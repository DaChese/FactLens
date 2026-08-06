# FactLens — TODO

Punch list as of 2026-07-10 (v1.4.0+, plus this session's retry/thumbs/pause work —
see below). Ordered roughly by priority for the capstone demo.
See also: `docs/demo-script.md` (the run-of-show + pre-demo checklist, in full detail),
`docs/ai-methodology.md`, `docs/ethics-and-trust.md`, `docs/user-journey.md`.

---

# ⚠️ OPEN — picked up 2026-08-05, work in progress

Everything in this top block is newer than the punch list below it. **Much of the
old list is already done** — see "Stale entries" at the end before trusting it.

## Blocking the demo — do these first

- [ ] **`backend/.env` is still the unedited `.env.example`.** `GROQ_API_KEY` is
      literally `gsk_...` and `TAVILY_API_KEY` is `tvly-...`; both are rejected with
      401 (verified against live Groq). `NEWSAPI_KEY` is not set at all.
      **Without a NewsAPI key `/coverage` returns `available: false` and no
      Community Note is built at all** — the whole product. Either fill in `.env`
      or confirm all three keys are set on the extension's Settings page.
      The backend now prints an explicit placeholder warning on startup.
- [ ] **End-to-end run with real API keys** against live audio — still never done.
      Now also worth capturing the new `[/coverage] timing: story=… news=… context=…
      total=…` log line to see where the time actually goes.
- [ ] **Verify caption capture on real news sites** (CNN/NBC/local). Their players
      are iframes, which is what `all_frames` was for. Note any site matching no selector.
- [ ] **Confirm `llama-3.1-8b-instant` still resolves.** Grep the backend log for
      `is unavailable (404)`. The fallback now latches instead of retrying forever,
      so if you see that line once, the fast path is dead and needs a new model name.
- [ ] Record the backup demo video; get a spare NewsAPI key for rehearsals.

## Decided and done — confirming the story now ends the session

Decision made 2026-08-06: **"Helpful" posts the thumbs-up to `/coverage/feedback`
and stops the session.** Both halves are implemented in `buildRatingRow`
(`sidebar/sidebar.js`). This also fixed a real bug — "Helpful" previously sent
nothing to the background at all, so `/coverage/feedback` had never once received
a thumbs-up in the product's history; only thumbs-down was ever sent.

- [ ] Verify on a real run that the session actually stops on "Helpful" and that
      "Check statements" / "Check public reaction" still work afterwards (they
      should — `clearCaptureState` deliberately preserves the note's transcript
      and query).

## Stop button — partially fixed, rest still open

A user hit "the stop button didn't work." Root cause was several bugs at once.
**Fixed this session:** `STOP_SESSION` now always broadcasts `idle` even when there
is no active session (previously a no-op, which made a desynced panel permanently
stuck); the three `finally` blocks in `buildNote`/`runClaimCheck`/`runDiscussionCheck`
now broadcast the *real* status via `broadcastLiveStatus()` instead of unconditionally
re-broadcasting `listening` over a session that had already ended; `stopSession()`
clears the session flag first so in-flight guards see it immediately; a
`sessionGeneration` counter now invalidates timer callbacks left over from a stopped
session; and Stop shows "Stopping…" instead of no feedback at all.

**Also fixed 2026-08-06 — the session-lifecycle round:**

- **The "records forever" bug is closed.** MV3 suspends the worker after ~30s idle
  and `setTimeout` does not survive that, so a suspension while a timer was pending
  left the session flagged active, the offscreen document capturing audio, and the
  panel on "Listening" — permanently. Fixed with a heartbeat from the offscreen
  document (`startHeartbeat` in `offscreen.js`), which is the only timer in the
  system MV3 cannot suspend. It wakes the worker every 15s and enforces a local
  6-minute recording cap that works even if the worker never comes back.
- **`handleHeartbeat` in `background.js`** is the watchdog: a 5-minute wall-clock
  session cap, plus "session active but nothing scheduled" detection (two strikes,
  ~30s, to avoid tripping on the legitimate await-windows in `scheduleFastCheck`
  and `rescheduleAfterResume`). It force-stops; it deliberately never *resumes* the
  pipeline, because after a restart every input is empty and resuming would pay for
  a Whisper call and a `/coverage` call to build a note out of nothing.
- **`ANALYZE_NOW` now ends the session** once the note lands, instead of leaving an
  active session with zero scheduled work. Follow-up checks still work afterwards.
