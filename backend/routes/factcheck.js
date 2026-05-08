/**
 * routes/factcheck.js — Fact-Check Route
 *
 * POST /factcheck
 *  Body: { transcript: string }
 *
 *  Pipeline:
 *   1. Send transcript to Groq (llama-3.3-70b) to extract verifiable claims
 *   2. For each claim, run a Tavily search to find supporting/contradicting sources
 *   3. Send claims + search results back to Groq for a final verdict
 *   4. Return structured JSON array
 *
 *  Response shape:
 *  [
 *    {
 *      claim:      string,
 *      verdict:    "True" | "False" | "Unverified",
 *      confidence: number (0.0 – 1.0),
 *      sources:    string[]  // URLs
 *    }
 *  ]
 */

import { Router } from 'express';
import OpenAI from 'openai';
import { tavily } from '@tavily/core';

const router = Router();

// Groq client — uses the OpenAI-compatible API
const groq = new OpenAI({
  apiKey:  process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

const tavilyClient = tavily({ apiKey: process.env.TAVILY_API_KEY });

const MODEL = 'llama-3.3-70b-versatile';
const MAX_CHARS = 4000;
const MAX_CLAIMS = 5; // cap to avoid excessive Tavily searches

// ─── System Prompts ──────────────────────────────────────────────────────────

const EXTRACT_SYSTEM_PROMPT = `
You are a neutral fact-checking assistant. Given a transcript excerpt, identify up to
${MAX_CLAIMS} specific verifiable factual claims (ignore opinions and predictions).
Return ONLY a valid JSON array of claim strings — no markdown, no explanation.

Example output:
["The unemployment rate is 4.2%", "NASA was founded in 1958"]
`.trim();

const VERDICT_SYSTEM_PROMPT = `
You are a neutral fact-checking assistant. Given a factual claim and web search results,
assess whether the claim is True, False, or Unverified.

Rules:
- Base your verdict ONLY on the provided search results
- If the search results do not clearly confirm or deny the claim, use "Unverified"
- Never fabricate sources
- Return ONLY a valid JSON object — no markdown, no explanation outside the JSON

Output format:
{
  "verdict": "True" | "False" | "Unverified",
  "confidence": <0.0 to 1.0>,
  "sources": ["<url1>", "<url2>"]
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

    // ── Step 1: Extract claims ──
    const extractionRes = await groq.chat.completions.create({
      model:      MODEL,
      max_tokens: 512,
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
        { role: 'user',   content: `Transcript:\n${safeTranscript}` },
      ],
    });

    let claims = [];
    try {
      claims = JSON.parse(extractionRes.choices[0].message.content);
      if (!Array.isArray(claims)) claims = [];
    } catch {
      console.warn('[/factcheck] Could not parse claims JSON — returning empty');
      return res.json([]);
    }

    // Cap the number of claims to avoid excessive API usage
    claims = claims.slice(0, MAX_CLAIMS);

    if (claims.length === 0) {
      return res.json([]);
    }

    console.log(`[/factcheck] Extracted ${claims.length} claims, searching...`);

    // ── Step 2 + 3: Search + verdict for each claim (in parallel) ──
    const results = await Promise.all(
      claims.map(async (claim) => {
        try {
          // Search for evidence
          const searchResult = await tavilyClient.search(claim, {
            maxResults:      3,
            includeAnswer:   false,
            searchDepth:     'basic',
          });

          const searchContext = searchResult.results
            .map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.content?.slice(0, 300)}`)
            .join('\n\n');

          const sourceUrls = searchResult.results.map(r => r.url);

          // Get verdict from Groq
          const verdictRes = await groq.chat.completions.create({
            model:      MODEL,
            max_tokens: 256,
            messages: [
              { role: 'system', content: VERDICT_SYSTEM_PROMPT },
              {
                role:    'user',
                content: `Claim: "${claim}"\n\nSearch results:\n${searchContext}`,
              },
            ],
          });

          const raw = verdictRes.choices[0].message.content;
          // Strip markdown code fences if the model wraps its response
          const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
          const parsed = JSON.parse(cleaned);

          return {
            claim,
            verdict:    parsed.verdict    ?? 'Unverified',
            confidence: parsed.confidence ?? 0.0,
            sources:    parsed.sources?.length ? parsed.sources : sourceUrls,
          };

        } catch (err) {
          console.warn(`[/factcheck] Failed to verify claim "${claim.slice(0, 50)}":`, err.message);
          return {
            claim,
            verdict:    'Unverified',
            confidence: 0.0,
            sources:    [],
          };
        }
      })
    );

    console.log(`[/factcheck] Done — ${results.length} verdicts returned`);
    return res.json(results);

  } catch (err) {
    console.error('[/factcheck] Error:', err.message);
    next(err);
  }
});

export default router;
