---
description: "The unified session-history query service for consumers and backend authors: exact reads, relationship traces, and provider-independent filters over live and durable session logs."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-query

English | [中文](README.zh.md)

## Summary

`dsh-session-query` gives code callers one service for retrieving session history: read a complete raw log, list and filter sessions, fold titles, read events with bounded context, trace session lineage and event relationships, and run full-text search. Live sessions take precedence over persisted ones, and every returned record is a detached clone, so results always describe one consistent moment. Exact reads, filters, and traces are built in; full-text search comes from a mounted backend such as `dsh-session-query-sqlite`. Use it directly from code when you need programmatic access to what the model saw. Setup and usage come first; the implementation internals live in a collapsible developer section below.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use `ctx.sessionQuery` from application code when you need to read or search session history without touching the session service or a storage backend directly. The service is provided by a concrete backend plugin — the shipped composition mounts `@deepseek-ai/dsh-session-query-sqlite` ([README](../session-query-sqlite/README.md)) — so this package is never mounted alone. Everything below is available on `ctx.sessionQuery` once a backend is composed.

### What you can do

| Operation | What you get |
|---|---|
| `listSessions()` | Every logical session, newest first, with `live` and `persisted` availability flags |
| `readSession(id)` | The complete replay-validated raw event log, without making the session live |
| `filterSessions(filters)` | Sessions matching ANDed metadata and availability predicates |
| `filterEvents(id, filters)` | Semantic event documents matching metadata and literal-text predicates |
| `readTitleSnapshots(ids)` | The latest folded title per session, bound to its source header |
| `listEvents(id)` / `readSurface(id)` | Lightweight per-event records, or the complete current model surface |
| `readEvent(request)` | One full event plus a bounded raw-log window around it |
| `traceSession(id)` | The known ancestor chain and recursive descendant trees |
| `traceEvent(request)` | One event's positional replacements and cited source-event relationships |
| `searchSessions(request)` / `searchEvents(request)` | Full-text search pages, implemented by the mounted backend |

Body-free records expose only `SessionHeader.isSeeded`. Reads that return event bodies (`readSession`, `readSurface`, `readEvent`) and retained `SessionObservation` values also carry the exact `inheritedEventCount`, so callers can distinguish inherited and owned events without inferring a cut from the log.

### Filters

`SessionResultFilter` narrows sessions by id, nullable cwd, created-at range, nullable parent, or source availability; `SessionEventResultFilter` narrows events by seq/time range, event type, surface, or literal text. Filter arrays are ANDed and list values within one clause are ORed; empty list values match nothing, ranges are inclusive, and malformed ranges or unknown closed-union values fail with `SESSION_QUERY_INVALID_FILTER`.

The text clause is a literal, case-insensitive, whitespace-flexible scan of extracted semantic text — not a full-text query. Use it for arbitrary substring recall; use the mounted backend's search methods when you need ranked full-text results.

### Configuration

The inherited knobs are set through the mounted backend's config:

| Field | Default | Meaning |
|---|---|---|
| `readWindowMax` | `50` | Maximum `before`/`after` raw events accepted by `readEvent` |
| `persistedReadConcurrency` | `4` | Concurrent persisted-log reads in one batch title read |
| `preparedSessionCacheSize` | `5` | Cold prepared-Session observations retained for reuse across `observeSession` reads |

### Failures and recovery

Failures are typed with a stable `SessionQueryError.code`. The ones you will meet: `SESSION_QUERY_SESSION_NOT_FOUND` when an id is absent; `SESSION_QUERY_SOURCE_CONFLICT` when live and persisted observations of one session disagree on immutable headers; `SESSION_QUERY_PERSISTENCE_FAILED` when mounted persistence is unreadable; `SESSION_QUERY_CORRUPT_SESSION` when a durable record fails Session validation; and `SESSION_QUERY_INVALID_SURFACE` when a loaded log breaks the surface contract. Reads targeting a known live session never consult persistence, so a failing backend cannot make current in-memory history unreadable.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the service and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The service is built on one separation and three commitments:

- **Live-preferred logical corpus.** Every read resolves one consistent observation: live `ctx.sessions` wins, optional `ctx.sessionPersistence` fills the rest, and conflicting immutable headers fail rather than merge.
- **Detached results.** All returned headers, events, and records are cloned; nothing exposes live state or a retained subscription.
- **Exact reads concrete, search abstract.** Reads, filters, and traces are implemented here once; the two full-text methods are the only abstract surface a backend owns.
- **One canonical surface fold.** `listEvents`, `readSurface`, and `traceEvent` validate the whole log with the same `dsh-session` fold, so search and traces agree with model-history derivation.

