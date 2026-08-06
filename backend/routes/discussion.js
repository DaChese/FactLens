/**
 * routes/discussion.js — Public Discussion Route
 *
 * POST /discussion
 *  Body: { query: string, language?: string }
 *   - query: the search query /coverage already identified for this story
 *            (returned as `query` in its response) — reused here so this
 *            route never has to re-identify the story itself.
 *
 *  This is the "what is the public actually saying about this" signal —
 *  distinct from and never blended with the outlet coverage in /coverage.
 *  It's a live web search for reaction/discussion (Tavily), summarized by
 *  an LLM instructed to describe opinions as opinions, never as fact.
 *
 *  On-demand only, triggered by the note's "Check public reaction" button —
 *  never called automatically, so building a note (Check now) never costs
 *  a Tavily credit; only this and /factcheck do.
 *
 *  Response shape:
 *  {
 *    available: boolean,               // false when no Tavily key configured
 *    summary:   string | null,         // null if results were too thin to summarize
 *    sources:   [{ title, url }]
 *  }
 */

import { Router } from 'express';
import { resolveKey, getTavilyClient, getGroqClient } from '../lib/keys.js';
import { recordCall } from '../lib/apiStatus.js';
import { spendBudget } from '../lib/rateLimit.js';
import { significantTokens } from '../lib/textMatch.js';

const router = Router();

const MODEL = 'llama-3.3-70b-versatile';

// ── Relevance gate ──
// A domain-restricted search still returns threads that merely mention a shared
// name or place, so results must independently look like they're about the same
// story. But the first tuning of this was far too strict — a real run scored
// 0/12 on "MTA subway upgrade delays New York City", rejecting threads that were
// plainly on-topic. Two causes, both fixed below:
//
//  1. No stemming. "Why is the L train always DELAYED" scored 0.00 against a
//     story about "DELAYS". relevanceScore() now stems, so plural/tense
//     variants match.
//  2. Three gates stacked (keyword, Tavily score, age) with no logging of which
//     one fired, so a total wipeout was undiagnosable.
//
// A broader second pass now runs when the strict pass comes up empty, so a
// too-tight gate degrades into a wider search rather than into silence.
const MIN_RELEVANCE       = 0.2;
const MIN_RELEVANCE_BROAD = 0.12; // second pass — cast wider before giving up
const MIN_TAVILY_SCORE    = 0.1;  // Tavily's score isn't calibrated for this; only drop the true tail
const MAX_AGE_DAYS        = 120;  // measured from the STORY's date, not today (see ageRelativeToStory)
const MIN_RESULTS         = 2;    // below this, broaden; below it again, say so

// Quotes are checked against their claimed source before being returned, so a
// generous ask here costs nothing — unverifiable ones are dropped.
const MAX_QUOTES       = 6;

/**
 * Crude suffix stripping so "delays", "delayed" and "delay" collapse together.
 * Not linguistically correct and not meant to be — it only has to stop obvious
 * plural/tense variants from scoring zero against each other.
 */
function stem(token) {
  return token
    .replace(/(ies)$/, 'y')
    .replace(/(sses|shes|ches|xes)$/, '')
    .replace(/(ing|ed|es|s)$/, '')
    || token;
}

/**
 * How much a search result looks like it's about this story, 0–1.
 *
 * Deliberately a local, more forgiving variant of lib/textMatch.js rather than a
 * change to it: /coverage's confidence thresholds are tuned against that exact
 * function, and loosening it there would quietly change which notes get flagged
 * low-confidence. Differences here: stemmed tokens, and scoring against the
 * story's own tokens (not the smaller of the two sets), so a long forum thread
 * isn't penalised for containing lots of other words.
 */
function relevanceScore(storyText, candidateText) {
  const storyTokens = [...new Set(significantTokens(storyText).map(stem))];
  const candidate   = new Set(significantTokens(candidateText).map(stem));
  if (storyTokens.length === 0 || candidate.size === 0) return 0;

  const shared = storyTokens.filter(t => candidate.has(t)).length;
  // One shared word is coincidence ("Florida"); two is a signal.
  if (shared < 2 && storyTokens.length >= 2) return 0;
  return shared / storyTokens.length;
}

/**
 * How far a result sits from the story itself, in days.
 *
 * Measured against the story's own date rather than today, because a story that
 * broke three weeks ago has three-week-old discussion — and judging that against
 * "now" would throw away exactly the reaction we want. Null when either date is
 * missing; undated results are common on social content and must not be treated
 * as stale.
 */
