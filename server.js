import express from 'express';
import bodyParser from 'body-parser';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import 'dotenv/config';

// ─────────────────────────────────────────────────────────────
// Environment & Checks
// ─────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT ?? 8000);
const WEBHOOK_SECRET = process.env.OPENAI_WEBHOOK_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// Must match the project in your Twilio Origination URI (sip:proj_...@sip.api.openai.com)
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
  project: OPENAI_PROJECT,
});

// ─────────────────────────────────────────────────────────────
// Session Config — SIP + built-in Web Search
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
  // Use a SIP-compatible realtime model your project has access to:
  model: 'gpt-4o-realtime-preview-2025-06-03',
  instructions: systemInstructions,
  modalities: ['audio'],
  audio: { output: { voice: 'alloy' } },
  tools: [
    { type: 'web_search', name: 'search', description: 'Search the web for recent information.' }
  ],
  // Optional knobs you can experiment with later:
  // turn_detection: { type: 'server_vad' },
  // input_audio_format: { type: 'wav', sample_rate_hz: 8000 },
};

// ─────────────────────────────────────────────────────────────
// Express + Webhook Endpoint
// ─────────────────────────────────────────────────────────────
const app = express();
// OpenAI needs raw body for signature verification
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

      // Accept the call — let OpenAI handle media + tools server-side
      const acceptUrl = `https://api.openai.com/v1/realtime/calls/${encodeURIComponent(callId)}/accept`;
      const acceptHeaders = {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'realtime=v1',
        ...(OPENAI_PROJECT ? { 'OpenAI-Project': OPENAI_PROJECT } : {}),
      };

      const acceptResp = await fetch(acceptUrl, {
        method: 'POST',
        headers: acceptHeaders,
        body: JSON.stringify(callAcceptPayload),
      });

      const respText = await acceptResp.text().catch(() => '');
      console.log('📦 ACCEPT status:', acceptResp.status, acceptResp.statusText);
      console.log('📦 ACCEPT raw:', respText || '<empty body>');

      if (!acceptResp.ok) {
        console.error('❌ ACCEPT failed');
        return res.status(502).send('Accept failed');
      }

      // No WS: leave OpenAI to drive the call. Just ACK the webhook.
      res.set('Authorization', `Bearer ${OPENAI_API_KEY}`);
      return res.sendStatus(200);
    }

    // (Optional) log ended calls for debugging
    if (event?.type === 'realtime.call.ended') {
      console.log('📴 Call ended:', event?.data?.call_id);
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
