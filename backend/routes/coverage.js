/**
 * routes/coverage.js — Coverage & Missing-Context Route
 *
 * POST /coverage
 *  Body: { transcript, language?, outlet?, pageTitle?, onScreenText? }
 *   - transcript:   rolling transcript buffer from the extension
 *   - outlet:       hostname of the tab being watched — used to look up the
 *                   current outlet's own bias rating
 *   - pageTitle:    document.title of the watched page (story cross-check signal)
 *   - onScreenText: headline / og:title / image captions scraped from the page
 *
 *  Pipeline:
 *   1. Send transcript + on-screen text to Groq to identify the story + search query
 *   2. Query NewsAPI (/v2/everything) for other outlets covering that story
 *   3. Consensus check: cross-reference the identified story against the page's
 *      on-screen text AND the returned headlines (keywordOverlap) — the note is
 *      only shown in full when independent signals agree it's the same story
 *   4. Join each article's outlet against data/bias-ratings.json
 *   5. Send transcript + other coverage back to Groq to extract concrete facts
 *      present in the other coverage but absent from this segment
 *
 *  Response shape:
 *  {
 *    available:       boolean,          // false when NEWSAPI_KEY is not set
 *    story:           string | null,    // short headline of the identified story
 *    confidence:      "high" | "medium" | "low",
 *    matched_on:      string[],         // which signals agreed (visible evidence)
 *    low_confidence:  boolean,          // true → articles/context withheld
 *    articles:        [{ title, outlet, url, bias }],
 *    coverage:        { total, "left", "lean-left", "center", "lean-right", "right", "unrated" },
 *    missing_context: string[],         // facts other outlets report that this segment omits
 *    outlet_bias:     { name, rating } | null   // rating of the outlet being watched
 *  }
 */

import { Router } from 'express';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { resolveKey, getGroqClient } from '../lib/keys.js';
import { keywordOverlap } from '../lib/textMatch.js';
import { recordCall, recordSuccess, recordFailure } from '../lib/apiStatus.js';
import { spendBudget } from '../lib/rateLimit.js';

const router = Router();

const MODEL     = 'llama-3.3-70b-versatile';
const MAX_CHARS = 4000;

// ─── Bias Ratings Lookup ─────────────────────────────────────────────────────
// Loaded once at startup. Index by both normalised outlet name and domain so we
// can match NewsAPI source names ("Fox News") and article URLs (foxnews.com).

const __dirname   = path.dirname(fileURLToPath(import.meta.url));
const ratingsFile = JSON.parse(readFileSync(path.join(__dirname, '../data/bias-ratings.json'), 'utf8'));

const ratingsByName   = new Map();
const ratingsByDomain = new Map();
for (const outlet of ratingsFile.outlets) {
  ratingsByName.set(normaliseName(outlet.name), outlet);
  ratingsByDomain.set(outlet.domain, outlet);
}

function normaliseName(name) {
  return name.toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]/g, '');
}

/**
 * Look up an outlet's bias rating by NewsAPI source name and/or article URL.
 * @param {string|null} sourceName - e.g. "Fox News"
 * @param {string|null} url        - article URL, matched by hostname
 * @returns {string|null} rating, e.g. "lean-left", or null if unrated
 */
function lookupBias(sourceName, url) {
  if (sourceName) {
    const match = ratingsByName.get(normaliseName(sourceName));
    if (match) return match.rating;
  }
  if (url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      // Try exact domain, then parent domain (e.g. edition.cnn.com → cnn.com)
      if (ratingsByDomain.has(host)) return ratingsByDomain.get(host).rating;
      const parts = host.split('.');
      for (let i = 1; i < parts.length - 1; i++) {
        const parent = parts.slice(i).join('.');
        if (ratingsByDomain.has(parent)) return ratingsByDomain.get(parent).rating;
      }
    } catch { /* malformed URL — skip */ }
  }
  return null;
}

/**
 * Look up the watched outlet (tab hostname) in the ratings table.
 * @param {string|null} hostname
 * @returns {{ name: string, rating: string } | null}
 */
