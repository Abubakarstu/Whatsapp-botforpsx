import express from 'express';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
import * as fs from 'fs';

const PORT = parseInt(process.env.PORT || process.env.WA_BOT_PORT || '3100', 10);
const AUTH_DIR = process.env.WA_AUTH_DIR || './auth';
const PSN_HOST = process.env.PSN_HOST || 'https://testpsx.runasp.net';

let sock: ReturnType<typeof makeWASocket> | null = null;
let connectionStatus: string = 'connecting';
let qrCode: string | null = null;
let pairingCode: string | null = null;
let retryCount = 0;
let fastRetriesRemaining = 20;
let stateStartTime = Date.now();
let lastConnected: number | null = null;

function jitter(base: number): number {
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function isBoom(err: any): boolean {
  return err?.output?.statusCode !== undefined;
}

// ── HTTP API ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((_req, res, next) => { res.header('Access-Control-Allow-Origin', '*'); res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE'); res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization'); if (_req.method === 'OPTIONS') return res.sendStatus(200); next(); });

app.get('/health', (_req, res) => {
  res.json({
    status: connectionStatus === 'open' || connectionStatus === 'connecting' ? 'ok' : 'degraded',
    connection: connectionStatus,
    connected: connectionStatus === 'open',
    uptime: process.uptime(),
    stateAge: Math.round((Date.now() - stateStartTime) / 1000),
    lastConnected,
    retryCount,
    fastRetriesRemaining,
  });
});

app.get('/status', (_req, res) => {
  res.json({ status: connectionStatus, connected: connectionStatus === 'open', hasQr: !!qrCode, hasPairingCode: !!pairingCode, retryCount, fastRetriesRemaining });
});

app.get('/qr', (_req, res) => {
  if (qrCode) res.type('text/plain').send(qrCode);
  else if (pairingCode) res.json({ pairingCode });
  else res.status(404).json({ error: 'No QR code available. Use /request-pairing or wait for connection update.' });
});

app.post('/reset-auth', (_req, res) => {
  try {
    if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
    qrCode = null;
    pairingCode = null;
    connectionStatus = 'reset';
    stateStartTime = Date.now();
    retryCount = 0;
    fastRetriesRemaining = 20;
    res.json({ message: 'Auth cleared. Restarting...' });
    setTimeout(() => process.exit(0), 500);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/request-pairing', async (req, res) => {
  const { phone } = req.body;
  if (!phone || !/^\d{7,15}$/.test(phone)) return res.status(400).json({ error: 'Valid phone number required (digits with country code)' });
  if (!sock) return res.status(503).json({ error: 'Socket not initialized' });
  try {
    const code = await sock.requestPairingCode(phone);
    pairingCode = code;
    res.json({ code });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/send', async (req, res) => {
  const { to, text } = req.body;
  if (!to || !text) return res.status(400).json({ error: 'to and text required' });
  return await sendMessage(to, text, res);
});

app.post('/signal', async (req, res) => {
  const { to, symbol, action, price, target, stoploss, reason } = req.body;
  if (!to || !symbol || !action) return res.status(400).json({ error: 'to, symbol, action required' });
  const msg = `🚀 *PSX SIGNAL*\n\n📈 ${symbol}\n🎯 ${action} @ ${price || '—'}\n🎯 Target: ${target || '—'}\n🛑 Stop: ${stoploss || '—'}${reason ? `\n📝 ${reason}` : ''}\n\nPowered by PSX Terminal`;
  return await sendMessage(to, msg, res);
});

app.post('/broadcast', async (req, res) => {
  const { recipients, text } = req.body;
  if (!recipients?.length || !text) return res.status(400).json({ error: 'recipients[] and text required' });
  if (!sock || connectionStatus !== 'open') return res.status(503).json({ error: 'WhatsApp not connected' });
  const results: any[] = [];
  for (const to of recipients) {
    try {
      const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
      await sock.sendMessage(jid, { text });
      results.push({ to, status: 'sent' });
    } catch (e: any) {
      results.push({ to, status: 'error', error: e.message });
    }
  }
  res.json({ results, sent: results.filter(r => r.status === 'sent').length, failed: results.filter(r => r.status === 'error').length });
});

app.post('/respond', async (req, res) => {
  const { to, text } = req.body;
  if (!to || !text) return res.status(400).json({ error: 'to and text required' });
  return await sendMessage(to, text, res);
});

async function sendMessage(to: string, text: string, res: any) {
  if (!sock || connectionStatus !== 'open') return res.status(503).json({ error: 'WhatsApp not connected' });
  try {
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text });
    res.json({ status: 'sent', jid });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
}

// ── WhatsApp Connection ──────────────────────────────────────────────────
async function connectWA() {
  if (!fs.existsSync(AUTH_DIR)) {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    console.log(`[WA] Created auth dir: ${AUTH_DIR}`);
  }

  const credsCount = fs.readdirSync(AUTH_DIR).length;
  console.log(`[WA] Auth dir has ${credsCount} file(s)${credsCount > 0 ? ' — existing session found, attempting restore' : ' — fresh start, will need QR'}`);

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('PSX-Terminal'),
    syncFullHistory: false,
    markOnlineOnConnect: true,
    connectTimeoutMs: 30_000,
    keepAliveIntervalMs: 30_000,
  });

  sock.ev.on('connection.update', (update: any) => {
    const { connection, lastDisconnect, qr } = update;
    if (connection !== connectionStatus && connection) {
      stateStartTime = Date.now();
    }

    if (qr) {
      qrCode = qr;
      pairingCode = null;
      retryCount = 0;
      console.log(`[WA] QR updated — scan: https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`);
    }
    if (connection) connectionStatus = connection;

    if (connection === 'close') {
      const boom = lastDisconnect?.error;
      const isLoggedOut = isBoom(boom) && boom?.output?.statusCode === DisconnectReason.loggedOut;

      if (isLoggedOut) {
        console.log('[WA] Logged out. Clearing auth and waiting for new QR...');
        connectionStatus = 'logged_out';
        qrCode = null;
        pairingCode = null;
        retryCount = 0;
        fastRetriesRemaining = 20;
        if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true });
        const delay = jitter(3000);
        console.log(`[WA] Reconnecting in ${Math.round(delay/1000)}s...`);
        setTimeout(connectWA, delay);
        return;
      }

      retryCount++;

      if (fastRetriesRemaining > 0) {
        fastRetriesRemaining--;
        const base = Math.min(3000 * Math.pow(1.5, retryCount - 1), 60000);
        const delay = jitter(base);
        console.log(`[WA] Closed. Reconnecting in ${Math.round(delay/1000)}s (retry #${retryCount}, ${fastRetriesRemaining} fast retries left)...`);
        qrCode = null;
        setTimeout(connectWA, delay);
      } else {
        console.log(`[WA] Fast retries exhausted. Entering poll mode — retry every 5min (retry #${retryCount})`);
        connectionStatus = 'sleeping';
        qrCode = null;
        setTimeout(connectWA, jitter(300_000));
      }
    } else if (connection === 'open') {
      console.log(`[WA] Connected! (after ${retryCount} retries)`);
      lastConnected = Date.now();
      retryCount = 0;
      fastRetriesRemaining = 20;
    } else if (connection === 'connecting') {
      console.log('[WA] Connecting...');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Watchdog: if stuck in 'connecting' > 30s, force close and retry
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  sock.ev.on('connection.update', (update: any) => {
    if (update.connection === 'connecting') {
      if (!watchdog) {
        watchdog = setTimeout(() => {
          if (connectionStatus === 'connecting' && sock) {
            console.log('[WA] Watchdog: stuck in connecting > 30s, terminating socket...');
            try { sock?.end(undefined); } catch (_) { /* ignore */ }
          }
          watchdog = null;
        }, 30_000);
      }
    } else {
      if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    }
  });

  // Forward incoming messages to .NET for command processing
  sock.ev.on('messages.upsert', async ({ messages, type }: any) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key?.fromMe) continue;
      const text = msg.message?.conversation
        || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption
        || '';
      const from = msg.key.remoteJid;
      if (!from || !text.trim()) { console.log(`[WA] Skipped empty msg from ${from}`); continue; }
      console.log(`[WA] From ${from}: "${text}" -> forwarding to ${PSN_HOST}/api/psx/whatsapp/command`);
      try {
        const resp = await fetch(`${PSN_HOST}/api/psx/whatsapp/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, text }),
        });
        if (resp.ok) {
          const data: any = await resp.json();
          if (data.response) {
            if (sock) await sock.sendMessage(from, { text: data.response });
            console.log(`[WA] Replied to ${from}: "${data.response.substring(0,40)}..."`);
          } else {
            console.log(`[WA] No response from .NET for: "${text}"`);
          }
        } else {
          const errText = await resp.text();
          console.log(`[WA] .NET returned ${resp.status}: ${errText}`);
        }
      } catch (e: any) {
        console.error(`[WA] Forward error: ${e.message}`);
      }
    }
  });
}

// Graceful shutdown
function shutdown() {
  console.log('[WA] Shutting down...');
  connectionStatus = 'shutdown';
  if (sock) sock.end(undefined);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start HTTP server (once) then connect WhatsApp
app.listen(PORT, () => {
  console.log(`[WA] Server on http://localhost:${PORT}`);
  console.log(`[WA] Status: /status | QR: /qr | Pairing: /request-pairing | Health: /health`);
  console.log(`[WA] Connected to .NET at ${PSN_HOST}`);
  console.log(`[WA] Auth directory: ${AUTH_DIR}`);
  console.log(`[WA] Fast retries: 20 (3s→60s exponential), then polling every 5min`);
});
connectWA().catch(console.error);
