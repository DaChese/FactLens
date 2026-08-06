(function () {
  'use strict';

  const SETTINGS_KEY = 'factlens-web-settings';

  const els = {
    status: document.getElementById('status-pill'),
    backendUrl: document.getElementById('backend-url'),
    groqKey: document.getElementById('groq-key'),
    tavilyKey: document.getElementById('tavily-key'),
    newsKey: document.getElementById('news-key'),
    transcript: document.getElementById('transcript'),
    pageTitle: document.getElementById('page-title'),
    outlet: document.getElementById('outlet'),
    screenText: document.getElementById('screen-text'),
    language: document.getElementById('language'),
    form: document.getElementById('analysis-form'),
    buildBtn: document.getElementById('build-btn'),
    clearBtn: document.getElementById('clear-btn'),
    sampleList: document.getElementById('sample-list'),
    claimsBtn: document.getElementById('claims-btn'),
    discussionBtn: document.getElementById('discussion-btn'),
    refreshStatusBtn: document.getElementById('refresh-status-btn'),
    activity: document.getElementById('activity'),
    note: document.getElementById('note'),
    apiStatus: document.getElementById('api-status'),
  };

  const state = {
    currentInput: null,
    currentNote: null,
    coverageStatus: 'idle',
    factcheckStatus: 'idle',
    discussionStatus: 'idle',
    providerStatus: null,
  };

  const saved = readSettings();
  els.backendUrl.value = saved.backendUrl || window.location.origin;
  els.groqKey.value = saved.groqKey || '';
  els.tavilyKey.value = saved.tavilyKey || '';
  els.newsKey.value = saved.newsKey || '';

  function readSettings() {
    try {
      return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    } catch {
      return {};
    }
  }

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      backendUrl: cleanBackendUrl(),
      groqKey: els.groqKey.value.trim(),
      tavilyKey: els.tavilyKey.value.trim(),
      newsKey: els.newsKey.value.trim(),
    }));
  }

  function cleanBackendUrl() {
    return (els.backendUrl.value.trim() || window.location.origin).replace(/\/+$/, '');
  }

  function keyHeaders() {
    const headers = {};
    if (els.groqKey.value.trim()) headers['X-Groq-Key'] = els.groqKey.value.trim();
    if (els.tavilyKey.value.trim()) headers['X-Tavily-Key'] = els.tavilyKey.value.trim();
    if (els.newsKey.value.trim()) headers['X-Newsapi-Key'] = els.newsKey.value.trim();
    return headers;
  }

  async function requestJson(path, options = {}) {
    saveSettings();
    let response;
    try {
      response = await fetch(`${cleanBackendUrl()}${path}`, {
        ...options,
        headers: {
          ...(options.headers || {}),
          ...keyHeaders(),
        },
      });
    } catch (err) {
      throw friendlyError(err, 'network');
    }

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(body.error || response.statusText || `HTTP ${response.status}`);
      err.status = response.status;
      throw friendlyError(err, 'http');
    }
    return body;
  }

  function friendlyError(err, kind) {
    const message = err.message || '';
    if (kind === 'network') {
      return new Error('Network failure. Check that the backend URL is correct and the Railway service is awake.');
    }
    if (err.status === 429 || /budget|rate/i.test(message)) {
      return new Error('Rate limit reached. Wait a minute, then try again.');
    }
    if (/No Groq API key/i.test(message)) {
      return new Error('Missing Groq key. Add one in Developer settings or set it in the backend environment.');
    }
    if (/No Tavily API key/i.test(message)) {
      return new Error('Missing Tavily key. Add one before checking statements or public reaction.');
    }
    if (/Request body must include/i.test(message)) {
      return new Error('Add a transcript, headline, or visible text before building a note.');
    }
    if (/NewsAPI/i.test(message) && /key/i.test(message)) {
      return new Error('Missing NewsAPI key. Add one to enable coverage comparison.');
    }
    return new Error(message || 'The request failed. Check Developer settings for provider status.');
  }

  function setActivity(text) {
    els.activity.textContent = text;
  }

  function setStatus(text, className) {
    els.status.textContent = text;
    els.status.className = `status-pill ${className || ''}`.trim();
  }

  function setButtonBusy(button, busy, busyText, readyText) {
    button.disabled = busy;
    button.textContent = busy ? busyText : readyText;
    button.setAttribute('aria-busy', String(busy));
  }

  function collectInput() {
    return {
      transcript: els.transcript.value.trim(),
      pageTitle: els.pageTitle.value.trim(),
      onScreenText: els.screenText.value.trim(),
      outlet: els.outlet.value.trim(),
      language: els.language.value,
    };
  }

  function hasEnoughInput(input) {
    return Boolean(input.transcript || input.pageTitle || input.onScreenText);
  }

  function normalizeNote(raw) {
    return {
      available: raw.available !== false,
      story: raw.story || null,
      storyDate: raw.story_date || null,
      query: raw.query || null,
      confidence: raw.confidence || null,
      matchedOn: Array.isArray(raw.matched_on) ? raw.matched_on : [],
      lowConfidence: Boolean(raw.low_confidence),
      articles: Array.isArray(raw.articles) ? raw.articles : [],
      coverage: raw.coverage || null,
      missingContext: Array.isArray(raw.missing_context) ? raw.missing_context : [],
      outletBias: raw.outlet_bias || null,
      claims: null,
      discussion: null,
    };
  }

  function normalizeClaims(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.map((claim) => ({
      claim: claim.claim || 'Not available',
      verdict: claim.verdict || 'Unverified',
      reasoning: claim.reasoning || '',
      // Sources used to be bare URL strings, and the backend's 1-hour verdict
      // cache can still hold that shape — normalise both to one object here so
      // the renderer doesn't have to care.
      sources: Array.isArray(claim.sources)
        ? claim.sources.map((s) => (typeof s === 'string'
            ? { url: s, publishedDate: null }
            : { url: s?.url, publishedDate: s?.publishedDate || null })).filter((s) => s.url)
        : [],
    }));
  }

  /**
   * Short readable date, or null when missing/unparseable.
   *
   * Formatted in UTC deliberately: sources report a publication calendar date,
   * usually as midnight UTC, and rendering that in local time shows the previous
   * day for every viewer west of UTC.
   */
  function formatDate(value) {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
    });
  }

  function normalizeDiscussion(raw) {
    return {
      available: raw.available !== false,
      summary: raw.summary || null,
      quotes: Array.isArray(raw.quotes) ? raw.quotes : [],
      sources: Array.isArray(raw.sources) ? raw.sources : [],
      platforms: Array.isArray(raw.platforms) ? raw.platforms : [],
    };
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function append(parent, ...children) {
    children.filter(Boolean).forEach((child) => parent.appendChild(child));
    return parent;
  }

  function sourceLink(url, text) {
    const link = document.createElement('a');
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported URL');
      link.href = parsed.href;
      link.textContent = text || parsed.hostname.replace(/^www\./, '');
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      return link;
    } catch {
      return el('span', null, text || 'Source unavailable');
    }
  }

  function domainLabel(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return 'source';
    }
  }

  function biasLabel(value) {
    return ({
      left: 'left',
      'lean-left': 'lean left',
      center: 'center',
      'lean-right': 'lean right',
      right: 'right',
      unrated: 'unrated',
    })[value] || value || 'unrated';
  }

  function verdictLabel(value) {
    return value === 'True' ? 'Confirmed' : value === 'False' ? 'Disputed' : 'Unclear';
  }

  function renderEmpty(text) {
    clearNode(els.note);
    els.note.appendChild(el('p', 'placeholder', text));
    syncFollowups();
  }

  function renderNote() {
    const note = state.currentNote;
    if (!note) {
      renderEmpty('Build a note to see story context, coverage, and follow-up checks.');
      return;
    }

    clearNode(els.note);

    if (!note.available) {
      append(els.note,
        el('h3', null, 'Coverage comparison unavailable'),
        el('p', 'placeholder', 'Add a NewsAPI key in Developer settings or set NEWSAPI_KEY in the backend environment.')
      );
      syncFollowups();
      return;
    }

    if (!note.story) {
      append(els.note,
        el('h3', null, 'No clear story identified'),
        el('p', 'placeholder', 'FactLens needs more transcript, a clearer headline, or visible page text before it can build a useful note.')
      );
      syncFollowups();
      return;
    }

    const storySection = el('section', note.lowConfidence ? 'result-section low-confidence' : 'result-section');
    append(storySection, el('h3', null, 'Identified story'));
    storySection.appendChild(el('p', 'story-title', note.story));
    const storyWhen = formatDate(note.storyDate);
    if (storyWhen) storySection.appendChild(el('p', 'note-meta', `Story dated ${storyWhen}`));
    if (note.query) storySection.appendChild(el('p', 'note-meta', `Search query: ${note.query}`));
    storySection.appendChild(el('p', 'note-meta', storyMatchText(note)));
    if (note.outletBias) {
      storySection.appendChild(el('p', 'note-meta', `Watched source: ${note.outletBias.name} (${biasLabel(note.outletBias.rating)})`));
    }
    els.note.appendChild(storySection);

    renderMissingContext(note);
    renderCoverage(note);
    if (note.claims) renderClaims(note.claims);
    if (note.discussion) renderDiscussion(note.discussion);
    syncFollowups();
  }

  function storyMatchText(note) {
    if (note.lowConfidence) {
      return 'Story match status: low confidence. Coverage and missing context may be withheld until more evidence is available.';
    }
    const signals = note.matchedOn.length ? note.matchedOn.join(', ') : 'Not available';
    const confidence = note.confidence ? `${note.confidence} confidence` : 'confidence not available';
    return `Story match status: ${confidence}. Signals used: ${signals}.`;
  }

  function renderMissingContext(note) {
    const section = el('section', 'result-section');
    append(section, el('h3', null, 'Missing context'));
    if (note.lowConfidence) {
      section.appendChild(el('p', 'placeholder', 'The story match was not confident enough to show missing context.'));
    } else if (note.missingContext.length === 0) {
      section.appendChild(el('p', 'placeholder', 'No additional context returned.'));
    } else {
      const list = el('ul', 'context-list');
      note.missingContext.forEach((item) => {
        const text = typeof item === 'string' ? item : item.text;
        const li = el('li');
        li.appendChild(el('span', null, text || 'Not available'));
        if (item && item.url) {
          li.appendChild(document.createTextNode(' '));
          li.appendChild(sourceLink(item.url, item.outlet || domainLabel(item.url)));
        }
        list.appendChild(li);
      });
      section.appendChild(list);
    }
    els.note.appendChild(section);
  }

  function renderCoverage(note) {
    const section = el('section', 'result-section');
    append(section, el('h3', null, 'Other coverage'));
    if (note.lowConfidence) {
      section.appendChild(el('p', 'placeholder', 'Coverage is withheld for low-confidence matches.'));
    } else if (note.articles.length === 0) {
      section.appendChild(el('p', 'placeholder', 'No other outlet coverage returned.'));
    } else {
      if (note.coverage) {
        section.appendChild(el('p', 'note-meta', coverageSummary(note.coverage)));
      }
      const list = el('ul', 'article-list');
      note.articles.forEach((article) => {
        const li = el('li');
        const title = article.title || `${article.outlet || 'Source'} article`;
        li.appendChild(sourceLink(article.url, title));
        const when = formatDate(article.publishedAt);
        const meta = `${article.outlet || domainLabel(article.url)} · ${biasLabel(article.bias)}${when ? ` · ${when}` : ''}`;
        li.appendChild(el('span', 'source-meta', meta));
        list.appendChild(li);
      });
      section.appendChild(list);
    }
    els.note.appendChild(section);
  }

  function coverageSummary(coverage) {
    const left = (coverage.left || 0) + (coverage['lean-left'] || 0);
    const right = (coverage.right || 0) + (coverage['lean-right'] || 0);
    return `${coverage.total || 0} outlet${coverage.total === 1 ? '' : 's'} found: ${left} left or lean-left, ${coverage.center || 0} center, ${right} right or lean-right, ${coverage.unrated || 0} unrated.`;
  }

  function renderClaims(claims) {
    const section = el('section', 'result-section followup-result');
    append(section, el('h3', null, 'Statement checks'));
    if (claims.length === 0) {
      section.appendChild(el('p', 'placeholder', 'No specific checkable statements were found.'));
    } else {
      const list = el('ul', 'claim-list');
      claims.forEach((claim) => {
        const li = el('li');
        append(li,
          el('span', `tag tag-${verdictLabel(claim.verdict).toLowerCase()}`, verdictLabel(claim.verdict)),
          el('p', 'claim-text', claim.claim)
        );
        if (claim.reasoning) li.appendChild(el('p', 'note-meta', claim.reasoning));
        if (claim.sources.length) {
          const sources = el('p', 'source-row', 'Sources: ');
          claim.sources.forEach((source, index) => {
            if (index > 0) sources.appendChild(document.createTextNode(', '));
            const shown = formatDate(source.publishedDate);
            const label = shown ? `${domainLabel(source.url)} · ${shown}` : domainLabel(source.url);
            sources.appendChild(sourceLink(source.url, label));
          });
          li.appendChild(sources);
        }
        list.appendChild(li);
      });
      section.appendChild(list);
    }
    els.note.appendChild(section);
  }

  function renderDiscussion(discussion) {
    const section = el('section', 'result-section followup-result');
    append(section, el('h3', null, 'Public reaction'));
    if (!discussion.available) {
      section.appendChild(el('p', 'placeholder', 'Add a Tavily key before checking public reaction.'));
    } else if (!discussion.summary && discussion.quotes.length === 0) {
      section.appendChild(el('p', 'placeholder', 'Not enough public discussion found to summarize yet.'));
    } else {
      if (discussion.summary) section.appendChild(el('p', 'note-summary', discussion.summary));

      // Verbatim quotes. Each is checked against its source backend-side before
      // it gets here, so nothing shown is paraphrased or invented.
      if (discussion.quotes.length) {
        const list = el('ul', 'quote-list');
        discussion.quotes.forEach((quote) => {
          const li = el('li', 'quote');
          li.appendChild(el('p', 'quote-text', `“${quote.text}”`));
          const when = formatDate(quote.publishedDate);
          const label = when ? `${quote.platform} · ${when}` : quote.platform;
          const attribution = el('p', 'quote-source');
          attribution.appendChild(quote.url ? sourceLink(quote.url, label) : el('span', null, label));
          li.appendChild(attribution);
          list.appendChild(li);
        });
        section.appendChild(list);
      }

      if (discussion.sources.length) {
        const sources = el('p', 'source-row', 'Sources: ');
        discussion.sources.forEach((source, index) => {
          if (index > 0) sources.appendChild(document.createTextNode(', '));
          const base  = source.platform || domainLabel(source.url);
          const shown = formatDate(source.publishedDate);
          const label = shown ? `${base} · ${shown}` : base;
          sources.appendChild(sourceLink(source.url, label));
        });
        section.appendChild(sources);
      }
    }
    els.note.appendChild(section);
  }

  function syncFollowups() {
    const hasNote = Boolean(state.currentNote?.story);
    const hasTranscript = Boolean(state.currentInput?.transcript);
    els.claimsBtn.disabled = !hasNote || !hasTranscript || state.factcheckStatus === 'loading';
    els.discussionBtn.disabled = !hasNote || !state.currentNote?.query || state.discussionStatus === 'loading';
  }

  async function checkHealth() {
    try {
      await requestJson('/health');
      setStatus('Backend online', 'ok');
    } catch (err) {
      setStatus('Backend offline', 'error');
      setActivity(err.message);
    }
  }

  async function buildNote(event) {
    event.preventDefault();
    const input = collectInput();
    if (!hasEnoughInput(input)) {
      state.coverageStatus = 'invalid';
      renderEmpty('Add a transcript, headline, or visible text before building a note.');
      setActivity('Add content first.');
      return;
    }

    state.currentInput = input;
    state.currentNote = null;
    state.coverageStatus = 'loading';
    state.factcheckStatus = 'idle';
    state.discussionStatus = 'idle';
    renderEmpty('Identifying the story and checking coverage...');
    setButtonBusy(els.buildBtn, true, 'Building note...', 'Build Community Note');
    setActivity('Identifying the story and checking coverage...');

    try {
      const raw = await requestJson('/coverage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript: input.transcript,
          language: input.language,
          outlet: input.outlet || null,
          pageTitle: input.pageTitle || null,
          onScreenText: input.onScreenText || null,
        }),
      });
      state.currentNote = normalizeNote(raw);
      state.coverageStatus = state.currentNote.lowConfidence ? 'low-confidence' : 'complete';
      setActivity(state.currentNote.story ? 'Community Note ready.' : 'No clear story identified.');
      renderNote();
      els.note.focus();
    } catch (err) {
      state.coverageStatus = 'error';
      renderEmpty(err.message);
      setActivity('Could not build the note.');
    } finally {
      setButtonBusy(els.buildBtn, false, 'Building note...', 'Build Community Note');
    }
  }

  async function checkClaims() {
    if (!state.currentInput?.transcript) return;
    state.factcheckStatus = 'loading';
    setButtonBusy(els.claimsBtn, true, 'Checking statements...', 'Check statements');
    setActivity('Checking statements against web sources...');
    syncFollowups();

    try {
      const raw = await requestJson('/factcheck', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: state.currentInput.transcript, language: state.currentInput.language }),
      });
      state.currentNote.claims = normalizeClaims(raw);
      state.factcheckStatus = 'complete';
      setActivity('Statement check complete.');
      renderNote();
    } catch (err) {
      state.factcheckStatus = 'error';
      setActivity(err.message);
    } finally {
      setButtonBusy(els.claimsBtn, false, 'Checking statements...', 'Check statements');
      syncFollowups();
    }
  }

  async function checkDiscussion() {
    if (!state.currentNote?.query) return;
    state.discussionStatus = 'loading';
    setButtonBusy(els.discussionBtn, true, 'Checking reaction...', 'Check public reaction');
    setActivity('Searching public reaction...');
    syncFollowups();

    try {
      const raw = await requestJson('/discussion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: state.currentNote.query, language: state.currentInput.language }),
      });
      state.currentNote.discussion = normalizeDiscussion(raw);
      state.discussionStatus = 'complete';
      setActivity('Public reaction check complete.');
      renderNote();
    } catch (err) {
      state.discussionStatus = 'error';
      setActivity(err.message);
    } finally {
      setButtonBusy(els.discussionBtn, false, 'Checking reaction...', 'Check public reaction');
      syncFollowups();
    }
  }

  async function refreshStatus() {
    setActivity('Loading provider status...');
    try {
      state.providerStatus = await requestJson('/status');
      renderStatus();
      setActivity('Provider status loaded.');
    } catch (err) {
      setActivity(err.message);
    }
  }

  function renderStatus() {
    clearNode(els.apiStatus);
    els.apiStatus.hidden = false;
    const providers = Object.entries(state.providerStatus?.providers || {});
    if (providers.length === 0) {
      els.apiStatus.appendChild(el('p', 'placeholder', 'No provider calls yet.'));
      return;
    }
    const table = el('table');
    const thead = document.createElement('thead');
    thead.innerHTML = '<tr><th>Provider</th><th>Status</th><th>Calls</th><th>Last error</th></tr>';
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    providers.forEach(([name, provider]) => {
      const row = document.createElement('tr');
      append(row,
        el('td', null, name),
        el('td', null, provider.status || 'unknown'),
        el('td', null, String(provider.calls ?? 0)),
        el('td', null, provider.lastError || '')
      );
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    els.apiStatus.appendChild(table);
  }

  function renderSamples() {
    clearNode(els.sampleList);
    (window.FACTLENS_SAMPLES || []).forEach((sample) => {
      const button = el('button', 'sample-card');
      button.type = 'button';
      button.dataset.sampleId = sample.id;
      append(button,
        el('strong', null, sample.label),
        el('span', null, sample.description)
      );
      els.sampleList.appendChild(button);
    });
  }

  function loadSample(sampleId) {
    const sample = (window.FACTLENS_SAMPLES || []).find((item) => item.id === sampleId);
    if (!sample) return;
    els.transcript.value = sample.transcript;
    els.pageTitle.value = sample.pageTitle;
    els.screenText.value = sample.screenText;
    els.outlet.value = sample.outlet;
    els.language.value = sample.language || 'english';
    state.currentNote = null;
    state.currentInput = null;
    renderNote();
    setActivity(`${sample.label} loaded.`);
    els.transcript.focus();
  }

  function clearForm() {
    els.transcript.value = '';
    els.pageTitle.value = '';
    els.outlet.value = '';
    els.screenText.value = '';
    state.currentNote = null;
    state.currentInput = null;
    state.coverageStatus = 'idle';
    state.factcheckStatus = 'idle';
    state.discussionStatus = 'idle';
    renderNote();
    setActivity('Form cleared.');
    els.transcript.focus();
  }

  els.form.addEventListener('submit', buildNote);
  els.claimsBtn.addEventListener('click', checkClaims);
  els.discussionBtn.addEventListener('click', checkDiscussion);
  els.refreshStatusBtn.addEventListener('click', refreshStatus);
  els.clearBtn.addEventListener('click', clearForm);
  els.sampleList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-sample-id]');
    if (button) loadSample(button.dataset.sampleId);
  });
  [els.backendUrl, els.groqKey, els.tavilyKey, els.newsKey].forEach((input) => {
    input.addEventListener('change', () => {
      saveSettings();
      checkHealth();
    });
  });

  renderSamples();
  renderNote();
  checkHealth();
})();
