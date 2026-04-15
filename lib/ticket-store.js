const crypto = require('crypto');
const { query, hasPostgres } = require('./db');
const tickets = new Map();
const tokens = new Map(); // token → ticketId

const TOKEN_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

// Daily counter: { date: 'YYYYMMDD', count: N }
let counter = { date: '', count: 0 };

function todayStr() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function nextId(prefix = 'SAAS') {
  const today = todayStr();
  if (counter.date !== today) {
    counter.date  = today;
    counter.count = 0;
  }
  counter.count++;
  return `${prefix}-${today}-${String(counter.count).padStart(4, '0')}`;
}

function normalizePhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (String(phone).startsWith('+')) return String(phone).trim();
  if (digits.length > 11) return `+${digits}`;
  return `+1${digits}`;
}

function normalizeWords(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
}

function jaccardSimilarity(setA, setB) {
  const a = new Set(setA);
  const b = new Set(setB);
  let intersection = 0;
  for (const w of a) { if (b.has(w)) intersection++; }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function countSimilarOpen(complaintText, orgId = null) {
  const words = normalizeWords(complaintText);
  const normalized = words.join(' ');
  let count = 0;
  for (const t of tickets.values()) {
    if (t.status !== 'open') continue;
    if (orgId && t.orgId !== orgId) continue;
    const tWords = normalizeWords(t.complaint);
    const tNormalized = tWords.join(' ');
    const isSubstring = normalized.includes(tNormalized) || tNormalized.includes(normalized);
    if (isSubstring || jaccardSimilarity(words, tWords) >= 0.6) {
      count++;
    }
  }
  return count;
}

async function countSimilarOpenDb(complaintText, orgId) {
  const { rows } = await query(
    `SELECT complaint FROM tickets WHERE org_id = $1 AND status = 'open' ORDER BY created_at DESC LIMIT 200`,
    [orgId],
  );
  const words = normalizeWords(complaintText);
  const normalized = words.join(' ');
  let count = 0;
  for (const row of rows) {
    const tWords = normalizeWords(row.complaint);
    const tNormalized = tWords.join(' ');
    const isSubstring = normalized.includes(tNormalized) || tNormalized.includes(normalized);
    if (isSubstring || jaccardSimilarity(words, tWords) >= 0.6) count++;
  }
  return count;
}

function mapTicketRecord(ticket, files = []) {
  return {
    ...ticket,
    severityScore: Number(ticket.severity_score ?? ticket.severityScore),
    createdAt: ticket.created_at || ticket.createdAt,
    uploadToken: ticket.upload_token || ticket.uploadToken,
    uploadExpiry: ticket.upload_expiry || ticket.uploadExpiry,
    orgId: ticket.org_id || ticket.orgId,
    notes: Array.isArray(ticket.notes) ? ticket.notes : (ticket.notes || []),
    files: files.map((f) => ({
      filename: f.filename,
      originalName: f.original_name || f.originalName,
      mimeType: f.mime_type || f.mimeType,
      storageProvider: f.storage_provider || f.storageProvider || 'local',
      storageKey: f.storage_key || f.storageKey || null,
      uploadedAt: f.uploaded_at || f.uploadedAt,
    })),
  };
}

async function createTicket(name, phone, complaint, severityScore, orgId = 'public') {
  const id = nextId('SMB');
  const token = crypto.randomBytes(24).toString('hex'); // 48-char URL-safe token
  const expiry = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

  const rawScore = Math.max(1, Math.min(10, Math.round(Number(severityScore) || 5)));
  const similarCount = hasPostgres ? await countSimilarOpenDb(complaint, orgId) : countSimilarOpen(complaint, orgId);
  const finalScore = Math.min(10, rawScore + similarCount);

  const ticket = {
    id,
    orgId,
    name:        name.trim(),
    phone:       normalizePhone(phone),
    complaint:   complaint.trim(),
    severityScore: finalScore,
    status:      'open',
    createdAt:   new Date().toISOString(),
    uploadToken: token,
    uploadExpiry: expiry,
    files:       [],
  };

  if (hasPostgres) {
    await query(
      `INSERT INTO tickets (id, org_id, name, phone, complaint, severity_score, status, upload_token, upload_expiry, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
      [id, orgId, ticket.name, ticket.phone, ticket.complaint, finalScore, 'open', token, expiry, JSON.stringify([])],
    );
  } else {
    tickets.set(id, ticket);
    tokens.set(token, id);
  }
  console.log(`[TICKET] Created ${id} — severity ${finalScore} (base=${rawScore}, similar=${similarCount}) — token expires ${expiry}`);
  return ticket;
}

async function getTicket(id) {
  if (hasPostgres) {
    const { rows } = await query(`SELECT * FROM tickets WHERE id = $1 LIMIT 1`, [id]);
    if (!rows[0]) return null;
    const filesRes = await query(`SELECT * FROM ticket_files WHERE ticket_id = $1 ORDER BY uploaded_at DESC`, [id]);
    return mapTicketRecord(rows[0], filesRes.rows);
  }
  return tickets.get(id) || null;
}

// Resolve token → ticket, checking expiry
async function getTicketByToken(token) {
  if (hasPostgres) {
    const { rows } = await query(`SELECT * FROM tickets WHERE upload_token = $1 LIMIT 1`, [token]);
    const record = rows[0];
    if (!record) return { ticket: null, error: 'invalid' };
    const expiryTime = new Date(record.upload_expiry).getTime();
    if (Date.now() > expiryTime) return { ticket: null, error: 'expired' };
    const filesRes = await query(`SELECT * FROM ticket_files WHERE ticket_id = $1 ORDER BY uploaded_at DESC`, [record.id]);
    return { ticket: mapTicketRecord(record, filesRes.rows), error: null };
  }

  const id = tokens.get(token);
  if (!id) return { ticket: null, error: 'invalid' };
  const ticket = tickets.get(id);
  if (!ticket) return { ticket: null, error: 'invalid' };
  if (Date.now() > new Date(ticket.uploadExpiry).getTime()) return { ticket: null, error: 'expired' };
  return { ticket, error: null };
}

async function addFile(ticketId, fileMetadata) {
  if (hasPostgres) {
    await query(
      `INSERT INTO ticket_files (id, ticket_id, filename, original_name, mime_type, storage_provider, storage_key, uploaded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        crypto.randomUUID(),
        ticketId,
        fileMetadata.filename,
        fileMetadata.originalName,
        fileMetadata.mimeType,
        fileMetadata.storageProvider || 'local',
        fileMetadata.storageKey || null,
        fileMetadata.uploadedAt || new Date().toISOString(),
      ],
    );
    return;
  }
  const ticket = tickets.get(ticketId);
  if (ticket) ticket.files.push(fileMetadata);
}

async function getAllTickets(orgId = null, phone = null) {
  if (hasPostgres) {
    const params = [];
    const clauses = [];
    if (orgId) {
      params.push(orgId);
      clauses.push(`org_id = $${params.length}`);
    }
    if (phone) {
      params.push(phone);
      clauses.push(`phone = $${params.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await query(`SELECT * FROM tickets ${where} ORDER BY created_at DESC`, params);
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const filesRes = await query(`SELECT * FROM ticket_files WHERE ticket_id = ANY($1::text[])`, [ids]);
    const filesByTicket = new Map();
    for (const file of filesRes.rows) {
      const list = filesByTicket.get(file.ticket_id) || [];
      list.push(file);
      filesByTicket.set(file.ticket_id, list);
    }
    return rows.map((row) => mapTicketRecord(row, filesByTicket.get(row.id) || []));
  }
  const source = Array.from(tickets.values());
  const filtered = orgId ? source.filter((t) => t.orgId === orgId) : source;
  return filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

module.exports = { createTicket, getTicket, getTicketByToken, addFile, getAllTickets };
