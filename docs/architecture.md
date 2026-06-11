# FactLens - Architecture Overview

## System Diagram

```text
Chrome tab with audio
  -> background.js service worker
     -> opens Chrome side panel
     -> gets tabCapture stream ID
     -> creates offscreen document
  -> offscreen.js
     -> captures tab audio
     -> routes audio back to speakers
     -> sends overlapping audio chunks to background.js
  -> background.js
     -> POST /transcribe
     -> buffers transcript text
     -> POST /factcheck and /bias every 20 seconds
  -> sidebar
     -> renders transcript, fact-check cards, and bias meter

Express backend on Railway or localhost
  -> /health for deployment and extension readiness checks
  -> /transcribe proxies audio to Groq Whisper
  -> /factcheck extracts claims, searches Tavily, and asks Groq for verdicts
  -> /bias asks Groq for framing and tone analysis
```

## Component Responsibilities

### Extension

| File | Role |
|------|------|
| `manifest.json` | MV3 config, permissions, service worker, side panel, offscreen access |
| `background.js` | Session lifecycle, backend health checks, rolling transcript buffer, overlap deduplication, backend fetches, side-panel broadcasts |
| `offscreen.html` | Offscreen document shell |
| `offscreen.js` | Audio capture, audio passthrough, ring-buffer chunking, base64 audio messages |
| `sidebar/sidebar.html` | Side panel UI shell |
| `sidebar/sidebar.css` | Dark UI styles, verdict colors, bias meter, emotion bar |
| `sidebar/sidebar.js` | Renders transcript chunks, fact-check cards, bias meter, status, and errors |

### Backend

| File | Role |
|------|------|
| `server.js` | Express app, CORS, proxy trust, rate limits, security headers, route mounting, health check |
| `routes/transcribe.js` | Accepts audio uploads, proxies to Groq Whisper, returns `{ text, language }` |
| `routes/factcheck.js` | Extracts claims, searches Tavily, asks Groq for grounded verdicts, caches claims for 1 hour |
| `routes/bias.js` | Analyzes political framing and emotional charge with Groq |
| `railway.toml` | Railway build, start command, health check, restart policy |

## Data Flow

1. User clicks the FactLens toolbar icon.
2. `background.js` opens the side panel and checks whether the backend is reachable.
3. `background.js` gets a `tabCapture` stream ID and starts the offscreen document.
4. `offscreen.js` captures tab audio, keeps audio audible through an `AudioContext`, and builds overlapping chunks.
5. `background.js` posts audio chunks to `POST /transcribe`.
6. The backend sends audio to Groq Whisper and returns transcript text plus detected language.
7. `background.js` deduplicates overlap, broadcasts transcript text, and stores recent words in a rolling buffer.
8. Every 20 seconds, `background.js` sends the buffer to `POST /factcheck` and `POST /bias`.
9. The side panel renders transcript, verdict cards, source links, and bias indicators.

## Runtime Targets

| Target | URL / permission |
|--------|------------------|
| Railway backend | `https://*.up.railway.app/*` |
| Local backend | `http://localhost:3001/*`, `http://127.0.0.1:3001/*` |
| Chrome extension origins | Allowed by backend CORS through `chrome-extension://*` |

## Sprint Status

| Sprint | Goal | Status |
|--------|------|--------|
| 1 | Scaffold, extension shell, sidebar UI, backend stubs | Done |
| 2 | Real audio capture, Groq Whisper, audio passthrough | Done |
| 3 | Groq LLM fact-checking, Tavily search, bias analysis, rolling buffer, claim cache, Spanish support | Done |
| 4 | UI polish, stop button, timestamps, clear buttons, spinner, v1.1.0 | Done |
| 5 | Railway deployment config, production backend hardening, rate limiting, privacy policy | Done after hardening pass |
| 6 | Cold-start UI handling, faster retry feedback, compact onboarding | Done |
