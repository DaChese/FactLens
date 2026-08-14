# User Journey & Broadcast Workflow Integration

## Today: the viewer, in a browser (Phase 1 — this repo)

1. Viewer is watching a news video — YouTube, a news site's embedded player, a live
   stream. They click the FactLens icon; the side panel opens.
2. Nothing happens automatically from here — the extension quietly collects, for free:
   audio into a local ring buffer, closed captions if the player has them, and page
   text (title, headline, image captions) via the content script. No API is called yet.
3. After ~20-30 seconds, the viewer presses **Check now**.
4. Within a few seconds, a Community Note appears: the story identified, the evidence
   it was matched on, context other outlets reported (with sources), and who else is
   covering it, plus evidence-backed framing and reliability analysis of the target
   segment. Outlet lean is separately labeled historical context.
5. Optionally, the viewer presses **Check statements** (fact-checks specific claims) or
   **Check public reaction** (searches and summarizes public discussion) — each a
   separate, deliberate action, each adding its own labeled section to the same note.
6. In the Analysis Studio, a user may explicitly opt a transcript into local blind
   review. A reviewer scores de-branded text before seeing automated or aggregate
   results; raw transcript text remains memory-only.
6. If the segment changes to a different story, the old note is archived below and a
   fresh one starts on the next Check now.

## Before / after

**Before:** a viewer watches one channel, hears one framing, and has no built-in way to
know what's being left out or how differently other outlets are covering the same
event — cross-referencing means opening new tabs and doing the research themselves,
which almost nobody does mid-broadcast.

**After:** the same viewing experience, plus one button away from: who else is
covering this, what they're adding that this segment didn't, and how the coverage
splits politically — without leaving the video.

## Where this sits in a broadcast workflow — deliberately outside the newsroom

FactLens is an **audience-facing companion layer**, not a newsroom production tool. It
never touches what a station writes, edits, or airs. This is a deliberate boundary, not
a limitation:

- It doesn't insert itself into editorial decisions, scripts, or the broadcast signal.
- It runs alongside the broadcast, triggered by the *viewer*, not the newsroom.
- The station's own reporting is treated the same as everyone else's in the coverage
  comparison — the tool doesn't grade its host outlet differently.

This is why the adoption model (see `docs/roadmap-phase2-3.md`) is **broadcaster-opt-in**:
a station chooses to make this available to its own audience as a transparency offering,
the same way they'd offer closed captions or a second-screen app — not something a
third party imposes on their coverage.

## Phase 2 → Phase 3: from browser click to remote-control press

The workflow is designed to translate directly onto a NextGen TV, not to be rebuilt
from scratch:

| Step | Phase 1 (browser, built) | Phase 3 (ATSC 3.0, target) |
|---|---|---|
| Trigger | Click "Check now" | Press a button on the remote |
| Audio/caption source | Tab capture + DOM captions | Broadcast signal directly; captions arrive free via CEA-708 — no transcription cost at all |
| Note delivery | Chrome side panel | A/344 broadcaster app or A/338 companion second-screen app |
| Backend | Local Node server | Hosted, multi-viewer backend (see `TODO.md`) |

Phase 2 (live broadcast testing — an HDMI capture rig, feeding a real over-the-air
signal into this same extension) is the practical bridge between the two: it validates
the same trigger → collect → note pipeline against real broadcast audio and captions
before anyone builds the ATSC 3.0-native version.
