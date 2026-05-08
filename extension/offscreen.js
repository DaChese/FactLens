/**
 * offscreen.js — FactLens Offscreen Document
 *
 * Runs in a hidden offscreen document (chrome.offscreen API).
 * Has access to getUserMedia and MediaRecorder — things the service worker
 * cannot use in MV3.
 *
 * Audio pipeline:
 *  - MediaRecorder fires ondataavailable every TIMESLICE_MS (500ms)
 *  - Raw data chunks are kept in a ring buffer (RING_SIZE slots)
 *  - Every SEND_EVERY slots, we assemble the full ring buffer into a blob
 *    and send it for transcription
 *  - Because the ring buffer always contains the last N seconds of audio,
 *    each blob overlaps with the previous one — no words get dropped at
 *    chunk boundaries
 *
 * Example with TIMESLICE_MS=500, RING_SIZE=12 (6s window), SEND_EVERY=6:
 *   t=0s:  ring=[0..5]   → send 6s blob
 *   t=3s:  ring=[6..11]  → send 6s blob (shares 3s with previous)
 *   t=6s:  ring=[12..17] → send 6s blob (shares 3s with previous)
 *
 * Message protocol with background.js (via chrome.runtime.onMessage):
 *  Incoming:
 *   { type: 'START_RECORDING', streamId: string, tabId: number }
 *   { type: 'STOP_RECORDING' }
 *  Outgoing:
 *   { type: 'AUDIO_CHUNK', payload: string (base64), mimeType: string, tabId: number }
 *   { type: 'ERROR',       payload: string, tabId: number }
 *   { type: 'STATUS',      payload: string, tabId: number }
 */

// How often MediaRecorder fires ondataavailable (ms)
const TIMESLICE_MS = 500;

// How many timeslice chunks to keep in the ring buffer.
// RING_SIZE * TIMESLICE_MS = total audio window sent to Whisper.
// 12 * 500ms = 6 seconds — enough context for accurate transcription.
const RING_SIZE = 12;

// Send a blob every N new timeslice chunks.
// SEND_EVERY * TIMESLICE_MS = how often a new transcript arrives.
// 6 * 500ms = every 3 seconds — feels live, with 3s of overlap from previous blob.
const SEND_EVERY = 6;

let mediaRecorder = null;
let audioContext  = null;
let currentTabId  = null;

// Ring buffer of raw Blob chunks from MediaRecorder
let ringBuffer  = [];
let chunksSince = 0; // how many new chunks since last send

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
 * @param {string} streamId
 * @param {number} tabId
 */
async function startRecording(streamId, tabId) {
  currentTabId = tabId;
  ringBuffer   = [];
  chunksSince  = 0;

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource:   'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    // ── Audio passthrough ──
    // Route the captured stream to speakers so the user can still hear the tab.
    audioContext = new AudioContext();
    audioContext.createMediaStreamSource(stream).connect(audioContext.destination);

    // ── MediaRecorder with timeslice ──
    // ondataavailable fires every TIMESLICE_MS with a small chunk of audio.
    // We accumulate these into a ring buffer and assemble overlapping blobs.
    mediaRecorder = new MediaRecorder(stream, { mimeType });

    mediaRecorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;

      // Add to ring buffer, drop oldest chunk if full
      ringBuffer.push(event.data);
      if (ringBuffer.length > RING_SIZE) {
        ringBuffer.shift();
      }

      chunksSince++;

      // Every SEND_EVERY new chunks, assemble and send the full ring buffer
      if (chunksSince >= SEND_EVERY && ringBuffer.length >= RING_SIZE) {
        chunksSince = 0;
        const blob = new Blob(ringBuffer, { type: mimeType });
        sendAudioChunk(blob, tabId);
      }
    };

    mediaRecorder.onerror = (event) => {
      sendToBackground({
        type:    'ERROR',
        payload: `Recorder error: ${event.error?.message}`,
        tabId,
      });
    };

    // Stop when the tab's audio track ends (tab closed, muted, etc.)
    stream.getAudioTracks()[0]?.addEventListener('ended', () => stopRecording());

    // Start recording — timeslice fires ondataavailable every TIMESLICE_MS
    mediaRecorder.start(TIMESLICE_MS);
    console.log(`[FactLens Offscreen] Recording started (${mimeType}, ${TIMESLICE_MS}ms timeslice)`);

  } catch (err) {
    console.error('[FactLens Offscreen] getUserMedia failed:', err.message);
    sendToBackground({ type: 'ERROR', payload: `Capture failed: ${err.message}`, tabId });
  }
}

/**
 * Stop the current recording session and release resources.
 */
function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  mediaRecorder = null;
  currentTabId  = null;
  ringBuffer    = [];
  chunksSince   = 0;
  console.log('[FactLens Offscreen] Recording stopped');
}

// ─── Transcription ───────────────────────────────────────────────────────────

/**
 * Encode an audio blob as base64 and send to background.js for transcription.
 * We send via the message bus rather than fetching directly because offscreen
 * documents have unreliable network access to localhost.
 * @param {Blob} blob
 * @param {number} tabId
 */
async function sendAudioChunk(blob, tabId) {
  if (blob.size < 1000) return; // skip silence

  sendToBackground({ type: 'STATUS', payload: 'processing', tabId });

  // Encode to base64 in 8KB chunks to avoid call stack overflow on large buffers
  const arrayBuffer = await blob.arrayBuffer();
  const bytes       = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  const base64 = btoa(binary);

  console.log(`[FactLens Offscreen] Sending ${blob.size} bytes (${(blob.size / 1024).toFixed(0)} KB)`);

  sendToBackground({
    type:     'AUDIO_CHUNK',
    payload:  base64,
    mimeType: blob.type,
    tabId,
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sendToBackground(message) {
  chrome.runtime.sendMessage(message).catch((err) => {
    console.warn('[FactLens Offscreen] sendToBackground error:', err.message);
  });
}
