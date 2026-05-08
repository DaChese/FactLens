# FactLens — Architecture Overview

## System Diagram

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Chrome Browser                                                          │
│                                                                          │
│  ┌──────────────┐  tabCapture   ┌───────────────────────────────────┐   │
│  │  Active Tab  │ ────────────► │  background.js (Service Worker)   │   │
│  │  (any page)  │               │                                   │   │
│  │              │               │  • Opens Side Panel               │   │
│  │ ┌──────────┐ │               │  • Gets stream ID (tabCapture)    │   │
│  │ │content.js│ │               │  • Manages session state          │   │
│  │ │(future   │ │               │  • Rolling 150-word buffer        │   │
│  │ │ in-page  │ │               │  • 20s analysis interval          │   │
│  │ │ features)│ │               │  • Overlap deduplication          │   │
│  │ └──────────┘ │               │  • Broadcasts to side panel       │   │
│  └──────────────┘               └──────────────┬────────────────────┘   │
│                                                │                         │
│                          ┌─────────────────────┘                         │
│                          │ START_RECORDING / AUDIO_CHUNK                 │
│                          ▼                                               │
│              ┌───────────────────────────┐                               │
│              │  offscreen.js             │                               │
│              │  (Offscreen Document)     │                               │
│              │                           │                               │
│              │  • getUserMedia (stream)  │                               │
│              │  • AudioContext passthru  │                               │
│              │  • MediaRecorder 500ms    │                               │
│              │  • Ring buffer (6s / 12  │                               │
│              │    slots, 3s overlap)     │                               │
│              │  • Base64 encode → send  │                               │
│              └───────────────────────────┘                               │
│                                                                          │
│              ┌───────────────────────────────────────────────────────┐   │
│              │  Chrome Side Panel  (sidebar/sidebar.html)            │   │
│              │                                                       │   │
│              │  • Live transcript feed                               │   │
│              │  • Fact-check verdict cards (True/False/Unverified)   │   │
│              │  • Political lean meter (Left ←→ Right)              │   │
│              │  • Emotional charge bar                               │   │
│              └───────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────┘
                          │ HTTP (localhost:3001)
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Node.js / Express Backend                                          │
│                                                                     │
│  POST /transcribe ──► Groq Whisper (whisper-large-v3-turbo)         │
│  POST /factcheck  ──► Groq LLM (llama-3.3-70b) + Tavily Search     │
│  POST /bias       ──► Groq LLM (llama-3.3-70b)                     │
└─────────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

### Extension

| File | Role |
|------|------|
| `manifest.json` | MV3 config — permissions, service worker, side panel, offscreen |
| `background.js` | Service worker — session lifecycle, rolling buffer, overlap dedup, backend fetch, broadcast |
| `content.js` | Content script — placeholder for future in-page claim highlighting |
| `offscreen.html` | Offscreen document shell |
| `offscreen.js` | Audio capture (getUserMedia), passthrough (AudioContext), ring buffer chunking |
| `sidebar/sidebar.html` | Side panel UI shell |
| `sidebar/sidebar.css` | Dark-mode styles — verdict colors, bias meter, emotion bar |
| `sidebar/sidebar.js` | Renders transcript, fact-check cards, bias meter from runtime messages |

### Backend

| File | Role |
|------|------|
| `server.js` | Express app — CORS, middleware, route mounting, health check |
| `routes/transcribe.js` | Proxies audio blobs to Groq Whisper, returns `{ text, language }` |
| `routes/factcheck.js` | Claim extraction → Tavily search → Groq verdict, with 1-hour claim cache |
| `routes/bias.js` | Language tone/framing analysis via Groq LLM |

## Data Flow

