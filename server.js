import express from 'express';
import bodyParser from 'body-parser';
import WebSocket from 'ws';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import 'dotenv/config';

// Load configuration from environment. See `.env.example` for the required variables.
const PORT = Number(process.env.PORT ?? 8000);
const WEBHOOK_SECRET = process.env.OPENAI_WEBHOOK_SECRET;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!WEBHOOK_SECRET || !OPENAI_API_KEY) {
  console.error('Missing OPENAI_WEBHOOK_SECRET or OPENAI_API_KEY in environment');
  process.exit(1);
}

// Initialise the OpenAI client with the webhook secret.  Without this, `client.webhooks` is undefined [oai_citation:1‡github.com](https://github.com/openai/openai-node#:~:text=import%20,next%2Fheaders%27%3B%20import%20OpenAI%20from%20%27openai).
const client = new OpenAI({
  apiKey: OPENAI_API_KEY,
  webhookSecret: WEBHOOK_SECRET,
});

const app = express();
app.use(bodyParser.raw({ type: '*/*' }));

app.post('/', async (req, res) => {
  try {
    const rawBody = req.body.toString('utf8');
    // Verify and parse the webhook using the client’s helper.  You no longer pass the secret here.
    const event = await client.webhooks.unwrap(rawBody, req.headers);
    if (event?.type === 'realtime.call.incoming') {
      const callId = event.data.call_id;
      // …accept call and open WebSocket…
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Error handling webhook:', err);
    res.status(500).send('Error processing webhook');
  }
});

app.listen(PORT, () => {
  console.log(`Realtime SIP agent listening on port ${PORT}`);
});
