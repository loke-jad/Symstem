import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI } from '@google/genai';

// Initialize Express
const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Lazy-initialize Gemini client to avoid crashes if API key is missing
let aiClient: GoogleGenAI | null = null;
function getGeminiClient() {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn('Warning: GEMINI_API_KEY is not defined. AI functionality will run in sandbox mode.');
      return null;
    }
    aiClient = new GoogleGenAI({ apiKey });
  }
  return aiClient;
}

// System prompt to guide the AI sound engineer
const SYSTEM_PROMPT = `You are the LoopLab AI Sound Engineer, a collaborative multi-track producer.
Your goal is to help the user build an amazing audio loop layout.
When a user asks to add, generate, or modify sounds, you should suggest new stems ("bricks") to add to their workstation, or update existing ones.

Always respond in a clean JSON format:
{
  "message": "Friendly, humble assistant text response describing the action, ideas, or feedback on their music",
  "new_stem": {
    "id": "unique-id-string",
    "name": "Name of the stem (e.g., 'Groovy Slap Bass', 'Psychedelic Lead', 'Lofi Hip Hop Beat')",
    "instrument": "synth" | "bass" | "drum" | "pad" | "melody",
    "verified_stem": true,
    "notes": "Description of the generated pattern details",
    "bars": 4,
    "tempo": 120,
    "synth_params": {
      "type": "synth" | "bass" | "drum" | "pad" | "melody",
      "frequencies": [110, 130.81, 164.81, 196]
    }
  }
}

If no new stem is requested or created, set "new_stem" to null.
Ensure the response is valid, parseable JSON and nothing else. Do not use markdown backticks outside of returning raw JSON. Do not enclose the JSON in \`\`\`json \`\`\`. Please return a pure JSON string.`;

// API Routes
app.post('/api/chat', async (req, res) => {
  const { messages } = req.body;
  const client = getGeminiClient();

  if (!client) {
    // Elegant fallback/sandbox mode if API key is missing
    const userMessage = messages[messages.length - 1]?.text || '';
    let mockResponse = {
      message: `LoopLab is running in Sandbox mode because no GEMINI_API_KEY is configured. I can still help you build tracks! I hear you want: "${userMessage}". Let me add a custom procedural stem to your workspace.`,
      new_stem: {
        id: 'procedural-' + Date.now().toString(),
        name: 'Sandbox Procedural ' + (userMessage.length > 5 ? userMessage.substring(0, 12) : 'Melody'),
        instrument: 'synth',
        verified_stem: true,
        notes: 'Sandbox generated oscillator wave',
        bars: 4,
        tempo: 120,
        synth_params: {
          type: 'synth',
          frequencies: [261.63, 329.63, 392.00, 523.25]
        }
      }
    };
    return res.json(mockResponse);
  }

  try {
    const formattedHistory = messages.map((m: any) => ({
      role: m.role === 'user' ? 'user' : 'model',
      parts: [{ text: m.text }]
    }));

    // Standard Gemini 3.5 Flash Model
    const response = await client.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: [
        { role: 'user', parts: [{ text: SYSTEM_PROMPT }] },
        ...formattedHistory
      ],
      config: {
        responseMimeType: 'application/json'
      }
    });

    const text = response.text || '{}';
    const data = JSON.parse(text);
    return res.json(data);
  } catch (error: any) {
    console.error('Error generating content from Gemini API:', error);
    return res.status(500).json({
      message: 'Failed to complete audio generation request: ' + error.message,
      new_stem: null
    });
  }
});

// Serve frontend build output
const distPath = path.resolve('dist/browser');
app.use(express.static(distPath));

// Fallback to Angular SPA routing index
app.get('*', (req, res) => {
  const indexFile = path.join(distPath, 'index.html');
  res.sendFile(indexFile);
});

// Start listening
app.listen(port, () => {
  console.log(`LoopLab backend running on port ${port}`);
});
