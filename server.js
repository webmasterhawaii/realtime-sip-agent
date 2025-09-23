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

if (!WEBHOOK_SECRET || !OPENAI_API_KEY) {
  console.error('ERROR: Missing OPENAI_WEBHOOK_SECRET or OPENAI_API_KEY');
  process.exit(1);
}

const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
  webhookSecret: WEBHOOK_SECRET,
});

// ─────────────────────────────────────────────────────────────
// Session Config — Web Search only, with correct model
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
  model: 'gpt-4o-realtime-preview-latest',   // ✅ SIP-compatible model
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

// ─────────────────────────────────────────────────────────────
// WebSocket Handling
// ─────────────────────────────────────────────────────────────
async function websocketTask(wssUrl, authToken) {
  const ws = new WebSocket(wssUrl, {
    headers: {
      origin: 'https://api.openai.com',
      'OpenAI-Beta': 'realtime=v1',
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

  ws.on('error', (err) => {
    console.error('🔴 WS error:', err);
  });

  ws.on('close', (code, reason) => {
    console.log('🔒 WS closed:', code, reason?.toString() ?? '');
  });
}

function connectWithDelay(wssUrl, authToken, delayMs = 1200) {
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
app.use(bodyParser.raw({ type: 'application/json' }));

app.post('/', async (req, res) => {
  try {
    const rawBody = req.body.toString('utf8');
    const event = await client.webhooks.unwrap(rawBody, req.headers);
    console.log('🔔 Webhook event:', event?.type);

    if (event?.type === 'realtime.call.incoming') {
      const callId = event?.data?.call_id;
      console.log('📞 Incoming call_id:', callId);

      if (!callId) {
        console.error('Missing call_id');
        return res.status(400).send('Missing call_id');
      }

      const acceptUrl = `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/accept`;
      const acceptResp = await fetch(acceptUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(callAcceptPayload)
      });

      const respText = await acceptResp.text().catch(() => '');
      let acceptData;
      try {
        acceptData = JSON.parse(respText);
      } catch {
        acceptData = null;
      }
      console.log('📦 ACCEPT status:', acceptResp.status, acceptResp.statusText);
      console.log('📦 ACCEPT response:', acceptData ?? respText);

      if (!acceptResp.ok) {
        console.error('❌ ACCEPT failed');
        return res.status(502).send('Accept failed');
      }

      // Determine WS connection info
      let wssUrl, token;
      token = acceptData?.client_secret?.value || OPENAI_API_KEY;

      if (acceptData?.ws_url) {
        wssUrl = acceptData.ws_url;
      } else {
        // fallback as docs suggest
        wssUrl = `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`;
      }

      console.log('✅ ACCEPT OK. Connecting WS with:', { wssUrl, usingEphemeral: token !== OPENAI_API_KEY });

      connectWithDelay(wssUrl, token, 1200);

      // respond HTTP 200 OK
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