function lookupWatchedOutlet(hostname) {
  if (!hostname) return null;
  const host  = hostname.replace(/^www\./, '');
  const parts = host.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const candidate = parts.slice(i).join('.');
    const match = ratingsByDomain.get(candidate);
    if (match) return { name: match.name, rating: match.rating };
  }
  return null;
}

// ─── Coverage Cache ──────────────────────────────────────────────────────────
// NewsAPI's free tier allows 100 requests/day, so cache coverage results by
// search query for 10 minutes. Live news doesn't change faster than that.

const COVERAGE_CACHE_TTL_MS = 10 * 60 * 1000;
const coverageCache = new Map(); // normalised query → { result, cachedAt }

function getCachedCoverage(query) {
  const key    = query.toLowerCase().trim();
  const cached = coverageCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > COVERAGE_CACHE_TTL_MS) {
    coverageCache.delete(key);
    return null;
  }
  return cached.result;
}

// ─── System Prompts ──────────────────────────────────────────────────────────

const STORY_SYSTEM_PROMPT = `
You are a news analysis assistant. Given a transcript excerpt from a live broadcast,
and possibly on-screen text from the page it is playing on (page title, headline,
image captions), identify the single main news story being discussed.

Rules:
- "story" is a short, neutral headline (under 12 words) describing the story
- Weigh the on-screen text heavily when present — a page title or headline usually
  names the story directly, while transcripts can wander
- "query" is a 3-6 keyword web search query that would find other news articles
  about this same story (names, places, events — no filler words)
- If the content is not an identifiable news story (e.g. small talk, ads, music,
  sports commentary without a news angle), return {"story": null}
- Return ONLY a valid JSON object — no markdown, no explanation

Output format:
{ "story": "<short headline>" | null, "query": "<search keywords>" }
`.trim();