- **`startedAt` and `attempts` are persisted** in `chrome.storage.session`, so
  `MAX_AUTO_CHECK_ATTEMPTS` survives a worker restart instead of silently resetting
  and allowing another full round of `/coverage` spend.
- **`startSession` no longer announces "listening" before capture exists**, and
  bails if a Stop landed during setup — previously that left audio recording with
  no session record able to stop it. Its `catch` now closes the offscreen document.
- **Multi-tab recorder leak fixed**: `startRecording` stops any existing recorder
  and its tracks before reassigning. Starting on tab B used to orphan tab A's capture.
- **`content.js` resets its dedup state on `SESSION_STARTED`.** Its change-detection
  lives in the page, so a second session on the same page never re-sent
  `PAGE_SIGNALS`, `scheduleFastCheck` never ran, and it silently fell back to the
  slow 20s timer.
- **The panel self-heals**: `syncStatus()` re-asks every 10s (guarded so it can't
  stomp an in-flight check), so a lost STATUS broadcast no longer strands it.
- Ready-hint text no longer claims "about 20 seconds".

**Deliberately NOT done — `chrome.alarms`.** An earlier draft of this list
prescribed replacing `setTimeout` with `chrome.alarms`. That advice was wrong and
is retracted: alarms have a **30-second minimum**, and **unpacked extensions are
exempt from that floor**. Every timer here is 4–20s, so alarms would have fired
correctly in development and silently clamped once packed — a reliability
mechanism whose failure mode is invisible in every test you'd run. The offscreen
heartbeat has identical packed/unpacked behaviour and needs no new permission.

**Deliberately NOT done — scoping `STOP_SESSION` to one tab.** It stops every tab's
session, which is technically imprecise but is the safer behaviour when the
complaint is "a session is stuck": restricting it would make a stranded session on
another tab unreachable. Revisit only if multi-tab becomes a real use case.

Still open:

- [ ] **The other 16 in-memory state objects are still not rehydrated** after a
      worker restart (`transcriptBuffers`, `lastAttemptGuess`, `lastCaptionAt`, …).
      This is a quality degradation, not a correctness bug — the watchdog now ends
      such sessions cleanly rather than letting them hang. Persisting a rolling
      200-word buffer on every caption tick is a real perf cost; not worth it
      before the demo.
- [ ] **Verify the watchdog manually** — see the test matrix below. The
      `chrome://serviceworker-internals/?devtools` **Stop** button terminates the
      worker deterministically, which turns "wait 30s and hope" into one click.
      Temporarily lower `MAX_SESSION_MS` to ~45s to test the cap in under a minute.

## Public reaction — social platforms (in progress)

`/discussion` now restricts its Tavily search to `SOCIAL_DOMAINS` (Reddit, Hacker
News, Quora, Bluesky, Threads, YouTube, X, Facebook) instead of searching the whole
web, labels each result with its platform, and returns `platform` per source plus a
`platforms` array. Still one search and one Tavily credit.

- [ ] **Not yet verified against live Tavily** — no working key locally. Confirm
      real results come back and that restricting domains doesn't make results
      *thinner* than the old whole-web search. If it does, add a fallback to an
      unrestricted search when the social pass returns fewer than ~2 results
      (costs a second credit only when it fires).
