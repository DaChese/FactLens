# FactLens

Community notes for live video. FactLens is a Chrome extension that listens to whatever's playing in your browser and writes a running **Community Note** about the story being discussed — modeled on how X/Twitter's Community Notes add neutral context to a post, rather than a "FACT CHECK" verdict machine.

## What it does

**Everything is on-demand.** Press **Start** and FactLens only *collects* at first — audio into a local ring buffer, captions and page text into local state. No API is called until the first automatic check fires (usually within ~5-6 seconds if the page has a clear title). If it can't identify the story confidently yet, it keeps listening and tries again — up to 3 attempts, 15 seconds apart, each one building on its own previous guess rather than re-guessing from scratch — and stops itself the moment it lands a confident result. This mirrors the ATSC 3.0 target: on a NextGen TV, captions arrive free with the broadcast and the note is triggered by a remote-control press.

Each Community Note combines:

- **The story** — identified from the audio, the page's closed captions, and the on-screen text (page title, headline, image captions), cross-checked against each other before anything is shown
- **Match evidence** — every note says what it was matched on ("audio transcript, on-screen text, other outlets' headlines"); when the signals don't agree, coverage is withheld rather than risking a note about the wrong story
- **Context other outlets reported** — concrete facts appearing in other coverage of the same story that this segment didn't mention, each with a clickable source
- **Who else is covering it** — outlets carrying the story, each labeled with its known editorial lean (lean left / center / lean right), plus the overall spread
- **Checked statements** (on request) — a "Check statements" button on the note checks up to 2 specific claims against a live web search, labeled Confirmed / Disputed / Unclear with sources
- **What people are discussing** (on request) — a "Check public reaction" button searches the web for how people are discussing the story and summarizes the tenor, kept in its own labeled section — never blended with verified news coverage. Opinions are described as opinions, not asserted as fact.
- **"Right story?" thumbs up/down** — thumbs down dismisses the note and evicts that story from the cache so a repeat check gets a fresh lookup instead of reusing the same wrong result; thumbs up is acknowledged only. Neither trains anything.

Works in English and Spanish, auto-detected. The UI is deliberately plain — black and white, Times New Roman, no colors deciding what you should think, with one deliberate exception: the Start/Stop buttons are green/red for universal go/stop signaling.

**Cost per note:** at most 1 transcription call (0 if captions are on) + 2 LLM calls + 1 NewsAPI request per attempt, and a hard-to-identify story can take up to 3 attempts before giving up. "Check statements" and "Check public reaction" each add their own small on-request cost. Idle listening costs nothing — see `backend/lib/rateLimit.js` for the self-imposed provider budgets that keep it that way.

See `docs/ai-methodology.md` for exactly how the AI decides things, `docs/ethics-and-trust.md` for the trust framework, `docs/user-journey.md` for how this fits a broadcast workflow, and `docs/demo-script.md` for the live-demo run-of-show.

## Built with

| | |
|--|--|
| Chrome Extension | MV3, Service Worker, Offscreen Document |
| Transcription | Groq Whisper (`whisper-large-v3-turbo`) |
| Fact-checking & Bias | Groq LLM (`llama-3.3-70b-versatile`, story ID uses `llama-3.1-8b-instant`) |
| Web Search | Tavily Search API |
| Coverage Analysis | NewsAPI + static outlet bias ratings |
| Sidebar | Vanilla JS + CSS (monochrome newsprint) |
| Backend | Node.js + Express |

## Getting it running

You need two things running: the backend server and the Chrome extension.

### 1. Start the backend

```bash
cd factlens/backend
cp .env.example .env
# Add your API keys to .env (see below) — or skip this and set them from
# the extension's Settings page once it's loaded (step 2)
npm install
npm run dev
```

Check it's alive:
```bash
curl http://localhost:3001/health
# {"status":"ok","timestamp":"..."}
```

### 2. Load the extension

1. Go to `chrome://extensions` in Chrome
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** → select the `factlens/extension/` folder
4. The FactLens icon shows up in your toolbar

### 3. Use it

1. Open any tab with audio — YouTube, a podcast, a news stream
2. Click the FactLens icon to open the side panel — this only opens the panel, nothing starts listening yet
3. Press the green **Start** button — it starts collecting locally (no API calls yet) and the live activity log shows what it's doing
4. The Community Note usually appears within ~5-6 seconds if the page has a clear title; if the first attempt can't confirm the story, it keeps listening and retries automatically (up to 3 attempts) instead of giving up
5. The session **stops itself** once a confident note is shown — no need to press Stop; press **Check statements** on the note to fact-check specific claims, or **Check public reaction** to see what people are saying

## API Keys

You only need two keys, both free (a third is optional):

