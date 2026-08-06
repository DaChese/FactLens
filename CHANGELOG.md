# FactLens Changelog

What changed since the original Sprint 4 build (v1.1.0, commit `d0eb98d`), and why.
The original was a **live fact-checking app**: continuous transcription feed, colored
True/False verdict cards, and a bias meter, analyzing everything automatically every
20 seconds. It is now a **Community Notes tool for live video**: on-demand, evidence-
gated, monochrome, and ~98% cheaper to run.

---

## v1.6.0 — Reliability, dates, and real quotes (2026-08-05/06)

**Why:** live use surfaced a cluster of problems that all had the same shape — the
tool was silently doing less than it appeared to. Sessions could record forever
after the service worker was suspended; the Stop button sometimes did nothing; the
relevance filter for public reaction rejected *everything* on a real story; and the
page title and description, which are the single best story signal available, were
being truncated before the model ever saw them.

**Sessions now reliably end.**
- MV3 suspends the service worker after ~30s idle and `setTimeout` does not survive
  that — and every path that stopped a session was a `setTimeout`. A suspension left
  the session flagged active, the offscreen document capturing audio indefinitely,
  and the panel stuck on "Listening". The offscreen document (whose timers cannot be
  suspended) now heartbeats every 15s, waking the worker and capping recording at 6
  minutes locally. The worker's watchdog enforces a 5-minute session cap and ends
  sessions flagged active with nothing scheduled.
- **`chrome.alarms` was evaluated and rejected.** Its minimum period is 30 seconds
  and *unpacked extensions are exempt from that floor* — it would have worked
  perfectly in development and silently clamped once packed. A reliability mechanism
  whose failure mode is invisible in testing is worse than none.
- **Check now** now ends the session instead of leaving it active with nothing
  scheduled. Follow-up checks still work afterwards.
- `startedAt` and `attempts` are persisted to `chrome.storage.session`, so the
  3-attempt cap survives a worker restart instead of silently resetting.
- Fixed: `startSession` revealed the Stop button before capture existed; a failing
  start leaked the offscreen document; starting on a second tab orphaned the first
  tab's recorder.

**The Stop button works.**
- `STOP_SESSION` with no active session was a no-op that broadcast nothing, so a
  desynced panel could never recover. It now always reports idle.
- Three `finally` blocks unconditionally re-broadcast `listening` after a note or
  follow-up check, stamping "active" over a session that had already ended. They now
  broadcast the real state.
- The panel re-syncs every 10 seconds, so a lost status broadcast no longer strands
  it, and Stop shows "Stopping…" instead of no feedback at all.
- Pressing **Check statements** or **Check public reaction** no longer looks like a
  new capture session started. Session state and working state are now tracked
  separately; "processing" no longer reveals Stop and Check now.

**Public reaction is substantially better.**
- **Verbatim quotes.** The response now carries 3–6 short quotes showing what people
  actually said, attributed to platform and date. Every quote is verified against the
  source text it claims to come from and dropped if it does not match — a prompt rule
  alone is a request, not a guarantee, and a fabricated quote attributed to a real
  person is the most damaging thing this feature could emit.
- **Comments on the page being watched** are now a first-class source, alongside a
  search across Reddit, Hacker News, Quora, Bluesky, Threads, YouTube, X and
  Facebook. Comments need no relevance matching — they are attached to the exact
  video being watched.
- **The relevance filter was far too strict.** A real run scored 0/12 on "MTA subway
  upgrade delays New York City" because there was no stemming: "delayed" scored 0.00
  against "delays". Fixed, and measured at 3/4 on-topic results kept on that same
  story. Each filter gate now logs its own drop count, because the original "0/12
  relevant" was undiagnosable.
- **A broader second pass** runs when the strict pass finds too little, so a
  mistuned threshold degrades into a wider search instead of into silence. Same
  idea in `/factcheck`, which retries claim extraction with a lower bar.
- The search is best-effort: if it fails, page comments alone still produce a result.

**Dates everywhere.**
- Notes show when the story broke; each outlet and each statement-check source shows
  its publication date. Dates are formatted in UTC — rendering a midnight-UTC
  publication date in local time showed the previous day for every viewer west of UTC.
- The story's date now anchors the discussion search and its age filter. Age was
  being measured from *today*, which discarded exactly the reaction we wanted for any
  story more than a few days old.

**Title and description are now the primary story signal.**
- The content script collects ~1500 characters of title, headline and description,
  but `/coverage` sliced it to 600 — throwing away over half, usually the description,
  which is often the part that actually names the story. Now passed in full, with the
  prompt treating it as primary and the transcript as corroboration.
- YouTube's expanded video description is read from the DOM, since `og:description`
  there is truncated to roughly the first line.

**Feedback does something.**
- **Helpful** now actually posts to `/coverage/feedback` — it previously only greyed
  out the button, so the endpoint had never once received a thumbs-up — and ends the
  session.
- **Not helpful** keeps listening and retries, reusing the transcript already
  collected rather than discarding it, and tells the backend to rule that story out.
  The backend enforces the exclusion server-side rather than trusting the prompt.

