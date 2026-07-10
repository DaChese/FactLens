/**
 * sidebar.js — FactLens Side Panel UI Controller (on-demand)
 *
 * Renders one unified "Community Note" per story — modeled on X/Twitter's
 * Community Notes: neutral added context with clickable sources, not a
 * verdict machine.
 *
 * Nothing is analyzed automatically. The viewer presses "Check now" to build
 * a note (story + context from other outlets + coverage spread), and can then
 * press "Check statements" on the note to fact-check specific claims.
 */

(function () {
  'use strict';

  // ─── DOM References ──────────────────────────────────────────────────────

  const statusDot    = document.getElementById('fl-status-dot');
  const statusLabel  = document.getElementById('fl-status-label');
  const stopBtn      = document.getElementById('fl-stop-btn');
  const checkBtn     = document.getElementById('fl-check-btn');
  const settingsBtn  = document.getElementById('fl-settings-btn');
  const notesList    = document.getElementById('fl-notes-list');
  const outletBadge  = document.getElementById('fl-outlet-badge');
  const clearNotes   = document.getElementById('fl-clear-notes');

  const PLACEHOLDER_HTML = '<p class="fl-placeholder">Press Check now while something is playing and a note about the story will appear here.</p>';

  const BIAS_LABELS = {
    'left':       'left',
    'lean-left':  'lean left',
    'center':     'center',
    'lean-right': 'lean right',
    'right':      'right',
  };

  // Neutral labels — context framing, not a "FACT CHECK" verdict machine
  const VERDICT_LABELS = {
    'True':       'Confirmed',
    'False':      'Disputed',
    'Unverified': 'Unclear',
  };

  const MAX_ARCHIVED_NOTES = 4;

  // ─── Note State ──────────────────────────────────────────────────────────

  function emptyNote() {
    return {
      story:          null,
      confidence:     null,
      matchedOn:      [],
      lowConfidence:  false,
      articles:       [],
      coverage:       null,
      missingContext: [],
      claims:         [],
      claimsChecked:  false, // "Check statements" has been run for this note
    };
  }

  let currentNote       = emptyNote();
  let coverageAvailable = true; // false once the backend reports no NewsAPI key

  // ─── Message Listener ────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message) => {
    const { type, payload } = message || {};
    if (!type) return;

    switch (type) {
      case 'STATUS':      updateStatus(payload);  break;
      case 'COVERAGE':    applyCoverage(payload); break;
      case 'FACTCHECK':   applyClaims(payload);   break;
      case 'NOTE_DONE':   resetCheckButton();     break;
      case 'CLAIMS_DONE': resetClaimsButton();    break;
      case 'ERROR':       showError(payload);     break;
      case 'TRANSCRIPT':
      case 'START_RECORDING':
      case 'STOP_RECORDING':
      case 'REQUEST_AUDIO':
      case 'AUDIO_CHUNK':
      case 'CAPTION_TEXT':
      case 'PAGE_SIGNALS':
        break;
      default:
        console.warn('[FactLens Sidebar] Unknown message type:', type);
    }
  });

  // ─── Header Buttons ──────────────────────────────────────────────────────

  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'STOP_SESSION' }).catch(() => {});
  });

  checkBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'ANALYZE_NOW' }).catch(() => {});
    checkBtn.disabled = true;
    checkBtn.textContent = 'Building note…';
  });

  function resetCheckButton() {
    checkBtn.disabled = false;
    checkBtn.textContent = 'Check now';
  }

  settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  clearNotes.addEventListener('click', () => {
    currentNote = emptyNote();
    notesList.innerHTML = PLACEHOLDER_HTML;
  });

  // ─── Status ──────────────────────────────────────────────────────────────

  function updateStatus(status) {
    statusDot.classList.remove('listening', 'processing');

    const labels = {
      idle:       'Idle',
      listening:  'Listening',
      processing: 'Working',
    };

    statusLabel.textContent = labels[status] ?? status;

    if (status === 'listening' || status === 'processing') {
      statusDot.classList.add(status);
      stopBtn.hidden = false;
      checkBtn.hidden = false;
      showReadyHintIfEmpty();
    } else {
      stopBtn.hidden = true;
      checkBtn.hidden = true;
      resetCheckButton();
      removeReadyHint();
    }
  }

  function showReadyHintIfEmpty() {
    if (notesList.querySelector('.fl-note')) return;
    if (notesList.querySelector('.fl-ready-hint')) return;
    const placeholder = notesList.querySelector('.fl-placeholder');
    if (placeholder) placeholder.remove();
    const hint = document.createElement('p');
    hint.className = 'fl-ready-hint';
    hint.textContent = 'Collecting audio and captions locally — press Check now whenever you want a note about what’s being discussed.';
    notesList.appendChild(hint);
  }

  function removeReadyHint() {
    const hint = notesList.querySelector('.fl-ready-hint');
    if (hint) hint.remove();
  }

  // ─── Applying Results to the Note ────────────────────────────────────────

  function applyCoverage(payload) {
    if (!payload) return;

    if (payload.outlet_bias) {
      outletBadge.hidden = false;
      outletBadge.textContent =
        `Watching: ${payload.outlet_bias.name} (${BIAS_LABELS[payload.outlet_bias.rating] ?? payload.outlet_bias.rating})`;
    }

    if (payload.available === false) {
      coverageAvailable = false;
      renderNotes();
      return;
    }
    coverageAvailable = true;

    if (!payload.story) {
      showError('No clear news story identified in this segment yet.');
      return;
    }

    // New story? Freeze the current note into history and start fresh.
    if (currentNote.story && payload.story !== currentNote.story) {
      archiveCurrentNote();
      currentNote = emptyNote();
    }

    currentNote.story          = payload.story;
    currentNote.confidence     = payload.confidence ?? null;
    currentNote.matchedOn      = payload.matched_on ?? [];
    currentNote.lowConfidence  = !!payload.low_confidence;
    currentNote.articles       = payload.articles ?? [];
    currentNote.coverage       = payload.coverage ?? null;
    currentNote.missingContext = payload.missing_context ?? [];
    renderNotes();
  }

  function applyClaims(results) {
    currentNote.claimsChecked = true;
    if (Array.isArray(results)) {
      for (const item of results) {
        if (!item?.claim) continue;
        const key = item.claim.trim().toLowerCase();
        if (currentNote.claims.some(c => c.claim.trim().toLowerCase() === key)) continue;
        currentNote.claims.push(item);
      }
    }
    renderNotes();
  }

  function archiveCurrentNote() {
    const liveCard = notesList.querySelector('.fl-note--live');
    if (!liveCard) return;
    liveCard.classList.remove('fl-note--live');
    liveCard.classList.add('fl-note--archived');
    // Frozen notes lose their action button
    liveCard.querySelector('.fl-note-actions')?.remove();

    const archived = notesList.querySelectorAll('.fl-note--archived');
    if (archived.length > MAX_ARCHIVED_NOTES) {
      archived[archived.length - 1].remove();
    }
  }

  // ─── Rendering ───────────────────────────────────────────────────────────

  function renderNotes() {
    removeReadyHint();
    const placeholder = notesList.querySelector('.fl-placeholder');
    if (placeholder) placeholder.remove();

    let liveCard = notesList.querySelector('.fl-note--live');
    if (!liveCard) {
      liveCard = document.createElement('article');
      liveCard.className = 'fl-note fl-note--live';
      notesList.prepend(liveCard);
    }
    liveCard.replaceChildren(...buildNoteContent(currentNote));
  }

  function buildNoteContent(note) {
    const parts = [];

    // ── Story headline + match evidence ──
    const heading = document.createElement('h3');
    heading.className = 'fl-note-story';
    heading.textContent = note.story ?? 'Current segment';
    parts.push(heading);

    const meta = document.createElement('p');
    meta.className = 'fl-note-meta';
    if (note.lowConfidence) {
      meta.textContent = 'Low-confidence story match — coverage withheld until independent signals agree.';
    } else if (note.matchedOn.length > 0) {
      const conf = note.confidence ? `${note.confidence} confidence` : '';
      meta.textContent = `Matched on: ${note.matchedOn.join(', ')}${conf ? ` · ${conf}` : ''}`;
    } else if (!coverageAvailable) {
      meta.textContent = 'Coverage comparison disabled — add a NewsAPI key in Settings to enable it.';
    }
    parts.push(meta);

    // ── Context other outlets reported (the heart of the note) ──
    if (note.missingContext.length > 0) {
      parts.push(subheading('Readers on other outlets also saw'));
      const list = document.createElement('ul');
      list.className = 'fl-note-context';
      note.missingContext.forEach((item) => {
        // Items are { text, outlet, url }; tolerate plain strings
        const text = typeof item === 'string' ? item : item?.text;
        if (!text) return;
        const li = document.createElement('li');
        li.appendChild(document.createTextNode(text + ' '));
        if (item?.url && item?.outlet) {
          const src = document.createElement('a');
          src.className = 'fl-context-source';
          src.href = item.url;
          src.target = '_blank';
          src.rel = 'noopener noreferrer';
          src.textContent = `(${item.outlet})`;
          li.appendChild(src);
        }
        list.appendChild(li);
      });
      parts.push(list);
    }

    // ── Coverage spread ──
    if (note.articles.length > 0) {
      parts.push(subheading('Who else is covering this'));

      const tally = note.coverage;
      if (tally) {
        const leftish  = (tally['left'] ?? 0) + (tally['lean-left'] ?? 0);
        const rightish = (tally['right'] ?? 0) + (tally['lean-right'] ?? 0);
        const center   = tally['center'] ?? 0;
        const summary  = document.createElement('p');
        summary.className = 'fl-note-summary';
        summary.textContent =
          `${note.articles.length} other outlet${note.articles.length === 1 ? '' : 's'} — ` +
          `${leftish} left-leaning, ${center} center, ${rightish} right-leaning.`;
        parts.push(summary);
      }

      const outlets = document.createElement('p');
      outlets.className = 'fl-note-outlets';
      note.articles.forEach((a, i) => {
        const link = document.createElement('a');
        link.href = a.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.title = a.title;
        link.textContent = a.bias ? `${a.outlet} (${BIAS_LABELS[a.bias] ?? a.bias})` : a.outlet;
        outlets.appendChild(link);
        if (i < note.articles.length - 1) outlets.appendChild(document.createTextNode(' · '));
      });
      parts.push(outlets);
    }

    // ── Checked statements ──
    if (note.claims.length > 0) {
      parts.push(subheading('Statements checked against the web'));
      const list = document.createElement('ul');
      list.className = 'fl-note-claims';
      note.claims.forEach((item) => {
        list.appendChild(buildClaimItem(item));
      });
      parts.push(list);
    } else if (note.claimsChecked) {
      const none = document.createElement('p');
      none.className = 'fl-note-summary';
      none.textContent = 'No specific checkable statements were found in this segment.';
      parts.push(none);
    }

    // ── Action: check statements (one /factcheck call, on request) ──
    if (note.story && !note.claimsChecked) {
      const actions = document.createElement('div');
      actions.className = 'fl-note-actions';
      const btn = document.createElement('button');
      btn.className = 'fl-btn fl-btn--small';
      btn.id = 'fl-claims-btn';
      btn.textContent = 'Check statements in this segment';
      btn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'CHECK_CLAIMS' }).catch(() => {});
        btn.disabled = true;
        btn.textContent = 'Checking statements…';
      });
      actions.appendChild(btn);
      parts.push(actions);
    }

    return parts;
  }

  function resetClaimsButton() {
    const btn = document.getElementById('fl-claims-btn');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Check statements in this segment';
    }
  }

  function buildClaimItem(item) {
    const { claim, verdict = 'Unverified', reasoning, sources = [] } = item;

    const li = document.createElement('li');
    li.className = 'fl-claim';

    const line = document.createElement('p');
    line.className = 'fl-claim-line';

    const tag = document.createElement('span');
    tag.className = 'fl-claim-tag';
    tag.textContent = VERDICT_LABELS[verdict] ?? 'Unclear';

    const text = document.createElement('span');
    text.textContent = ` ${claim}`;

    line.appendChild(tag);
    line.appendChild(text);
    li.appendChild(line);

    if (reasoning) {
      const why = document.createElement('p');
      why.className = 'fl-claim-reasoning';
      why.textContent = reasoning;
      li.appendChild(why);
    }

    if (sources.length > 0) {
      const srcs = document.createElement('p');
      srcs.className = 'fl-claim-sources';
      srcs.appendChild(document.createTextNode('Sources: '));
      sources.forEach((url, i) => {
        try {
          const domain = new URL(url).hostname.replace(/^www\./, '');
          const link = document.createElement('a');
          link.href = url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = domain;
          link.title = url;
          srcs.appendChild(link);
          if (i < sources.length - 1) srcs.appendChild(document.createTextNode(', '));
        } catch { /* skip malformed URLs */ }
      });
      li.appendChild(srcs);
    }

    return li;
  }

  function subheading(text) {
    const h = document.createElement('h4');
    h.className = 'fl-note-subheading';
    h.textContent = text;
    return h;
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
    setTimeout(() => banner.classList.remove('visible'), 5000);
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  chrome.runtime.sendMessage({ type: 'GET_STATUS' }).then((response) => {
    if (response?.type === 'STATUS') updateStatus(response.payload);
  }).catch(() => {});

  console.log('[FactLens] Side panel loaded.');
})();