**Done 2026-08-06:** the sidebar now shows the platform name ("Reddit", "Hacker
News") instead of a bare hostname, the web studio keeps the field and prefixes each
source with it, and `DISCUSSION_SYSTEM_PROMPT` is told the results are
platform-labelled — so the summary can say "on Reddit, the common reaction is…"
instead of flattening every audience into "people online". The prompt also now
forbids describing the tenor as what "the public" thinks, since these results are
whatever was publicly reachable, not a representative sample.

- [ ] **Be honest about reach in the docs/pitch.** X blocks crawlers on most posts
      and Facebook is almost entirely login-walled — expect most results from
      Reddit. Don't claim Facebook/Twitter coverage on a slide that won't hold up.
      Nothing in `docs/` says this yet.

## Source dates and discussion relevance (done 2026-08-06)

Reported: statement checks showed no source dates; public-reaction sources were
sometimes about a different story entirely; and both follow-up checks *looked* like
they restarted a capture session.

- **Source dates on statement checks.** Tavily returns `publishedDate` on every
  result and `/factcheck` was discarding it. `sources` is now
  `{url, title, publishedDate}[]` instead of `string[]`, the date goes into the
  verdict prompt (with rules to prefer recent evidence and lower confidence when
  the only support is dated), and both frontends render `domain · Mar 4, 2026`.
  Both frontends still accept the old bare-string shape, since the backend's
  1-hour verdict cache can still hold it — **verified with a throwaway Playwright
  spec**, since that's the kind of thing that silently throws in the UI.
- **Dates are formatted in UTC.** Found while testing: `2026-03-04T00:00:00Z`
  rendered as "Mar 3" in America/New_York, because midnight UTC is the previous
  evening locally. Every publication date would have been a day early for anyone
  west of UTC — the opposite of making dates line up.
- **Discussion relevance gate.** `/discussion` now scores each result with
  `keywordOverlap` from `lib/textMatch.js` (the same check `/coverage` uses to
  validate its story match) against the query *plus the note's headline*, which
  `background.js` now sends as `lastNoteStory`. Results also need a minimum Tavily
  score, and anything positively datable as older than 60 days is dropped —
  **dates are a soft filter**, undated results are kept, since Tavily leaves
  `publishedDate` empty on most social content. Survivors sort newest-first.
  Below 2 relevant results it returns no summary rather than summarizing noise,
  which the UI already renders as "Not enough public discussion found to
  summarize yet."
- **The phantom "listening" state.** `updateStatus` treated `'processing'`
  identically to `'listening'`, so it revealed Stop and "Check now" — the chrome
  that means a session exists — even though the follow-up checks deliberately run
  after the session ends. Session state and working state are now tracked
  separately: buttons key off `sessionActive`, label and activity line key off
  status, and `'processing'` says nothing about whether a session exists.
- **Fixed a bug I introduced last session.** The `syncStatus()` 10s poll was
  guarded by `checkBtn.disabled`, which is only ever set by the header "Check now"
  button — so it did nothing during `CHECK_CLAIMS`/`CHECK_DISCUSSION`, exactly the
  two flows that routinely exceed 10s. It was wiping the progress line mid-check.
  Now guarded by a `busyChecks` counter covering all three flows.

- [ ] **Thresholds are unverified against live Tavily** (`MIN_RELEVANCE = 0.25`,
      `MIN_TAVILY_SCORE = 0.3`, `MAX_AGE_DAYS = 60`, `MIN_RESULTS = 2` in
      `discussion.js`). They were reasoned, not measured. If public reaction starts
      coming back empty too often on real stories, loosen `MIN_RELEVANCE` first —
      the backend logs `N/M relevant results` on every call, so the ratio tells you
      directly whether the gate is too tight.
- [ ] **`GET_STATUS` is global, `broadcastLiveStatus` is per-tab.** The 10s poll
      asks "is ANY tab in a session", so a session on another tab would report
      "listening" for the tab you're looking at. Harmless for a single-session
      demo; fix if multi-tab ever matters.

## Title/description weighting, page comments, thumbs-down retry (done 2026-08-06)

- **The page title and description were being truncated before the model saw
  them.** `content.js` curates ~1500 chars of title, headline and description,
  but `identifyStory` sliced it to 600 — throwing away more than half, usually
  the description, which is often the part that actually names the story. Raised
  to 1500 and the prompt now treats title/description as the PRIMARY signal with
  the transcript as corroboration, rather than "weigh it heavily".
- **YouTube's full video description is now captured.** `og:description` is
  truncated to roughly the first line on YouTube, so `readExpandedDescription()`
  reads the real one from the DOM. Worth one site-specific selector despite the
  standards-based approach used elsewhere, since it's the demo platform.
- **Public reaction now uses comments on the page being watched.** `content.js`
  scrapes YouTube and generic comment selectors into `PAGE_COMMENTS`;
  `background.js` snapshots them with the note (so "Check public reaction" still
  works after the session ends) and sends them to `/discussion`. Comments need no
  relevance gate — they're attached to this exact video, so there is no
  story-matching step that can go wrong. **When there are 5 or more, the Tavily
  search is skipped entirely** — strictly more on-topic and one credit cheaper.
  Verified: the log shows `5 page comments + 0 searched results (search skipped)`
  and the Tavily budget counter does not move.
  Public reaction now also works with **no Tavily key at all** when the page has
  comments.
- **Thumbs down keeps listening instead of dismissing.** "Not helpful" now sends
  the rejected story, restarts the session if it had stopped, **re-seeds the
  transcript buffer with the transcript already collected** (it cost real time and
  possibly a paid Whisper call — only the conclusion drawn from it was wrong), and
  retries. `/coverage` accepts `rejectedStories` and both instructs the model not
  to repeat them and enforces it server-side via `keywordOverlap`, since asking a
  model not to repeat an answer is a request rather than a guarantee.

- [ ] **YouTube lazy-loads comments** — they only exist in the DOM once the viewer
      scrolls to them. We deliberately do NOT auto-scroll (hijacking the viewer's
      scroll position mid-video is worse than having fewer comments), so on a
      video nobody scrolled, comment count is 0 and it falls back to the search.
      Worth knowing before the demo: **scroll down once** if you want the
      comments path shown.
- [ ] **Comment selectors are unverified against live YouTube.** The renderer
      names (`ytd-comment-thread-renderer`, `ytd-comment-view-model`) change
      periodically. Check the console for a non-zero comment count; if it's
      always 0 on a scrolled page, the selectors need updating.
- [ ] Verify the thumbs-down retry end to end: it should keep listening, not
      re-offer the rejected story, and not make the viewer wait through
      re-collecting speech already transcribed.

## Quoted public reaction from multiple platforms (done 2026-08-06)

Public reaction now returns **verbatim quotes** — what people actually said —
rather than only a tenor summary, drawn from page comments *and* Reddit, X,
Hacker News and the rest of `SOCIAL_DOMAINS`.

- **Reversed the "skip the search when comments exist" optimization** added
  earlier the same day. It saved a Tavily credit but directly worked against
  breadth: on a video with comments you'd have got no Reddit or X at all. The
  search now always runs when a key is present, and comments are additional
  evidence rather than a replacement. One credit for both is the right trade.
- **Quotes are verified, not trusted.** The model returns each quote with the
  label of the item it came from; `verifyQuotes` then checks the text actually
  appears in that item's source text and silently drops it otherwise. A
  fabricated quote attributed to a real person on a real platform is the most
  damaging thing this feature could emit, and a prompt rule alone is a request,
  not a guarantee. Verified against 8 cases including a fabrication, a
  paraphrase, and a real quote attributed to the wrong source — all correctly
  rejected; punctuation/case reformatting correctly kept.
- `max_tokens` for the discussion call went 200 → 900. Quotes cost tokens, and
  200 would have truncated the JSON mid-array, losing every quote to a parse
  failure rather than degrading gracefully.
- Tavily now requests `includeRawContent` and a wider `maxResults` (12), because
  a 300-character snippet rarely contains a whole quotable opinion.
- Both UIs render quotes as attributed, indented blockquotes with platform and
  date; quotes alone are enough to show the section, without a tenor summary.

- [ ] **X/Twitter coverage will still be thin and that is not fixable here.** X
      blocks crawlers on most posts, so Tavily reaches comparatively little of it.
      It stays in `SOCIAL_DOMAINS` so public posts surface when reachable, but
      expect Reddit to dominate. Don't promise X coverage on a slide.
- [ ] **Watch how many quotes survive verification on real data.** The backend
      logs `N verified quotes from: ...` on every call. If N is often 0 while the
      summary is fine, the model is likely paraphrasing rather than copying —
      tighten the prompt's verbatim rule before loosening the check.
- [ ] Quote rendering is unverified against real payloads (no live keys). The
      styles are new (`.fl-quote*` in `sidebar.css`, `.quote*` in `styles.css`).

## Relevance gate was far too strict — fixed with real-run evidence (2026-08-06)

A live run produced `0/12 searched results were relevant to "MTA subway upgrade
delays New York City"` and then `Nothing relevant — not summarizing`. The gate
I'd tuned was rejecting everything. Two root causes, both now fixed:

- **No stemming.** "Why is the L train always DELAYED" scored **0.00** against a
  story about "DELAYS". `relevanceScore()` in `discussion.js` now stems tokens.
  Measured on the real MTA story: **3/4 on-topic results kept, versus 0/12
  before.** Kept local rather than changing `lib/textMatch.js`, because
  `/coverage`'s confidence thresholds are tuned against that exact function and
  loosening it there would quietly change which notes get flagged low-confidence.
- **Three gates stacked with no per-gate logging**, so a total wipeout was
  undiagnosable. Each pass now logs `dropped — off-topic: N, low score: N,
  wrong date: N`. `MIN_TAVILY_SCORE` dropped 0.3 → 0.1 (its score isn't
  calibrated for this use) and `MIN_RELEVANCE` 0.25 → 0.2.
- **Age is now measured from the STORY's date, not today.** A story that broke
  three weeks ago has three-week-old discussion; judging that against "now" threw
  away exactly the reaction we wanted.
- **A broader second pass** now runs when the strict pass finds fewer than 2
  usable results: whole web instead of social domains, lower bar, no date
  ceiling. Costs a second Tavily credit only when the first pass came up short,
  so a too-tight threshold degrades into a wider search instead of into silence.
- **`/factcheck` retries claim extraction with a lower bar** when the strict pass
  finds none — the other half of the reported symptom (`No verifiable claims
  found in transcript`). The retry accepts hedged/attributed and comparative
  statements but still refuses pure opinion and prediction.
- **The search is now best-effort.** Found while testing: a failing Tavily call
  sank the whole request even when page comments were present and needed no
  search at all. It now logs and continues on comments alone; with no comments to
  salvage, the error still propagates.

### Dates

- `/coverage` returns `story_date` (most recent article date from NewsAPI) and a
  per-article `publishedAt`. Both UIs show "Story dated ..." under the headline
  and the date beside each outlet in "Other coverage".
- The story date is passed to `/discussion`, which uses it to anchor both the
  search window and the age filter.

- [ ] **Recall is deliberately favoured over precision now.** "New York City
      council passes housing bill" still scores 0.33 against the MTA story on
      shared place names. That's an accepted trade: a false positive costs a
      slightly noisier evidence set that the prompt is told to ignore, while a
      false negative costs the entire feature (as 0/12 showed). Revisit only if
      summaries start drifting off-topic.
- [ ] **Watch the new per-gate drop logs on real runs** and retune from data
      rather than reasoning — that's what went wrong the first time.

## Speed work — done this session, worth verifying live

Retries now wait for **new transcript material** instead of a flat 15s clock (fires
in ~4–8s when captions flow; skips the retry entirely when nothing changed, which
saves a NewsAPI call that could only have returned an identical answer). `/factcheck`
runs its claims concurrently. Groq/Tavily/Whisper calls are now bounded (10s/10s/20s,
`maxRetries: 1`) — previously the Groq SDK defaulted to a 10-minute timeout while the
extension gave up at 30s. `FAST_MODEL` falls back only on a 404 and latches.

- [ ] **Verify the retry guard against real captions.** `RETRY_MIN_NEW_WORDS = 15`
      and `AUTO_CHECK_RETRY_POLL_MS = 4000` were reasoned, not measured.
- [ ] **`response_format: {type:'json_object'}` is unverified against live Groq**
      (no working key). Added to story ID, factcheck verdicts, and the discussion
      summary. Story ID self-heals: a 400 retries once without it and latches.
      The other two degrade gracefully. Still worth confirming on the first real run.
- [ ] Fixed but unverified: the coverage cache used to serve one transcript's
      "missing context" for a *different* transcript on the same story. Articles are
      still cached by query; context is now keyed by query + transcript fingerprint.

## Manual test matrix for the session-lifecycle work

None of this is coverable by the Playwright suite — that drives the backend web
studio, and MV3 lifecycle / `chrome.offscreen` / `chrome.tabCapture` don't run
headless. Building a Puppeteer harness is ~a day and would need rewriting as this
changes; manual is the right call before the demo.

Tool you need: `chrome://serviceworker-internals/?devtools` has a per-worker
**Stop** button that kills the worker exactly as the idle timeout would.

- [ ] **T1 — regression check.** Captioned video, CC on, Start. Note in ~5-8s,
      session stops cleanly. Confirms the fast path is untouched.
- [ ] **T2 — the original bug.** Captions off. Start, pause the video within 2s,
      wait 90s. Previously: worker inactive at ~30s, capture indicator stuck on,
      panel stuck on Listening. Now: watchdog stops it. Lower `MAX_SESSION_MS`
      temporarily to verify quickly.
- [ ] **T3 — Check now.** Start, immediately press Check now. Note lands, status
      goes Idle, capture stops. Previously stayed "Listening" forever.
- [ ] **T4 — worker death.** Captions off, Start, then Stop the worker from
      serviceworker-internals at ~3s. Worker should respawn within 15s on the
      heartbeat and log `Watchdog: … no scheduled work` after two strikes.
- [ ] **T5 — orphaned recorder.** Start, then in the worker console run
      `chrome.storage.session.set({activeSessions:{}})` and kill the worker. Next
      heartbeat should hit the "unknown session" branch and close the offscreen doc.
- [ ] **T6 — attempt cap across a restart.** Force retries (a page with a garbage
      title so `/coverage` finds no story), watch `Attempt N/3`, kill the worker
      between attempts. Total attempts must still be ≤ 3.
- [ ] **T7 — follow-ups after stop.** Build a note, let it auto-stop, then press
      "Check statements" and "Check public reaction". Both must still work — this
      is the regression guard for the Check-now change.
- [ ] **T8 — second session on the same page.** Stop → Start without navigating.
      Should now get page signals immediately and use the fast path, not fall back
      to the 20s timer.
- [ ] Verify "recording actually stopped" three ways: the tab's capture indicator
      disappears; `await chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})`
      returns `[]`; and the offscreen console logs `Recording stopped`.

## Still worth doing, not started

- [ ] **Split `/coverage`** so the headline appears before coverage finishes
      (~5x better time-to-first-content). Deliberately deferred: half a day, touches
      the extension, and would make each note consume 2 of the 6/min throttle slots —
      raise that throttle in the same commit or expect a phantom 429 on stage.
- [ ] **Model IDs are hardcoded** in four route files with `llama-3.3-70b-versatile`
      duplicated three times. Move to env vars with in-code defaults so a
      decommissioned model doesn't need a code change.
- [ ] Warm the Groq/NewsAPI TLS connections at startup (~150–300ms off the first
      note only — but that's the first note of the demo).

---

# Older punch list (2026-07-10) — verify before trusting

**Stale entries — already done, ignore:** the entire "Documentation debt" section
below (manifest is at 1.5.0, CHANGELOG has v1.5.0, `ai-methodology.md` documents the
retry loop, `ethics-and-trust.md` covers thumbs up/down, `architecture.md` was
rewritten 2026-08-05); "no automated tests anywhere" (3 Playwright specs now cover
the web studio); "there is no hosted version" (Railway serves the studio).

## Documentation debt (highest priority — these get quoted live in front of judges)

None of the following are mentioned anywhere in `README.md`, `CHANGELOG.md`, or
`docs/` — confirmed by grep, not assumption:

- [ ] **`docs/ai-methodology.md`** doesn't mention the retry/refinement loop
      (`autoRunAndStop` in `extension/background.js`): a miss doesn't give up, it
      retries up to 3x, and each retry hands the model its own previous guess to
      confirm/refine/correct with new evidence (`previousGuess` in
      `backend/routes/coverage.js`). This is a genuinely strong "agentic AI" talking
      point that's currently invisible to whoever presents this.
- [ ] **`docs/demo-script.md`** doesn't account for a session that retries — add a
      line to the run-of-show and Q&A prep for what a retry looks like live, since it
      may well happen during the actual demo.
- [ ] **`docs/ethics-and-trust.md`** doesn't cover the thumbs up/down mechanism
      (`POST /coverage/feedback`) — directly relevant to the "trust framework" framing
      the doc already argues for elsewhere.
- [ ] **`CHANGELOG.md`** stops at v1.4.0 — nothing from the retry logic, thumbs
      up/down + cache invalidation, pause-awareness, or the broadened JSON-LD/Twitter
      Card page-signal scraping is recorded.
- [ ] **`extension/manifest.json`** version is still `1.4.0` despite several rounds of
      real feature work since — bump it before it ships/demos.

## Must do before the demo

- [ ] **End-to-end run with real API keys**, now including the new `/discussion`
      route. Nobody has exercised the full pipeline (Whisper → story ID → NewsAPI →
      missing context → claims → public reaction) against live audio yet.
      Backend up → reload extension → YouTube news clip → wait ~20s → Check now →
      note appears → Check statements → Check public reaction.
- [ ] **Verify caption capture in a real browser.** Open a YouTube video with CC on,
      check the console for `[FactLens] Captions found via "..."`. Then try 1–2 real
      news sites (CNN, NBC, local station) — their players are usually iframes, which
      is exactly what `all_frames` was added for. If a site doesn't match any selector,
      note which site so its player selector can be added.
- [ ] **Run the full pre-demo checklist in `docs/demo-script.md`** before presenting —
      backend up, Settings → API Status → Refresh → all providers OK, budgets not near
      their caps, exact demo clip rehearsed, backup recording cued.
- [ ] **Record the backup demo video** referenced in `docs/demo-script.md`.
- [ ] Consider a **backup NewsAPI key** (free) in case the daily 100 gets consumed
      by rehearsals.

## Should do (quality / credibility)

- [ ] **`docs/architecture.md` is stale** — it describes the old continuous pipeline and
      bias meter. Update it to the on-demand Community Note flow (or delete it and let
      README + CHANGELOG carry it).
- [ ] **Team review of `backend/data/bias-ratings.json`.** The ~48 outlet ratings are
      AllSides/Ad Fontes-style *approximations* written for the prototype. Someone should
      sanity-check them against the current published AllSides chart — judges may ask
      where the ratings come from. (See `docs/ai-methodology.md` §5 and
      `docs/ethics-and-trust.md` §4 for exactly how this is currently disclosed.)
- [ ] **Re-verify the X/Meta Community Notes research claims** in
      `docs/ai-methodology.md` against their cited sources one more time before they go
      on a slide — this is the highest-scrutiny research claim in the deck.
- [ ] **Verify presentation stats before they go on a slide:** the "declining trust in
      media" claim should cite a real source (Gallup's annual media-trust survey is the
      standard one); ATSC 3.0 adoption/market-coverage numbers should come from
      ATSC/NAB/Pearl TV materials, not memory.
- [ ] **Story-change handling:** if the viewer checks two different stories in one
      session, the old note is archived below the live one — verify this looks right
      with real data.
- [ ] Spanish end-to-end test (transcription auto-detects; NewsAPI is queried with
      `language=es` — confirm results actually come back for a Spanish clip).
- [ ] **Verify `FAST_MODEL` (`llama-3.1-8b-instant`) is still a valid Groq model
      name** before demo day — `backend/routes/coverage.js` falls back to the full
      model automatically if it 404s, so nothing breaks either way, but the speed
      win only applies if the fast model actually resolves. Check the backend log
      for `"falling back to llama-3.3-70b-versatile"` — if you see that line, the
      fast path isn't working and the name needs updating.
- [ ] **Confirm the story-ID model swap didn't hurt accuracy** — it's a smaller
      model now, doing the same job faster. Watch the "Matched on:" confidence
      levels across a few real notes; if `low_confidence` starts showing up more
      than before, the tradeoff isn't worth it and `FAST_MODEL` should just be set
      equal to `MODEL`.
- [ ] **Watch the NewsAPI/Tavily budget numbers during rehearsals.** Retries mean a
      hard-to-identify story can now cost up to 3x the story-ID/NewsAPI calls it used
      to (bounded by `MAX_AUTO_CHECK_ATTEMPTS = 3` in `extension/background.js`).
      Check Settings → API Status before and after a rehearsal block; consider
      lowering the attempt cap specifically for demo day if the budget looks tight.

## New features worth considering

- [ ] **Visible retry state in the sidebar.** Right now a retry is invisible from the
      UI's perspective — status just returns to "Listening," and the ready-hint text
      still says "about 20 seconds" even though retries are 15s apart. Something like
      "Still narrowing down the story (attempt 2 of 3)…" would make the retry loop
      visible instead of looking identical to idle listening — and per the
      competition-differentiation notes below, this loop is actually a good demo
      moment if it's shown rather than hidden.
- [ ] **Chyron / on-screen graphics OCR** — the last unimplemented piece of the original
      problem statement ("visual content"). Needs frame sampling + OCR or a vision model;
      scoped as its own sprint. Image *metadata* (alt text, captions) is already used.
- [ ] **Export the note log** — let a viewer save the session's notes with sources;
      supports the broadcaster-accountability story.
- [ ] **Hosted backend** with auth + per-user quotas (required for anyone to use this
      without running Node locally; prerequisite for Phase 2/3 — see
      `docs/roadmap-phase2-3.md`).

## Efficiency & speed

- [ ] **Streaming/progressive `/coverage` response** — the most direct remaining lever
      for "faster everything." Right now "Check now" is one request/response; the
      sidebar's live activity line tells the viewer *what's happening* during the
      wait, but the story headline itself only appears once the entire pipeline
      finishes. Splitting `/coverage` so the headline shows the moment it's
      identified, with outlet coverage filling in a beat later, would feel
      substantially faster without changing total work done — real architectural
      change (multiple round trips or a streaming endpoint), not done here.
- [ ] **A faster Whisper variant**, if Groq offers one — same idea as `FAST_MODEL` for
      story ID, just not yet applied to transcription. Audio transcription (the
      no-caption path) is still the single biggest latency source that hasn't gotten
      a speed pass.
- [ ] **Skip a retry if nothing's actually changed** since the last attempt (same
      transcript buffer, same page signals) — right now a retry fires again
      regardless, which can waste a call when there was never going to be new
      information to find. Cheap guard to add.
