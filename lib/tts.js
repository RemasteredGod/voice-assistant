const textToSpeech = require('@google-cloud/text-to-speech');

const client = new textToSpeech.TextToSpeechClient();

// Best available Indian male voice per encoding type
// Chirp3-HD = ultra-natural, only supports LINEAR16/MP3 (browser)
// Neural2   = high-quality, supports MULAW (Twilio phone calls)

const VOICE_BROWSER = {
  languageCode: 'en-IN',
  name: 'en-IN-Chirp3-HD-Alnilam',  // best Indian male voice
  ssmlGender: 'MALE',
};

const VOICE_CALL = {
  languageCode: 'en-IN',
  name: 'en-IN-Neural2-B',           // Indian male, supports MULAW for calls
  ssmlGender: 'MALE',
};

// For Twilio Media Streams — MULAW 8000 Hz
async function synthesize(text) {
  const [response] = await client.synthesizeSpeech({
    input: { text },
    voice: VOICE_CALL,
    audioConfig: {
      audioEncoding: 'MULAW',
      sampleRateHertz: 8000,
    },
  });
  return Buffer.isBuffer(response.audioContent)
    ? response.audioContent
    : Buffer.from(response.audioContent);
}

// For browser playback — MP3
async function synthesizeForBrowser(text) {
  const [response] = await client.synthesizeSpeech({
    input: { text },
    voice: VOICE_BROWSER,
    audioConfig: { audioEncoding: 'MP3' },
  });
  const buf = Buffer.isBuffer(response.audioContent)
    ? response.audioContent
    : Buffer.from(response.audioContent);
  return buf.toString('base64');
}

module.exports = { synthesize, synthesizeForBrowser };
