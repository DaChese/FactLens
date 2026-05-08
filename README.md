# FactLens

A Chrome extension (Manifest V3) that captures audio from any active browser tab, transcribes it in real time using Groq Whisper, and runs an AI agent to fact-check claims and detect bias. Results are displayed in a live sidebar injected into the page.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Extension | Chrome MV3, Service Worker, Offscreen Document, Web Audio API |
| Transcription | Groq Whisper (`whisper-large-v3-turbo`) |
| Fact-checking & Bias | Anthropic Claude (`claude-sonnet-4-20250514`) — Sprint 3 |
| Search / Sourcing | Tavily Search API — Sprint 3 |
| Sidebar UI | Vanilla JS + CSS (dark mode, no frameworks) |
| Backend | Node.js + Express |

## Project Structure

```
factlens/
├── extension/
│   ├── manifest.json        # MV3 config — permissions, service worker, side panel
│   ├── background.js        # Service worker — session management, fetch to backend
│   ├── content.js           # Content script — hook for future in-page features
│   ├── offscreen.html       # Offscreen document shell
│   ├── offscreen.js         # Audio capture (getUserMedia) + MediaRecorder chunking
│   ├── sidebar/
│   │   ├── sidebar.html     # Side panel UI shell
│   │   ├── sidebar.js       # Renders transcript, fact-check cards, bias meter
│   │   └── sidebar.css      # Dark mode styles
│   └── icons/
├── backend/
│   ├── server.js            # Express server — CORS, middleware, route mounting
│   ├── routes/
│   │   ├── transcribe.js    # POST /transcribe → Groq Whisper
│   │   ├── factcheck.js     # POST /factcheck → Claude + Tavily (Sprint 3)
│   │   └── bias.js          # POST /bias → Claude (Sprint 3)
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
5. Navigate to any tab with audio playing (YouTube, podcast, etc.)
6. Click the FactLens icon — the side panel opens and transcription begins

## Environment Variables

Copy `backend/.env.example` to `backend/.env` and fill in:

| Variable | Used for | Required in |
|----------|----------|-------------|
| `PORT` | Backend port (default: 3001) | All sprints |
| `GROQ_API_KEY` | Whisper transcription via Groq | Sprint 2+ |
| `ANTHROPIC_API_KEY` | Claude fact-checking + bias analysis | Sprint 3+ |
| `TAVILY_API_KEY` | Web search for claim verification | Sprint 3+ |

Get your keys:
- Groq (free): [console.groq.com](https://console.groq.com)
- Anthropic: [console.anthropic.com](https://console.anthropic.com)
- Tavily (free tier): [app.tavily.com](https://app.tavily.com)

**Never commit `.env` to version control.**

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Server health check |
| `POST` | `/transcribe` | Audio blob → transcription text (Groq Whisper) |
| `POST` | `/factcheck` | Transcript text → fact-check verdicts (Sprint 3) |
| `POST` | `/bias` | Transcript text → bias analysis (Sprint 3) |

## How It Works

1. User clicks the FactLens toolbar icon → Chrome side panel opens
2. `background.js` calls `chrome.tabCapture.getMediaStreamId()` to get a stream ID
3. The stream ID is passed to `offscreen.js` which uses `getUserMedia` to capture the tab audio
4. `MediaRecorder` chunks the audio into 15-second WebM blobs
5. Each blob is sent to `background.js` as base64, which POSTs it to `/transcribe`
6. Groq Whisper returns the transcript text
7. Text is broadcast to the side panel via `chrome.runtime.sendMessage`
8. In parallel, the transcript is sent to `/factcheck` and `/bias` (Sprint 3)

See `docs/architecture.md` for the full system diagram.

## Sprint Status

- [x] **Sprint 1** — Project scaffold, extension shell, sidebar UI, backend stubs
- [x] **Sprint 2** — Real audio capture (offscreen doc), Groq Whisper transcription
- [ ] **Sprint 3** — Claude fact-checking + Tavily search
- [ ] **Sprint 4** — Claude bias analysis + UI polish
- [ ] **Sprint 5** — Error handling, performance, packaging

## Known Limitations

- The backend must be running locally (`npm run dev`) — there is no hosted backend yet
- Transcription chunks are 15 seconds, so there is a ~15 second delay before the first result appears
- Fact-check and bias results are stubs until Sprint 3
