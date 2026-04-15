const crypto = require('crypto');
const { query, hasPostgres } = require('./db');
const { setJson, getJson, delKey } = require('./cache');

const otps = new Map();

const OTP_TTL_MS = 5 * 60 * 1000;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;

function hashOtp(otp) {
  return crypto.createHash('sha256').update(String(otp)).digest('hex');
}

function generateOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

function normalizeIdentifier(identifier) {
  return String(identifier || '').trim().toLowerCase();
}

async function createOtp(identifier, orgId = null, type = 'citizen') {
  const normalizedIdentifier = normalizeIdentifier(identifier);
  const otp = generateOtp();
  const expiresAt = Date.now() + OTP_TTL_MS;
  const otpHash = hashOtp(otp);

  if (hasPostgres) {
    await query(`DELETE FROM otp_codes WHERE identifier = $1`, [normalizedIdentifier]);
    await query(
      `INSERT INTO otp_codes (id, org_id, identifier, otp_hash, type, expires_at) VALUES ($1, $2, $3, $4, $5, $6)`,
      [crypto.randomUUID(), orgId, normalizedIdentifier, otpHash, type, new Date(expiresAt).toISOString()],
    );
  } else {
    otps.set(normalizedIdentifier, { otpHash, expiresAt, attempts: 0, type });
  }
  return otp;
}

async function verifyOtp(identifier, inputOtp, expectedType = 'citizen') {
  const normalizedIdentifier = normalizeIdentifier(identifier);
  const incomingHash = hashOtp(String(inputOtp).trim());

  if (hasPostgres) {
    const { rows } = await query(
      `SELECT id, otp_hash, attempts, type, expires_at
       FROM otp_codes
       WHERE identifier = $1
       ORDER BY created_at DESC LIMIT 1`,
      [normalizedIdentifier],
    );
    const record = rows[0];
    if (!record) return { ok: false, reason: 'No OTP found. Please request a new one.' };

    if (Date.now() > new Date(record.expires_at).getTime()) {
      await query(`DELETE FROM otp_codes WHERE id = $1`, [record.id]);
      return { ok: false, reason: 'OTP expired. Please request a new one.' };
    }

    if (record.attempts >= MAX_OTP_ATTEMPTS) {
      return { ok: false, reason: 'Too many attempts. Please request a new OTP.' };
    }
    if (record.type !== expectedType) {
      return { ok: false, reason: 'OTP type mismatch. Please request a new OTP.' };
    }

    if (record.otp_hash !== incomingHash) {
      await query(`UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1`, [record.id]);
      return { ok: false, reason: 'Incorrect OTP.' };
    }

    await query(`DELETE FROM otp_codes WHERE id = $1`, [record.id]);
    return { ok: true };
  }

  const record = otps.get(normalizedIdentifier);
  if (!record) return { ok: false, reason: 'No OTP found. Please request a new one.' };
  if (Date.now() > record.expiresAt) {
    otps.delete(normalizedIdentifier);
    return { ok: false, reason: 'OTP expired. Please request a new one.' };
  }
  if ((record.attempts || 0) >= MAX_OTP_ATTEMPTS) {
    return { ok: false, reason: 'Too many attempts. Please request a new OTP.' };
  }
  if ((record.type || 'citizen') !== expectedType) {
    return { ok: false, reason: 'OTP type mismatch. Please request a new OTP.' };
  }
  if (record.otpHash !== incomingHash) {
    record.attempts = (record.attempts || 0) + 1;
    otps.set(normalizedIdentifier, record);
    return { ok: false, reason: 'Incorrect OTP.' };
  }
  otps.delete(normalizedIdentifier);
  return { ok: true };
}

async function createSession(id, role, orgId = null) {
  const token = crypto.randomBytes(32).toString('hex');
  const payload = { id, role, orgId, createdAt: Date.now() };
  await setJson(`session:${token}`, payload, Math.floor(SESSION_TTL_MS / 1000));

  if (hasPostgres) {
    await query(
      `INSERT INTO sessions (token, org_id, identifier, role, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [token, orgId, id, role, new Date(Date.now() + SESSION_TTL_MS).toISOString()],
    );
  }
  return token;
}

async function getSession(token) {
  if (!token) return null;

  const cached = await getJson(`session:${token}`);
  if (cached) return cached;

  if (!hasPostgres) return null;
  const { rows } = await query(
    `SELECT org_id, identifier, role, created_at, expires_at FROM sessions WHERE token = $1 LIMIT 1`,
    [token],
  );
  const session = rows[0];
  if (!session) return null;
  if (Date.now() > new Date(session.expires_at).getTime()) {
    await query(`DELETE FROM sessions WHERE token = $1`, [token]);
    return null;
  }
  const payload = {
    id: session.identifier,
    role: session.role,
    orgId: session.org_id,
    createdAt: new Date(session.created_at).getTime(),
  };
  await setJson(`session:${token}`, payload, Math.floor((new Date(session.expires_at).getTime() - Date.now()) / 1000));
  return payload;
}

async function deleteSession(token) {
  await delKey(`session:${token}`);
  if (hasPostgres) {
    await query(`DELETE FROM sessions WHERE token = $1`, [token]);
  }
}

// Parse session token from Cookie header
function parseSessionCookie(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)session=([a-f0-9]+)/);
  return match ? match[1] : null;
}

module.exports = { createOtp, verifyOtp, createSession, getSession, deleteSession, parseSessionCookie };
