/**
 * background.js — FactLens Service Worker (on-demand architecture)
 *
 * Nothing calls a paid API on a timer. While a session is active, the
 * extension only *collects* for free:
 *  - the offscreen document keeps a rolling ~90s audio ring buffer (local)
 *  - the content script streams caption text and page signals (local)
 *
 * APIs are hit only when the viewer acts:
 *  - "Check now"        → ANALYZE_NOW  → build a Community Note:
 *       transcript (captions if available, else ONE Whisper call)
 *       + ONE /coverage call (story ID + other outlets + missing context)
 *  - "Check statements" → CHECK_CLAIMS → ONE /factcheck call on the same
 *       transcript (claim extraction + up to 2 web-searched verdicts)
 *
 * This mirrors the ATSC 3.0 target: on a real NextGen TV, captions arrive
 * free with the broadcast (CEA-708) and the note is triggered by a remote
 * button press — the browser prototype demonstrates the same architecture.
 *
 * Session state lives in chrome.storage.session (survives SW restarts).
 */

const DEFAULT_BACKEND_URL = 'http://localhost:3001';

// ── Settings (backend URL + API keys) ──
// Configured via the extension's Settings page (options/options.js) and
// stored in chrome.storage.local. Cached here and invalidated on change.
let cachedSettings = null;

async function getSettings() {
  if (cachedSettings) return cachedSettings;
  const stored = await chrome.storage.local.get(['backendUrl', 'groqKey', 'tavilyKey', 'newsApiKey']);
  cachedSettings = {
    backendUrl: stored.backendUrl || DEFAULT_BACKEND_URL,
    groqKey:    stored.groqKey    || '',
    tavilyKey:  stored.tavilyKey  || '',
    newsApiKey: stored.newsApiKey || '',
  };
  return cachedSettings;
}

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') cachedSettings = null;
});

/**
 * Build request headers carrying API key overrides for the backend.
 * Keys left blank in Settings are omitted, so the backend falls back to its
 * own .env for that key.
 */
function buildKeyHeaders(settings) {
  const headers = {};
  if (settings.groqKey)    headers['X-Groq-Key']    = settings.groqKey;
  if (settings.tavilyKey)  headers['X-Tavily-Key']  = settings.tavilyKey;
  if (settings.newsApiKey) headers['X-Newsapi-Key'] = settings.newsApiKey;
  return headers;
}

// ── Per-tab collection state (all local, all free) ──

// Caption-fed rolling word buffer — the preferred transcript source.
// ~200 words ≈ the last 1-2 minutes of speech.
const BUFFER_MAX_WORDS  = 200;
const transcriptBuffers = {}; // tabId → string[]

// How long after the last caption snapshot we still trust the caption buffer
// as the transcript source (instead of paying for a Whisper call).
const CAPTION_USABLE_MS  = 75000;
const lastCaptions       = {}; // tabId → last caption snapshot (for overlap dedup)
const lastCaptionAt      = {}; // tabId → timestamp of last caption text

// Page title / headline / image metadata from the content script — used by
// the backend to cross-check the identified story ("checks and balances").
const pageSignals = {}; // tabId → { pageTitle, onScreenText }

// Detected language per tab (from Whisper) — captions don't provide one.
const detectedLanguages = {}; // tabId → "english" | "spanish" | ...

// ── Per-tab note-building state ──

const noteBuilding       = {}; // tabId → boolean guard (one note at a time)
const lastNoteTranscript = {}; // tabId → { text, language } for CHECK_CLAIMS
const pendingAudio       = {}; // tabId → { resolve, reject, timer } awaiting AUDIO_CHUNK

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;

  // Must be called synchronously — Chrome requires a direct user gesture
  chrome.sidePanel.open({ tabId: tab.id });

  (async () => {
    const isActive = await getSessionActive(tab.id);
    if (isActive) {
      await stopSession(tab.id);
    } else {
      await startSession(tab);
    }
  })();
});

