import express from 'express';
import bodyParser from 'body-parser';
import WebSocket from 'ws';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import 'dotenv/config';

// ─────────────────────────────────────────────────────────────
// Environment
// ─────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 8000);
const WEBHOOK_SECRET = process.env.OPENAI_WEBHOOK_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!WEBHOOK_SECRET || !OPENAI_API_KEY) {
  console.error('Missing OPENAI_WEBHOOK_SECRET or OPENAI_API_KEY in environment');
  process.exit(1);
}

// OpenAI client (includes webhook signature verification)
const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
  webhookSecret: WEBHOOK_SECRET,
});

// ─────────────────────────────────────────────────────────────
/**
 * Session config:
 * - Model: keep the default realtime model you’ve been using
 * - Voice: alloy
 * - Tools: ✅ built-in OpenAI "web_search" tool
 *   (Note: enable Web Search for the project in the OpenAI UI)
 */
// ─────────────────────────────────────────────────────────────
const systemInstructions = [
  'You are a friendly voice assistant for ACME Internet.',
  'Respond concisely and helpfully to callers.',
  'If you do not understand the caller, politely ask them to repeat.',
  'Only speak in the same language as the caller unless instructed otherwise.',
  'Use variety in your responses so they do not sound robotic.',
].join('\n');

const callAcceptPayload = {
  type: 'realtime',
  model: 'gpt-realtime', // keep your working model
  instructions: systemInstructions,
  audio: { output: { voice: 'alloy' } },

  // The built-in web search tool is executed by OpenAI (no server bridge required).
  // Your server does NOT need to implement a function for this one.
  tools: [{ type: 'web_search' }],
};

// Optional: send a greeting if/when a control WS exists
const initialGreetingEvent = {
  type: 'response.create',
  response: {
    instructions: 'Say: Hello! Thanks for calling ACME Internet support. How can I help you today?',
  },
};

// ─────────────────────────────────────────────────────────────
// Control WebSocket (opened ONLY if /accept returns ws_url)
// ─────────────────────────────────────────────────────────────
async function openControlWebSocket(wsUrl, token) {
  const ws = new WebSocket(wsUrl, {
    headers: {
      origin: 'https://api.openai.com',
      'OpenAI-Beta': 'realtime=v1',
      Authorization: `Bearer ${token}`,
    },
  });

  ws.on('open', () => {
    console.log('🔌 Control WS opened:', wsUrl);
    // Kick off a greeting (purely optional—OpenAI will still talk without it)
    ws.send(JSON.stringify(initialGreetingEvent));
  });

  ws.on('message', async (data) => {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    try {
      const evt = JSON.parse(text);
      // For built-in web_search, OpenAI executes and streams results on its side.
      // If you add custom function tools later, handle them here.
      if (evt?.type) console.log('📥 Control WS event:', evt.type);
    } catch (e) {
      console.warn('Unable to parse WS message:', e);
    }
  });

  ws.on('error', (err) => console.error('🔴 Control WS error:', err));
  ws.on('close', (code, reason) => {
    console.log('🔒 Control WS closed:', code, reason?.toString?.() ?? '');
  });
}

function connectControlWsIfAvailable(acceptData) {
  const wsUrl = acceptData?.ws_url;
  const token = acceptData?.client_secret?.value || OPENAI_API_KEY;

  if (!wsUrl) {
    console.log('ℹ️ No ws_url in ACCEPT response → skipping control WS (this is normal for some SIP paths).');
    return;
  }
  console.log('✅ ACCEPT included ws_url. Opening control WS…');
  // small delay to let accept settle
  setTimeout(() => openControlWebSocket(wsUrl, token).catch(console.error), 800);
}

// ─────────────────────────────────────────────────────────────
// Express: raw body required for signature verification
// ─────────────────────────────────────────────────────────────
const app = express();
app.use(bodyParser.raw({ type: '*/*' }));

app.post('/', async (req, res) => {
  try {
    const rawBody = req.body.toString('utf8');
    const event = await client.webhooks.unwrap(rawBody, req.headers);
    const type = event?.type;
    console.log('🔔 Webhook event:', type);

    if (type === 'realtime.call.incoming') {
      const callId = event?.data?.call_id;
      if (!callId) {
        console.error('Missing call_id on incoming call');
        return res.status(400).send('Missing call_id');
      }
      console.log('📞 Incoming call_id:', callId);

      // Accept the call with our session config
      const acceptUrl = `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/accept`;
      const resp = await fetch(acceptUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(callAcceptPayload),
      });

      const text = await resp.text().catch(() => '');
      let data;
      try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }

      console.log('📦 ACCEPT status:', resp.status, resp.statusText);
      console.log('📦 ACCEPT response JSON:', data);

      if (!resp.ok) {
        console.error('❌ Call accept failed:', text || resp.statusText);
        return res.status(502).send('Call accept failed');
      }

      // Open control WS only if OpenAI returned one (prevents your 404)
      connectControlWsIfAvailable(data);

      // Required response header for OpenAI
      res.set('Authorization', `Bearer ${OPENAI_API_KEY}`);
      return res.sendStatus(200);
    }

    // Acknowledge other events
    return res.sendStatus(200);
  } catch (err) {
    const message = String(err?.message ?? '').toLowerCase();
    if (err?.name === 'InvalidWebhookSignatureError' || message.includes('invalid signature')) {
      console.error('❌ Invalid webhook signature');
      return res.status(400).send('Invalid signature');
    }
    console.error('Webhook handler error:', err);
    return res.status(500).send('Server error');
  }
});

app.listen(PORT, () => {
  console.log(`Realtime SIP agent listening on port ${PORT}`);
});
