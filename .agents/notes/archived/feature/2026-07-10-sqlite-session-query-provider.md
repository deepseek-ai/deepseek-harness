# Agent Note: SQLite FTS5 session search

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-10-sqlite-session-query-provider.zh.md)

## Problem

The exact-read `ctx.sessionQuery` service deliberately has no derived index. Large persisted histories need full-text search without scanning every event on every query, while current live sessions need an overlay newer than the last durability checkpoint. Search also needs concrete ranking, snippets, filters, pagination, cancellation, and rebuild behavior.

Splitting those concerns across a provider coordinator and a database implementation would create two coupled reconciliation state machines. The first implementation needs to own source observation, extraction, SQLite transactions, generations, and query execution as one lifecycle while still exposing a small provider-neutral call contract.

## Decision

`@deepseek-ai/dsh-session-query` declares one abstract `ctx.sessionQuery` service whose exact reads, filters, and traces are concrete and whose two full-text methods are abstract. `searchSessions(request, exec?)` returns cursor-paginated `SessionSearchHit`s grouped by each session's strongest matching event; `searchEvents(request, exec?)` returns `SessionEventSearchHit`s within one logical session. Both requests require `query`, accept `limit` and an owned branded `SessionSearchCursor`, and support an optional abort signal. Session search accepts `sessionFilters` plus event metadata filters; event search accepts event metadata filters. Results expose bounded plain-text snippets but no provider identifier or numeric relevance score. The [unified service decision](../../archived/architecture/2026-07-23-unified-session-query-service.md) owns the single-key topology.

`@deepseek-ai/dsh-session-query-sqlite` extends the interface service and is the sole concrete owner of `ctx.sessionQuery`. It depends on live `ctx.sessions`, observes optional `ctx.sessionPersistence` dynamically, and owns a dedicated derived SQLite database. There is no search-provider registry, coordinator, persistence event, or agent-loop integration.

The Service Definition package also owns shared first-party semantic extraction and provider-independent filtering. `SessionResultFilter` covers id, nullable cwd, created-at range, nullable parent, and availability; `ctx.sessionQuery.filterSessions()` applies it without an FTS provider. `SessionEventResultFilter` covers seq/time ranges, event type, surface, and literal semantic text. Arrays are ANDed and list values are ORed. The text clause escapes caller input into a Unicode case-insensitive regular expression whose whitespace runs match one or more whitespace characters; it is available through `ctx.sessionQuery.filterEvents()` and is not delegated to an FTS provider.

## Search semantics

Each semantic event is one FTS document carrying session metadata, event metadata, surface classification, and extracted text. All `current`, `shadowed`, and `log-only` documents participate unless a surface filter narrows them. Metadata filters compile to parameterized SQL before ranking. Session results partition matching documents by session and retain the strongest one.

Ordering is deterministic and comparable across the persistent and TEMP FTS tables: actual FTS5 highlighted-match span count descending, indexed document code-point length ascending, event time descending, session id ascending for the cross-session scope, and seq descending. Snippets use those actual highlight positions, strip the reserved markers, normalize whitespace, and bound by Unicode code points. Opaque cursors bind to the service instance, scope, canonical normalized request, offset, and relevant generation. Any corpus change invalidates cross-session cursors; a within-session cursor changes only when its target source/generation changes, so unrelated sessions do not invalidate it. Reopening creates a new service instance and invalidates old cursors.

Queries are trimmed, whitespace-normalized, and quoted as one literal FTS5 phrase. Embedded quotes are doubled before binding, so MATCH operators such as `OR`, `NEAR`, quotes, parentheses, and `*` remain data rather than executable query syntax. NUL is rejected before SQLite execution. Reserved highlight noncharacters and NUL in documents are normalized before indexing, making inserted presentation markers collision-free. Phrase matching follows tokenizer tokens rather than arbitrary substrings.

## Tokenizer choice

Both persistent and live FTS5 tables use `unicode61`. The implementation experiment found that this tokenizer supports the two-character token `AI` and produces an index about 2.1× smaller than the trigram alternative. The accepted limitation is token/phrase recall: `AI` does not match the larger token `BRAID`, and arbitrary substring search uses the provider-independent text scan instead.

## Extraction and reconciliation

The shared extractor includes message text, reasoning, nested tool-call/result content, tool names and arguments, blocked-prompt reasons, todo status/content, and error or terminal status detail. Structural boundaries, stream chunks, request headers, successful completion markers, and unknown declaration-merged event/content variants produce no document. Surface classification reuses `foldSurface()` so search agrees with model-history derivation.

