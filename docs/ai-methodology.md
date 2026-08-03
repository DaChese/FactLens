# How FactLens's AI Makes Decisions

This is the source-of-truth explanation of what the AI actually does — written to be
quoted directly when explaining "how does it decide bias / missing context" to judges
or sponsors. Every mechanism below is implemented in the code cited next to it; nothing
here is aspirational.

## 1. Identifying the story

**File:** `backend/routes/coverage.js`, `identifyStory()`

An LLM call reads the transcript of what's being said, plus — when available —
on-screen text scraped from the page: title, main headline, JSON-LD structured data
(`Article`/`NewsArticle`/`VideoObject` schema, which most professional news and video
sites already embed for SEO), Open Graph and Twitter Card metadata, and image
captions (see `extension/content.js` → `readPageSignals()`). These are deliberately
standards-based signals rather than site-specific CSS guessing, so they travel across
platforms. It returns a short neutral headline and a search query, or `null` if the
content isn't an identifiable news story at all (small talk, ads, music).

The prompt explicitly weighs on-screen text heavily: a page title usually names the
story directly, while spoken transcript can wander before getting to the point. A page
title alone is often enough on its own — the story can be identified before a single
word of audio has been transcribed, which is what lets the first check fire within
seconds of pressing Start instead of waiting for spoken transcript to accumulate.

Story identification runs on a smaller, faster Groq model than the rest of the
pipeline (it's a lean extraction task, not deep reasoning), with an automatic fallback
to the full model if that faster one isn't available.

## 2. Proving it's the right story — the consensus/confidence gate

**File:** `backend/lib/textMatch.js` (`keywordOverlap()`), `backend/routes/coverage.js`

A single LLM guess is not trusted on its own. The identified story is cross-checked
against two **independent** signals using a plain keyword-overlap score (tokenize,
strip stopwords, no LLM call, deterministic):

- Does the story overlap with the on-screen text scraped from the page?
- Does it overlap with the headlines NewsAPI actually returned for that search query?

Both agree → **high confidence**. One agrees (or no on-screen text was available to
compare) → **medium**. Neither agrees → **low confidence**, and the system
**withholds** the coverage comparison and missing-context sections rather than risk
showing detail for a misidentified story. Every note displays which signals it matched
on ("Matched on: audio transcript, on-screen text · high confidence") so a viewer — or
a judge — can see the evidence, not just trust a black box.

This is a genuinely agentic step: the system evaluates its own output before deciding
whether to act on it.

## 3. Not giving up on the first miss — retrying with its own prior guess

**File:** `extension/background.js`, `autoRunAndStop()` / `buildNote()`;
`backend/routes/coverage.js`, `identifyStory()`'s `previousGuess` handling

A single miss doesn't end the session. If the check can't identify a story yet, or the
confidence gate above flags the match as unreliable, the system **keeps listening and
tries again** — up to 3 attempts, spaced ~15 seconds apart, giving real time for more
captions or a fuller page load to arrive. It only stops once a confident result lands,
the attempt cap is reached, or the failure is one more listening time can't fix (a
missing API key, a hard error).

The part that makes this a genuine refinement loop rather than blind repetition: each
retry is told the system's **own previous guess** — "a previous pass tentatively
identified this as X; confirm, refine, or correct that using the fuller information
now available" — instead of independently re-guessing from scratch every time. The
transcript itself also keeps growing across attempts (the caption buffer is never
reset mid-session), so later attempts always have strictly more evidence than earlier
ones.

This is worth stating plainly as the strongest "agentic AI" example in the pipeline:
the system evaluates its own prior output, decides whether to trust it, and either
acts or iterates — not a single prompt-in/answer-out call.

## 4. Missing context

**File:** `backend/routes/coverage.js`, `extractMissingContext()`

A second LLM call compares the transcript against the headlines/descriptions of other
outlets currently covering the same story (from NewsAPI) and extracts up to 3 concrete
facts present in that other coverage but absent from this segment — a name, a
statistic, a prior event, an official response. Each fact is tied to the specific
article it came from and shown with a clickable source. Only runs when confidence is
not low.

## 5. What people are discussing (public reaction)

**File:** `backend/routes/discussion.js`

