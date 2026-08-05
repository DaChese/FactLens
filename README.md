# FactLens

FactLens is a Chrome extension prototype for "Community Notes for live video."
Instead of continuously fact-checking every sentence, it opens a side panel, lets
the viewer press **Start**, collects local context from the current tab, and then
builds one neutral note about the story being discussed.

The current `main` branch is v1.5.0. It is local-development focused: the backend
runs on your machine, and the extension talks to `http://localhost:3001` unless
you change the backend URL in the extension settings page.

The backend also serves the FactLens Analysis Studio from `/`. This is useful for
Railway hosting and demos: visitors can paste transcript/page text, build a
Community Note, and run the same `/coverage`, `/factcheck`, and `/discussion`
pipeline without installing the Chrome extension.

## Current Behavior

- Opening the extension icon only opens the Chrome side panel. It does not start
  listening by itself.
- Pressing **Start** begins local collection: tab audio is buffered in the
  offscreen document, captions are captured from the page when available, and page
  text is scraped for story-identification signals.
- FactLens schedules an automatic note attempt. If page title/headline signals are
  available, this usually happens after about 5 seconds. If not, a 20-second
  fallback timer is used.
- If the story match is unclear, FactLens retries up to 3 total attempts, 15
  seconds apart.
- A confident automatic note stops the session.
- **Check now** manually builds a note for the active session before the automatic
  timer fires.
- **Check statements in this segment** runs claim checking on demand.
- **Check public reaction** searches and summarizes public discussion on demand.
- **Right story?** feedback lets the viewer mark the story match helpful or dismiss
  it. A dismissal evicts the backend coverage cache for that query.

Known implementation caveats in the current code:

- Manual **Check now** cancels the automatic timer and builds a note, but it does
  not currently auto-stop the capture session afterward.
- **Check statements** and **Check public reaction** can run after auto-stop, but
  their completion currently broadcasts `listening`, which can make the sidebar
  look active even when capture has stopped.
- Post-note actions target the first stored note in the service worker. Multiple
  tabs with built notes can therefore be ambiguous.

## What a Note Shows

Each Community Note can include:

- The identified story headline.
- A match-evidence line showing whether the note matched on transcript,
  on-screen text, and/or other outlets' headlines.
- Context that other outlets reported but the watched segment did not mention.
- A list of other outlets covering the story, labeled with static editorial-lean
  ratings from `backend/data/bias-ratings.json`.
- Optional statement checks labeled **Confirmed**, **Disputed**, or **Unclear**.
- Optional public reaction summary, kept separate from outlet coverage.
- A "Right story?" helpful/not-helpful control.

FactLens intentionally avoids the old colored TRUE/FALSE feed and bias meter. The
UI is a monochrome newsprint-style sidebar, with green/red reserved for Start/Stop.

## Built With

| Area | Stack |
|---|---|
| Chrome extension | Manifest V3, service worker, content script, offscreen document, side panel |
| Audio transcription | Groq Whisper (`whisper-large-v3-turbo`) |
| Story ID and synthesis | Groq chat models (`llama-3.3-70b-versatile`, with `llama-3.1-8b-instant` as the fast story-ID model) |
| Statement/public-reaction search | Tavily Search API |
| Coverage search | NewsAPI |
| Outlet ratings | Static JSON dataset in `backend/data/bias-ratings.json` |
| Backend | Node.js + Express |
| UI | Vanilla JS + CSS |
| Web studio | Static HTML/CSS/JS served from `backend/public` |

## Requirements

- Chrome or a Chromium browser with extension developer mode.
- Node.js for the backend.
- A Groq API key for transcription and LLM calls.
- A Tavily API key for statement checks and public reaction.
- A NewsAPI key for coverage comparison and missing-context notes.

The backend can start without keys in `.env`, because the extension can send keys
per request from the settings page. Requests that need a missing key will fail with
an actionable error.

## Setup

### 1. Start the backend

```bash
cd factlens/backend
cp .env.example .env
npm install
npm run dev
```

Then check the server:

```bash
curl http://localhost:3001/health
```

Expected response:

```json
{"status":"ok","timestamp":"..."}
```

### 2. Configure API keys

You can use either method.

Method A: put keys in `backend/.env`.

