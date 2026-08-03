# FactLens — TODO

Punch list as of 2026-07-10 (v1.4.0+, plus this session's retry/thumbs/pause work —
see below). Ordered roughly by priority for the capstone demo.
See also: `docs/demo-script.md` (the run-of-show + pre-demo checklist, in full detail),
`docs/ai-methodology.md`, `docs/ethics-and-trust.md`, `docs/user-journey.md`.

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