1. User clicks the FactLens icon → `background.js` calls `chrome.sidePanel.open()` synchronously
2. `chrome.tabCapture.getMediaStreamId()` returns a stream ID (MV3-compatible)
3. An offscreen document is created; the stream ID is passed to `offscreen.js`
4. `offscreen.js` calls `getUserMedia` with the stream ID to get the `MediaStream`
5. Audio is routed through an `AudioContext` → speakers (passthrough, user still hears the tab)
6. `MediaRecorder` fires `ondataavailable` every 500ms; chunks accumulate in a 12-slot ring buffer
7. Every 6 new chunks (~3s), the full ring buffer (6s of audio) is base64-encoded and sent to `background.js`
8. `background.js` decodes the base64, POSTs the blob to `POST /transcribe`
9. Groq Whisper returns `{ text, language }` — language is auto-detected
10. Overlap deduplication strips repeated words from the previous chunk boundary
11. New transcript text is broadcast to the side panel immediately and added to the rolling buffer
12. Every 20 seconds, `runAnalysis()` fires: sends the rolling buffer to `/factcheck` and `/bias` in parallel
13. Fact-check results (verdict, confidence, reasoning, sources) are broadcast to the side panel
14. Bias results (lean score, emotion score, framing label) update the meter

## Audio Pipeline Detail

```
MediaRecorder (500ms timeslice)
    │
    ▼ ondataavailable
Ring buffer [slot 0..11] — 12 × 500ms = 6 seconds total
    │
    ▼ every 6 new chunks (3 seconds)
Blob = concat(ring[0..11])   ← always 6s, overlaps 3s with previous blob
    │
    ▼ base64 encode
background.js → POST /transcribe
    │
    ▼ Groq Whisper
{ text, language }
    │
    ▼ deduplicateOverlap(prev, next)
New words only → sidebar + rolling buffer
```

## Message Types (background → side panel)

| Type | Payload | Description |
|------|---------|-------------|
| `STATUS` | `'idle' \| 'listening' \| 'processing'` | Session state change |
| `TRANSCRIPT` | `string` | New (deduplicated) transcript chunk |
| `FACTCHECK` | `Array<{claim, verdict, confidence, reasoning, sources}>` | Fact-check results |
| `BIAS` | `{lean_score, emotion_score, framing_label}` | Bias analysis result |
| `ERROR` | `string` | Human-readable error to display in the panel |

Internal messages (background ↔ offscreen, silently ignored by sidebar):

| Type | Direction | Description |
|------|-----------|-------------|
| `START_RECORDING` | background → offscreen | Begin capture with stream ID |
| `STOP_RECORDING` | background → offscreen | Stop capture and release resources |
| `AUDIO_CHUNK` | offscreen → background | Base64-encoded audio blob |
| `GET_STATUS` | sidebar → background | Request current session state on panel load |

## Fact-Check Pipeline

```
Rolling buffer (150 words) → POST /factcheck
    │
    ▼ Groq llama-3.3-70b (temperature 0.1)
Extract up to 3 verifiable claims
    │
    ▼ For each claim:
    ├─ Cache hit? → return instantly (1-hour TTL)
    └─ Cache miss:
        ├─ Tavily advanced search (5 results)
        ├─ Groq verdict call (grounded in search results only)
        └─ Cache result → return to sidebar
```

## API Keys

All keys live in `backend/.env` — never in the extension. The extension only ever talks to `localhost:3001`.

| Key | Service | Used for |
|-----|---------|----------|
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) | Whisper transcription + LLM fact-check + bias |
| `TAVILY_API_KEY` | [app.tavily.com](https://app.tavily.com) | Web search for claim verification |

## Sprint Status

| Sprint | Goal | Status |
|--------|------|--------|
| 1 | Scaffold, extension shell, sidebar UI, backend stubs | ✅ Done |
| 2 | Real audio capture (offscreen doc), Groq Whisper, audio passthrough | ✅ Done |
| 3 | Groq LLM fact-checking + Tavily, bias analysis, rolling buffer, claim cache, Spanish support | ✅ Done |
| 4 | UI polish, packaging | ⏳ Pending |
| 5 | Error handling, performance tuning, final packaging | ⏳ Pending |
