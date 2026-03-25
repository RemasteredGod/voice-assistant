const { getReply }     = require('./gemini');
const { emitTranscript } = require('./session');

// ConversationRelay protocol (no STT/TTS needed — Twilio handles it)
// Receive: { type: "setup" | "prompt" | "interrupt", ... }
// Send:    { type: "text", token: "...", last: true/false }

const GREETING = 'Namaste! Welcome to Delhi Municipal Corporation helpline. You can speak in Hindi, Hinglish, or English. Please go ahead.';

function handleConnection(ws) {
  let callSid = null;
  let history  = [];

  ws.on('message', async (raw) => {
    const rawStr = raw.toString();

    // Log every single message — first 300 chars so we can see structure
    console.log(`[WS RAW] ${rawStr.slice(0, 300)}`);

    let msg;
    try { msg = JSON.parse(rawStr); } catch { console.log('[WS] non-JSON message'); return; }

    console.log(`[WS] type="${msg.type || msg.event}" keys=${Object.keys(msg).join(',')}`);

    // Handle both ConversationRelay ("type") and Media Streams ("event") protocols
    const msgType = msg.type || msg.event;

    switch (msgType) {

      // ── ConversationRelay messages ─────────────────────────────────────────
      case 'setup':
        callSid = msg.callSid;
        console.log(`[CR] Setup — callSid: ${callSid}, full msg:`, JSON.stringify(msg));
        history = [];  // start empty — greeting is spoken by ConversationRelay
        break;

      case 'prompt': {
        const userText = (msg.voicePrompt || msg.text || '').trim();
        const lang     = msg.lang || 'en-IN';
        console.log(`[CR] Prompt received — lang=${lang} voicePrompt="${msg.voicePrompt}" last=${msg.last}`);
        if (!userText) { console.log('[CR] Empty prompt, skipping'); return; }
        console.log(`[CR] User said: "${userText}"`);
        emitTranscript({ type: 'user', text: userText, callSid });

        try {
          console.log('[CR] Calling Gemini...');
          const { reply, updatedHistory } = await getReply(history, userText, lang);
          history = updatedHistory;
          console.log(`[CR] Gemini replied: "${reply}"`);
          emitTranscript({ type: 'ai', text: reply, callSid });

          if (ws.readyState === 1) {
            const payload = JSON.stringify({ type: 'text', token: reply, last: true });
            console.log(`[CR] Sending back: ${payload}`);
            ws.send(payload);
          } else {
            console.log(`[CR] WS not open (readyState=${ws.readyState}), cannot send`);
          }
        } catch (err) {
          console.error('[CR] Gemini error:', err.message, err.stack);
        }
        break;
      }

      case 'interrupt':
        console.log(`[CR] Caller interrupted`);
        break;

      // ── Legacy Media Streams messages (fallback detection) ─────────────────
      case 'connected':
        console.log('[WS] Twilio Media Streams connected — ConversationRelay NOT active!');
        break;

      case 'start':
        console.log('[WS] Media Streams "start" — this means ConversationRelay TwiML was not used');
        break;

      case 'media':
        // Silently count media packets — don't log each one
        break;

      default:
        console.log(`[WS] Unknown message type: "${msgType}", full:`, JSON.stringify(msg).slice(0, 200));
        break;
    }
  });

  ws.on('close', () => {
    console.log(`[CR] Call disconnected — callSid: ${callSid}`);
    if (callSid) emitTranscript({ type: 'call_ended', callSid });
  });

  ws.on('error', (err) => console.error('[CR] WS error:', err.message));
}

module.exports = { handleConnection };