| Key | Where to get it |
|-----|----------------|
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) — free account |
| `TAVILY_API_KEY` | [app.tavily.com](https://app.tavily.com) — free tier |
| `NEWSAPI_KEY` (optional) | [newsapi.org](https://newsapi.org) — free tier, 100 req/day. Enables Coverage Watch + missing context; everything else works without it |

**Two ways to set them:**

1. **`backend/.env`** (for the machine running the backend):
   ```
   GROQ_API_KEY=gsk_...
   TAVILY_API_KEY=tvly-...
   ```
   Don't commit `.env` to git — your keys stay local.

2. **The extension's Settings page** (gear icon in the side panel header) — lets you
   paste keys directly into the browser without touching the backend at all. Handy on
   a demo machine, or if several people are testing against the same backend with
   their own keys. Keys entered here are sent to the backend as request headers and
   take priority over `.env`; leaving a field blank falls back to `.env`.

## How it actually works under the hood

Chrome's MV3 extensions can't directly access audio streams in a service worker, so there's a bit of a relay happening:

**While listening (all local, zero API calls):**

1. You click the icon → the side panel opens (this alone starts nothing)
2. You press **Start** → the service worker gets a stream ID from Chrome's tab capture API and passes it to a hidden "offscreen document" which does the actual audio capture (audio is also routed back to your speakers)
3. The offscreen document keeps a rolling ring buffer of the last ~90 seconds of audio — nothing is sent anywhere
4. If the page renders closed captions (YouTube, Video.js, JW Player, Shaka, Brightcove, HTML5 tracks — including inside iframes), the content script reads them into a rolling local transcript; any amount of caption text is used immediately, no minimum-length wait
5. The content script also scrapes the page's identifying text every few seconds: title, headline, JSON-LD structured data, Open Graph and Twitter Card metadata, image captions; it also reports when the page's video pauses/resumes so a paused video doesn't burn an API call

**The first automatic check (~4 API calls, fires ~5-6s after Start if the page has a usable title, sooner than the old fixed 20s wait):**

6. Transcript: the caption buffer if it's fresh (free), otherwise the audio ring is sent as ONE Whisper call — though a clear page title alone is often enough to identify the story before any audio is transcribed at all
7. The LLM identifies the story using the transcript + the scraped on-screen text; NewsAPI finds other outlets covering it; a second LLM pass extracts facts the other coverage mentions that this segment didn't — each tied to its source article
8. **Consensus check**: the identified story is cross-checked (keyword overlap, no extra API calls) against the page's on-screen text AND the headlines NewsAPI actually returned. Both agree → high confidence; one agrees → medium; neither → **low confidence**
9. Coverage results are cached for 10 minutes per story, so repeat checks are nearly free

**If confidence is low or no story was found yet — retry, don't give up:**

9a. The session keeps listening and tries again automatically — up to 3 attempts total, 15 seconds apart. Each retry hands the LLM its own previous guess ("a previous pass tentatively identified this as X; confirm, refine, or correct that using the fuller information now available") instead of re-guessing from scratch, and the transcript keeps growing between attempts. A real success, a missing API key, or a hard error stop the loop immediately — only a fixable miss retries.

**Once a confident note is shown, the session stops itself.** From there:

**If you press Check statements (~3 more calls):**

10. The LLM extracts up to 2 checkable claims from the same transcript; each gets one Tavily web search and one LLM verdict, with claims cached for an hour

**If you press Check public reaction (~2 more calls):**

11. Reuses the story's search query from step 7 — no re-identification needed. One Tavily search for discussion/reaction, one LLM pass summarizes the tenor neutrally (opinions described as opinions, never as fact). Shown in its own labeled section, never blended with the outlet coverage from step 7.

None of steps 10-11 run unless you explicitly press their button — they never make building the note itself (steps 6-9a) more expensive.

## What a Community Note shows

Each note has:
- The story headline FactLens identified
- An evidence line — which signals the match was based on, and the confidence level
- "Readers on other outlets also saw" — context this segment didn't mention, each item citing the outlet it came from
- "Who else is covering this" — outlets with their editorial lean, and the left/center/right spread
- A "Check statements" button — on request, claims labeled **Confirmed** / **Disputed** / **Unclear**, each with one-sentence reasoning and source links
- A "Check public reaction" button — on request, "What people are discussing" — a neutral summary of public reaction with sources, kept separate from the news coverage above it

## Project files

```
factlens/
├── extension/
│   ├── manifest.json        # Chrome extension config
│   ├── background.js        # Service worker — the on-demand note pipeline
│   ├── content.js           # Reads captions + page text from the page's DOM
│   ├── offscreen.html/js    # Hidden doc holding the rolling audio buffer
│   ├── options/             # Settings page (backend URL + API keys)
│   └── sidebar/             # The side panel UI
├── backend/
│   ├── server.js            # Express server
│   ├── data/
│   │   └── bias-ratings.json  # Static outlet bias ratings (AllSides-style)
│   ├── lib/
│   │   ├── keys.js          # Per-request API key resolution
│   │   ├── textMatch.js     # Keyword-overlap story cross-checking
│   │   ├── apiStatus.js     # Per-provider call/error tracking (GET /status)
│   │   └── rateLimit.js     # Route throttles + self-imposed provider budgets
│   └── routes/
│       ├── transcribe.js    # Sends audio to Groq Whisper (one call per note)
│       ├── factcheck.js     # Extracts claims, searches Tavily, gets verdicts
│       ├── coverage.js      # Story ID + consensus + coverage + missing context
│       └── discussion.js    # Public reaction search + neutral summary (on request)
└── docs/
    ├── architecture.md      # Full technical diagram if you want to go deep
    ├── roadmap-phase2-3.md  # Feasibility notes: live broadcast testing & ATSC 3.0
    ├── ai-methodology.md    # Exactly how the AI decides things
    ├── ethics-and-trust.md  # The trust framework and its limits
    ├── user-journey.md      # Viewer flow + broadcast workflow integration
    └── demo-script.md       # Live-demo run-of-show and pre-demo checklist
```

## Version history

See `CHANGELOG.md` for the full history. Current: **v1.5.0** — retry-until-confident
story identification, public reaction search, thumbs up/down, pause-aware checking.
Earlier milestones: on-demand architecture + API safety (v1.4.0), Community Notes
reframe + story verification + monochrome UI (v1.3.0), coverage/missing-context/bias
ratings/settings (v1.2.0).

## Things to know

- The backend has to be running locally for the extension to work — there's no hosted version yet!!
- Idle listening is free — API credits are only spent once the first automatic check fires after pressing Start, or when Check statements/Check public reaction is pressed
- A hard-to-identify story can retry up to 3 times (15s apart) before settling on "low-confidence match" — worst case is more calls than a single check, still bounded
- The claim and coverage caches reset when you restart the backend
