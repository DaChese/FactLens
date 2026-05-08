/**
 * sidebar.js — FactLens Side Panel UI Controller
 *
 * Responsibilities:
 *  - Listen for messages from background.js via chrome.runtime.onMessage
 *    (the side panel is an extension page, so it shares the runtime message bus)
 *  - Update the status indicator
 *  - Append transcript chunks to the live feed
 *  - Render fact-check verdict cards with source links
 *  - Animate the bias meter needle and emotion bar
 *  - Display error banners when something goes wrong
 */

(function () {
  'use strict';

  // ─── DOM References ──────────────────────────────────────────────────────

  const statusDot      = document.getElementById('fl-status-dot');
  const statusLabel    = document.getElementById('fl-status-label');
  const transcriptFeed = document.getElementById('fl-transcript-feed');
  const factcheckList  = document.getElementById('fl-factcheck-list');
  const biasNeedle     = document.getElementById('fl-bias-needle');
  const biasFraming    = document.getElementById('fl-bias-framing');
  const emotionFill    = document.getElementById('fl-emotion-fill');
  const emotionValue   = document.getElementById('fl-emotion-value');

  // ─── Message Listener ────────────────────────────────────────────────────

  /**
   * The side panel is an extension page, so it receives messages directly
   * from background.js via chrome.runtime.onMessage — no postMessage bridge
   * needed (that was the iframe approach).
   *
   * Expected message shape: { type: string, payload: any }
   */
  chrome.runtime.onMessage.addListener((message) => {
    const { type, payload } = message || {};
    if (!type) return;

    switch (type) {
      case 'STATUS':
        updateStatus(payload);
        break;
      case 'TRANSCRIPT':
        appendTranscript(payload);
        break;
      case 'FACTCHECK':
        renderFactChecks(payload);
        break;
      case 'BIAS':
        updateBiasMeter(payload);
        break;
      case 'ERROR':
        showError(payload);
        break;
      // These are internal messages between background.js and offscreen.js
      // The sidebar receives them too (broadcast is extension-wide) but has
      // nothing to do with them — silently ignore.
      case 'START_RECORDING':
      case 'STOP_RECORDING':
        break;
      default:
        console.warn('[FactLens Sidebar] Unknown message type:', type);
    }
  });

  // ─── Status ──────────────────────────────────────────────────────────────

  /**
   * Update the header status indicator dot and label.
   * @param {'idle'|'listening'|'processing'} status
   */
  function updateStatus(status) {
    statusDot.classList.remove('listening', 'processing');

    const labels = {
      idle:       'Idle',
      listening:  'Listening',
      processing: 'Processing',
    };

    statusLabel.textContent = labels[status] ?? status;

    if (status === 'listening' || status === 'processing') {
      statusDot.classList.add(status);
    }
  }

  // ─── Transcript ──────────────────────────────────────────────────────────

  /**
   * Append a new transcript chunk to the scrollable feed.
   * Removes the placeholder text on the first real chunk.
   * @param {string} text
   */
  function appendTranscript(text) {
    const placeholder = transcriptFeed.querySelector('.fl-placeholder');
    if (placeholder) placeholder.remove();

    const chunk = document.createElement('p');
    chunk.className = 'fl-transcript-chunk';
    chunk.textContent = text;
    transcriptFeed.appendChild(chunk);

    // Auto-scroll to the latest chunk
    transcriptFeed.scrollTop = transcriptFeed.scrollHeight;
  }

  // ─── Fact-Check Cards ────────────────────────────────────────────────────

  /**
   * Render an array of fact-check results as verdict cards.
   * Newest results are prepended so they appear at the top.
   * @param {Array<{claim: string, verdict: string, confidence: number, sources: string[]}>} results
   */
  function renderFactChecks(results) {
    if (!Array.isArray(results) || results.length === 0) return;

    const placeholder = factcheckList.querySelector('.fl-placeholder');
    if (placeholder) placeholder.remove();

    results.forEach((item) => {
      factcheckList.prepend(buildClaimCard(item));
    });
  }

  /**
   * Build a single claim card DOM element.
   * @param {{claim: string, verdict: string, confidence: number, sources: string[]}} item
   * @returns {HTMLElement}
   */
  function buildClaimCard(item) {
    const { claim, verdict, confidence = 0, sources = [] } = item;

    const card = document.createElement('div');
    card.className = 'fl-claim-card';

    // ── Header: claim text + verdict badge ──
    const header = document.createElement('div');
    header.className = 'fl-claim-header';

    const claimText = document.createElement('span');
    claimText.className = 'fl-claim-text';
    claimText.textContent = claim;

    const badge = document.createElement('span');
    badge.className = `fl-verdict ${verdict.toLowerCase()}`;
    badge.textContent = verdict;

    header.appendChild(claimText);
    header.appendChild(badge);

    // ── Confidence bar ──
    const confBar = document.createElement('div');
    confBar.className = 'fl-confidence-bar';
    const confFill = document.createElement('div');
    confFill.className = 'fl-confidence-fill';
    confFill.style.width = `${Math.round(confidence * 100)}%`;
    confBar.appendChild(confFill);

    // ── Source links ──
    const sourcesEl = document.createElement('div');
    sourcesEl.className = 'fl-sources';
    sources.forEach((url, i) => {
      const link = document.createElement('a');
      link.className = 'fl-source-link';
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `Source ${i + 1}`;
      sourcesEl.appendChild(link);
    });

    card.appendChild(header);
    card.appendChild(confBar);
    if (sources.length > 0) card.appendChild(sourcesEl);

    return card;
  }

  // ─── Bias Meter ──────────────────────────────────────────────────────────

  /**
   * Update the bias needle position and emotion bar.
   * @param {{lean_score: number, emotion_score: number, framing_label: string}} data
   *   lean_score:    -1.0 (far left) → 0.0 (center) → +1.0 (far right)
   *   emotion_score:  0.0 (neutral)  → 1.0 (highly charged)
   *   framing_label: plain-English description
   */
  function updateBiasMeter({ lean_score = 0, emotion_score = 0, framing_label = '—' }) {
    // Convert lean_score (-1 to +1) → CSS left percentage (0% to 100%)
    const leftPct = ((lean_score + 1) / 2) * 100;
    biasNeedle.style.left = `${leftPct.toFixed(1)}%`;

    biasFraming.textContent = framing_label || '—';

    const emotionPct = Math.round(Math.min(Math.max(emotion_score, 0), 1) * 100);
    emotionFill.style.width = `${emotionPct}%`;
    emotionValue.textContent = `${emotionPct}%`;
  }

  // ─── Error Banner ─────────────────────────────────────────────────────────

  /**
   * Show a dismissible error banner at the top of the panel.
   * Auto-hides after 5 seconds.
   * @param {string} message
   */
  function showError(message) {
    let banner = document.getElementById('fl-error-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'fl-error-banner';
      banner.className = 'fl-error-banner';
      // Insert after the header
      const header = document.querySelector('.fl-header');
      header.insertAdjacentElement('afterend', banner);
    }
    banner.textContent = message;
    banner.classList.add('visible');
    setTimeout(() => banner.classList.remove('visible'), 5000);
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  // When the panel first loads, ask the background script for the current
  // session status. This handles the race condition where the STATUS message
  // was broadcast before the panel's onMessage listener was registered.
  chrome.runtime.sendMessage({ type: 'GET_STATUS' }).then((response) => {
    if (response?.type === 'STATUS') updateStatus(response.payload);
  }).catch(() => {
    // Background may not be ready yet — safe to ignore
  });

  console.log('[FactLens] Side panel loaded and ready.');
})();
