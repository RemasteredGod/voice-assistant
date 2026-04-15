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
const crypto = require('crypto');
const twilio = require('twilio');
const { WebSocketServer } = require('ws');
const busboy = require('busboy');

const { handleConnection }                                 = require('./lib/ws-handler');
const { transcriptBus, getOrCreateBrowserSession,
        updateBrowserSession }                             = require('./lib/session');
const { getReply, continueWithFunctionResult }            = require('./lib/gemini');
const { synthesizeForBrowser }                            = require('./lib/tts');
const { makeCall }                                        = require('./lib/twilio-call');
const { createTicket, getTicket, getTicketByToken, addFile, getAllTickets } = require('./lib/ticket-store');
const { createOtp, verifyOtp, createSession,
        getSession, deleteSession, parseSessionCookie } = require('./lib/auth-store');
const { sendOtpSms, sendTicketSms } = require('./lib/sms');
const { sendOtpEmail }  = require('./lib/email');
const { initDatabase, hasPostgres, query } = require('./lib/db');
const { connectRedis } = require('./lib/cache');
const { createCheckoutSession, upsertSubscription, verifyStripeWebhook, stripeEnabled } = require('./lib/billing');
const { saveUpload, getDownloadUrl, provider: storageProvider } = require('./lib/storage');
const { increment, captureError, getMetricsSnapshot } = require('./lib/observability');

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
const APP_NAME = process.env.APP_NAME || 'CallPilot AI';
const DEFAULT_ORG_ID = 'public';
const PUBLIC_APP_ORIGIN = (process.env.PUBLIC_APP_ORIGIN || '').replace(/\/$/, '');
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || PUBLIC_APP_ORIGIN || '').split(',').map((v) => v.trim()).filter(Boolean);
const MAX_JSON_BODY_BYTES = 256 * 1024;
const rateLimitBuckets = new Map();
const STRIPE_WEBHOOK_PATH = '/api/billing/webhook';
const TEAM_ROLES = new Set(['owner', 'admin', 'agent']);
const ALLOWED_UPLOAD_MIME = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
  'video/mp4',
]);

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

function parseCookies(cookieHeader = '') {
  const out = {};
  cookieHeader.split(';').forEach((part) => {
    const [k, ...rest] = part.trim().split('=');
    if (!k) return;
    out[k] = decodeURIComponent(rest.join('=') || '');
  });
  return out;
}

