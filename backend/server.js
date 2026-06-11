/**
 * server.js — FactLens Express Backend
 *
 * Responsibilities:
 *  - Serve as the secure API proxy between the Chrome extension and third-party APIs
 *  - Load API keys from .env (never expose them to the extension)
 *  - Mount route handlers for /transcribe, /factcheck, and /bias
 *  - Enable CORS for the extension origin
 *  - Rate-limit API routes to protect free-tier quotas
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';

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

// Railway runs Express behind a proxy; trust one hop so IP-based rate limits work.
app.set('trust proxy', 1);

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

// Basic security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});

// ─── Rate Limiting ───────────────────────────────────────────────────────────
// Protects free-tier Groq and Tavily quotas from runaway clients or bugs.
// Limits are per IP — generous enough for normal use, tight enough to prevent abuse.

// Transcription: audio chunk every ~3s per tab → 20 requests/min is plenty
const transcribeLimiter = rateLimit({
  windowMs:         60 * 1000, // 1 minute
  max:              20,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: 'Too many transcription requests. Please wait a moment.' },
});

// Analysis: runs every 20s → 5 requests/min per route is generous
const analysisLimiter = rateLimit({
  windowMs:         60 * 1000,
  max:              5,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: 'Too many analysis requests. Please wait a moment.' },
});

// ─── Routes ──────────────────────────────────────────────────────────────────

app.use('/transcribe', transcribeLimiter, transcribeRouter);
app.use('/factcheck',  analysisLimiter,   factcheckRouter);
app.use('/bias',       analysisLimiter,   biasRouter);

// Health check — used by Railway for deployment health and by the extension
// to detect cold starts before showing a "warming up" message.
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
