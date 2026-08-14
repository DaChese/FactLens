# FactLens Architecture Overview

FactLens is a Community Notes-style tool for live or pasted video context. The current system has two user surfaces that share one backend.

## Surfaces

| Surface | Responsibility |
|---|---|
| Chrome extension | Opens the side panel, captures tab audio with an offscreen document, reads captions/page signals, and triggers fast analysis for the active tab. |
| Railway product site | Explains the product, methodology, providers, installer, and next-generation TV roadmap. |
| Railway Analysis Studio | Available at `/studio.html`; runs the backend analysis on manually pasted transcript and page context. |
| Express backend | Proxies third-party API calls, applies provider key overrides, rate limits requests, and returns structured note/follow-up data. |
| Blind review workspace | Presents opted-in, de-branded transcript samples and collects independent rubric scores without revealing automation first. |

The Phase 1 stack stays intentionally small: Manifest V3, Node/Express, vanilla JavaScript, and static files in `backend/public`.

## Request Flow

1. The extension or web studio sends transcript and optional page context to `POST /coverage`.
2. `/coverage` asks Groq to identify the story and search query.
3. `/coverage` queries NewsAPI for other outlets covering that story.
4. The backend cross-checks the identified story against page signals and returned headlines.
5. Low-confidence matches withhold articles, missing context, and framing analysis.
6. Confident matches can include outlet coverage and missing-context items with source URLs.
7. A single Groq synthesis call extracts missing context and applies the versioned
   framing rubric; the backend validates quotes and derives confidence from observable inputs.
8. Follow-up buttons call `POST /factcheck` and `POST /discussion` only after a note exists.

The web studio cannot capture another tab. It only sends the fields the user pasted into the page.

## Backend Routes

| Endpoint | Purpose |
|---|---|
| `GET /health` | Basic server health check. |
| `GET /status` | Provider status, call counts, and budget state. |
| `POST /transcribe` | Sends one audio blob to Groq Whisper. Used by the extension when captions are unavailable. |
| `POST /coverage` | Identifies the story, checks coverage, gates low-confidence matches, extracts missing context, and analyzes target framing. |
| `POST /coverage/feedback` | Handles helpful/not-helpful feedback. Not-helpful evicts cached coverage for that query. |
| `POST /factcheck` | Extracts up to two checkable claims and verifies them with Tavily plus Groq. |
| `POST /discussion` | Searches and summarizes public reaction separately from verified reporting. |
| `GET /reviews/queue` | Returns a memory-only opted-in sample not yet rated by the reviewer session. |
| `POST /reviews/:sampleId` | Persists a locked blind review with a hashed reviewer session. |
| `GET /reviews/summary/:sampleId` | Aggregates agreement, means, stance coverage, and automated comparison. |
| `GET /reviews/stats` | Reports queue, audit, review, and reviewed-sample counts. |

## API Keys

Keys can come from backend environment variables or per-request override headers.

| Header | Environment fallback | Used for |
|---|---|---|
| `X-Groq-Key` | `GROQ_API_KEY` | Story ID, synthesis, transcription, statement verdicts, discussion summaries. |
| `X-Tavily-Key` | `TAVILY_API_KEY` | Statement checks and public reaction search. |
| `X-Newsapi-Key` | `NEWSAPI_KEY` | Coverage comparison, missing-context notes, and framing analysis. |

Header keys take priority over `.env`. The server never sends environment keys to the browser.

## Extension Data Flow

1. The viewer opens the side panel and presses **Start**.
2. `background.js` starts a session and creates the offscreen document when audio capture is needed.
3. `content.js` collects captions, page title, headlines, metadata, and pause/resume state.
4. `offscreen.js` keeps a short local audio ring buffer and sends audio chunks back to the service worker.
5. The service worker prefers captions, falls back to `/transcribe`, then calls `/coverage`.
6. A confident automatic note stops the session; unclear matches retry up to the configured attempt limit.
7. Follow-up statement and public-reaction checks are triggered by explicit user actions.
8. The sidebar renders framing scores, dimensions, provenance, and expandable evidence.

## Web Studio Data Flow

1. The visitor enters or loads sample content.
2. The page calls `/coverage` with transcript, page title, on-screen text, source domain, and language.
3. Results render in separate sections for story match, framing analysis, missing
   context, and other coverage.
4. Follow-up buttons stay disabled until a note exists.
5. Developer settings can override the backend URL and provider keys for testing.

The web studio stores those override settings in browser `localStorage` to preserve the existing prototype behavior.

## Review and Audit Data Flow

1. A Studio user explicitly enables review opt-in for a transcript.
2. After a validated framing result, `/coverage` gives the sample a random ID.
3. Raw transcript text enters an in-memory queue only; it is never written to disk.
4. Audit JSONL stores the transcript hash, story, automated result, and provenance.
5. The reviewer page receives de-branded text without automated scores.
6. A locked review is stored with a hashed reviewer-session ID.
7. Aggregate and automated results become visible only after submission.
8. Memory-only samples expire after 24 hours by default (`REVIEW_QUEUE_TTL_MS`).

## Trust Boundaries

- Raw audio stays local to the extension ring buffer unless the viewer triggers a note that needs transcription.
- The web studio does not capture audio or inspect another tab.
- Raw transcripts are not stored by the backend.
- Coverage and claim caches are in memory and reset on backend restart.
- Public reaction is labeled separately from reporting and factual evidence.
- Static outlet labels are historical context and do not determine a segment score.
- Framing analysis is automated and is not yet calibrated against a human reviewer panel.
- Persistent reports, dashboards, authentication, and public/community features are future phases.
- Calibration JSONL contains hashes and scores only. Production deployment still
  needs authentication, access controls, and an explicit retention policy.
