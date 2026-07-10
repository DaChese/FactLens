# FactLens Changelog

What changed since the original Sprint 4 build (v1.1.0, commit `d0eb98d`), and why.
The original was a **live fact-checking app**: continuous transcription feed, colored
True/False verdict cards, and a bias meter, analyzing everything automatically every
20 seconds. It is now a **Community Notes tool for live video**: on-demand, evidence-
gated, monochrome, and ~98% cheaper to run.

---

## v1.4.0 — On-demand architecture, API safety (2026-07-09/10)

**Why:** API credits were being burned continuously whether anyone was looking or not
(~200 calls per 5-minute session). The demo's key moment — press a button, get a note —
doesn't need any of that. This also matches the ATSC 3.0 target: on a NextGen TV,
captions arrive free with the broadcast and notes are triggered by a remote press.

- **Everything is now on-demand.** While listening, zero API calls: audio sits in a
  local ~90-second ring buffer (offscreen document), captions and page text collect
  locally. Pressing **Check now** costs ≤4 calls (1 transcription — 0 if captions are
  on — + 2 LLM + 1 NewsAPI). The old 3-second transcription loop and 20-second
  analysis timer are gone.
- **Bias meter removed entirely** (route deleted, UI removed). It was a single LLM's
  unrubric'd judgment re-scored constantly — the least defensible part of the pipeline,
  and awkward given broadcasters are the intended customer. Bias now shows only through
  the data-backed channel: each covering outlet's published lean and the left/center/right
  coverage spread.
- **Fact-checking is opt-in.** The note itself never touches Tavily. A "Check statements"
  button on the note runs claim extraction + up to 2 basic-depth searches (~2 Tavily
  credits) only when pressed. Every context bullet and claim carries clickable sources.
- **API status monitor.** `GET /status` + an "API Status" panel on the Settings page show
  per provider (Groq / Tavily / NewsAPI): OK / ERROR / RATE LIMITED / NO KEY / BUDGET
  SPENT, call counts, and the last error — so a dead key is diagnosable in seconds.
- **Rate limiting & budget caps.** Per-route throttles (6–10 req/min) stop runaway loops;
  self-imposed provider budgets (NewsAPI 80/day, Tavily 900/month, configurable in .env)
  stop the backend *itself* before the real quotas drain. Budget state is visible in
  the status panel.

## v1.3.0 — Community Notes reframe, story verification, monochrome UI (2026-07-09)

**Why:** the product is "Community Notes for live TV," not a FACT CHECK verdict machine —
and a live demo that confidently shows coverage for the *wrong* story would sink the
pitch, so story identification needed checks and balances.

- **One unified Community Note per story** (X/Twitter style) replaced the separate
  Fact Checks and Coverage Watch sections: story headline → match evidence → "Readers
  on other outlets also saw" → coverage spread → checked statements. Verdict labels
  became neutral text: Confirmed / Disputed / Unclear (was green TRUE / red FALSE).
- **Consensus gate on story identification.** The LLM's story ID is cross-checked
  (cheap keyword overlap, no extra API calls) against two independent signals: the
  page's on-screen text and the headlines NewsAPI actually returned. Both agree → high
  confidence; one → medium; neither → coverage is withheld and the note says so. Every
  note displays "Matched on: …" as visible evidence.
- **On-screen text scraping** (content script): page title, headline, og:title/description,
  image alt text and figcaptions feed story identification — recognizing the story from
  what's *shown*, not just what's *said*.
- **Caption capture broadened**: content script now runs inside iframes (most news-site
  players are embedded), plus selectors for Video.js/Brightcove, JW Player, Shaka,
  THEOplayer, Bitmovin, HTML5 text tracks, and a guarded generic fallback.
- **Live transcript feed removed from the UI** (transcription still runs as internal
  plumbing — nobody needed to watch raw text scroll by).
- **Full monochrome reskin**: black/white only, Times New Roman, no emojis, no colors
  passing judgment. Buttons are plain text. Settings page got a Back button.

## v1.2.0 — Coverage, missing context, outlet ratings, settings (2026-07-07)

**Why:** these are the features that earn the "Community Notes for Live TV" framing from
the problem statement — coverage comparison, missing-context identification, and
per-outlet bias ratings.

- **Coverage analysis** (`/coverage`): an LLM identifies the story being discussed,
  NewsAPI finds other outlets covering it (one article per outlet, 10-minute cache),
  results shown with each outlet's editorial lean.
- **Missing-context identification**: a second LLM pass extracts concrete facts the
  other coverage mentions that this segment didn't — the heart of the note.
- **Outlet bias dataset** (`backend/data/bias-ratings.json`): ~48 outlets on an
  AllSides-style left→right scale; also rates the outlet being watched (by tab domain).
- **Viewer-triggered check**: the "Check now" button (then a re-check; now the only trigger).
- **Settings page**: backend URL + API keys configurable from the browser
  (sent as request headers; falls back to backend/.env), with a connection test.
- **Closed-caption reading** (first version): captions preferred over Whisper when a
  page renders them.
- **Phase 2/3 feasibility writeup** (`docs/roadmap-phase2-3.md`): live broadcast testing
  and native ATSC 3.0 deployment — analysis only, no code, per the roadmap.

---

## Removed since v1.1.0

| Removed | Replaced by |
|---|---|
| Continuous 3s transcription loop | Local 90s audio ring buffer, one Whisper call per note |
| 20s automatic analysis timer | On-demand "Check now" button |
| Live transcript panel | (internal only — UI shows notes, not raw text) |
| Bias/emotion meter + `/bias` route | Outlet-lean coverage spread inside the note |
| Colored TRUE/FALSE/UNVERIFIED badges | Neutral Confirmed/Disputed/Unclear text tags |
| Dark indigo themed UI, emoji icons | Monochrome newsprint: black/white, Times New Roman |
