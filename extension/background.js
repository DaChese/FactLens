/**
 * background.js — FactLens Service Worker (on-demand architecture)
 *
 * Opening the side panel does nothing by itself — a session only begins when
 * the viewer presses Start (in-panel button; the toolbar icon just opens the
 * panel). While a session is active, the extension only *collects* for free:
 *  - the offscreen document keeps a rolling ~60s audio ring buffer (local)
 *  - the content script streams caption text and page signals (local)
 *
 * Start schedules exactly ONE automatic Check-now-equivalent pass
 * AUTO_CHECK_DELAY_MS later (see autoRunAndStop), after which the session
 * stops itself — "press Start, see what it's about, done." Nothing repeats
 * or polls; that one pass is the only place a paid API gets called unless
 * the viewer acts again:
 *  - "Check now" (manual, before the timer fires) → ANALYZE_NOW → builds the
 *       note early instead of waiting, and cancels the pending auto-check
 *  - "Check statements" → CHECK_CLAIMS → ONE /factcheck call on the note's
 *       transcript (claim extraction + up to 2 web-searched verdicts)
 *  - "Check public reaction" → CHECK_DISCUSSION → ONE /discussion call
 *       reusing the note's story query (Tavily search + one summary call)
 *    Both of these work even after the session has auto-stopped — they only
 *    need the stored transcript/query, not a live capture session.
 *
 * This mirrors the ATSC 3.0 target: on a real NextGen TV, captions arrive
 * free with the broadcast (CEA-708) and the note is triggered by a remote
 * button press — the browser prototype demonstrates the same architecture.
 *
 * Session state lives in chrome.storage.session (survives SW restarts).
 */

const DEFAULT_BACKEND_URL = 'https://factlens-production.up.railway.app';

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
const lastNoteQuery      = {}; // tabId → search query (from /coverage) for CHECK_DISCUSSION
const pendingAudio       = {}; // tabId → { resolve, reject, timer } awaiting AUDIO_CHUNK

// How long after Start to automatically run one Check-now-equivalent pass if
// the viewer hasn't already pressed Check now themselves. This is an OUTER
// fallback only, for the rare page with no usable title at all — in the
// normal case, real page signals arrive within ~1s and the much shorter
// AUTO_CHECK_FAST_DELAY_MS timer below takes over instead (see
// scheduleFastCheck). A page title alone is often enough to identify the
// story, so there's no reason to wait a flat 20s for spoken transcript.
const AUTO_CHECK_MAX_WAIT_MS  = 20000;
const AUTO_CHECK_FAST_DELAY_MS = 5000;
const autoCheckTimers     = {}; // tabId → setTimeout handle
const fastCheckScheduled  = {}; // tabId → boolean, true once scheduled (once per session)

// If the video is paused, hold off the automatic check entirely — there's
// nothing new to check, and firing anyway would just spend an API call on a
// stale moment. Resumes with the same scheduling logic used at session start.
const videoPaused  = {}; // tabId → boolean
const autoCheckFired = {}; // tabId → true once the automatic check process is fully done (no more retries pending)

// A miss (no story identified, or low confidence) doesn't give up — it
// retries, since the free local collection (captions, page signals) keeps
// improving with more time. Bounded on purpose: "keep trying" must not mean
// "keep trying forever" and silently draining the API budget.
const MAX_AUTO_CHECK_ATTEMPTS   = 3;  // the original attempt + up to 2 retries
const AUTO_CHECK_RETRY_DELAY_MS = 15000; // time between retries for more context to accumulate
const autoCheckAttempts = {}; // tabId → number of attempts made this session
const lastAttemptGuess  = {}; // tabId → { story, query } from a previous non-final attempt

