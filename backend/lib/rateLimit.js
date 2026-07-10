/**
 * lib/rateLimit.js — Request throttling and provider budget guards
 *
 * Two layers of protection so a bug, a stuck button, or an enthusiastic
 * demo can't silently burn through a month of API credits:
 *
 *  1. Route throttle (middleware): caps how many requests a route accepts
 *     per minute, regardless of what they'd cost.
 *  2. Provider budgets: hard caps on the scarce third-party quotas —
 *     NewsAPI (100/day free) and Tavily (~1,000 credits/month free) —
 *     set slightly below the real limits so we stop OURSELVES before the
 *     provider starts rejecting us mid-demo.
 *
 * Limits are configurable via .env; state is in-memory and resets on
 * backend restart (fine for a single-user prototype — the real provider
 * quota is the source of truth, this is a local safety margin).
 */

// ─── Provider Budgets ────────────────────────────────────────────────────────

const BUDGETS = {
  // NewsAPI free developer tier: 100 requests/day. Stop at 80 by default.
  newsapi: {
    limit:  Number(process.env.NEWSAPI_DAILY_LIMIT) || 80,
    window: 'day',
  },
  // Tavily free tier: ~1,000 credits/month (basic search = 1 credit).
  // Stop at 900 by default.
  tavily: {
    limit:  Number(process.env.TAVILY_MONTHLY_LIMIT) || 900,
    window: 'month',
  },
};

const budgetState = Object.fromEntries(
  Object.keys(BUDGETS).map(p => [p, { used: 0, windowKey: null }])
);

function currentWindowKey(window) {
  const now = new Date();
  if (window === 'day')   return now.toISOString().slice(0, 10);  // YYYY-MM-DD (UTC)
  if (window === 'month') return now.toISOString().slice(0, 7);   // YYYY-MM (UTC)
  return String(Math.floor(Date.now() / 60000));                  // per-minute
}

function windowResetHint(window) {
  if (window === 'day')   return 'resets at midnight UTC';
  if (window === 'month') return 'resets on the 1st of next month (UTC)';
  return 'resets within a minute';
}

/**
 * Spend one unit of a provider's budget, or throw a 429 error if the
 * budget for the current window is exhausted. Call this immediately
 * before each real (non-cached) call to the provider.
 * @param {string} provider - 'newsapi' | 'tavily'
 */
export function spendBudget(provider) {
  const config = BUDGETS[provider];
  const state  = budgetState[provider];
  if (!config || !state) return;

  const key = currentWindowKey(config.window);
  if (state.windowKey !== key) {
    state.windowKey = key;
    state.used = 0;
  }

  if (state.used >= config.limit) {
    const err = new Error(
      `${provider} budget reached (${config.limit} calls this ${config.window}, ${windowResetHint(config.window)}). ` +
      `Raise the limit in backend/.env if you're sure.`
    );
    err.status = 429;
    err.budget = true;
    throw err;
  }

  state.used += 1;
}

/** Budget snapshot for GET /status. */
export function getBudgets() {
  const snapshot = {};
  for (const [provider, config] of Object.entries(BUDGETS)) {
    const state = budgetState[provider];
    const key   = currentWindowKey(config.window);
    snapshot[provider] = {
      used:   state.windowKey === key ? state.used : 0,
      limit:  config.limit,
      window: config.window,
    };
  }
  return snapshot;
}

// ─── Route Throttle Middleware ───────────────────────────────────────────────

/**
 * Express middleware: allow at most `maxPerMinute` requests to this route
 * per rolling minute. This is a loop-breaker, not a security control —
 * the extension is the only client.
 * @param {number} maxPerMinute
 */
export function requestThrottle(maxPerMinute) {
  const timestamps = [];

  return (req, res, next) => {
    const now = Date.now();
    while (timestamps.length > 0 && now - timestamps[0] > 60000) {
      timestamps.shift();
    }

    if (timestamps.length >= maxPerMinute) {
      return res.status(429).json({
        error: `Too many requests — this route allows ${maxPerMinute}/minute. Wait a moment and try again.`,
      });
    }

    timestamps.push(now);
    next();
  };
}
