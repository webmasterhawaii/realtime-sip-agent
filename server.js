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
// calling `.unwrap()` will throw a TypeError. See the official docs【177794260894115†L520-L548】.
const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
  // Use the same secret as defined above. Without providing this, client.webhooks
  // will be undefined and unwrap will throw. See docs【177794260894115†L520-L548】.
  webhookSecret: WEBHOOK_SECRET,
});

// The `openai` SDK >=5 defines `client.webhooks` unconditionally, so
// there is no need to guard against it being undefined. Signature
// verification will throw if the webhook secret is missing or
// incorrect. See the documentation【859407725996152†L20-L23】 for details.

/*
 * Build the call acceptance payload. This payload tells the Realtime API how
 * to configure the session: which model to use, what voice to speak with,
 * any system‑level instructions, and optional function tools. According to
 * OpenAI’s documentation, the `conversation.item.create` event can be used
 * to add messages, function calls and function call responses【1776078711550†L340-L394】,
 * while `function_call_output` items include a `call_id` identifying the
 * request and an `output` string for the response【1776078711550†L1830-L1860】.
 */
const systemInstructions = [
  'You are a friendly voice assistant for ACME Internet.',
  'Respond concisely and helpfully to callers.',
  'If you do not understand the caller, politely ask them to repeat.',
  'Only speak in the same language as the caller unless instructed otherwise.',
  'Use variety in your responses so they do not sound robotic.',
  'If audio is unclear or unintelligible, ask for clarification【783853029708891†L36-L37】.',
].join('\n');

// -----------------------------------------------------------------------------
// TOOL DEFINITIONS
//
// In the Realtime API, tools allow the model to call external functions
// (functions you implement locally) or remote services (via MCP servers and
// connectors). The model decides when to call these tools based on its
// reasoning chain. To support additional capabilities like web search or
// third‑party integrations, define those tools in the `tools` array below.
//
// Built‑in function tools. These are local JavaScript functions that run in
// this server. When the model calls a function, a `function_call` item is
// emitted over the WebSocket. The server must execute the function and return
// a `function_call_output` item with the result【1776078711550†L1830-L1860】.
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

// Additional tools can be conditionally enabled via environment variables.
// These include the web search tool, remote MCP servers and OpenAI connectors.
const additionalTools = [];