```env
PORT=3001
GROQ_API_KEY=gsk_...
TAVILY_API_KEY=tvly-...
NEWSAPI_KEY=...
```

Method B: open the extension settings page and paste keys there. The extension
stores them in `chrome.storage.local` and sends them to the backend as request
headers:

- `X-Groq-Key`
- `X-Tavily-Key`
- `X-Newsapi-Key`

Header keys take priority over `.env`. Blank settings fall back to `.env`.

### 3. Load the extension

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select `factlens/extension/`.
5. Click the FactLens icon to open the side panel.

### 4. Use the Analysis Studio

With the backend running, open:

```text
http://localhost:3001/
```

On Railway, the same page is served from the Railway service URL. The web studio
does not have Chrome extension privileges, so it cannot inspect another tab's DOM,
capture audio, or capture captions automatically. It is a hosted manual analysis
surface for pasted transcripts, page titles, source domains, and on-screen text.

The studio workflow is:

1. Paste transcript or segment text.
2. Optionally add a page title, on-screen text, source domain, and language.
3. Press **Build Community Note**.
4. Review the identified story, match signals, missing context, and other coverage.
5. Optionally press **Check statements** or **Check public reaction**.

The page includes three clearly labeled sample inputs and a collapsed **Developer
settings** section for backend URL and API-key overrides. These overrides preserve
the same request-header behavior as the extension:

- `X-Groq-Key`
- `X-Tavily-Key`
- `X-Newsapi-Key`

The current web studio stores these overrides in browser `localStorage`, matching
the previous prototype behavior. Do not use shared machines for private provider
keys.

## Using FactLens

1. Open a tab with a video, podcast, stream, or news page.
2. Click the FactLens toolbar icon. The side panel opens.
3. Click **Start**.
4. Wait for the automatic note attempt, or press **Check now**.
5. Review the Community Note.
6. Optionally press **Check statements in this segment** or **Check public
   reaction**.
7. Use **Right story?** if the note matched the correct or incorrect story.

If the page is paused, the content script reports that state and the automatic
check is held until playback resumes.

## How It Works

### Local collection

While a session is active, FactLens collects local context without calling paid
APIs:

- `extension/content.js` captures visible captions from common video players,
  HTML5 text tracks, and caption-like DOM elements, including iframes.
- `extension/content.js` also sends page signals such as `document.title`,
  headlines, Open Graph metadata, Twitter Card metadata, JSON-LD, image alt text,
  and figure captions.
- `extension/offscreen.js` captures tab audio with `tabCapture`, routes it back to
  the speakers, and keeps a rolling audio ring buffer.

The audio ring buffer is currently 120 chunks at 500ms each, or about 60 seconds
of audio. Audio is not sent continuously.

### Note building

When a note is built:

1. The extension prefers fresh captions if available.
2. If captions are not available, it requests the current audio ring buffer and
   makes one `/transcribe` call.
3. The extension sends transcript and page signals to `/coverage`.
4. `/coverage` asks Groq to identify the story and search query.
5. `/coverage` queries NewsAPI for other outlets covering the story.
6. `/coverage` cross-checks the story against on-screen text and returned
   headlines using keyword overlap.
7. If confidence is low, articles and missing-context items are withheld.
8. If confidence is sufficient and transcript text exists, Groq extracts up to 3
   missing-context facts from other coverage.

Coverage results are cached by query for 10 minutes. Claim results are cached for
1 hour.

### On-demand followups

- `/factcheck` extracts up to 2 checkable claims from the note transcript, searches
  Tavily, and asks Groq for grounded verdicts.
- `/discussion` reuses the note query, searches Tavily for public reaction, and
  asks Groq for a neutral summary.
- `/coverage/feedback` handles note feedback. Thumbs down evicts the cached
  coverage result for that query. Thumbs up is logged only.

## Backend Endpoints

| Endpoint | Purpose |
|---|---|
| `GET /health` | Basic server health check |
| `GET /status` | Provider status, call counts, and budget state |
| `POST /transcribe` | Send one audio blob to Groq Whisper |
| `POST /coverage` | Identify story, find coverage, cross-check confidence, extract missing context |
| `POST /coverage/feedback` | Evict cached coverage on not-helpful feedback |
| `POST /factcheck` | On-demand statement checking |
| `POST /discussion` | On-demand public-reaction summary |