const CONTEXT_SYSTEM_PROMPT = `
You are a media transparency assistant. You will be given:
1. A transcript excerpt from one broadcast covering a news story
2. Headlines and descriptions of how OTHER outlets are covering the same story

Identify up to 3 concrete facts or details present in the other coverage but NOT
mentioned in the transcript excerpt. Think "Community Notes for live TV" — what
context is this segment's audience missing?

A good missing-context item:
- Is a concrete fact: a name, statistic, date, prior event, official response,
  or opposing statement — not an opinion or vague theme
- Actually appears in the other coverage provided
- Is genuinely absent from the transcript excerpt

If the other coverage adds nothing concrete beyond the transcript, return [].
Each fact must be one short standalone sentence. "source" is the number of the
coverage item ([1], [2], ...) the fact came from.
Return ONLY a valid JSON array — no markdown, no explanation.

Output format:
[ { "fact": "<one sentence>", "source": <coverage item number> } ]
`.trim();

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Strip markdown code fences that the model sometimes wraps around JSON. */
function stripFences(raw) {
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

/**
 * Ask Groq to identify the main story + search query in the transcript,
 * optionally cross-referencing on-screen text scraped from the page.
 * @returns {{ story: string, query: string } | null}
 */
async function identifyStory(groq, transcript, onScreenText, replyLanguage) {
  const screenBlock = onScreenText
    ? `\n\nOn-screen text from the page:\n${onScreenText.slice(0, 600)}`
    : '';

  const response = await recordCall('groq', groq.chat.completions.create({
    model:       MODEL,
    max_tokens:  128,
    temperature: 0.1,
    messages: [
      { role: 'system', content: STORY_SYSTEM_PROMPT },
      { role: 'user',   content: `Transcript (language: ${replyLanguage}):\n${transcript}${screenBlock}` },
    ],
  }));

  let parsed;
  try {
    parsed = JSON.parse(stripFences(response.choices[0].message.content));
  } catch {
    console.warn('[/coverage] Could not parse story JSON');
    return null;
  }

  if (!parsed?.story || !parsed?.query || typeof parsed.query !== 'string') return null;
  return { story: String(parsed.story).slice(0, 200), query: parsed.query.slice(0, 100) };
}

/**
 * Query NewsAPI for articles matching the story query.
 * Returns one article per outlet (deduplicated), max 8.
 */
async function searchNewsApi(newsApiKey, query, language) {
  // Throws 429 if today's self-imposed NewsAPI budget is spent —
  // cache hits never reach this point.
  spendBudget('newsapi');

  const params = new URLSearchParams({
    q:        query,
    sortBy:   'relevancy',
    pageSize: '20',
    language: language === 'spanish' ? 'es' : 'en',
  });

  const res = await fetch(`https://newsapi.org/v2/everything?${params}`, {
    headers: { 'X-Api-Key': newsApiKey },
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    const err = new Error(errBody.message || `NewsAPI returned ${res.status}`);
    err.status = res.status;
    recordFailure('newsapi', err);
    throw err;
  }
  recordSuccess('newsapi');

  const data = await res.json();
  const seenOutlets = new Set();
  const articles = [];

  for (const a of data.articles ?? []) {
    const outlet = a.source?.name;
    if (!outlet || !a.title || !a.url) continue;
    const key = normaliseName(outlet);
    if (seenOutlets.has(key)) continue; // one article per outlet
    seenOutlets.add(key);

    articles.push({
      title:       a.title,
      description: (a.description || '').slice(0, 400),
      outlet,
      url:         a.url,
      bias:        lookupBias(outlet, a.url),
    });
    if (articles.length >= 8) break;
  }

  return articles;
}

/**
 * Ask Groq which concrete facts the other coverage contains that the
 * transcript segment does not mention. Each fact carries the outlet and URL
 * of the article it came from, so the note can cite a clickable source.
 * @returns {{ text: string, outlet: string|null, url: string|null }[]}
 */
async function extractMissingContext(groq, transcript, articles, replyLanguage) {
  if (articles.length === 0) return [];

  const otherCoverage = articles
    .map((a, i) => `[${i + 1}] ${a.outlet}: ${a.title}${a.description ? ` — ${a.description}` : ''}`)
    .join('\n');

  const response = await recordCall('groq', groq.chat.completions.create({
    model:       MODEL,
    max_tokens:  300,
    temperature: 0.1,
    messages: [
      { role: 'system', content: CONTEXT_SYSTEM_PROMPT },
      {
        role:    'user',
        content: `Transcript excerpt:\n${transcript}\n\nOther outlets' coverage:\n${otherCoverage}\n\nRespond in ${replyLanguage}.`,
      },
    ],
  }));

  try {
    const parsed = JSON.parse(stripFences(response.choices[0].message.content));
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((item) => {
        // Tolerate the model returning plain strings instead of objects
        const text = typeof item === 'string' ? item : item?.fact;
        if (!text || typeof text !== 'string' || text.trim().length === 0) return null;
        const source = articles[Number(item?.source) - 1] ?? null;
        return {
          text:   text.slice(0, 300),
          outlet: source?.outlet ?? null,
          url:    source?.url ?? null,
        };
      })
      .filter(Boolean)
      .slice(0, 3);
  } catch {
    console.warn('[/coverage] Could not parse missing-context JSON');
    return [];
  }
}

/** Tally articles by bias rating for the coverage distribution summary. */
function tallyCoverage(articles) {
  const tally = { total: articles.length, 'left': 0, 'lean-left': 0, 'center': 0, 'lean-right': 0, 'right': 0, 'unrated': 0 };
  for (const a of articles) {
    tally[a.bias ?? 'unrated'] += 1;
  }
  return tally;
}

// ─── POST /coverage ──────────────────────────────────────────────────────────

// Minimum keyword overlap for two texts to count as "the same story".
const MATCH_THRESHOLD = 0.3;

router.post('/', async (req, res, next) => {
  try {
    const { transcript, language = 'english', outlet = null, pageTitle = null, onScreenText = null } = req.body;

    if (!transcript || typeof transcript !== 'string' || transcript.trim().length === 0) {
      return res.status(400).json({ error: 'Request body must include a non-empty "transcript" string.' });
    }

    const outletBias = lookupWatchedOutlet(outlet);
    const newsApiKey  = resolveKey(req, 'X-Newsapi-Key', 'NEWSAPI_KEY');

    // Coverage analysis is optional — degrade gracefully without a NewsAPI key.
    // The watched outlet's own rating is a local lookup, so it still works.
    if (!newsApiKey) {
      return res.json({ available: false, story: null, articles: [], coverage: null, missing_context: [], outlet_bias: outletBias });
    }

    const groqKey = resolveKey(req, 'X-Groq-Key', 'GROQ_API_KEY');
    if (!groqKey) {
      return res.status(400).json({ error: 'No Groq API key configured. Set one in the extension\'s Settings page or backend/.env.' });
    }
    const groq = getGroqClient(groqKey);

    const safeTranscript = transcript.slice(0, MAX_CHARS);
    const replyLanguage  = language === 'spanish' ? 'Spanish' : 'English';
    const screenSignals  = [pageTitle, onScreenText].filter(s => s && typeof s === 'string').join('\n');

    // ── Step 1: Identify the story (transcript + on-screen text) ──
    const storyInfo = await identifyStory(groq, safeTranscript, screenSignals, replyLanguage);
    if (!storyInfo) {
      console.log('[/coverage] No identifiable news story in transcript');
      return res.json({ available: true, story: null, articles: [], coverage: null, missing_context: [], outlet_bias: outletBias });
    }

    console.log(`[/coverage] Story: "${storyInfo.story}" (query: "${storyInfo.query}")`);

    // ── Step 2: Fetch articles (cache first — NewsAPI quota is small) ──
    const cacheKey = storyInfo.query.toLowerCase().trim();
    let cached     = getCachedCoverage(storyInfo.query);
    const articles = cached?.articles ?? await searchNewsApi(newsApiKey, storyInfo.query, language);
    console.log(`[/coverage] ${articles.length} outlets covering this story${cached ? ' (cached)' : ''}`);

    // ── Step 3: Consensus check — don't trust a single signal ──
    // The LLM's story identification is cross-checked against two independent
    // signals: the on-screen text the extension scraped from the page, and the
    // headlines NewsAPI actually returned. Agreement between signals is what
    // "proves" this is the right story before we show a note about it.
    const storyText   = `${storyInfo.story} ${storyInfo.query}`;
    const screenMatch = screenSignals ? keywordOverlap(storyText, screenSignals) >= MATCH_THRESHOLD : null;
    const newsMatch   = articles.some(a => keywordOverlap(storyText, a.title) >= MATCH_THRESHOLD);

    const matchedOn = ['audio transcript'];
    if (screenMatch) matchedOn.push('on-screen text');
    if (newsMatch)   matchedOn.push("other outlets' headlines");

    // high   = both independent signals agree with the transcript-derived story
    // medium = one agrees (or no on-screen text was available to compare)
    // low    = neither agrees — likely a misidentified story, so don't show
    //          coverage/context for it
    const confidence =
      (screenMatch && newsMatch) ? 'high'
      : (screenMatch || newsMatch) ? 'medium'
      : 'low';
    const lowConfidence = confidence === 'low';

    if (lowConfidence) {
      console.log(`[/coverage] Low-confidence story match — withholding coverage (screenMatch=${screenMatch}, newsMatch=${newsMatch})`);
    }

    // ── Step 4: Missing-context extraction (skipped for low-confidence matches) ──
    let missingContext = [];
    if (!lowConfidence) {
      missingContext = cached?.missing_context
        ?? await extractMissingContext(groq, safeTranscript, articles, replyLanguage);
    }

    // Cache articles + context so repeat requests don't burn NewsAPI/Groq quota.
    // Confidence is NOT cached — it depends on the page the viewer is watching.
    coverageCache.set(cacheKey, {
      result:   { articles, missing_context: lowConfidence ? (cached?.missing_context ?? null) : missingContext },
      cachedAt: cached ? coverageCache.get(cacheKey)?.cachedAt ?? Date.now() : Date.now(),
    });

    return res.json({
      available:       true,
      story:           storyInfo.story,
      confidence,
      matched_on:      matchedOn,
      low_confidence:  lowConfidence,
      // Don't send article descriptions to the extension — titles are enough for the UI
      articles:        lowConfidence ? [] : articles.map(({ title, outlet: o, url, bias }) => ({ title, outlet: o, url, bias })),
      coverage:        lowConfidence ? null : tallyCoverage(articles),
      missing_context: missingContext,
      outlet_bias:     outletBias,
    });

  } catch (err) {
    console.error('[/coverage] Error:', err.message);
    next(err);
  }
});

export default router;
