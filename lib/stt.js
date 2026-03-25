const speech = require('@google-cloud/speech');

const client = new speech.SpeechClient();

const STREAM_MAX_MS = 280 * 1000;

function createSttStream(onTranscript, onError) {
  const startedAt = Date.now();

  const stream = client.streamingRecognize({
    config: {
      encoding: 'MULAW',
      sampleRateHertz: 8000,
      languageCode: 'en-IN',   // English only — no auto Hindi switching
      enableAutomaticPunctuation: true,
    },
    interimResults: true,
  });

  stream.on('data', (data) => {
    const result = data.results?.[0];
    if (!result) return;
    const transcript = result.alternatives?.[0]?.transcript || '';
    if (transcript) {
      console.log(`[STT] ${result.isFinal ? 'FINAL' : 'interim'}: "${transcript}"`);
      onTranscript(transcript, result.isFinal === true);
    }
  });

  stream.on('error', (err) => {
    if (err.code === 11) return; // stream time limit — expected
    console.error('[STT] Stream error:', err.code, err.message);
    onError(err);
  });

  function write(audioChunk) {
    if (!stream || !stream.writable) return;
    // v6+ expects raw Buffer, not { audioContent: buffer }
    try { stream.write(audioChunk); } catch (_) {}
  }

  function end() {
    try { stream?.end(); } catch (_) {}
  }

  function isExpired() {
    return Date.now() - startedAt >= STREAM_MAX_MS;
  }

  return { write, end, isExpired };
}

module.exports = { createSttStream };
