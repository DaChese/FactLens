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

const router = Router();

const MODEL = 'llama-3.3-70b-versatile';

const DISCUSSION_SYSTEM_PROMPT = `
You are a neutral observer summarizing online public discussion about a news story.
You will be given search results about how people are discussing or reacting to a
story online — forums, comment threads, social posts.

Rules:
- Describe opinions as opinions: "some commenters argue...", "a common reaction is...",
  "discussion is divided over..." — never state an opinion as an established fact
- Identify the general tenor and up to 2-3 major recurring viewpoints or reactions
- If one of the search results contains an actual quotable line from a real person
  (a named commenter, a quoted post, an attributed remark), you may include ONE short
  quote verbatim with its attribution ("as one commenter put it, '...'") to make the
  summary concrete. Only ever quote text that is literally present in the search
  results — inventing or paraphrasing-as-a-quote is not allowed. If nothing in the
  results is a real attributable quote, don't include one; the tenor summary alone is fine
- Do not adopt, endorse, or lean toward any viewpoint yourself
- If the results are too thin, off-topic, or don't reflect real discussion of this
  story, return {"summary": null} rather than guessing
- One to three sentences. Return ONLY a valid JSON object — no markdown, no explanation

Output format:
{ "summary": "<1-3 sentences>" | null }
`.trim();

function stripFences(raw) {
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

// ─── POST /discussion ────────────────────────────────────────────────────────

router.post('/', async (req, res, next) => {
  try {
    const { query, language = 'english' } = req.body;

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return res.status(400).json({ error: 'Request body must include a non-empty "query" string (from /coverage\'s response).' });
    }

    const tavilyKey = resolveKey(req, 'X-Tavily-Key', 'TAVILY_API_KEY');
    if (!tavilyKey) {
      return res.json({ available: false, summary: null, sources: [] });
    }

    const groqKey = resolveKey(req, 'X-Groq-Key', 'GROQ_API_KEY');
    if (!groqKey) {
      return res.status(400).json({ error: 'No Groq API key configured. Set one in the extension\'s Settings page or backend/.env.' });
    }

    const safeQuery = query.slice(0, 100);
    const tavilyClient  = getTavilyClient(tavilyKey);
    const groq          = getGroqClient(groqKey);
    const replyLanguage = language === 'spanish' ? 'Spanish' : 'English';

    // Throws 429 if the monthly Tavily budget is spent (same pool as /factcheck)
    spendBudget('tavily');

    const searchResult = await recordCall('tavily', tavilyClient.search(`${safeQuery} reaction discussion`, {
      maxResults:  5,
      searchDepth: 'basic', // 1 credit
    }));

    const results = (searchResult.results ?? []).filter(r => r.title && r.url);
    if (results.length === 0) {
      console.log('[/discussion] No search results — nothing to summarize');
      return res.json({ available: true, summary: null, sources: [] });
    }

    const resultBlock = results
      .map((r, i) => `[${i + 1}] ${r.title}${r.content ? ` — ${r.content.slice(0, 300)}` : ''}`)
      .join('\n');

    const response = await recordCall('groq', groq.chat.completions.create({
      model:       MODEL,
      max_tokens:  200,
      temperature: 0.2,
      messages: [
        { role: 'system', content: DISCUSSION_SYSTEM_PROMPT },
        { role: 'user',   content: `Story: "${safeQuery}"\nRespond in ${replyLanguage}.\n\nSearch results:\n${resultBlock}` },
      ],
    }));

    let summary = null;
    try {
      const parsed = JSON.parse(stripFences(response.choices[0].message.content));
      summary = typeof parsed?.summary === 'string' ? parsed.summary.slice(0, 400) : null;
    } catch {
      console.warn('[/discussion] Could not parse summary JSON');
    }

    console.log(`[/discussion] "${safeQuery}" → ${summary ? 'summarized' : 'no summary (thin results)'}`);

    return res.json({
      available: true,
      summary,
      sources: summary ? results.slice(0, 5).map(r => ({ title: r.title, url: r.url })) : [],
    });

  } catch (err) {
    console.error('[/discussion] Error:', err.message);
    next(err);
  }
});

export default router;
