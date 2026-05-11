/**
 * background.js — FactLens Service Worker
 *
 * In Chrome MV3, service workers cannot use MediaRecorder or access
 * MediaStream objects directly. The audio pipeline lives in an offscreen
 * document (offscreen.html / offscreen.js) instead.
 *
 * This service worker:
 *  1. Opens the Chrome Side Panel on icon click
 *  2. Gets a stream ID via chrome.tabCapture.getMediaStreamId()
 *  3. Creates an offscreen document and passes the stream ID to it
 *  4. Receives TRANSCRIPT / STATUS / ERROR messages from the offscreen doc
 *  5. Broadcasts those messages to the side panel
 *
 * Session state lives in chrome.storage.session (survives SW restarts).
 */

// Backend URL — swap this to your Railway deployment URL for production.
// Local dev:  'http://localhost:3001'
// Production: 'https://factlens-production.up.railway.app'
const BACKEND_URL = 'https://factlens-production.up.railway.app';

// Rolling transcript buffer — accumulates chunks across multiple Whisper responses.
// Fact-check and bias analysis run against this buffer on a separate interval,
// so analysis updates more frequently than the 8s audio chunk cycle.
const transcriptBuffers = {}; // tabId → string[]

// How many words to keep in the rolling buffer for analysis context.
// ~150 words ≈ 60–90 seconds of speech — enough context without being too stale.
const BUFFER_MAX_WORDS = 150;

// How often (ms) to run fact-check + bias analysis against the rolling buffer.
// Independent of the audio chunk interval — runs every 20s so analysis feels live.
const ANALYSIS_INTERVAL_MS = 20000;

// Guard flag — prevents overlapping analysis cycles if Tavily/Groq is slow
const analysisRunning = {}; // tabId → boolean

// Last transcript per tab — used to deduplicate overlapping Whisper results
const lastTranscripts = {}; // tabId → last transcript string

// Detected language per tab — passed to fact-check and bias routes
const detectedLanguages = {}; // tabId → e.g. "english" | "spanish"

// Module-level map of tabId → analysis interval ID
const analysisIntervals = {};

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
 * Start a capture session:
 *  1. Get a stream ID from tabCapture (works in SW via getMediaStreamId)
 *  2. Create the offscreen document
 *  3. Tell the offscreen doc to start recording with that stream ID
 */
async function startSession(tab) {
  await setSessionActive(tab.id);

  // Initialise the rolling transcript buffer for this tab
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

    // Start the analysis interval — runs independently of audio chunking
    analysisIntervals[tab.id] = setInterval(() => {
      runAnalysis(tab.id);
    }, ANALYSIS_INTERVAL_MS);

    console.log(`[FactLens] Session started for tab ${tab.id}`);

  } catch (err) {
    console.error('[FactLens] startSession error:', err.message);
    broadcast({ type: 'ERROR', payload: `Could not start capture: ${err.message}` });
    broadcast({ type: 'STATUS', payload: 'idle' });
    await clearSessionActive(tab.id);
    delete transcriptBuffers[tab.id];
  }
}

/**
 * Stop the current session and tear down the offscreen document.
 * @param {number} tabId
 */
async function stopSession(tabId) {
  // Stop the analysis interval
  if (analysisIntervals[tabId]) {
    clearInterval(analysisIntervals[tabId]);
    delete analysisIntervals[tabId];
  }

  // Clear the rolling buffer and language
  delete transcriptBuffers[tabId];
  delete detectedLanguages[tabId];
  delete lastTranscripts[tabId];
  delete analysisRunning[tabId];

  // Tell the offscreen doc to stop recording
  chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }).catch(() => {});

  await closeOffscreenDocument();
  await clearSessionActive(tabId);
  broadcast({ type: 'STATUS', payload: 'idle' });
  console.log(`[FactLens] Session stopped for tab ${tabId}`);
}

// ─── Offscreen Document Management ──────────────────────────────────────────

const OFFSCREEN_URL = chrome.runtime.getURL('offscreen.html');

/**
 * Create the offscreen document if it doesn't already exist.
 */