function ageRelativeToStory(publishedDate, storyDate) {
  if (!publishedDate) return null;
  const parsed = Date.parse(publishedDate);
  if (Number.isNaN(parsed)) return null;
  const anchor = storyDate ? Date.parse(storyDate) : Date.now();
  const base   = Number.isNaN(anchor) ? Date.now() : anchor;
  return Math.abs(base - parsed) / (1000 * 60 * 60 * 24);
}

/**
 * Where "what are people saying" actually lives.
 *
 * A caveat worth knowing rather than discovering on stage: these are NOT
 * equally reachable. Reddit, Hacker News and Quora are fully crawlable and
 * supply most real results. YouTube exposes only some comment text. X/Twitter
 * blocks crawlers on most posts and Facebook is almost entirely login-walled —
 * both are listed so their public pages surface when they are reachable, but
 * neither can be relied on, and an empty result from them is normal.
 *
 * Ordered roughly by how much usable discussion each actually returns.
 */
const SOCIAL_DOMAINS = [
  'reddit.com',
  'news.ycombinator.com',
  'quora.com',
  'bsky.app',
  'threads.net',
  'youtube.com',
  'x.com',
  'twitter.com',
  'facebook.com',
];

/** Human-readable platform name for a result URL, for display in the note. */
function platformName(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    if (host.endsWith('reddit.com'))          return 'Reddit';
    if (host.endsWith('ycombinator.com'))     return 'Hacker News';
    if (host.endsWith('quora.com'))           return 'Quora';
    if (host.endsWith('bsky.app'))            return 'Bluesky';
    if (host.endsWith('threads.net'))         return 'Threads';
    if (host.endsWith('youtube.com'))         return 'YouTube';
    if (host.endsWith('x.com') || host.endsWith('twitter.com')) return 'X';
    if (host.endsWith('facebook.com'))        return 'Facebook';
    return host;
  } catch {
    return 'source';
  }
}

const DISCUSSION_SYSTEM_PROMPT = `
You are a neutral observer summarizing public reaction to a news story.

You may be given two kinds of evidence:
1. COMMENTS posted directly on the video or article the viewer is watching,
   labelled [C1], [C2]... These are reaction to this exact content, so they are
   your best and most relevant evidence — lead with them when they are present,
   and say plainly that they are comments on this video/article.
2. DISCUSSION FOUND ELSEWHERE online — forums, comment threads, social posts —
   each prefixed with its platform, e.g. "(Reddit)" or "(Hacker News)".

Do not blend the two into one undifferentiated "people are saying". Where a
reaction came from is part of what it means.

Rules:
- Describe opinions as opinions: "some commenters argue...", "a common reaction is...",
  "discussion is divided over..." — never state an opinion as an established fact
- Name the platform when it is informative ("on Reddit, the common reaction is...").
  Different platforms are different audiences, and flattening them into "people
  online" hides that. Do not imply a platform represents the public at large
- These results are whatever was publicly reachable, not a representative sample.
  Never describe the tenor as what "the public" or "everyone" thinks
- Identify the general tenor and up to 2-3 major recurring viewpoints or reactions
- Do not adopt, endorse, or lean toward any viewpoint yourself
- Each result carries a date (or "date unknown"). Do not present older discussion as
  current reaction — if the material is not recent, say when it is from, and never
  imply an undated thread is a live reaction
- If any result is not actually about this story, ignore it entirely rather than
  stretching the summary to cover it
- If the results are too thin, off-topic, or don't reflect real discussion of this
  story, return {"summary": null, "quotes": []} rather than guessing
- Summary is one to three sentences. Return ONLY a valid JSON object — no markdown

QUOTES — the most important part of your output:
- Pull 3 to 6 SHORT verbatim quotes showing what people are actually saying
- Copy the text EXACTLY as it appears in the evidence. Do not fix spelling, do not
  tidy grammar, do not paraphrase, do not merge two comments into one. Every quote
  is checked against the source text and silently discarded if it does not match
- Keep each quote under 200 characters. Trim to the most telling sentence rather
  than quoting a whole paragraph
- Set "source" to the exact label of the item you took it from — "C1", "C3", "4"
- Choose quotes that DISAGREE with each other where the discussion is divided.
  A set of quotes that all say the same thing misrepresents a split reaction
- Spread quotes across different items and platforms rather than mining one thread
- Skip anything abusive, slurring, or targeting a private individual
- If nothing is genuinely quotable, return an empty quotes array — never invent one

Output format:
{
  "summary": "<1-3 sentences>" | null,
  "quotes": [ { "text": "<verbatim quote>", "source": "<C1 or 4>" } ]
}
`.trim();

