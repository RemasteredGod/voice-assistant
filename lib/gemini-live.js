'use strict';

const { GoogleGenAI } = require('@google/genai');

const LIVE_MODEL = 'models/gemini-3.1-flash-live-preview';

// ── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are Samadhan, an AI assistant for the Delhi Municipal Corporation (DMC). You help citizens with property tax, water bills, building permits, complaints, and all other municipal services. This is a live phone call — keep every response brief, clear, and naturally spoken.

LANGUAGE RULES (highest priority):
- Detect the language the caller uses from their very first sentence.
- ALWAYS reply in the exact same language. Never switch unless the caller switches first.
- You support ALL languages: every Indian language (Hindi, Bengali, Telugu, Marathi, Tamil, Urdu, Gujarati, Kannada, Malayalam, Odia, Punjabi, Assamese, Maithili, Kashmiri, Konkani, Manipuri, Nepali, Sindhi, Dogri, Bodo, Santali) plus Hinglish, English, Arabic, French, Spanish, German, Japanese, Chinese, and any other language a caller may use.
- When a caller speaks number words, convert them to digits in any language (e.g. Hindi: ek/do/teen/char/paanch, Tamil: onnu/rendu/moonnu, Bengali: ek/dui/tin, Telugu: okati/rendu/muudu, Punjabi: ikk/do/tinn, etc.).

COMPLAINT TICKET FLOW:
1. Ask for their full name.
2. Ask for their mobile number — accept any format or spoken style, never ask to reformat.
3. Ask for a clear complaint description.
4. Confirm all three details back to them in their language.
5. Call create_ticket with severity_score (1-10) — ONLY after confirmation.
6. After ticket is created, read the ticket ID aloud digit by digit and say an SMS has been sent.
7. Ask if they need anything else.

