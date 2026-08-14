# Ethics & Trust Framework

FactLens makes editorial-adjacent claims about live news — who's covering what, who's
biased, what's missing. That's a real responsibility, and it shaped specific design
decisions, not just good intentions. Each item below points to the code that enforces
it, not just a policy statement.

## 1. Context, not verdicts

The tool never tells a viewer what to believe. It shows what else exists.

- No "FACT CHECK: TRUE/FALSE" badges. Statement checks use neutral labels — **Confirmed
  / Disputed / Unclear** — always with the one-sentence reasoning and source links
  attached (`extension/sidebar/sidebar.js` → `VERDICT_LABELS`).
- Public reaction is described as opinion, explicitly: the discussion-summary prompt is
  instructed to write "some commenters argue..." never "X is true" (`backend/routes/discussion.js`
  → `DISCUSSION_SYSTEM_PROMPT`).
- The UI itself reinforces this — plain black-and-white, no color coding a claim as
  good/bad/dangerous.

## 2. Nothing is asserted without a visible source

Every fact in a note traces to a clickable link: missing-context items cite the
specific article they came from (`backend/routes/coverage.js` →
`extractMissingContext()`), outlet coverage links to the actual articles, checked
statements list their search sources, and public discussion summaries link the threads
they were drawn from. If the system can't cite something, it doesn't say it.

## 3. The system can say "I don't know" — on purpose

This is the least common but most important AI-safety property here: **the confidence
gate can withhold output.** When the story-identification consensus check fails (see
`docs/ai-methodology.md`), the note explicitly says "low-confidence match — coverage
withheld" instead of confidently displaying context for what might be the wrong story.
Same for the discussion feature: thin search results produce "not enough public
discussion to summarize" rather than a fabricated one. Most of the failure modes people
worry about with AI news tools are exactly this — confident wrongness — and the
architecture is built to refuse rather than guess.

## 4. Framing analysis and outlet history are separate

The current framing assessment is AI-generated, but constrained by an explicit,
versioned rubric. Political direction, framing intensity, and reliability are separate
outputs. Findings must quote the target transcript exactly; the backend discards an
evidence excerpt when it cannot be found verbatim in the submitted text.

Displayed analysis completeness is not model self-assessment or accuracy confidence.
It reports the amount of distinct comparison coverage and validated evidence available.
Results expose their timestamp and methodology version. These controls improve auditability, but do not make the
assessment objective: version 1.0 uses one model pass and is not yet calibrated by a
politically diverse human reviewer panel.

Both user interfaces label framing and political direction as experimental. This is a
required product disclaimer for the prototype, not merely documentation fine print.

The following static data is retained only as outlet-history context:

`backend/data/bias-ratings.json` is a small, hand-curated approximation of
AllSides-style outlet ratings — not licensed AllSides data, not an algorithm, and not
an LLM's opinion re-scored on the fly (an earlier LLM-based bias meter was deliberately
removed; see `docs/ai-methodology.md` §7). Anyone can open the file and see exactly
what it contains and where the categories came from.

The UI explicitly says this label is not the current segment's score. It never feeds
or overrides the dynamic framing assessment.

## 5. Broadcaster-controlled, not imposed

The intended deployment model (see `docs/user-journey.md` and
`docs/roadmap-phase2-3.md`) is a station choosing to offer this to its own audience —
not a third party inserting verdicts over someone else's broadcast. It never touches
what a station airs; it's an audience-facing companion layer the broadcaster opts into,
which preserves editorial independence rather than overriding it.

## 6. Data handling

- Audio lives only in a local ~90-second ring buffer in the browser extension during an
  active session (`extension/offscreen.js`) — nothing is recorded to disk or sent
  anywhere until the viewer explicitly presses a button.
- API keys are stored in the browser's local storage and sent only to the user's own
  backend, never to a third party (`backend/lib/keys.js` per-request header pattern).
- In-memory caches (coverage, claims, ratings status) reset on backend restart — no
  persistent viewer profile is built anywhere.
- Blind-review participation is explicit and off by default. Opted-in raw transcripts
  stay only in memory and disappear on restart. Persistent JSONL stores transcript
  hashes, scores, timestamps, methodology provenance, and hashed reviewer sessions.
  Audit records exclude raw transcript text, story titles, and quoted evidence excerpts.
- The server, not only the UI, blocks aggregate/automated review summaries until that
  reviewer session has submitted a locked review. Memory-only samples expire after
  24 hours by default.
- Review sample, submission, and summary endpoints fail closed unless an operator sets
  a panel access token. The token limits the queue to an invited review panel.
- Reviewer political perspective is optional calibration metadata. It is associated
  with a one-way hashed session and used to measure panel diversity, not identity.

## 7. Responsible use of third-party APIs

Rate limiting and self-imposed provider budgets (`backend/lib/rateLimit.js`) aren't
just a cost-control feature — they're a commitment that a bug or a demo running long
can't silently exhaust a shared API quota that other legitimate uses depend on. The
system stops calling a provider *before* the provider's real limit, with a clear
message about why, rather than failing unpredictably or racking up charges.

## 8. Viewer feedback doesn't gate what's shown — the system's own checks do

Each note has a "Right story?" thumbs up/down (`backend/routes/coverage.js` →
`POST /coverage/feedback`). Deliberately scoped small, and worth being precise about
what it is and isn't:

- **Thumbs down** dismisses the note and evicts that story from the backend's cache —
  a repeat check won't silently reuse the same wrong result. That's the entire effect.
- **Thumbs up** is acknowledged in the sidebar and nothing else. It doesn't score,
  weight, or influence any future check.
- Visibility of a note is decided entirely by the system's own consensus/confidence
  gate (§3 above), before any viewer ever sees it — not by accumulated ratings. This is
  the opposite shape from platforms where crowd ratings *are* the visibility mechanism;
  the honest comparison is in `docs/ai-methodology.md`'s X/Meta table. Choosing not to
  build a full crowd-rating system here was deliberate, not a missing feature — a
  meaningful bridging-style mechanism needs a real population of raters with rating
  history to work correctly, which a single-viewer prototype doesn't have. Pretending
  otherwise would be its own dishonesty.

## 9. What this doesn't solve

Being direct about limits, since overclaiming is its own ethical failure:

- The outlet bias dataset is small (~48 outlets), US-centric, and a static
  approximation — it will misjudge or fail to rate real outlets. Disclosed openly
  rather than presented as authoritative.
- Framing analysis is sensitive to transcript quality, the comparison articles
  returned by NewsAPI, and the model prompt. It has no human inter-rater agreement,
  blind survey, or longitudinal calibration yet.
- Its completeness score measures available inputs and validated evidence, not a
  statistical probability that the political-direction label is correct.
- Keyword-overlap consensus checking catches gross mismatches, not subtle ones — it's
  a safety net, not a guarantee of correctness.
- Public-discussion search reflects whatever a general web search surfaces about a
  topic, not a representative sample of public opinion — it's a signal, not a poll.
- The retry loop is bounded (3 attempts) — a genuinely ambiguous or content-free
  segment will still end in "low-confidence match" rather than a guaranteed answer,
  by design, rather than looping indefinitely to force one.
