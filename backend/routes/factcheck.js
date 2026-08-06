/**
 * routes/factcheck.js — Fact-Check Route
 *
 * POST /factcheck
 *  Body: { transcript: string }
 *
 *  Pipeline:
 *   1. Send transcript to Groq to extract specific verifiable factual claims
 *   2. For each claim, run a Tavily advanced search for evidence
 *   3. Send claim + full search context back to Groq for a grounded verdict
 *   4. Return structured JSON array
 *
 *  Response shape:
 *  [
 *    {
 *      claim:      string,
 *      verdict:    "True" | "False" | "Unverified",
 *      confidence: number (0.0 – 1.0),
 *      sources:    string[]  // URLs from Tavily — never hallucinated
 *    }
 *  ]
 */

import { Router } from 'express';
import { resolveKey, getGroqClient, getTavilyClient } from '../lib/keys.js';
import { recordCall } from '../lib/apiStatus.js';
import { spendBudget } from '../lib/rateLimit.js';

const router = Router();

const MODEL      = 'llama-3.3-70b-versatile';
const MAX_CHARS  = 4000;
// 2 claims per check, basic search depth — this endpoint only runs when the
// viewer explicitly asks ("Check statements"), and Tavily credits are the
// scarcest resource in the stack (~1,000/month free).
const MAX_CLAIMS = 2;

// ─── Claim Cache ─────────────────────────────────────────────────────────────
// In-memory cache keyed by normalised claim text.
// Prevents re-running Tavily + Groq for claims already verified in this session.
// TTL of 1 hour — claims don't change that fast.

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const claimCache   = new Map(); // normalised claim → { result, cachedAt }

/**
 * Normalise a claim string for cache key comparison.
 * Lowercases, trims, and collapses whitespace so minor phrasing differences
 * don't cause cache misses.
 * @param {string} claim
 * @returns {string}
 */
function normaliseClaim(claim) {
  return claim.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Get a cached result for a claim, or null if not cached / expired.
 * @param {string} claim
 * @returns {object|null}
 */
function getCached(claim) {
  const key    = normaliseClaim(claim);
  const cached = claimCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.cachedAt > CACHE_TTL_MS) {
    claimCache.delete(key);
    return null;
  }
  return cached.result;
}

/**
 * Store a result in the cache.
 * @param {string} claim
 * @param {object} result
 */
function setCached(claim, result) {
  claimCache.set(normaliseClaim(claim), { result, cachedAt: Date.now() });
}

// ─── System Prompts ──────────────────────────────────────────────────────────

const EXTRACT_SYSTEM_PROMPT = `
You are a strict fact-checking assistant. Given a transcript excerpt, extract up to 2
specific, verifiable factual claims that can be confirmed or denied with a web search.
Pick only the most significant, checkable claims.

A good claim:
- States a concrete, checkable fact (a number, date, name, event, statistic, or law)
- Is specific enough to search for (not vague or subjective)
- Is NOT an opinion, prediction, joke, or rhetorical question

If you return 2 claims, they must be about DIFFERENT facts — never two phrasings or
angles of the same underlying fact or event. For example, "a public figure died" and
"that same death occurred on a specific date at a specific place" are restating one
fact, not two; pick the single clearest phrasing of it instead of both. Two claims are
only both worth including if a reader could disagree with one while agreeing with the
other.

Bad examples (do NOT include):
- "He doesn't care about legality" (opinion)
- "Things are getting worse" (vague)
- "Are we friends with Bama Fitz?" (rhetorical)

Good examples:
- "The War Powers Act requires congressional approval after 60 days"
- "Marco Rubio is 5 feet 8 inches tall"
- "NASA was founded in 1958"

If there are no good verifiable claims in the transcript, return an empty array.
Return ONLY a valid JSON array of claim strings — no markdown, no explanation.
`.trim();

const VERDICT_SYSTEM_PROMPT = `
You are a neutral, rigorous fact-checker. You will be given:
1. A factual claim extracted from a transcript
2. Web search results relevant to that claim

Your job is to assess whether the claim is True, False, or Unverified based ONLY on
the provided search results. Do not use your training data to make the verdict —
only use what the search results say.

Verdict definitions:
- "True"       — The search results clearly confirm the claim
- "False"      — The search results clearly contradict the claim
- "Unverified" — The search results are inconclusive, irrelevant, or contradictory

Each search result carries a "Published:" date (or "date unknown"). Use it:
- Prefer recent sources. For a claim about a current event, an old article may
  describe a superseded state of affairs rather than contradicting the claim
- If the only supporting evidence is clearly old relative to the claim, say so in
  the reasoning and lower the confidence rather than treating it as settled
- Never assume a "date unknown" source is current

Confidence guidelines:
- 0.9–1.0: Multiple recent sources clearly agree
- 0.7–0.9: One strong source confirms/denies
- 0.5–0.7: Partial or indirect evidence, or the evidence is dated
- 0.0–0.5: Weak or ambiguous evidence → use "Unverified"

Return ONLY a valid JSON object — no markdown, no explanation outside the JSON.

Output format:
{
  "verdict":    "True" | "False" | "Unverified",
  "confidence": <0.0 to 1.0>,
  "reasoning":  "<one sentence explaining the verdict based on the search results>"
}
`.trim();

