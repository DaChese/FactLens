/**
 * background.js — FactLens Service Worker
 *
 * Responsibilities:
 *  - Listen for the extension icon click to activate FactLens
 *  - Open Chrome's native Side Panel for the active tab
 *  - Capture tab audio via chrome.tabCapture (Sprint 2)
 *  - Chunk audio and POST to the backend /transcribe endpoint (Sprint 2)
 *  - Relay STATUS, TRANSCRIPT, FACTCHECK, and BIAS messages to the side panel
 *    via chrome.runtime.sendMessage
 *
 * Session state is stored in chrome.storage.session so it survives service
 * worker restarts (MV3 service workers are ephemeral and can be killed by
 * Chrome at any time — never rely on module-level variables for persistence).
 */

const BACKEND_URL = 'http://localhost:3001';

// How often (ms) to send an audio chunk to the transcription endpoint.
// Sprint 2 note: real Whisper transcription works best with 10–30s chunks.
const CHUNK_INTERVAL_MS = 5000;

// ─── Extension Icon Click ────────────────────────────────────────────────────

chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;

  // sidePanel.open() MUST be called synchronously inside the click handler
  // (before any await) — Chrome requires it to be triggered by a direct user
  // gesture. We open it unconditionally on every click, then check session
  // state asynchronously to decide whether to start or stop.
  chrome.sidePanel.open({ tabId: tab.id });

  // Handle start/stop asynchronously after the panel is open
  (async () => {
    const isActive = await getSessionActive(tab.id);
    if (isActive) {
      await stopSession(tab.id);
    } else {
      await startSession(tab);
    }
  })();
});

// ─── Session State (chrome.storage.session) ──────────────────────────────────
//
// We use chrome.storage.session instead of a plain object so that session
// state survives service worker restarts. storage.session is cleared when
// the browser session ends (tab/window close), which is the right lifetime.

/**
 * Mark a tab as having an active FactLens session.
 * @param {number} tabId
 */
async function setSessionActive(tabId) {
  const { activeSessions = {} } = await chrome.storage.session.get('activeSessions');
  activeSessions[tabId] = true;
  await chrome.storage.session.set({ activeSessions });
}

/**
 * Remove a tab's active session marker.
 * @param {number} tabId
 */
async function clearSessionActive(tabId) {
  const { activeSessions = {} } = await chrome.storage.session.get('activeSessions');
  delete activeSessions[tabId];
  await chrome.storage.session.set({ activeSessions });
}

/**
 * Check whether a tab currently has an active session.
 * @param {number} tabId
 * @returns {Promise<boolean>}
 */
async function getSessionActive(tabId) {
  const { activeSessions = {} } = await chrome.storage.session.get('activeSessions');
  return !!activeSessions[tabId];
}

// ─── Session Management ──────────────────────────────────────────────────────

/**
 * Start an audio capture session for the given tab.
 * @param {chrome.tabs.Tab} tab
 */
async function startSession(tab) {
  await setSessionActive(tab.id);

  // Notify the side panel that we are now listening
  broadcast({ type: 'STATUS', payload: 'listening' });

  // TODO (Sprint 2): Replace stub interval with real tabCapture + audio pipeline.
  //
  // chrome.tabCapture.capture({ audio: true, video: false }, (stream) => {
  //   if (!stream) {
  //     console.error('[FactLens] tabCapture failed:', chrome.runtime.lastError);
  //     broadcast({ type: 'ERROR', payload: 'Audio capture failed. Is the tab playing audio?' });
  //     return;
  //   }
  //   buildAudioPipeline(tab.id, stream);
  // });

  // ── STUB: fire a fake transcript every CHUNK_INTERVAL_MS ──
  // We can't store the intervalId in storage (not serialisable), so we keep
  // it in a module-level map. This is acceptable for the stub — Sprint 2 will
  // replace this with a real MediaStream pipeline that doesn't need an interval.
  console.log(`[FactLens] Starting stub session for tab ${tab.id}`);

  const intervalId = setInterval(async () => {
    // Guard: if the session was stopped while the interval was pending, bail out
    const stillActive = await getSessionActive(tab.id);
    if (!stillActive) {
      clearInterval(intervalId);
      return;
    }
    handleTranscript(tab.id, '[Stub] This is a simulated transcript chunk.');
  }, CHUNK_INTERVAL_MS);

  // Store intervalId in a module-level map for cleanup.
  // This is intentionally limited to the stub — real audio pipelines use
  // MediaStream track lifecycle instead.
  stubIntervals[tab.id] = intervalId;
}

// Module-level map used only by the stub interval — not relied on for
// persistent state (see comment in startSession above).
const stubIntervals = {};

/**
 * Stop the capture session for the given tab.
 * @param {number} tabId
 */
