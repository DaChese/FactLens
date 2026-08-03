(function () {
  'use strict';

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
    buildBtn: document.getElementById('build-btn'),
    clearBtn: document.getElementById('clear-btn'),
    sampleBtn: document.getElementById('sample-btn'),
    claimsBtn: document.getElementById('claims-btn'),
    discussionBtn: document.getElementById('discussion-btn'),
    refreshStatusBtn: document.getElementById('refresh-status-btn'),
    activity: document.getElementById('activity'),
    note: document.getElementById('note'),
    apiStatus: document.getElementById('api-status'),
  };

  const state = {
    note: null,
    transcript: '',
    language: 'english',
  };

  const saved = JSON.parse(localStorage.getItem('factlens-web-settings') || '{}');
  els.backendUrl.value = saved.backendUrl || window.location.origin;
  els.groqKey.value = saved.groqKey || '';
  els.tavilyKey.value = saved.tavilyKey || '';
  els.newsKey.value = saved.newsKey || '';

  function saveSettings() {
    localStorage.setItem('factlens-web-settings', JSON.stringify({
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

  async function api(path, options = {}) {
    saveSettings();
    const res = await fetch(`${cleanBackendUrl()}${path}`, {
      ...options,
      headers: {
        ...(options.headers || {}),
        ...keyHeaders(),
      },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || res.statusText || `HTTP ${res.status}`);
    }
    return res.json();
  }

  function setActivity(text) {
    els.activity.textContent = text;
  }

  function setBusy(button, busy, busyText, readyText) {
    button.disabled = busy;
    button.textContent = busy ? busyText : readyText;
  }

  function escapeText(text) {
    return String(text ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[char]));
  }

  function link(url, text) {
    const safeUrl = escapeText(url);
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${escapeText(text || url)}</a>`;
  }

  function domainLabel(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return url;
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

  function renderNote() {
    const note = state.note;
    if (!note) {
      els.note.innerHTML = '<p class="placeholder">Build a note to see story context, coverage spread, and follow-up checks.</p>';
      els.claimsBtn.disabled = true;
      els.discussionBtn.disabled = true;
      return;
    }

    if (note.available === false) {
      els.note.innerHTML = '<p class="placeholder">Coverage comparison is disabled. Add a NewsAPI key in Railway or in the API key overrides.</p>';
      els.claimsBtn.disabled = !state.transcript.trim();
      els.discussionBtn.disabled = true;
      return;
    }

    if (!note.story) {
      els.note.innerHTML = '<p class="placeholder">No clear news story was identified from the provided text yet.</p>';
      els.claimsBtn.disabled = true;
      els.discussionBtn.disabled = true;
      return;
    }

    const matched = note.matched_on?.length
      ? `Matched on: ${escapeText(note.matched_on.join(', '))}${note.confidence ? ` · ${escapeText(note.confidence)} confidence` : ''}`
      : note.low_confidence
        ? 'Low-confidence story match'
        : '';

    const contextItems = (note.missing_context || []).map((item) => {
      const text = typeof item === 'string' ? item : item.text;
      const source = item?.url ? ` ${link(item.url, `(${item.outlet || 'source'})`)}` : '';
      return `<li>${escapeText(text)}${source}</li>`;
    }).join('');

    const articles = (note.articles || []).map((article) =>
      link(article.url, `${article.outlet}${article.bias ? ` (${biasLabel(article.bias)})` : ''}`)
    ).join(' · ');

    const coverage = note.coverage
      ? `<p class="note-summary">${note.coverage.total} outlet${note.coverage.total === 1 ? '' : 's'} found: ` +
        `${(note.coverage.left || 0) + (note.coverage['lean-left'] || 0)} left-leaning, ` +
        `${note.coverage.center || 0} center, ` +
        `${(note.coverage.right || 0) + (note.coverage['lean-right'] || 0)} right-leaning.</p>`
      : '';

    const outletBias = note.outlet_bias
      ? `<p class="note-summary"><span class="tag">Watching</span>${escapeText(note.outlet_bias.name)} (${escapeText(biasLabel(note.outlet_bias.rating))})</p>`
      : '';

    els.note.innerHTML = `
      <div class="${note.low_confidence ? 'low-confidence' : ''}">
        <h3>${escapeText(note.story)}</h3>
        <p class="note-meta">${matched}</p>
      </div>
      ${outletBias}
      ${contextItems ? `<h4>Readers on other outlets also saw</h4><ul>${contextItems}</ul>` : ''}
      ${(note.articles || []).length ? `<h4>Who else is covering this</h4>${coverage}<p class="note-outlets">${articles}</p>` : ''}
      ${note.claimsHtml || ''}
      ${note.discussionHtml || ''}
    `;

    els.claimsBtn.disabled = !state.transcript.trim();
    els.discussionBtn.disabled = !note.query;
  }

  async function checkHealth() {
    try {
      await api('/health');
      els.status.textContent = 'Backend online';
      els.status.className = 'status ok';
    } catch (err) {
      els.status.textContent = 'Backend offline';
      els.status.className = 'status error';
      setActivity(err.message);
    }
  }

  async function buildNote() {
    const transcript = els.transcript.value.trim();
    const pageTitle = els.pageTitle.value.trim();
    const onScreenText = els.screenText.value.trim();
    if (!transcript && !pageTitle && !onScreenText) {
      setActivity('Add a transcript, page title, or on-screen text first.');
      return;
    }

    setBusy(els.buildBtn, true, 'Building...', 'Build Community Note');
    setActivity('Identifying the story and checking coverage...');
    state.transcript = transcript;
    state.language = els.language.value;

    try {
      state.note = await api('/coverage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transcript,
          language: els.language.value,
          outlet: els.outlet.value.trim() || null,
          pageTitle: pageTitle || null,
          onScreenText: onScreenText || null,
        }),
      });
      setActivity(state.note.story ? 'Note ready.' : 'No clear story identified.');
      renderNote();
    } catch (err) {
      setActivity(err.message);
    } finally {
      setBusy(els.buildBtn, false, 'Building...', 'Build Community Note');
    }
  }

  async function checkClaims() {
    if (!state.transcript.trim()) return;
    setBusy(els.claimsBtn, true, 'Checking...', 'Check Statements');
    setActivity('Checking statements against web sources...');
    try {
      const claims = await api('/factcheck', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcript: state.transcript, language: state.language }),
      });
      const rows = claims.length
        ? claims.map((claim) => `
          <li>
            <p><span class="tag">${escapeText(claim.verdict === 'True' ? 'Confirmed' : claim.verdict === 'False' ? 'Disputed' : 'Unclear')}</span>${escapeText(claim.claim)}</p>
            ${claim.reasoning ? `<p class="claim-reasoning">${escapeText(claim.reasoning)}</p>` : ''}
            ${(claim.sources || []).length ? `<p class="claim-sources">Sources: ${claim.sources.map((url) => link(url, domainLabel(url))).join(', ')}</p>` : ''}
          </li>
        `).join('')
        : '<li>No specific checkable statements were found.</li>';
      state.note.claimsHtml = `<h4>Statements checked against the web</h4><ul>${rows}</ul>`;
      setActivity('Statement check complete.');
      renderNote();
    } catch (err) {
      setActivity(err.message);
    } finally {
      setBusy(els.claimsBtn, false, 'Checking...', 'Check Statements');
    }
  }

  async function checkDiscussion() {
    if (!state.note?.query) return;
    setBusy(els.discussionBtn, true, 'Checking...', 'Check Public Reaction');
    setActivity('Searching public reaction...');
    try {
      const discussion = await api('/discussion', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: state.note.query, language: state.language }),
      });
      const sources = (discussion.sources || [])
        .map((source) => link(source.url, source.title || source.url))
        .join(' · ');
      state.note.discussionHtml = discussion.summary
        ? `<h4>What people are discussing</h4><p class="note-summary">${escapeText(discussion.summary)}</p>${sources ? `<p class="note-outlets">${sources}</p>` : ''}`
        : '<h4>What people are discussing</h4><p class="note-summary">Not enough public discussion found to summarize yet.</p>';
      setActivity('Public reaction check complete.');
      renderNote();
    } catch (err) {
      setActivity(err.message);
    } finally {
      setBusy(els.discussionBtn, false, 'Checking...', 'Check Public Reaction');
    }
  }

  async function refreshStatus() {
    setActivity('Loading API status...');
    try {
      const status = await api('/status');
      const rows = Object.entries(status.providers || {}).map(([name, provider]) => `
        <tr>
          <td>${escapeText(name)}</td>
          <td>${escapeText(provider.status || 'unknown')}</td>
          <td>${escapeText(provider.calls ?? 0)}</td>
          <td>${escapeText(provider.lastError || '')}</td>
        </tr>
      `).join('');
      els.apiStatus.hidden = false;
      els.apiStatus.innerHTML = `
        <h4>API Status</h4>
        <table>
          <thead><tr><th>Provider</th><th>Status</th><th>Calls</th><th>Last error</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4">No provider calls yet.</td></tr>'}</tbody>
        </table>
      `;
      setActivity('API status loaded.');
    } catch (err) {
      setActivity(err.message);
    }
  }

  function loadSample() {
    els.pageTitle.value = 'Supreme Court hears challenge to social media moderation laws';
    els.outlet.value = 'apnews.com';
    els.screenText.value = 'Justices weigh state laws that restrict how social media companies moderate political content.';
    els.transcript.value = 'The Supreme Court heard arguments today over whether states can limit how large social media platforms moderate posts. Supporters of the state laws say platforms unfairly silence political viewpoints, while tech companies argue the laws violate their First Amendment right to choose what speech they host.';
    setActivity('Sample loaded.');
  }

  function clearAll() {
    els.transcript.value = '';
    els.pageTitle.value = '';
    els.outlet.value = '';
    els.screenText.value = '';
    state.note = null;
    state.transcript = '';
    renderNote();
    setActivity('Cleared.');
  }

  els.buildBtn.addEventListener('click', buildNote);
  els.claimsBtn.addEventListener('click', checkClaims);
  els.discussionBtn.addEventListener('click', checkDiscussion);
  els.refreshStatusBtn.addEventListener('click', refreshStatus);
  els.sampleBtn.addEventListener('click', loadSample);
  els.clearBtn.addEventListener('click', clearAll);
  [els.backendUrl, els.groqKey, els.tavilyKey, els.newsKey].forEach((el) => {
    el.addEventListener('change', () => {
      saveSettings();
      checkHealth();
    });
  });

  checkHealth();
})();
