/**
 * options.js — FactLens Settings Page Controller
 *
 * Lets the user configure the backend URL and API keys without touching
 * backend/.env. Values are stored in chrome.storage.local and read by
 * background.js, which sends the keys as request headers to the backend
 * (X-Groq-Key, X-Tavily-Key, X-Newsapi-Key). A blank field here means
 * "use whatever the backend's own .env has configured."
 */

(function () {
  'use strict';

  const DEFAULT_BACKEND_URL = 'http://localhost:3001';

  const form        = document.getElementById('fl-settings-form');
  const backendUrl  = document.getElementById('fl-backend-url');
  const groqKey     = document.getElementById('fl-groq-key');
  const tavilyKey   = document.getElementById('fl-tavily-key');
  const newsApiKey  = document.getElementById('fl-newsapi-key');
  const testBtn     = document.getElementById('fl-test-btn');
  const backBtn     = document.getElementById('fl-back-btn');
  const status      = document.getElementById('fl-status');

  // ─── Back button ──────────────────────────────────────────────────────────
  // The options page opens as its own tab, so "back" means closing it —
  // the side panel is still open in the window underneath.
  backBtn.addEventListener('click', () => {
    window.close();
  });

  // ─── Load existing settings ──────────────────────────────────────────────

  chrome.storage.local.get(['backendUrl', 'groqKey', 'tavilyKey', 'newsApiKey']).then((stored) => {
    backendUrl.value = stored.backendUrl || DEFAULT_BACKEND_URL;
    groqKey.value    = stored.groqKey    || '';
    tavilyKey.value  = stored.tavilyKey  || '';
    newsApiKey.value = stored.newsApiKey || '';
  });

  // ─── Save ─────────────────────────────────────────────────────────────────

  form.addEventListener('submit', (e) => {
    e.preventDefault();

    const trimmedUrl = backendUrl.value.trim().replace(/\/+$/, '') || DEFAULT_BACKEND_URL;

    chrome.storage.local.set({
      backendUrl: trimmedUrl,
      groqKey:    groqKey.value.trim(),
      tavilyKey:  tavilyKey.value.trim(),
      newsApiKey: newsApiKey.value.trim(),
    }).then(() => {
      showStatus('Saved.', 'success');
    }).catch((err) => {
      showStatus(`Could not save: ${err.message}`, 'error');
    });
  });

  // ─── Test connection ──────────────────────────────────────────────────────

  testBtn.addEventListener('click', async () => {
    const url = backendUrl.value.trim().replace(/\/+$/, '') || DEFAULT_BACKEND_URL;

    testBtn.disabled = true;
    testBtn.textContent = 'Testing…';
    showStatus('', '');

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${url}/health`, { signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) throw new Error(`Backend responded with HTTP ${res.status}`);
      const data = await res.json();
      showStatus(`Connected — backend is ${data.status ?? 'ok'}.`, 'success');
    } catch (err) {
      const message = err.name === 'AbortError' ? 'Timed out — is the backend running?' : err.message;
      showStatus(`Could not reach backend: ${message}`, 'error');
    } finally {
      testBtn.disabled = false;
      testBtn.textContent = 'Test connection';
    }
  });

  // ─── API Status Panel ─────────────────────────────────────────────────────
  // Shows which providers are pulling, which are erroring, and which have
  // hit their rate limit — sourced from the backend's GET /status.

  const statusRefresh = document.getElementById('fl-status-refresh');
  const statusBody    = document.getElementById('fl-api-status-body');

  const PROVIDER_LABELS = {
    groq:    'Groq (transcription + analysis)',
    tavily:  'Tavily (web search)',
    newsapi: 'NewsAPI (coverage)',
  };

  async function loadApiStatus() {
    const url = backendUrl.value.trim().replace(/\/+$/, '') || DEFAULT_BACKEND_URL;
    statusBody.innerHTML = '<p class="fl-hint">Checking…</p>';

    let data;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(`${url}/status`, { signal: controller.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      statusBody.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'fl-api-row fl-api-row--bad';
      p.textContent = `Backend unreachable: ${err.name === 'AbortError' ? 'timed out' : err.message}`;
      statusBody.appendChild(p);
      return;
    }

    statusBody.innerHTML = '';
    const stored = await chrome.storage.local.get(['groqKey', 'tavilyKey', 'newsApiKey']);
    const extensionKeys = { groq: !!stored.groqKey, tavily: !!stored.tavilyKey, newsapi: !!stored.newsApiKey };

    for (const [provider, info] of Object.entries(data.providers ?? {})) {
      const row = document.createElement('div');
      row.className = 'fl-api-row';

      const name = document.createElement('span');
      name.className = 'fl-api-name';
      name.textContent = PROVIDER_LABELS[provider] ?? provider;

      const state = document.createElement('span');
      state.className = 'fl-api-state';

      const budget         = data.budgets?.[provider];
      const budgetSpent    = budget && budget.used >= budget.limit;

      const hasKey = info.configured || extensionKeys[provider];
      if (!hasKey) {
        state.textContent = 'NO KEY';
        row.classList.add('fl-api-row--bad');
      } else if (budgetSpent) {
        state.textContent = 'BUDGET SPENT';
        row.classList.add('fl-api-row--bad');
      } else if (info.last === 'rate_limited') {
        state.textContent = 'RATE LIMITED';
        row.classList.add('fl-api-row--bad');
      } else if (info.last === 'error') {
        state.textContent = 'ERROR';
        row.classList.add('fl-api-row--bad');
      } else if (info.last === 'ok') {
        state.textContent = 'OK';
      } else {
        state.textContent = 'NO CALLS YET';
      }

      const detail = document.createElement('span');
      detail.className = 'fl-api-detail';
      const bits = [`${info.calls ?? 0} calls`];
      if (info.failed > 0) bits.push(`${info.failed} failed`);
      if (budget) bits.push(`budget ${budget.used}/${budget.limit} this ${budget.window}`);
      if (info.lastError) bits.push(info.lastError);
      detail.textContent = bits.join(' · ');

      row.appendChild(name);
      row.appendChild(state);
      row.appendChild(detail);
      statusBody.appendChild(row);
    }
  }

  statusRefresh.addEventListener('click', loadApiStatus);
  loadApiStatus(); // check automatically when the page opens

  // ─── Status message ──────────────────────────────────────────────────────

  function showStatus(message, kind) {
    status.textContent = message;
    status.className = `fl-status ${kind}`;
  }

  console.log('[FactLens] Settings page loaded.');
})();