function readRawBody(req, limitBytes = MAX_JSON_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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
    let tooLarge = false;
    req.on('data', c => {
      body += c;
      if (body.length > MAX_JSON_BODY_BYTES) {
        tooLarge = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooLarge) { resolve({}); return; }
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

function readFormBody(req) {
  return new Promise((resolve) => {
    let body = '';
    let tooLarge = false;
    req.on('data', c => {
      body += c;
      if (body.length > MAX_JSON_BODY_BYTES) {
        tooLarge = true;
        req.destroy();
      }
    });
    req.on('end', () => {
      if (tooLarge) { resolve({}); return; }
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

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'microphone=(self)');
}

function applyCors(req, res) {
  const origin = req.headers.origin || '';
  if (!origin || !ALLOWED_ORIGINS.length) return;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
}

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

function checkRateLimit(req, key, limit, windowMs) {
  const now = Date.now();
  const ip = getClientIp(req);
  const bucketKey = `${key}:${ip}`;
  const bucket = rateLimitBuckets.get(bucketKey) || { count: 0, resetAt: now + windowMs };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  rateLimitBuckets.set(bucketKey, bucket);
  return bucket.count <= limit;
}

function normalizePhoneForUs(identifier) {
  const digits = String(identifier || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (String(identifier).startsWith('+')) return String(identifier).trim();
  return `+1${digits.slice(-10)}`;
}

function createOrgSlug(name) {
  const base = String(name || 'workspace')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'workspace';
  return `${base}-${crypto.randomBytes(2).toString('hex')}`;
}

async function logAudit(action, session, metadata = {}) {
  if (!hasPostgres) return;
  try {
    await query(
      `INSERT INTO audit_logs (id, org_id, actor_id, actor_role, action, metadata)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        crypto.randomUUID(),
        session?.orgId || null,
        session?.id || null,
        session?.role || null,
        action,
        JSON.stringify(metadata),
      ],
    );
  } catch (error) {
    console.error('[AUDIT]', error.message);
  }
}

async function getOrgFromSlug(slug) {
  if (!hasPostgres) return null;
  const { rows } = await query(`SELECT * FROM organizations WHERE slug = $1 LIMIT 1`, [slug]);
  return rows[0] || null;
}

async function getUserForSession(session) {
  if (!session || !hasPostgres || !session.orgId) return null;
  const { rows } = await query(
    `SELECT id, org_id, name, identifier, role FROM users WHERE org_id = $1 AND identifier = $2 LIMIT 1`,
    [session.orgId, session.id],
  );
  return rows[0] || null;
}

function getPlanLimits(plan) {
  if (plan === 'professional') return { callsPerMonth: 3000, teamSeats: 10 };
  if (plan === 'growth') return { callsPerMonth: 8000, teamSeats: 30 };
  return { callsPerMonth: 500, teamSeats: 3 };
}

function isTeamMember(session) {
  return Boolean(session && TEAM_ROLES.has(session.role));
}

function canManageTeam(session) {
  return Boolean(session && (session.role === 'owner' || session.role === 'admin'));
}

function canManageBilling(session) {
  return Boolean(session && (session.role === 'owner' || session.role === 'admin'));
}

setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets) {
    if (now > bucket.resetAt) rateLimitBuckets.delete(key);
  }
}, 5 * 60_000);

async function hasActiveEntitlement(orgId) {
  if (!hasPostgres || !orgId || orgId === DEFAULT_ORG_ID) return true;
  const orgRes = await query(`SELECT trial_ends_at FROM organizations WHERE id = $1 LIMIT 1`, [orgId]);
  const subRes = await query(`SELECT status FROM subscriptions WHERE org_id = $1 LIMIT 1`, [orgId]);
  const subscription = subRes.rows[0];
  if (subscription && ['active', 'trialing'].includes(subscription.status)) return true;
  const trialEndsAt = orgRes.rows[0]?.trial_ends_at ? new Date(orgRes.rows[0].trial_ends_at).getTime() : 0;
  return Date.now() <= trialEndsAt;
}

// ── Request handler ───────────────────────────────────────────────────────────
async function requestHandler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p   = url.pathname;
  const requestId = crypto.randomBytes(8).toString('hex');
  increment('requestsTotal');
  const startedAt = Date.now();
  res.setHeader('X-Request-Id', requestId);
  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    console.log(JSON.stringify({
      level: 'info',
      requestId,
      method: req.method,
      path: p,
      statusCode: res.statusCode,
      durationMs,
      at: new Date().toISOString(),
    }));
  });

  setSecurityHeaders(res);
  applyCors(req, res);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Stripe-Signature, X-Twilio-Signature');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── Static pages ─────────────────────────────────────────────────────────
  // ── Session helper ───────────────────────────────────────────────────────
  const sessionToken = parseSessionCookie(req.headers.cookie);
  const session = await getSession(sessionToken);
  const currentOrgId = session?.orgId || DEFAULT_ORG_ID;

  if (req.method === 'GET') {
    if (p === '/')           { serveFile(res, path.join(PUBLIC_DIR, 'index.html'));      return; }
    if (p === '/simulation') { serveFile(res, path.join(PUBLIC_DIR, 'simulation.html')); return; }
    if (p === '/samadhan')   { serveFile(res, path.join(PUBLIC_DIR, 'samadhan.html'));   return; }
    if (p === '/login')      { serveFile(res, path.join(PUBLIC_DIR, 'login.html'));      return; }
    if (p === '/signup')     { serveFile(res, path.join(PUBLIC_DIR, 'signup.html'));     return; }
    if (p === '/pricing')    { serveFile(res, path.join(PUBLIC_DIR, 'pricing.html'));    return; }
    if (p === '/terms')      { serveFile(res, path.join(PUBLIC_DIR, 'terms.html'));      return; }
    if (p === '/privacy')    { serveFile(res, path.join(PUBLIC_DIR, 'privacy.html'));    return; }
    if (p === '/security')   { serveFile(res, path.join(PUBLIC_DIR, 'security.html'));   return; }
    if (p === '/subprocessors') { serveFile(res, path.join(PUBLIC_DIR, 'subprocessors.html')); return; }
    if (p === '/my-tickets') { serveFile(res, path.join(PUBLIC_DIR, 'my-tickets.html')); return; }

    // Admin-only pages
    if (p === '/tickets') {
      if (!isTeamMember(session)) { res.writeHead(302, { Location: '/login?next=/tickets' }); res.end(); return; }
      serveFile(res, path.join(PUBLIC_DIR, 'tickets.html'));
      return;
    }
    if (p === '/api/tickets') {
      if (!isTeamMember(session)) { json(res, 401, { error: 'Unauthorized' }); return; }
      const tickets = await getAllTickets(currentOrgId);
      json(res, 200, tickets);
      return;
    }

    // Public stats (used by homepage counter — no auth required)
    if (p === '/api/stats') {
      const tickets = await getAllTickets(currentOrgId);
      json(res, 200, { ticketCount: tickets.length });
      return;
    }

    // Auth: current user info
    if (p === '/api/auth/me') {
      if (!session) { json(res, 401, { error: 'Not logged in' }); return; }
      const me = await getUserForSession(session);
      json(res, 200, {
        id: session.id,
        role: session.role,
        orgId: session.orgId || null,
        name: me?.name || null,
      });
      return;
    }

    if (p === '/api/health') {
      json(res, 200, {
        ok: true,
        storageProvider,
        hasPostgres,
        now: new Date().toISOString(),
      });
      return;
    }

    if (p === '/api/metrics') {
      if (!canManageTeam(session)) { json(res, 401, { error: 'Unauthorized' }); return; }
      json(res, 200, getMetricsSnapshot());
      return;
    }

    // Citizen: their own tickets by phone
    if (p === '/api/my-tickets') {
      if (!session || session.role !== 'citizen') { json(res, 401, { error: 'Unauthorized' }); return; }
      const phone   = session.id;
      const myTickets = await getAllTickets(currentOrgId, phone);
      json(res, 200, myTickets);
      return;
    }

    const ext = path.extname(p);
    if (MIME[ext])           { serveFile(res, path.join(PUBLIC_DIR, p));                return; }
  }

  // ── Twilio: incoming/outbound call TwiML (Media Streams + Gemini Live) ──────
  if (p === '/api/voice' && (req.method === 'POST' || req.method === 'GET')) {
    if (req.method === 'POST' && process.env.TWILIO_AUTH_TOKEN) {
      const signature = req.headers['x-twilio-signature'];
      const protocol = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const webhookUrl = `${protocol}://${host}${req.url}`;
      const bodyBuf = await readRawBody(req);
      const params = new URLSearchParams(bodyBuf.toString());
      const formObj = {};
      for (const [k, v] of params.entries()) formObj[k] = v;
      const ok = twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, webhookUrl, formObj);
      if (!ok) { json(res, 403, { error: 'Invalid Twilio signature' }); return; }
      const base       = getPublicBase(req).replace(/^https?:\/\//, '');
      const callerPhone = formObj.To || formObj.From || '';
      const wsUrl      = `wss://${base}/api/stream`;
      xml(res, `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${wsUrl}">
      <Parameter name="callerPhone" value="${callerPhone}"/>
      <Parameter name="orgId" value="${DEFAULT_ORG_ID}"/>
    </Stream>
  </Connect>
</Response>`);
      return;
    }
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
    if (!isTeamMember(session)) { json(res, 401, { error: 'Unauthorized' }); return; }
    if (!checkRateLimit(req, 'api-call', 30, 60_000)) {
      json(res, 429, { error: 'Rate limit exceeded. Try again in a minute.' });
      return;
    }
    try {
      if (!(await hasActiveEntitlement(currentOrgId))) {
        json(res, 402, { error: 'Subscription required. Please update billing.' });
        return;
      }
      const body = await readBody(req);
      const to = body.to;
      if (!to) { json(res, 400, { error: 'Missing "to" phone number' }); return; }

      const base = getPublicBase(req);
      const call = await makeCall(to, base);

      transcriptBus.emit('transcript', { type: 'call_started', callSid: call.sid, to });
      json(res, 200, { callSid: call.sid, status: call.status });
    } catch (err) {
      captureError(err, { route: '/api/call' });
      json(res, 500, { error: err.message });
    }
    return;
  }

  // ── POST /api/call/end — end active call ─────────────────────────────────
  if (p === '/api/call/end' && req.method === 'POST') {
    if (!isTeamMember(session)) { json(res, 401, { error: 'Unauthorized' }); return; }
    try {
      const { callSid } = await readBody(req);
      // Signal the frontend that the call ended
      transcriptBus.emit('transcript', { type: 'call_ended', callSid });
      json(res, 200, { ok: true });
    } catch (err) {
      captureError(err, { route: '/api/call/end' });
      json(res, 500, { error: err.message });
    }
    return;
  }

  // ── POST /api/twilio/status — Twilio call status callback ────────────────
  if (p === '/api/twilio/status' && req.method === 'POST') {
    if (process.env.TWILIO_AUTH_TOKEN) {
      const signature = req.headers['x-twilio-signature'];
      const protocol = req.headers['x-forwarded-proto'] || 'https';
      const host = req.headers['x-forwarded-host'] || req.headers.host;
      const webhookUrl = `${protocol}://${host}${req.url}`;
      const bodyBuf = await readRawBody(req);
      const params = new URLSearchParams(bodyBuf.toString());
      const formObj = {};
      for (const [k, v] of params.entries()) formObj[k] = v;
      const ok = twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, webhookUrl, formObj);
      if (!ok) { json(res, 403, { error: 'Invalid Twilio signature' }); return; }
      const status = formObj.CallStatus || '';
      if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(status)) {
        transcriptBus.emit('transcript', { type: 'call_ended', status });
      } else if (status === 'in-progress') {
        transcriptBus.emit('transcript', { type: 'call_started', callSid: formObj.CallSid });
      }
      res.writeHead(200); res.end('ok');
      return;
    }
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
    if (!checkRateLimit(req, 'api-chat', 120, 60_000)) {
      json(res, 429, { error: 'Rate limit exceeded. Please retry shortly.' });
      return;
    }
    try {
      if (!(await hasActiveEntitlement(currentOrgId))) {
        json(res, 402, { error: 'Subscription required. Please update billing.' });
        return;
      }
      const { text, sessionId = 'browser-default' } = await readBody(req);
      if (!text || typeof text !== 'string') { json(res, 400, { error: 'Missing text' }); return; }
      const browserSession = getOrCreateBrowserSession(sessionId);
      const { reply, updatedHistory, functionCall } = await getReply(browserSession.history, text.trim());
      updateBrowserSession(sessionId, updatedHistory);
      let finalReply = reply;
      if (functionCall?.name === 'create_ticket' && functionCall?.args?.name && functionCall?.args?.phone && functionCall?.args?.complaint) {
        const ticket = await createTicket(
          functionCall.args.name,
          functionCall.args.phone,
          functionCall.args.complaint,
          functionCall.args.severity_score || 5,
          DEFAULT_ORG_ID,
        );
        const uploadUrl = `${getPublicBase(req)}/upload/${ticket.uploadToken}`;
        await sendTicketSms(ticket.phone, ticket.id, uploadUrl).catch(() => {});
        const followUp = await continueWithFunctionResult(updatedHistory, 'create_ticket', {
          ticket_id: ticket.id,
          upload_link: uploadUrl,
          sms_sent: true,
        });
        updateBrowserSession(sessionId, followUp.updatedHistory);
        finalReply = followUp.reply;
      }
      if (!finalReply) finalReply = 'Thanks. Your request has been recorded.';
      const audioBase64 = await synthesizeForBrowser(finalReply);
      json(res, 200, { reply: finalReply, audioBase64 });
    } catch (err) {
      captureError(err, { route: '/api/chat' });
      json(res, 500, { error: 'Internal server error' });
    }
    return;
  }

  // ── GET /api/transcripts — SSE live feed ──────────────────────────────────
  if (p === '/api/transcripts' && req.method === 'GET') {
    if (!isTeamMember(session)) { json(res, 401, { error: 'Unauthorized' }); return; }
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
    if (!checkRateLimit(req, 'send-otp', 20, 15 * 60_000)) {
      json(res, 429, { error: 'Too many OTP requests. Try again later.' });
      return;
    }
    const { identifier, type } = await readBody(req); // type: 'citizen' | 'admin'
    if (!identifier) { json(res, 400, { error: 'Missing identifier' }); return; }
    const orgSlug = url.searchParams.get('org');
    const org = orgSlug ? await getOrgFromSlug(orgSlug) : null;
    const orgId = org?.id || DEFAULT_ORG_ID;

    if (type === 'admin') {
      const email = identifier.toLowerCase().trim();
      const adminAllowed = ADMIN_EMAILS.length > 0 && ADMIN_EMAILS.includes(email);
      if (!adminAllowed && !org) {
        increment('authFailures');
        json(res, 403, { error: 'Not an admin email.' });
        return;
      }
      const otp = await createOtp(email, orgId, 'admin');
      try {
        await sendOtpEmail(email, otp);
        json(res, 200, { ok: true, message: `OTP sent to ${email}` });
      } catch (err) {
        console.error('[EMAIL OTP]', err.message);
        json(res, 500, { error: 'Failed to send OTP email. Check EMAIL_USER / EMAIL_PASS in .env' });
      }

    } else {
      // Citizen — OTP via Twilio SMS
      const phone = normalizePhoneForUs(identifier);
      const otp = await createOtp(phone, orgId, 'citizen');
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
    if (!checkRateLimit(req, 'verify-otp', 20, 10 * 60_000)) {
      json(res, 429, { error: 'Too many OTP attempts. Please retry later.' });
      return;
    }
    const { identifier, otp, type } = await readBody(req);
    if (!identifier || !otp) { json(res, 400, { error: 'Missing fields' }); return; }
    const orgSlug = url.searchParams.get('org');
    const org = orgSlug ? await getOrgFromSlug(orgSlug) : null;
    const orgId = org?.id || DEFAULT_ORG_ID;

    const id = type === 'admin'
      ? identifier.toLowerCase().trim()
      : normalizePhoneForUs(identifier);

    const result = await verifyOtp(id, otp, type === 'admin' ? 'admin' : 'citizen');
    if (!result.ok) {
      increment('authFailures');
      json(res, 401, { error: result.reason });
      return;
    }

    let role = 'citizen';
    if (type === 'admin') {
      if (hasPostgres && orgId !== DEFAULT_ORG_ID) {
        const { rows } = await query(
          `SELECT role FROM users WHERE org_id = $1 AND identifier = $2 LIMIT 1`,
          [orgId, id],
        );
        if (!rows[0]?.role || !TEAM_ROLES.has(rows[0].role)) {
          increment('authFailures');
          json(res, 403, { error: 'No team role found for this account.' });
          return;
        }
        role = rows[0].role;
      } else {
        role = 'owner';
      }
    }
    const token = await createSession(id, role, orgId);

    const isHttps = (req.headers['x-forwarded-proto'] || '').includes('https') || process.env.BASE_URL?.startsWith('https');
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie':   `session=${token}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax${isHttps ? '; Secure' : ''}`,
    });
    res.end(JSON.stringify({ ok: true, role, id, orgSlug: org?.slug || null }));
    return;
  }

  // ── POST /api/auth/logout ─────────────────────────────────────────────────
  if (p === '/api/auth/logout' && req.method === 'POST') {
    if (sessionToken) await deleteSession(sessionToken);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie':   'session=; HttpOnly; Path=/; Max-Age=0',
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── POST /api/signup — self-serve org onboarding ───────────────────────────
  if (p === '/api/signup' && req.method === 'POST') {
    if (!hasPostgres) { json(res, 503, { error: 'Signup requires DATABASE_URL configuration.' }); return; }
    const { companyName, ownerName, ownerEmail, industry = 'services', plan = 'starter' } = await readBody(req);
    if (!companyName || !ownerEmail) {
      json(res, 400, { error: 'companyName and ownerEmail are required.' });
      return;
    }
    const orgId = crypto.randomUUID();
    const ownerId = crypto.randomUUID();
    const slug = createOrgSlug(companyName);
    const trialEndsAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();
    await query(
      `INSERT INTO organizations (id, name, slug, owner_email, owner_name, industry, plan, trial_ends_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [orgId, companyName, slug, ownerEmail.toLowerCase().trim(), ownerName || null, industry, plan, trialEndsAt],
    );
    await query(
      `INSERT INTO users (id, org_id, name, identifier, role)
       VALUES ($1,$2,$3,$4,'owner')`,
      [ownerId, orgId, ownerName || ownerEmail, ownerEmail.toLowerCase().trim()],
    );
    await upsertSubscription(orgId, { status: 'trialing' });
    await logAudit('org.signup', null, { orgId, ownerEmail, plan });
    json(res, 201, {
      ok: true,
      org: { id: orgId, slug, plan, trialEndsAt },
      loginUrl: `/login?org=${encodeURIComponent(slug)}`,
    });
    return;
  }

  // ── POST /api/org/invite — invite teammate ────────────────────────────────
  if (p === '/api/org/invite' && req.method === 'POST') {
    if (!canManageTeam(session)) { json(res, 401, { error: 'Unauthorized' }); return; }
    if (!hasPostgres) { json(res, 503, { error: 'Invites require DATABASE_URL configuration.' }); return; }
    const { email, role = 'agent' } = await readBody(req);
    if (!email) { json(res, 400, { error: 'email is required' }); return; }
    if (!TEAM_ROLES.has(role)) { json(res, 400, { error: 'role must be owner, admin, or agent' }); return; }
    if (role === 'owner' && session.role !== 'owner') { json(res, 403, { error: 'Only owner can invite another owner.' }); return; }
    const token = crypto.randomBytes(24).toString('hex');
    await query(
      `INSERT INTO invites (id, org_id, email, role, token, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [crypto.randomUUID(), currentOrgId, email.toLowerCase().trim(), role, token, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()],
    );
    await logAudit('org.invite.created', session, { email, role });
    json(res, 201, { ok: true });
    return;
  }

  // ── POST /api/billing/checkout — start subscription checkout ──────────────
  if (p === '/api/billing/checkout' && req.method === 'POST') {
    if (!canManageBilling(session)) { json(res, 401, { error: 'Unauthorized' }); return; }
    if (!hasPostgres) { json(res, 503, { error: 'Billing requires DATABASE_URL configuration.' }); return; }
    const { plan = 'starter' } = await readBody(req);
    const { rows } = await query(`SELECT id, name, owner_email FROM organizations WHERE id = $1 LIMIT 1`, [currentOrgId]);
    const org = rows[0];
    if (!org) { json(res, 404, { error: 'Organization not found.' }); return; }
    const base = getPublicBase(req);
    const checkout = await createCheckoutSession({
      orgId: org.id,
      orgName: org.name,
      ownerEmail: org.owner_email,
      plan,
      successUrl: `${base}/pricing?billing=success`,
      cancelUrl: `${base}/pricing?billing=cancelled`,
    });
    await logAudit('billing.checkout.started', session, { plan, mode: checkout.mode });
    json(res, 200, { ok: true, checkoutUrl: checkout.url, stripeEnabled });
    return;
  }

  // ── POST /api/billing/webhook — Stripe subscription updates ───────────────
  if (p === STRIPE_WEBHOOK_PATH && req.method === 'POST') {
    const signature = req.headers['stripe-signature'];
    const raw = await readRawBody(req);
    const event = verifyStripeWebhook(raw, signature);
    if (!event) {
      increment('billingFailures');
      json(res, 200, { ok: true, skipped: true });
      return;
    }

    if (event.type === 'checkout.session.completed') {
      const sessionData = event.data.object;
      const orgId = sessionData.metadata?.orgId;
      if (orgId) {
        await upsertSubscription(orgId, {
          customerId: sessionData.customer,
          subscriptionId: sessionData.subscription,
          status: 'active',
        });
      }
    }

    if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const { rows } = await query(`SELECT org_id FROM subscriptions WHERE stripe_subscription_id = $1 LIMIT 1`, [sub.id]);
      if (rows[0]?.org_id) {
        await upsertSubscription(rows[0].org_id, {
          customerId: sub.customer,
          subscriptionId: sub.id,
          status: sub.status,
          currentPeriodEnd: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
        });
      }
    }

    res.writeHead(200); res.end('ok');
    return;
  }

  // ── GET /api/org/overview — onboarding metadata for dashboard ─────────────
  if (p === '/api/org/overview' && req.method === 'GET') {
    if (!session) { json(res, 401, { error: 'Unauthorized' }); return; }
    if (!hasPostgres) {
      json(res, 200, {
        org: { id: DEFAULT_ORG_ID, name: APP_NAME, plan: 'starter' },
        limits: getPlanLimits('starter'),
        billing: { status: 'trialing' },
      });
      return;
    }
    const orgRes = await query(`SELECT id, slug, name, plan, trial_ends_at FROM organizations WHERE id = $1 LIMIT 1`, [currentOrgId]);
    const subRes = await query(`SELECT status, current_period_end FROM subscriptions WHERE org_id = $1 LIMIT 1`, [currentOrgId]);
    if (!orgRes.rows[0]) { json(res, 404, { error: 'Organization not found' }); return; }
    json(res, 200, {
      org: orgRes.rows[0],
      limits: getPlanLimits(orgRes.rows[0].plan),
      billing: subRes.rows[0] || { status: 'trialing' },
    });
    return;
  }

  // ── POST /api/tickets — citizen complaint create ───────────────────────────
  if (p === '/api/tickets' && req.method === 'POST') {
    if (!session || session.role !== 'citizen') { json(res, 401, { error: 'Unauthorized' }); return; }
    if (!checkRateLimit(req, 'create-ticket', 50, 15 * 60_000)) {
      json(res, 429, { error: 'Too many requests. Please retry shortly.' });
      return;
    }
    const { name, complaint, severityScore } = await readBody(req);
    if (!(await hasActiveEntitlement(currentOrgId))) {
      json(res, 402, { error: 'Subscription required. Please update billing.' });
      return;
    }
    const trimName = (name || '').trim();
    const trimComplaint = (complaint || '').trim();
    if (!trimName || trimName.length > 100) { json(res, 400, { error: 'Name is required (1-100 characters)' }); return; }
    if (trimComplaint.length < 10 || trimComplaint.length > 2000) { json(res, 400, { error: 'Complaint must be 10-2000 characters' }); return; }
    const phone = session.id;
    const ticket = await createTicket(trimName, phone, trimComplaint, severityScore || 5, currentOrgId);
    increment('ticketCreates');
    const uploadUrl = `${getPublicBase(req)}/upload/${ticket.uploadToken}`;
    sendTicketSms(phone, ticket.id, uploadUrl).catch((e) => console.error('[SMS]', e.message));
    await logAudit('ticket.created', session, { ticketId: ticket.id });
    json(res, 201, { ticket, uploadUrl });
    return;
  }

  // ── PATCH /api/admin/ticket/:id/status — admin update status ─────────────
  if (p.match(/^\/api\/admin\/ticket\/([^/]+)\/status$/) && req.method === 'PATCH') {
    if (!isTeamMember(session)) { json(res, 401, { error: 'Unauthorized' }); return; }
    const ticketId = p.split('/')[4];
    const { status, note } = await readBody(req);
    const ticket = await getTicket(ticketId);
    if (!ticket) { json(res, 404, { error: 'Ticket not found' }); return; }
    if (ticket.orgId !== currentOrgId) { json(res, 403, { error: 'Forbidden' }); return; }
    if (status) ticket.status = status;
    if (note)   ticket.notes  = [...(ticket.notes || []), { text: note, by: session.id, at: new Date().toISOString() }];
    if (hasPostgres) {
      await query(
        `UPDATE tickets SET status = $1, notes = $2::jsonb WHERE id = $3`,
        [ticket.status, JSON.stringify(ticket.notes || []), ticketId],
      );
    }
    await logAudit('ticket.status.updated', session, { ticketId, status: ticket.status });
    json(res, 200, ticket);
    return;
  }

  // ── GET /api/onboarding/checklist — launch checklist ─────────────────────
  if (p === '/api/onboarding/checklist' && req.method === 'GET') {
    if (!session) { json(res, 401, { error: 'Unauthorized' }); return; }
    const checklist = [
      { id: 'connect-number', label: 'Connect Twilio number', done: Boolean(process.env.TWILIO_PHONE_NUMBER) },
      { id: 'run-test-call', label: 'Complete first test call', done: false },
      { id: 'invite-teammate', label: 'Invite teammate', done: false },
      { id: 'activate-billing', label: 'Activate billing', done: stripeEnabled },
    ];
    json(res, 200, checklist);
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
    const { ticket, error } = await getTicketByToken(tokenApiMatch[1]);
    if (error === 'expired') { json(res, 410, { error: 'This upload link has expired.' }); return; }
    if (!ticket) { json(res, 404, { error: 'Invalid upload link.' }); return; }
    const files = await Promise.all((ticket.files || []).map(async (file) => ({
      filename: file.filename,
      originalName: file.originalName,
      mimeType: file.mimeType,
      uploadedAt: file.uploadedAt,
      signedUrl: await getDownloadUrl(file),
    })));
    json(res, 200, { ...ticket, files });
    return;
  }

  // ── GET /api/ticket/:id — ticket details by ID (for dashboard) ───────────
  const ticketApiMatch = p.match(/^\/api\/ticket\/([^/]+)$/);
  if (ticketApiMatch && req.method === 'GET') {
    if (!session) { json(res, 401, { error: 'Unauthorized' }); return; }
    const ticket = await getTicket(ticketApiMatch[1]);
    if (!ticket) { json(res, 404, { error: 'Ticket not found' }); return; }
    if (session.role === 'citizen' && ticket.phone !== session.id) { json(res, 403, { error: 'Forbidden' }); return; }
    if (isTeamMember(session) && ticket.orgId !== currentOrgId) { json(res, 403, { error: 'Forbidden' }); return; }
    json(res, 200, ticket);
    return;
  }

  // ── POST /api/upload/:token — file upload via token ──────────────────────
  const uploadApiMatch = p.match(/^\/api\/upload\/([a-f0-9]+)$/);
  if (uploadApiMatch && req.method === 'POST') {
    const { ticket, error } = await getTicketByToken(uploadApiMatch[1]);
    if (error === 'expired') { json(res, 410, { error: 'This upload link has expired.' }); return; }
    if (!ticket) { json(res, 404, { error: 'Invalid upload link.' }); return; }
    const ticketId = ticket.id;

    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      json(res, 400, { error: 'Expected multipart/form-data' }); return;
    }

    const bb = busboy({ headers: req.headers, limits: { fileSize: 10 * 1024 * 1024 } });
    const uploads = [];

    bb.on('file', (fieldname, fileStream, info) => {
      const { filename, mimeType } = info;
      if (!ALLOWED_UPLOAD_MIME.has(mimeType)) {
        fileStream.resume();
        return;
      }
      uploads.push(new Promise((resolve, reject) => {
        const chunks = [];
        fileStream.on('data', (chunk) => chunks.push(chunk));
        fileStream.on('end', async () => {
          try {
            const saved = await saveUpload({
              ticketId,
              originalName: filename,
              mimeType,
              buffer: Buffer.concat(chunks),
            });
            const meta = {
              filename: saved.filename,
              originalName: filename,
              mimeType: saved.mimeType,
              storageProvider: saved.storageProvider,
              storageKey: saved.storageKey,
              uploadedAt: new Date().toISOString(),
            };
            await addFile(ticketId, meta);
            resolve(meta);
          } catch (error) {
            reject(error);
          }
        });
        fileStream.on('error', reject);
      }));
    });

    bb.on('finish', async () => {
      try {
        const savedFiles = await Promise.all(uploads);
        json(res, 200, { success: true, filesCount: (ticket.files?.length || 0) + savedFiles.length });
      } catch (error) {
        increment('uploadFailures');
        captureError(error, { route: '/api/upload/:token' });
        json(res, 500, { error: 'Upload failed' });
      }
    });

    bb.on('error', (err) => {
      increment('uploadFailures');
      captureError(err, { route: '/api/upload/:token:busboy' });
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
  console.log(`\n🤖  ${APP_NAME}`);
  console.log(`    Dashboard   → http://localhost:${PORT}/`);
  console.log(`    Signup      → http://localhost:${PORT}/signup`);
  console.log(`    Simulation  → http://localhost:${PORT}/simulation`);
  console.log(`    Voice hook  → POST ${base}/api/voice  (Twilio)\n`);
});

initDatabase()
  .then(() => connectRedis())
  .catch((error) => console.error('[BOOT]', error.message));
