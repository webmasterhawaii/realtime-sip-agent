import express from 'express';
import bodyParser from 'body-parser';
import WebSocket from 'ws';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import 'dotenv/config';

// Load configuration from environment. See `.env.example` for the required variables.
const PORT = Number(process.env.PORT ?? 8000);
const WEBHOOK_SECRET = process.env.OPENAI_WEBHOOK_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!WEBHOOK_SECRET || !OPENAI_API_KEY) {
  console.error('Missing OPENAI_WEBHOOK_SECRET or OPENAI_API_KEY in environment');
  process.exit(1);
}

// Initialise the OpenAI client with your API key and webhook secret.
const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
  webhookSecret: WEBHOOK_SECRET,
});

// System‑level instructions for the voice assistant.
const systemInstructions = [
  'You are a friendly voice assistant for ACME Internet.',
  'Respond concisely and helpfully to callers.',
  'If you do not understand the caller, politely ask them to repeat.',
  'Only speak in the same language as the caller unless instructed otherwise.',
  'Use variety in your responses so they do not sound robotic.',
  'If audio is unclear or unintelligible, ask for clarification.',
].join('\n');

// Define local function tools.
const functionTools = [
  {
    type: 'function',
    name: 'get_current_time',
    description: 'Return the current time in ISO 8601 format.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'get_random_number',
    description: 'Generate a random integer between 0 and 100.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

// Always include the web_search tool.  Optionally restrict domains and set
// approximate user location via environment variables (see .env.example).
const additionalTools = [];
{
  const webTool = { type: 'web_search' };
  if (process.env.WEB_SEARCH_ALLOWED_DOMAINS) {
    const domains = process.env.WEB_SEARCH_ALLOWED_DOMAINS.split(',')
      .map((d) => d.trim())
      .filter(Boolean);
    if (domains.length > 0) webTool.filters = { allowed_domains: domains };
  }
  const country = process.env.WEB_SEARCH_COUNTRY;
  const city = process.env.WEB_SEARCH_CITY;
  const region = process.env.WEB_SEARCH_REGION;
  const timezone = process.env.WEB_SEARCH_TIMEZONE;
  if (country || city || region || timezone) {
    webTool.user_location = {
      type: 'approximate',
      ...(country ? { country } : {}),
      ...(city ? { city } : {}),
      ...(region ? { region } : {}),
      ...(timezone ? { timezone } : {}),
    };
  }
  additionalTools.push(webTool);
}

// Combine function tools with any additional tools (web search).
const tools = [...functionTools, ...additionalTools];

// Build the call acceptance payload.
const callAcceptPayload = {
  instructions: systemInstructions,
  type: 'realtime',
  model: 'gpt-realtime',
  audio: { output: { voice: 'alloy' } },
  tools,
};

// Greeting sent when the WebSocket opens.
const initialGreetingEvent = {
  type: 'response.create',
  response: {
    instructions: 'Say: Hello! Thanks for calling ACME Internet support. How can I help you today?',
  },
};

// Implementations for function tools.
const functionImplementations = {
  async get_current_time() {
    return { current_time: new Date().toISOString() };
  },
  async get_random_number() {
    return { random_number: Math.floor(Math.random() * 101) };
  },
};

// Handle a function call and send the result back.
async function handleFunctionCall(item, ws) {
  const name = item?.name;
  let args = {};
  try { args = item?.arguments ? JSON.parse(item.arguments) : {}; } catch {}
  const fn = functionImplementations[name];
  let result;
  if (fn) {
    try { result = await fn(args); } catch (e) { result = { error: e?.message ?? 'Unknown error' }; }
  } else {
    result = { error: `Function ${name} is not implemented.` };
  }
  const outputEvent = {
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      call_id: item?.id ?? item?.call_id,
      output: JSON.stringify(result),
    },
  };
  ws.send(JSON.stringify(outputEvent));
}

// Manage WebSocket session.
async function websocketTask(uri) {
  const ws = new WebSocket(uri, {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, origin: 'https://api.openai.com' },
  });
  ws.on('open', () => {
    console.log('WebSocket opened:', uri);
    ws.send(JSON.stringify(initialGreetingEvent));
  });
  ws.on('message', async (data) => {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    let event;
    try { event = JSON.parse(text); } catch { return; }
    if (event?.type === 'conversation.item.created' && event?.item?.type === 'function_call') {
      await handleFunctionCall(event.item, ws);
    }
  });
  ws.on('error', (err) => console.error('WebSocket error:', err));
  ws.on('close', (code, reason) => console.log('WebSocket closed:', code, reason?.toString?.()));
}

function connectWithDelay(sipWssUrl, delay = 1000) {
  setTimeout(() => {
    websocketTask(sipWssUrl).catch((err) => console.error('Failed to connect WebSocket:', err));
  }, delay);
}

// Express server for webhooks.
const app = express();
app.use(bodyParser.raw({ type: '*/*' }));

app.post('/', async (req, res) => {
  try {
    const rawBody = req.body.toString('utf8');
    const event = await client.webhooks.unwrap(rawBody, req.headers);
    if (event?.type === 'realtime.call.incoming') {
      const callId = event?.data?.call_id;
      const acceptResp = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/accept`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(callAcceptPayload),
      });
      if (!acceptResp.ok) {
        console.error('Failed to accept call:', acceptResp.status, await acceptResp.text().catch(() => ''));
        return res.status(500).send('Call accept failed');
      }
      const wssUrl = `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`;
      connectWithDelay(wssUrl);
      res.set('Authorization', `Bearer ${OPENAI_API_KEY}`);
      return res.sendStatus(200);
    }
    return res.sendStatus(200);
  } catch (err) {
    if (err?.name === 'InvalidWebhookSignatureError' || err?.message?.toLowerCase?.().includes('invalid signature')) {
      return res.status(400).send('Invalid signature');
    }
    console.error('Error handling webhook:', err);
    return res.status(500).send('Server error');
  }
});

app.listen(PORT, () => {
  console.log(`Realtime SIP agent listening on port ${PORT}`);
});
