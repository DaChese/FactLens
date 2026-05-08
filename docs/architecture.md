# FactLens — Architecture Overview

## System Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│  Chrome Browser                                                      │
│                                                                      │
│  ┌──────────────┐  tabCapture   ┌───────────────────────────────┐   │
│  │  Active Tab  │ ────────────► │  background.js                │   │
│  │  (any page)  │               │  (Service Worker)             │   │
│  │              │               │                               │   │
│  │ ┌──────────┐ │               │  • Opens Side Panel           │   │
│  │ │content.js│ │               │  • Captures tab audio         │   │
│  │ │(hook for │ │               │  • Chunks audio               │   │
│  │ │ future   │ │               │  • Sends to backend           │   │
│  │ │ in-page  │ │               │  • Broadcasts results via     │   │
│  │ │ features)│ │               │    chrome.runtime.sendMessage │   │
│  │ └──────────┘ │               └──────────────┬────────────────┘   │
│  └──────────────┘                              │ runtime.sendMessage │
│                                                ▼                     │
│                               ┌────────────────────────────────┐    │
│                               │  Chrome Side Panel             │    │
│                               │  sidebar/sidebar.html          │    │
│                               │  (Native extension UI — no     │    │
│                               │   iframe, no DOM injection)    │    │
│                               │                                │    │
│                               │  • Renders transcript feed     │    │
│                               │  • Renders fact-check cards    │    │
│                               │  • Animates bias meter         │    │
│                               └────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
                          │ HTTP (localhost:3001)
                          ▼
┌─────────────────────────────────────────────────────────────────┐
│  Node.js / Express Backend                                      │
│                                                                 │
│  POST /transcribe ──► OpenAI Whisper API                        │
│  POST /factcheck  ──► Anthropic Claude + Tavily Search          │
│  POST /bias       ──► Anthropic Claude                          │
└─────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

### Extension

| File | Role |
|------|------|
| `manifest.json` | Declares permissions, registers service worker, content script, and side panel |
| `background.js` | Service worker — owns audio capture, chunking, backend communication, and broadcasting results to the side panel via `chrome.runtime.sendMessage` |
| `content.js` | Content script — lightweight hook for future in-page features (e.g. highlighting verified claims in page text). No DOM injection. |
| `sidebar/sidebar.html` | Side panel UI shell — loaded by Chrome's native Side Panel API |
| `sidebar/sidebar.css` | Dark-mode styles for the sidebar |
| `sidebar/sidebar.js` | Listens on `chrome.runtime.onMessage` and renders transcript, fact-check cards, and bias meter |

### Backend

| File | Role |
|------|------|
| `server.js` | Express app — CORS, middleware, route mounting |
| `routes/transcribe.js` | Proxies audio blobs to OpenAI Whisper |
| `routes/factcheck.js` | Extracts claims via Claude, searches via Tavily, returns verdicts |
| `routes/bias.js` | Analyses language tone/framing via Claude |

## Data Flow

1. User clicks the FactLens icon → `background.js` calls `chrome.sidePanel.open()` and starts a session.
2. Audio is captured via `chrome.tabCapture`, buffered, and chunked every ~5 seconds.
3. Each chunk is POSTed to `POST /transcribe` → Whisper returns text.
4. `background.js` broadcasts the transcript to the side panel via `chrome.runtime.sendMessage`.
5. In parallel, the transcript is sent to `POST /factcheck` and `POST /bias`.
6. Results are broadcast to the side panel and rendered as verdict cards / bias meter updates.

The side panel (`sidebar.js`) is an extension page — it shares the extension's runtime message bus and receives messages directly from `background.js`. No iframe, no `postMessage` bridge needed.

## Message Types (background → side panel)

| Type | Payload | Description |
|------|---------|-------------|
| `STATUS` | `'idle' \| 'listening' \| 'processing'` | Session state change |
| `TRANSCRIPT` | `string` | New transcript chunk |
| `FACTCHECK` | `Array<{claim, verdict, confidence, sources}>` | Fact-check results |
| `BIAS` | `{lean_score, emotion_score, framing_label}` | Bias analysis result |
| `ERROR` | `string` | Human-readable error message to display in the panel |

All messages are sent via `chrome.runtime.sendMessage` from `background.js` and received in `sidebar.js` via `chrome.runtime.onMessage`. `content.js` also listens on the same bus as a hook for future in-page features.

## API Keys

All keys live in `backend/.env` (never in the extension). The extension only ever talks to `localhost:3001`.

## Sprint Plan

| Sprint | Goal |
|--------|------|
| **1** | Scaffold all files; extension loads in Chrome; sidebar renders; backend starts |
| **2** | Wire up real audio capture → Whisper transcription |
| **3** | Integrate Claude fact-checking + Tavily search |
| **4** | Integrate Claude bias analysis; polish UI |
| **5** | Error handling, edge cases, performance tuning, packaging |
