require('dotenv').config();

// Support inline Google credentials JSON (useful on hosting platforms)
if (process.env.GOOGLE_CREDENTIALS_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const fs   = require('fs');
  const os   = require('os');
  const path = require('path');
  const tmp  = path.join(os.tmpdir(), 'google-creds.json');
  fs.writeFileSync(tmp, process.env.GOOGLE_CREDENTIALS_JSON);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = tmp;
}

const http   = require('http');
const fs     = require('fs');
const path   = require('path');
const { WebSocketServer } = require('ws');
const busboy = require('busboy');

// Ensure uploads directory exists
const UPLOADS_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const { handleConnection }                                 = require('./lib/ws-handler');
const { transcriptBus, getOrCreateBrowserSession,
        updateBrowserSession }                             = require('./lib/session');
const { getReply }                                        = require('./lib/gemini');
const { synthesizeForBrowser }                            = require('./lib/tts');
const { makeCall }                                        = require('./lib/twilio-call');
const { getTicket, getTicketByToken, addFile, getAllTickets } = require('./lib/ticket-store');

const PORT       = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function getPublicBase(req) {
  const env = process.env.BASE_URL;
  if (env) return env.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

function serveFile(res, filePath) {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(PUBLIC_DIR))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(resolved)] || 'application/octet-stream' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function xml(res, body) {
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(body);
}

