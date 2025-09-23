import express from 'express';
import bodyParser from 'body-parser';
import WebSocket from 'ws';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import 'dotenv/config';

// ─────────────────────────────────────────────
// Env
// ─────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 8000);
const WEBHOOK_SECRET = process.env.OPENAI_WEBHOOK_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!WEBHOOK_SECRET || !OPENAI_API_KEY) {
  console.error('Missing OPENAI_WEBHOOK_SECRET or OPENAI_API_KEY');
  process.exit(1);
}

const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
  webhookSecret: WEBHOOK_SECRET,
});

// ─────────────────────────────────────────────
// Session config (Web Search only)
// ─────────────────────────────────────────────
const systemInstructions = [
  'You are a friendly voice assistant for ACME Internet.',
  'Respond concisely and helpfully.',
  'If you do not understand the caller, politely ask them to repeat.',
  'Speak in the caller’s language unless asked otherwise.',
  'Vary phrasing so it doesn’t sound robotic.',
].join('\n');

// Correct realtime preview model
const callAcceptPayload = {
  type: 'realtime',
  model: 'gpt-4o-realtime-preview-2024-12-17',
  instructions: systemInstructions,
  audio: { output: { voice: 'alloy' } },
  tools: [
    {
      type: 'web_search',
      name: 'search',
      description: 'Search the web for recent information.'
    }
  ]
};

const initialGreetingEvent = {
  type: 'response.create',
  response: {
    instructions: "Say: Hello! Thanks for calling ACME Internet support. How can I help you today?"
  }
};

// ─────────────────────────────────────────────
// WebSocket
// ─────────────────────────────────────────────
async function websocketTask(wssUrl, authToken) {
  const ws = new WebSocket(wssUrl, {
    headers: {
      origin: 'https://api.openai.com',
      'OpenAI-Beta': 'realtime=v1',
      Authorization: `Bearer ${authToken}`,
    },
  });

  ws.on('open', () => {
    console.log('🔌 Realtime WS opened:', wssUrl);
    ws.send(JSON.stringify(initialGreetingEvent));
  });

  ws.on('message', (data) => {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    try {
      const evt = JSON.parse(text);
      if (evt?.type) console.log('📥 Realtime event:', evt.type);
    } catch (e) {
      console.warn('Unable to parse WS message:', e);
    }
  });

  ws.on('error', (err) => console.error('WS error:', err));
  ws.on('close', (code, reason) =>
    console.log('🔒 WS closed:', code, reason?.toString?.() ?? '')
  );
}

function connectWithDelay(wssUrl, authToken, delayMs = 1000) {
  setTimeout(() => {
    websocketTask(wssUrl, authToken).catch((e) => console.error('WS connect failed:', e));
  }, delayMs);
}

// ─────────────────────────────────────────────
// Express
// ─────────────────────────────────────────────
const app = express();
app.use(bodyParser.raw({ type: 'application/json' }));

app.post('/', async (req, res) => {
  try {
    const rawBody = req.body.toString('utf8');
    const event = await client.webhooks.unwrap(rawBody, req.headers);
    const type = event?.type;
    console.log('🔔 Webhook event:', type);

    if (type === 'realtime.call.incoming') {
      const callId = event?.data?.call_id;
      console.log('📞 Incoming call_id:', callId);

      if (!callId) return res.status(400).send('Missing call_id');

      // Accept
      const acceptUrl = `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/accept`;
      const acceptResp = await fetch(acceptUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(callAcceptPayload),
      });

      const acceptData = await acceptResp.json().catch(() => ({}));
      console.log('📦 ACCEPT response JSON:', acceptData);

      if (!acceptResp.ok) {
        console.error('❌ ACCEPT failed:', acceptResp.status, acceptResp.statusText, acceptData);
        return res.status(502).send('Accept failed');
      }

      // Use ws_url/client_secret if provided
      let wssUrl = acceptData?.ws_url
        ? acceptData.ws_url
        : `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`;
      let token = acceptData?.client_secret?.value || OPENAI_API_KEY;

      console.log('✅ ACCEPT OK. Connecting WS…', {
        wssUrl,
        usingEphemeral: token !== OPENAI_API_KEY,
      });
      connectWithDelay(wssUrl, token, 1200);

      res.set('Authorization', `Bearer ${OPENAI_API_KEY}`);
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (err) {
    const msg = String(err?.message ?? '').toLowerCase();
    if (err?.name === 'InvalidWebhookSignatureError' || msg.includes('invalid signature')) {
      console.error('❌ Invalid signature');
      return res.status(400).send('Invalid signature');
    }
    console.error('Webhook handler error:', err);
    return res.status(500).send('Server error');
  }
});

app.listen(PORT, () => {
  console.log(`📞 Realtime SIP agent (Web Search) listening on :${PORT}`);
});
