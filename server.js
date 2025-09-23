import express from 'express';
import bodyParser from 'body-parser';
import WebSocket from 'ws';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import 'dotenv/config';

// ───────────────────────────────────────────────────────────────────────────────
// Env + basic checks
// ───────────────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 8000);
const WEBHOOK_SECRET = process.env.OPENAI_WEBHOOK_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!WEBHOOK_SECRET || !OPENAI_API_KEY) {
  console.error('Missing OPENAI_WEBHOOK_SECRET or OPENAI_API_KEY in environment');
  process.exit(1);
}

// Initialize OpenAI client (SDK verifies webhook signatures via client.webhooks.unwrap)
const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
  webhookSecret: WEBHOOK_SECRET,
});

// ───────────────────────────────────────────────────────────────────────────────
/** Session config sent during accept() */
// ───────────────────────────────────────────────────────────────────────────────
const systemInstructions = [
  'You are a friendly voice assistant for ACME Internet.',
  'Respond concisely and helpfully to callers.',
  'If you do not understand the caller, politely ask them to repeat.',
  'Only speak in the same language as the caller unless instructed otherwise.',
  'Use variety in your responses so they do not sound robotic.',
].join('\n');

// ✅ Web Search tool only (executed natively by OpenAI)
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

// Optional: greet right after WS opens
const initialGreetingEvent = {
  type: 'response.create',
  response: {
    instructions: "Say: Hello! Thanks for calling ACME Internet support. How can I help you today?"
  }
};

// ───────────────────────────────────────────────────────────────────────────────
/** WebSocket management — now uses the ws URL/client secret returned by accept */
// ───────────────────────────────────────────────────────────────────────────────
async function websocketTask({ wsUrl, clientSecret }) {
  // Choose connection mode:
  // 1) If wsUrl provided by accept response, connect to it directly.
  // 2) Else, connect to the generic endpoint and auth with clientSecret.
  const url = wsUrl ?? 'wss://api.openai.com/v1/realtime';

  // Build headers: prefer the ephemeral client secret from accept, otherwise fall back (shouldn't happen)
  const headers = {
    origin: 'https://api.openai.com',
    'OpenAI-Beta': 'realtime=v1',
    Authorization: `Bearer ${clientSecret ?? OPENAI_API_KEY}`,
  };

  const ws = new WebSocket(url, { headers });

  ws.on('open', () => {
    console.log('🔌 Realtime WebSocket opened');
    ws.send(JSON.stringify(initialGreetingEvent));
  });

  ws.on('message', (data) => {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    try {
      const evt = JSON.parse(text);
      // Log high-level event types for visibility
      if (evt?.type) console.log('📥 Realtime event:', evt.type);
    } catch (e) {
      console.warn('Unable to parse Realtime WS message:', e);
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });

  ws.on('close', (code, reason) => {
    console.log('🔒 WebSocket closed:', code, reason?.toString?.() ?? '');
  });
}

function connectWS({ wsUrl, clientSecret }, delayMs = 0) {
  setTimeout(() => {
    websocketTask({ wsUrl, clientSecret }).catch((e) =>
      console.error('Failed to start Realtime WebSocket:', e)
    );
  }, delayMs);
}

// ───────────────────────────────────────────────────────────────────────────────
/** Express app + webhook (root path `/`) */
// ───────────────────────────────────────────────────────────────────────────────
const app = express();

// Raw body is required for signature verification
app.use(bodyParser.raw({ type: '*/*' }));

app.post('/', async (req, res) => {
  try {
    const rawBody = req.body.toString('utf8');

    // Verify OpenAI webhook signature
    const event = await client.webhooks.unwrap(rawBody, req.headers);
    const type = event?.type;

    if (type === 'realtime.call.incoming') {
      const callId = event?.data?.call_id;
      if (!callId) {
        console.error('No call_id in realtime.call.incoming event');
        return res.status(400).send('Missing call_id');
      }

      // Accept the call with our session config
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
        console.error('❌ Call accept failed:', acceptResp.status, acceptResp.statusText, text);
        return res.status(502).send('Call accept failed');
      }

      // IMPORTANT: Use data returned by accept to connect WS
      const acceptData = await acceptResp.json().catch(() => ({}));
      // Different responses may include either a ready-to-use WS URL, or a client secret for auth
      const wsUrl =
        acceptData?.ws_url ||
        acceptData?.websocket_url || // alternate field name if present
        null;

      const clientSecret =
        acceptData?.client_secret?.value ||
        acceptData?.client_secret ||
        null;

      if (!wsUrl && !clientSecret) {
        console.error('❌ Accept response missing ws_url/client_secret:', acceptData);
        return res.status(502).send('Accept response incomplete');
      }

      console.log('✅ Accepted call. Connecting WS…', { hasWsUrl: !!wsUrl, hasClientSecret: !!clientSecret });

      // Spin up the Realtime WS using the provided URL or the ephemeral client secret
      connectWS({ wsUrl, clientSecret }, 0);

      // Per OpenAI docs, echo Authorization header (harmless if omitted but kept for completeness)
      res.set('Authorization', `Bearer ${OPENAI_API_KEY}`);
      return res.sendStatus(200);
    }

    // Acknowledge other events (e.g., call ended)
    return res.sendStatus(200);
  } catch (err) {
    const message = err?.message?.toLowerCase?.() ?? '';
    if (err?.name === 'InvalidWebhookSignatureError' || message.includes('invalid signature')) {
      return res.status(400).send('Invalid signature');
    }
    console.error('Webhook handler error:', err);
    return res.status(500).send('Server error');
  }
});

app.listen(PORT, () => {
  console.log(`📞 Realtime SIP agent (Web Search) listening on :${PORT}`);
});
