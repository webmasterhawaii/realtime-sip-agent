import express from 'express';
import bodyParser from 'body-parser';
import WebSocket from 'ws';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import 'dotenv/config';

// ─────────────────────────────────────────────────────────────
// Environment & Checks
// ─────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 8000);
const WEBHOOK_SECRET = process.env.OPENAI_WEBHOOK_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// 🔑 IMPORTANT: must match the project id used in your Twilio SIP Origination URI
// e.g. sip:proj_T7Q7VX28XwkNHh39cDbtiJkO@sip.api.openai.com;transport=tls
const OPENAI_PROJECT = process.env.OPENAI_PROJECT; 

if (!WEBHOOK_SECRET || !OPENAI_API_KEY) {
  console.error('ERROR: Missing OPENAI_WEBHOOK_SECRET or OPENAI_API_KEY');
  process.exit(1);
}
if (!OPENAI_PROJECT) {
  console.warn('⚠️  OPENAI_PROJECT not set. Set it to your project id (e.g. proj_...).');
}

const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
  webhookSecret: WEBHOOK_SECRET,
  // Setting project here helps all SDK calls (like webhooks.unwrap) use the right project
  // (SDK supports { project }).
  project: OPENAI_PROJECT,
});

// ─────────────────────────────────────────────────────────────
const systemInstructions = [
  'You are a friendly voice assistant for ACME Internet.',
  'Respond concisely and helpfully.',
  'If you do not understand the caller, politely ask them to repeat.',
  'Speak in the caller’s language unless asked otherwise.',
  'Vary phrasing so it doesn’t sound robotic.',
].join('\n');

const callAcceptPayload = {
  type: 'realtime',
  model: 'gpt-4o-realtime-preview-2025-06-03',
  instructions: systemInstructions,
  modalities: ['audio'],
  audio: { output: { voice: 'alloy' } },
  tools: [
    { type: 'web_search', name: 'search', description: 'Search the web for recent information.' }
  ]
};

const initialGreetingEvent = {
  type: 'response.create',
  response: {
    instructions: "Say: Hello! Thanks for calling ACME Internet support. How can I help you today?"
  }
};

// ─────────────────────────────────────────────────────────────
// WebSocket Handling
// ─────────────────────────────────────────────────────────────
async function websocketTask(wssUrl, authToken) {
  const ws = new WebSocket(wssUrl, {
    headers: {
      origin: 'https://api.openai.com',
      'OpenAI-Beta': 'realtime=v1',
      // 🔑 Ensure the WS handshake is scoped to the same project as the call
      ...(OPENAI_PROJECT ? { 'OpenAI-Project': OPENAI_PROJECT } : {}),
      Authorization: `Bearer ${authToken}`,
    },
  });

  ws.on('open', () => {
    console.log('🔌 WebSocket opened:', wssUrl);
    ws.send(JSON.stringify(initialGreetingEvent));
  });

  ws.on('message', (data) => {
    const msg = typeof data === 'string' ? data : data.toString('utf8');
    try {
      const evt = JSON.parse(msg);
      console.log('📥 WS event type:', evt?.type);
    } catch (err) {
      console.warn('⚠️ WS message parse error:', err);
    }
  });

  ws.on('error', (err) => console.error('🔴 WS error:', err));
  ws.on('close', (code, reason) => {
    console.log('🔒 WS closed:', code, reason?.toString() ?? '');
  });
}

function connectWithDelay(wssUrl, authToken, delayMs = 2500) {
  setTimeout(() => {
    websocketTask(wssUrl, authToken).catch((err) => {
      console.error('WS connect failed:', err);
    });
  }, delayMs);
}

// ─────────────────────────────────────────────────────────────
// Express + Webhook Endpoint
// ─────────────────────────────────────────────────────────────
const app = express();
// OpenAI wants the raw body for signature verification
app.use(bodyParser.raw({ type: 'application/json' }));

app.post('/', async (req, res) => {
  try {
    const rawBody = req.body.toString('utf8');
    const event = await client.webhooks.unwrap(rawBody, req.headers);
    console.log('🔔 Webhook event:', event?.type);

    if (event?.type === 'realtime.call.incoming') {
      const callId = event?.data?.call_id;
      console.log('📞 Incoming call_id:', callId);
      if (!callId) return res.status(400).send('Missing call_id');

      const acceptUrl = `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/accept`;
      const acceptHeaders = {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'realtime=v1',
        // 🔑 Scope this accept call to the same project that owns the call_id
        ...(OPENAI_PROJECT ? { 'OpenAI-Project': OPENAI_PROJECT } : {}),
      };

      const acceptResp = await fetch(acceptUrl, {
        method: 'POST',
        headers: acceptHeaders,
        body: JSON.stringify(callAcceptPayload),
      });

      const respText = await acceptResp.text().catch(() => '');
      let acceptData = null;
      try { acceptData = respText ? JSON.parse(respText) : null; } catch { /* ignore */ }

      console.log('📦 ACCEPT status:', acceptResp.status, acceptResp.statusText);
      console.log('📦 ACCEPT raw:', respText || '<empty body>');
      if (acceptData) console.log('📦 ACCEPT parsed:', acceptData);

      if (!acceptResp.ok) {
        console.error('❌ ACCEPT failed');
        return res.status(502).send('Accept failed');
      }

      // Use client_secret if present; otherwise default to API key
      const token = acceptData?.client_secret?.value || OPENAI_API_KEY;
      const wssUrl = acceptData?.ws_url
        ? acceptData.ws_url
        : `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`;

      console.log('✅ ACCEPT OK. Connecting WS with:', {
        wssUrl,
        usingEphemeral: token !== OPENAI_API_KEY,
        project: OPENAI_PROJECT || '<default>',
      });

      connectWithDelay(wssUrl, token, 2500);

      // Acknowledge webhook (OpenAI expects an Authorization header echoed back)
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

// ─────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`📞 Realtime SIP agent (Web Search) listening on :${PORT}`);
});
