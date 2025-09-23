import express from 'express';
import bodyParser from 'body-parser';
import WebSocket from 'ws';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import 'dotenv/config';

const PORT = Number(process.env.PORT ?? 8000);
const WEBHOOK_SECRET = process.env.OPENAI_WEBHOOK_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!WEBHOOK_SECRET || !OPENAI_API_KEY) {
  console.error('Missing OPENAI_WEBHOOK_SECRET or OPENAI_API_KEY in environment');
  process.exit(1);
}

// Initialize OpenAI client (handles webhook verification)
const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
  webhookSecret: WEBHOOK_SECRET,
});

// System instructions
const systemInstructions = [
  'You are a friendly voice assistant for ACME Internet.',
  'Respond concisely and helpfully to callers.',
  'If you do not understand the caller, politely ask them to repeat.',
  'Only speak in the same language as the caller unless instructed otherwise.',
  'Use variety in your responses so they do not sound robotic.',
].join('\n');

// ✅ Web Search tool only
const tools = [
  {
    type: "web_search",
    name: "search",
    description: "Search the web for recent information."
  }
];

// Accept payload for incoming calls
const callAcceptPayload = {
  instructions: systemInstructions,
  type: 'realtime',
  model: 'gpt-realtime',
  audio: {
    output: { voice: 'alloy' },
  },
  tools,
};

// Optional initial greeting (sent once WS opens)
const initialGreetingEvent = {
  type: 'response.create',
  response: {
    instructions: 'Say: Hello! Thanks for calling ACME Internet support. How can I help you today?'
  },
};

// WebSocket handler (no function calls needed anymore)
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

  ws.on('message', (data) => {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    try {
      const event = JSON.parse(text);
      console.log('Realtime event:', event.type);
    } catch (err) {
      console.warn('Unable to parse WebSocket message:', err);
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

const app = express();
app.use(bodyParser.raw({ type: '*/*' }));

// Webhook endpoint
app.post('/', async (req, res) => {
  try {
    const rawBody = req.body.toString('utf8');
    const event = await client.webhooks.unwrap(rawBody, req.headers);

    if (event?.type === 'realtime.call.incoming') {
      const callId = event?.data?.call_id;

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

      const wssUrl = `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`;
      connectWithDelay(wssUrl, 0);

      res.set('Authorization', `Bearer ${OPENAI_API_KEY}`);
      return res.sendStatus(200);
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

app.listen(PORT, () => {
  console.log(`Realtime SIP agent (Web Search) listening on port ${PORT}`);
});