The decision history lives in the [unified service decision](../../../.agents/notes/archived/architecture/2026-07-23-unified-session-query-service.md), the [tracing note](../../../.agents/notes/implemented/feature/2026-07-13-session-query-tracing.md), and the [SQLite provider note](../../../.agents/notes/implemented/feature/2026-07-10-sqlite-session-query-provider.md).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service definition: the abstract `SessionQueryEngine`, concrete reads, config validation |
| [`src/corpus.ts`](src/corpus.ts) | Live-preferred corpus resolution, optional persistence binding, batch projections |
| [`src/observation.ts`](src/observation.ts) | Live-preferred point observations with a bounded revision-keyed prepared-Session cache |
| [`src/cold-read.ts`](src/cold-read.ts) | Handle-based cold log read with in-memory interrupted-turn closers |
| [`src/types.ts`](src/types.ts) | Public records, filters, requests, and page types |
| [`src/config.ts`](src/config.ts) | Inherited config and the closed `SessionQueryError` taxonomy |
| [`src/filters.ts`](src/filters.ts) | Provider-independent predicates and the literal text scan |
| [`src/extraction.ts`](src/extraction.ts) | First-party semantic text extraction per event type |
| [`src/documents.ts`](src/documents.ts) | Surface-aware semantic document projection |
| [`src/tracing.ts`](src/tracing.ts) | One-shot session-lineage and event-relationship tracing |
| [`src/sources.ts`](src/sources.ts) | Immutable-header compatibility check |
| — | No runtime invariant companion is published; query results are immutable per-call projections whose lineage and event relations are validated while they are built; the service retains no observable result state. |

### Corpus resolution

`SessionCorpus` binds optional `ctx.sessionPersistence` through a fiber and resolves each read live-first: a known live target is snapshotted without consulting persistence; otherwise the session is listed, read completely through a short-lived read handle, and re-checked for a live attachment before cloning. A cold log whose writer crashed mid-turn is balanced in memory with `interruptedTurnClosers` — persistence is never mutated by a read. Header compatibility is asserted between listed and loaded observations. Batch title reads run one metadata listing and bounded-concurrency reads, isolating per-session failures while cancellation rejects the whole batch.

### Observation cache

`observeSession` builds point observations without a listing preflight. The cold path stats the stored session first and consults an own bounded cache keyed by the persistence instance and the `stat` revision: an unchanged revision reuses the restored unpublished Session without re-reading the log; a changed revision, or a replaced persistence instance, reloads through the handle seam and replaces the entry. The cache holds `preparedSessionCacheSize` entries with least-recently-used eviction, entries pinned by active observation leases are never evicted, and a session that goes live mid-read retries the live path.

### Reads and traces

`readSession` replays the log through `Session.create` to reuse resume's validation. `readSurface`, `listEvents`, and `traceEvent` share one `foldSurface` pass that classifies events as `current`, `shadowed`, or `log-only` and validates zero-based contiguous seqs, surface-marker eligibility, and replacement or citation integrity; any violation fails with `SESSION_QUERY_INVALID_SURFACE`. Traces are one-shot: session lineage reads the corpus once and walks parents and descendant trees deterministically, and event traces follow positional replacers to the final node while keeping cited-source links non-transitive.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared query vocabulary to the concrete backend and the decision evidence.

- [Session Query subsystem reference](../../../docs/subsystems/session-query.md) — the full type-level contract: records, filters, search pages, lineage, bounded reads, and errors.
- [dsh-session-query-sqlite](../session-query-sqlite/README.md) — the shipped full-text backend and its index lifecycle.
- [dsh-tool-session-query](../tool-session-query/README.md) — the model-facing consumer built on this service.
- [Session query relationship tracing](../../../.agents/notes/implemented/feature/2026-07-13-session-query-tracing.md) — trace semantics and the validation boundary.
- [SQLite FTS5 session search](../../../.agents/notes/implemented/feature/2026-07-10-sqlite-session-query-provider.md) — how the search surface is implemented and reconciled.

-----

<a id="model-experience"></a>
## Model Experience

None, as the trusted query service exposes cloned records only to callers and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this package is a poor fit or needs special operational care. They are current package constraints, not a task backlog.

- **No caller authorization** — this is trusted context-wide infrastructure; a model tool or UI must constrain which sessions its caller may inspect.
- **No provider coordinator or fallback** — the service is abstract over search, so a composition must mount a concrete backend; there is no search-provider registry or fallback implementation.
- **Exact reads replay whole logs** — `readSession`, `readSurface`, `filterEvents`, and event traces load and validate the complete logical log, so very large histories pay full inspection per call; `listSessions` stays lightweight.
- **Literal text scan, not full-text search** — the `text` filter scans extracted documents with a regular expression and does not rank; ranked search requires the mounted backend.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: extractor and search-provider registries

Recursive traversal through cited source events, extractor and search-provider registries, and additional model-facing surfaces are deferred; the [model-facing tools note](../../../.agents/notes/implemented/feature/2026-07-24-model-facing-session-query-tools.md) records the current consumer surface.

</details>
