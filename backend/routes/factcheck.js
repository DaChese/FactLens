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

Confidence guidelines:
- 0.9–1.0: Multiple sources clearly agree
- 0.7–0.9: One strong source confirms/denies
- 0.5–0.7: Partial or indirect evidence
- 0.0–0.5: Weak or ambiguous evidence → use "Unverified"

Return ONLY a valid JSON object — no markdown, no explanation outside the JSON.

Output format:
{
  "verdict":    "True" | "False" | "Unverified",
  "confidence": <0.0 to 1.0>,
  "reasoning":  "<one sentence explaining the verdict based on the search results>"
}
`.trim();

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
    const extractionRes = await recordCall('groq', groq.chat.completions.create({
      model:       MODEL,
      max_tokens:  256,
      temperature: 0.1,
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
        { role: 'user',   content: `Transcript (language: ${replyLanguage}):\n${safeTranscript}` },
      ],
    }));

    const rawExtraction = extractionRes.choices[0].message.content;
    const cleanedExtraction = rawExtraction
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    let claims = [];
    try {
      claims = JSON.parse(cleanedExtraction);
      if (!Array.isArray(claims)) claims = [];
    } catch {
      console.warn('[/factcheck] Could not parse claims JSON:', cleanedExtraction.slice(0, 100));
      return res.json([]);
    }

    // Filter out any claims that are too short to be meaningful
    claims = claims
      .filter(c => typeof c === 'string' && c.trim().length > 15)
      .slice(0, MAX_CLAIMS);

    if (claims.length === 0) {
      console.log('[/factcheck] No verifiable claims found in transcript');
      return res.json([]);
    }

    console.log(`[/factcheck] Extracted ${claims.length} claims:`, claims);

    // ── Step 2 + 3: Search + verdict for each claim ──
    // Run sequentially to avoid rate limiting on Tavily free tier.
    // Cache hits return instantly without any API calls.
    const results = [];
    for (const claim of claims) {
      // Check cache first
      const cached = getCached(claim);
      if (cached) {
        console.log(`[/factcheck] Cache hit: "${claim.slice(0, 50)}"`);
        results.push(cached);
        continue;
      }

      try {
        // Throws 429 if the monthly Tavily budget is spent (cache hits skip this)
        spendBudget('tavily');

        const searchResult = await recordCall('tavily', tavilyClient.search(claim, {
          maxResults:    5,
          searchDepth:   'basic', // 1 Tavily credit instead of 2
          includeAnswer: true,
        }));

        const tavilyAnswer = searchResult.answer
          ? `Tavily summary: ${searchResult.answer}\n\n`
          : '';

        const searchContext = searchResult.results
          .map((r, i) =>
            `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content?.slice(0, 600) ?? ''}`
          )
          .join('\n\n');

        const sourceUrls = searchResult.results.map(r => r.url);

        // If Tavily returned no results, mark as Unverified immediately
        if (sourceUrls.length === 0) {
          console.warn(`[/factcheck] No search results for: "${claim.slice(0, 50)}"`);
          results.push({ claim, verdict: 'Unverified', confidence: 0.0, reasoning: 'No search results found.', sources: [] });
          continue;
        }

        const verdictRes = await recordCall('groq', groq.chat.completions.create({
          model:       MODEL,
          max_tokens:  200,
          temperature: 0.1,
          messages: [
            { role: 'system', content: VERDICT_SYSTEM_PROMPT },
            {
              role:    'user',
              content: `Claim: "${claim}"\nRespond in ${replyLanguage}.\n\n${tavilyAnswer}Search results:\n${searchContext}`,
            },
          ],
        }));

        const rawVerdict = verdictRes.choices[0].message.content;
        const cleanedVerdict = rawVerdict
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/, '')
          .trim();

        const parsed = JSON.parse(cleanedVerdict);

        const verdict    = ['True', 'False', 'Unverified'].includes(parsed.verdict)
          ? parsed.verdict
          : 'Unverified';
        const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));

        console.log(`[/factcheck] "${claim.slice(0, 50)}" → ${verdict} (${(confidence * 100).toFixed(0)}%)`);

        const result = {
          claim,
          verdict,
          confidence,
          reasoning: String(parsed.reasoning || '').slice(0, 300),
          sources:   sourceUrls,
        };

        // Cache the result so repeat claims are instant
        setCached(claim, result);
        results.push(result);

      } catch (err) {
        console.warn(`[/factcheck] Failed on claim "${claim.slice(0, 50)}":`, err.message);
        results.push({
          claim,
          verdict:    'Unverified',
          confidence: 0.0,
          reasoning:  err.budget ? err.message : 'Could not retrieve search results.',
          sources:    [],
        });
        if (err.budget) break; // budget is spent — no point trying the next claim
      }
    }

    console.log(`[/factcheck] Done — ${results.length} verdicts`);
    return res.json(results);

  } catch (err) {
    console.error('[/factcheck] Error:', err.message);
    next(err);
  }
});

export default router;
