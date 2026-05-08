/**
 * routes/factcheck.js — Fact-Check Route
 *
 * POST /factcheck
 *  Body: { transcript: string }
 *
 *  Pipeline (Sprint 2):
 *   1. Send transcript to Claude to extract verifiable claims
 *   2. For each claim, run a Tavily search to find supporting/contradicting sources
 *   3. Send claim + search results back to Claude for a final verdict
 *   4. Return structured JSON array
 *
 *  Response shape:
 *  [
 *    {
 *      claim:      string,
 *      verdict:    "True" | "False" | "Unverified",
 *      confidence: number (0.0 – 1.0),
 *      sources:    string[]  // URLs
 *    },
 *    ...
 *  ]
 */

import { Router } from 'express';

// TODO (Sprint 2): Import Anthropic SDK and Tavily client
// import Anthropic from '@anthropic-ai/sdk';
// import { tavily } from '@tavily/core';

const router = Router();

// TODO (Sprint 2): Initialise API clients
// const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
// const tavilyClient = tavily({ apiKey: process.env.TAVILY_API_KEY });

// ─── System Prompt ───────────────────────────────────────────────────────────

const FACTCHECK_SYSTEM_PROMPT = `
You are a neutral fact-checking assistant. Given a transcript excerpt, identify specific
verifiable factual claims (ignore opinions). For each claim, assess whether it is True,
False, or Unverified based on the search results provided. Be concise. Never fabricate
sources. Return only valid JSON — no markdown, no explanation outside the JSON.

Output format (array):
[
  {
    "claim": "<exact claim from transcript>",
    "verdict": "True" | "False" | "Unverified",
    "confidence": <0.0 to 1.0>,
    "sources": ["<url1>", "<url2>"]
  }
]
`.trim();

// ─── POST /factcheck ─────────────────────────────────────────────────────────

router.post('/', async (req, res, next) => {
  try {
    const { transcript } = req.body;

    // ── Input validation ──
    if (!transcript || typeof transcript !== 'string') {
      return res.status(400).json({ error: 'Request body must include a "transcript" string.' });
    }

    if (transcript.trim().length === 0) {
      return res.status(400).json({ error: '"transcript" must not be empty.' });
    }

    // Limit input size to avoid runaway API costs
    const MAX_CHARS = 4000;
    const safeTranscript = transcript.slice(0, MAX_CHARS);

    // TODO (Sprint 2): Step 1 — Extract claims with Claude
    // const extractionResponse = await anthropic.messages.create({
    //   model: 'claude-sonnet-4-20250514',
    //   max_tokens: 1024,
    //   system: FACTCHECK_SYSTEM_PROMPT,
    //   messages: [{ role: 'user', content: `Transcript:\n${safeTranscript}` }],
    // });
    // const claims = JSON.parse(extractionResponse.content[0].text);

    // TODO (Sprint 2): Step 2 — For each claim, search with Tavily
    // const enrichedClaims = await Promise.all(
    //   claims.map(async (item) => {
    // const searchResult = await tavilyClient.search(item.claim, { maxResults: 3 });
    //     return { ...item, searchResults: searchResult.results };
    //   })
    // );

    // TODO (Sprint 2): Step 3 — Final verdict pass with Claude + search context
    // (send enrichedClaims back to Claude for a final structured verdict)

    // ── STUB response ──
    console.log(`[/factcheck] Received transcript (${safeTranscript.length} chars) — stub mode`);
    return res.json([
      {
        claim: '[Stub] No real claims extracted yet.',
        verdict: 'Unverified',
        confidence: 0.0,
        sources: [],
      },
    ]);

  } catch (err) {
    next(err);
  }
});

export default router;