// ── Request handler ───────────────────────────────────────────────────────────
async function requestHandler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p   = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Static pages ─────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    if (p === '/')           { serveFile(res, path.join(PUBLIC_DIR, 'index.html'));      return; }
    if (p === '/simulation') { serveFile(res, path.join(PUBLIC_DIR, 'simulation.html')); return; }
    if (p === '/tickets')    { serveFile(res, path.join(PUBLIC_DIR, 'tickets.html'));    return; }
    if (p === '/api/tickets') { json(res, 200, getAllTickets()); return; }
    const ext = path.extname(p);
    if (MIME[ext])           { serveFile(res, path.join(PUBLIC_DIR, p));                return; }
  }

  // ── Twilio: incoming call TwiML (ConversationRelay) ──────────────────────
  if (p === '/api/voice' && (req.method === 'POST' || req.method === 'GET')) {
    const base = getPublicBase(req).replace(/^https?:\/\//, '');
    const wsUrl = `wss://${base}/api/stream`;
    console.log(`[TwiML] ConversationRelay → ${wsUrl}`);
    xml(res, `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay url="${wsUrl}"
      welcomeGreeting="Namaste! Welcome to Delhi Municipal Corporation helpline. You can speak in Hindi, Hinglish, or English. Please go ahead."
      language="en-IN"
      interruptByDtmf="false"
    />
  </Connect>
</Response>`);
    return;
  }

  // ── Exotel: outbound call ExoML webhook ───────────────────────────────────
  if (p === '/api/exotel/voice' && (req.method === 'POST' || req.method === 'GET')) {
    const base = getPublicBase(req).replace(/^https?:\/\//, '');
    // Exotel Streams requires bidirectional="true" for two-way audio
    xml(res, `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say>Hello! Jarvis AI is now listening. Please speak after the tone.</Say>
  <Connect>
    <Stream url="wss://${base}/api/stream" bidirectional="true"/>
  </Connect>
</Response>`);
    return;
  }

  // ── Exotel: call status callback ──────────────────────────────────────────
  if (p === '/api/exotel/status' && req.method === 'POST') {
    const body = await readBody(req);
    const status = body.Status || body.status || '';
    if (status === 'completed' || status === 'failed' || status === 'busy' || status === 'no-answer') {
      transcriptBus.emit('transcript', { type: 'call_ended', status });
    }
    res.writeHead(200); res.end('ok');
    return;
  }

  // ── POST /api/call — initiate outbound call via Exotel ───────────────────
  if (p === '/api/call' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const to = body.to || '+918509047388';
      if (!to) { json(res, 400, { error: 'Missing "to" phone number' }); return; }

      const base = getPublicBase(req);
      const call = await makeCall(to, base);

      transcriptBus.emit('transcript', { type: 'call_started', callSid: call.sid, to });
      json(res, 200, { callSid: call.sid, status: call.status });
    } catch (err) {
      console.error('[/api/call]', err.message);
      json(res, 500, { error: err.message });
    }
    return;
  }

  // ── POST /api/call/end — hang up call via Exotel ─────────────────────────
  if (p === '/api/call/end' && req.method === 'POST') {
    try {
      const { callSid } = await readBody(req);
      // Exotel doesn't have a direct hangup API for in-progress calls via REST
      // Signal the frontend that the call ended
      transcriptBus.emit('transcript', { type: 'call_ended', callSid });
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
    return;
  }

  // ── POST /api/twilio/status — Twilio call status callback ────────────────
  if (p === '/api/twilio/status' && req.method === 'POST') {
    const body = await readBody(req);
    const status = body.CallStatus || '';
    if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(status)) {
      transcriptBus.emit('transcript', { type: 'call_ended', status });
    } else if (status === 'in-progress') {
      transcriptBus.emit('transcript', { type: 'call_started', callSid: body.CallSid });
    }
    res.writeHead(200); res.end('ok');
    return;
  }

  // ── POST /api/chat — browser mic simulation (index page) ─────────────────
  if (p === '/api/chat' && req.method === 'POST') {
    try {
      const { text, sessionId = 'browser-default' } = await readBody(req);
      if (!text || typeof text !== 'string') { json(res, 400, { error: 'Missing text' }); return; }
      const session = getOrCreateBrowserSession(sessionId);
      const { reply, updatedHistory } = await getReply(session.history, text.trim());
      updateBrowserSession(sessionId, updatedHistory);
      const audioBase64 = await synthesizeForBrowser(reply);
      json(res, 200, { reply, audioBase64 });
    } catch (err) {
      console.error('[/api/chat]', err.message);
      json(res, 500, { error: 'Internal server error' });
    }
    return;
  }

  // ── GET /api/transcripts — SSE live feed ──────────────────────────────────
  if (p === '/api/transcripts' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('data: {"type":"connected"}\n\n');
    const send = (e) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(e)}\n\n`); };
    transcriptBus.on('transcript', send);
    req.on('close', () => transcriptBus.off('transcript', send));
    return;
  }

  // ── GET /upload/:token — serve upload page (temporary link) ─────────────
  const uploadPageMatch = p.match(/^\/upload\/([a-f0-9]+)$/);
  if (uploadPageMatch && req.method === 'GET') {
    serveFile(res, path.join(PUBLIC_DIR, 'upload.html'));
    return;
  }

  // ── GET /api/upload/:token — ticket details via token ────────────────────
  const tokenApiMatch = p.match(/^\/api\/upload\/([a-f0-9]+)$/);
  if (tokenApiMatch && req.method === 'GET') {
    const { ticket, error } = getTicketByToken(tokenApiMatch[1]);
    if (error === 'expired') { json(res, 410, { error: 'This upload link has expired.' }); return; }
    if (!ticket) { json(res, 404, { error: 'Invalid upload link.' }); return; }
    json(res, 200, ticket);
    return;
  }

  // ── GET /api/ticket/:id — ticket details by ID (for dashboard) ───────────
  const ticketApiMatch = p.match(/^\/api\/ticket\/([^/]+)$/);
  if (ticketApiMatch && req.method === 'GET') {
    const ticket = getTicket(ticketApiMatch[1]);
    if (!ticket) { json(res, 404, { error: 'Ticket not found' }); return; }
    json(res, 200, ticket);
    return;
  }

  // ── POST /api/upload/:token — file upload via token ──────────────────────
  const uploadApiMatch = p.match(/^\/api\/upload\/([a-f0-9]+)$/);
  if (uploadApiMatch && req.method === 'POST') {
    const { ticket, error } = getTicketByToken(uploadApiMatch[1]);
    if (error === 'expired') { json(res, 410, { error: 'This upload link has expired.' }); return; }
    if (!ticket) { json(res, 404, { error: 'Invalid upload link.' }); return; }
    const ticketId = ticket.id;

    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      json(res, 400, { error: 'Expected multipart/form-data' }); return;
    }

    const ticketDir = path.join(UPLOADS_DIR, ticketId);
    fs.mkdirSync(ticketDir, { recursive: true });

    const bb = busboy({ headers: req.headers, limits: { fileSize: 10 * 1024 * 1024 } });
    const savedFiles = [];

    bb.on('file', (fieldname, fileStream, info) => {
      const { filename, mimeType } = info;
      const safeName = `${Date.now()}-${path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      const destPath = path.join(ticketDir, safeName);
      const writeStream = fs.createWriteStream(destPath);

      fileStream.pipe(writeStream);
      writeStream.on('finish', () => {
        const meta = { filename: safeName, originalName: filename, mimeType, uploadedAt: new Date().toISOString() };
        addFile(ticketId, meta);
        savedFiles.push(meta);
        console.log(`[UPLOAD] ${ticketId} — saved: ${safeName}`);
      });
    });

    bb.on('finish', () => {
      json(res, 200, { success: true, filesCount: ticket.files.length });
    });

    bb.on('error', (err) => {
      console.error('[UPLOAD] busboy error:', err.message);
      json(res, 500, { error: 'Upload failed' });
    });

    req.pipe(bb);
    return;
  }

  res.writeHead(404); res.end('Not Found');
}

// ── Server + WebSocket ────────────────────────────────────────────────────────
const server = http.createServer(requestHandler);
const wss    = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/api/stream') {
    wss.handleUpgrade(req, socket, head, ws => handleConnection(ws));
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  const base = process.env.BASE_URL || `http://localhost:${PORT}`;
  console.log(`\n🤖  Jarvis AI Voice Agent`);
  console.log(`    Dashboard   → http://localhost:${PORT}/`);
  console.log(`    Simulation  → http://localhost:${PORT}/simulation`);
  console.log(`    Voice hook  → POST ${base}/api/voice  (Twilio)\n`);
});
