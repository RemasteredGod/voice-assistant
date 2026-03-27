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
const { createTicket, getTicket, getTicketByToken, addFile, getAllTickets } = require('./lib/ticket-store');
const { createOtp, verifyOtp, createSession,
        getSession, deleteSession, parseSessionCookie } = require('./lib/auth-store');
const { sendOtpSms, sendTicketSms } = require('./lib/sms');
const { sendOtpEmail }  = require('./lib/email');

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

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
  // Trust GCP / nginx proxy headers for HTTPS
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

function serveFile(res, filePath) {
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(PUBLIC_DIR))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(resolved, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(resolved);
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    // Prevent browsers caching JS/CSS so changes are always picked up
    if (ext === '.js' || ext === '.css') headers['Cache-Control'] = 'no-store';
    res.writeHead(200, headers);
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

function readFormBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const obj = {};
      for (const [k, v] of params) obj[k] = v;
      resolve(obj);
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
  // ── Session helper ───────────────────────────────────────────────────────
  const sessionToken = parseSessionCookie(req.headers.cookie);
  const session      = getSession(sessionToken);

  if (req.method === 'GET') {
    if (p === '/')           { serveFile(res, path.join(PUBLIC_DIR, 'index.html'));      return; }
    if (p === '/simulation') { serveFile(res, path.join(PUBLIC_DIR, 'simulation.html')); return; }
    if (p === '/samadhan')     { serveFile(res, path.join(PUBLIC_DIR, 'samadhan.html'));      return; }
    if (p === '/login')      { serveFile(res, path.join(PUBLIC_DIR, 'login.html'));      return; }
    if (p === '/my-tickets') { serveFile(res, path.join(PUBLIC_DIR, 'my-tickets.html')); return; }

    // Admin-only pages
    if (p === '/tickets') {
      if (!session || session.role !== 'admin') { res.writeHead(302, { Location: '/login?next=/tickets' }); res.end(); return; }
      serveFile(res, path.join(PUBLIC_DIR, 'tickets.html'));
      return;
    }
    if (p === '/api/tickets') {
      if (!session || session.role !== 'admin') { json(res, 401, { error: 'Unauthorized' }); return; }
      json(res, 200, getAllTickets());
      return;
    }

    // Public stats (used by homepage counter — no auth required)
    if (p === '/api/stats') {
      json(res, 200, { ticketCount: getAllTickets().length });
      return;
    }

    // Auth: current user info
    if (p === '/api/auth/me') {
      if (!session) { json(res, 401, { error: 'Not logged in' }); return; }
      json(res, 200, { id: session.id, role: session.role });
      return;
    }

    // Citizen: their own tickets by phone
    if (p === '/api/my-tickets') {
      if (!session || session.role !== 'citizen') { json(res, 401, { error: 'Unauthorized' }); return; }
      const phone   = session.id;
      const myTickets = getAllTickets().filter(t => t.phone === phone || t.phone === '+91' + phone.replace(/\D/g,'').slice(-10));
      json(res, 200, myTickets);
      return;
    }
    // Citizen: create a new complaint ticket
    if (p === '/api/tickets' && req.method === 'POST') {
      if (!session || session.role !== 'citizen') { json(res, 401, { error: 'Unauthorized' }); return; }
      const { name, complaint, severityScore } = await readBody(req);
      const trimName = (name || '').trim();
      const trimComplaint = (complaint || '').trim();
      if (!trimName || trimName.length > 100) { json(res, 400, { error: 'Name is required (1-100 characters)' }); return; }
      if (trimComplaint.length < 10 || trimComplaint.length > 2000) { json(res, 400, { error: 'Complaint must be 10-2000 characters' }); return; }
      const phone = session.id;
      const ticket = createTicket(trimName, phone, trimComplaint, severityScore || 5);
      const uploadUrl = `${getPublicBase(req)}/upload/${ticket.uploadToken}`;
      sendTicketSms(phone, ticket.id, uploadUrl).catch(e => console.error('[SMS]', e.message));
      json(res, 201, { ticket, uploadUrl });
      return;
    }

    const ext = path.extname(p);
    if (MIME[ext])           { serveFile(res, path.join(PUBLIC_DIR, p));                return; }
  }

  // ── Twilio: incoming/outbound call TwiML (Media Streams + Gemini Live) ──────
  if (p === '/api/voice' && (req.method === 'POST' || req.method === 'GET')) {
    const formBody   = req.method === 'POST' ? await readFormBody(req) : {};
    const base       = getPublicBase(req).replace(/^https?:\/\//, '');
    // For outbound calls: To = the number we dialled (the citizen)
    const callerPhone = formBody.To || formBody.From || '';
    const wsUrl      = `wss://${base}/api/stream`;
    console.log(`[TwiML] Media Streams → ${wsUrl}, callerPhone: ${callerPhone}`);
    xml(res, `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="callerPhone" value="${callerPhone}"/>
    </Stream>
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
  <Say>Hello! Samadhan AI is now listening. Please speak after the tone.</Say>
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

  // ── POST /api/call — initiate outbound call via Twilio ───────────────────
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

  // ── POST /api/call/end — end active call ─────────────────────────────────
  if (p === '/api/call/end' && req.method === 'POST') {
    try {
      const { callSid } = await readBody(req);
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

  // ── POST /api/auth/send-otp ───────────────────────────────────────────────
  if (p === '/api/auth/send-otp' && req.method === 'POST') {
    const { identifier, type } = await readBody(req); // type: 'citizen' | 'admin'
    if (!identifier) { json(res, 400, { error: 'Missing identifier' }); return; }

    if (type === 'admin') {
      const email = identifier.toLowerCase().trim();
      if (!ADMIN_EMAILS.includes(email)) { json(res, 403, { error: 'Not an admin email.' }); return; }
      const otp = createOtp(email);
      try {
        await sendOtpEmail(email, otp);
        json(res, 200, { ok: true, message: `OTP sent to ${email}` });
      } catch (err) {
        console.error('[EMAIL OTP]', err.message);
        json(res, 500, { error: 'Failed to send OTP email. Check EMAIL_USER / EMAIL_PASS in .env' });
      }

    } else {
      // Citizen — OTP via Twilio SMS
      const digits = identifier.replace(/\D/g, '');
      const phone  = digits.length === 10 ? '+91' + digits : (digits.startsWith('91') ? '+' + digits : identifier);
      const otp    = createOtp(phone);
      try {
        await sendOtpSms(phone, otp);
      } catch (err) {
        console.error('[OTP SMS]', err.message);
        json(res, 500, { error: 'Failed to send OTP. Check your phone number.' });
        return;
      }
      json(res, 200, { ok: true, phone });
    }
    return;
  }

  // ── POST /api/auth/verify-otp ─────────────────────────────────────────────
  if (p === '/api/auth/verify-otp' && req.method === 'POST') {
    const { identifier, otp, type } = await readBody(req);
    if (!identifier || !otp) { json(res, 400, { error: 'Missing fields' }); return; }

    const id = type === 'admin'
      ? identifier.toLowerCase().trim()
      : '+91' + identifier.replace(/\D/g, '').slice(-10);

    const result = verifyOtp(id, otp);
    if (!result.ok) { json(res, 401, { error: result.reason }); return; }

    const role  = type === 'admin' ? 'admin' : 'citizen';
    const token = createSession(id, role);

    const isHttps = (req.headers['x-forwarded-proto'] || '').includes('https') || process.env.BASE_URL?.startsWith('https');
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie':   `session=${token}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax${isHttps ? '; Secure' : ''}`,
    });
    res.end(JSON.stringify({ ok: true, role, id }));
    return;
  }

  // ── POST /api/auth/logout ─────────────────────────────────────────────────
  if (p === '/api/auth/logout' && req.method === 'POST') {
    if (sessionToken) deleteSession(sessionToken);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie':   'session=; HttpOnly; Path=/; Max-Age=0',
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── PATCH /api/admin/ticket/:id/status — admin update status ─────────────
  if (p.match(/^\/api\/admin\/ticket\/([^/]+)\/status$/) && req.method === 'PATCH') {
    if (!session || session.role !== 'admin') { json(res, 401, { error: 'Unauthorized' }); return; }
    const ticketId = p.split('/')[4];
    const { status, note } = await readBody(req);
    const ticket = getTicket(ticketId);
    if (!ticket) { json(res, 404, { error: 'Ticket not found' }); return; }
    if (status) ticket.status = status;
    if (note)   ticket.notes  = [...(ticket.notes || []), { text: note, by: session.id, at: new Date().toISOString() }];
    json(res, 200, ticket);
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
  if (req.url === '/api/stream' || req.url.startsWith('/api/stream?')) {
    wss.handleUpgrade(req, socket, head, ws => handleConnection(ws, req));
  } else {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  const base = process.env.BASE_URL || `http://localhost:${PORT}`;
  console.log(`\n🤖  Samadhan AI Voice Agent`);
  console.log(`    Dashboard   → http://localhost:${PORT}/`);
  console.log(`    Simulation  → http://localhost:${PORT}/simulation`);
  console.log(`    Voice hook  → POST ${base}/api/voice  (Twilio)\n`);
});
