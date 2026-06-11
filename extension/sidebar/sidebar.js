/**
 * sidebar.js — FactLens Side Panel UI Controller
 */

(function () {
  'use strict';

  // ─── DOM References ──────────────────────────────────────────────────────

  const statusDot        = document.getElementById('fl-status-dot');
  const statusLabel      = document.getElementById('fl-status-label');
  const stopBtn          = document.getElementById('fl-stop-btn');
  const transcriptFeed   = document.getElementById('fl-transcript-feed');
  const factcheckList    = document.getElementById('fl-factcheck-list');
  const biasNeedle       = document.getElementById('fl-bias-needle');
  const biasFraming      = document.getElementById('fl-bias-framing');
  const emotionFill      = document.getElementById('fl-emotion-fill');
  const emotionValue     = document.getElementById('fl-emotion-value');
  const clearTranscript  = document.getElementById('fl-clear-transcript');
  const clearFactcheck   = document.getElementById('fl-clear-factcheck');
  const onboarding       = document.getElementById('fl-onboarding');
  const mainContent      = document.getElementById('fl-main');
  const backendBanner    = document.getElementById('fl-backend-banner');

  // ─── Message Listener ────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message) => {
    const { type, payload } = message || {};
    if (!type) return;

    console.log(`[FactLens Sidebar] Message received: ${type}`, payload);

    switch (type) {
      case 'STATUS':         updateStatus(payload);         break;
      case 'TRANSCRIPT':     appendTranscript(payload);     break;
      case 'FACTCHECK':      renderFactChecks(payload);     break;
      case 'BIAS':           updateBiasMeter(payload);      break;
      case 'ERROR':          showError(payload);            break;
      case 'BACKEND_STATUS': updateBackendStatus(payload);  break;
      // Internal messages — silently ignored by the sidebar
      case 'START_RECORDING':
      case 'STOP_RECORDING':
      case 'AUDIO_CHUNK':
        break;
      default:
        console.warn('[FactLens Sidebar] Unknown message type:', type);
    }
  });

  // ─── Stop Button ─────────────────────────────────────────────────────────

  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_SESSION' }).catch(() => {});
  });

  // ─── Clear Buttons ───────────────────────────────────────────────────────

  clearTranscript.addEventListener('click', () => {
    transcriptFeed.innerHTML = '<p class="fl-placeholder">Transcript will appear here once listening starts…</p>';
  });

  clearFactcheck.addEventListener('click', () => {
    factcheckList.innerHTML = '<p class="fl-placeholder">Claims will be verified as they are detected…</p>';
    renderedClaims.clear();
  });

  // ─── Onboarding / Main toggle ────────────────────────────────────────────

  /**
   * Show the main content panels and hide the onboarding screen.
   * Called the first time a session becomes active.
   */
  function showMain() {
    onboarding.hidden = true;
    mainContent.hidden = false;
  }

  /**
   * Show the onboarding screen and hide the main content.
   * Called when the session goes idle and no transcript has been captured yet.
   */
  function showOnboarding() {
    // Only go back to onboarding if there's no transcript content yet
    if (transcriptFeed.querySelector('.fl-transcript-chunk')) return;
    onboarding.hidden = false;
    mainContent.hidden = true;
  }

  // ─── Status ──────────────────────────────────────────────────────────────

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
      stopBtn.hidden = false;
      showMain();
      showSpinnerIfEmpty();
    } else {
      stopBtn.hidden = true;
      removeSpinner();
      showOnboarding();
    }
  }

  // ─── Spinner ─────────────────────────────────────────────────────────────

  function showSpinnerIfEmpty() {
    if (transcriptFeed.querySelector('.fl-transcript-chunk')) return;
    if (transcriptFeed.querySelector('.fl-spinner')) return;
    const placeholder = transcriptFeed.querySelector('.fl-placeholder');
    if (placeholder) placeholder.remove();
    const spinner = document.createElement('div');
    spinner.className = 'fl-spinner';
    spinner.id = 'fl-spinner';
    spinner.textContent = 'Listening for audio…';
    transcriptFeed.appendChild(spinner);
  }

  function removeSpinner() {
    const spinner = document.getElementById('fl-spinner');
    if (spinner) spinner.remove();
  }

  // ─── Transcript ──────────────────────────────────────────────────────────

  function appendTranscript(text) {
    removeSpinner();
    const placeholder = transcriptFeed.querySelector('.fl-placeholder');
    if (placeholder) placeholder.remove();

    const chunk = document.createElement('div');
    chunk.className = 'fl-transcript-chunk';

    const time = document.createElement('span');
    time.className = 'fl-transcript-time';
    time.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const textNode = document.createElement('span');
    textNode.textContent = text;

    chunk.appendChild(time);
    chunk.appendChild(textNode);
    transcriptFeed.appendChild(chunk);
    transcriptFeed.scrollTop = transcriptFeed.scrollHeight;
  }

  // ─── Fact-Check Cards ────────────────────────────────────────────────────

  const renderedClaims = new Set();
  const MAX_CARDS = 20;

  function renderFactChecks(results) {
    if (!Array.isArray(results) || results.length === 0) return;

    const placeholder = factcheckList.querySelector('.fl-placeholder');
    if (placeholder) placeholder.remove();

    results.forEach((item) => {
      const key = item.claim.trim().toLowerCase();
      if (renderedClaims.has(key)) return;
      renderedClaims.add(key);

      factcheckList.prepend(buildClaimCard(item));

      const cards = factcheckList.querySelectorAll('.fl-claim-card');
      if (cards.length > MAX_CARDS) cards[cards.length - 1].remove();
    });
  }

  function buildClaimCard(item) {
    const { claim, verdict, confidence = 0, sources = [] } = item;

    const card = document.createElement('div');
    card.className = `fl-claim-card ${verdict.toLowerCase()}`;

    // Header
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

    // Confidence bar
    const confBar = document.createElement('div');
    confBar.className = 'fl-confidence-bar';
    const confFill = document.createElement('div');
    confFill.className = 'fl-confidence-fill';
    confFill.style.width = `${Math.round(confidence * 100)}%`;
    confBar.appendChild(confFill);

    // Source links
    const sourcesEl = document.createElement('div');
    sourcesEl.className = 'fl-sources';
    sources.forEach((url) => {
      try {
        const domain = new URL(url).hostname.replace(/^www\./, '');
        const link = document.createElement('a');
        link.className = 'fl-source-link';
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = domain;
        link.title = url;
        sourcesEl.appendChild(link);
      } catch { /* skip malformed URLs */ }
    });

    card.appendChild(header);
    card.appendChild(confBar);

    if (item.reasoning) {
      const reasoning = document.createElement('p');
      reasoning.className = 'fl-claim-reasoning';
      reasoning.textContent = item.reasoning;
      card.appendChild(reasoning);
    }

    if (sources.length > 0) card.appendChild(sourcesEl);

    return card;
  }

  // ─── Bias Meter ──────────────────────────────────────────────────────────

  function updateBiasMeter({ lean_score = 0, emotion_score = 0, framing_label = '-' }) {
    const lean    = Math.max(-1, Math.min(1, Number(lean_score)    || 0));
    const emotion = Math.max(0,  Math.min(1, Number(emotion_score) || 0));

    biasNeedle.style.left = `${(((lean + 1) / 2) * 100).toFixed(1)}%`;
    biasFraming.textContent = framing_label || '-';

    const emotionPct = Math.round(emotion * 100);
    emotionFill.style.width = `${emotionPct}%`;
    emotionValue.textContent = `${emotionPct}%`;
  }

  function updateBackendStatus(status) {
    backendBanner.classList.remove('checking', 'warming');

    const messages = {
      checking: 'Checking the FactLens server...',
      warming:  'Server is waking up. This can take a few seconds on Railway.',
    };

    if (!messages[status]) {
      backendBanner.hidden = true;
      backendBanner.textContent = '';
      return;
    }

    backendBanner.textContent = messages[status];
    backendBanner.classList.add(status);
    backendBanner.hidden = false;
  }

  // ─── Error Banner ─────────────────────────────────────────────────────────

  function showError(message) {
    let banner = document.getElementById('fl-error-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'fl-error-banner';
      banner.className = 'fl-error-banner';
      const header = document.querySelector('.fl-header');
      header.insertAdjacentElement('afterend', banner);
    }
    banner.textContent = message;
    banner.classList.add('visible');
    setTimeout(() => banner.classList.remove('visible'), 6000);
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  chrome.runtime.sendMessage({ type: 'GET_STATUS' }).then((response) => {
    if (response?.type === 'STATUS') {
      updateStatus(response.payload);
      updateBackendStatus(response.backendStatus);
    }
  }).catch(() => {});

  console.log('[FactLens] Side panel loaded.');
})();
