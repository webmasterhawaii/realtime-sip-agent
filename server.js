import express from 'express';
import bodyParser from 'body-parser';
import WebSocket from 'ws';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import 'dotenv/config';

// Load configuration from environment. See `.env.example` for the required
// variables. If any values are missing the server will exit immediately.
const PORT = Number(process.env.PORT ?? 8000);
const WEBHOOK_SECRET = process.env.OPENAI_WEBHOOK_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!WEBHOOK_SECRET || !OPENAI_API_KEY) {
  console.error('Missing OPENAI_WEBHOOK_SECRET or OPENAI_API_KEY in environment');
  process.exit(1);
}

// Initialize an OpenAI client instance. The SDK handles webhook signature
// verification via the `webhooks.unwrap` helper and makes it easy to call
// other OpenAI endpoints. Passing the webhookSecret when constructing
// the client ensures that the `.webhooks` helper is defined. Without
// webhookSecret defined the `webhooks` property is undefined and
// calling `.unwrap()` will throw a TypeError. See the official docs.
const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
  // Use the same secret as defined above. Without providing this, client.webhooks
  // will be undefined and unwrap will throw. See docs.
  webhookSecret: WEBHOOK_SECRET,
});

// The `openai` SDK >=5 defines `client.webhooks` unconditionally, so
// there is no need to guard against it being undefined. Signature
// verification will throw if the webhook secret is missing or
// incorrect. See the documentation for details.

/*
 * Build the call acceptance payload. This payload tells the Realtime API how
 * to configure the session: which model to use, what voice to speak with,
 * any system-level instructions, and optional function tools. According to
 * OpenAI’s documentation, the `conversation.item.create` event can be used
 * to add messages, function calls and function call responses,
 * while `function_call_output` items include a `call_id` identifying the
 * request and an `output` string for the response.
 */
const systemInstructions = [
  'You are a friendly voice assistant for ACME Internet.',
  'Respond concisely and helpfully to callers.',
  'If you do not understand the caller, politely ask them to repeat.',
  'Only speak in the same language as the caller unless instructed otherwise.',
  'Use variety in your responses so they do not sound robotic.',
  'When a question may involve current events, recent changes, or unknown facts, consider using the web_search tool. Summarize briefly.',
  'If audio is unclear or unintelligible, ask for clarification.',
].join('\n');

