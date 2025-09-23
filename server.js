import express from 'express';
import bodyParser from 'body-parser';
import WebSocket from 'ws';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import 'dotenv/config';

// ─────────────────────────────────────────────────────────────
// Env
// ─────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 8000);
const WEBHOOK_SECRET = process.env.OPENAI_WEBHOOK_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Optional but recommended: must match the project used in your Twilio SIP URI
// e.g. sip:proj_XXXX@sip.api.openai.com;transport=tls
const OPENAI_PROJECT = process.env.OPENAI_PROJECT;

if (!WEBHOOK_SECRET || !OPENAI_API_KEY) {
  console.error('Missing OPENAI_WEBHOOK_SECRET or OPENAI_API_KEY in environment');
  process.exit(1);
}

const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
  webhookSecret: WEBHOOK_SECRET,
  project: OPENAI_PROJECT,
});

// ─────────────────────────────────────────────────────────────
// Session config (built-in Web Search)
// ─────────────────────────────────────────────────────────────
const systemInstructions = [
  'You are a friendly voice assistant for ACME Internet.',
  'Respond concisely and helpfully to callers.',
  'If you do not understand the caller, politely ask them to repeat.',
  'Only speak in the same language as the caller unless instructed otherwise.',
  'Use variety in your responses so they do not sound robotic.',
  'When a question may involve current events or unknown facts, consider using the web_search tool and summarize briefly.',
].join('\n');

const callAcceptPayload = {
  type: 'realtime',
  // SIP+tools-capable model
  model: 'gpt-4o-realtime-preview-2025-06-03',
  instructions: systemInstructions,
  modalities: ['audio'],
  audio: { output: { voice: 'alloy' } },
  tools: [
    {
      type: 'web_search',
      name: 'search',
      description: 'Search the web for recent information, news, and facts.',
    },
  ],
  tool_choice: 'auto',
};

// OPTIONAL greeting only if a control WS is issued by your project
const initialGreetingEvent = {
  type: 'response.create',
  response: {
    instructions: 'Say: Hello! Thanks for calling ACME Internet support. How can I help you today?'
  },
};

// ─────────────────────────────────────────────────────────────
// Control WebSocket (optional; only if accept returns ws_url + client_secret)
// ─────────────────────────────────────────────────────────────
async function websocketTask(wssUrl, ephemeralToken) {
  const ws = new WebSocket(wssUrl, {
    headers: {
      origin: 'https://api.openai.com',
      'OpenAI-Beta': 'realtime=v1',
      ...(OPENAI_PROJECT ? { 'OpenAI-Project': OPENAI_PROJECT } : {}),
      Authorization: `Bearer ${ephemeralToken}`,
    },
  });

  ws.on('open', () => {
    console.log('WebSocket opened:', wssUrl);
    // Kick off a friendly greeting through the control channel
    ws.send(JSON.stringify(initialGreetingEvent));
  });

  ws.on('message', (data) => {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    try {
      const evt = JSON.parse(text);
      if (evt?.type) console.log('WS event:', evt.type);
    } catch {
      /* ignore parse noise */
    }
  });

  ws.on('error', (err) => console.error('WebSocket error:', err));
  ws.on('close', (code, reason) =>
    console.log('WebSocket closed:', code, reason?.toString?.() ?? '')
  );
}

function maybeOpenWebSocket(acceptData) {
  const wsUrl = acceptData?.ws_url;
  const token = acceptData?.client_secret?.value;

  if (!wsUrl || !token) {
    console.log('ℹ️ No control WS issued by project (continuing without WS).');
    return;
  }
  // small delay so accept “settles”
  setTimeout(() => {
    websocketTask(wsUrl, token).catch((e) => console.error('WS connect failed:', e));
  }, 1200);
}

// ─────────────────────────────────────────────────────────────
// Express
// ─────────────────────────────────────────────────────────────
const app = express();
// Keep raw for signature verification across all content-types (matches your working setup)
app.use(bodyParser.raw({ type: '*/*' }));

app.post('/', async (req, res) => {
  try {
    const rawBody = req.body.toString('utf8');
    const event = await client.webhooks.unwrap(rawBody, req.headers);
    const type = event?.type;
    if (type === 'realtime.call.incoming') {
      const callId = event?.data?.call_id;
      console.log('Incoming call_id:', callId);
      if (!callId) {
        console.error('Missing call_id');
        return res.status(400).send('Missing call_id');
      }

      // Accept
      const acceptUrl = `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/accept`;
      const acceptResp = await fetch(acceptUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'realtime=v1',
          ...(OPENAI_PROJECT ? { 'OpenAI-Project': OPENAI_PROJECT } : {}),
        },
        body: JSON.stringify(callAcceptPayload),
      });

      const respText = await acceptResp.text().catch(() => '');
      let acceptData = null;
      try { acceptData = respText ? JSON.parse(respText) : null; } catch { /* ignore */ }

      console.log('ACCEPT status:', acceptResp.status, acceptResp.statusText);
      console.log('ACCEPT raw:', respText || '<empty body>');
      if (!acceptResp.ok) {
        console.error('Accept failed');
        return res.status(502).send('Accept failed');
      }

      // Only open control WS if the project actually returns one
      if (acceptData) maybeOpenWebSocket(acceptData);

      // Acknowledge webhook (OpenAI expects Authorization echo)
      res.set('Authorization', `Bearer ${OPENAI_API_KEY}`);
      return res.sendStatus(200);
    }

    // (nice to have) log ended calls
    if (type === 'realtime.call.ended') {
      console.log('Call ended:', event?.data?.call_id);
    }

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
