/**
 * lib/apiStatus.js — Per-provider API health tracking
 *
 * Every outbound call to Groq, Tavily, or NewsAPI is recorded here so
 * GET /status can show which providers are working, which are erroring,
 * and which have hit their rate limit / quota — instead of the extension
 * failing with a vague message and nobody knowing which key ran out.
 *
 * State is in-memory and resets when the backend restarts.
 */

const PROVIDERS = ['groq', 'tavily', 'newsapi'];

const status = Object.fromEntries(PROVIDERS.map(p => [p, {
  calls:      0,
  ok:         0,
  failed:     0,
  last:       null,  // 'ok' | 'rate_limited' | 'error' | null (no calls yet)
  lastError:  null,
  lastAt:     null,
}]));

/** Does this error look like a rate limit / quota exhaustion? */
function isRateLimit(err) {
  if (err?.status === 429 || err?.code === 429) return true;
  const msg = String(err?.message ?? err ?? '');
  return /rate.?limit|quota|too many requests|exceeded|limit reached|maximum.*requests/i.test(msg);
}

export function recordSuccess(provider) {
  const s = status[provider];
  if (!s) return;
  s.calls += 1;
  s.ok    += 1;
  s.last   = 'ok';
  s.lastError = null;
  s.lastAt = new Date().toISOString();
}

export function recordFailure(provider, err) {
  const s = status[provider];
  if (!s) return;
  s.calls  += 1;
  s.failed += 1;
  s.last    = isRateLimit(err) ? 'rate_limited' : 'error';
  s.lastError = String(err?.message ?? err ?? 'Unknown error').slice(0, 200);
  s.lastAt  = new Date().toISOString();
}

/**
 * Await a provider call and record its outcome, rethrowing on failure.
 * Usage: const res = await recordCall('groq', groq.chat.completions.create({...}));
 */
export async function recordCall(provider, promise) {
  try {
    const result = await promise;
    recordSuccess(provider);
    return result;
  } catch (err) {
    recordFailure(provider, err);
    throw err;
  }
}

/** Snapshot for GET /status. */
export function getStatus() {
  return {
    groq: {
      ...status.groq,
      configured: !!process.env.GROQ_API_KEY,
    },
    tavily: {
      ...status.tavily,
      configured: !!process.env.TAVILY_API_KEY,
    },
    newsapi: {
      ...status.newsapi,
      configured: !!process.env.NEWSAPI_KEY,
    },
  };
}
