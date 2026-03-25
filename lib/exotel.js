const https = require('https');

function makeCall(toNumber, webhookBaseUrl) {
  const {
    EXOTEL_ACCOUNT_SID,
    EXOTEL_API_KEY,
    EXOTEL_API_TOKEN,
    EXOTEL_PHONE_NUMBER,
    EXOTEL_SUBDOMAIN = 'api.exotel.com',
  } = process.env;

  if (!EXOTEL_ACCOUNT_SID || EXOTEL_ACCOUNT_SID === 'YOUR_EXOTEL_ACCOUNT_SID') {
    throw new Error('EXOTEL_ACCOUNT_SID not set in .env');
  }
  if (!EXOTEL_PHONE_NUMBER || EXOTEL_PHONE_NUMBER === 'YOUR_EXOPHONE_NUMBER') {
    throw new Error('EXOTEL_PHONE_NUMBER not set in .env — add your Exophone number');
  }

  const base = webhookBaseUrl.replace(/\/$/, '');

  const params = new URLSearchParams({
    From:           EXOTEL_PHONE_NUMBER,
    To:             toNumber,
    CallerId:       EXOTEL_PHONE_NUMBER,
    Url:            `${base}/api/exotel/voice`,
    CallType:       'trans',
    TimeLimit:      '3600',
    TimeOut:        '40',
    StatusCallback: `${base}/api/exotel/status`,
  });

  const auth    = Buffer.from(`${EXOTEL_API_KEY}:${EXOTEL_API_TOKEN}`).toString('base64');
  const body    = params.toString();
  const path    = `/v1/Accounts/${EXOTEL_ACCOUNT_SID}/Calls/connect`;

  const options = {
    hostname: EXOTEL_SUBDOMAIN,
    path,
    method:   'POST',
    headers:  {
      Authorization:   `Basic ${auth}`,
      'Content-Type':  'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(`Exotel ${res.statusCode}: ${data}`));
        }
        try {
          const json = JSON.parse(data);
          resolve(json.Call || json);
        } catch {
          reject(new Error(`Unparseable Exotel response: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { makeCall };
