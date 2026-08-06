/**
 * routes/coverage.js — Coverage & Missing-Context Route
 *
 * POST /coverage
 *  Body: { transcript, language?, outlet?, pageTitle?, onScreenText?, previousGuess? }
 *   - transcript:    rolling transcript buffer from the extension
 *   - outlet:        hostname of the tab being watched — used to look up the
 *                    current outlet's own bias rating
 *   - pageTitle:     document.title of the watched page (story cross-check signal)
 *   - onScreenText:  headline / og:title / image captions scraped from the page
 *   - previousGuess: { story, query } from an earlier attempt this session, when
 *                    this is a retry — the model treats it as a hypothesis to
 *                    confirm/refine/correct, not a fact to defer to
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
 *    query:           string | null,    // search query used — reusable by /discussion
 *    confidence:      "high" | "medium" | "low",
 *    matched_on:      string[],         // which signals agreed (visible evidence)
 *    low_confidence:  boolean,          // true → articles/context withheld
 *    articles:        [{ title, outlet, url, bias }],
 *    coverage:        { total, "left", "lean-left", "center", "lean-right", "right", "unrated" },
 *    missing_context: string[],         // facts other outlets report that this segment omits
 *    outlet_bias:     { name, rating } | null   // rating of the outlet being watched
 *  }
 *
 * POST /coverage/feedback
 *  Body: { query: string, helpful: boolean }
 *  Thumbs up/down on a note's story identification. Thumbs down evicts that
 *  query's cached coverage so a repeat check doesn't reuse the same wrong
 *  result. Not a learning system — nothing is retrained or scored.
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

const MODEL      = 'llama-3.3-70b-versatile';
// Story identification is a lean extraction task (headline + a few keywords),
// not deep reasoning — a smaller/faster model cuts real latency off the
// slowest step of "Check now" without hurting the harder synthesis work
// below, which stays on the bigger model. (If this model name ever 404s,
// swap it for whatever Groq's current small/fast tier is called.)
const FAST_MODEL = 'llama-3.1-8b-instant';
const MAX_CHARS  = 4000;

// Set once if FAST_MODEL ever 404s, so we stop paying for a doomed call on
// every subsequent request. Resets on backend restart, which is the right
// scope — a redeployed/renamed model should get one fresh try.
let fastModelUnavailable = false;

// Same idea for JSON mode: if a model rejects response_format, stop sending it
// rather than burning a failed call on every request to rediscover that.
let jsonModeUnsupported = false;

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
const coverageCache = new Map(); // normalised query → { articles, cachedAt }

// Missing context is cached SEPARATELY from articles, and deliberately not by
// query alone. "What did this segment leave out" is a statement about a
// specific transcript — two segments covering the same story have the same
// articles but different omissions, so sharing one cache entry between them
// would attribute the first segment's gaps to the second.
const contextCache = new Map(); // query + transcript fingerprint → { missingContext, cachedAt }

// Entries are only pruned when they're read, so a long session can accumulate
// keys nothing ever asks for again — and contextCache gains one per distinct
// transcript, which grows faster than one per story. Cheap hard cap: drop the
// oldest entries once a cache is clearly larger than a viewing session needs.
const MAX_CACHE_ENTRIES = 200;

function boundCache(cache) {
  if (cache.size <= MAX_CACHE_ENTRIES) return;
  // Map preserves insertion order, so the first keys are the oldest writes.
  const excess = cache.size - MAX_CACHE_ENTRIES;
  let dropped = 0;
  for (const key of cache.keys()) {
    cache.delete(key);
    if (++dropped >= excess) break;
  }
}

function readCache(cache, key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > COVERAGE_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function coverageKey(query) {
  return query.toLowerCase().trim();
}

/** Cheap non-cryptographic fingerprint — only needs to detect "different transcript". */
function contextKey(query, transcript) {
  let hash = 0;
  for (let i = 0; i < transcript.length; i++) {
    hash = ((hash << 5) - hash + transcript.charCodeAt(i)) | 0;
  }
  return `${coverageKey(query)}::${transcript.length}:${hash}`;
}

function getCachedArticles(query) {
  return readCache(coverageCache, coverageKey(query))?.articles ?? null;
}

function getCachedContext(query, transcript) {
  return readCache(contextCache, contextKey(query, transcript))?.missingContext ?? null;
}

// ─── System Prompts ──────────────────────────────────────────────────────────

