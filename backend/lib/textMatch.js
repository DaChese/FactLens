/**
 * lib/textMatch.js — Lightweight keyword-overlap scoring
 *
 * Used by /coverage as a cheap, deterministic cross-check that two pieces of
 * text are about the same story (e.g. the LLM's search query vs. the page
 * title, or vs. headlines NewsAPI returned). No API calls, no dependencies —
 * this is the "checks and balances" layer that doesn't trust any single
 * model output on its own.
 */

// Common English + Spanish filler words that carry no story identity.
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for',
  'with', 'from', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'has',
  'have', 'had', 'will', 'would', 'can', 'could', 'this', 'that', 'these',
  'those', 'it', 'its', 'his', 'her', 'their', 'our', 'your', 'after',
  'before', 'over', 'under', 'about', 'into', 'more', 'most', 'new', 'news',
  'says', 'said', 'live', 'video', 'watch', 'breaking', 'update', 'report',
  'el', 'la', 'los', 'las', 'un', 'una', 'y', 'o', 'de', 'del', 'en', 'con',
  'por', 'para', 'que', 'es', 'son', 'como', 'sobre', 'noticias',
]);

/**
 * Extract the distinct, meaningful lowercase tokens from a string.
 * @param {string} text
 * @returns {string[]}
 */
export function significantTokens(text) {
  if (!text || typeof text !== 'string') return [];
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9áéíóúüñ\s]/gi, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
  return [...new Set(tokens)];
}

/**
 * Score how much two texts overlap on meaningful keywords: the fraction of
 * the smaller token set that also appears in the other. 0 = nothing shared,
 * 1 = one is fully contained in the other.
 *
 * A single shared word is never enough — two different stories can easily
 * share one place or name ("Florida"), so unless a text only *has* one
 * meaningful token, at least two shared tokens are required to score at all.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} 0.0 – 1.0
 */
export function keywordOverlap(a, b) {
  const tokensA = significantTokens(a);
  const tokensB = significantTokens(b);
  if (tokensA.length === 0 || tokensB.length === 0) return 0;

  const setB = new Set(tokensB);
  const shared = tokensA.filter(t => setB.has(t)).length;

  const minSize = Math.min(tokensA.length, tokensB.length);
  if (shared < 2 && minSize >= 2) return 0;

  return shared / minSize;
}
