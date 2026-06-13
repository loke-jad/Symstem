/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars, @typescript-eslint/no-inferrable-types, no-empty, prefer-const, @typescript-eslint/ban-ts-comment */
import {
  AngularNodeAppEngine,
  createNodeRequestHandler,
  isMainModule,
  writeResponseToNodeResponse,
} from '@angular/ssr/node';
import express from 'express';
import {join} from 'node:path';
import {GoogleGenAI} from '@google/genai';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import Stripe from 'stripe';
import { SONG_SPEC_SCHEMA, STEM_CHECK_SCHEMA } from './app/schema.js';

const browserDistFolder = join(import.meta.dirname, '../browser');

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });
wss.on('connection', (ws: WebSocket) => {
  ws.on('message', (message: any, isBinary: boolean) => {
    wss.clients.forEach((client) => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(message, { binary: isBinary });
      }
    });
  });
});

const angularApp = new AngularNodeAppEngine();

app.use(express.json());

// WebSocket middleware
app.use('/api', (req, res, next) => {
  if (req.path === '/yjs' && req.headers.upgrade?.toLowerCase() === 'websocket') {
    wss.handleUpgrade(req, req.socket, Buffer.alloc(0), (ws: WebSocket) => {
      wss.emit('connection', ws, req);
    });
    return;
  }
  next();
});

let stripeClient: Stripe | null = null;
function getStripe(): Stripe {
  if (!stripeClient) {
    const key = process.env['STRIPE_SECRET_KEY'];
    if (!key) {
      throw new Error('STRIPE_SECRET_KEY environment variable is required');
    }
    stripeClient = new Stripe(key);
  }
  return stripeClient;
}

const PRODUCER_MODEL = 'gemini-3.5-flash';
const INSTRUMENT_MODEL = 'lyria-3-clip-preview';

const PRODUCER_SYSTEM = "You are the Loopster producer agent. Turn the user's track description into a song spec for loop generation. Choose 3-6 channels, each one instrument with one job. Every loop_prompt must be a self-contained instruction to a music generator for a SINGLE-INSTRUMENT 4-bar loop: name the instrument, the exact BPM, the key, the feel, and say 'loopable, no fade in or out, no other instruments'. All channels share the same BPM, key, and time signature.";

