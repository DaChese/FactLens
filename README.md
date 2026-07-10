# FactLens

Community notes for live video. FactLens is a Chrome extension that listens to whatever's playing in your browser and writes a running **Community Note** about the story being discussed — modeled on how X/Twitter's Community Notes add neutral context to a post, rather than a "FACT CHECK" verdict machine.

## What it does

**Everything is on-demand.** While a session is running, FactLens only *collects* — audio into a local ring buffer, captions and page text into local state. No API is called until the viewer presses **Check now**, which builds the note in a few seconds. This mirrors the ATSC 3.0 target: on a NextGen TV, captions arrive free with the broadcast and the note is triggered by a remote-control press.

Each Community Note combines:

- **The story** — identified from the audio, the page's closed captions, and the on-screen text (page title, headline, image captions), cross-checked against each other before anything is shown
- **Match evidence** — every note says what it was matched on ("audio transcript, on-screen text, other outlets' headlines"); when the signals don't agree, coverage is withheld rather than risking a note about the wrong story
- **Context other outlets reported** — concrete facts appearing in other coverage of the same story that this segment didn't mention, each with a clickable source
- **Who else is covering it** — outlets carrying the story, each labeled with its known editorial lean (lean left / center / lean right), plus the overall spread
- **Checked statements** (on request) — a "Check statements" button on the note checks up to 2 specific claims against a live web search, labeled Confirmed / Disputed / Unclear with sources

Works in English and Spanish, auto-detected. The UI is deliberately plain — black and white, Times New Roman, no colors deciding what you should think.

**Cost per note:** at most 1 transcription call (0 if captions are on) + 2 LLM calls + 1 NewsAPI request. "Check statements" adds 1 LLM extraction + up to 2 web searches. Idle listening costs nothing.

## Built with

| | |
|--|--|
| Chrome Extension | MV3, Service Worker, Offscreen Document |
| Transcription | Groq Whisper (`whisper-large-v3-turbo`) |
| Fact-checking & Bias | Groq LLM (`llama-3.3-70b-versatile`) |
| Web Search | Tavily Search API |
| Coverage Analysis | NewsAPI + static outlet bias ratings |
| Sidebar | Vanilla JS + CSS (dark mode) |
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
2. Click the FactLens icon — the side panel opens and starts collecting (locally, no API calls)
3. Let it listen for ~20+ seconds, then press **Check now**
4. The Community Note appears within a few seconds; press **Check statements** on it to fact-check specific claims
5. Click the icon again (or the Stop button) to stop

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

1. You click the icon → the side panel opens
2. The service worker gets a stream ID from Chrome's tab capture API and passes it to a hidden "offscreen document" which does the actual audio capture (audio is also routed back to your speakers)
3. The offscreen document keeps a rolling ring buffer of the last ~90 seconds of audio — nothing is sent anywhere
4. If the page renders closed captions (YouTube, Video.js, JW Player, Shaka, Brightcove, HTML5 tracks — including inside iframes), the content script reads them into a rolling local transcript
5. The content script also scrapes the page's identifying text every few seconds: title, headline, og: metadata, image captions

**When you press Check now (~4 API calls):**

6. Transcript: the caption buffer if it's fresh (free), otherwise the audio ring is sent as ONE Whisper call
7. The LLM identifies the story using the transcript + the scraped on-screen text; NewsAPI finds other outlets covering it; a second LLM pass extracts facts the other coverage mentions that this segment didn't — each tied to its source article
8. **Consensus check**: the identified story is cross-checked (keyword overlap, no extra API calls) against the page's on-screen text AND the headlines NewsAPI actually returned. Both agree → high confidence; one agrees → medium; neither → the coverage is withheld and the note says so, instead of confidently showing the wrong story
9. Coverage results are cached for 10 minutes per story, so repeat checks are nearly free

**When you press Check statements (~3 more calls):**

10. The LLM extracts up to 2 checkable claims from the same transcript; each gets one Tavily web search and one LLM verdict, with claims cached for an hour

The 6-second overlapping window is what prevents words from getting dropped at chunk boundaries — each clip shares 3 seconds with the previous one, so nothing falls through, hopefully

## What a Community Note shows

Each note has:
- The story headline FactLens identified
- An evidence line — which signals the match was based on, and the confidence level
- "Readers on other outlets also saw" — context this segment didn't mention, each item citing the outlet it came from
- "Who else is covering this" — outlets with their editorial lean, and the left/center/right spread
- A "Check statements" button — on request, claims labeled **Confirmed** / **Disputed** / **Unclear**, each with one-sentence reasoning and source links

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
│   │   └── textMatch.js     # Keyword-overlap story cross-checking
│   └── routes/
│       ├── transcribe.js    # Sends audio to Groq Whisper (one call per note)
│       ├── factcheck.js     # Extracts claims, searches Tavily, gets verdicts
│       └── coverage.js      # Story ID + consensus + coverage + missing context
└── docs/
    ├── architecture.md      # Full technical diagram if you want to go deep
    └── roadmap-phase2-3.md  # Feasibility notes: live broadcast testing & ATSC 3.0
```

## Sprint progress

- [x] Sprint 1 — Got the extension loading and the sidebar rendering
- [x] Sprint 2 — Real audio capture, passthrough, Whisper transcription
- [x] Sprint 3 — Fact-checking, bias analysis, claim cache, Spanish support, overlap fix
- [ ] Sprint 4 — UI polish, packaging
- [ ] Sprint 5 — Final cleanup and packaging

## Things to know

- The backend has to be running locally for the extension to work — there's no hosted version yet!!
- Let it listen ~20 seconds before the first Check now, so there's enough speech to work with
- Idle listening is free — API credits are only spent when Check now or Check statements is pressed
- The claim and coverage caches reset when you restart the backend
