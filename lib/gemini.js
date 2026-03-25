const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const model = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash',
  systemInstruction: `You are a helpful AI assistant for the Delhi Municipal Corporation. You help citizens with queries about property tax, water bills, building permits, complaints, and other municipal services. Keep responses short, clear, and under 3 sentences — this is a phone call. You can understand Hindi and Hinglish. Always be polite and professional.

LANGUAGE RULE (most important): Read the user's message carefully. Detect the language they used — Hindi, English, or Hinglish. ALWAYS reply in the exact same language. Never switch languages unless the user does first.

RESPONSE RULE: Give a complete, full answer — never stop mid-sentence. Always finish your sentences. No markdown, no bullet points — plain spoken words only.`,
  generationConfig: {
    maxOutputTokens: 500,
    temperature: 0.8,
  },
});

const MAX_HISTORY_PAIRS = 15;

// History format: Gemini [{ role: 'user'|'model', parts: [{ text }] }]

async function getReply(history, userText) {
  let trimmed = history.slice(-(MAX_HISTORY_PAIRS * 2));

  // Gemini requires history to start with 'user' — trimming an odd index can violate this
  if (trimmed.length > 0 && trimmed[0].role !== 'user') {
    trimmed = trimmed.slice(1);
  }

  const chat = model.startChat({ history: trimmed });
  const result = await chat.sendMessage(userText);
  const reply = result.response.text().trim();

  const updatedHistory = [
    ...trimmed,
    { role: 'user',  parts: [{ text: userText }] },
    { role: 'model', parts: [{ text: reply }] },
  ];

  return { reply, updatedHistory };
}

module.exports = { getReply };
