/**
 * offscreen.js — FactLens Offscreen Document
 *
 * Runs in a hidden offscreen document (chrome.offscreen API).
 * Has access to getUserMedia and MediaRecorder — things the service worker
 * cannot use in MV3.
 *
 * Audio pipeline (on-demand — nothing is sent anywhere on a timer):
 *  - MediaRecorder fires ondataavailable every TIMESLICE_MS (500ms)
 *  - Raw data chunks are kept in a rolling ring buffer holding the last
 *    RING_SIZE slots (~90 seconds of audio)
 *  - Recording costs nothing — audio only leaves this document when the
 *    service worker sends REQUEST_AUDIO (the viewer pressed "Check now"),
 *    at which point the whole ring is assembled into ONE blob and sent
 *    for a single transcription call
 *
 * Message protocol with background.js (via chrome.runtime.onMessage):
 *  Incoming:
 *   { type: 'START_RECORDING', streamId: string, tabId: number }
 *   { type: 'STOP_RECORDING' }
 *   { type: 'REQUEST_AUDIO' }   ← assemble + send the current ring buffer
 *  Outgoing:
 *   { type: 'AUDIO_CHUNK', payload: string (base64), mimeType: string, tabId: number }
 *   { type: 'ERROR',       payload: string, tabId: number }
 *   { type: 'STATUS',      payload: string, tabId: number }
 */

// How often MediaRecorder fires ondataavailable (ms)
const TIMESLICE_MS = 500;

// How many timeslice chunks to keep in the ring buffer.
// RING_SIZE * TIMESLICE_MS = the audio window sent to Whisper on request.
// 180 * 500ms = the last 90 seconds — enough context for a full note.
const RING_SIZE = 180;

let mediaRecorder = null;
let audioContext  = null;
let currentTabId  = null;

// The first chunk from MediaRecorder contains the WebM initialization segment
// (codec info, container headers). We must prepend it to every blob we send
// to Groq, otherwise the file is invalid and Whisper rejects it.
let headerChunk = null;

// Ring buffer of raw Blob chunks from MediaRecorder (audio data only, no header)
let ringBuffer = [];

// ─── Message Handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'START_RECORDING':
      startRecording(message.streamId, message.tabId);
      break;
    case 'STOP_RECORDING':
      stopRecording();
      break;
    case 'REQUEST_AUDIO':
      sendBufferedAudio();
      break;
  }
});

/**
 * Assemble the current ring buffer into one blob and send it for
 * transcription. Called only when the viewer presses "Check now".
 */
function sendBufferedAudio() {
  if (!mediaRecorder || !headerChunk || ringBuffer.length === 0) {
    sendToBackground({ type: 'ERROR', payload: 'No audio captured yet — wait a few seconds and try again.', tabId: currentTabId });
    return;
  }
  const blob = new Blob([headerChunk, ...ringBuffer], { type: mediaRecorder.mimeType });
  sendAudioChunk(blob, currentTabId);
}

// ─── Recording ───────────────────────────────────────────────────────────────

/**
 * Start capturing audio using the stream ID provided by background.js.
 * @param {string} streamId
 * @param {number} tabId
 */
async function startRecording(streamId, tabId) {
  currentTabId = tabId;
  ringBuffer   = [];
  headerChunk  = null;

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

      // The very first chunk is the WebM initialization segment — save it
      // separately and always prepend it to every blob we send.
      if (!headerChunk) {
        headerChunk = event.data;
        return; // don't add the header to the ring buffer
      }

      // Add audio data to ring buffer, drop oldest if full.
      // Nothing is sent from here — audio leaves only on REQUEST_AUDIO.
      ringBuffer.push(event.data);
      if (ringBuffer.length > RING_SIZE) {
        ringBuffer.shift();
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
  // Stop all audio tracks to fully release the tab capture
  if (mediaRecorder?.stream) {
    mediaRecorder.stream.getTracks().forEach(track => track.stop());
  }
  mediaRecorder = null;
  currentTabId  = null;
  ringBuffer    = [];
  headerChunk   = null;
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
