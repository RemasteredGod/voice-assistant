const twilio = require('twilio');

// Singleton client — created once, reused on every call
let _client = null;
function getClient() {
  if (!_client) {
    const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = process.env;
    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
      throw new Error('Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN in .env');
    }
    _client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  }
  return _client;
}

async function makeCall(toNumber, webhookBaseUrl) {
  const { TWILIO_PHONE_NUMBER } = process.env;
  if (!TWILIO_PHONE_NUMBER) throw new Error('Missing TWILIO_PHONE_NUMBER in .env');

  const base = webhookBaseUrl.replace(/\/$/, '');
  const client = getClient();

  console.log(`[CALL] Placing call → ${toNumber} from ${TWILIO_PHONE_NUMBER}`);
  console.log(`[CALL] Webhook: ${base}/api/voice`);

  const call = await client.calls.create({
    from:                TWILIO_PHONE_NUMBER,
    to:                  toNumber,
    url:                 `${base}/api/voice`,
    statusCallback:      `${base}/api/twilio/status`,
    statusCallbackMethod:'POST',
    timeout:             30,
  });

  console.log(`[CALL] Created — sid: ${call.sid}, status: ${call.status}`);
  return call;
}

module.exports = { makeCall };
