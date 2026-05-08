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

const BACKEND_URL = 'http://localhost:3001';

// ─── Extension Icon Click ────────────────────────────────────────────────────

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
  broadcast({ type: 'STATUS', payload: 'listening' });

  try {
    // getMediaStreamId is the MV3-compatible way to get a capture stream ID
    // from the service worker. The actual MediaStream is created in the
    // offscreen document using this ID.
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

    // Ensure the offscreen document exists
    await ensureOffscreenDocument();

    // Tell the offscreen doc to start recording
    chrome.runtime.sendMessage({
      type:     'START_RECORDING',
      streamId: streamId,
      tabId:    tab.id,
    });

    console.log(`[FactLens] Session started for tab ${tab.id}`);

  } catch (err) {
    console.error('[FactLens] startSession error:', err.message);
    broadcast({ type: 'ERROR', payload: `Could not start capture: ${err.message}` });
    broadcast({ type: 'STATUS', payload: 'idle' });
    await clearSessionActive(tab.id);
  }
}

/**
 * Stop the current session and tear down the offscreen document.
 * @param {number} tabId
 */
async function stopSession(tabId) {
  // Tell the offscreen doc to stop recording
  chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }).catch(() => {});

  // Close the offscreen document
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

    const { text } = await res.json();

    if (!text || text.trim().length === 0) {
      console.log('[FactLens] Empty transcript (silence)');
      broadcast({ type: 'STATUS', payload: 'listening' });
      return;
    }

    console.log(`[FactLens] Transcript: "${text.slice(0, 80)}"`);
    await handleTranscript(tabId, text.trim());

  } catch (err) {
    console.error('[FactLens] Audio chunk error:', err.message);
    broadcast({ type: 'ERROR',  payload: `Transcription failed: ${err.message}` });
    broadcast({ type: 'STATUS', payload: 'listening' });
  }
}

// ─── Transcript Handling ─────────────────────────────────────────────────────

/**
 * Called when a real transcript arrives from the offscreen document.
 * Sends it to the sidebar and fires stub fact-check / bias responses.
 * @param {number} tabId
 * @param {string} text
 */
async function handleTranscript(tabId, text) {
  broadcast({ type: 'TRANSCRIPT', payload: text });

  const [factCheckResult, biasResult] = await Promise.allSettled([
    fetchFactCheck(text),
    fetchBiasAnalysis(text),
  ]);

  if (factCheckResult.status === 'fulfilled') {
    broadcast({ type: 'FACTCHECK', payload: factCheckResult.value });
  } else {
    broadcast({ type: 'ERROR', payload: 'Fact-check failed: ' + factCheckResult.reason.message });
  }

  if (biasResult.status === 'fulfilled') {
    broadcast({ type: 'BIAS', payload: biasResult.value });
  } else {
    broadcast({ type: 'ERROR', payload: 'Bias analysis failed: ' + biasResult.reason.message });
  }
}

// ─── Backend API Calls ───────────────────────────────────────────────────────

async function fetchFactCheck(text) {
  const res = await fetch(`${BACKEND_URL}/factcheck`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ transcript: text }),
  });
  if (!res.ok) throw new Error(`/factcheck returned ${res.status}`);
  return res.json();
}

async function fetchBiasAnalysis(text) {
  const res = await fetch(`${BACKEND_URL}/bias`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ transcript: text }),
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
});
