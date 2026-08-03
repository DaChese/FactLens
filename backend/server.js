/**
 * server.js — FactLens Express Backend
 *
 * Responsibilities:
 *  - Serve as the secure API proxy between the Chrome extension and third-party APIs
 *  - Load API keys from .env (never expose them to the extension)
 *  - Mount route handlers for /transcribe, /factcheck, and /coverage
 *  - Enable CORS for the extension origin
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';

import transcribeRouter  from './routes/transcribe.js';
import factcheckRouter   from './routes/factcheck.js';
import coverageRouter    from './routes/coverage.js';
import discussionRouter  from './routes/discussion.js';
import { getStatus }     from './lib/apiStatus.js';
import { requestThrottle, getBudgets } from './lib/rateLimit.js';

// ─── Startup Validation ──────────────────────────────────────────────────────

// GROQ_API_KEY / TAVILY_API_KEY can also be supplied per-request via the
// X-Groq-Key / X-Tavily-Key headers (set from the extension's Settings page),
// so a missing .env is a warning, not a hard failure — routes validate at
// request time and return a 400 if no key is available from either source.
const RECOMMENDED_KEYS = ['GROQ_API_KEY', 'TAVILY_API_KEY'];
const missing = RECOMMENDED_KEYS.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.warn(`[FactLens] ${missing.join(', ')} not set in backend/.env.`);
  console.warn('[FactLens] Requests must then supply keys via the extension\'s Settings page (X-Groq-Key / X-Tavily-Key headers), or they will fail.');
}

// NEWSAPI_KEY is optional — coverage analysis degrades gracefully without it
if (!process.env.NEWSAPI_KEY) {
  console.warn('[FactLens] NEWSAPI_KEY not set — multi-outlet coverage analysis (/coverage) is disabled unless supplied via the extension Settings page.');
}

const app        = express();
const PORT       = process.env.PORT || 3001;
const STARTED_AT = new Date().toISOString();

// ─── Middleware ──────────────────────────────────────────────────────────────

// Allow requests from the Chrome extension (chrome-extension://* scheme)
// and localhost during development.
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (e.g., curl, Postman) and extension origins
    if (!origin || origin.startsWith('chrome-extension://') || origin === `http://localhost:${PORT}`) {
      callback(null, true);
    } else {
      callback(new Error(`CORS: origin ${origin} not allowed`));
    }
  },
}));

// Parse JSON bodies
app.use(express.json());

// ─── Routes ──────────────────────────────────────────────────────────────────

// Route throttles — loop-breakers so a stuck button or bug can't hammer
// the paid APIs. Generous for human use: notes are built one at a time.
app.use('/transcribe', requestThrottle(10), transcribeRouter);
app.use('/factcheck',  requestThrottle(6),  factcheckRouter);
app.use('/coverage',   requestThrottle(6),  coverageRouter);
app.use('/discussion', requestThrottle(6),  discussionRouter);

// Health check — useful for verifying the server is up
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Per-provider API health: which providers are working, erroring, or
// rate-limited, with call counts since the backend started. Shown on the
// extension's Settings page so a dead key is diagnosable at a glance.
app.get('/status', (_req, res) => {
  res.json({ providers: getStatus(), budgets: getBudgets(), since: STARTED_AT });
});

// ─── Global Error Handler ────────────────────────────────────────────────────

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[FactLens Server Error]', err.message);
  // Budget/rate-limit errors carry status 429 so the extension can tell the
  // difference between "we stopped ourselves" and a real failure.
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`[FactLens] Backend running on http://localhost:${PORT}`);
});
