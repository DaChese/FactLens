/**
 * server.js — FactLens Express Backend
 *
 * Responsibilities:
 *  - Serve as the secure API proxy between the Chrome extension and third-party APIs
 *  - Load API keys from .env (never expose them to the extension)
 *  - Mount route handlers for /transcribe, /factcheck, and /bias
 *  - Enable CORS for the extension origin
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import transcribeRouter from './routes/transcribe.js';
import factcheckRouter  from './routes/factcheck.js';
import biasRouter       from './routes/bias.js';

// ─── Startup Validation ──────────────────────────────────────────────────────

const REQUIRED_KEYS = ['GROQ_API_KEY', 'TAVILY_API_KEY'];
const missing = REQUIRED_KEYS.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.error(`[FactLens] Missing required environment variables: ${missing.join(', ')}`);
  console.error('[FactLens] Copy backend/.env.example to backend/.env and fill in your keys.');
  process.exit(1);
}

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── Middleware ──────────────────────────────────────────────────────────────

// Allow requests from the Chrome extension (chrome-extension://* scheme)
// and localhost during development.
app.use(cors({
  origin: (origin, callback) => {
    // Allow: no origin (curl/Postman), Chrome extensions, localhost
    if (
      !origin ||
      origin.startsWith('chrome-extension://') ||
      origin === `http://localhost:${PORT}` ||
      origin === `https://localhost:${PORT}`
    ) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
}));

// Parse JSON bodies
app.use(express.json());

// ─── Routes ──────────────────────────────────────────────────────────────────

app.use('/transcribe', transcribeRouter);
app.use('/factcheck',  factcheckRouter);
app.use('/bias',       biasRouter);

// Health check — useful for verifying the server is up
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Global Error Handler ────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[FactLens Server Error]', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[FactLens] Backend running on http://localhost:${PORT}`);
});