const STORY_SYSTEM_PROMPT = `
You are a news analysis assistant. Given a transcript excerpt from a live broadcast,
and possibly on-screen text from the page it is playing on (page title, headline,
image captions), identify the single main news story being discussed.

The transcript may be short, empty, or absent — captions/speech may not have caught up
yet. When that happens, identify the story from the on-screen text alone; a page title
or headline is often a complete, reliable signal by itself. Do NOT return null just
because the transcript is thin or missing — a clear page title or headline is enough
on its own. Only return null when NEITHER the transcript NOR the on-screen text
points to an identifiable story.

Rules:
- "story" is a short, neutral headline (under 12 words) describing the story
- The page title, headline and description are your PRIMARY signal. They are
  authored deliberately to say what the content is about, and they are far more
  reliable than a partial or wandering transcript. Read them first and treat the
  transcript as corroboration
- The description in particular often names the specific event, people, and places
  that make a good search query — mine it for those before falling back to the
  transcript
- If the title/description clearly name a story, use them even if the transcript is
  empty, unclear, or seems to be about something else (the transcript may simply not
  have caught up yet)
- "query" is a 3-6 keyword web search query that would find other news articles
  about this same story (names, places, events — no filler words)
- If there is neither a usable transcript nor usable on-screen text, or neither
  points to an identifiable news story (e.g. small talk, ads, music, sports
  commentary without a news angle), return {"story": null}
- You may be given a previous tentative guess from an earlier pass that had less
  information available. Treat it as a hypothesis to confirm, refine, or correct
  with the fuller information you have now — not as a fact to defer to. If the new
  information points somewhere else, say so; don't just repeat the old guess
- You may also be given stories a viewer has explicitly REJECTED as wrong. Those
  are not hypotheses — they are known-incorrect. Do not return them or a trivial
  rewording of them. Look again at the title, description and transcript for a
  different story. If nothing else is identifiable, return {"story": null} rather
  than repeating a rejected answer
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
 * optionally cross-referencing on-screen text scraped from the page and a
 * previous attempt's tentative guess (when this is a retry with more
 * information than the last pass had).
 * @returns {{ story: string, query: string } | null}
 */
async function identifyStory(groq, transcript, onScreenText, replyLanguage, previousGuess = null, rejectedStories = []) {
  // The content script already curates this down to ~1500 chars of title,
  // headline, and description — the highest-signal, most reliable input we get,
  // and often a complete answer on its own. Truncating it to 600 here threw away
  // more than half of it (usually the description) before the model ever saw it.
  const screenBlock = onScreenText
    ? `\n\nPage title, headline and description:\n${onScreenText.slice(0, 1500)}`
    : '';
  const transcriptBlock = transcript
    ? `Transcript (language: ${replyLanguage}):\n${transcript}`
    : 'Transcript: (none yet — nothing has been transcribed so far)';
  const previousGuessBlock = previousGuess?.story
    ? `\n\nA previous pass, with less information available, tentatively guessed this story was about: "${previousGuess.story}" (search terms: "${previousGuess.query ?? ''}"). Confirm, refine, or correct this using the fuller information above.`
    : '';
  // The viewer looked at these and said they were the wrong story. Unlike
  // previousGuess, they are not hypotheses to refine — they are ruled out.
  const rejectedBlock = rejectedStories.length > 0
    ? `\n\nThe viewer has REJECTED these as the wrong story:\n${rejectedStories.map(s => `- "${s}"`).join('\n')}\nIdentify a different story, or return {"story": null}.`
    : '';

  const callArgs = {
    max_tokens:  128,
    temperature: 0.1,
    messages: [
      { role: 'system', content: STORY_SYSTEM_PROMPT },
      { role: 'user',   content: `${transcriptBlock}${screenBlock}${previousGuessBlock}${rejectedBlock}` },
    ],
    // A parse failure here costs a whole retry cycle (null story → 'no_story'
    // → the extension waits and runs the entire pipeline again), so constrain
    // the decode rather than hoping the model skips the preamble. Dropped
    // automatically below if the model turns out not to support it.
    ...(jsonModeUnsupported ? {} : { response_format: { type: 'json_object' } }),
  };

  /**
   * Story identification is the one call whose failure kills the whole note —
   * everything downstream degrades gracefully, this doesn't. So it gets two
   * narrow, self-latching recoveries instead of one broad retry-everything.
   */
  async function callStoryModel(model, args) {
    try {
      return await recordCall('groq', groq.chat.completions.create({ ...args, model }));
    } catch (err) {
      // Some models reject response_format. Retry once without it rather than
      // failing the note over a formatting nicety, and stop asking after that.
      if (args.response_format && err.status === 400) {
        jsonModeUnsupported = true;
        console.warn(`[/coverage] ${model} rejected response_format (400) — falling back to prompt-only JSON from now on`);
        const { response_format, ...rest } = args;
        return recordCall('groq', groq.chat.completions.create({ ...rest, model }));
      }
      throw err;
    }
  }

  let response;
  const model = fastModelUnavailable ? MODEL : FAST_MODEL;
  try {
    response = await callStoryModel(model, callArgs);
  } catch (err) {
    // Only a genuinely missing model name is worth a second call. Auth errors,
    // rate limits, and timeouts all fail the same way on MODEL, so retrying
    // there just doubles the wait before the real error surfaces — and when
    // Groq is rate-limiting us, it doubles the load that caused it.
    if (fastModelUnavailable || err.status !== 404) throw err;

    // Latch it: without this, a decommissioned FAST_MODEL means every single
    // request pays both models' latency forever instead of just the first.
    fastModelUnavailable = true;
    console.warn(`[/coverage] ${FAST_MODEL} is unavailable (404) — using ${MODEL} for story ID from now on`);
    response = await callStoryModel(MODEL, callArgs);
  }

  let parsed;
  try {
    parsed = JSON.parse(stripFences(response.choices[0].message.content));
  } catch {
    console.warn('[/coverage] Could not parse story JSON');
    return null;
  }

  if (!parsed?.story || !parsed?.query || typeof parsed.query !== 'string') return null;

  // Enforce the rejection server-side. Asking the model not to repeat a rejected
  // story is a request, not a guarantee — and handing the viewer back the exact
  // answer they just marked wrong is the most annoying failure this can have.
  const repeated = rejectedStories.find(s => keywordOverlap(s, String(parsed.story)) >= 0.6);
  if (repeated) {
    console.warn(`[/coverage] Model returned a rejected story ("${parsed.story}" ≈ "${repeated}") — treating as no story`);
    return null;
  }
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
      publishedAt: a.publishedAt || null,
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
  const requestStartedAt = Date.now();
  try {
    const { transcript, language = 'english', outlet = null, pageTitle = null, onScreenText = null, previousGuess = null, rejectedStories = [] } = req.body;
    const safeRejected = Array.isArray(rejectedStories)
      ? rejectedStories.filter(s => typeof s === 'string' && s.trim()).slice(0, 5).map(s => s.slice(0, 200))
      : [];

    const hasTranscript = typeof transcript === 'string' && transcript.trim().length > 0;
    const hasScreenSignals =
      (typeof pageTitle === 'string' && pageTitle.trim().length > 0) ||
      (typeof onScreenText === 'string' && onScreenText.trim().length > 0);

    // A story can be identified from on-screen text alone (a page title is
    // often enough) — only reject the request if there's truly nothing to
    // work with. This is what lets the extension check the moment page
    // signals arrive, without waiting for spoken transcript to accumulate.
    if (!hasTranscript && !hasScreenSignals) {
      return res.status(400).json({ error: 'Request body must include a non-empty "transcript" string, or a "pageTitle"/"onScreenText".' });
    }

    const outletBias = lookupWatchedOutlet(outlet);
    const newsApiKey  = resolveKey(req, 'X-Newsapi-Key', 'NEWSAPI_KEY');

    // Coverage analysis is optional — degrade gracefully without a NewsAPI key.
    // The watched outlet's own rating is a local lookup, so it still works.
    if (!newsApiKey) {
      return res.json({ available: false, story: null, query: null, articles: [], coverage: null, missing_context: [], outlet_bias: outletBias });
    }

    const groqKey = resolveKey(req, 'X-Groq-Key', 'GROQ_API_KEY');
    if (!groqKey) {
      return res.status(400).json({ error: 'No Groq API key configured. Set one in the extension\'s Settings page or backend/.env.' });
    }
    const groq = getGroqClient(groqKey);

    const safeTranscript = hasTranscript ? transcript.slice(0, MAX_CHARS) : '';
    const replyLanguage  = language === 'spanish' ? 'Spanish' : 'English';
    const screenSignals  = [pageTitle, onScreenText].filter(s => s && typeof s === 'string').join('\n');

    // ── Step 1: Identify the story (transcript + on-screen text) ──
    const storyStartedAt = Date.now();
    const storyInfo = await identifyStory(groq, safeTranscript, screenSignals, replyLanguage, previousGuess, safeRejected);
    const storyMs = Date.now() - storyStartedAt;
    if (!storyInfo) {
      console.log('[/coverage] No identifiable news story in transcript');
      return res.json({ available: true, story: null, query: null, articles: [], coverage: null, missing_context: [], outlet_bias: outletBias });
    }

    console.log(`[/coverage] Story: "${storyInfo.story}" (query: "${storyInfo.query}")`);

    // ── Step 2: Fetch articles (cache first — NewsAPI quota is small) ──
    const newsStartedAt  = Date.now();
    const cachedArticles = getCachedArticles(storyInfo.query);
    const articles       = cachedArticles ?? await searchNewsApi(newsApiKey, storyInfo.query, language);
    const newsMs         = Date.now() - newsStartedAt;
    console.log(`[/coverage] ${articles.length} outlets covering this story${cachedArticles ? ' (cached)' : ''}`);

    // ── Step 3: Consensus check — don't trust a single signal ──
    // The LLM's story identification is cross-checked against two independent
    // signals: the on-screen text the extension scraped from the page, and the
    // headlines NewsAPI actually returned. Agreement between signals is what
    // "proves" this is the right story before we show a note about it.
    const storyText   = `${storyInfo.story} ${storyInfo.query}`;
    const screenMatch = screenSignals ? keywordOverlap(storyText, screenSignals) >= MATCH_THRESHOLD : null;
    const newsMatch   = articles.some(a => keywordOverlap(storyText, a.title) >= MATCH_THRESHOLD);

    // Only claim a signal actually contributed — don't list "audio transcript"
    // when the check ran off page signals alone (e.g. the fast path, before
    // any speech has been transcribed).
    const matchedOn = [];
    if (hasTranscript) matchedOn.push('audio transcript');
    if (screenMatch)   matchedOn.push('on-screen text');
    if (newsMatch)     matchedOn.push("other outlets' headlines");

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

    // ── Step 4: Missing-context extraction ──
    // Skipped for low-confidence matches, and skipped when there's no real
    // transcript yet — "what did this segment omit" is meaningless to ask
    // when nothing has been transcribed from it so far (the fast page-signals
    // path can reach this point with an empty transcript).
    const contextStartedAt = Date.now();
    let missingContext = [];
    let contextCached  = false;
    if (!lowConfidence && hasTranscript) {
      const hit = getCachedContext(storyInfo.query, safeTranscript);
      contextCached = hit !== null;
      missingContext = hit ?? await extractMissingContext(groq, safeTranscript, articles, replyLanguage);
      if (!contextCached) {
        contextCache.set(contextKey(storyInfo.query, safeTranscript), {
          missingContext,
          cachedAt: Date.now(),
        });
        boundCache(contextCache);
      }
    }
    const contextMs = Date.now() - contextStartedAt;

    // Cache articles so repeat requests don't burn the small NewsAPI quota.
    // Confidence is NOT cached — it depends on the page the viewer is watching.
    if (!cachedArticles) {
      coverageCache.set(coverageKey(storyInfo.query), { articles, cachedAt: Date.now() });
      boundCache(coverageCache);
    }

    console.log(
      `[/coverage] timing: story=${storyMs}ms news=${newsMs}ms${cachedArticles ? '(cached)' : ''} ` +
      `context=${contextMs}ms${contextCached ? '(cached)' : ''} total=${Date.now() - requestStartedAt}ms`
    );

    // When the story broke, inferred from the coverage itself: the most recent
    // article date. Used to date the note, and passed to /discussion so it looks
    // for reaction from when the story was live rather than from today.
    const storyDate = articles
      .map(a => a.publishedAt)
      .filter(Boolean)
      .sort()
      .pop() ?? null;

    return res.json({
      available:       true,
      story:           storyInfo.story,
      query:           storyInfo.query,
      story_date:      lowConfidence ? null : storyDate,
      confidence,
      matched_on:      matchedOn,
      low_confidence:  lowConfidence,
      // Don't send article descriptions to the extension — titles are enough for the UI
      articles:        lowConfidence ? [] : articles.map(({ title, outlet: o, url, bias, publishedAt }) => ({ title, outlet: o, url, bias, publishedAt })),
      coverage:        lowConfidence ? null : tallyCoverage(articles),
      missing_context: missingContext,
      outlet_bias:     outletBias,
    });

  } catch (err) {
    console.error('[/coverage] Error:', err.message);
    next(err);
  }
});

// ─── POST /coverage/feedback ──────────────────────────────────────────────────
// Viewer feedback on a note's story identification (thumbs up/down). This is
// deliberately NOT a learning system — nothing here retrains or scores
// anything. Thumbs down does one concrete, honest thing: evicts that story's
// cached coverage, so a repeat check for the same story gets a fresh lookup
// instead of silently reusing the same wrong result. Thumbs up is
// acknowledged and logged only.

router.post('/feedback', (req, res) => {
  const { query, helpful } = req.body;

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return res.status(400).json({ error: 'Request body must include a non-empty "query" string.' });
  }

  if (helpful === false) {
    const key     = coverageKey(query);
    const removed = coverageCache.delete(key);
    // Context entries are keyed by query + transcript, so there's no single
    // key to delete — drop every entry for this story.
    let contextRemoved = 0;
    for (const cachedKey of contextCache.keys()) {
      if (cachedKey.startsWith(`${key}::`)) {
        contextCache.delete(cachedKey);
        contextRemoved += 1;
      }
    }
    console.log(`[/coverage/feedback] Thumbs down on "${query}" — coverage cache ${removed ? 'invalidated' : 'was already empty'}, ${contextRemoved} context entries dropped`);
  } else {
    console.log(`[/coverage/feedback] Thumbs up on "${query}"`);
  }

  res.json({ ok: true });
});

export default router;
