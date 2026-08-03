// FactLens backend API and Railway-hosted web studio.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import path from 'path';

import transcribeRouter from './routes/transcribe.js';
import factcheckRouter from './routes/factcheck.js';
import coverageRouter from './routes/coverage.js';
import discussionRouter from './routes/discussion.js';
import { getStatus } from './lib/apiStatus.js';
import { requestThrottle, getBudgets } from './lib/rateLimit.js';

// We allow key overrides from the extension/web UI, so missing .env keys are warnings.
const RECOMMENDED_KEYS = ['GROQ_API_KEY', 'TAVILY_API_KEY'];
const missing = RECOMMENDED_KEYS.filter(k => !process.env[k]);
if (missing.length > 0) {
  console.warn(`[FactLens] ${missing.join(', ')} not set in backend/.env.`);
  console.warn('[FactLens] Requests must then supply keys via the extension\'s Settings page (X-Groq-Key / X-Tavily-Key headers), or they will fail.');
}

// NewsAPI is optional because core statement checks can still run without it.
if (!process.env.NEWSAPI_KEY) {
  console.warn('[FactLens] NEWSAPI_KEY not set - multi-outlet coverage analysis (/coverage) is disabled unless supplied via the extension Settings page.');
}

const app = express();
const PORT = process.env.PORT || 3001;
const STARTED_AT = new Date().toISOString();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Railway sits behind a proxy, so we trust one hop for the hosted frontend origin.
app.set('trust proxy', 1);

// Allow the extension, local dev, and the same origin that serves the web studio.
app.use((req, res, next) => {
  const sameOrigin = `${req.protocol}://${req.get('host')}`;
  const publicOrigin = process.env.PUBLIC_ORIGIN;

  return cors({
    origin: (origin, callback) => {
      if (
        !origin ||
        origin === sameOrigin ||
        origin === publicOrigin ||
        origin.startsWith('chrome-extension://') ||
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)
      ) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin ${origin} not allowed`));
      }
    },
  })(req, res, next);
});

app.use(express.json());

// We serve the web studio from the same Railway service as the API.
app.use(express.static(path.join(__dirname, 'public')));

// We throttle routes so a stuck button or bug cannot hammer paid APIs.
app.use('/transcribe', requestThrottle(10), transcribeRouter);
app.use('/factcheck', requestThrottle(6), factcheckRouter);
app.use('/coverage', requestThrottle(6), coverageRouter);
app.use('/discussion', requestThrottle(6), discussionRouter);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Show provider health so dead keys are easy to diagnose.
app.get('/status', (_req, res) => {
  res.json({ providers: getStatus(), budgets: getBudgets(), since: STARTED_AT });
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error('[FactLens Server Error]', err.message);
  // Keep budget stops separate from real server failures.
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`[FactLens] Backend running on http://localhost:${PORT}`);
});
