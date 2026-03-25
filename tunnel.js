/**
 * tunnel.js — starts ngrok CLI tunnel + auto-configures Twilio webhook
 *
 * Requires ngrok CLI installed: https://ngrok.com/download
 * After install, run once: ngrok authtoken <your-token>
 *
 * Usage: node tunnel.js
 */

require('dotenv').config();

const { execSync, spawn } = require('child_process');
const https  = require('https');
const http   = require('http');
const twilio = require('twilio');

const PORT  = process.env.PORT || 3000;
const SID   = process.env.TWILIO_ACCOUNT_SID;
const TOKEN = process.env.TWILIO_AUTH_TOKEN;
const PHONE = process.env.TWILIO_PHONE_NUMBER;

// Check ngrok CLI is available
try {
  execSync('ngrok version', { stdio: 'ignore' });
} catch {
  console.error('[tunnel] ngrok CLI not found.');
  console.error('  → Download: https://ngrok.com/download');
  console.error('  → After install run: ngrok authtoken <token>');
  console.error('  → Or run server + ngrok manually:');
  console.error('      Terminal 1: node server.js');
  console.error('      Terminal 2: ngrok http 3000');
  process.exit(1);
}

// Start ngrok in background
console.log('[tunnel] Starting ngrok…');
const ngrokProc = spawn('ngrok', ['http', PORT.toString(), '--log=stdout'], {
  stdio: ['ignore', 'pipe', 'ignore'],
});

// Poll ngrok local API for the public URL
function getNgrokUrl(retries = 20) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const tunnels = JSON.parse(data).tunnels;
            const https_tunnel = tunnels.find(t => t.proto === 'https');
            if (https_tunnel) return resolve(https_tunnel.public_url);
          } catch {}
          if (++attempts < retries) setTimeout(check, 500);
          else reject(new Error('Timed out waiting for ngrok tunnel'));
        });
      }).on('error', () => {
        if (++attempts < retries) setTimeout(check, 500);
        else reject(new Error('ngrok local API not responding'));
      });
    };
    setTimeout(check, 1000);
  });
}

(async () => {
  let url;
  try {
    url = await getNgrokUrl();
  } catch (err) {
    console.error('[tunnel]', err.message);
    ngrokProc.kill();
    process.exit(1);
  }

  const cleanUrl = url.replace(/\/$/, '');
  process.env.BASE_URL = cleanUrl;

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(`  ngrok tunnel  →  ${cleanUrl}`);
  console.log(`  Voice webhook →  ${cleanUrl}/api/voice`);
  console.log(`  WebSocket     →  wss://${cleanUrl.replace(/^https?:\/\//, '')}/api/stream`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Auto-configure Twilio webhook
  if (SID && TOKEN && PHONE) {
    try {
      const client = twilio(SID, TOKEN);
      const numbers = await client.incomingPhoneNumbers.list({ phoneNumber: PHONE });
      if (numbers.length > 0) {
        await client.incomingPhoneNumbers(numbers[0].sid).update({
          voiceUrl:    `${cleanUrl}/api/voice`,
          voiceMethod: 'POST',
        });
        console.log(`[twilio] Webhook updated → ${cleanUrl}/api/voice`);
        console.log(`[twilio] Call ${PHONE} to test Jarvis\n`);
      }
    } catch (err) {
      console.error('[twilio] Webhook update failed:', err.message);
      console.error(`  → Set manually in Twilio console to: ${cleanUrl}/api/voice\n`);
    }
  }

  // Start the main server
  require('./server.js');

  // Cleanup ngrok on exit
  process.on('SIGINT',  () => { ngrokProc.kill(); process.exit(0); });
  process.on('SIGTERM', () => { ngrokProc.kill(); process.exit(0); });
})();
