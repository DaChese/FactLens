/**
 * routes/bias.js — Bias Analysis Route
 *
 * POST /bias
 *  Body: { transcript: string }
 *
 *  Pipeline (Sprint 2):
 *   1. Send transcript to Claude with the bias analysis system prompt
 *   2. Parse and validate the structured JSON response
 *   3. Return the result to the extension
 *
 *  Response shape:
 *  {
 *    lean_score:    number  (-1.0 far-left → 0.0 center → +1.0 far-right),
 *    emotion_score: number  (0.0 neutral → 1.0 highly charged),
 *    framing_label: string  (plain-English description of detected bias)
 *  }
 */

import { Router } from 'express';

// TODO (Sprint 2): Import Anthropic SDK
// import Anthropic from '@anthropic-ai/sdk';

const router = Router();

// TODO (Sprint 2): Initialise the Anthropic client
// const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── System Prompt ───────────────────────────────────────────────────────────

const BIAS_SYSTEM_PROMPT = `
You are a neutral media analysis assistant. Given a transcript excerpt, analyze the
language for political leaning and emotional charge. Do not factor in the topic itself —
only analyze word choice, framing, and tone. Return only valid JSON — no markdown,
no explanation outside the JSON.

Output format (object):
{
  "lean_score":    <-1.0 to +1.0>,
  "emotion_score": <0.0 to 1.0>,
  "framing_label": "<short plain-English description, e.g. 'Emotionally charged language detected'>"
}
`.trim();

// ─── POST /bias ──────────────────────────────────────────────────────────────

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

    // Limit input size
    const MAX_CHARS = 4000;
    const safeTranscript = transcript.slice(0, MAX_CHARS);

    // TODO (Sprint 2): Call Claude for bias analysis
    // const response = await anthropic.messages.create({
    //   model: 'claude-sonnet-4-20250514',
    //   max_tokens: 256,
    //   system: BIAS_SYSTEM_PROMPT,
    //   messages: [{ role: 'user', content: `Transcript:\n${safeTranscript}` }],
    // });
    //
    // // Claude is instructed to return only JSON — parse it directly
    // const result = JSON.parse(response.content[0].text);
    //
    // // Clamp values to expected ranges before returning
    // return res.json({
    //   lean_score:    Math.max(-1, Math.min(1, result.lean_score)),
    //   emotion_score: Math.max(0,  Math.min(1, result.emotion_score)),
    //   framing_label: String(result.framing_label).slice(0, 200),
    // });

    // ── STUB response ──
    console.log(`[/bias] Received transcript (${safeTranscript.length} chars) — stub mode`);
    return res.json({
      lean_score:    0.0,
      emotion_score: 0.0,
      framing_label: 'Neutral (stub — real analysis coming in Sprint 2)',
    });

  } catch (err) {
    next(err);
  }
});

export default router;
