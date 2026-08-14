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
  const startBtn     = document.getElementById('fl-start-btn');
  const stopBtn      = document.getElementById('fl-stop-btn');
  const checkBtn     = document.getElementById('fl-check-btn');
  const settingsBtn  = document.getElementById('fl-settings-btn');
  const notesList    = document.getElementById('fl-notes-list');
  const activityLine = document.getElementById('fl-activity');
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
      query:          null, // search query from /coverage — needed to rate/dismiss
      confidence:     null,
      matchedOn:      [],
      lowConfidence:  false,
      articles:       [],
      coverage:       null,
      missingContext: [],
      framingAnalysis: null,
      claims:         [],
      claimsChecked:  false, // "Check statements" has been run for this note
      discussion:        null,  // { summary, sources } from /discussion
      discussionAvailable: true, // false once the backend reports no Tavily key
      discussionChecked: false, // "Check public reaction" has been run for this note
      rating:         null, // 'up' once marked helpful — 'down' dismisses the note entirely
    };
  }

  let currentNote       = emptyNote();
  let coverageAvailable = true; // false once the backend reports no NewsAPI key

  // ─── Message Listener ────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message) => {
    const { type, payload } = message || {};
    if (!type) return;

    switch (type) {
      case 'STATUS':         updateStatus(payload);    break;
      case 'PROGRESS':       showActivity(payload);    break;
      case 'COVERAGE':       applyCoverage(payload);   break;
      case 'FACTCHECK':      applyClaims(payload);     break;
      case 'DISCUSSION':     applyDiscussion(payload); break;
      case 'NOTE_DONE':      resetCheckButton();       break;
      case 'CLAIMS_DONE':    resetClaimsButton();      break;
      case 'DISCUSSION_DONE': resetDiscussionButton(); break;
      case 'ERROR':          showError(payload);       break;
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

  startBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'START_SESSION' }).catch(() => {});
    startBtn.disabled = true;
    startBtn.textContent = 'Starting…';
    setTimeout(() => {
      startBtn.disabled = false;
      startBtn.textContent = 'Start';
    }, 3000);
  });

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
      startBtn.hidden = true;
      stopBtn.hidden = false;
      checkBtn.hidden = false;
      if (status === 'processing') {
        showActivity('Working…'); // immediate fallback; PROGRESS messages refine this
      } else {
        clearActivity();
        showReadyHintIfEmpty();
      }
    } else {
      startBtn.hidden = false;
      stopBtn.hidden = true;
      checkBtn.hidden = true;
      resetCheckButton();
      removeReadyHint();
      clearActivity();
    }
  }

  function showReadyHintIfEmpty() {
    if (notesList.querySelector('.fl-note')) return;
    if (notesList.querySelector('.fl-ready-hint')) return;
    const placeholder = notesList.querySelector('.fl-placeholder');
    if (placeholder) placeholder.remove();
    const hint = document.createElement('p');
    hint.className = 'fl-ready-hint';
    hint.textContent = 'Listening — this will check automatically in about 20 seconds, or press Check now to check sooner.';
    notesList.appendChild(hint);
  }

  function removeReadyHint() {
    const hint = notesList.querySelector('.fl-ready-hint');
    if (hint) hint.remove();
  }

  // ─── Live Activity ("what the AI is doing right now") ────────────────────

  let activityTimer = null;

  function showActivity(text) {
    if (!text) return;
    removeReadyHint();
    activityLine.hidden = false;
    activityLine.textContent = text + ' ';

    const dots = document.createElement('span');
    dots.className = 'fl-activity-dots';
    activityLine.appendChild(dots);

    if (activityTimer) clearInterval(activityTimer);
    let step = 0;
    activityTimer = setInterval(() => {
      step = (step + 1) % 4;
      dots.textContent = '.'.repeat(step);
    }, 400);
  }

  function clearActivity() {
    if (activityTimer) {
      clearInterval(activityTimer);
      activityTimer = null;
    }
    activityLine.hidden = true;
    activityLine.textContent = '';
  }

  // ─── Applying Results to the Note ────────────────────────────────────────

  function applyCoverage(payload) {
    if (!payload) return;

    if (payload.outlet_bias) {
      outletBadge.hidden = false;
      outletBadge.textContent =
        `Outlet history: ${payload.outlet_bias.name} (${BIAS_LABELS[payload.outlet_bias.rating] ?? payload.outlet_bias.rating})`;
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
    currentNote.query          = payload.query ?? null;
    currentNote.confidence     = payload.confidence ?? null;
    currentNote.matchedOn      = payload.matched_on ?? [];
    currentNote.lowConfidence  = !!payload.low_confidence;
    currentNote.articles       = payload.articles ?? [];
    currentNote.coverage       = payload.coverage ?? null;
    currentNote.missingContext = payload.missing_context ?? [];
    currentNote.framingAnalysis = payload.framing_analysis ?? null;
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

  function applyDiscussion(payload) {
    currentNote.discussionChecked = true;
    currentNote.discussionAvailable = payload?.available !== false;
    if (payload?.summary) {
      currentNote.discussion = { summary: payload.summary, sources: payload.sources ?? [] };
    }
    renderNotes();
  }

  function archiveCurrentNote() {
    const liveCard = notesList.querySelector('.fl-note--live');
    if (!liveCard) return;
    liveCard.classList.remove('fl-note--live');
    liveCard.classList.add('fl-note--archived');
    // Frozen notes lose their action buttons and rating controls
    liveCard.querySelector('.fl-note-actions')?.remove();
    liveCard.querySelector('.fl-note-rating')?.remove();

    const archived = notesList.querySelectorAll('.fl-note--archived');
    if (archived.length > MAX_ARCHIVED_NOTES) {
      archived[archived.length - 1].remove();
    }
  }

  /**
   * Thumbs down: dismiss the note immediately. The story was wrong, so
   * there's nothing worth keeping on screen — matches "just delete bad
   * results" directly, no need to archive it first.
   */
  function dismissCurrentNote() {
    const liveCard = notesList.querySelector('.fl-note--live');
    if (liveCard) liveCard.remove();
    currentNote = emptyNote();
    if (!notesList.querySelector('.fl-note') && !notesList.querySelector('.fl-ready-hint')) {
      notesList.innerHTML = PLACEHOLDER_HTML;
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

    // ── Rate the story identification — the actual complaint this answers is
    // "it wasn't the right story", so this rates that specifically, not the
    // note's content overall ──
    if (note.story) {
      parts.push(buildRatingRow(note));
    }

    if (note.framingAnalysis) {
      parts.push(...buildFramingAnalysis(note.framingAnalysis));
    }

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

    // ── Public discussion (separate from, never blended with, outlet coverage above) ──
    if (note.discussion) {
      parts.push(subheading('What people are discussing'));
      const summary = document.createElement('p');
      summary.className = 'fl-note-summary';
      summary.textContent = note.discussion.summary;
      parts.push(summary);

      if (note.discussion.sources.length > 0) {
        const srcs = document.createElement('p');
        srcs.className = 'fl-note-outlets';
        note.discussion.sources.forEach((s, i) => {
          try {
            const link = document.createElement('a');
            link.href = s.url;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.title = s.title;
            link.textContent = new URL(s.url).hostname.replace(/^www\./, '');
            srcs.appendChild(link);
            if (i < note.discussion.sources.length - 1) srcs.appendChild(document.createTextNode(' · '));
          } catch { /* skip malformed URLs */ }
        });
        parts.push(srcs);
      }
    } else if (note.discussionChecked) {
      const none = document.createElement('p');
      none.className = 'fl-note-summary';
      none.textContent = note.discussionAvailable
        ? 'Not enough public discussion found to summarize yet.'
        : 'Public reaction search disabled — add a Tavily key in Settings to enable it.';
      parts.push(none);
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

    // ── Actions: check statements / public reaction (one call each, on request) ──
    if (note.story && (!note.claimsChecked || !note.discussionChecked)) {
      const actions = document.createElement('div');
      actions.className = 'fl-note-actions';

      if (!note.claimsChecked) {
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
      }

      if (!note.discussionChecked) {
        const btn = document.createElement('button');
        btn.className = 'fl-btn fl-btn--small';
        btn.id = 'fl-discussion-btn';
        btn.textContent = 'Check public reaction';
        btn.addEventListener('click', () => {
          chrome.runtime.sendMessage({ type: 'CHECK_DISCUSSION' }).catch(() => {});
          btn.disabled = true;
          btn.textContent = 'Checking public reaction…';
        });
        actions.appendChild(btn);
      }

      parts.push(actions);
    }

    return parts;
  }

  function scoreText(value) {
    return `${Math.round(Math.max(0, Math.min(100, Number(value) || 0)))}/100`;
  }

  function framingLabel(value) {
    return ({
      loaded_language: 'Loaded language',
      source_balance: 'One-sided sourcing',
      evidence_quality: 'Evidence quality',
      missing_context: 'Missing context',
      fact_opinion_separation: 'Fact/opinion separation',
    })[value] || value;
  }

  function buildFramingAnalysis(analysis) {
    const parts = [subheading('Experimental segment framing')];
    const notice = document.createElement('p');
    notice.className = 'fl-experimental-notice';
    notice.textContent = 'Prototype assessment. Political direction is not yet human-calibrated.';
    parts.push(notice);
    const summary = document.createElement('dl');
    summary.className = 'fl-framing-summary';
    [
      ['Experimental direction', BIAS_LABELS[analysis.direction] ?? analysis.direction ?? 'unclear'],
      ['Framing intensity', scoreText(analysis.framing_intensity)],
      ['Reliability', scoreText(analysis.reliability)],
      ['Analysis completeness', `${analysis.confidence?.label ?? 'unknown'} (${scoreText(analysis.confidence?.score)})`],
    ].forEach(([label, value]) => {
      const item = document.createElement('div');
      const term = document.createElement('dt');
      const detail = document.createElement('dd');
      term.textContent = label;
      detail.textContent = value;
      item.append(term, detail);
      summary.appendChild(item);
    });
    parts.push(summary);

    const dimensions = document.createElement('dl');
    dimensions.className = 'fl-framing-dimensions';
    Object.entries(analysis.dimensions ?? {}).forEach(([name, value]) => {
      const term = document.createElement('dt');
      const detail = document.createElement('dd');
      term.textContent = framingLabel(name);
      detail.textContent = scoreText(value);
      dimensions.append(term, detail);
    });
    parts.push(dimensions);

    if (Array.isArray(analysis.evidence) && analysis.evidence.length > 0) {
      const details = document.createElement('details');
      details.className = 'fl-framing-evidence';
      const toggle = document.createElement('summary');
      toggle.textContent = `Review ${analysis.evidence.length} evidence excerpt${analysis.evidence.length === 1 ? '' : 's'}`;
      details.appendChild(toggle);
      analysis.evidence.forEach((item) => {
        const finding = document.createElement('div');
        finding.className = 'fl-framing-finding';
        const label = document.createElement('strong');
        const quote = document.createElement('blockquote');
        const explanation = document.createElement('p');
        label.textContent = framingLabel(item.dimension);
        quote.textContent = item.excerpt ?? '';
        explanation.textContent = item.explanation ?? '';
        finding.append(label, quote, explanation);
        details.appendChild(finding);
      });
      parts.push(details);
    }

    const provenance = document.createElement('p');
    provenance.className = 'fl-framing-provenance';
    const sourceCount = analysis.confidence?.comparison_sources ?? 0;
    const analyzedAt = analysis.analyzed_at ? new Date(analysis.analyzed_at).toLocaleString() : 'time unavailable';
    provenance.textContent = `Method ${analysis.methodology_version ?? 'unknown'} | ${sourceCount} comparison source${sourceCount === 1 ? '' : 's'} | ${analyzedAt}`;
    parts.push(provenance);
    return parts;
  }

  function resetClaimsButton() {
    const btn = document.getElementById('fl-claims-btn');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Check statements in this segment';
    }
  }

  function resetDiscussionButton() {
    const btn = document.getElementById('fl-discussion-btn');
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Check public reaction';
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

  /**
   * "Right story?" — thumbs up marks the note helpful (cosmetic only, no
   * backend effect); thumbs down dismisses it and tells the backend to
   * forget its cached result for this story, so a repeat check doesn't
   * reuse the same wrong answer.
   */
  function buildRatingRow(note) {
    const row = document.createElement('div');
    row.className = 'fl-note-rating';

    const label = document.createElement('span');
    label.className = 'fl-note-rating-label';
    label.textContent = 'Right story?';
    row.appendChild(label);

    if (note.rating === 'up') {
      const marked = document.createElement('span');
      marked.className = 'fl-note-rating-marked';
      marked.textContent = 'Marked helpful';
      row.appendChild(marked);
    } else {
      const upBtn = document.createElement('button');
      upBtn.className = 'fl-btn fl-btn--small';
      upBtn.textContent = 'Helpful';
      upBtn.addEventListener('click', () => {
        note.rating = 'up';
        renderNotes();
      });
      row.appendChild(upBtn);
    }

    const downBtn = document.createElement('button');
    downBtn.className = 'fl-btn fl-btn--small';
    downBtn.textContent = 'Not helpful';
    downBtn.addEventListener('click', () => {
      if (note.query) {
        chrome.runtime.sendMessage({ type: 'RATE_NOTE', query: note.query, helpful: false }).catch(() => {});
      }
      dismissCurrentNote();
    });
    row.appendChild(downBtn);

    return row;
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
