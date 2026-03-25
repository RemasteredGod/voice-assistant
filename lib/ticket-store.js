const crypto  = require('crypto');
const tickets = new Map();
const tokens  = new Map(); // token → ticketId

const TOKEN_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

// Daily counter: { date: 'YYYYMMDD', count: N }
let counter = { date: '', count: 0 };

function todayStr() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, '');
}

function nextId() {
  const today = todayStr();
  if (counter.date !== today) {
    counter.date  = today;
    counter.count = 0;
  }
  counter.count++;
  return `DMC-${today}-${String(counter.count).padStart(4, '0')}`;
}

function normalizePhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length === 10) return '+91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return '+' + digits;
  return phone;
}

function createTicket(name, phone, complaint) {
  const id    = nextId();
  const token = crypto.randomBytes(24).toString('hex'); // 48-char URL-safe token
  const expiry = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

  const ticket = {
    id,
    name:        name.trim(),
    phone:       normalizePhone(phone),
    complaint:   complaint.trim(),
    status:      'open',
    createdAt:   new Date().toISOString(),
    uploadToken: token,
    uploadExpiry: expiry,
    files:       [],
  };

  tickets.set(id, ticket);
  tokens.set(token, id);
  console.log(`[TICKET] Created ${id} — token expires ${expiry}`);
  return ticket;
}

function getTicket(id) {
  return tickets.get(id) || null;
}

// Resolve token → ticket, checking expiry
function getTicketByToken(token) {
  const id = tokens.get(token);
  if (!id) return { ticket: null, error: 'invalid' };
  const ticket = tickets.get(id);
  if (!ticket) return { ticket: null, error: 'invalid' };
  if (Date.now() > new Date(ticket.uploadExpiry).getTime()) {
    return { ticket: null, error: 'expired' };
  }
  return { ticket, error: null };
}

function addFile(ticketId, fileMetadata) {
  const ticket = tickets.get(ticketId);
  if (ticket) ticket.files.push(fileMetadata);
}

function getAllTickets() {
  return Array.from(tickets.values()).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

module.exports = { createTicket, getTicket, getTicketByToken, addFile, getAllTickets };
