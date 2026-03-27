'use strict';

const { GeminiLiveSession } = require('./gemini-live');
const { emitTranscript }    = require('./session');
const { createTicket }      = require('./ticket-store');
const { sendTicketSms }     = require('./sms');

function handleConnection(ws, req) {
  let callerPhone = null;
  try {
    const urlObj = new URL(req.url, 'http://localhost');
    callerPhone  = urlObj.searchParams.get('callerPhone') || null;
  } catch (_) {}

  let streamSid  = null;
  let callSid    = null;
  let gemini     = null;
  let isClosed   = false;
  let geminiReady = false;   // true once Gemini session is open and stable

  const geminiCallbacks = {
    onTranscript: (text, isFinal) => {
      if (text.startsWith('__ai__')) {
        const aiText = text.slice(6).trim();
        if (!aiText) return;
        console.log(`[Samadhan] "${aiText}"`);
        emitTranscript({ type: 'ai', text: aiText, callSid });
      } else {
        const userText = text.trim();
        if (!userText) return;
        console.log(`[STT${isFinal ? '' : ' interim'}] "${userText}"`);
        // Only push final user turns to the simulation (avoids duplicate interim lines)
        if (isFinal) emitTranscript({ type: 'user', text: userText, callSid });
      }
    },

    // Gemini sends native audio — forward MULAW directly to Twilio
    onAudio: (mulawBuf) => {
      if (!streamSid || ws.readyState !== 1) return;
      wsSend({
        event:     'media',
        streamSid,
        media:     { payload: mulawBuf.toString('base64') },
      });
    },

    onFunctionCall: async ({ id, name, args }) => {
      if (name !== 'create_ticket') {
        console.warn('[WS] Unknown function call:', name);
        return;
      }
      const result = handleTicketCreation(args);   // NOT awaited — SMS fires async
      gemini.sendToolResponse(id, name, result);   // respond to Gemini immediately
    },

    onClose: () => {
      if (!isClosed) {
        isClosed = true;
        emitTranscript({ type: 'call_ended', callSid });
      }
    },
  };

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.event) {
      case 'connected':
        console.log('[MediaStream] WebSocket connected');
        break;

      case 'start': {
        streamSid   = msg.streamSid;
        callSid     = msg.start.callSid;
        callerPhone = msg.start.customParameters?.callerPhone || callerPhone || null;
        console.log(`[MediaStream] Start — streamSid: ${streamSid}, callSid: ${callSid}, callerPhone: ${callerPhone}`);

        gemini = new GeminiLiveSession(geminiCallbacks);
        gemini.connect()
          .then(() => { geminiReady = true; })
          .catch(err => console.error('[MediaStream] Gemini connect error:', err.message));
        break;
      }

      case 'media': {
        if (msg.media?.track === 'outbound') return;
        if (!msg.media?.payload || !gemini || !geminiReady) return;
        gemini.sendAudio(Buffer.from(msg.media.payload, 'base64'));
        break;
      }

      case 'stop':
        console.log('[MediaStream] Stop event');
        cleanup();
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    console.log('[MediaStream] WS closed');
    cleanup();
  });

  ws.on('error', err => console.error('[MediaStream] WS error:', err.message));

  function cleanup() {
    if (isClosed) return;
    isClosed = true;
    if (gemini) { gemini.close(); gemini = null; }
    emitTranscript({ type: 'call_ended', callSid });
  }

  // Synchronous ticket creation — returns result immediately, fires SMS async
  function handleTicketCreation(args) {
    const { name, phone, complaint, severity_score } = args;

    if (!name || !phone || !complaint) {
      console.error('[TICKET] Missing fields:', args);
      return { error: 'Missing required fields — please provide name, phone, and complaint.' };
    }

    const ticket    = createTicket(name, phone, complaint, severity_score);
    const base      = process.env.BASE_URL || 'http://localhost:3000';
    const uploadUrl = `${base}/upload/${ticket.uploadToken}`;

    console.log(`[TICKET] ${ticket.id} created — severity: ${ticket.severityScore}`);
    emitTranscript({ type: 'ai', text: `Ticket ${ticket.id} created for ${name}`, callSid });

    // Fire-and-forget SMS — do not block Gemini's tool response
    const smsTarget = callerPhone || phone;
    sendTicketSms(smsTarget, ticket.id, uploadUrl)
      .catch(err => console.error('[TICKET] SMS failed:', err.message));

    return {
      ticketId:   ticket.id,
      status:     'created',
      uploadLink: uploadUrl,
      smsSent:    true,
    };
  }

  function wsSend(data) {
    if (ws.readyState === 1) ws.send(JSON.stringify(data));
  }
}

module.exports = { handleConnection };