// Define the tools (functions) available to the model. These follow the
// RealtimeFunctionTool schema: each tool has a name, description and JSON
// schema for its parameters. When the model calls a function, the server
// receives a `function_call` item and must respond with a `function_call_output`
// item containing the result.
const functionTools = [
  {
    type: 'function',
    name: 'get_current_time',
    description: 'Return the current time in ISO 8601 format.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    type: 'function',
    name: 'get_random_number',
    description: 'Generate a random integer between 0 and 100.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

// ✅ Add OpenAI built-in Web Search tool
const builtinTools = [
  {
    type: 'web_search',
    name: 'search',
    description: 'Search the web for recent information, news, and facts.',
  },
];

// Combine tools
const tools = [...functionTools, ...builtinTools];

const callAcceptPayload = {
  instructions: systemInstructions,
  type: 'realtime',
  // Keep your working model; the built-in tool will be invoked if supported in your project.
  model: 'gpt-realtime',
  audio: {
    output: { voice: 'alloy' },
  },
  tools,
  tool_choice: 'auto', // let the model decide when to use web_search
};

// A friendly greeting to kick off the conversation. This is sent over the
// WebSocket as soon as the connection is established. Without an initial
// `response.create` call the user would be greeted with silence.
const initialGreetingEvent = {
  type: 'response.create',
  response: {
    instructions: 'Say: Hello! Thanks for calling ACME Internet support. How can I help you today?'
  },
};

// Map function names to their implementations. The Realtime API will
// automatically call one of these functions when appropriate. The server
// executes the function, then returns the result to the model using
// a `function_call_output` item.
const functionImplementations = {
  async get_current_time() {
    return { current_time: new Date().toISOString() };
  },
  async get_random_number() {
    return { random_number: Math.floor(Math.random() * 101) };
  },
};

/**
 * Handles an incoming function call from the model. When a `function_call`
 * item arrives over the WebSocket, this helper executes the function and
 * sends the result back to the model using a `conversation.item.create` event
 * containing a `function_call_output` item.
 *
 * @param {object} item The function call item from the server
 * @param {WebSocket} ws The WebSocket connection
 */
async function handleFunctionCall(item, ws) {
  const name = item?.name;
  let args = {};
  try {
    args = item?.arguments ? JSON.parse(item.arguments) : {};
  } catch (e) {
    console.warn('Failed to parse function arguments:', e);
  }
  const fn = functionImplementations[name];
  let result;
  if (fn) {
    try {
      result = await fn(args);
    } catch (e) {
      result = { error: e?.message ?? 'Unknown error running function' };
    }
  } else {
    result = { error: `Function ${name} is not implemented.` };
  }
  const outputEvent = {
    type: 'conversation.item.create',
    item: {
      type: 'function_call_output',
      // Per the API, call_id must match the ID of the original function call.
      call_id: item?.id ?? item?.call_id,
      output: JSON.stringify(result),
    },
  };
  ws.send(JSON.stringify(outputEvent));
}

/**
 * Opens and manages a WebSocket connection to the Realtime API. This
 * function sends an initial greeting, listens for messages (including
 * function call requests) and logs any errors or closure events.
 *
 * @param {string} uri The full WebSocket URL with a call_id query parameter
 */
async function websocketTask(uri) {
  const ws = new WebSocket(uri, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      origin: 'https://api.openai.com',
    },
  });

  ws.on('open', () => {
    console.log('WebSocket opened:', uri);
    ws.send(JSON.stringify(initialGreetingEvent));
  });

  ws.on('message', async (data) => {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    let event;
    try {
      event = JSON.parse(text);
    } catch (err) {
      console.warn('Unable to parse WebSocket message:', err);
      return;
    }
    // Handle function call requests from the model (for your custom functions).
    // Built-in tools like web_search are executed by OpenAI — no server action required.
    if (event?.type === 'conversation.item.created' && event?.item?.type === 'function_call') {
      await handleFunctionCall(event.item, ws);
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });

  ws.on('close', (code, reason) => {
    console.log('WebSocket closed:', code, reason?.toString?.());
  });
}

/**
 * Establishes a WebSocket connection to the given URL after a short delay.
 * A delay allows the `/accept` call to settle before connecting.
 *
 * @param {string} sipWssUrl The WebSocket URL from the accept call
 * @param {number} delay How long to wait before connecting (ms)
 */
function connectWithDelay(sipWssUrl, delay = 1000) {
  setTimeout(() => {
    websocketTask(sipWssUrl).catch((err) => console.error('Failed to connect WebSocket:', err));
  }, delay);
}

// Create the Express application and configure a raw body parser. OpenAI
// requires the webhook payload to be passed as raw bytes for signature
// verification.
const app = express();
app.use(bodyParser.raw({ type: '*/*' }));

// Handle webhook requests from OpenAI. When a realtime incoming call
// notification arrives the server will accept the call, instruct the model
// how to behave and then open a WebSocket connection for the conversation.
app.post('/', async (req, res) => {
  try {
    const rawBody = req.body.toString('utf8');
    // Verify the webhook signature using the OpenAI SDK. When webhookSecret is
    // provided to the client constructor, the unwrap helper only requires
    // the body and headers arguments.
    const event = await client.webhooks.unwrap(rawBody, req.headers);
    const type = event?.type;
    if (type === 'realtime.call.incoming') {
      const callId = event?.data?.call_id;
      // Send the accept call with our instructions, model, voice, and tools (incl. web_search)
      const acceptResp = await fetch(`https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/accept`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(callAcceptPayload),
      });
      if (!acceptResp.ok) {
        const text = await acceptResp.text().catch(() => '');
        console.error('Failed to accept call:', acceptResp.status, acceptResp.statusText, text);
        return res.status(500).send('Call accept failed');
      }
      // Open the WebSocket connection to handle the conversation
      const wssUrl = `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`;
      connectWithDelay(wssUrl, 0);
      // Return 200 OK and include authorization header as required by OpenAI
      res.set('Authorization', `Bearer ${OPENAI_API_KEY}`);
      return res.sendStatus(200);
    }
    // For other event types simply acknowledge the webhook
    return res.sendStatus(200);
  } catch (err) {
    const message = err?.message?.toLowerCase?.() ?? '';
    if (err?.name === 'InvalidWebhookSignatureError' || message.includes('invalid signature')) {
      return res.status(400).send('Invalid signature');
    }
    console.error('Error handling webhook:', err);
    return res.status(500).send('Server error');
  }
});

// Start the server
app.listen(PORT, () => {
  console.log(`Realtime SIP agent listening on port ${PORT}`);
});