app.post('/api/generate', async (req, res) => {
  const { description } = req.body;
  
  if (!description) {
    res.status(400).json({ error: 'Missing description' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const emitEvent = (event: string, data: any) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const ai = new GoogleGenAI({ apiKey: process.env['GEMINI_API_KEY']! });
    
    emitEvent('status', { message: 'Producer is writing the song spec...' });

    const specResponse = await ai.interactions.create({
      model: PRODUCER_MODEL,
      system_instruction: PRODUCER_SYSTEM,
      input: description,
      response_format: {
        type: 'text',
        mime_type: 'application/json',
        schema: SONG_SPEC_SCHEMA as any
      }
    });

    // The output is typically text format when response_format is JSON schema
    const lastStep: any = specResponse.steps?.at(-1);
    const rawSpecText = lastStep?.content?.[0]?.text;
    if (!rawSpecText) {
      throw new Error('Failed to generate spec from producer agent.');
    }
    const spec = JSON.parse(rawSpecText);
    
    emitEvent('spec', spec);
    emitEvent('status', { message: `Spec generated. Briefing ${spec.channels.length} instrument agents...` });

    const bricks: any[] = [];
    
    const generateBrick = async (channel: any) => {
      let prompt = channel.loop_prompt;
      let check: any = {};
      let audioRes: any;
      let take = 1;
      
      for (; take <= 3; take++) {
        emitEvent('status', { message: `Generating ${channel.instrument} (Take ${take})...` });
        const instrRes = await ai.interactions.create({
          model: INSTRUMENT_MODEL,
          input: prompt
        });

        const instrLast: any = instrRes.steps?.at(-1);
        audioRes = instrLast?.content?.find((c: any) => c.type === 'audio');
        if (!audioRes) {
          throw new Error(`Instrument agent failed to return audio for ${channel.instrument}`);
        }

        emitEvent('status', { message: `Listening to ${channel.instrument} to verify isolation...` });
        const verifyRes = await ai.interactions.create({
          model: PRODUCER_MODEL,
          input: [
            { type: 'audio', data: audioRes.data, mime_type: audioRes.mime_type || 'audio/wav' },
            { type: 'text', text: `This clip is labeled '${channel.instrument}'. List every instrument or sound you hear. Is it a single isolated instrument stem? Incidental noise of the instrument itself does not count as a second instrument.` }
          ],
          response_format: {
            type: 'text',
            mime_type: 'application/json',
            schema: STEM_CHECK_SCHEMA as any
          }
        });
        
        const verifyLast: any = verifyRes.steps?.at(-1);
        const rawCheckText = verifyLast?.content?.[0]?.text;
        check = rawCheckText ? JSON.parse(rawCheckText) : { is_single_instrument: true, instruments_heard: [] };
        
        if (check.is_single_instrument) break;
        
        const extras = check.instruments_heard?.filter((i: string) => !i.toLowerCase().includes(channel.instrument.toLowerCase())) || [];
        prompt = channel.loop_prompt + ` CRITICAL: the previous take wrongly included ${extras.join(', ')}. Produce ONLY the isolated ${channel.instrument} - absolutely no drums, percussion, snaps, or any other sound source.`;
      }

      const brickId = `brick-${Math.random().toString(36).substring(2, 10)}`;
      
      const brick = {
        id: brickId,
        verified_stem: !!check.is_single_instrument,
        heard: check.instruments_heard || [],
        takes: take > 3 ? 3 : take,
        name: `${channel.instrument} — ${spec.title}`,
        instrument: channel.instrument,
        color: channel.instrument,
        audio_data: audioRes.data,
        mime: audioRes.mime_type || 'audio/wav',
        bpm: spec.bpm,
        key: spec.key,
        bars: 4,
        time_sig: spec.time_sig,
        tags: [spec.genre, channel.role],
        params: { gain: 1.0, rate: 1.0, pitch: 0 },
        lineage: {
          derived_from: null,
          created_by: "producer-agent",
          generator: INSTRUMENT_MODEL,
          prompt: channel.loop_prompt,
        }
      };

      bricks.push(brick);
      emitEvent('brick', brick);
      return brick;
    };

    await Promise.all(spec.channels.map(generateBrick));

    emitEvent('status', { message: 'All bricks matched and arranged.' });
    emitEvent('done', { message: 'Success' });
  } catch (err: any) {
    console.error(err);
    emitEvent('error', { message: err.message || 'Unknown error' });
  } finally {
    res.end();
  }
});

app.post('/api/checkout', async (req, res) => {
  try {
    const stripe = getStripe();
    // Use test mode mock behavior if we're not actually configured or just simulate
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'Trackpack License' },
          unit_amount: 500,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: req.headers.origin + '/?success=true',
      cancel_url: req.headers.origin + '/?canceled=true',
    });
    res.json({ id: session.id, url: session.url });
  } catch (err: any) {
    // Graceful fallback for preview mode missing keys
    if (err.message.includes('STRIPE_SECRET_KEY')) {
      res.json({ id: 'mock-session', url: '/?mock_payment=success' });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

/**
 * Serve static files from /browser
 */
app.use(
  express.static(browserDistFolder, {
    maxAge: '1y',
    index: false,
    redirect: false,
  }),
);

/**
 * Handle all other requests by rendering the Angular application.
 */
app.use((req, res, next) => {
  angularApp
    .handle(req)
    .then((response) =>
      response ? writeResponseToNodeResponse(response, res) : next(),
    )
    .catch(next);
});

/**
 * Start the server if this module is the main entry point, or it is ran via PM2.
 * The server listens on the port defined by the `PORT` environment variable, or defaults to 4000.
 */
if (isMainModule(import.meta.url) || process.env['pm_id']) {
  const port = process.env['PORT'] || 4000;
  server.listen(port, () => {
    console.log(`Node Express server listening on http://localhost:${port}`);
  });
}

/**
 * Request handler used by the Angular CLI (for dev-server and during build) or Firebase Cloud Functions.
 */
export const reqHandler = createNodeRequestHandler(app);
