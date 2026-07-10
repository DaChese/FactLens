/**
 * lib/keys.js — Per-request API key resolution
 *
 * Keys can come from two places:
 *  1. Request headers (X-Groq-Key, X-Tavily-Key, X-Newsapi-Key) — set via the
 *     extension's Settings page, so a demo machine never has to touch .env
 *  2. backend/.env — the default for local development
 *
 * Header values take priority when present. OpenAI/Tavily clients are cached
 * per API key so routes don't reconstruct one on every request.
 */

import OpenAI from 'openai';
import { tavily } from '@tavily/core';

/**
 * Resolve an API key for a request: header override, else env var, else null.
 * @param {import('express').Request} req
 * @param {string} headerName - e.g. 'X-Groq-Key'
 * @param {string} envVar     - e.g. 'GROQ_API_KEY'
 * @returns {string|null}
 */
export function resolveKey(req, headerName, envVar) {
  const headerKey = req.get(headerName);
  if (headerKey && headerKey.trim()) return headerKey.trim();
  return process.env[envVar] || null;
}

const groqClients = new Map();

/** @param {string} apiKey @returns {OpenAI} */
export function getGroqClient(apiKey) {
  if (!groqClients.has(apiKey)) {
    groqClients.set(apiKey, new OpenAI({ apiKey, baseURL: 'https://api.groq.com/openai/v1' }));
  }
  return groqClients.get(apiKey);
}

const tavilyClients = new Map();

/** @param {string} apiKey @returns {ReturnType<typeof tavily>} */
export function getTavilyClient(apiKey) {
  if (!tavilyClients.has(apiKey)) {
    tavilyClients.set(apiKey, tavily({ apiKey }));
  }
  return tavilyClients.get(apiKey);
}
