# FactLens

A Chrome extension (Manifest V3) that captures audio from any active browser tab, transcribes it in real time, and runs an AI agent to fact-check claims and detect bias. Results appear in a live side panel alongside the page.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Extension | Chrome MV3, Service Worker, Offscreen Document, Web Audio API |
| Transcription | Groq Whisper (`whisper-large-v3-turbo`) |
| Fact-checking | Groq LLM (`llama-3.3-70b-versatile`) + Tavily Search |
| Bias Analysis | Groq LLM (`llama-3.3-70b-versatile`) |
| Sidebar UI | Vanilla JS + CSS (dark mode, no frameworks) |
| Backend | Node.js + Express |

## Project Structure

```
factlens/
├── extension/
│   ├── manifest.json        # MV3 config — permissions, service worker, side panel
│   ├── background.js        # Service worker — session management, rolling buffer, fetch to backend
│   ├── content.js           # Content script — hook for future in-page features
│   ├── offscreen.html       # Offscreen document shell
│   ├── offscreen.js         # Audio capture, passthrough, MediaRecorder chunking
│   ├── sidebar/
│   │   ├── sidebar.html     # Side panel UI shell
│   │   ├── sidebar.js       # Renders transcript, fact-check cards, bias meter
│   │   └── sidebar.css      # Dark mode styles
│   └── icons/
├── backend/
│   ├── server.js            # Express server — CORS, middleware, route mounting
│   ├── routes/
│   │   ├── transcribe.js    # POST /transcribe → Groq Whisper
│   │   ├── factcheck.js     # POST /factcheck → Groq LLM + Tavily (with claim cache)
│   │   └── bias.js          # POST /bias → Groq LLM
│   ├── package.json
│   └── .env.example
├── docs/
│   └── architecture.md      # System diagram, data flow, message types
├── .gitignore
└── README.md
```

## Getting Started

### 1. Backend

```bash
cd factlens/backend
cp .env.example .env
# Fill in your API keys in .env
npm install
npm run dev
```

The server starts on `http://localhost:3001`. Verify with:

```bash
curl http://localhost:3001/health
# → {"status":"ok","timestamp":"..."}
```

> The backend must be running before the extension will work.

### 2. Chrome Extension

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `factlens/extension/` folder
4. The FactLens icon will appear in your toolbar
5. Navigate to any tab with audio playing (YouTube, podcast, news stream, etc.)
6. Click the FactLens icon — the side panel opens and transcription begins immediately
7. Click the icon again to stop

## Environment Variables

Copy `backend/.env.example` to `backend/.env` and fill in:

| Variable | Used for | Get it at |
|----------|----------|-----------|
| `PORT` | Backend port (default: 3001) | — |
| `GROQ_API_KEY` | Whisper transcription + LLM fact-checking + bias | [console.groq.com](https://console.groq.com) (free) |
| `TAVILY_API_KEY` | Web search for claim verification | [app.tavily.com](https://app.tavily.com) (free tier) |

**Never commit `.env` to version control.**

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Server health check |
| `POST` | `/transcribe` | Audio blob → transcription text (Groq Whisper) |
| `POST` | `/factcheck` | Transcript text → fact-check verdicts with sources |
| `POST` | `/bias` | Transcript text → bias analysis (lean score, emotion, framing) |

## How It Works

1. User clicks the FactLens toolbar icon → Chrome side panel opens
2. `background.js` calls `chrome.tabCapture.getMediaStreamId()` to get a stream ID
3. The stream ID is passed to `offscreen.js` which captures the tab audio via `getUserMedia`
4. Audio is routed through an `AudioContext` for passthrough — the user can still hear the tab
5. `MediaRecorder` chunks the audio into 8-second WebM blobs
6. Each blob is base64-encoded and sent to `background.js`, which POSTs it to `/transcribe`
7. Groq Whisper returns transcript text, which appears in the side panel immediately
8. Transcript words are added to a rolling 150-word buffer in `background.js`
9. Every 20 seconds, the buffer is sent to `/factcheck` and `/bias` in parallel
10. Fact-check results include a verdict (True / False / Unverified), confidence score, reasoning, and source links
11. Bias results update the needle on the political lean meter and the emotional charge bar
12. Verified claims are cached server-side for 1 hour — repeat claims return instantly

See `docs/architecture.md` for the full system diagram.

## Fact-Check Pipeline

Each analysis cycle:
1. Groq extracts up to 3 specific, verifiable factual claims from the transcript buffer
2. Each claim is checked against a server-side cache (1-hour TTL) — cache hits skip steps 3–4
3. Tavily runs an advanced web search (5 results) for each new claim
4. Groq assesses the claim against the search results and returns a grounded verdict
5. Results are broadcast to the side panel and rendered as verdict cards with source domain links

## Sprint Status

- [x] **Sprint 1** — Project scaffold, extension shell, sidebar UI, backend stubs
- [x] **Sprint 2** — Real audio capture (offscreen doc), audio passthrough, Groq Whisper transcription
- [x] **Sprint 3** — Groq LLM fact-checking + Tavily search, bias analysis, rolling buffer, claim cache
- [ ] **Sprint 4** — UI polish, packaging
- [ ] **Sprint 5** — Error handling, performance tuning, final packaging

## Known Limitations

- The backend must be running locally (`npm run dev`) — there is no hosted backend yet
- First transcript appears after ~8 seconds (first audio chunk)
- First fact-check results appear after ~20 seconds (first analysis cycle)
- Fact-check accuracy depends on Tavily search quality — obscure or very recent claims may return Unverified
- Bias analysis reflects language tone only, not the factual content of what is said
