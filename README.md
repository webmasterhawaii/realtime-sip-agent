# Realtime SIP Agent

This project implements a simple voice agent for the OpenAI Realtime API and a Twilio SIP trunk.  When someone calls a Twilio number connected to your SIP trunk, Twilio forwards the call to OpenAI.  OpenAI then forwards an incoming call webhook to this server.  The server accepts the call, instructs the model how to behave, opens a WebSocket for the audio stream and handles any function calls from the model.

## Key concepts

* **SIP trunking.**  Twilio routes inbound calls to the OpenAI SIP endpoint using an origination URI of the form `sip:<your_project_id>@sip.api.openai.com;transport=tls`.  The Twilio blog details how to purchase a voice‑enabled number, create a SIP trunk and add the origination URI【501579161073898†L824-L876】.  Once configured, incoming calls to your Twilio number are forwarded to OpenAI.

* **Webhook for incoming calls.**  When the OpenAI Realtime API receives a SIP call, it emits a `realtime.call.incoming` event to the webhook URL configured in the OpenAI console.  The webhook must accept the call by sending a `POST` request to `/v1/realtime/calls/{call_id}/accept` with instructions, model settings and voice selection.  The sample server in this repo does exactly that.

* **WebSocket conversation.**  After accepting the call the server connects to `wss://api.openai.com/v1/realtime?call_id=<call_id>` and sends an initial greeting.  The server then listens for events over the WebSocket and can respond to function calls from the model by sending `conversation.item.create` events with a `function_call_output` item.  According to the API reference, a `function_call_output` item includes a `call_id` and an `output` string containing the JSON‑encoded result【1776078711550†L1830-L1860】.

* **Prompting guidelines.**  Realtime models follow short bullet points more reliably than long paragraphs.  The included system instructions use concise bullet‑style rules, ask the assistant to mirror the caller’s language and to ask for clarification when audio is unclear【783853029708891†L24-L37】.  See the “Seven tips for prompting voice agents with the Realtime API” guide for more advice.

* **Function calling.**  You can expose custom functions to the model by defining them in the `tools` array of the accept payload.  When the model decides to call a function it emits a `function_call` item.  The client must respond with a `conversation.item.create` event containing a `function_call_output` item whose `call_id` matches the original call and whose `output` property contains the JSON result【1776078711550†L1830-L1860】.  The provided server demonstrates this pattern with two simple functions (`get_current_time` and `get_random_number`).

## Getting started

1. **Clone the repo and install dependencies.**

   ```bash
   git clone <your-repo-url>
   cd realtime-sip-agent
   npm install
   ```

2. **Create a `.env` file.**  Copy `.env.example` to `.env` and provide your OpenAI API key and webhook signing secret.  The port can remain `8000` unless you need to use a different one.

3. **Configure your OpenAI project.**
   * Create or select a project in the [OpenAI console](https://platform.openai.com/).
   * In **Settings → Webhooks**, click **+ Add webhook** and enter the publicly reachable URL of your server (for local development you can expose port 8000 using a tool like ngrok).  Select the `realtime.call.incoming` event.
   * Copy the **Signing secret** value and set it as `OPENAI_WEBHOOK_SECRET` in your `.env` file.
   * Note your project ID from the general settings page; you’ll need it when configuring Twilio.

4. **Purchase a Twilio number and configure a SIP trunk.**  Follow the Twilio guide to buy a voice‑enabled number, create a SIP trunk and set the origination URI to `sip:<project_id>@sip.api.openai.com;transport=tls`.  Then assign your number to the trunk so that incoming calls are forwarded to OpenAI【501579161073898†L824-L877】.

5. **Run the server locally.**  Once your webhook URL is reachable and your environment variables are configured, start the server:

   ```bash
   npm start
   ```

   You should see `Realtime SIP agent listening on port 8000` printed in the console.

6. **Test the call flow.**  Dial your Twilio number.  The server will accept the call, send the system instructions and greet the caller.  Try asking the assistant to “What time is it?” or “Give me a random number.”  When the model requests the `get_current_time` or `get_random_number` functions the server executes the function and returns the result to the model via a `function_call_output` item【1776078711550†L1830-L1860】.

## Deployment on Railway

Railway makes it easy to deploy Node.js apps.  Here’s a basic workflow:

1. **Create a new project.**  Sign in to your [Railway account](https://railway.app/) and click **New Project** → **Deploy from GitHub**.  Select the repository containing this project.
2. **Set environment variables.**  Under **Variables** add `OPENAI_API_KEY`, `OPENAI_WEBHOOK_SECRET` and `PORT` (set to `8000`).
3. **Deploy.**  Railway will automatically install dependencies and run `npm start`.  Once deployed, copy the generated domain (e.g. `https://your-project.up.railway.app`) and update your webhook URL in the OpenAI console accordingly.

After deployment, incoming SIP calls will trigger the webhook hosted on Railway and you’ll have a fully hosted voice agent ready to handle customer conversations.

## Notes

* This sample uses Node’s built‑in `fetch` via the `node-fetch` package.  If you are running on Node 18+ the global `fetch` may be available and you can remove the dependency.
* For production use you should implement persistent state, error handling and logging.  Additionally, consider using an async task queue for function execution if functions perform slow I/O.
* The assistant voice (`alloy`) and model (`gpt-realtime`) can be adjusted in the `callAcceptPayload` object.  See the Realtime API docs for available options.