// Web search tool configuration. Web search allows the model to query the
// internet for up‑to‑date information. To enable it, set
// WEB_SEARCH_ENABLED=true in your environment. You can optionally restrict
// searches to a list of domains using WEB_SEARCH_ALLOWED_DOMAINS (comma‑
// separated)【880246847596441†L340-L347】 and provide an approximate user
// location via WEB_SEARCH_COUNTRY, WEB_SEARCH_CITY, WEB_SEARCH_REGION and
// WEB_SEARCH_TIMEZONE【880246847596441†L521-L534】. See the official docs for
// details on domain filtering and user location fields.
if (process.env.WEB_SEARCH_ENABLED?.toLowerCase?.() === 'true') {
  const webTool = { type: 'web_search' };
  // Domain allow‑list. When provided, restricts searches to the specified
  // domains and their subdomains【880246847596441†L340-L347】.
  if (process.env.WEB_SEARCH_ALLOWED_DOMAINS) {
    const domains = process.env.WEB_SEARCH_ALLOWED_DOMAINS.split(',').map((d) => d.trim()).filter(Boolean);
    if (domains.length > 0) {
      webTool.filters = { allowed_domains: domains };
    }
  }
  // User location hint. This helps the model tailor results by geography【880246847596441†L521-L534】.
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

// Remote MCP server configuration. Remote MCP servers expose tools over the
// internet that the model can call. To use a remote MCP server, set
// MCP_SERVER_URL to the server’s URL. Optionally provide MCP_SERVER_LABEL
// (a human friendly name), MCP_AUTHORIZATION (an OAuth access token)【173302511999189†screenshot】,
// MCP_REQUIRE_APPROVAL (e.g. "never" to auto‑approve all calls)【575803211680614†screenshot】,
// and MCP_ALLOWED_TOOLS (comma‑separated list)【537303462688410†screenshot】.
if (process.env.MCP_SERVER_URL) {
  const mcpTool = {
    type: 'mcp',
    server_label: process.env.MCP_SERVER_LABEL || 'remote_mcp',
    server_url: process.env.MCP_SERVER_URL,
  };
  if (process.env.MCP_AUTHORIZATION) {
    mcpTool.authorization = process.env.MCP_AUTHORIZATION;
  }
  if (process.env.MCP_REQUIRE_APPROVAL) {
    // Acceptable values: 'always', 'never', or an object mapping tool names to
    // approval policy. See docs【575803211680614†screenshot】.
    try {
      // Try to parse as JSON; if fails, treat as string (e.g. "never").
      mcpTool.require_approval = JSON.parse(process.env.MCP_REQUIRE_APPROVAL);
    } catch {
      mcpTool.require_approval = process.env.MCP_REQUIRE_APPROVAL;
    }
  }
  if (process.env.MCP_ALLOWED_TOOLS) {
    mcpTool.allowed_tools = process.env.MCP_ALLOWED_TOOLS.split(',').map((t) => t.trim()).filter(Boolean);
  }
  additionalTools.push(mcpTool);
}

// Connector configuration. Connectors are OpenAI‑hosted MCP wrappers for
// services like Google Calendar, Gmail and Dropbox【200056371336966†screenshot】. To use a
// connector, set CONNECTOR_ID (e.g. "connector_googlecalendar"). You can also
// specify CONNECTOR_LABEL (optional), CONNECTOR_AUTHORIZATION (OAuth access
// token), CONNECTOR_REQUIRE_APPROVAL and CONNECTOR_ALLOWED_TOOLS similar to
// the remote MCP server configuration【749830989574305†screenshot】.
if (process.env.CONNECTOR_ID) {
  const connTool = {
    type: 'mcp',
    server_label: process.env.CONNECTOR_LABEL || process.env.CONNECTOR_ID,
    connector_id: process.env.CONNECTOR_ID,
  };
  if (process.env.CONNECTOR_AUTHORIZATION) {
    connTool.authorization = process.env.CONNECTOR_AUTHORIZATION;
  }
  if (process.env.CONNECTOR_REQUIRE_APPROVAL) {
    try {
      connTool.require_approval = JSON.parse(process.env.CONNECTOR_REQUIRE_APPROVAL);
    } catch {
      connTool.require_approval = process.env.CONNECTOR_REQUIRE_APPROVAL;
    }
  }
  if (process.env.CONNECTOR_ALLOWED_TOOLS) {
    connTool.allowed_tools = process.env.CONNECTOR_ALLOWED_TOOLS.split(',').map((t) => t.trim()).filter(Boolean);
  }
  additionalTools.push(connTool);
}

// Combine all tools into a single array. The model will see function tools
// (implemented locally) and any additional tools configured above. The order of
// tools doesn’t matter; however, grouping them makes it easier to reason about
// your agent’s capabilities.
const tools = [...functionTools, ...additionalTools];

// Build the call acceptance payload. The payload tells the Realtime API how
// to configure the session: choose the model and voice, provide system‑level
// instructions, and declare any tools the model may call. Including the
// dynamically built `tools` array here exposes your function tools, web
// search, remote MCP servers and connectors to the model【793223803248159†L264-L324】.
const callAcceptPayload = {
  instructions: systemInstructions,
  type: 'realtime',
  model: 'gpt-realtime',
  audio: {
    output: { voice: 'alloy' },
  },
  tools,
};

// A friendly greeting to kick off the conversation. This is sent over the
// WebSocket as soon as the connection is established. Without an initial
// `response.create` call the user would be greeted with silence【501579161073898†L1047-L1051】.
const initialGreetingEvent = {
  type: 'response.create',
  response: {
    instructions: 'Say: Hello! Thanks for calling ACME Internet support. How can I help you today?'
  },
};

// Map function names to their implementations. The Realtime API will
// automatically call one of these functions when appropriate. The server
// executes the function, then returns the result to the model using
// a `function_call_output` item【1776078711550†L1830-L1860】.
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
 * containing a `function_call_output` item【1776078711550†L1830-L1860】.
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
      // Per the API, call_id must match the ID of the original function call【1776078711550†L1830-L1860】.
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
    // Handle function call requests from the model
    if (event?.type === 'conversation.item.created') {
      const item = event?.item;
      // Handle function calls from the model
      if (item?.type === 'function_call') {
        await handleFunctionCall(item, ws);
        return;
      }
      // Previously, auto-approval for MCP tool calls could be enabled with an
      // AUTO_APPROVE_MCP environment flag. This behaviour has been removed to
      // ensure that calls to remote MCP tools require explicit approval or
      // follow the default approval policy configured in your OpenAI dashboard.
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
// verification【501579161073898†L1039-L1051】.
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
    // the body and headers arguments【177794260894115†L520-L548】.
    const event = await client.webhooks.unwrap(rawBody, req.headers);
    const type = event?.type;
    if (type === 'realtime.call.incoming') {
      const callId = event?.data?.call_id;
      // Send the accept call with our instructions, model and voice
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
