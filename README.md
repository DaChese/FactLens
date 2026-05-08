# FactLens

A Chrome extension (Manifest V3) that captures audio from any active browser tab, transcribes it in real time, and runs an AI agent to fact-check claims and detect bias. Results are displayed in a live sidebar injected into the page.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Extension | Chrome MV3, Service Worker, Web Audio API |
| Transcription | OpenAI Whisper API |
| Fact-checking & Bias | Anthropic Claude (`claude-sonnet-4-20250514`) |
| Search / Sourcing | Tavily Search API |
| Sidebar UI | Vanilla JS + CSS |
| Backend | Node.js + Express |

## Project Structure

```
factlens/
├── extension/
│   ├── manifest.json
│   ├── background.js
│   ├── content.js
│   ├── sidebar/
│   │   ├── sidebar.html
│   │   ├── sidebar.js
│   │   └── sidebar.css
│   └── icons/
├── backend/
│   ├── server.js
│   ├── routes/
│   │   ├── transcribe.js
│   │   ├── factcheck.js
│   │   └── bias.js
│   ├── package.json
│   └── .env.example
├── docs/
│   └── architecture.md
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
```

### 2. Chrome Extension

1. Open Chrome and navigate to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select the `factlens/extension/` folder
4. The FactLens icon will appear in your toolbar

### 3. Icons

Add PNG icons to `extension/icons/`:
- `icon16.png` — 16×16
- `icon48.png` — 48×48
- `icon128.png` — 128×128

Placeholder icons can be any solid-colour PNGs for Sprint 1.

## Environment Variables

Copy `backend/.env.example` to `backend/.env` and fill in:

| Variable | Description |
|----------|-------------|
| `PORT` | Backend port (default: 3001) |
| `OPENAI_API_KEY` | OpenAI key for Whisper transcription |
| `ANTHROPIC_API_KEY` | Anthropic key for Claude |
| `TAVILY_API_KEY` | Tavily key for web search |

**Never commit `.env` to version control.**

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Server health check |
| `POST` | `/transcribe` | Audio blob → transcription text |
| `POST` | `/factcheck` | Transcript text → fact-check verdicts |
| `POST` | `/bias` | Transcript text → bias analysis |

See `docs/architecture.md` for the full system diagram and data flow.

## Sprint Status

- [x] **Sprint 1** — Scaffold complete; extension loads; sidebar renders; backend starts
- [ ] **Sprint 2** — Real audio capture + Whisper transcription
- [ ] **Sprint 3** — Claude fact-checking + Tavily search
- [ ] **Sprint 4** — Claude bias analysis + UI polish
- [ ] **Sprint 5** — Error handling, performance, packaging