async function ensureOffscreenDocument() {
  // Check if it's already open
  const existing = await chrome.offscreen.hasDocument?.();
  if (existing) return;

  // getContexts is the preferred way to check in newer Chrome versions
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [OFFSCREEN_URL],
  }).catch(() => []);

  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url:      'offscreen.html',
    reasons:  ['USER_MEDIA'],
    justification: 'Capture and chunk tab audio for transcription',
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

/**
 * Listen for messages from:
 *  - offscreen.js (TRANSCRIPT, STATUS, ERROR)
 *  - sidebar.js   (GET_STATUS)
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {

    // Audio chunk from offscreen doc — fetch to backend and transcribe
    case 'AUDIO_CHUNK':
      handleAudioChunk(message.payload, message.mimeType, message.tabId);
      break;

    // Messages from the offscreen document — relay to the side panel
    case 'TRANSCRIPT':
      handleTranscript(message.tabId, message.payload);
      break;

    case 'STATUS':
      broadcast({ type: 'STATUS', payload: message.payload });
      break;

    case 'ERROR':
      broadcast({ type: 'ERROR', payload: message.payload });
      break;

    // Stop session request from the sidebar stop button
    case 'STOP_SESSION':
      chrome.storage.session.get('activeSessions').then(({ activeSessions = {} }) => {
        Object.keys(activeSessions).forEach(tabId => stopSession(Number(tabId)));
      });
      break;

    // Request from the side panel on load — reply with current session state
    case 'GET_STATUS':
      chrome.storage.session.get('activeSessions').then(({ activeSessions = {} }) => {
        const hasActive = Object.keys(activeSessions).length > 0;
        sendResponse({ type: 'STATUS', payload: hasActive ? 'listening' : 'idle' });
      });
      return true; // keep channel open for async response
  }
});

// ─── Audio Chunk → Backend ───────────────────────────────────────────────────

/**
 * Receive a base64-encoded audio chunk from the offscreen document,
 * POST it to the backend /transcribe endpoint, and handle the result.
 * Fetching from the service worker avoids the network restrictions that
 * affect offscreen documents.
 *
 * @param {string} base64  - base64-encoded audio data
 * @param {string} mimeType
 * @param {number} tabId
 */
