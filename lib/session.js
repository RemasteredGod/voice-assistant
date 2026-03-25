const { EventEmitter } = require('events');

const sessions = new Map();
const browserSessions = new Map();

const transcriptBus = new EventEmitter();
transcriptBus.setMaxListeners(200);

function createSession(streamSid, callSid, ws) {
  const session = {
    callSid,
    streamSid,
    ws,
    history: [],
    sttStream: null,
    debounceTimer: null,
    pendingTranscript: '',
    createdAt: Date.now(),
  };
  sessions.set(streamSid, session);
  return session;
}

function getSession(streamSid) {
  return sessions.get(streamSid) || null;
}

function deleteSession(streamSid) {
  const session = sessions.get(streamSid);
  if (!session) return;
  if (session.debounceTimer) clearTimeout(session.debounceTimer);
  if (session.sttStream) {
    try { session.sttStream.end(); } catch (_) {}
  }
  sessions.delete(streamSid);
}

function getOrCreateBrowserSession(sessionId) {
  if (!browserSessions.has(sessionId)) {
    browserSessions.set(sessionId, { history: [], createdAt: Date.now() });
  }
  return browserSessions.get(sessionId);
}

function updateBrowserSession(sessionId, history) {
  const s = browserSessions.get(sessionId);
  if (s) browserSessions.set(sessionId, { ...s, history });
}

function emitTranscript(event) {
  transcriptBus.emit('transcript', event);
}

// Prune old browser sessions every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, s] of browserSessions) {
    if (s.createdAt < cutoff) browserSessions.delete(id);
  }
}, 10 * 60 * 1000);

module.exports = {
  createSession,
  getSession,
  deleteSession,
  getOrCreateBrowserSession,
  updateBrowserSession,
  emitTranscript,
  transcriptBus,
};
