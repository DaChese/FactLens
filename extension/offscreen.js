/**
 * offscreen.js — FactLens Offscreen Document
 *
 * Runs in a hidden offscreen document (chrome.offscreen API).
 * Has access to getUserMedia and MediaRecorder — things the service worker
 * cannot use in MV3.
 *
 * Message protocol with background.js (via chrome.runtime.onMessage):
 *
 *  Incoming:
 *   { type: 'START_RECORDING', streamId: string, tabId: number }
 *   { type: 'STOP_RECORDING' }
 *
 *  Outgoing (sent back to background.js):
 *   { type: 'AUDIO_CHUNK',  payload: string (base64), mimeType: string, tabId: number }
 *   { type: 'ERROR',        payload: string, tabId: number }
 *   { type: 'STATUS',       payload: string, tabId: number }
 */

const CHUNK_DURATION_MS = 5000;  // 5s chunks — faster transcription
const OVERLAP_MS        = 2000;  // start next chunk 2s before current ends (sliding window)

let mediaRecorder = null;
let audioContext  = null;
let currentTabId  = null;
let chunks        = [];

// ─── Message Handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'START_RECORDING':
      startRecording(message.streamId, message.tabId);
      break;
    case 'STOP_RECORDING':
      stopRecording();
      break;
  }
});

// ─── Recording ───────────────────────────────────────────────────────────────

/**
 * Start capturing audio using the stream ID provided by background.js.
 * The stream ID comes from chrome.tabCapture.getMediaStreamId() and is
 * passed to getUserMedia via the chromeMediaSourceId constraint.
 *
 * @param {string} streamId
 * @param {number} tabId
 */
async function startRecording(streamId, tabId) {
  currentTabId = tabId;

  try {
    // Use the stream ID to get the actual MediaStream
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    // ── Audio passthrough ──
    // Connect the captured stream to the audio output so the user can still
    // hear the tab. Without this the captured stream is consumed silently.
    audioContext   = new AudioContext();
    const source   = audioContext.createMediaStreamSource(stream);
    source.connect(audioContext.destination);

    mediaRecorder = new MediaRecorder(stream, { mimeType });
    chunks = [];

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      if (chunks.length === 0) return;

      const blob = new Blob(chunks, { type: mimeType });
      chunks = [];

      // Send this chunk for transcription (non-blocking — don't await)
      sendAudioChunk(blob, tabId);

      // Sliding window: start the next recording slice immediately
      // so there's no gap between chunks. The overlap means sentences
      // that straddle a chunk boundary get captured in both chunks,
      // giving Whisper full context on each side.
      if (mediaRecorder && mediaRecorder.stream.active) {
        chunks = [];
        mediaRecorder.start();
        // Stop after full chunk duration
        setTimeout(() => {
          if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
        }, CHUNK_DURATION_MS);
      }
    };

    mediaRecorder.onerror = (event) => {
      sendToBackground({ type: 'ERROR', payload: `Recorder error: ${event.error?.message}`, tabId });
    };

    // Stop when the tab's audio track ends
    stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      stopRecording();
    });

    // Start first slice — stop after CHUNK_DURATION_MS
    // The onstop handler immediately starts the next slice (sliding window)
    mediaRecorder.start();
    setTimeout(() => {
      if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
    }, CHUNK_DURATION_MS);

    console.log(`[FactLens Offscreen] Recording started (${mimeType})`);

  } catch (err) {
    console.error('[FactLens Offscreen] getUserMedia failed:', err.message);
    sendToBackground({ type: 'ERROR', payload: `Capture failed: ${err.message}`, tabId });
  }
}

/**
 * Stop the current recording session.
 */
function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  // Close the AudioContext to release the audio output connection
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  mediaRecorder = null;
  currentTabId  = null;
  chunks        = [];
  console.log('[FactLens Offscreen] Recording stopped');
}

// ─── Transcription ───────────────────────────────────────────────────────────

/**
 * Send an audio blob to background.js as base64.
 * background.js handles the actual fetch to the backend — it has reliable
 * network access whereas offscreen documents can have fetch restrictions.
 * @param {Blob} blob
 * @param {number} tabId
 */
async function sendAudioChunk(blob, tabId) {
  // Skip tiny blobs (silence)
  if (blob.size < 1000) {
    console.log('[FactLens Offscreen] Chunk too small, skipping');
    return;
  }

  sendToBackground({ type: 'STATUS', payload: 'processing', tabId });

  // Convert blob to base64 so it can be sent over the message bus.
  // We chunk the Uint8Array conversion to avoid call stack overflow on
  // large buffers (spread operator crashes above ~250KB on some engines).
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  const base64 = btoa(binary);

  console.log(`[FactLens Offscreen] Sending chunk: ${blob.size} bytes as base64 (${base64.length} chars)`);
  sendToBackground({
    type:     'AUDIO_CHUNK',
    payload:  base64,
    mimeType: blob.type,
    tabId,
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Send a message back to background.js.
 * @param {object} message
 */
function sendToBackground(message) {
  chrome.runtime.sendMessage(message).catch((err) => {
    console.warn('[FactLens Offscreen] sendToBackground error:', err.message);
  });
}