RESPONSE STYLE: Complete sentences only. No markdown, no bullet points. Plain spoken words only. Keep each reply under 3 sentences for voice clarity.`;

// ── Function declarations ─────────────────────────────────────────────────────
const FUNCTION_DECLARATIONS = [{
  name: 'create_ticket',
  description: "Create a complaint ticket after collecting the citizen's full name, registered mobile number, and complaint description. Only call this AFTER confirming all three details.",
  parameters: {
    type: 'OBJECT',
    properties: {
      name:           { type: 'STRING',  description: 'Full name of the citizen' },
      phone:          { type: 'STRING',  description: 'Registered Indian mobile number' },
      complaint:      { type: 'STRING',  description: 'Full description of the complaint' },
      severity_score: { type: 'INTEGER', description: 'Severity 1-10: 1=minor, 10=life-threatening or major civic breakdown.' },
    },
    required: ['name', 'phone', 'complaint', 'severity_score'],
  },
}];

// ── Audio: Twilio MULAW 8kHz → PCM16 16kHz ───────────────────────────────────

function mulawToLinear(byte) {
  const m = ~byte & 0xFF;
  const sign = m & 0x80;
  const exp  = (m >> 4) & 0x07;
  const mant = m & 0x0F;
  let s = ((mant << 3) + 0x84) << exp;
  s -= 0x84;
  return sign ? -s : s;
}

function decodeMulaw(buf) {
  const out = Buffer.alloc(buf.length * 2);
  for (let i = 0; i < buf.length; i++) {
    const s = Math.max(-32768, Math.min(32767, mulawToLinear(buf[i])));
    out.writeInt16LE(s, i * 2);
  }
  return out;
}

function upsample8to16(pcm8) {
  const n   = pcm8.length >> 1;
  const out = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const s0 = pcm8.readInt16LE(i * 2);
    const s1 = i + 1 < n ? pcm8.readInt16LE((i + 1) * 2) : s0;
    out.writeInt16LE(s0, i * 4);
    out.writeInt16LE(Math.round((s0 + s1) / 2), i * 4 + 2);
  }
  return out;
}

// ── Audio: Gemini PCM16 24kHz → MULAW 8kHz ───────────────────────────────────

function downsample24to8(pcm24) {
  const inSamples  = pcm24.length >> 1;
  const outSamples = Math.floor(inSamples / 3);
  const out        = Buffer.alloc(outSamples * 2);
  for (let i = 0; i < outSamples; i++) {
    out.writeInt16LE(pcm24.readInt16LE(i * 6), i * 2);
  }
  return out;
}

function linearToMulaw(sample) {
  const BIAS = 0x84, MAX = 32767;
  let sign = 0;
  if (sample < 0) { sign = 0x80; sample = -sample; }
  if (sample > MAX) sample = MAX;
  sample += BIAS;
  let exp = 7;
  for (let mask = 0x4000; (sample & mask) === 0 && exp > 0; exp--, mask >>= 1) {}
  const mantissa = (sample >> (exp + 3)) & 0x0F;
  return ~(sign | (exp << 4) | mantissa) & 0xFF;
}

function encodeMulaw(pcm16) {
  const out = Buffer.alloc(pcm16.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = linearToMulaw(pcm16.readInt16LE(i * 2));
  return out;
}

// ── GeminiLiveSession ─────────────────────────────────────────────────────────
class GeminiLiveSession {
  constructor({ onTranscript, onAudio, onFunctionCall, onClose }) {
    this._ai     = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    this._session = null;
    this._closed  = false;

    // Transcript accumulators — flushed at turnComplete
    this._inputTranscriptBuf  = '';
    this._outputTranscriptBuf = '';

    this._onTranscript   = onTranscript;
    this._onAudio        = onAudio;
    this._onFunctionCall = onFunctionCall;
    this._onClose        = onClose;
  }

  async connect() {
    this._session = await this._ai.live.connect({
      model: LIVE_MODEL,
      config: {
        responseModalities: ['AUDIO'],
        mediaResolution: 'MEDIA_RESOLUTION_MEDIUM',
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Zephyr' },
          },
        },
        inputAudioTranscription:  {},
        outputAudioTranscription: {},
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        tools: [{ functionDeclarations: FUNCTION_DECLARATIONS }],
        contextWindowCompression: {
          triggerTokens: '25600',
          slidingWindow: { targetTokens: '12800' },
        },
        // ── Latency tuning ────────────────────────────────────────────────────
        realtimeInputConfig: {
          automaticActivityDetection: {
            startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
            endOfSpeechSensitivity:   'END_SENSITIVITY_HIGH',
            prefixPaddingMs:  100,
            silenceDurationMs: 300,
          },
        },
      },
      callbacks: {
        onopen: () => console.log('[Gemini Live] Session open'),

        onmessage: (msg) => {
          // Debug — log every message type so we can see what Gemini sends
          const keys = Object.keys(msg).filter(k => msg[k] != null && k !== 'text' && k !== 'data');
          if (keys.length) console.log('[Gemini Live] msg keys:', keys.join(', '));

          // ── User speech transcription ────────────────────────────────────
          const it = msg.serverContent?.inputTranscription;
          if (it?.text) {
            this._inputTranscriptBuf = it.text; // keep latest (interim overwrites)
            if (it.finished) {
              this._onTranscript(this._inputTranscriptBuf, true);
              this._inputTranscriptBuf = '';
            }
          }

          // ── AI output transcription ──────────────────────────────────────
          const ot = msg.serverContent?.outputTranscription;
          if (ot?.text) {
            this._outputTranscriptBuf += ot.text;
            if (ot.finished) {
              this._onTranscript('__ai__' + this._outputTranscriptBuf, true);
              this._outputTranscriptBuf = '';
            }
          }

          // ── Audio chunks from Gemini → MULAW → Twilio ────────────────────
          const parts = msg.serverContent?.modelTurn?.parts;
          if (parts) {
            for (const part of parts) {
              if (part.inlineData?.mimeType && part.inlineData?.data) {
                const mime = part.inlineData.mimeType;
                const bytes = Buffer.from(part.inlineData.data, 'base64');
                console.log(`[Gemini Live] audio part — mime:${mime} bytes:${bytes.length}`);
                if (mime.startsWith('audio/')) {
                  try {
                    const mulaw = encodeMulaw(downsample24to8(bytes));
                    this._onAudio(mulaw);
                  } catch (err) {
                    console.error('[Gemini Live] Audio decode error:', err.message);
                  }
                }
              }
            }
          }

          // ── Turn complete — flush any un-fired transcripts ───────────────
          if (msg.serverContent?.turnComplete) {
            if (this._inputTranscriptBuf) {
              this._onTranscript(this._inputTranscriptBuf, true);
              this._inputTranscriptBuf = '';
            }
            if (this._outputTranscriptBuf) {
              this._onTranscript('__ai__' + this._outputTranscriptBuf, true);
              this._outputTranscriptBuf = '';
            }
          }

          // ── Function call ────────────────────────────────────────────────
          const fcs = msg.toolCall?.functionCalls;
          if (fcs?.length > 0) {
            const fc = fcs[0];
            this._onFunctionCall({ id: fc.id, name: fc.name, args: fc.args }).catch(err =>
              console.error('[Gemini Live] onFunctionCall error:', err.message)
            );
          }
        },

        onerror: (err) => {
          console.error('[Gemini Live] Error type=%s msg=%s', err?.type, err?.message);
        },

        onclose: (event) => {
          console.log('[Gemini Live] Closed — code:%s reason:%s', event?.code, event?.reason);
          if (!this._closed) { this._closed = true; this._onClose(); }
        },
      },
    });
  }

  // Send each Twilio packet (160 bytes / 20ms) directly — no buffering
  sendAudio(mulawBuf) {
    if (!this._session || this._closed) return;
    try {
      const pcm16 = upsample8to16(decodeMulaw(mulawBuf));
      this._session.sendRealtimeInput({
        audio: { mimeType: 'audio/pcm;rate=16000', data: pcm16.toString('base64') },
      });
    } catch (err) {
      console.error('[Gemini Live] sendRealtimeInput error:', err.message);
    }
  }

  sendToolResponse(id, name, result) {
    if (!this._session || this._closed) return;
    try {
      this._session.sendToolResponse({
        functionResponses: [{ id, name, response: result }],
      });
    } catch (err) {
      console.error('[Gemini Live] sendToolResponse error:', err.message);
    }
  }

  close() {
    this._closed = true;
    if (this._session) {
      try { this._session.close(); } catch (_) {}
      this._session = null;
    }
  }
}

module.exports = { GeminiLiveSession };