On request only (the "Check public reaction" button — never automatic, so it never
adds cost to building a note), a separate search (Tavily, reusing the same query)
looks for online discussion/reaction to the story, and one more LLM call summarizes
its general tenor. The prompt is explicit: **describe opinions as opinions**
("some commenters argue...", never as established fact), and return nothing at all if
the results are too thin to summarize honestly rather than guessing.

This section is always shown separately from, and never blended into, the news-outlet
coverage above it — verified reporting and unverified public sentiment are not the same
kind of information, and the UI doesn't pretend otherwise.

## 6. Viewer feedback (thumbs up/down) — honest about what it does and doesn't do

**File:** `backend/routes/coverage.js` (`POST /coverage/feedback`), `extension/sidebar/sidebar.js`

Each note can be rated on its story identification specifically. Thumbs down does one
concrete, real thing: it evicts that story from the backend's cache, so a repeat check
for the same story gets a fresh lookup instead of silently reusing the same wrong
result — and it dismisses the note immediately. Thumbs up is acknowledged in the UI
only; it has **no effect on future checks**. This is deliberately not dressed up as a
learning system — see `docs/ethics-and-trust.md` for the full reasoning, and the
X/Meta comparison below for why this is a different mechanism than it might look like.

## 7. "Bias" is explicitly not AI-judged

An earlier version of this project had an LLM score political lean and "emotional
charge" directly from the language of the transcript. **That was removed.** A single
model's unrubric'd judgment, re-run on live speech, is the least defensible kind of
"bias detection" — no ground truth, no consistency guarantee, no way to audit *why* it
scored something the way it did.

What replaced it: a **static, human-curated dataset** of outlet-level lean ratings
(`backend/data/bias-ratings.json`, ~48 outlets, styled after — not licensed from —
AllSides' left/lean-left/center/lean-right/right scale). When a story is covered by
multiple outlets, the note shows each outlet's known published lean and the resulting
spread ("4 left-leaning, 1 center, 2 right-leaning"). The AI never decides who's
biased; it only reports which outlets — with a pre-existing, disclosed rating — are
covering the story.

## How this compares to X/Meta Community Notes (and where it honestly differs)

FactLens is explicitly modeled on Community Notes' core idea — context added alongside
content, not a top-down verdict — but the actual mechanism is different, and it's worth
being precise about that difference:

| | X/Meta Community Notes | FactLens |
|---|---|---|
| Who writes the note | The crowd (any eligible contributor) | The AI pipeline |
| Who filters/verifies it | An algorithm, filtering *human ratings* | The AI's own consensus check against independent signals |
| Core mechanism | Bridging-based matrix factorization over a rater×note history — a note only surfaces once it's rated helpful by people who have *historically disagreed* with each other | Keyword-overlap agreement between the LLM's story ID, on-screen page text, and independently-returned search headlines |
| Timescale | Requires accumulated rating history; can take hours to days | Seconds — has to work standalone for live video |
| Viewer ratings | Ratings *are* the ranking algorithm's input — ratings from ideologically diverse users are what promotes a note | A thumbs-down evicts a cached result and dismisses the note; a thumbs-up is acknowledged only. Neither trains or re-ranks anything — a small, honest tool, not a scaled-down version of the real bridging algorithm |

Sources: X's real algorithm is documented in [twitter/communitynotes on GitHub](https://github.com/twitter/communitynotes/blob/main/documentation/under-the-hood/ranking-notes.md)
(bridging-based matrix factorization, a helpfulness "intercept" score, and a
"factor" measuring how polarizing the rating pattern is; a note needs a helpfulness
score above ~0.40 *and* low polarization to reach "Currently Rated Helpful"). Meta
adopted the same open-source algorithm for Facebook/Instagram/Threads in 2025,
replacing third-party fact-checkers, reported by
[Fast Company](https://www.fastcompany.com/91296566/meta-community-notes-fact-checking-system)
and [NBC News](https://www.nbcnews.com/tech/social-media/meta-ends-fact-checking-program-community-notes-x-rcna186468).

Say it this way in the room: **"inspired by Community Notes' philosophy — context over
verdicts, transparent evidence over black-box trust — not a reimplementation of its
crowd-rating algorithm."** Claiming otherwise to an audience that might know the real
mechanism is an unforced error.