/**
 * Resolve one claim to a verdict. Never rejects — every failure path returns
 * an Unverified result instead, so a single bad claim can't collapse the
 * Promise.all and lose the verdicts that did succeed.
 *
 * The Tavily budget for this claim has already been spent by the caller (or
 * found to be exhausted), so this function never touches spendBudget itself.
 *
 * @param {{kind: 'cached'|'run'|'budget', claim: string, cached?: object, err?: Error}} job
 * @returns {Promise<object>} a verdict result
 */
async function runClaim(job, { groq, tavilyClient, replyLanguage }) {
  const { claim } = job;

  if (job.kind === 'cached') return job.cached;

  if (job.kind === 'budget') {
    console.warn(`[/factcheck] Budget exhausted before "${claim.slice(0, 50)}"`);
    return { claim, verdict: 'Unverified', confidence: 0.0, reasoning: job.err.message, sources: [] };
  }

  try {
    const searchResult = await recordCall('tavily', tavilyClient.search(claim, {
      maxResults:    5,
      searchDepth:   'basic', // 1 Tavily credit instead of 2
      includeAnswer: true,
      timeout:       10,      // seconds; the SDK default is 60, past the extension's 30s abort
    }));

    const tavilyAnswer = searchResult.answer
      ? `Tavily summary: ${searchResult.answer}\n\n`
      : '';

    // Tavily returns a publishedDate on every result and we used to discard it.
    // A verdict backed by a three-year-old article is weaker than one backed by
    // yesterday's, so the date goes both to the model (below) and to the UI.
    const sources = (searchResult.results ?? []).map(r => ({
      url:           r.url,
      title:         r.title,
      publishedDate: r.publishedDate || null,
    }));

    const searchContext = (searchResult.results ?? [])
      .map((r, i) =>
        `[${i + 1}] ${r.title}\nURL: ${r.url}\nPublished: ${r.publishedDate || 'date unknown'}\n${r.content?.slice(0, 600) ?? ''}`
      )
      .join('\n\n');

    // If Tavily returned no results, mark as Unverified without paying for a verdict call
    if (sources.length === 0) {
      console.warn(`[/factcheck] No search results for: "${claim.slice(0, 50)}"`);
      return { claim, verdict: 'Unverified', confidence: 0.0, reasoning: 'No search results found.', sources: [] };
    }

    const verdictRes = await recordCall('groq', groq.chat.completions.create({
      model:       MODEL,
      max_tokens:  200,
      temperature: 0.1,
      // Constrained decoding so a stray prose preamble can't discard a
      // completed, paid-for call at the JSON.parse below.
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: VERDICT_SYSTEM_PROMPT },
        {
          role:    'user',
          content: `Claim: "${claim}"\nRespond in ${replyLanguage}.\n\n${tavilyAnswer}Search results:\n${searchContext}`,
        },
      ],
    }));

    const cleanedVerdict = verdictRes.choices[0].message.content
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    const parsed = JSON.parse(cleanedVerdict);

    const verdict = ['True', 'False', 'Unverified'].includes(parsed.verdict)
      ? parsed.verdict
      : 'Unverified';
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));

    console.log(`[/factcheck] "${claim.slice(0, 50)}" → ${verdict} (${(confidence * 100).toFixed(0)}%)`);

    const result = {
      claim,
      verdict,
      confidence,
      reasoning: String(parsed.reasoning || '').slice(0, 300),
      sources,
    };

    setCached(claim, result); // repeat claims are instant
    return result;

  } catch (err) {
    console.warn(`[/factcheck] Failed on claim "${claim.slice(0, 50)}":`, err.message);
    return {
      claim,
      verdict:    'Unverified',
      confidence: 0.0,
      reasoning:  'Could not retrieve search results.',
      sources:    [],
    };
  }
}

// ─── POST /factcheck ─────────────────────────────────────────────────────────

