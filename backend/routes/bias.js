/**
 * routes/bias.js — Bias Analysis Route
 *
 * POST /bias
 *  Body: { transcript: string }
 *
 *  Pipeline:
 *   1. Send transcript to Groq (llama-3.3-70b) with the bias analysis prompt
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
import OpenAI from 'openai';

const router = Router();

// Groq client — uses the OpenAI-compatible API
const groq = new OpenAI({
  apiKey:  process.env.GROQ_API_KEY,
  baseURL: 'https://api.groq.com/openai/v1',
});

const MODEL    = 'llama-3.3-70b-versatile';
const MAX_CHARS = 4000;

// ─── System Prompt ───────────────────────────────────────────────────────────

const BIAS_SYSTEM_PROMPT = `
You are a neutral media analysis assistant. Given a transcript excerpt, analyze the
language for political leaning and emotional charge.

Rules:
- Analyze ONLY word choice, framing, and tone — not the topic itself
- lean_score: -1.0 = strongly left-leaning language, 0.0 = neutral, +1.0 = strongly right-leaning
- emotion_score: 0.0 = calm/neutral language, 1.0 = highly emotional/charged language
- framing_label: one short plain-English sentence describing the dominant framing or tone
- Return ONLY valid JSON — no markdown, no explanation outside the JSON

Output format:
{
  "lean_score":    <-1.0 to 1.0>,
  "emotion_score": <0.0 to 1.0>,
  "framing_label": "<short description>"
}
`.trim();

// ─── POST /bias ──────────────────────────────────────────────────────────────

router.post('/', async (req, res, next) => {
  try {
    const { transcript, language = 'english' } = req.body;

    if (!transcript || typeof transcript !== 'string' || transcript.trim().length === 0) {
      return res.status(400).json({ error: 'Request body must include a non-empty "transcript" string.' });
    }

    const safeTranscript = transcript.slice(0, MAX_CHARS);
    const replyLanguage  = language === 'spanish' ? 'Spanish' : 'English';

    console.log(`[/bias] Analysing ${safeTranscript.length} chars (${replyLanguage})...`);

    const response = await groq.chat.completions.create({
      model:      MODEL,
      max_tokens: 128,
      messages: [
        { role: 'system', content: BIAS_SYSTEM_PROMPT },
        { role: 'user',   content: `Transcript (language: ${replyLanguage}):\n${safeTranscript}\n\nRespond in ${replyLanguage}.` },
      ],
    });

    const raw = response.choices[0].message.content;
    // Strip markdown code fences if the model wraps its response
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let result;
    try {
      result = JSON.parse(cleaned);
    } catch {
      console.warn('[/bias] Could not parse JSON response:', raw.slice(0, 100));
      return res.json({ lean_score: 0.0, emotion_score: 0.0, framing_label: 'Analysis unavailable' });
    }

    // Clamp values to expected ranges
    return res.json({
      lean_score:    Math.max(-1, Math.min(1, Number(result.lean_score)   || 0)),
      emotion_score: Math.max(0,  Math.min(1, Number(result.emotion_score) || 0)),
      framing_label: String(result.framing_label || '—').slice(0, 200),
    });

  } catch (err) {
    console.error('[/bias] Error:', err.message);
    next(err);
  }
});

export default router;
