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

// OpenAI client (for webhook signature verify)
const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
  webhookSecret: WEBHOOK_SECRET,
});

// ─────────────────────────────────────────────
// Session config (accept payload) — Web Search only
// ─────────────────────────────────────────────
const systemInstructions = [
  'You are a friendly voice assistant for ACME Internet.',
  'Respond concisely and helpfully.',
  'If you do not understand the caller, politely ask them to repeat.',
  'Speak in the caller’s language unless asked otherwise.',
  'Vary phrasing so it doesn’t sound robotic.',
].join('\n');

const tools = [
  {
    type: 'web_search',
    name: 'search',
    description: 'Search the web for recent information.'
  }
];

const callAcceptPayload = {
  type: 'realtime',
  model: 'gpt-realtime',
  instructions: systemInstructions,
  audio: { output: { voice: 'alloy' } },
  tools,
};

// Optional greeting once WS opens
const initialGreetingEvent = {
  type: 'response.create',
  response: {
    instructions: "Say: Hello! Thanks for calling ACME Internet support. How can I help you today?"
  }
};

// ─────────────────────────────────────────────
// WebSocket
// ─────────────────────────────────────────────
async function websocketTask(wssUrl) {
  const ws = new WebSocket(wssUrl, {
    headers: {
      origin: 'https://api.openai.com',
      'OpenAI-Beta': 'realtime=v1',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
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

function connectWithDelay(wssUrl, delayMs = 1000) {
  // Give OpenAI a moment to finalize session after accept
  setTimeout(() => {
    websocketTask(wssUrl).catch((e) => console.error('WS connect failed:', e));
  }, delayMs);
}

// ─────────────────────────────────────────────
// Express
// IMPORTANT: raw JSON body for signature verify
// ─────────────────────────────────────────────
const app = express();
app.use(bodyParser.raw({ type: 'application/json' })); // tighter than */*

// NOTE: If your OpenAI console points to /session, change to app.post('/session', …)
app.post('/', async (req, res) => {
  try {
    const rawBody = req.body.toString('utf8');

    // Verify and unwrap event
    const event = await client.webhooks.unwrap(rawBody, req.headers);
    const type = event?.type;
    console.log('🔔 Webhook event:', type);

    if (type === 'realtime.call.incoming') {
      const callId = event?.data?.call_id;
      console.log('📞 Incoming call_id:', callId);

      if (!callId) {
        console.error('No call_id in incoming event');
        return res.status(400).send('Missing call_id');
      }

      // Accept ASAP (do as little work before this as possible)
      const acceptUrl = `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/accept`;
      const acceptResp = await fetch(acceptUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(callAcceptPayload),
      });

      if (!acceptResp.ok) {
        const text = await acceptResp.text().catch(() => '');
        console.error('❌ ACCEPT failed:', acceptResp.status, acceptResp.statusText, text);
        // 404 call_id_not_found usually means wrong/expired call_id or accepting too late
        return res.status(502).send('Accept failed');
      }

      console.log('✅ ACCEPT OK. Preparing WS…');

      // Connect using the generic WS URL + call_id (per docs and Twilio guide)
      // Add a small delay to avoid 404 race conditions
      const wssUrl = `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`;
      connectWithDelay(wssUrl, 1000); // 1s

      // Echo Authorization (as recommended)
      res.set('Authorization', `Bearer ${OPENAI_API_KEY}`);
      return res.sendStatus(200);
    }

    // Acknowledge other events (e.g., call ended)
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