router.post('/', async (req, res, next) => {
  try {
    const groqKey   = resolveKey(req, 'X-Groq-Key', 'GROQ_API_KEY');
    const tavilyKey = resolveKey(req, 'X-Tavily-Key', 'TAVILY_API_KEY');
    if (!groqKey)   return res.status(400).json({ error: 'No Groq API key configured. Set one in the extension\'s Settings page or backend/.env.' });
    if (!tavilyKey) return res.status(400).json({ error: 'No Tavily API key configured. Set one in the extension\'s Settings page or backend/.env.' });

    const groq        = getGroqClient(groqKey);
    const tavilyClient = getTavilyClient(tavilyKey);

    const { transcript, language = 'english' } = req.body;

    if (!transcript || typeof transcript !== 'string' || transcript.trim().length === 0) {
      return res.status(400).json({ error: 'Request body must include a non-empty "transcript" string.' });
    }

    const safeTranscript = transcript.slice(0, MAX_CHARS);
    const replyLanguage  = language === 'spanish' ? 'Spanish' : 'English';

    // ── Step 1: Extract verifiable claims ──
    const extractClaims = async (extraInstruction = '') => {
      const extractionRes = await recordCall('groq', groq.chat.completions.create({
        model:       MODEL,
        max_tokens:  256,
        temperature: extraInstruction ? 0.3 : 0.1, // a little more latitude on the retry
        messages: [
          { role: 'system', content: EXTRACT_SYSTEM_PROMPT + extraInstruction },
          { role: 'user',   content: `Transcript (language: ${replyLanguage}):\n${safeTranscript}` },
        ],
      }));

      const cleaned = extractionRes.choices[0].message.content
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/, '')
        .trim();

      try {
        const parsed = JSON.parse(cleaned);
        if (!Array.isArray(parsed)) return [];
        return parsed
          .filter(c => typeof c === 'string' && c.trim().length > 15)
          .slice(0, MAX_CLAIMS);
      } catch {
        console.warn('[/factcheck] Could not parse claims JSON:', cleaned.slice(0, 100));
        return [];
      }
    };

    let claims = await extractClaims();

    // Nothing found on the strict pass. Before reporting "no checkable
    // statements" — which reads as a failure to the viewer — ask again with a
    // lower bar. Segments often contain something checkable that the strict
    // prompt skipped as too soft; this costs one small Groq call and only runs
    // when the first pass came back empty.
    if (claims.length === 0) {
      console.log('[/factcheck] No claims on the strict pass — retrying with a lower bar');
      claims = await extractClaims(`

RETRY — the strict pass found nothing. Lower the bar this time:
- Accept claims that are checkable in principle even if hedged ("officials say
  delays have doubled") — attribute them as stated rather than skipping them
- Accept comparative and quantitative statements about trends, dates, counts,
  costs, or timelines even without a precise figure
- Accept statements about what an organisation or official announced or decided
- Still refuse pure opinion, prediction, and rhetorical questions — those are
  genuinely not checkable and a wrong verdict on them is worse than none`);
    }

    if (claims.length === 0) {
      console.log('[/factcheck] No verifiable claims found in transcript');
      return res.json([]);
    }

    console.log(`[/factcheck] Extracted ${claims.length} claims:`, claims);

    // ── Step 2 + 3: Search + verdict for each claim ──
    // Claims are independent, so they run concurrently. This used to be a
    // sequential loop "to avoid rate limiting on Tavily free tier", but
    // parallelising MAX_CLAIMS calls changes burstiness, not rate — and the
    // route throttle in server.js already caps this endpoint well below any
    // plausible provider RPM limit. Cache hits still cost nothing.
    //
    // Budget accounting happens synchronously below, BEFORE any await, so
    // spendBudget() is still called exactly once per real search and in claim
    // order — concurrency can't interleave it.
    const jobs = claims.map((claim) => {
      const cached = getCached(claim);
      if (cached) {
        console.log(`[/factcheck] Cache hit: "${claim.slice(0, 50)}"`);
        return { kind: 'cached', claim, cached };
      }
      try {
        // Throws 429 if the monthly Tavily budget is spent (cache hits skip this)
        spendBudget('tavily');
        return { kind: 'run', claim };
      } catch (err) {
        return { kind: 'budget', claim, err };
      }
    });

    // Mirror the old `break`: once the budget is gone, keep everything up to
    // and including the claim that discovered it, and drop the rest.
    const exhaustedAt = jobs.findIndex(j => j.kind === 'budget');
    const active = exhaustedAt === -1 ? jobs : jobs.slice(0, exhaustedAt + 1);

    const startedAt = Date.now();
    const results = await Promise.all(active.map(job => runClaim(job, { groq, tavilyClient, replyLanguage })));

    console.log(`[/factcheck] Done — ${results.length} verdicts in ${Date.now() - startedAt}ms`);
    return res.json(results);

  } catch (err) {
    console.error('[/factcheck] Error:', err.message);
    next(err);
  }
});

export default router;
