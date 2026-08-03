# FactLens Product Phases

FactLens is moving in phases so the hosted web surface can mature without breaking the extension.

## Phase 1: Manual Analysis Studio

Status: current implementation.

The Railway root page is a manual studio for pasted transcripts and page context. It uses the same backend routes as the extension:

- `POST /coverage` builds the Community Note.
- `POST /factcheck` checks statements after a note exists.
- `POST /discussion` summarizes public reaction after a note exists.
- `GET /status` helps diagnose provider keys and budgets.

The studio cannot capture another browser tab, read captions automatically, or inspect page content. Users must paste the transcript, headline, visible text, or source domain they want analyzed.

## Phase 2: Extension Dashboard

Status: planned.

The Railway frontend becomes a companion dashboard for extension-generated notes. The extension should send explicit note and tab identifiers so follow-up actions target the correct stored note. Notes should be private or unlisted by default.

Phase 2 should not add public posting until storage, authentication, retention, deletion, and privacy controls are defined.

## Phase 3: Full Report Pages

Status: planned.

Each completed note can expand into a shareable report with the identified story, missing context, outlet coverage, statement checks, public discussion, and source links. Reports should make uncertainty visible and avoid turning public reaction into verified evidence.

Persistent report storage needs retention limits, deletion controls, and careful handling of raw transcripts before it ships.

## Phase 4: Public Explorer or Community Review

Status: planned.

A public explorer or community review layer should come only after story matching, moderation, abuse controls, and privacy boundaries are reliable. Community participation must not pretend to be X/Meta Community Notes unless it has the rating diversity, history, and moderation systems that make that model meaningful.

## Privacy Boundaries

- The browser studio does not automatically inspect another tab.
- Raw audio should not be stored.
- Transcript storage should not be added silently.
- API keys must not be logged or rendered back to the page.
- Future reports should be private or unlisted by default.
- Future persistent storage needs retention and deletion controls before launch.
