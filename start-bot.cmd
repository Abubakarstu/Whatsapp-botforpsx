@echo off
cd /d "%~dp0"
echo Starting PSX WhatsApp Baileys Bot...
echo.
echo Connect via QR:      http://localhost:3100/qr
echo Pairing:             POST /request-pairing { "phone": "92xxxxxxxxx" }
echo Status:              http://localhost:3100/status
echo.
npx tsx src/index.ts
pause
