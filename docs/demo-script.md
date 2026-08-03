# Live Demo Script

A literal run-of-show for presenting FactLens, plus the pre-demo checklist. Read this
end to end at least once before presenting; rehearse the exact clip you'll use live.

## Before walking in the room

1. `cd backend && npm run dev` — confirm it prints `Backend running on http://localhost:3001`
   with no missing-key errors.
2. Reload the extension in `chrome://extensions` (picks up the latest code).
3. Open the side panel, click **Settings** → **API Status** → **Refresh**.
   Confirm Groq / Tavily / NewsAPI all show **OK** or **NO CALLS YET** — not NO KEY,
   ERROR, RATE LIMITED, or BUDGET SPENT. Check budget usage isn't already near its cap
   from rehearsals — retries can now use up to 3x the story-ID/NewsAPI calls of a
   single check on a hard-to-identify story, so this matters more than it used to.
4. Pick and cue the demo clip **in advance** — a real, currently-covered news story
   (so NewsAPI actually returns other outlets), clear speech, ideally captions
   available. Do one full rehearsal run with this exact clip shortly before presenting —
   coverage results cache for 10 minutes, so a rehearsal run also makes the live run
   faster and more reliable.
5. Have the **backup recording** (see below) cued and ready to switch to.

## The run itself

The flow is now **Start → it figures it out on its own → stops itself** — the button
sequence is simpler than it used to be, which is worth saying explicitly since it's a
better demo beat than "click three things."

| Step | What to click | What to say while it runs |
|---|---|---|
| 1 | Play the clip | Frame the problem: one channel, no cross-referencing, invisible bias/underreporting |
| 2 | Click the FactLens icon | "This just opens the panel — nothing starts listening until I tell it to." Opening the panel is deliberately inert |
| 3 | Press the green **Start** button | "Now it's listening locally — audio, captions, the page's own title — and nothing has been sent anywhere yet" |
| 4 | Wait (usually ~5-6s if the page has a clear title, live activity log shows what it's doing) | Point at the live activity line — "you can watch it work: reading the page, transcribing, identifying the story" |
| 5 | Note appears, session auto-stops on its own | "It found the story with enough confidence, showed the note, and stopped itself — I never touched Stop." This is a real beat worth narrating, not rushing past |
| 6 | Walk through the note top to bottom | Story headline, the "Matched on:" evidence line — **point this out explicitly**, it's the answer to "how do you know it's the right story" — then coverage spread, then missing context with its source link |
| 7 | Press **Check public reaction** (optional, if time allows) | "This is our take on the Community Notes idea — not asking our own users to vote, but searching what's already being said publicly" |
| 8 | Press **Check statements** (optional) | Shows the deeper claim-verification layer — Confirmed/Disputed/Unclear, sourced |

**If the first attempt misses** (no story identified yet, or low confidence): don't
treat this as a failure — say so out loud. "It's not confident yet, so instead of
guessing it's going to keep listening and try again" — the status stays on
"Listening," the live activity log keeps updating, and a second attempt fires about
15 seconds later automatically (up to 3 attempts total). This is a genuinely good
moment to have happen live: it demonstrates the system checking its own work rather
than confidently showing a possibly-wrong answer. Don't panic and switch to the
backup recording just because the first pass misses — only do that for an actual
error (see below).

## If something goes wrong live

- **Note doesn't appear / error banner:** don't troubleshoot live. Say "let's look at
  a run we captured earlier" and switch to the backup recording.
- **A provider shows RATE LIMITED or BUDGET SPENT:** same move — switch to the backup.
  This is exactly what the API Status panel and rate limiting exist to make diagnosable
  after the fact, not to fix mid-pitch.
- **WiFi drops:** same move.

The backup recording exists specifically so a live failure is a non-event, not a
crisis — rehearse the switch-over itself, not just the happy path.

## Lines worth having ready for Q&A

- *"How do you know it picked the right story?"* → point to the "Matched on:" line;
  explain the consensus gate cross-checks the transcript against on-screen text and the
  actual returned headlines before showing anything (see `docs/ai-methodology.md`).
- *"Isn't this just Community Notes?"* → no — explain the honest difference: X/Meta
  filters human-submitted ratings; this is an AI pipeline with its own self-verification
  step (`docs/ai-methodology.md`, the comparison table).
- *"Who decides what's biased?"* → nobody, on purpose — the AI doesn't score bias; it's
  a static, disclosed, human-curated outlet dataset (`docs/ethics-and-trust.md` §4).
- *"What does this cost to run?"* → per note: ≤4 API calls (0-1 transcription + 2 LLM +
  1 NewsAPI); idle listening costs nothing; self-imposed budgets prevent runaway spend
  (`backend/lib/rateLimit.js`). A hard-to-identify story can retry up to 3 times before
  giving up, so the worst case is higher than a single check — still bounded, never
  unlimited.
- *"What happens when it's not sure?"* → it doesn't guess — it retries, using its own
  previous guess plus whatever new context has arrived, up to 3 times, before settling
  on "low-confidence match" rather than showing a possibly-wrong answer with full
  confidence (`docs/ai-methodology.md` §3).
- *"What do the thumbs up/down do?"* → be precise, don't oversell: thumbs down evicts
  that story from the cache and dismisses the note; thumbs up is acknowledged only.
  Neither trains anything — it's a small, honest tool, not a learning system
  (`docs/ethics-and-trust.md` §8).
