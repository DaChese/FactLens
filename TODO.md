# FactLens — TODO

Punch list as of 2026-07-10 (v1.4.0). Ordered roughly by priority for the capstone demo.

## Must do before the demo

- [ ] **End-to-end run with real API keys.** Nobody has exercised the full pipeline
      (Whisper → story ID → NewsAPI → missing context → claims) against live audio yet.
      Backend up → reload extension → YouTube news clip → wait ~20s → Check now →
      note appears → Check statements.
- [ ] **Verify caption capture in a real browser.** Open a YouTube video with CC on,
      check the console for `[FactLens] Captions found via "..."`. Then try 1–2 real
      news sites (CNN, NBC, local station) — their players are usually iframes, which
      is exactly what `all_frames` was added for. If a site doesn't match any selector,
      note which site so its player selector can be added.
- [ ] **Pre-demo checklist ritual:** backend running, Settings → API Status → Refresh →
      all providers OK / NO CALLS YET, budgets not near their caps, test clip cued.
- [ ] **Record a backup demo video** of a successful run in case live WiFi/APIs fail
      in the room.
- [ ] **Pick the demo clip deliberately** — a real, currently-covered news story (so
      NewsAPI returns plenty of outlets) with clear speech. Rehearse with that exact clip;
      coverage results are cached 10 minutes, so a rehearsal right before presenting
      also makes the live run faster.
- [ ] Consider a **backup NewsAPI key** (free) in case the daily 100 gets consumed
      by rehearsals.

## Should do (quality / credibility)

- [ ] **`docs/architecture.md` is stale** — it describes the old continuous pipeline and
      bias meter. Update it to the on-demand Community Note flow (or delete it and let
      README + CHANGELOG carry it).
- [ ] **Team review of `backend/data/bias-ratings.json`.** The ~48 outlet ratings are
      AllSides/Ad Fontes-style *approximations* written for the prototype. Someone should
      sanity-check them against the current published AllSides chart — judges may ask
      where the ratings come from. (See "research accuracy" notes in the presentation dump.)
- [ ] **Verify presentation stats before they go on a slide:** the "declining trust in
      media" claim should cite a real source (Gallup's annual media-trust survey is the
      standard one); ATSC 3.0 adoption/market-coverage numbers should come from
      ATSC/NAB/Pearl TV materials, not memory.
- [ ] **Story-change handling:** if the viewer checks two different stories in one
      session, the old note is archived below the live one — verify this looks right
      with real data.
- [ ] Spanish end-to-end test (transcription auto-detects; NewsAPI is queried with
      `language=es` — confirm results actually come back for a Spanish clip).

## Nice to have (post-demo / future)

- [ ] **Chyron / on-screen graphics OCR** — the last unimplemented piece of the original
      problem statement ("visual content"). Needs frame sampling + OCR or a vision model;
      scoped as its own sprint. Image *metadata* (alt text, captions) is already used.
- [ ] **Export the note log** — let a viewer save the session's notes with sources;
      supports the broadcaster-accountability story.
- [ ] **Hosted backend** with auth + per-user quotas (required for anyone to use this
      without running Node locally; prerequisite for Phase 2/3 — see
      `docs/roadmap-phase2-3.md`).
- [ ] **Phase 2: live broadcast testing** — HDMI capture card → browser tab rig;
      measure transcript accuracy and note latency against real broadcast audio.
- [ ] **Phase 3: ATSC 3.0 prototype** — companion-app path first (A/338), broadcaster-
      hosted A/344 app with a station testbed second. Not a Chrome extension port.
- [ ] Cross-check the original "fix-up prompt" document (Phases 1–4 bug list) — it was
      never added to the repo; if it still exists, confirm nothing from it is missing.

## Known limitations (document honestly if asked)

- Outlet bias ratings are static and US-centric; unrated outlets show as "unrated."
- Story consensus uses keyword overlap — good at catching total mismatches, not subtle ones.
- NewsAPI free tier only returns articles, not TV transcripts — "who else is covering
  this" means *online* coverage.
- In-memory caches and budgets reset when the backend restarts.
- The extension requires the backend running on localhost; there is no hosted version.
