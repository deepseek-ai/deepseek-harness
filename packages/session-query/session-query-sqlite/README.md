---
description: "The SQLite FTS5 full-text search backend for session history, for deployments and maintainers choosing, configuring, or debugging full-text search over the query service."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-query-sqlite

English | [中文](README.zh.md)

## Summary

`dsh-session-query-sqlite` searches session history with a SQLite FTS5 index and returns ranked, cursor-paginated results grouped by session or within one session. Mount it together with `dsh-session-query` and you get full-text search plus the whole query surface — exact reads, filters, and traces — at once. Live sessions are indexed from memory and persisted sessions from a dedicated derived-index database, so results always reflect the newest state without touching the session-persistence store. Search is opt-in and off by default in shipped compositions: `openAt` decides whether the index opens at startup, at the first search, or never. Setup and usage come first; the implementation internals live in a collapsible developer section below.

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

Mount this package when a composition needs ranked full-text search over session history — for example the Web content search or `/resume` prior-work retrieval. The common path is explicit: mount the plugin, give it a dedicated database path, and call `ctx.sessionQuery.searchSessions` or `searchEvents` from code.

### When to choose it

Choose it when you want full-text recall over prior sessions with ranking and paging. Choose it together with `dsh-session-query` and the session service; a persistence backend is optional but recommended so persisted history is searchable after restarts. Avoid pointing `path` at the session-persistence database — this package owns a separate derived index.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-query-sqlite'
  config:
    path: /absolute/path/to/session-search.db
