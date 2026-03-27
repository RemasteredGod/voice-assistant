const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const tools = [{
  functionDeclarations: [{
    name: 'create_ticket',
    description: 'Create a complaint ticket after collecting the citizen\'s full name, registered mobile number, and complaint description. Only call this AFTER you have confirmed all three details with the citizen.',
    parameters: {
      type: 'OBJECT',
      properties: {
        name:      { type: 'STRING', description: 'Full name of the citizen' },
        phone:     { type: 'STRING', description: 'Registered 10-digit Indian mobile number' },
        complaint: { type: 'STRING', description: 'Full description of the complaint' },
        severity_score: { type: 'INTEGER', description: 'Severity of this grievance: 1=minor inconvenience, 10=life-threatening or major civic breakdown. Assess based on public safety, health risk, and scale of impact.' },
      },
      required: ['name', 'phone', 'complaint', 'severity_score'],
    },
  }],
}];

const model = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash',
  tools,
  systemInstruction: `You are Samadhan, an AI assistant for the Delhi Municipal Corporation (DMC). You help citizens with property tax, water bills, building permits, complaints, and all other municipal services.

LANGUAGE RULES (highest priority):
- Detect the language the user is writing or speaking from their very first message.
- ALWAYS reply in the exact same language. Never switch unless the user switches first.
- You support ALL languages: every Indian language (Hindi, Bengali, Telugu, Marathi, Tamil, Urdu, Gujarati, Kannada, Malayalam, Odia, Punjabi, Assamese, Maithili, Kashmiri, Konkani, Manipuri, Nepali, Sindhi, Dogri, Bodo, Santali) plus Hinglish, English, Arabic, French, Spanish, German, Japanese, Chinese, and any other language a user may use.
- When a user speaks or types number words, convert them to digits in any language (e.g. Hindi: ek/do/teen/char/paanch, Tamil: onnu/rendu/moonnu, Bengali: ek/dui/tin, Telugu: okati/rendu/muudu, Punjabi: ikk/do/tinn, etc.).

COMPLAINT TICKET FLOW:
1. Ask for their full name.
2. Ask for their mobile number — accept any format or spoken style, never ask to reformat.
3. Ask for a clear description of the complaint.
4. Confirm all three details back to them in their language.
5. Once confirmed, call create_ticket with a severity_score (1-10) based on public safety, health risk, and scale of impact — do NOT call it before confirmation.
6. After the ticket is created, read the ticket ID clearly digit by digit and tell them an SMS with an upload link has been sent.
7. Ask if they have another complaint or need anything else.

RESPONSE STYLE: Complete sentences only — never cut off mid-sentence. No markdown, no bullet points. Plain spoken words only.`,
  generationConfig: {
    maxOutputTokens: 500,
    temperature: 0.8,
  },
});

const MAX_HISTORY_PAIRS = 15;

async function getReply(history, userText) {
  let trimmed = history.slice(-(MAX_HISTORY_PAIRS * 2));

  // Gemini requires history to start with 'user' role
  if (trimmed.length > 0 && trimmed[0].role !== 'user') {
    trimmed = trimmed.slice(1);
  }

  const chat = model.startChat({ history: trimmed });
  const result = await chat.sendMessage(userText);
  const response = result.response;

  // Check for function call
  const fnCalls = response.functionCalls ? response.functionCalls() : [];
  if (fnCalls && fnCalls.length > 0) {
    const fn = fnCalls[0];
    // Build updated history including the model's function call turn
    const updatedHistory = [
      ...trimmed,
      { role: 'user',  parts: [{ text: userText }] },
      { role: 'model', parts: response.candidates[0].content.parts },
    ];
    return { reply: null, functionCall: { name: fn.name, args: fn.args }, updatedHistory };
  }

  const reply = response.text().trim();
  const updatedHistory = [
    ...trimmed,
    { role: 'user',  parts: [{ text: userText }] },
    { role: 'model', parts: [{ text: reply }] },
  ];

  return { reply, functionCall: null, updatedHistory };
}

async function continueWithFunctionResult(history, functionName, functionResult) {
  let trimmed = history.slice(-(MAX_HISTORY_PAIRS * 2));
  if (trimmed.length > 0 && trimmed[0].role !== 'user') {
    trimmed = trimmed.slice(1);
  }

  // trimmed ends with: [..., {role:'user', parts:[{text}]}, {role:'model', parts:[functionCall]}]
  // We need to feed ALL of that as history, then send the functionResponse as the next message.
  const chat = model.startChat({ history: trimmed });

  const result = await chat.sendMessage([
    {
      functionResponse: {
        name: functionName,
        response: functionResult,
      },
    },
  ]);

  const reply = result.response.text().trim();

  // Build clean history for future turns: collapse the function-call cycle into
  // a simple user/model text exchange so subsequent getReply() calls work cleanly.
  // Keep everything before the function call turns, then add a summary pair.
  const preFnHistory = trimmed.slice(0, -2); // everything before the user msg + model functionCall
  const userTextTurn = trimmed[trimmed.length - 2]; // the original user text that triggered the function call
  const updatedHistory = [
    ...preFnHistory,
    userTextTurn,
    { role: 'model', parts: [{ text: reply }] },
  ];

  return { reply, updatedHistory };
}

module.exports = { getReply, continueWithFunctionResult };
