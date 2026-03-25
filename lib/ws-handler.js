const { getReply, continueWithFunctionResult } = require('./gemini');
const { emitTranscript }  = require('./session');
const { createTicket }    = require('./ticket-store');
const { sendTicketSms }   = require('./sms');

const GREETING = 'Namaste! Welcome to Delhi Municipal Corporation helpline. You can speak in Hindi, Hinglish, or English. Please go ahead.';

function handleConnection(ws) {
  let callSid     = null;
  let callerPhone = null;
  let history     = [];

  ws.on('message', async (raw) => {
    const rawStr = raw.toString();
    let msg;
    try { msg = JSON.parse(rawStr); } catch { return; }

    const msgType = msg.type || msg.event;

    switch (msgType) {

      case 'setup':
        callSid     = msg.callSid;
        // msg.to is the actual user's number (we dial OUT from Twilio TO the user)
        // msg.from is the Twilio number — never use that as SMS target
        callerPhone = msg.to || msg.from || null;
        console.log(`[CR] Connected — callSid: ${callSid}, callerPhone: ${callerPhone} (from=${msg.from} to=${msg.to})`);
        history = [];
        break;

      case 'prompt': {
        const userText = (msg.voicePrompt || '').trim();
        if (!userText) return;
        console.log(`[CR] User said: "${userText}"`);
        emitTranscript({ type: 'user', text: userText, callSid });

        try {
          const { reply, functionCall, updatedHistory } = await getReply(history, userText);
          history = updatedHistory;

          if (functionCall && functionCall.name === 'create_ticket') {
            await handleTicketCreation(ws, functionCall.args, callerPhone, callSid);
          } else if (reply) {
            console.log(`[CR] Jarvis: "${reply}"`);
            emitTranscript({ type: 'ai', text: reply, callSid });
            send(ws, { type: 'text', token: reply, last: true });
          }
        } catch (err) {
          console.error('[CR] Error in prompt handler:', err.message, err.stack);
        }
        break;
      }

      case 'interrupt':
        console.log('[CR] Caller interrupted');
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    console.log(`[CR] Disconnected — callSid: ${callSid}`);
    if (callSid) emitTranscript({ type: 'call_ended', callSid });
  });

  ws.on('error', (err) => console.error('[CR] WS error:', err.message));

  async function handleTicketCreation(ws, args, callerPhone, callSid) {
    const { name, phone, complaint } = args;

    if (!name || !phone || !complaint) {
      console.error('[TICKET] Missing fields in function call args:', args);
      send(ws, { type: 'text', token: 'I am sorry, I could not create the ticket. Please provide your name, phone number, and complaint again.', last: true });
      return;
    }

    // Create the ticket
    const ticket   = createTicket(name, phone, complaint);
    const base      = process.env.BASE_URL || 'http://localhost:3000';
    const uploadUrl = `${base}/upload/${ticket.uploadToken}`;

    console.log(`[TICKET] ${ticket.id} created — upload URL: ${uploadUrl}`);
    emitTranscript({ type: 'ai', text: `Ticket ${ticket.id} created for ${name}`, callSid });

    // Send SMS — non-blocking, failure should not stop the call
    const smsTarget = callerPhone || phone;
    try {
      await sendTicketSms(smsTarget, ticket.id, uploadUrl);
    } catch (err) {
      console.error('[TICKET] SMS failed, continuing:', err.message);
    }

    // Ask Gemini to speak the confirmation
    const functionResult = {
      ticketId:   ticket.id,
      status:     'created',
      uploadLink: uploadUrl,
      smsSent:    true,
    };

    try {
      const { reply, updatedHistory } = await continueWithFunctionResult(
        history, 'create_ticket', functionResult
      );
      history = updatedHistory;
      console.log(`[CR] Ticket confirmation: "${reply}"`);
      emitTranscript({ type: 'ai', text: reply, callSid });
      send(ws, { type: 'text', token: reply, last: true });
    } catch (err) {
      // Fallback spoken message if Gemini fails
      console.error('[TICKET] continueWithFunctionResult failed:', err.message);
      const fallback = `Your complaint has been registered. Your ticket number is ${ticket.id.split('').join(' ')}. An SMS with the upload link has been sent to your phone. Thank you for contacting Delhi Municipal Corporation.`;
      emitTranscript({ type: 'ai', text: fallback, callSid });
      send(ws, { type: 'text', token: fallback, last: true });
    }
  }
}

function send(ws, data) {
  if (ws.readyState === 1) ws.send(JSON.stringify(data));
}

module.exports = { handleConnection };