One serialized operation reads the provider-neutral `SessionPersistence` snapshot listing, compares each source-qualified opaque revision with the revision stored beside the indexed session, loads only new or changed logs, reconciles rows in one transaction, and executes the query. It passes the caller's exact abort signal into snapshot listing and inspection, awaits each observer operation, and checks cancellation after each await and before starting more work. Already-current inspection keeps recovery in memory; a supported historical body read may first publish migration and repair. Cancellation settles this query observer without starting another observation or reconciliation step; a shared persistence load or migration already admitted for another observer may continue behind its per-id chain. The operation never calls the backend's mutating `load()` for an id currently owned by `ctx.sessions`; the TEMP overlay records persisted availability, and the durable base refreshes after the live owner detaches. A revision identifies its backing persistence store as well as the backend-local log revision, so reopening against the same store reuses indexed rows while switching to an independent store cannot collide on a session id and local counter. Observation repeats when listing changes during a load; this incorporates migration or mutating load repair's refreshed revision before commit. Repeated queries and unchanged reopen load no full persisted logs. New, changed, and deleted sessions update on the next stable search. A source or extraction failure cannot mark a row current, and a transaction failure rolls back so a later search retries.

Persisted documents survive restarts. Live sessions use connection-local TEMP tables, shadow the persisted base for the same id, and reveal that base on detach. Closing the database drops live rows. Unmounting persistence hides durable rows without treating absence as authoritative deletion; remounting observes and reconciles the backend again. Conflicting immutable live and durable headers fail rather than combining sources.

The derived schema has its own application id and monotonic schema version. Persistent and TEMP session metadata store the integer `SessionHeader.createdAt` contract in strict `INTEGER` columns. A recognized incompatible version resets only this derived database. A database with a foreign application id or unrecognized user tables is refused before journal-mode mutation, which prevents an accidentally configured canonical session database from being changed. On POSIX filesystems, missing directories and database files are created owner-only so new SQLite sidecars inherit that mode; existing modes are preserved. One service in one process exclusively owns a derived-index path; cross-process writers are unsupported because generations and live TEMP shadow state are connection-owned.

Cancellation rejects queued operations promptly. Once source observation starts, cancellation rejects the query observer without committing its result or starting more source/index work; persistence may keep a shared cold load or migration alive for another observer. Node's synchronous `DatabaseSync` metadata and MATCH calls cannot be interrupted once executing on the JavaScript thread, so the service checks the signal around those calls but does not promise mid-statement preemption.

## Alternatives considered

- **Add FTS tables to the canonical persistence database** — rejected because a rebuildable index must not share the authoritative log's schema, reset, or failure boundary.
- **Add a phase-one provider registry and coordinator** — rejected because one implementation provides no evidence for registration semantics and would split one reconciliation lifecycle across two owners.
- **Persist live overrides immediately** — rejected because live events are not canonical until the existing checkpoint commits.
- **Use the FTS5 trigram tokenizer** — rejected because it omits useful queries shorter than three characters and measured about 2.1× the index size of `unicode61`; literal substring filtering remains available through the scan path.
- **Use FTS5 BM25 independently in each table** — rejected because scores from differently populated persistent and TEMP corpora are not comparable; actual matched spans and document length have one shared scale.

## Consequences

Search has a small provider-neutral API while its only backend owns every derived-index state transition. The separate database adds configuration and a lightweight snapshot read before queries, but index corruption, reset, and tokenizer changes cannot endanger canonical logs. Durable revisions avoid full-log reads and rewrites for unchanged sessions; TEMP live overlays preserve current-session truth without making uncheckpointed events durable.

The chosen tokenizer supports short tokens with a smaller index but does not promise substring recall. Literal phrases make query syntax safe and predictable at the cost of excluding boolean/full MATCH expressions. Cancellation is prompt while queued and observer-local during shared source work; synchronous SQLite execution remains a non-preemptible section bracketed by signal checks.

Unit coverage pins extraction, filters, both search scopes, all default surfaces, metadata-before-ranking, snippets, literal escaping, deterministic ties, complete pagination, scoped cursor invalidation, dynamic persistence mount/unmount, restart reconciliation, live shadow/reveal/reopen, schema safety, rollback retry, and queued/in-flight source-wait cancellation. A keyless real-Loader-path test combines the derived SQLite index with the real JSONL persistence provider.