```

| Field | Default | Meaning |
|---|---|---|
| `path` | required | Dedicated derived-index SQLite path, or `:memory:`; missing paths are created owner-only on POSIX |
| `openAt` | `startup` | `startup` opens at activation; `first-search` defers the SQLite module until the first search; `never` disables full-text search while inherited reads stay available |
| `journalMode` | `wal` | `wal`, `delete`, `truncate`, or `persist` |
| `defaultLimit` | `20` | Page size when a request omits `limit` |
| `maxLimit` | `100` | Largest accepted request page size |
| `snippetChars` | `240` | Maximum snippet length in Unicode code points |
| `readWindowMax` | `50` | Maximum `before`/`after` raw events for the inherited `readEvent()` |
| `persistedInspectConcurrency` | `4` | Concurrent persisted-log inspections for inherited batch reads |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-query-sqlite) is the exhaustive source for every accepted field and its JSDoc.

### Search behavior

`searchSessions` searches the whole corpus and groups results by each session's strongest matching event; `searchEvents` searches one logical session. Queries are literal phrases: they are trimmed and whitespace-normalized, and FTS5 syntax such as quotes, `OR`, `NEAR`, and `*` is treated as data, never as executable query syntax. Metadata filters (session id, cwd, created-at, parent, availability, event seq/time/type/surface) narrow results before ranking. All `current`, `shadowed`, and `log-only` events are searchable by default; pass a surface filter to narrow.

Ranking is deterministic: more actual FTS5 highlighted-match spans first, then shorter documents, with event time, session id, and seq breaking ties. Results carry plain-text snippets bounded by `snippetChars` Unicode code points, with no provider-specific numeric score. Pages continue through an opaque `SessionSearchCursor` bound to the exact normalized request; a cursor becomes stale when its relevant corpus changes (`SESSION_QUERY_STALE_CURSOR`), and a within-session cursor survives changes to unrelated sessions while a cross-session cursor does not.

The `unicode61` tokenizer matches tokens and phrases, not arbitrary substrings: `AI` does not match the token `BRAID`. Use `ctx.sessionQuery.filterEvents()` with a `text` clause when a literal whitespace-flexible substring scan is required.

### When to defer or disable search

With `openAt: first-search`, the service activates without importing `node:sqlite` or opening the index, deferring SQLite's experimental warning until the first actual search; an invalid database fails that first search instead of service activation. With `openAt: never`, full-text search is off for the deployment: `searchSessions` and `searchEvents` fail with `SESSION_QUERY_SEARCH_DISABLED` before any request normalization, while every inherited exact read, filter, and trace keeps working. Requests that exceed the compiled-predicate budget (14 combined predicates across sessions, 13 within a session) or SQLite's portable 32,766-binding limit fail with `SESSION_QUERY_INVALID_FILTER` before statement preparation.

### Failures and recovery

Typed `SessionQueryError` failures carry stable codes: `SESSION_QUERY_SEARCH_DISABLED` when search is configured off; `SESSION_QUERY_INDEX_FAILED` when the index cannot open or reconcile; `SESSION_QUERY_SESSION_NOT_FOUND` when a search target is absent; `SESSION_QUERY_STALE_CURSOR` when the corpus changed between pages — retry the complete search call; and `SESSION_QUERY_INVALID_CURSOR` for a cursor that does not belong to this request. Cancellation is honored between synchronous SQLite calls; a statement already executing on the JavaScript thread cannot be interrupted.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the backend and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The backend is built on one separation and three commitments:

- **Derived index, never the source store.** The FTS rows live in a dedicated disposable database; the session-persistence database is never opened here.
- **Live-preferred observation.** One serialized state machine compares persistence snapshot revisions, inspects only new or changed logs, and reconciles in one transaction, so a search reflects the newest stable state.
- **Generation-bound cursors.** Every corpus change bumps a generation; cursors carry the generation they were created under and fail stale rather than returning a shifted page.
- **Literal phrases as data.** Caller query text is quoted into one FTS5 phrase so query syntax stays inert, and reserved highlight markers are stripped from documents before indexing.

The design history lives in the [SQLite FTS5 session search note](../../../.agents/notes/implemented/feature/2026-07-10-sqlite-session-query-provider.md) and the [unified service decision](../../../.agents/notes/archived/architecture/2026-07-23-unified-session-query-service.md).

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service: config, openAt lifecycle, serialized reconciliation, query execution, cursors |
| [`src/query.ts`](src/query.ts) | Request normalization, parameterized predicates, snippets, predicate and binding budgets |
| [`src/schema.ts`](src/schema.ts) | Database schema, application-id ownership, in-place reset, owner-only file creation |
| — | No runtime invariant companion is published; reconciliation, cursor generations, and derived-index ownership are validated at each serialized query boundary. |

### Index lifecycle

Persisted FTS rows live in a dedicated derived database and survive restarts; live sessions use connection-local TEMP tables that shadow the durable base for the same session and reveal it again when the live owner detaches. Each search runs one serialized observation: list persistence snapshots, compare per-session revisions with the indexed rows, inspect only new or changed logs, extract semantic documents, and commit the reconciliation in one transaction before running the query. Repeated queries and unchanged reopens inspect nothing; switching stores or observing new, changed, deleted, or externally repaired sources reconciles on the next stable observation. Source or transaction failure commits nothing and the next search retries.

### Schema ownership

The database carries an application id and schema version 8. Opening refuses a file owned by another application or a canonical database, rejects unknown user tables, and only a recognized incompatible derived schema resets in place — so an unrelated or session-persistence database is never touched. On POSIX filesystems, missing directories and database files are created owner-only (`0700` and `0600` before the process umask). Exactly one service in one process owns a derived-index path; generations and TEMP shadow state are connection-owned.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared query service to the type-level contract and the design evidence.

- [Session Query subsystem reference](../../../docs/subsystems/session-query.md) — the full type-level contract this backend implements.
- [dsh-session-query](../session-query/README.md) — the service definition: exact reads, filters, and traces this backend inherits.
- [dsh-tool-session-query](../tool-session-query/README.md) — the model-facing consumer that calls these search methods.
- [SQLite FTS5 session search](../../../.agents/notes/implemented/feature/2026-07-10-sqlite-session-query-provider.md) — search semantics, reconciliation, and the tokenizer decision.
- [JSONL session persistence](../../session/session-persistence-jsonl/README.md) — the authoritative Session store this disposable index observes; keep its root separate from this package's database path.

-----

<a id="model-experience"></a>
## Model Experience

None, as the search backend returns hits only to callers and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this package is a poor fit or needs special operational care. They are current package constraints, not a general SQLite comparison or a task backlog.

- **No caller authorization** — this is a trusted context-wide service; a model tool or UI must enforce its own access policy.
- **Synchronous query execution** — `DatabaseSync` blocks the JavaScript thread during MATCH execution and cannot interrupt a statement already running.
- **Token recall, not arbitrary substrings** — the `unicode61` tokenizer does not match substrings inside a larger token; use `filterEvents()` for literal scans.
- **Single-owner derived index** — one service in one process must own each index path; external writers and multi-process sharing are unsupported.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open design questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

#### Future: alternate tokenizers and search providers

The `unicode61` tokenizer choice trades substring recall for index size and two-character token support; the trigram alternative was measured and rejected. Switching tokenizers or adding another search backend would change indexed recall and require its own reconciliation and generation story.

</details>