// ─── Session State ───────────────────────────────────────────────────────────

async function setSessionActive(tabId) {
  const { activeSessions = {} } = await chrome.storage.session.get('activeSessions');
  activeSessions[tabId] = true;
  await chrome.storage.session.set({ activeSessions });
}

async function clearSessionActive(tabId) {
  const { activeSessions = {} } = await chrome.storage.session.get('activeSessions');
  delete activeSessions[tabId];
  await chrome.storage.session.set({ activeSessions });
}

async function getSessionActive(tabId) {
  const { activeSessions = {} } = await chrome.storage.session.get('activeSessions');
  return !!activeSessions[tabId];
}

// ─── Session Management ──────────────────────────────────────────────────────

/**
 * Start a capture session. Recording and caption collection begin, but no
 * API is called until the viewer presses "Check now".
 */
async function startSession(tab) {
  await setSessionActive(tab.id);
  transcriptBuffers[tab.id] = [];

  broadcast({ type: 'STATUS', payload: 'listening' });

  try {
    const streamId = await new Promise((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId(
        { targetTabId: tab.id },
        (id) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(id);
          }
        }
      );
    });

    await ensureOffscreenDocument();

    chrome.runtime.sendMessage({
      type:     'START_RECORDING',
      streamId: streamId,
      tabId:    tab.id,
    });

    console.log(`[FactLens] Session started for tab ${tab.id} (on-demand mode)`);

  } catch (err) {
    console.error('[FactLens] startSession error:', err.message);
    broadcast({ type: 'ERROR', payload: `Could not start capture: ${err.message}` });
    broadcast({ type: 'STATUS', payload: 'idle' });
    await clearSessionActive(tab.id);
    cleanupTabState(tab.id);
  }
}

/**
 * Stop the current session and tear down the offscreen document.
 * @param {number} tabId
 */
async function stopSession(tabId) {
  cleanupTabState(tabId);

  chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }).catch(() => {});

  await closeOffscreenDocument();
  await clearSessionActive(tabId);
  broadcast({ type: 'STATUS', payload: 'idle' });
  console.log(`[FactLens] Session stopped for tab ${tabId}`);
}

function cleanupTabState(tabId) {
  delete transcriptBuffers[tabId];
  delete detectedLanguages[tabId];
  delete lastCaptions[tabId];
  delete lastCaptionAt[tabId];
  delete pageSignals[tabId];
  delete noteBuilding[tabId];
  delete lastNoteTranscript[tabId];
  if (pendingAudio[tabId]) {
    clearTimeout(pendingAudio[tabId].timer);
    pendingAudio[tabId].reject(new Error('Session stopped'));
    delete pendingAudio[tabId];
  }
}

// ─── Offscreen Document Management ──────────────────────────────────────────

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');

/**
 * Create the offscreen document if it doesn't already exist.
 */
async function ensureOffscreenDocument() {
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [OFFSCREEN_URL],
  }).catch(() => []);

  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url:      'offscreen.html',
    reasons:  ['USER_MEDIA'],
    justification: 'Buffer tab audio locally for on-demand transcription',
  });

  console.log('[FactLens] Offscreen document created');
}

/**
 * Close the offscreen document if it exists.
 */
async function closeOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [OFFSCREEN_URL],
  }).catch(() => []);

  if (contexts.length === 0) return;

  await chrome.offscreen.closeDocument().catch(() => {});
  console.log('[FactLens] Offscreen document closed');
}

