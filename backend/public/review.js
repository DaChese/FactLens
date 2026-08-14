(function () {
  'use strict';

  const dimensions = [
    ['framing_intensity', 'Framing intensity'],
    ['reliability', 'Reliability'],
    ['loaded_language', 'Loaded language'],
    ['source_balance', 'One-sided sourcing'],
    ['evidence_quality', 'Evidence quality'],
    ['missing_context', 'Missing context'],
    ['fact_opinion_separation', 'Fact/opinion separation'],
    ['confidence', 'Your confidence'],
  ];
  const els = {
    activity: document.getElementById('review-activity'),
    accessForm: document.getElementById('review-access'),
    accessToken: document.getElementById('review-access-token'),
    empty: document.getElementById('review-empty'),
    workspace: document.getElementById('review-workspace'),
    transcript: document.getElementById('review-transcript'),
    form: document.getElementById('review-form'),
    sliders: document.getElementById('review-sliders'),
    stance: document.getElementById('reviewer-stance'),
    direction: document.getElementById('direction'),
    summary: document.getElementById('review-summary'),
    summaryContent: document.getElementById('summary-content'),
    next: document.getElementById('next-review'),
  };
  let sample = null;
  const sessionKey = 'factlensReviewerSession';
  const reviewerSession = localStorage.getItem(sessionKey) || crypto.randomUUID();
  localStorage.setItem(sessionKey, reviewerSession);
  let accessToken = sessionStorage.getItem('factlensReviewerAccess') || '';

  dimensions.forEach(([name, label]) => {
    const row = document.createElement('div');
    row.className = 'review-slider';
    const input = document.createElement('input');
    const output = document.createElement('output');
    input.type = 'range';
    input.id = name;
    input.name = name;
    input.min = '0';
    input.max = '100';
    input.value = '50';
    output.htmlFor = name;
    output.textContent = input.value;
    input.addEventListener('input', () => { output.textContent = input.value; });
    const labelNode = document.createElement('label');
    labelNode.htmlFor = name;
    labelNode.textContent = label;
    row.append(labelNode, input, output);
    els.sliders.appendChild(row);
  });

  async function request(url, options = {}) {
    const response = await fetch(url, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Reviewer-Session': reviewerSession,
        'X-Reviewer-Access': accessToken,
        ...(options.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
    return body;
  }

  async function loadSample() {
    els.activity.textContent = 'Loading review queue...';
    els.summary.hidden = true;
    try {
      const response = await request('/reviews/queue');
      sample = response.sample;
      els.empty.hidden = Boolean(sample);
      els.workspace.hidden = !sample;
      if (!sample) {
        els.activity.textContent = 'Queue empty.';
        return;
      }
      els.transcript.textContent = sample.transcript;
      els.activity.textContent = 'Sample ready.';
    } catch (error) {
      els.activity.textContent = error.message;
    }
  }

  function score(name) {
    return Number(document.getElementById(name).value);
  }

  els.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!sample) return;
    const submit = els.form.querySelector('button[type="submit"]');
    submit.disabled = true;
    els.activity.textContent = 'Submitting review...';
    try {
      await request(`/reviews/${encodeURIComponent(sample.sample_id)}`, {
        method: 'POST',
        body: JSON.stringify({
          reviewer_stance: els.stance.value,
          direction: els.direction.value,
          framing_intensity: score('framing_intensity'),
          reliability: score('reliability'),
          confidence: score('confidence'),
          dimensions: Object.fromEntries(dimensions.slice(2, 7).map(([name]) => [name, score(name)])),
        }),
      });
      const summary = await request(`/reviews/summary/${encodeURIComponent(sample.sample_id)}`);
      renderSummary(summary);
      els.workspace.hidden = true;
      els.summary.hidden = false;
      els.activity.textContent = 'Review locked.';
    } catch (error) {
      els.activity.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });

  function renderSummary(summary) {
    els.summaryContent.replaceChildren();
    const grid = document.createElement('div');
    grid.className = 'summary-grid';
    [
      ['Reviews', summary.review_count],
      ['Direction agreement', summary.direction_agreement == null ? 'Pending' : `${Math.round(summary.direction_agreement * 100)}%`],
      ['Mean reliability', summary.mean_reliability == null ? 'Pending' : `${summary.mean_reliability}/100`],
    ].forEach(([label, value]) => {
      const item = document.createElement('div');
      const name = document.createElement('span');
      const result = document.createElement('strong');
      name.textContent = label;
      result.textContent = String(value);
      item.append(name, result);
      grid.appendChild(item);
    });
    els.summaryContent.appendChild(grid);
  }

  els.next.addEventListener('click', loadSample);
  els.accessForm.addEventListener('submit', (event) => {
    event.preventDefault();
    accessToken = els.accessToken.value;
    sessionStorage.setItem('factlensReviewerAccess', accessToken);
    loadSample();
  });
  if (accessToken) {
    els.accessToken.value = accessToken;
    loadSample();
  } else {
    els.activity.textContent = 'Enter the panel access token to load the queue.';
  }
})();
