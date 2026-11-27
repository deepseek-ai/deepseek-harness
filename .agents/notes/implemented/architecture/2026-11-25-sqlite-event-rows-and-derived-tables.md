# Agent Note: SQLite event rows with derived tables

Status: implemented

English | [中文](2026-11-25-sqlite-event-rows-and-derived-tables.zh.md)

## Problem

The opt-in SQLite Session store kept each durable write as one frame: the batch's events as JSON lines, Zstandard-compressed, keyed by Segment and start sequence. A frame carries no per-event sequence, type, or time, so SQL cannot filter, count, or aggregate events; counting events by type means decoding every frame. Frames compress well only when they hold many events, and live writes carry a few, so matching JSONL's size needed a second step that merged short frames after the fact. That step rewrote stored rows, cost write latency, and was reverted.

Session listing, search, and statistics all read whole logs today. A store that already holds every event in a database should answer questions about events, token usage, tool calls, and compactions without a full read, and a forked Session's shared history must not make those answers wrong.

## Decision

`@deepseek-ai/dsh-session-persistence-sqlite` stores one row per event. The envelope members are columns: `seq`, `type`, `time`, `surface_op`, `source_seqs`, `ignorable`. Inline `data` is JSON text, or one Zstandard frame when its text is at least 1,024 characters and compression shrinks it; `codec` names which. The event and its envelope are immutable; the [cold tier](2026-11-26-sqlite-cold-sessions.md) can move its payload without changing the event row's identity.

`seq` is the Session sequence. A Segment's `base_seq` is its first sequence and therefore the cut in its parent. `segment_paths` holds, for each Segment, itself and every ancestor with the exclusive sequence up to which that member's events belong to its history. A trigger fills it when a Segment is inserted. The `session_*` views join Sessions to events through it, so SQL written against a Session never handles Segments.

Derived tables hold facts read out of events: `llm_calls`, `tool_calls`, `tool_results`, `compactions`. A `Derivation` declares one table, a version, the event types it reads, and a pure function from an event to a row. The store owns the key `(segment_id, seq)`, the per-Session view, and rebuilding. Rows are written in the events' transaction. No counter is stored on a Session: totals are sums through the views, so a fork that shares a prefix needs no copy and no correction. A table whose version changes, or whose derivation was absent for a while, is refilled from events through a cursor in `derivations`. Events are the only authority.

Opening a database runs the ordered upgrade steps in `src/migrations/`, one per schema version, inside the transaction that opens it. The step from version 1 is the only code that reads the frame layout. It rewrites the same file: the database is one artifact for every Session, so it has no per-Session generation to keep beside a successor, and the transaction leaves either the old layout or the new one.

## Measurements

Eighty real Sessions (84,456 events, 408.6 MB of event JSON) were replayed through the provider in batches of the size live writes had: one batch per 200 ms of event time, 12,692 commits. The machine was an Apple Silicon laptop running macOS and Node 24.21.0 with other work in progress; latencies are medians of five alternating runs, and sizes are of a checkpointed database.

| Store | Size |
|---|---:|
| Zstandard JSONL | 105.8 MB |
| Frames, at the 6.65 events per frame live writes produced | 109.7 MB |
| Event rows with derived tables | 157.6 MB |
| Event rows without compression | 442.4 MB |
| One uncompressed JSON text per event | 487.5 MB |

The events table is 96.5% of the row store, its two indexes 2.4%, and everything derived 1.1%. A full read of the largest Session takes the same time as with frames; the last 50 events take 0.35 ms against 1.05 ms; counting events by type across the store takes 10 ms against 1,278 ms. Per-Session token totals, tool counts, and compaction totals each answer in about 1 ms or less.

With one writer, an append plus flush has a median of 0.190 ms without derived tables and 0.226 ms with them. Deriving costs 0.10 µs of CPU per event; the added time is write volume, because each derived table touched by a commit dirties one more 4 KB page.

## Alternatives considered