// ─── Message Handling ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {

    // Requested audio arrived from the offscreen doc (viewer pressed Check now)
    case 'AUDIO_CHUNK':
      resolvePendingAudio(message.tabId, message.payload, message.mimeType);
      break;

    // Caption snapshot from the content script — free transcript source
    case 'CAPTION_TEXT':
      handleCaptionText(sender.tab?.id, message.payload);
      break;

    // Page title / headline / image metadata from the content script
    case 'PAGE_SIGNALS':
      if (sender.tab?.id && message.payload) {
        pageSignals[sender.tab.id] = message.payload;
      }
      break;

    case 'STATUS':
      broadcast({ type: 'STATUS', payload: message.payload });
      break;

    case 'ERROR':
      // If we're waiting on audio and the offscreen doc reports a problem,
      // fail the pending request immediately instead of timing out.
      if (message.tabId && pendingAudio[message.tabId]) {
        const pending = pendingAudio[message.tabId];
        clearTimeout(pending.timer);
        delete pendingAudio[message.tabId];
        pending.reject(new Error(message.payload));
      } else {
        broadcast({ type: 'ERROR', payload: message.payload });
      }
      break;

    // "Check now" — build a Community Note for the active session
    case 'ANALYZE_NOW':
      chrome.storage.session.get('activeSessions').then(({ activeSessions = {} }) => {
        Object.keys(activeSessions).forEach(tabId => buildNote(Number(tabId)));
      });
      break;

    // "Check statements" on the note — run claims for the last note's transcript
    case 'CHECK_CLAIMS':
      chrome.storage.session.get('activeSessions').then(({ activeSessions = {} }) => {
        Object.keys(activeSessions).forEach(tabId => runClaimCheck(Number(tabId)));
      });
      break;

    case 'STOP_SESSION':
      chrome.storage.session.get('activeSessions').then(({ activeSessions = {} }) => {
        Object.keys(activeSessions).forEach(tabId => stopSession(Number(tabId)));
      });
      break;

    case 'GET_STATUS':
      chrome.storage.session.get('activeSessions').then(({ activeSessions = {} }) => {
        const hasActive = Object.keys(activeSessions).length > 0;
        sendResponse({ type: 'STATUS', payload: hasActive ? 'listening' : 'idle' });
      });
      return true; // keep channel open for async response
  }
});

// ─── Caption Handling ────────────────────────────────────────────────────────

/**
 * Caption snapshot from the content script. Snapshots overlap as the caption
 * window scrolls, so suffix/prefix dedup extracts just the new words, which
 * accumulate in the rolling transcript buffer — for free.
 * @param {number|undefined} tabId
 * @param {string} text
 */
async function handleCaptionText(tabId, text) {
  if (!tabId || !text || typeof text !== 'string') return;
  if (!(await getSessionActive(tabId))) return;

  lastCaptionAt[tabId] = Date.now();

  const prev = lastCaptions[tabId] ?? '';
  const next = text.trim();

  // Fast path: captions usually grow cumulatively ("hello" → "hello there"),
  // which the ≥3-word overlap dedup can't catch for short snapshots.
  let newText;
  if (prev && next.toLowerCase().startsWith(prev.toLowerCase())) {
    newText = next.slice(prev.length);
  } else {
    newText = deduplicateOverlap(prev, next);
  }
  lastCaptions[tabId] = next;

  if (!newText || newText.trim().length === 0) return;

  if (!transcriptBuffers[tabId]) transcriptBuffers[tabId] = [];
  transcriptBuffers[tabId].push(...newText.trim().split(/\s+/));
  if (transcriptBuffers[tabId].length > BUFFER_MAX_WORDS) {
    transcriptBuffers[tabId] = transcriptBuffers[tabId].slice(-BUFFER_MAX_WORDS);
  }
}

/**
 * Given the previous caption snapshot and the new one (which overlaps with it),
 * return only the genuinely new portion of the new text.
 * @param {string} prev
 * @param {string} next
 * @returns {string}
 */
function deduplicateOverlap(prev, next) {
  if (!prev) return next;

  const prevWords = prev.trim().split(/\s+/);
  const nextWords = next.trim().split(/\s+/);

  const maxOverlap = Math.min(prevWords.length, nextWords.length, 20);

  for (let overlap = maxOverlap; overlap >= 3; overlap--) {
    const prevSuffix = prevWords.slice(-overlap).join(' ').toLowerCase();
    const nextPrefix = nextWords.slice(0, overlap).join(' ').toLowerCase();
    if (prevSuffix === nextPrefix) {
      return nextWords.slice(overlap).join(' ');
    }
  }

  return next;
}