- [ ] `AUTO_CHECK_FAST_DELAY_MS` (5s) and the retry delay (15s) were chosen by
      reasoning, not measurement — worth tuning down once real session data shows how
      much margin is actually needed.
- [x] ~~Retries burning duplicate NewsAPI calls on the same story~~ — checked, not an
      issue: `coverageCache` in `backend/routes/coverage.js` is written regardless of
      confidence, so a retry landing on the same story gets a cache hit instead of a
      fresh NewsAPI call. Confirmed by reading the code, not assumed.

## Alternative architectures worth evaluating (not necessarily switching to)

- [ ] **Fewer LLM round trips per note.** Story identification and missing-context
      extraction are sequential today because missing-context needs the NewsAPI
      results, which need the identified query first. A restructure (rough keyword
      extraction → NewsAPI search → single combined identify+context call) could cut
      one full model round trip per note.
- [ ] **Server-Sent Events or a WebSocket** instead of one-shot REST for `/coverage`,
      so the backend can push each stage as it completes instead of the client
      waiting for one big response — the real mechanism behind the streaming idea
      above, not just a UI trick.

## Next-Gen TV / ATSC 3.0 adoption planning

("Practicality and implementation feasibility" is an explicitly judged category —
this section is as much for the pitch as for the code.)

- [ ] **Expand `docs/roadmap-phase2-3.md` from feasibility notes into an adoption
      plan** — a rough Phase 2 pilot plan (what station/content partner, what
      hardware, what success looks like), and a Phase 3 technical migration checklist
      (Chrome extension concepts → A/344 broadcaster app, what's reusable vs. rebuilt).
- [ ] **Research what real ATSC 3.0 broadcasters/vendors are currently shipping** for
      interactive content, to ground the roadmap in what's actually happening in the
      industry right now — makes the "why now" urgency argument concrete instead of
      assumed.
- [ ] **Phase 2: live broadcast testing** — HDMI capture card → browser tab rig;
      measure transcript accuracy and note latency against real broadcast audio.
- [ ] **Phase 3: ATSC 3.0 prototype** — companion-app path first (A/338), broadcaster-
      hosted A/344 app with a station testbed second. Not a Chrome extension port.

## Competition-differentiation ideas (for the pitch, not just the code)

- [ ] The retry-with-refinement loop is a genuinely strong "look, it's actually
      reasoning" demo moment if it's visible on screen — see "Visible retry state"
      above. Currently invisible, which wastes a real differentiator.
- [ ] A visual (not just textual) treatment of the confidence/consensus check — right
      now "Matched on: ..." is plain text; something that visually reads as
      "verification in progress" would make the trust mechanism land harder with
      judges in the room.
- [ ] Spanish-language support already exists and is untested live — demonstrating it
      briefly would be a low-effort, high-signal moment showing real breadth.

## Testing / robustness

- [ ] No automated tests anywhere in the project (extension or backend) — reasonable
      for a hackathon timeline, but worth naming explicitly as a known gap rather than
      an oversight.
- [ ] **Multi-tab edge case**: `CHECK_CLAIMS`/`CHECK_DISCUSSION` resolve the note's
      tab via "the first tab with note data" (`Object.keys(lastNoteTranscript)[0]` in
      `extension/background.js`) — correct for the realistic single-session case, but
      would misbehave if a viewer ran FactLens on two tabs at once.
- [ ] Cross-check the original "fix-up prompt" document (Phases 1–4 bug list) — it was
      never added to the repo; if it still exists, confirm nothing from it is missing.

## Known limitations (document honestly if asked)

- Outlet bias ratings are static and US-centric; unrated outlets show as "unrated."
- Story consensus uses keyword overlap — good at catching total mismatches, not subtle ones.
- NewsAPI free tier only returns articles, not TV transcripts — "who else is covering
  this" means *online* coverage.
- In-memory caches and budgets reset when the backend restarts.
- The extension requires the backend running on localhost; there is no hosted version.
- Pause detection watches only the first `<video>` element in DOM order — a page with
  multiple video elements may not be tracked correctly.
- `CHECK_CLAIMS`/`CHECK_DISCUSSION` assume a single active note session (see
  "Multi-tab edge case" above).
