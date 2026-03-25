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
      },
      required: ['name', 'phone', 'complaint'],
    },
  }],
}];

const model = genAI.getGenerativeModel({
  model: 'gemini-2.5-flash',
  tools,
  systemInstruction: `You are a helpful AI assistant for the Delhi Municipal Corporation. You help citizens with queries about property tax, water bills, building permits, complaints, and other municipal services. This is a phone call — keep responses clear and spoken naturally.

LANGUAGE RULE: Detect the language the user speaks (Hindi, English, or Hinglish) and ALWAYS reply in the exact same language. Never switch unless the user does.

COMPLAINT TICKET FLOW: When a citizen wants to file a complaint:
1. Ask for their full name.
2. Ask for their registered 10-digit mobile number.
3. Ask for a clear description of the complaint.
4. Confirm all three details back to them.
5. Once confirmed, call the create_ticket function — do NOT call it before confirmation.
6. After the ticket is created, read the ticket ID clearly digit by digit and tell them an SMS with an upload link has been sent to their phone.

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

  // history already contains the function call as last model turn
  // We need to send the function response
  const chat = model.startChat({ history: trimmed.slice(0, -1) }); // history without last model turn
  const lastModelTurn = trimmed[trimmed.length - 1];

  // Re-send the last user message + function result
  // Use sendMessage with the function response part
  const result = await chat.sendMessage([
    // First re-send what triggered the function call (the model's function call is in history)
    // Actually we need to send the functionResponse as the next turn
    {
      functionResponse: {
        name: functionName,
        response: functionResult,
      },
    },
  ]);

  const reply = result.response.text().trim();
  const updatedHistory = [
    ...trimmed,
    { role: 'user',  parts: [{ functionResponse: { name: functionName, response: functionResult } }] },
    { role: 'model', parts: [{ text: reply }] },
  ];

  return { reply, updatedHistory };
}

module.exports = { getReply, continueWithFunctionResult };