// Opening the panel is deliberately inert — it never starts a session on its
// own. Session control lives entirely in the panel's Start/Stop buttons.
chrome.action.onClicked.addListener((tab) => {
  if (!tab.id) return;
  // Must be called synchronously — Chrome requires a direct user gesture
  chrome.sidePanel.open({ tabId: tab.id });
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
 * Start a capture session. Recording and caption collection begin for free;
 * one automatic Check-now-equivalent pass is scheduled for AUTO_CHECK_DELAY_MS
 * later (see autoRunAndStop) unless the viewer presses Check now sooner.
 */
async function startSession(tab) {
  await setSessionActive(tab.id);
  transcriptBuffers[tab.id] = [];
  fastCheckScheduled[tab.id] = false;
  videoPaused[tab.id] = false;
  autoCheckFired[tab.id] = false;
  autoCheckAttempts[tab.id] = 0;
  delete lastAttemptGuess[tab.id];

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

    autoCheckTimers[tab.id] = setTimeout(() => autoRunAndStop(tab.id), AUTO_CHECK_MAX_WAIT_MS);

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
 * Automatic follow-through on Start: run a note-build attempt and decide
 * whether to retry or stop based on what happened. A miss (no story found,
 * or the consensus check flagged low confidence) doesn't give up — the free
 * local collection keeps improving with more time, so it retries up to
 * MAX_AUTO_CHECK_ATTEMPTS total before finally stopping. A real success, a
 * config problem (no NewsAPI key), or a hard error all stop immediately —
 * retrying any of those can't help. If the viewer already pressed Check now,
 * ANALYZE_NOW cancels whatever timer is pending first, so this never
 * double-fires against a manual check.
 * @param {number} tabId
 */
async function autoRunAndStop(tabId) {
  delete autoCheckTimers[tabId];
  if (!(await getSessionActive(tabId))) return; // stopped manually before this fired

  autoCheckAttempts[tabId] = (autoCheckAttempts[tabId] ?? 0) + 1;
  const outcome = await buildNote(tabId);

  const retryable = outcome === 'no_story' || outcome === 'low_confidence' || outcome === 'insufficient_input';
  const canRetry  = autoCheckAttempts[tabId] < MAX_AUTO_CHECK_ATTEMPTS;

  if (retryable && canRetry) {
    console.log(`[FactLens] Attempt ${autoCheckAttempts[tabId]}/${MAX_AUTO_CHECK_ATTEMPTS} (${outcome}) — still listening, retrying in ${AUTO_CHECK_RETRY_DELAY_MS / 1000}s`);
    autoCheckTimers[tabId] = setTimeout(() => autoRunAndStop(tabId), AUTO_CHECK_RETRY_DELAY_MS);
    return; // keep the session alive — do NOT stop
  }

  if (retryable) {
    console.log(`[FactLens] Gave up after ${autoCheckAttempts[tabId]} attempts (${outcome})`);
  }
  autoCheckFired[tabId] = true; // fully done — either a result landed or the cap was hit
  await stopSession(tabId);
}

function clearAutoCheckTimer(tabId) {
  if (autoCheckTimers[tabId]) {
    clearTimeout(autoCheckTimers[tabId]);
    delete autoCheckTimers[tabId];
  }
}

/**
 * Re-arm the automatic check after the video resumes from a pause that
 * interrupted it. Only relevant if the automatic process isn't already fully
 * done and nothing else is currently pending. Uses the retry delay once at
 * least one attempt has already happened, otherwise the same fast-path-vs-
 * outer-fallback choice used at session start.
 * @param {number} tabId
 */
async function rescheduleAfterResume(tabId) {
  if (autoCheckFired[tabId]) return;      // fully done — no more attempts coming
  if (autoCheckTimers[tabId]) return;     // something's already pending
  if (!(await getSessionActive(tabId))) return;

  const delay = (autoCheckAttempts[tabId] ?? 0) > 0
    ? AUTO_CHECK_RETRY_DELAY_MS
    : (pageSignals[tabId] ? AUTO_CHECK_FAST_DELAY_MS : AUTO_CHECK_MAX_WAIT_MS);
  autoCheckTimers[tabId] = setTimeout(() => autoRunAndStop(tabId), delay);
}

/**
 * Once real page signals arrive (near-instant after Start — content.js sends
 * them immediately, not on a poll delay), replace the outer AUTO_CHECK_MAX_WAIT_MS
 * fallback with a much shorter timer. A page title/description is often a
 * complete signal on its own; the short delay just gives a beat for a little
 * caption or audio text to land alongside it. Only ever schedules once per
 * session — repeated PAGE_SIGNALS updates (every ~8s) don't keep pushing it back.
 * @param {number} tabId
 */
async function scheduleFastCheck(tabId) {
  if (fastCheckScheduled[tabId]) return;
  if (!(await getSessionActive(tabId))) return;
  fastCheckScheduled[tabId] = true;

  clearAutoCheckTimer(tabId);
  autoCheckTimers[tabId] = setTimeout(() => autoRunAndStop(tabId), AUTO_CHECK_FAST_DELAY_MS);
}

/**
 * Stop the current session and tear down the offscreen document. Keeps
 * lastNoteTranscript/lastNoteQuery intact (see clearCaptureState) so "Check
 * statements" and "Check public reaction" keep working on the note that was
 * already built, even after the session auto-stops.
 * @param {number} tabId
 */
async function stopSession(tabId) {
  clearCaptureState(tabId);

  chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }).catch(() => {});

  await closeOffscreenDocument();
  await clearSessionActive(tabId);
  broadcast({ type: 'STATUS', payload: 'idle' });
  console.log(`[FactLens] Session stopped for tab ${tabId}`);
}

/**
 * Clear capture-in-progress state — called on every Stop (manual or
 * automatic). Deliberately does NOT touch lastNoteTranscript/lastNoteQuery;
 * those represent the note itself, not the capture session, and stay
 * actionable ("Check statements" / "Check public reaction") after stopping.
 */
function clearCaptureState(tabId) {
  delete transcriptBuffers[tabId];
  delete detectedLanguages[tabId];
  delete lastCaptions[tabId];
  delete lastCaptionAt[tabId];
  delete pageSignals[tabId];
  delete noteBuilding[tabId];
  delete fastCheckScheduled[tabId];
  delete videoPaused[tabId];
  delete autoCheckFired[tabId];
  delete autoCheckAttempts[tabId];
  delete lastAttemptGuess[tabId];
  clearAutoCheckTimer(tabId);
  if (pendingAudio[tabId]) {
    clearTimeout(pendingAudio[tabId].timer);
    pendingAudio[tabId].reject(new Error('Session stopped'));
    delete pendingAudio[tabId];
  }
}

/**
 * Full teardown — only for when the tab itself is gone (chrome.tabs.onRemoved)
 * or a session failed to start. Unlike clearCaptureState, this also drops the
 * note data, since there's no tab left for "Check statements" to apply to.
 */
function cleanupTabState(tabId) {
  clearCaptureState(tabId);
  delete lastNoteTranscript[tabId];
  delete lastNoteQuery[tabId];
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

    // Page title / headline / image metadata from the content script —
    // arrives near-instantly after Start, so it's what drives the fast check.
    case 'PAGE_SIGNALS':
      if (sender.tab?.id && message.payload) {
        pageSignals[sender.tab.id] = message.payload;
        scheduleFastCheck(sender.tab.id);
      }
      break;

    // Video paused/resumed (from content.js) — hold off the automatic check
    // while paused so it doesn't spend an API call on a stale moment, and
    // pick back up when playback resumes.
    case 'VIDEO_PAUSED':
      if (sender.tab?.id) {
        videoPaused[sender.tab.id] = true;
        clearAutoCheckTimer(sender.tab.id);
      }
      break;

    case 'VIDEO_PLAYING':
      if (sender.tab?.id) {
        videoPaused[sender.tab.id] = false;
        rescheduleAfterResume(sender.tab.id);
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

    // "Check now" — build a Community Note for the active session.
    // Cancels the pending auto-check timer first so Start's automatic pass
    // never double-fires on top of a manual one.
    case 'ANALYZE_NOW':
      chrome.storage.session.get('activeSessions').then(({ activeSessions = {} }) => {
        Object.keys(activeSessions).forEach(tabId => {
          clearAutoCheckTimer(Number(tabId));
          buildNote(Number(tabId));
        });
      });
      break;

    // "Check statements" / "Check public reaction" on the note — these only
    // need the stored transcript/query from the last note, not a live
    // capture session, so they work whether or not the session already
    // auto-stopped. Resolve the tab from the note data itself rather than
    // chrome.tabs.query({currentWindow: true}) — that API is ambiguous when
    // called from a service worker (not attached to any particular window),
    // and can resolve to the wrong tab entirely. lastNoteTranscript is only
    // ever populated for the tab that actually built a note, so it's the
    // reliable source of truth.
    case 'CHECK_CLAIMS': {
      const tabId = Object.keys(lastNoteTranscript).map(Number)[0];
      if (tabId) {
        runClaimCheck(tabId);
      } else {
        broadcast({ type: 'ERROR', payload: 'Build a note first (Check now), then check its statements.' });
        broadcast({ type: 'CLAIMS_DONE' });
      }
      break;
    }

    case 'CHECK_DISCUSSION': {
      const tabId = Object.keys(lastNoteTranscript).map(Number)[0];
      if (tabId) {
        runDiscussionCheck(tabId);
      } else {
        broadcast({ type: 'ERROR', payload: 'Build a note first (Check now), then check public reaction.' });
        broadcast({ type: 'DISCUSSION_DONE' });
      }
      break;
    }

    // Thumbs down on a note's story — evicts that story's cached coverage
    // backend-side (see /coverage/feedback). Thumbs up is acknowledged but
    // has no effect on future checks; the sidebar handles dismissal itself.
    case 'RATE_NOTE':
      if (message.query) {
        sendNoteFeedback(message.query, message.helpful).catch((err) => {
          console.warn('[FactLens] sendNoteFeedback error:', err.message);
        });
      }
      break;

    // In-panel Start button — same effect as clicking the toolbar icon while idle,
    // but discoverable from inside the side panel itself.
    case 'START_SESSION':
      chrome.tabs.query({ active: true, currentWindow: true }).then(async ([tab]) => {
        if (!tab?.id) return;
        if (await getSessionActive(tab.id)) return; // already running — ignore
        await startSession(tab);
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
 * 0-1 transcription + 2 LLM calls + 1 NewsAPI request. Missing context and
 * framing are produced by the same synthesis call.
 *
 * Returns an outcome string so the caller (autoRunAndStop) can decide whether
 * to retry: 'success' | 'no_story' | 'low_confidence' | 'unavailable' |
 * 'insufficient_input' | 'error' | 'busy'.
 * @param {number} tabId
 * @returns {Promise<string>}
 */
async function buildNote(tabId) {
  if (noteBuilding[tabId]) {
    console.log('[FactLens] Note already being built, ignoring');
    return 'busy';
  }
  noteBuilding[tabId] = true;
  broadcast({ type: 'STATUS', payload: 'processing' });

  try {
    const captionsFresh = lastCaptionAt[tabId] && (Date.now() - lastCaptionAt[tabId]) < CAPTION_USABLE_MS;
    const buffer         = transcriptBuffers[tabId];
    const usingCaptions  = captionsFresh && buffer && buffer.length > 0;
    broadcast({
      type: 'PROGRESS',
      payload: usingCaptions
        ? `Reading ${buffer.length} word${buffer.length === 1 ? '' : 's'} from captions`
        : 'Transcribing whatever audio has been captured so far',
    });

    const { text, language } = await getTranscript(tabId);
    const wordCount = text?.trim() ? text.trim().split(/\s+/).length : 0;

    // A story can be identified from the page title/description alone (the
    // fast path) — only bail out here if there's truly nothing to work with,
    // neither speech nor page signals.
    const signals = pageSignals[tabId] ?? {};
    const hasPageSignals = !!(signals.pageTitle || signals.onScreenText);
    if (wordCount === 0 && !hasPageSignals) {
      broadcast({ type: 'ERROR', payload: 'Not enough info captured yet — still listening for more.' });
      return 'insufficient_input';
    }

    lastNoteTranscript[tabId] = { text: text ?? '', language };
    console.log(`[FactLens] Building note from ${wordCount} words (${language}), page signals: ${hasPageSignals}`);

    broadcast({
      type: 'PROGRESS',
      payload: wordCount > 0
        ? `Got a ${wordCount}-word transcript — identifying the story and checking coverage`
        : 'Identifying the story from the page — checking coverage',
    });
    const coverage = await fetchCoverage(tabId, text ?? '', language, lastAttemptGuess[tabId] ?? null);
    if (coverage.query) lastNoteQuery[tabId] = coverage.query;
    broadcast({ type: 'COVERAGE', payload: coverage });

    if (coverage.available === false) return 'unavailable';
    if (!coverage.story) return 'no_story'; // leaves any earlier guess in place for the next attempt
    if (coverage.low_confidence) {
      lastAttemptGuess[tabId] = { story: coverage.story, query: coverage.query };
      return 'low_confidence';
    }
    delete lastAttemptGuess[tabId]; // succeeded — no longer needed
    return 'success';

  } catch (err) {
    console.error('[FactLens] buildNote error:', err.message);
    broadcast({ type: 'ERROR', payload: `Could not build note: ${err.message}` });
    return 'error';
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
  broadcast({ type: 'PROGRESS', payload: 'Searching the web for these statements' });
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
 * "Check public reaction" — search public discussion for the last note's
 * story and summarize its tenor. One /discussion call. Never runs
 * automatically; distinct from and never blended with the note's outlet
 * coverage, which comes from /coverage instead.
 * @param {number} tabId
 */
async function runDiscussionCheck(tabId) {
  const query = lastNoteQuery[tabId];
  if (!query) {
    broadcast({ type: 'ERROR', payload: 'Build a note first (Check now), then check public reaction.' });
    broadcast({ type: 'DISCUSSION_DONE' });
    return;
  }

  broadcast({ type: 'STATUS', payload: 'processing' });
  broadcast({ type: 'PROGRESS', payload: `Searching for public reaction to: "${query}"` });
  try {
    const discussion = await fetchDiscussion(query, lastNoteTranscript[tabId]?.language);
    broadcast({ type: 'DISCUSSION', payload: discussion });
  } catch (err) {
    console.error('[FactLens] runDiscussionCheck error:', err.message);
    broadcast({ type: 'ERROR', payload: `Public reaction check failed: ${err.message}` });
  } finally {
    broadcast({ type: 'STATUS', payload: 'listening' });
    broadcast({ type: 'DISCUSSION_DONE' });
  }
}

/**
 * Get a transcript for the note. Captions are free and more accurate, so
 * whenever they're actively flowing, use whatever the caption buffer holds —
 * even a handful of words — and skip Whisper entirely. There's no minimum
 * word count: a partial caption buffer is still real, free, accurate text,
 * and worth more than waiting for a Whisper call that costs an API credit.
 * Only falls back to transcribing the buffered audio ring when captions
 * aren't available at all.
 * @param {number} tabId
 * @returns {Promise<{ text: string, language: string }>}
 */
async function getTranscript(tabId) {
  const buffer        = transcriptBuffers[tabId];
  const captionsFresh = lastCaptionAt[tabId] && (Date.now() - lastCaptionAt[tabId]) < CAPTION_USABLE_MS;

  if (captionsFresh && buffer && buffer.length > 0) {
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

  if (!res.ok) throw await describeFailedResponse(res);

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

/**
 * Turn a failed backend response into a clear, actionable error message
 * instead of a bare status code. The backend already sends a real message in
 * the JSON body (e.g. "401 Invalid API Key") — this just makes sure the
 * extension actually surfaces it, and adds a pointer to Settings for auth
 * failures specifically, since that's the most common real-world cause.
 * @param {Response} res
 * @returns {Promise<Error>}
 */
async function describeFailedResponse(res) {
  const body = await res.json().catch(() => ({}));
  const backendMessage = body.error || res.statusText || `HTTP ${res.status}`;

  if (res.status === 401 || res.status === 403 || /\b401\b|\bunauthorized\b|invalid api key/i.test(backendMessage)) {
    return new Error(`${backendMessage} — check your API keys in Settings`);
  }
  if (res.status === 429) {
    return new Error(backendMessage); // already a clear rate-limit/budget message from the backend
  }
  return new Error(backendMessage);
}

async function fetchFactCheck(text, language = 'english') {
  const settings = await getSettings();
  const res = await fetchWithTimeout(`${settings.backendUrl}/factcheck`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...buildKeyHeaders(settings) },
    body:    JSON.stringify({ transcript: text, language }),
  });
  if (!res.ok) throw await describeFailedResponse(res);
  return res.json();
}

/**
 * Fetch multi-outlet coverage + missing context for the current story.
 * Sends the tab's hostname and scraped page signals so the backend can
 * cross-check the story identification.
 */
async function fetchCoverage(tabId, text, language = 'english', previousGuess = null) {
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
      previousGuess,
    }),
  });
  if (!res.ok) throw await describeFailedResponse(res);
  return res.json();
}

/**
 * Fetch a public-discussion summary for the note's story query.
 */
async function fetchDiscussion(query, language = 'english') {
  const settings = await getSettings();
  const res = await fetchWithTimeout(`${settings.backendUrl}/discussion`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...buildKeyHeaders(settings) },
    body:    JSON.stringify({ query, language }),
  });
  if (!res.ok) throw await describeFailedResponse(res);
  return res.json();
}

/**
 * Send thumbs up/down on a note's story identification. Thumbs down tells
 * the backend to forget its cached coverage for that story, so a repeat
 * check doesn't reuse the same wrong result. This is not free-form — it
 * costs no external API call, just a local cache eviction.
 */
async function sendNoteFeedback(query, helpful) {
  const settings = await getSettings();
  const res = await fetchWithTimeout(`${settings.backendUrl}/coverage/feedback`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', ...buildKeyHeaders(settings) },
    body:    JSON.stringify({ query, helpful }),
  });
  if (!res.ok) throw await describeFailedResponse(res);
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