async function handleAudioChunk(base64, mimeType, tabId) {
  try {
    // Decode base64 back to binary
    const binary = atob(base64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const baseMime  = mimeType.split(';')[0].trim();
    const extension = baseMime === 'audio/mpeg' ? 'mp3'
                    : baseMime === 'audio/wav'  ? 'wav'
                    : 'webm';

    const formData = new FormData();
    formData.append('audio', new Blob([bytes], { type: baseMime }), `chunk.${extension}`);

    const res = await fetch(`${BACKEND_URL}/transcribe`, {
      method: 'POST',
      body:   formData,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const { text, language } = await res.json();

    if (!text || text.trim().length === 0) {
      console.log('[FactLens] Empty transcript (silence)');
      broadcast({ type: 'STATUS', payload: 'listening' });
      return;
    }

    console.log(`[FactLens] Transcript (${language ?? 'unknown'}): "${text.slice(0, 80)}"`);

    // ── Overlap deduplication ──
    // Because blobs overlap, Whisper may return text we already showed.
    // Find the longest suffix of the previous transcript that matches a
    // prefix of the new one, and only show the genuinely new portion.
    const newText = deduplicateOverlap(lastTranscripts[tabId] ?? '', text);
    lastTranscripts[tabId] = text;

    if (!newText || newText.trim().length === 0) {
      broadcast({ type: 'STATUS', payload: 'listening' });
      return;
    }

    await handleTranscript(tabId, newText.trim(), language);

  } catch (err) {
    console.error('[FactLens] Audio chunk error:', err.message);
    broadcast({ type: 'ERROR',  payload: `Transcription failed: ${err.message}` });
    broadcast({ type: 'STATUS', payload: 'listening' });
  }
}

// ─── Overlap Deduplication ───────────────────────────────────────────────────

/**
 * Given the previous transcript and the new one (which overlaps with it),
 * return only the genuinely new portion of the new transcript.
 *
 * Strategy: find the longest suffix of `prev` that appears as a prefix
 * of `next` (word-level comparison), then return everything after that match.
 *
 * @param {string} prev - previous transcript text
 * @param {string} next - new transcript text (may start with repeated words)
 * @returns {string} - only the new words not already shown
 */
function deduplicateOverlap(prev, next) {
  if (!prev) return next;

  const prevWords = prev.trim().split(/\s+/);
  const nextWords = next.trim().split(/\s+/);

  // Try matching the last N words of prev against the first N words of next
  // Start with the longest possible overlap and work down
  const maxOverlap = Math.min(prevWords.length, nextWords.length, 20);

  for (let overlap = maxOverlap; overlap >= 3; overlap--) {
    const prevSuffix = prevWords.slice(-overlap).join(' ').toLowerCase();
    const nextPrefix = nextWords.slice(0, overlap).join(' ').toLowerCase();
    if (prevSuffix === nextPrefix) {
      // Found the overlap — return only the new words after it
      const newWords = nextWords.slice(overlap);
      return newWords.join(' ');
    }
  }

  // No significant overlap found — return the full new transcript
  return next;
}

// ─── Transcript Handling ─────────────────────────────────────────────────────

/**
 * Called when a transcript chunk arrives from Whisper.
 * Appends to the rolling buffer and broadcasts to the sidebar immediately.
 * @param {number} tabId
 * @param {string} text
 * @param {string|null} language - detected language e.g. "english", "spanish"
 */
async function handleTranscript(tabId, text, language = null) {
  broadcast({ type: 'TRANSCRIPT', payload: text });
  broadcast({ type: 'STATUS', payload: 'listening' });

  // Store the detected language for the analysis interval
  if (language) detectedLanguages[tabId] = language;

  if (!transcriptBuffers[tabId]) transcriptBuffers[tabId] = [];
  const newWords = text.trim().split(/\s+/);
  transcriptBuffers[tabId].push(...newWords);

  if (transcriptBuffers[tabId].length > BUFFER_MAX_WORDS) {
    transcriptBuffers[tabId] = transcriptBuffers[tabId].slice(-BUFFER_MAX_WORDS);
  }

  console.log(`[FactLens] Buffer: ${transcriptBuffers[tabId].length} words (${language ?? 'unknown'})`);
}

/**
 * Run fact-check and bias analysis against the current rolling buffer.
 * Called on the ANALYSIS_INTERVAL_MS timer — independent of audio chunking.
 * @param {number} tabId
 */
async function runAnalysis(tabId) {
  // Skip if a previous analysis cycle is still running — prevents rate limit pile-up
  if (analysisRunning[tabId]) {
    console.log('[FactLens] Analysis still running, skipping cycle');
    return;
  }

  const buffer = transcriptBuffers[tabId];
  if (!buffer || buffer.length < 10) return;

  analysisRunning[tabId] = true;
  const bufferText = buffer.join(' ');
  const language   = detectedLanguages[tabId] ?? 'english';
  console.log(`[FactLens] Running analysis on ${buffer.length} words (${language})...`);

  try {
    const [factCheckResult, biasResult] = await Promise.allSettled([
      fetchFactCheck(bufferText, language),
      fetchBiasAnalysis(bufferText, language),
    ]);

    if (factCheckResult.status === 'fulfilled' && factCheckResult.value.length > 0) {
      broadcast({ type: 'FACTCHECK', payload: factCheckResult.value });
    } else if (factCheckResult.status === 'rejected') {
      broadcast({ type: 'ERROR', payload: 'Fact-check failed: ' + factCheckResult.reason.message });
    }

    if (biasResult.status === 'fulfilled') {
      broadcast({ type: 'BIAS', payload: biasResult.value });
    } else if (biasResult.status === 'rejected') {
      broadcast({ type: 'ERROR', payload: 'Bias analysis failed: ' + biasResult.reason.message });
    }
  } finally {
    analysisRunning[tabId] = false;
  }
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
  const res = await fetchWithTimeout(`${BACKEND_URL}/factcheck`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ transcript: text, language }),
  });
  if (!res.ok) throw new Error(`/factcheck returned ${res.status}`);
  return res.json();
}

async function fetchBiasAnalysis(text, language = 'english') {
  const res = await fetchWithTimeout(`${BACKEND_URL}/bias`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ transcript: text, language }),
  });
  if (!res.ok) throw new Error(`/bias returned ${res.status}`);
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
  // Clean up buffer even if session wasn't formally active
  delete transcriptBuffers[tabId];
});