async function stopSession(tabId) {
  // Clear stub interval if running
  if (stubIntervals[tabId]) {
    clearInterval(stubIntervals[tabId]);
    delete stubIntervals[tabId];
  }

  // TODO (Sprint 2): Stop MediaStream tracks and disconnect AudioContext nodes
  // session.stream?.getTracks().forEach(t => t.stop());

  await clearSessionActive(tabId);
  broadcast({ type: 'STATUS', payload: 'idle' });
  console.log(`[FactLens] Session stopped for tab ${tabId}`);
}

// ─── Audio Pipeline (Sprint 2) ───────────────────────────────────────────────

/**
 * TODO (Sprint 2): Build the Web Audio API pipeline.
 *  1. Create an AudioContext
 *  2. Connect the MediaStream source to an AudioWorkletNode (preferred over
 *     the deprecated ScriptProcessorNode)
 *  3. Accumulate PCM samples in the worklet
 *  4. Every CHUNK_INTERVAL_MS, encode as WebM via MediaRecorder and call
 *     sendAudioChunk()
 *
 * @param {number} tabId
 * @param {MediaStream} stream
 */
function buildAudioPipeline(tabId, stream) {
  // Placeholder — implement in Sprint 2
}

/**
 * TODO (Sprint 2): Encode a PCM buffer as a WebM Blob and POST to /transcribe.
 * @param {number} tabId
 * @param {Blob} audioBlob
 */
async function sendAudioChunk(tabId, audioBlob) {
  broadcast({ type: 'STATUS', payload: 'processing' });

  const formData = new FormData();
  formData.append('audio', audioBlob, 'chunk.webm');

  const res = await fetch(`${BACKEND_URL}/transcribe`, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) throw new Error(`/transcribe returned ${res.status}`);

  const { text } = await res.json();
  if (text) handleTranscript(tabId, text);
}

// ─── Transcription Handling ──────────────────────────────────────────────────

/**
 * Called when a transcript chunk is ready (real or stub).
 * Forwards the text to the side panel and kicks off fact-check + bias analysis.
 * @param {number} tabId
 * @param {string} text
 */
async function handleTranscript(tabId, text) {
  // Send raw transcript to the side panel immediately
  broadcast({ type: 'TRANSCRIPT', payload: text });

  // Fire fact-check and bias analysis in parallel
  // TODO (Sprint 2): Uncomment once backend routes are wired up with real APIs
  // const [factCheckResult, biasResult] = await Promise.allSettled([
  //   fetchFactCheck(text),
  //   fetchBiasAnalysis(text),
  // ]);
  // if (factCheckResult.status === 'fulfilled') {
  //   broadcast({ type: 'FACTCHECK', payload: factCheckResult.value });
  // } else {
  //   broadcast({ type: 'ERROR', payload: 'Fact-check failed: ' + factCheckResult.reason.message });
  // }
  // if (biasResult.status === 'fulfilled') {
  //   broadcast({ type: 'BIAS', payload: biasResult.value });
  // } else {
  //   broadcast({ type: 'ERROR', payload: 'Bias analysis failed: ' + biasResult.reason.message });
  // }

  // ── STUB responses ──
  broadcast({
    type: 'FACTCHECK',
    payload: [
      {
        claim: '[Stub] Example claim from transcript.',
        verdict: 'Unverified',
        confidence: 0.5,
        sources: [],
      },
    ],
  });

  broadcast({
    type: 'BIAS',
    payload: {
      lean_score: 0.0,
      emotion_score: 0.1,
      framing_label: 'Neutral (stub)',
    },
  });
}

// ─── Backend API Calls (Sprint 2) ────────────────────────────────────────────

/**
 * TODO (Sprint 2): POST transcript text to /factcheck and return parsed JSON.
 * @param {string} text
 * @returns {Promise<Array>}
 */
async function fetchFactCheck(text) {
  const res = await fetch(`${BACKEND_URL}/factcheck`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript: text }),
  });
  if (!res.ok) throw new Error(`/factcheck returned ${res.status}`);
  return res.json();
}

/**
 * TODO (Sprint 2): POST transcript text to /bias and return parsed JSON.
 * @param {string} text
 * @returns {Promise<object>}
 */
async function fetchBiasAnalysis(text) {
  const res = await fetch(`${BACKEND_URL}/bias`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcript: text }),
  });
  if (!res.ok) throw new Error(`/bias returned ${res.status}`);
  return res.json();
}

// ─── Messaging ───────────────────────────────────────────────────────────────

/**
 * Broadcast a message to all extension pages (side panel, any open popups).
 * The side panel's sidebar.js listens with chrome.runtime.onMessage.
 *
 * We use sendMessage rather than targeting a specific tab because the side
 * panel is an extension page, not a content script — it lives on the
 * extension's own origin and receives runtime messages directly.
 *
 * @param {object} message
 */
function broadcast(message) {
  chrome.runtime.sendMessage(message).catch((err) => {
    // The side panel may not be open yet — this is expected and safe to ignore
    if (!err.message.includes('Could not establish connection')) {
      console.warn('[FactLens] broadcast error:', err.message);
    }
  });
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

// Stop sessions when a tab is closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const isActive = await getSessionActive(tabId);
  if (isActive) await stopSession(tabId);
});
