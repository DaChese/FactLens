# FactLens Roadmap — Phase 2 & 3 Feasibility

Phase 1 (the Chrome extension prototype in this repo) is the current implementation.
This document is a feasibility assessment for the next two phases of the "Community
Notes for Live TV" roadmap. **No implementation work is scoped here** — this is a
planning reference.

---

## Phase 2 — Live Broadcast Testing

**Goal:** validate FactLens against real live TV content instead of YouTube/podcast tabs.

### What carries over unchanged

- **The entire backend.** `/transcribe`, `/factcheck`, `/bias`, and `/coverage` are
  source-agnostic — they take audio and text, not "a YouTube tab." Nothing changes.
- **Audio transcription as the primary pipeline.** Whisper doesn't care whether the
  audio came from a YouTube player or a live broadcast stream.

### How to get a live broadcast into the extension

Cheapest-first options, all of which keep the existing extension working as-is:

1. **Network streaming sites in a browser tab** — many local stations and national
   networks stream live on their websites or YouTube/Pluto/Tubi. Zero new work; this
   is the first test to run.
2. **HDMI capture card → browser tab** — a cable/antenna feed through a ~$20 HDMI
   capture dongle shows up as a webcam. A trivial local page rendering
   `getUserMedia()` output in a tab makes any real broadcast capturable by the
   existing `tabCapture` pipeline. This is the recommended Phase 2 test rig.
3. **ATSC tuner + software player** — an ATSC 1.0/3.0 USB tuner with a player that
   runs in or mirrors to a browser tab. More setup, closer to the real signal.

### Known gaps to validate (and honest expectations)

- **Closed captions:** the DOM-caption reading added in Phase 1 works for web players
  (YouTube, Video.js, JW Player, HTML5 tracks). Broadcast captions are CEA-608/708
  streams inside the video signal — they never appear in any DOM. **For live TV,
  audio transcription will be the primary transcript source**, with DOM captions as a
  bonus only when the broadcaster's web player renders them. This matches the
  fallback design already in the extension: captions when available, Whisper otherwise.
- **On-screen text (chyrons / lower-thirds):** not covered by any current pipeline.
  This needs frame sampling (e.g. `captureVisibleTab` or a canvas grab every few
  seconds) plus OCR (Tesseract.js locally, or a vision-capable LLM call server-side).
  It is a real scope increase — budget it as its own sprint, not an add-on. It is
  also the last remaining gap against the problem statement's "on-screen text and
  visual content" requirement.
- **Latency & noise:** live broadcast audio has music beds, crosstalk, and ads.
  Expect more Whisper errors and more "Unverified" verdicts. Phase 2 should measure:
  transcript word error rate, claim-extraction precision, and end-to-end latency
  (speech → card) against a scripted test broadcast.

### Phase 2 success criteria (suggested)

- Extension runs 30+ minutes against a live feed without crashing or drifting.
- ≥80% of on-air factual claims spoken clearly are extracted or correctly ignored.
- Coverage Watch identifies the correct story within 2 analysis cycles of a story change.

---

## Phase 3 — Native ATSC 3.0 Deployment

**Goal:** move the overlay from a Chrome extension into the broadcast itself.

### Architecture reality check

This is **not a port — it's a separate product** sharing the FactLens backend. ATSC 3.0
interactive content runs in the **A/344 Broadcaster Application** environment: an
HTML5/JS runtime hosted by the receiver, delivered over broadband or the broadcast
ROUTE/DASH pipe. Do not attempt to reuse MV3 extension concepts (service workers,
`tabCapture`, side panel) — none of them exist on a TV runtime.

What transfers:

| Layer | Transfers? |
|---|---|
| Backend APIs (`/factcheck`, `/bias`, `/coverage`) | ✅ As-is, once hosted (not localhost) |
| Sidebar UI (vanilla HTML/CSS/JS) | 🟡 Largely reusable — A/344 apps are HTML5, but need TV-safe layout + remote-control navigation |
| Audio capture pipeline | ❌ Replaced — the receiver already has the AV stream; captions arrive as IMSC1/CEA-708, which the app can read directly (better than Whisper) |
| Bias ratings + coverage logic | ✅ As-is |

### Two viable deployment shapes

1. **Broadcaster-hosted A/344 app** (the "real" ATSC 3.0 path): the station signs and
   broadcasts the FactLens app; it overlays the live program and calls the FactLens
   backend over broadband. Requires a broadcaster partnership, app signing/cert
   process, and testing on real receivers (e.g. via the ATSC 3.0 developer programs
   or a station testbed). This is the path that "demonstrates broadcaster
   transparency" from the problem statement — the broadcaster is voluntarily
   carrying the accountability layer.
2. **Companion-device app** (A/338): the TV broadcasts a signal that a phone/tablet
   app syncs to, and the overlay lives on the second screen. Much lower barrier (no
   receiver certification), works with any TV, and is a realistic interim step if no
   broadcaster partner materializes.

### Practical sequencing

1. Host the backend publicly (with auth + per-user quotas — the localhost proxy model
   doesn't survive contact with real users).
2. Get transcript source from the broadcast captions (IMSC1/708) instead of Whisper —
   cheaper, more accurate, and the receiver hands them to the app for free.
3. Prototype on the companion-app path first; pursue an A/344 pilot with one station
   testbed second.

### Biggest risks

- **Receiver fragmentation:** A/344 support across 2024–2026 TVs is uneven; a
  companion app dodges this entirely.
- **Broadcaster incentive:** the app ships only if a station wants to ship it. The
  Phase 2 demo (extension against their own live stream) is the sales tool.
- **Editorial liability:** verdicts rendered on top of a broadcaster's own signal
  will get scrutiny; the True/False/Unverified confidence framing and visible
  sources from Phase 1 are the mitigations — keep them front and center.
