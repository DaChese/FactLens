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
import OpenAI from 'openai';
import { tavily } from '@tavily/core';

const router = Router();

const groq = new OpenAI({
  apiKey:  process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

const tavilyClient = tavily({ apiKey: process.env.TAVILY_API_KEY });

const MODEL     = 'llama-3.3-70b-versatile';
const MAX_CHARS = 4000;
const MAX_CLAIMS = 3; // fewer claims = more thorough search per claim

// ─── System Prompts ──────────────────────────────────────────────────────────

const EXTRACT_SYSTEM_PROMPT = `
You are a strict fact-checking assistant. Given a transcript excerpt, extract up to 3
specific, verifiable factual claims that can be confirmed or denied with a web search.

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
    const { transcript } = req.body;

    if (!transcript || typeof transcript !== 'string' || transcript.trim().length === 0) {
      return res.status(400).json({ error: 'Request body must include a non-empty "transcript" string.' });
    }

    const safeTranscript = transcript.slice(0, MAX_CHARS);

    // ── Step 1: Extract verifiable claims ──
    const extractionRes = await groq.chat.completions.create({
      model:       MODEL,
      max_tokens:  256,
      temperature: 0.1, // low temperature = more deterministic, less hallucination
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
        { role: 'user',   content: `Transcript:\n${safeTranscript}` },
      ],
    });

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
    // Run sequentially to avoid rate limiting on Tavily free tier
    const results = [];
    for (const claim of claims) {
      try {
        // Advanced search gives more content per result — better for fact-checking
        const searchResult = await tavilyClient.search(claim, {
          maxResults:   5,
          searchDepth:  'advanced',
          includeAnswer: true, // Tavily's own AI answer as additional context
        });

        // Build rich context for the verdict model
        const tavilyAnswer = searchResult.answer
          ? `Tavily summary: ${searchResult.answer}\n\n`
          : '';

        const searchContext = searchResult.results
          .map((r, i) =>
            `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content?.slice(0, 600) ?? ''}`
          )
          .join('\n\n');

        // Always use Tavily URLs — never trust model-generated URLs
        const sourceUrls = searchResult.results.map(r => r.url);

        // Get verdict from Groq — grounded in search results only
        const verdictRes = await groq.chat.completions.create({
          model:       MODEL,
          max_tokens:  200,
          temperature: 0.1,
          messages: [
            { role: 'system', content: VERDICT_SYSTEM_PROMPT },
            {
              role:    'user',
              content: `Claim: "${claim}"\n\n${tavilyAnswer}Search results:\n${searchContext}`,
            },
          ],
        });

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

        results.push({
          claim,
          verdict,
          confidence,
          reasoning: String(parsed.reasoning || '').slice(0, 300),
          sources:   sourceUrls,
        });

      } catch (err) {
        console.warn(`[/factcheck] Failed on claim "${claim.slice(0, 50)}":`, err.message);
        results.push({
          claim,
          verdict:    'Unverified',
          confidence: 0.0,
          reasoning:  'Could not retrieve search results.',
          sources:    [],
        });
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
