const twilio = require('twilio');

function makeCall(toNumber, webhookBaseUrl) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER } = process.env;

  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER) {
    throw new Error('Missing TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_PHONE_NUMBER in .env');
  }

  const base   = webhookBaseUrl.replace(/\/$/, '');
  const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

  return client.calls.create({
    from:         TWILIO_PHONE_NUMBER,
    to:           toNumber,
    url:          `${base}/api/voice`,
    statusCallback: `${base}/api/twilio/status`,
    statusCallbackMethod: 'POST',
    timeout:      30,
  });
}

module.exports = { makeCall };
