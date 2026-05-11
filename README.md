# FactLens 🔍

Ever watched a news segment or podcast and wondered "is that actually true?" FactLens is a Chrome extension that listens to whatever's playing in your browser, transcribes it live, and automatically fact-checks what's being said — all in a side panel right next to the page.

## What it does

- **Live transcription** — captures audio from any tab and turns it into text in real time
- **Fact-checking** — pulls out specific claims, searches the web, and tells you if they're True, False, or Unverified — with sources
- **Bias detection** — analyzes the language and framing, not just the topic, and shows you where it lands on the political spectrum
- **Works in English and Spanish** — auto-detects the language, no setup needed

## Built with

| | |
|--|--|
| Chrome Extension | MV3, Service Worker, Offscreen Document |
| Transcription | Groq Whisper (`whisper-large-v3-turbo`) |
| Fact-checking & Bias | Groq LLM (`llama-3.3-70b-versatile`) |
| Web Search | Tavily Search API |
| Sidebar | Vanilla JS + CSS (dark mode) |
| Backend | Node.js + Express (deployable to Railway) |

## Getting it running

You need the backend running somewhere and the Chrome extension loaded. Pick one:

### Option A — Local development

```bash
cd factlens/backend
cp .env.example .env
# Add your API keys to .env (see below)
npm install
npm run dev
```

Check it's alive:
```bash
curl http://localhost:3001/health
# {"status":"ok","timestamp":"..."}
```

### Option B — Deploy to Railway (no local server needed)

1. Go to [railway.app](https://railway.app) and sign in with GitHub
2. Click **New Project → Deploy from GitHub repo** → select your FactLens fork
3. Set the **Root Directory** to `backend`
4. Add environment variables in the Railway dashboard: `GROQ_API_KEY` and `TAVILY_API_KEY`
5. Railway gives you a public URL like `https://factlens-xxxx.up.railway.app`
6. Open `extension/background.js` and update `BACKEND_URL` to your Railway URL
7. Reload the extension in `chrome://extensions`

### Load the extension

1. Go to `chrome://extensions` in Chrome
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** → select the `factlens/extension/` folder
4. The FactLens icon shows up in your toolbar

### Use it

1. Open any tab with audio — YouTube, a podcast, a news stream
2. Click the FactLens icon
3. The side panel opens and starts listening
4. Transcript shows up within a few seconds, fact-checks roll in after about 20 seconds
5. Click the **stop button** in the panel header (or the toolbar icon again) to stop

## API Keys

You only need two keys, both free:

| Key | Where to get it |
|-----|----------------|
| `GROQ_API_KEY` | [console.groq.com](https://console.groq.com) — free account |
| `TAVILY_API_KEY` | [app.tavily.com](https://app.tavily.com) — free tier |

For local dev, put them in `backend/.env`. For Railway, add them as environment variables in the dashboard.

Don't commit `.env` to git — your keys stay local.

## How it actually works under the hood

Chrome's MV3 extensions can't directly access audio streams in a service worker, so there's a bit of a relay happening:

1. You click the icon → the side panel opens
2. The service worker gets a stream ID from Chrome's tab capture API
3. That ID gets passed to a hidden "offscreen document" which does the actual audio capture
4. The audio is also routed back to your speakers so you can still hear everything
5. Every 3 seconds, a 6-second overlapping audio clip gets sent to the backend
6. Groq Whisper transcribes it and detects the language
7. The transcript shows up in the panel immediately
8. Every 20 seconds, the last ~150 words get analyzed for claims and bias
9. For each claim: Tavily searches the web, then the LLM reads the results and gives a verdict
10. Claims are cached for an hour so the same claim doesn't get re-searched every cycle

The 6-second overlapping window is what prevents words from getting dropped at chunk boundaries — each clip shares 3 seconds with the previous one, so nothing falls through the cracks.

## What the fact-check cards show

Each card has:
- The claim extracted from the transcript
- A verdict badge — **True** (green), **False** (red), or **Unverified** (orange)
- A confidence bar showing how sure the model is
- A one-sentence reasoning explaining the verdict
- Source links showing which sites the verdict is based on

## Project files

```
factlens/
├── extension/
│   ├── manifest.json        # Chrome extension config
│   ├── background.js        # Service worker — the brain of the operation
│   ├── content.js           # Content script (placeholder for future features)
│   ├── offscreen.html/js    # Hidden doc that handles audio capture
│   └── sidebar/             # The side panel UI
├── backend/
│   ├── server.js            # Express server
│   ├── railway.toml         # Railway deployment config
│   └── routes/
│       ├── transcribe.js    # Sends audio to Groq Whisper
│       ├── factcheck.js     # Extracts claims, searches Tavily, gets verdicts
│       └── bias.js          # Analyzes language tone and framing
└── docs/
    └── architecture.md      # Full technical diagram if you want to go deep
```

## Sprint progress

- [x] Sprint 1 — Got the extension loading and the sidebar rendering
- [x] Sprint 2 — Real audio capture, passthrough, Whisper transcription
- [x] Sprint 3 — Fact-checking, bias analysis, claim cache, Spanish support, overlap fix
- [x] Sprint 4 — Stop button, timestamps, clear buttons, spinner, UI polish, v1.1.0
- [x] Sprint 5 — Railway deployment config, production-ready backend

## Things to know

- After deploying to Railway, update `BACKEND_URL` in `extension/background.js` with your Railway URL
- The claim cache resets when the backend restarts
- Bias analysis looks at *how* something is said, not *what* is being said
- First transcript shows up after about 6 seconds, first fact-checks after about 20 seconds
