# Agent Note: Resume selector folds titles only

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-31-resume-selector-batch-projection.zh.md)

## Problem

Opening the TUI `/resume` selector called `sessionQuery.readSession()` once per listed session under an unbounded `Promise.all`. Each call re-listed the whole persistence store inside `SessionCorpus.load()` (O(N²) listings), read and decompressed the complete log, replay-validated every event through the `Session` constructor, and deep-cloned the header and events up to three times — all to derive one selector row's title, last-activity time, last `turn/end` label, provider/model route, and goal phase. On a real store (185 sessions, 87 MB compressed, ~353k events) the selector took tens of seconds to open, and the cost grew with total log size rather than session count.

## Decision

Selector rows fold nothing but titles, and everything else a row shows comes from metadata:

- Titles come from the projection system: `session-title` already registers a `title` unit, so a live row reads the registry snapshot, a persisted row reads the durable checkpoint row (`sessionProjectionCache.cachedSnapshot`, one file read per session), and only a row without a usable checkpoint pays a `coldSnapshot` — checkpoint plus a `readFrom` tail, written back so the next scan is zero-I/O. Cold reads are bounded by the TUI `resumeScanConcurrency` config. A composition without the cache falls back to one bounded `readTitleSnapshots` batch over the logs; either path isolates a per-row failure into the disabled "Unreadable session" fallback.
- The activity timestamp never reads a log: a live Session uses its last in-memory event time; a persisted Session stats the artifact named by the optional `sessionPersistence.locate()` (mtime), falling back to the header's creation time when a provider locates no per-Session artifact or the stat fails. Any append moves the mtime, so a mere pickup boundary now floats a browsed Session up — accepted as the price of a metadata-only timestamp.
- The last-turn label, provider/model route, and goal phase columns are gone from rows. Route availability is now enforced by the Enter-time preflight, which fully reads and replay-validates the one chosen log through `readSession` before handoff.

The selector overlay opens synchronously when `/resume` dispatches, before the scan settles: an `undefined` candidate set renders a "Loading sessions…" placeholder, the picker owns terminal input from its first frame, Enter reports that sessions are still loading, and Escape cancels. Closing the overlay aborts the scan through the `AbortSignal` the query methods accept; a signal-ignoring backend's late settlement is dropped by a staleness check. The finished scan swaps rows in through `setCandidates` (clearing a stale still-loading error) without replacing the overlay; a queued activation behind a closing predecessor receives an already-scanned set at construction; one catch spans listing, titles, and mtimes, so any scan failure closes the overlay and reports a notice rather than stranding the loading placeholder.

No session-query or session-persistence surface changed. The shipped TUI composition gains the projection registry, storage, and projection-cache rows (mirroring the web overlay over the same `storages` root, so checkpoints written by either surface serve both); the first scan over a pre-existing store still reads each log once to seed checkpoints, and every later scan is metadata-only.

## Alternatives considered

**Keep per-row route/turn/goal columns via a generic batch projection (`projectSessions`).** Implemented first, then rejected: it still decompressed and parsed every log on every `/resume`, so browsing cost stayed O(total log bytes), and it grew the session-query public API for one consumer. The public contract was reverted; `readTitleSnapshots` keeps using the internal `projectMany` unchanged.

**Fix only the O(N²) listing inside `SessionCorpus.load()`.** Rejected as the primary fix: the per-candidate full decompress, replay validation, and triple clone dominated on large logs. The redundant pre-listing in `load()` remains a candidate cleanup with error-semantics implications.

**Surface a last-modified time through `list()`/`SessionRecord`.** Cleanest seam-wise, but touches the persistence contract, provider, and query record type for what the TUI can already derive from the stored log's file metadata. Reintroduce if a second consumer needs metadata activity times.

**A bespoke persisted title index or TUI-local title cache.** Rejected: the session-projection cache already is the owned durable checkpoint system with an invalidation contract (`stateVersion`, identity binding, shrunk-log anchoring); mounting it beats adding a parallel cache.

## Consequences

Opening `/resume` performs one listing, one stat per persisted row, and per-row title reads that touch only checkpoint rows and log tails once checkpoints exist — O(session count) metadata instead of O(total log bytes); the fallback path without the cache remains one bounded title pass. Rows show title, timestamp, status, and id only; route problems surface as an Enter-time preflight error instead of a disabled row, and a session that fails replay is caught by preflight rather than the listing. Browsed-then-abandoned sessions float up on their pickup mtime. Fake `sessionQuery` services in TUI tests provide `readTitleSnapshots` alongside `listSessions`/`readSession`, and the test harness forwards an optional `locate`. Because the picker takes focus immediately, starting a second scan requires dismissing the current overlay first — a second `/resume` typed during a scan lands in the search field, which is the intended input capture.