**Speed and robustness.**
- Retries now wait for new transcript material rather than a flat 15-second clock,
  and skip entirely when nothing has changed — saving a NewsAPI call that could only
  have returned an identical answer.
- `/factcheck` runs its claims concurrently instead of serially.
- Groq, Tavily and Whisper calls are now bounded (10s/10s/20s, one retry). The Groq
  SDK was defaulting to a 10-minute timeout while the extension gave up at 30s.
- `FAST_MODEL` now falls back only on a 404 and latches, instead of firing a second
  call on rate limits and timeouts where it could not possibly help.
- `/status` no longer reports `.env.example` placeholder keys as "configured", and
  startup warns about them explicitly.

---

## v1.5.0 — Retry-until-confident, public reaction, trust fixes (2026-07-10/11)

**Why:** live-testing v1.4.0 surfaced three real problems: a single miss on story
identification meant giving up and waiting for the viewer to press Start again;
results took a flat 20 seconds even when the page's own title already gave the story
away; and two bugs (a tab-resolution mixup, an unhelpful "401" error) actively broke
the "Check statements"/"Check public reaction" flow. This release is mostly fixes and
one genuinely new feature — the tool got faster and more resilient rather than bigger.

**Retry instead of giving up:**
- **The automatic check no longer stops after one miss.** If no story can be
  identified yet, or the consensus check flags low confidence, the session keeps
  listening and tries again — up to 3 attempts, 15 seconds apart — instead of
  auto-stopping on the first failure. A real success, a missing NewsAPI key, or a hard
  error still stop immediately, since retrying those can't help.
- **Retries build on each other, not from scratch.** Each retry hands the model its
  own previous guess (`previousGuess` in `/coverage`) — "a previous pass tentatively
  identified this as X, confirm/refine/correct using the fuller information now
  available" — rather than independently re-guessing every time. Transcript
  accumulation across attempts was already automatic (the caption buffer never resets
  mid-session); this closes the other half of "use the old context."

**Faster first results:**
- **The check fires off page signals, not a flat 20s wait.** Page title/headline is
  usually available within ~1 second of pressing Start; a new fast-path timer (~5s)
  replaces the old fixed 20-second wait whenever real page signals exist, with the 20s
  timer surviving only as a fallback for pages with no usable title at all.
- **`/coverage` accepts page-signals-only requests** — a transcript is no longer
  required if the page title/description clearly names a story, so the very first
  check doesn't have to wait for any spoken audio to be transcribed.
- **The 15-word minimum for trusting captions is gone** — any amount of caption text,
  even a few words, is used immediately instead of being discarded until a threshold
  is hit.
- **Story identification uses a smaller, faster Groq model** for the lean
  extraction step (headline + search query), with an automatic fallback to the
  full model if that model name isn't available.

**Broader page-signal scraping:** on top of `<h1>`/Open Graph, the content script now
reads JSON-LD structured data (`Article`/`NewsArticle`/`VideoObject` schema — what
most professional news and video sites already embed for SEO), Twitter Card meta
tags, and `itemprop="headline"` microdata — standards-based signals that travel
across platforms instead of depending on one site's DOM structure.

**"What people are discussing" (new):** a third on-demand action on the note, "Check
public reaction" — searches (Tavily, reusing the note's story query) for public
discussion/reaction and summarizes its tenor, explicitly instructed to describe
opinions as opinions and never fabricate a quote. Kept in its own labeled section,
never blended with the outlet coverage above it. Explicitly *not* a reimplementation
of X/Meta's real Community Notes mechanism (which filters crowd-submitted ratings) —
documented as "inspired by, not the same as."

**Thumbs up / thumbs down on a note:** rates the story identification specifically.
Thumbs down dismisses the note immediately and evicts that story from the backend's
cache, so a repeat check doesn't silently reuse the same wrong result. Thumbs up is a
lightweight, honest acknowledgment only — no functional effect on future checks, no
pretending it "trains" anything.

**Pause-aware checking:** the content script reports when the page's video pauses or
resumes; the pending automatic check is cancelled while paused (nothing to check
against a stale moment) and re-armed on resume, so a paused video can't silently burn
an API call.

**Reliability fixes:**
- **Fixed a real bug** where "Check statements" and "Check public reaction" failed
  with "Build a note first" even right after a note was built — caused by resolving
  the target tab through `chrome.tabs.query({currentWindow: true})`, which is
  ambiguous when called from a service worker. Now resolved from the note data itself.
- **Error banners show the real reason, not a bare status code** — e.g. "401 Invalid
  API Key — check your API keys in Settings" instead of "/coverage returned 401" —
  across every backend call.
- **In-panel Start button**, colored green; Stop stays red — the one deliberate
  exception to the monochrome design, for universal go/stop signaling. Opening the
  panel no longer auto-starts a session; only the Start button does.
- **Live activity log** under the Community Notes header shows real, specific
  progress ("Reading 47 words from captions," "Got a 62-word transcript — identifying
  the story…") instead of a blank wait or a generic label.

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
