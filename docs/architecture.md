# FactLens Architecture Overview

FactLens is a Community Notes-style tool for live or pasted video context. The current system has two user surfaces that share one backend.

## Surfaces

| Surface | Responsibility |
|---|---|
| Chrome extension | Opens the side panel, captures tab audio with an offscreen document, reads captions/page signals, and triggers fast analysis for the active tab. |
| Railway Analysis Studio | Lets visitors manually paste transcript and page context, then run the same backend analysis without installing the extension. |
| Express backend | Proxies third-party API calls, applies provider key overrides, rate limits requests, and returns structured note/follow-up data. |

The Phase 1 stack stays intentionally small: Manifest V3, Node/Express, vanilla JavaScript, and static files in `backend/public`.

## Request Flow

1. The extension or web studio sends transcript and optional page context to `POST /coverage`.
2. `/coverage` asks Groq to identify the story and search query.
3. `/coverage` queries NewsAPI for other outlets covering that story.
4. The backend cross-checks the identified story against page signals and returned headlines.
5. Low-confidence matches withhold articles and missing context.
6. Confident matches can include outlet coverage and missing-context items with source URLs.
7. Follow-up buttons call `POST /factcheck` and `POST /discussion` only after a note exists.

The web studio cannot capture another tab. It only sends the fields the user pasted into the page.

## Backend Routes

| Endpoint | Purpose |
|---|---|
| `GET /health` | Basic server health check. |
| `GET /status` | Provider status, call counts, and budget state. |
| `POST /transcribe` | Sends one audio blob to Groq Whisper. Used by the extension when captions are unavailable. |
| `POST /coverage` | Identifies the story, checks coverage, gates low-confidence matches, and extracts missing context. |
| `POST /coverage/feedback` | Handles helpful/not-helpful feedback. Not-helpful evicts cached coverage for that query. |
| `POST /factcheck` | Extracts up to two checkable claims and verifies them with Tavily plus Groq. |
| `POST /discussion` | Searches and summarizes public reaction separately from verified reporting. |

## API Keys

Keys can come from backend environment variables or per-request override headers.

| Header | Environment fallback | Used for |
|---|---|---|
| `X-Groq-Key` | `GROQ_API_KEY` | Story ID, synthesis, transcription, statement verdicts, discussion summaries. |
| `X-Tavily-Key` | `TAVILY_API_KEY` | Statement checks and public reaction search. |
| `X-Newsapi-Key` | `NEWSAPI_KEY` | Coverage comparison and missing-context notes. |

Header keys take priority over `.env`. The server never sends environment keys to the browser.

## Extension Data Flow

1. The viewer opens the side panel and presses **Start**.
2. `background.js` starts a session and creates the offscreen document when audio capture is needed.
3. `content.js` collects captions, page title, headlines, metadata, and pause/resume state.
4. `offscreen.js` keeps a short local audio ring buffer and sends audio chunks back to the service worker.
5. The service worker prefers captions, falls back to `/transcribe`, then calls `/coverage`.
6. A confident automatic note stops the session; unclear matches retry up to the configured attempt limit.
7. Follow-up statement and public-reaction checks are triggered by explicit user actions.

## Web Studio Data Flow

1. The visitor enters or loads sample content.
2. The page calls `/coverage` with transcript, page title, on-screen text, source domain, and language.
3. Results render in separate sections for story match, missing context, and other coverage.
4. Follow-up buttons stay disabled until a note exists.
5. Developer settings can override the backend URL and provider keys for testing.

The web studio stores those override settings in browser `localStorage` to preserve the existing prototype behavior.

## Trust Boundaries

- Raw audio stays local to the extension ring buffer unless the viewer triggers a note that needs transcription.
- The web studio does not capture audio or inspect another tab.
- Raw transcripts are not stored by the backend.
- Coverage and claim caches are in memory and reset on backend restart.
- Public reaction is labeled separately from reporting and factual evidence.
- Persistent reports, dashboards, authentication, and public/community features are future phases.