The old `/bias` route has been removed.

## Railway Hosting

Railway can host the backend API and web studio as one Node service:

1. Point Railway at `backend/` as the service root.
2. Use `npm start` as the start command.
3. Set `GROQ_API_KEY`, `TAVILY_API_KEY`, and `NEWSAPI_KEY` in Railway variables,
   or leave them blank and enter keys in the web studio developer settings.
4. Optional: set `PUBLIC_ORIGIN` to your public Railway/custom domain if you put
   the frontend and API on different origins.
5. Open the Railway public URL. `/` serves the web studio; API routes remain
   available under `/coverage`, `/factcheck`, `/discussion`, `/transcribe`,
   `/health`, and `/status`.

## Studio Acceptance Tests

The backend package includes a Playwright runner for the hosted studio.

Fast smoke checks:

```bash
cd factlens/backend
npm run test:studio
```

This checks `/health`, `/status`, provider variable visibility, the deployed studio
shell, sample loading, clear-form behavior, empty validation, developer settings,
and desktop/mobile layouts.

Live provider check:

```bash
cd factlens/backend
npm run test:studio:live
```

This builds a real Community Note and runs statement and public-reaction checks.
Use it intentionally because it spends Groq, NewsAPI, and Tavily calls.

By default the runner targets:

```text
https://factlens-production.up.railway.app
```

Set `FACTLENS_TEST_URL` to test a different deployment or local server. Set
`CHROME_PATH` if Playwright cannot find Chrome on a machine.

## Project Files

```text
factlens/
|-- extension/
|   |-- manifest.json
|   |-- background.js
|   |-- content.js
|   |-- offscreen.html
|   |-- offscreen.js
|   |-- options/
|   |   |-- options.html
|   |   |-- options.css
|   |   `-- options.js
|   `-- sidebar/
|       |-- sidebar.html
|       |-- sidebar.css
|       `-- sidebar.js
|-- backend/
|   |-- server.js
|   |-- playwright.config.js
|   |-- .env.example
|   |-- public/
|   |   |-- index.html
|   |   |-- samples.js
|   |   |-- styles.css
|   |   `-- app.js
|   |-- scripts/
|   |   `-- run-studio-tests.js
|   |-- tests/
|   |   |-- studio-live.spec.js
|   |   `-- studio-smoke.spec.js
|   |-- data/
|   |   `-- bias-ratings.json
|   |-- lib/
|   |   |-- apiStatus.js
|   |   |-- keys.js
|   |   |-- rateLimit.js
|   |   `-- textMatch.js
|   `-- routes/
|       |-- coverage.js
|       |-- discussion.js
|       |-- factcheck.js
|       `-- transcribe.js
|-- docs/
|   |-- ai-methodology.md
|   |-- architecture.md
|   |-- demo-script.md
|   |-- ethics-and-trust.md
|   |-- product-phases.md
|   |-- roadmap-phase2-3.md
|   `-- user-journey.md
|-- CHANGELOG.md
|-- TODO.md
`-- README.md
```

## Documentation

- `CHANGELOG.md` explains the shift from v1.1 live fact-checking to the current
  Community Notes architecture.
- `docs/ai-methodology.md` describes the AI decision flow.
- `docs/ethics-and-trust.md` documents trust boundaries and limitations.
- `docs/product-phases.md` documents the Phase 1 studio and later dashboard,
  report, and public/community directions.
- `docs/user-journey.md` explains the intended viewer workflow.
- `docs/demo-script.md` gives a demo run-of-show.
- `docs/roadmap-phase2-3.md` covers live broadcast and ATSC 3.0 feasibility.

## Operational Notes

- The extension host permissions currently allow `http://localhost:3001/*`.
  For a hosted backend, update `extension/manifest.json` and the backend URL in
  settings.
- `backend/lib/rateLimit.js` contains route throttles and provider budget caps.
- `GET /status` powers the settings page API status panel.
- The backend caches are in memory and reset when the server restarts.
- `backend/.env` is ignored by git. Do not commit real API keys.

## Version

Current README target: `main` at v1.5.0.

See `CHANGELOG.md` for the detailed version history.