function stripFences(raw) {
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

/** Collapse whitespace, punctuation and case so verbatim-but-reformatted text still matches. */
function normalizeForMatch(text) {
  return String(text)
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^a-z0-9'" ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Keep only quotes that genuinely appear in the evidence.
 *
 * The prompt forbids inventing quotes, but a prompt is a request, not a
 * guarantee — and a fabricated quote attributed to a real person on a real
 * platform is the single most damaging thing this feature could emit. So every
 * quote is checked against the text it claims to come from, and silently
 * dropped if it isn't there.
 *
 * @param {Array} rawQuotes      what the model returned
 * @param {Map<string,object>}   evidence  label ("C1" / "4") → { text, url, platform, publishedDate }
 */
function verifyQuotes(rawQuotes, evidence) {
  if (!Array.isArray(rawQuotes)) return [];

  const verified = [];
  const seen = new Set();

  for (const item of rawQuotes) {
    const text  = typeof item?.text === 'string' ? item.text.trim() : '';
    const label = String(item?.source ?? '').trim().toUpperCase();
    if (!text || text.length < 15) continue;

    const source = evidence.get(label);
    if (!source) {
      console.warn(`[/discussion] Dropped quote citing unknown source "${label}"`);
      continue;
    }

    const needle = normalizeForMatch(text);
    const hay    = normalizeForMatch(source.text);
    // Accept an exact verbatim match, or a long leading fragment — models often
    // trim a trailing clause, which is honest quoting, not fabrication.
    const prefix = needle.slice(0, Math.max(40, Math.floor(needle.length * 0.8)));
    if (!hay.includes(needle) && !hay.includes(prefix)) {
      console.warn(`[/discussion] Dropped unverifiable quote from ${label}: "${text.slice(0, 60)}"`);
      continue;
    }

    const dedupeKey = needle.slice(0, 80);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    verified.push({
      text:          text.slice(0, 300),
      platform:      source.platform,
      url:           source.url ?? null,
      publishedDate: source.publishedDate ?? null,
    });
  }

  return verified.slice(0, MAX_QUOTES);
}

// ─── POST /discussion ────────────────────────────────────────────────────────

router.post('/', async (req, res, next) => {
  try {
    const { query, story = null, storyDate = null, language = 'english', comments = [] } = req.body;

    // Comments scraped from the page the viewer is actually watching. These need
    // no relevance gate — they're attached to this exact video or article, so
    // unlike a web search there is no story-matching step that can go wrong.
    const pageComments = Array.isArray(comments)
      ? comments
          .filter(c => typeof c === 'string' && c.trim().length > 15)
          .slice(0, 25)
          .map(c => c.replace(/\s+/g, ' ').trim().slice(0, 400))
      : [];

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({ error: 'Request body must include a non-empty "query" string (from /coverage\'s response).' });
    }

    const groqKey = resolveKey(req, 'X-Groq-Key', 'GROQ_API_KEY');
    if (!groqKey) {
      return res.status(400).json({ error: 'No Groq API key configured. Set one in the extension\'s Settings page or backend/.env.' });
    }

    const safeQuery     = query.slice(0, 100);
    const groq          = getGroqClient(groqKey);
    const replyLanguage = language === 'spanish' ? 'Spanish' : 'English';

    // Relevance gate for SEARCHED results. `story` is the note's headline when
    // the caller has it — the bare query is only 3-6 keywords, so the headline
    // makes the overlap check meaningfully stronger. Falls back to query-only.
    const storyText = typeof story === 'string' && story.trim()
      ? `${safeQuery} ${story.slice(0, 200)}`
      : safeQuery;

    // Always search when a key is available, even when the page already supplied
    // plenty of comments. An earlier version skipped the search in that case to
    // save a Tavily credit, but breadth is the point here: comments tell you what
    // this video's audience thinks, and Reddit/X tell you how the story is landing
    // beyond it. One credit is a fair price for both.
    const tavilyKey = resolveKey(req, 'X-Tavily-Key', 'TAVILY_API_KEY');

    let results = [];
    let searched = false;
    let searchFailed = false;

    if (tavilyKey) {
      const tavilyClient = getTavilyClient(tavilyKey);

      /**
       * One search + filter pass. Counts why each result was dropped, because a
       * bare "0/12 relevant" tells you nothing about which of three stacked
       * gates actually fired — which is exactly how the first tuning of this
       * shipped undiagnosable.
       */
      const runPass = async (label, { minRelevance, restrictDomains, maxAgeDays, searchQuery }) => {
        spendBudget('tavily'); // throws 429 if the monthly budget is spent
        const searchResult = await recordCall('tavily', tavilyClient.search(searchQuery, {
          maxResults:        12, // domain + relevance filtering thins this a lot; ask wide
          searchDepth:       'basic', // 1 credit
          ...(restrictDomains ? { includeDomains: SOCIAL_DOMAINS } : {}),
          // Quotes need the actual post text, not just Tavily's snippet.
          includeRawContent: true,
          // Anchor the window on the story itself when we know its date, so an
          // older story still finds the discussion from when it broke.
          ...(storyDate ? { timeRange: 'year' } : {}),
          timeout:           10, // seconds; the SDK default is 60, past the extension's 30s abort
        }));

        const raw = (searchResult.results ?? []).filter(r => r.title && r.url);
        const dropped = { relevance: 0, score: 0, age: 0 };

        const kept = raw
          .map(r => ({
            ...r,
            age:       ageRelativeToStory(r.publishedDate, storyDate),
            relevance: relevanceScore(storyText, `${r.title} ${r.content ?? ''}`),
          }))
          .filter((r) => {
            if (r.relevance < minRelevance) { dropped.relevance++; return false; }
            if (typeof r.score === 'number' && r.score < MIN_TAVILY_SCORE) { dropped.score++; return false; }
            // Dates are a SOFT filter: undated is normal on social content, so
            // only drop results we can positively date as far from the story.
            if (r.age !== null && r.age > maxAgeDays) { dropped.age++; return false; }
            return true;
          })
          .sort((a, b) => (a.age ?? Number.MAX_SAFE_INTEGER) - (b.age ?? Number.MAX_SAFE_INTEGER));

        console.log(
          `[/discussion] ${label}: kept ${kept.length}/${raw.length} for "${safeQuery}" ` +
          `(dropped — off-topic: ${dropped.relevance}, low score: ${dropped.score}, wrong date: ${dropped.age})`
        );
        return kept;
      };

      // The search is best-effort. Page comments need no search at all, so a bad
      // Tavily key, a rate limit, or a timeout must not sink a request we can
      // already answer — it should just narrow the evidence. With no comments to
      // fall back on there is nothing to salvage, so the error propagates.
      try {
        // Pass 1: social platforms, normal relevance bar.
        results = await runPass('strict', {
          minRelevance:    MIN_RELEVANCE,
          restrictDomains: true,
          maxAgeDays:      MAX_AGE_DAYS,
          searchQuery:     `${safeQuery} reaction discussion opinion`,
        });
        searched = true;

        // Pass 2: the strict gate found nothing usable. Rather than reporting
        // silence — which is what a too-tight threshold looks like from outside —
        // search the whole web with a lower bar and no date ceiling. Costs a
        // second credit, and only when the first pass actually came up short.
        if (results.length < MIN_RESULTS) {
          console.log('[/discussion] Strict pass came up short — retrying broader');
          results = await runPass('broad', {
            minRelevance:    MIN_RELEVANCE_BROAD,
            restrictDomains: false,
            maxAgeDays:      Number.MAX_SAFE_INTEGER,
            searchQuery:     `what people are saying about ${safeQuery}`,
          });
        }
      } catch (err) {
        if (pageComments.length === 0) throw err;
        console.warn(`[/discussion] Search failed (${err.message}) — continuing with ${pageComments.length} page comments`);
        results = [];
        searchFailed = true;
      }
    }

    // Nothing usable from either source.
    if (pageComments.length === 0 && results.length < MIN_RESULTS) {
      if (!tavilyKey && !searched) {
        console.log('[/discussion] No page comments and no Tavily key — cannot check public reaction');
        return res.json({ available: false, summary: null, sources: [] });
      }
      console.log(`[/discussion] Nothing relevant for "${safeQuery}" — not summarizing`);
      return res.json({ available: true, summary: null, sources: [] });
    }

    const platformsFound = [...new Set(results.map(r => platformName(r.url)))];
    if (pageComments.length > 0) platformsFound.unshift('Comments on this page');
    const searchNote = searchFailed ? ' (search failed)' : searched ? '' : ' (no search key)';
    console.log(`[/discussion] ${pageComments.length} page comments + ${results.length} searched results${searchNote}`);

    // Naming the platform lets the summary say where a reaction came from —
    // discussion on Hacker News and discussion on Facebook are not the same
    // audience, and flattening them into "people online" hides that.
    // More text per result than the summary alone needed — quotes have to be
    // copied verbatim out of this, and a 300-char snippet rarely contains a
    // whole quotable opinion.
    const resultBlock = results
      .map((r, i) => {
        const when = r.publishedDate || 'date unknown';
        const body = (r.rawContent || r.content || '').replace(/\s+/g, ' ').slice(0, 900);
        return `[${i + 1}] (${platformName(r.url)}, ${when}) ${r.title}${body ? ` — ${body}` : ''}`;
      })
      .join('\n');

    // Comments go in their own labelled block. They're reaction to the exact
    // video/article being watched, which is a stronger claim than anything the
    // search can offer, and the summary should be able to say so.
    const commentBlock = pageComments.length > 0
      ? `Comments posted directly on the video/article being watched (${pageComments.length}):\n`
        + pageComments.map((c, i) => `[C${i + 1}] ${c}`).join('\n')
      : '';

    const evidenceBlock = [
      commentBlock,
      resultBlock ? `Discussion found elsewhere online:\n${resultBlock}` : '',
    ].filter(Boolean).join('\n\n');

    // Label → the exact text the model was shown, so a returned quote can be
    // checked against its claimed origin rather than taken on trust.
    const evidence = new Map();
    pageComments.forEach((c, i) => {
      evidence.set(`C${i + 1}`, { text: c, url: null, platform: 'Comment on this page', publishedDate: null });
    });
    results.forEach((r, i) => {
      evidence.set(String(i + 1), {
        text:          `${r.title} ${r.rawContent || r.content || ''}`,
        url:           r.url,
        platform:      platformName(r.url),
        publishedDate: r.publishedDate || null,
      });
    });

    const storyLine = storyText === safeQuery ? safeQuery : `${story} (search terms: ${safeQuery})`;

    const response = await recordCall('groq', groq.chat.completions.create({
      model:       MODEL,
      // Quotes cost tokens — 200 was sized for a bare summary and would truncate
      // the JSON mid-array, losing every quote to a parse failure.
      max_tokens:  900,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: DISCUSSION_SYSTEM_PROMPT },
        { role: 'user',   content: `Story: "${storyLine}"\nRespond in ${replyLanguage}.\n\n${evidenceBlock}` },
      ],
    }));

    let summary = null;
    let quotes  = [];
    try {
      const parsed = JSON.parse(stripFences(response.choices[0].message.content));
      summary = typeof parsed?.summary === 'string' ? parsed.summary.slice(0, 400) : null;
      quotes  = verifyQuotes(parsed?.quotes, evidence);
    } catch {
      console.warn('[/discussion] Could not parse summary JSON');
    }

    // Quotes alone are a legitimate result — seeing what people actually said is
    // the point, and a thin tenor summary shouldn't suppress them.
    const hasContent = Boolean(summary) || quotes.length > 0;
    const quotedPlatforms = [...new Set(quotes.map(q => q.platform))];
    console.log(`[/discussion] "${safeQuery}" → ${summary ? 'summarized' : 'no summary'}, ${quotes.length} verified quotes from: ${quotedPlatforms.join(', ') || 'none'}`);

    return res.json({
      available: true,
      summary,
      quotes,
      sources: hasContent
        ? results.slice(0, 8).map(r => ({
            title:         r.title,
            url:           r.url,
            platform:      platformName(r.url),
            publishedDate: r.publishedDate || null,
          }))
        : [],
      platforms: hasContent ? platformsFound : [],
      commentCount: hasContent ? pageComments.length : 0,
    });

  } catch (err) {
    console.error('[/discussion] Error:', err.message);
    next(err);
  }
});

export default router;