// ─── Note Building (the "Check now" pipeline) ────────────────────────────────

/**
 * Build a Community Note for the tab: get a transcript (captions preferred,
 * one Whisper call otherwise), then one /coverage call. Total cost per press:
 * 0-1 transcription + 2 LLM calls + 1 NewsAPI request.
 * @param {number} tabId
 */
async function buildNote(tabId) {
  if (noteBuilding[tabId]) {
    console.log('[FactLens] Note already being built, ignoring');
    return;
  }
  noteBuilding[tabId] = true;
  broadcast({ type: 'STATUS', payload: 'processing' });

  try {
    const { text, language } = await getTranscript(tabId);

    if (!text || text.trim().split(/\s+/).length < 8) {
      broadcast({ type: 'ERROR', payload: 'Not enough speech captured yet — let it listen a little longer, then try again.' });
      return;
    }

    lastNoteTranscript[tabId] = { text, language };
    console.log(`[FactLens] Building note from ${text.split(/\s+/).length} words (${language})`);

    const coverage = await fetchCoverage(tabId, text, language);
    broadcast({ type: 'COVERAGE', payload: coverage });

  } catch (err) {
    console.error('[FactLens] buildNote error:', err.message);
    broadcast({ type: 'ERROR', payload: `Could not build note: ${err.message}` });
  } finally {
    noteBuilding[tabId] = false;
    broadcast({ type: 'STATUS', payload: 'listening' });
    broadcast({ type: 'NOTE_DONE' });
  }
}

/**
 * "Check statements" — run claim extraction + verdicts against the transcript
 * of the most recently built note. One /factcheck call.
 * @param {number} tabId
 */
async function runClaimCheck(tabId) {
  const noteTranscript = lastNoteTranscript[tabId];
  if (!noteTranscript) {
    broadcast({ type: 'ERROR', payload: 'Build a note first (Check now), then check its statements.' });
    broadcast({ type: 'CLAIMS_DONE' });
    return;
  }

  broadcast({ type: 'STATUS', payload: 'processing' });
  try {
    const claims = await fetchFactCheck(noteTranscript.text, noteTranscript.language);
    broadcast({ type: 'FACTCHECK', payload: claims });
  } catch (err) {
    console.error('[FactLens] runClaimCheck error:', err.message);
    broadcast({ type: 'ERROR', payload: `Statement check failed: ${err.message}` });
  } finally {
    broadcast({ type: 'STATUS', payload: 'listening' });
    broadcast({ type: 'CLAIMS_DONE' });
  }
}

/**
 * Get a transcript for the note. Captions are free and more accurate, so if
 * the caption buffer is fresh and substantial, use it and skip Whisper
 * entirely. Otherwise: request the buffered audio ring from the offscreen
 * doc and make ONE transcription call.
 * @param {number} tabId
 * @returns {Promise<{ text: string, language: string }>}
 */
async function getTranscript(tabId) {
  const buffer        = transcriptBuffers[tabId];
  const captionsFresh = lastCaptionAt[tabId] && (Date.now() - lastCaptionAt[tabId]) < CAPTION_USABLE_MS;

  if (captionsFresh && buffer && buffer.length >= 15) {
    console.log(`[FactLens] Using caption transcript (${buffer.length} words) — no Whisper call`);
    return {
      text:     buffer.join(' '),
      language: detectedLanguages[tabId] ?? 'english',
    };
  }

  const { base64, mimeType } = await requestBufferedAudio(tabId);
  return transcribeOnce(base64, mimeType, tabId);
}

