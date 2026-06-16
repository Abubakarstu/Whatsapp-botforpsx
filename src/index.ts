import express from 'express';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers } from '@whiskeysockets/baileys';
import * as fs from 'fs';

const PORT = parseInt(process.env.PORT || process.env.WA_BOT_PORT || '3100', 10);
const AUTH_DIR = process.env.WA_AUTH_DIR || './auth';
const PSN_HOST = process.env.PSN_HOST || 'http://localhost:5087';

let sock: ReturnType<typeof makeWASocket> | null = null;
let connectionStatus: string = 'connecting';
let qrCode: string | null = null;
let pairingCode: string | null = null;

function isBoom(err: any): boolean {
  return err?.output?.statusCode !== undefined;
}

// ── HTTP API ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use((_req, res, next) => { res.header('Access-Control-Allow-Origin', '*'); res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE'); res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization'); if (_req.method === 'OPTIONS') return res.sendStatus(200); next(); });

app.get('/status', (_req, res) => {
  res.json({ status: connectionStatus, connected: connectionStatus === 'open', hasQr: !!qrCode, hasPairingCode: !!pairingCode });
});

app.get('/qr', (_req, res) => {
  if (qrCode) res.type('text/plain').send(qrCode);
  else if (pairingCode) res.json({ pairingCode });
  else res.status(404).json({ error: 'No QR code available. Use /request-pairing or wait for connection update.' });
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

// ── Baileys Socket ───────────────────────────────────────────────────────
async function startBot() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('PSX-Terminal'),
    syncFullHistory: false,
    markOnlineOnConnect: true,
  });

  sock.ev.on('connection.update', (update: any) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { qrCode = qr; pairingCode = null; console.log(`[WA] QR updated — scan: https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(qr)}`); }
    if (connection) connectionStatus = connection;
    if (connection === 'close') {
      const boom = lastDisconnect?.error;
      const shouldReconnect = !isBoom(boom) || boom?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log(`[WA] Closed. Reconnect: ${shouldReconnect}`);
      qrCode = null;
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('[WA] Connected!');
    }
  });

  sock.ev.on('creds.update', saveCreds);

  // Forward incoming messages to .NET for command processing
  sock.ev.on('messages.upsert', async ({ messages }: any) => {
    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message?.conversation) continue;
      const text = msg.message.conversation;
      const from = msg.key.remoteJid;
      if (!from || !text) continue;
      console.log(`[WA] From ${from}: ${text}`);
      try {
        const resp = await fetch(`${PSN_HOST}/api/psx/whatsapp/command`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, text }),
        });
        if (resp.ok) {
          const data: any = await resp.json();
          if (data.response) await sock!.sendMessage(from, { text: data.response });
        }
      } catch (e: any) {
        console.error(`[WA] Forward error: ${e.message}`);
      }
    }
  });

  app.listen(PORT, () => {
    console.log(`[WA] Server on http://localhost:${PORT}`);
    console.log(`[WA] Status: /status | QR: /qr | Pairing: /request-pairing`);
    console.log(`[WA] Connected to .NET at ${PSN_HOST}`);
  });
}

startBot().catch(console.error);