- **Keep frames and merge short ones.** Rejected. It recovers JSONL's size but keeps events opaque to SQL, rewrites stored rows, and the measured merge raised append latency.
- **Plain JSON rows without compression.** Rejected. Every byte is readable by any SQLite client, at three times the size.
- **Compress every row, or use a trained dictionary.** Rejected for now. A threshold of 256 characters saves 3% and hides another 28% of rows from SQL JSON operators. A dictionary saved about 9% in an estimate, and its bytes would become part of the format; the per-row `codec` leaves room to add one without rewriting rows.
- **Write derived rows after the commit.** Built, measured, and removed. A second transaction per commit is a second synchronization, and the median append rose from 0.75 ms to 0.90 ms with four writers. Batching the deferral further saves little, because rebuilding from stored events costs 11 µs per event to read and decompress them again.
- **SQL triggers or generated columns for derived facts.** Rejected. A trigger runs in the same transaction, so it saves nothing, and it cannot read compressed `data`.
- **One generic derived table.** Rejected. It lowers pages written per commit from 14.3 to 12.1, and every query would filter on a kind column and read unnamed slots.
- **Counters on the Session row.** Rejected. A fork would have to copy and then correct them, and they would be a second authority beside events.
- **Keep SQL as strings in TypeScript.** Rejected. The schema could not be read or diffed per version, and an upgrade step silently followed the current schema constant.
- **Refuse databases of the frame layout.** Rejected. Two alpha releases wrote that layout.
- **Write a successor database file instead of rewriting in place.** Rejected. It doubles disk use during the upgrade and needs a publication step for the file swap and the routing records that name the database; one transaction gives the same all-or-nothing result, and the upgrade guide asks for a backup.
- **A separate read-model plugin with its own database, like the full-text query provider.** Rejected for these facts. It re-reads and decompresses every event the store just wrote, trails the log, and needs its own change detection; rows written beside their events need none of that. Full-text search stays in that separate provider because its index is large and optional.
- **Session projections as the owner of these facts.** Not replaced. Projections fold one Session's log in memory and remain the authority for what DSH displays, such as `tokenUsage`. They cannot answer across Sessions without opening each log, which is the question the tables serve.
- **A service through which other plugins register derivations.** Deferred. No plugin needs one yet, and `Derivation` stays internal until one does.

## Consequences

Events, token usage, tool calls, and compactions are queryable with ordinary SQL while DSH runs, per Session and across the store, and tail and point reads no longer decode a frame. The store is 44% larger than frames and 49% larger than JSONL on the measured corpus, and an append is about 0.04 ms slower at the median than without derived tables.

Another SQLite client cannot read `data` stored with `codec` 1 without a Zstandard function; every other column, the derived tables, and small events remain readable. Derived tables exist only under this provider, so a consumer that needs their facts under JSONL still folds the log.

The first open of a frame-layout database blocks the process while it rewrites every event, about four seconds per 100 MB, and earlier builds refuse the upgraded file. The file then holds both layouts until freed pages are reused. Damaged frames do not stop the upgrade: a frame's readable events are carried over, an undecodable row stands in for each sequence with no readable line, and the frame's bytes are kept in `frames_set_aside`, so a read fails afterwards exactly where it failed under frames. A version 1 child Segment that does not start where its parent ends stops the upgrade instead of receiving a history it never had, and a frame whose Segment row is absent is set aside like any other unreadable frame. Each schema version is a file, `resources/sql/schema/vN.sql`, that is not edited once a release has written it. An upgrade step names the file of the version it writes and keeps its statements under `resources/sql/upgrade/A-to-B/`, so adding version 3 adds a step module and files and edits none. A test checks that the first step reads only its own files and the version 2 schema, and that the database it leaves has the schema of a new one.

No service lets another plugin register a `Derivation`, and no setting turns the built-in tables off. Sessions still cannot be deleted, so shared history is never reclaimed.

An open that cannot use the database recovers rather than failing the whole Session service. An absent file becomes a new empty database, and a file this build cannot read is moved aside to `<name>.unreadable-<timestamp>`, where a new empty database takes its place: every stored byte survives and the Sessions stay available except for the ones the moved file holds. `recovery: report` keeps the earlier refusal for an operator who repairs storage by hand.

Only damage replaces a file. A lock that outlives the busy timeout is reported as `SESSION_STORAGE_LOCKED` on every platform, because SQLite holds its locks as operating-system locks that the kernel releases when a process exits: a surviving lock belongs to a live writer, and replacing its file would leave that writer appending to bytes no Session reads while the new database started empty. Windows cannot move a file another handle holds open at all, so a lock there could never be recovered that way; reporting it uniformly is the one rule that holds everywhere. A database whose schema is newer than this build is likewise never replaced, because its bytes are readable and only the release that wrote them can interpret them.

## Related

- [JSONL-only first-party Session persistence](../simplification/2026-08-30-jsonl-only-session-persistence.md) records why the earlier SQLite provider was removed. This provider returned later as an opt-in package; that note's requirement of an owner, a deployment need, and a format-transition policy applies to it, and the ordered upgrade steps are that policy for the physical schema.
- [SQLite physical chunk-row compression](../../archived/architecture/2026-08-18-sqlite-physical-chunk-row-compression.md) is the removed provider's layout, which packed runs of streamed chunks into one row. Chunks are no longer separate events, so one row per event no longer multiplies rows the way it did then.
- [Handle-based session persistence](2026-08-27-handle-based-session-persistence.md) defines the service this provider implements.