/**
 * Ask the offscreen document for its audio ring buffer and wait for the
 * AUDIO_CHUNK reply.
 * @param {number} tabId
 * @returns {Promise<{ base64: string, mimeType: string }>}
 */
function requestBufferedAudio(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      delete pendingAudio[tabId];
      reject(new Error('Timed out waiting for buffered audio.'));
    }, 8000);

    pendingAudio[tabId] = { resolve, reject, timer };
    chrome.runtime.sendMessage({ type: 'REQUEST_AUDIO' }).catch((err) => {
      clearTimeout(timer);
      delete pendingAudio[tabId];
      reject(err);
    });
  });
}

function resolvePendingAudio(tabId, base64, mimeType) {
  const pending = pendingAudio[tabId];
  if (!pending) return; // unsolicited chunk — shouldn't happen in on-demand mode
  clearTimeout(pending.timer);
  delete pendingAudio[tabId];
  pending.resolve({ base64, mimeType });
}

/**
 * ONE transcription call for the assembled audio ring (~90s of audio).
 * @returns {Promise<{ text: string, language: string }>}
 */
async function transcribeOnce(base64, mimeType, tabId) {
  const binary = atob(base64);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const baseMime  = mimeType.split(';')[0].trim();
  const extension = baseMime === 'audio/mpeg' ? 'mp3'
                  : baseMime === 'audio/wav'  ? 'wav'
                  : 'webm';

  const formData = new FormData();
  formData.append('audio', new Blob([bytes], { type: baseMime }), `chunk.${extension}`);

  const settings = await getSettings();
  const res = await fetchWithTimeout(`${settings.backendUrl}/transcribe`, {
    method:  'POST',
    headers: buildKeyHeaders(settings),
    body:    formData,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }

  const { text, language } = await res.json();
  if (language) detectedLanguages[tabId] = language;

  console.log(`[FactLens] Transcribed ${text?.split(/\s+/).length ?? 0} words (${language ?? 'unknown'}) in one call`);
  return { text: text ?? '', language: language ?? detectedLanguages[tabId] ?? 'english' };
}

// ─── Backend API Calls ───────────────────────────────────────────────────────

// Request timeout for backend calls — prevents hanging if backend is slow
const REQUEST_TIMEOUT_MS = 30000;

/**
 * Fetch with a timeout. Throws if the request takes longer than timeoutMs.
 */
async function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFactCheck(text, language = 'english') {
  const settings = await getSettings();
  const res = await fetchWithTimeout(`${settings.backendUrl}/factcheck`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...buildKeyHeaders(settings) },
    body:    JSON.stringify({ transcript: text, language }),
  });
  if (!res.ok) throw new Error(`/factcheck returned ${res.status}`);
  return res.json();
}

/**
 * Fetch multi-outlet coverage + missing context for the current story.
 * Sends the tab's hostname and scraped page signals so the backend can
 * cross-check the story identification.
 */
async function fetchCoverage(tabId, text, language = 'english') {
  let outlet = null;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab?.url) outlet = new URL(tab.url).hostname;
  } catch { /* tab gone or URL unavailable — outlet rating is optional */ }

  const signals  = pageSignals[tabId] ?? {};
  const settings = await getSettings();
  const res = await fetchWithTimeout(`${settings.backendUrl}/coverage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...buildKeyHeaders(settings) },
    body:    JSON.stringify({
      transcript:   text,
      language,
      outlet,
      pageTitle:    signals.pageTitle    || null,
      onScreenText: signals.onScreenText || null,
    }),
  });
  if (!res.ok) throw new Error(`/coverage returned ${res.status}`);
  return res.json();
}

// ─── Broadcast ───────────────────────────────────────────────────────────────

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch((err) => {
    if (!err.message.includes('Could not establish connection')) {
      console.warn('[FactLens] broadcast error:', err.message);
    }
  });
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const isActive = await getSessionActive(tabId);
  if (isActive) await stopSession(tabId);
  cleanupTabState(tabId);
});
