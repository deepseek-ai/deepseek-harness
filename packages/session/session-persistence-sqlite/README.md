---
description: "Save and reopen Session histories in SQLite as one row per event, query them with SQL, import existing JSONL histories, and coordinate concurrent readers and writers."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-sqlite

English | [中文](README.zh.md)

## Summary

Save Session histories in SQLite and reopen them through the existing persistence API. Each event is one row whose sequence, type and time are columns, so the database also answers SQL questions about events, token usage, tool calls and compactions. Existing JSONL histories import on first open while their source files remain intact. Readers can share a database with an active writer; each Session permits one writer. Choose this provider explicitly: shipped profiles continue to use JSONL.

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

Mount this provider for the storage root whose Sessions should use SQLite.

### Minimal configuration

Disable the default JSONL provider in your profile patch or `--patch` overlay and insert the SQLite provider with the same storage root:

```yaml
- id: session-persistence-jsonl
  disabled: true

- insert:
    - id: session-persistence-sqlite
      name: '@deepseek-ai/dsh-session-persistence-sqlite'
      config:
        root: !!js dshHomePath('sessions')
```

Fork creation drains a local parent writer, then references the persisted parent prefix and writes the events after `endSeq` into a new Segment in one transaction. Read opens and fork creation wait for a local parent's in-progress close to drain; a drain or flush failure stops creation. Later parent writes remain in the parent history. A prefix beyond the parent's persisted event count rejects creation; a failed transaction rolls back the child and releases its write lease. If routing publication fails after commit, the error reports that history remains stored and the Session can be reopened.

The database lives at `<root>/.segments/sessions.sqlite`. Application callers continue to use `ctx.sessionPersistence` and its Session handles.

| Field | Default | Meaning |
|---|---|---|
| `root` | Required | Storage root containing the database and any existing JSONL histories. |
| `compression` | `zstd` | Encoding of existing JSONL histories and of new event rows: `zstd` compresses a large event `data` when that is smaller, `none` stores JSON text. Stored rows decode by their own codec. |
| `listConcurrency` | `3` | Concurrent filesystem reads for legacy metadata and routing records. |
| `recovery` | `replace` | What an open does when the database is damaged. `replace` moves the damaged file aside and starts an empty database, so Sessions stay available and the bytes remain readable; `report` refuses and leaves the storage root for repair. A lock is never damage and is always reported. |
| `coldAfterDays` | `30` | Archive Sessions idle for this many whole days, or `0` to disable archiving. Disabling stops new archives and does not prevent reopening existing archives. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-persistence-sqlite) documents all accepted fields.

### Query the database

Open `<root>/.segments/sessions.sqlite` read-only with any SQLite 3.38 or later client while DSH runs. Query the `session_*` views: a forked Session shares its parent's earlier events, and the views return each Session's complete history with that sharing resolved.

| View | One row per | Columns beyond `session_id` |
|---|---|---|
| `session_summary` | Session | `created_at`, `cwd`, `parent_session`, `origin`, `agent_preset`, `inherited_count`, `event_count`, `last_event_time` |
| `session_events` | event | `seq`, `type`, `time`, `surface_op`, `source_seqs`, `ignorable`, `codec`, `data`, `event_no` |
| `session_llm_calls` | model call that reported usage | `seq`, `time`, `provider`, `model`, `turn`, `step`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens` |
| `session_tools` | tool call, with its result when stored | `seq`, `time`, `tool`, `turn`, `step`, `result_seq`, `is_error`, `error_code`, `duration_ms` |
| `session_tool_calls` | tool call | `seq`, `time`, `tool`, `turn`, `step` |
| `session_tool_results` | tool result | `seq`, `time`, `call_seq` (NULL for a result that replaces an earlier one), `is_error`, `error_code` |
| `session_compactions` | prune or summary | `seq`, `time`, `kind`, `shadowed_tokens`, `shadowed_start`, `shadowed_end` |

Every view except `session_summary` and `session_tools` also returns `segment_id`, the Segment that stores the row.

```sql
SELECT tool, count(*) AS calls, sum(is_error) AS errors FROM session_tools WHERE session_id = ? GROUP BY tool;
SELECT sum(input_tokens), sum(output_tokens) FROM session_llm_calls WHERE session_id = ?;
SELECT seq, data ->> 'model' FROM session_events WHERE session_id = ? AND type = 'model/selection' AND codec = 0;
```

Times are Unix milliseconds. `data` is JSON text when `codec` is `0`, which SQLite's JSON operators read directly, and Zstandard bytes when `codec` is `1`. A database upgraded from a damaged frame layout also holds `codec` `255` rows: `type` is `storage/unreadable` and `data` is an empty blob, one row per sequence whose stored bytes could not be decoded. These rows keep the Segment's event count, appear in `session_events`, and count in `session_summary.event_count`; reading the Session that holds one fails as storage corruption. A stored value of at least 1,024 characters is compressed whenever compression shrinks it, so the largest events are the ones JSON operators cannot read: `SELECT` a `data ->> ...` expression from a filtered query, because one compressed row in the result raises `malformed JSON` and fails the whole statement. Add `AND codec = 0` to skip them, or use a derived table. The tables `llm_calls`, `tool_calls`, `tool_results` and `compactions` hold each stored event once, so use them for totals across the whole store; summing a `session_*` view over all Sessions counts a shared event once per Session that inherits it. Token columns are the usage each call reported; the `tokenUsage` projection remains the figure DSH displays.

The first open of a new or upgraded database analyzes it once, and each close refreshes the statistics of the tables that changed. Without them SQLite reads every result in a Segment for each tool call instead of seeking the derived index: on a store of 84,000 tool calls, `session_tools` takes 2.3 s before the analysis and 22 ms after it.

### Opening existing history

A first read or write open decodes the selected JSONL generation through its version migration chain, then imports the current logical history into SQLite. Import preserves metadata, event order, source coordinates and the inheritance marker. It creates an independent root Segment and retains the JSONL source bytes. The imported Session and its later events reopen through SQLite.

An active JSONL writer retains ownership until it closes. A SQLite read open waits for that ownership; a competing write open rejects. Cancellation or provider disposal stops the wait. After import, readers can open while the SQLite writer remains active. `stat()` and `list()` observe metadata without importing history.

<a id="archiving-idle-sessions"></a>
### Archiving idle Sessions

When `coldAfterDays` is positive (30 days by default), a background pass starts after the database opens and repeats hourly. It uses the newest of the Session creation time, last event time, and tracked open time. The provider records creation and opens while archiving is enabled, updating an open watermark at most once per hour per Session. Sessions with shared SQLite fork history, sessions with set-aside unreadable events, sessions without events, and logs above 256 MiB of JSONL stay inline.

The provider writes one Zstandard level-12 JSONL frame per archived Session under `<root>/.segments/sessions.sqlite.cold/`. These private files do not replace imported JSONL generations, and `recovery: replace` moves the archive directory aside with a damaged database. The database keeps Session metadata, event envelopes (`codec` 254 with an empty `data` blob), and existing derived rows. Either read or write open restores the payloads into SQLite before returning a handle, and forking a positive prefix from an archived Session restores and pins its parent Segment inline; `stat()`, `list()`, and SQL queries over envelopes or derived tables do not restore them. A read handle already open in another process can read the archive without restoring it. A missing or damaged archive refuses the open rather than returning older JSONL history.

Back up the SQLite database and its archive directory together with all writers stopped. An archive releases pages for reuse but does not shrink the SQLite file. To return that space to the filesystem, use [explicit compaction](#compact-the-store).

<a id="compact-the-store"></a>
### Compact the store

Archiving frees pages inside `sessions.sqlite` for later writes to reuse without shrinking the file on disk. To return unused pages to the filesystem, stop every DSH process using the storage root and run `sqlite3 <root>/.segments/sessions.sqlite 'VACUUM;'` when the volume has room for a database rewrite; cold archives are untouched.

The provider also carries an internal worker-backed `compactStorage()` method (`VACUUM` plus `PRAGMA wal_checkpoint(TRUNCATE)` while local writes wait) rather than exposing it on `ctx.sessionPersistence`; see the [cold-storage decision record](../../../.agents/notes/implemented/architecture/2026-11-26-sqlite-cold-sessions.md) for the rationale.

### Durability and shutdown

Direct append, live Session events and durability checkpoints use the same handle. `flush()` drains pending events; writer close and provider disposal finish admitted writes before releasing ownership. An automatic write failure retains its pending batch and pauses automatic writes; the next explicit checkpoint retries and reports any remaining failure.

Concurrent writers share a transaction when their encoded batches are queued together. Each batch has its own savepoint: a batch-local failure rejects that batch while its peers commit, but an error that ends the transaction rejects the whole group. Routing publication follows commit and settles each batch independently. An unknown commit or rollback result makes the provider unusable until restart.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin supplies the existing persistence service and uses a JSONL provider in an isolated service context to read legacy histories. Import acquires the Session's artifact lease, commits its metadata and events in a database transaction, then records SQLite routing. A write open retains the lease through the handoff.

SQLite keeps Session metadata, predecessor-linked Segment metadata and events. `sessions` holds each header as JSON with its fields as generated columns, which are NULL for a header that is damaged. `segments` records each Segment's parent and `base_seq`, the Session sequence of its first event and therefore the cut in its parent. `segment_paths` lists, for every Segment, itself and each ancestor with the exclusive sequence up to which that member's events belong to the Segment's history; a trigger fills it when a Segment is inserted, so reads and views need no recursion. `events` holds one row per event keyed by `(segment_id, seq)`, where `seq` is the Session sequence. A Segment's event count is one past its last row's sequence. Reads select each Segment range by that key and decode rows on the JavaScript thread, yielding between groups of events; a missing row, an unknown codec, undecodable bytes or an invalid event rejects the read as storage corruption. Triggers refuse event deletes and ancestry changes and allow payload changes only when moving between inline and cold storage. The views `segment_extents` and `session_heads` are internal to the provider: its statements read each Segment's event count and the Segment each Session's `head_segment_id` names through them.

Derived tables are filled from events and never read by the provider. Each `Derivation` declares one table keyed by `(segment_id, seq)`, the event types it reads, and a pure function from an event to a row; the store adds the `session_<name>` view. `derivations` records each table's version and, while a table is behind, the `event_no` it has reached. A table that is missing, whose stored version differs from its derivation, or that is added to a store that already holds events such as an upgraded one, is dropped and refilled from events in bounded transactions after open. A stored table whose derivation this build does not hold is kept and marked behind from that point, so it catches up when its derivation returns. A derivation that throws, or a row its table refuses, skips that row and never fails the append; the first such failure of each table logs a warning that names the event. A failure that ends the transaction fails the append with its events.

Opening a database runs the ordered upgrade steps in [migrations/](src/migrations/index.ts): each step upgrades the stored schema by one version inside the transaction that opens the database, so a failed step leaves the file unchanged. The step from version 1 rewrites the earlier frame layout as event rows, carrying over Segment identities, ancestry and inherited counts; it copies each event by its envelope, so an event type the build does not know is upgraded and judged when its Session is read. A frame that holds an unreadable event is logged and copied unchanged into `frames_set_aside`; a row that no reader decodes stands in for each such event, or for the whole frame when its bytes cannot be split into events, so a read fails after the upgrade exactly where it failed before and every other Session upgrades. The provider logs each step before it runs, because a step blocks the process while it rewrites the database. A step that fails rejects the open with `SESSION_STORAGE_UPGRADE`, and the provider does not retry it until restart. A foreign database, a version newer than this build, or a database without the current tables is refused with `SESSION_STORAGE_FORMAT`.

WAL is enabled before schema publication so a concurrent reader cannot prevent the first mode switch. Journal-mode lock contention retries within the five-second busy budget before any schema or Session write; persistent contention and other failures are reported. The backend owns write queues, live-event buffering, transaction completion and handle cleanup; callers do not address Segments.

| Source | Responsibility |
|---|---|
| [persistence.ts](src/persistence.ts) | Service routing and durable JSONL takeover. |
| [migration.ts](src/migration.ts) | Import sequencing, ownership handoff and cancellation. |
| [sqlite.ts](src/sqlite.ts) | Database, Segment access, handles and durability. |
| [schema.ts](src/schema.ts) | The current schema version, the application id, and the tables every current database holds. |
| [resources/sql/](resources/sql/schema/v3.sql) | Static SQL, including versioned schema scripts and queries for event, derived and cold storage. Released schema scripts and upgrade statements are immutable. |
| [sql.ts](src/sql.ts) | The only reader of `resources/sql/`: the closed list of file names and their text. |
| [migrations/](src/migrations/index.ts) | Opening a database: creation, the ordered upgrade steps and refusals; one module per retired layout, which reads only its own `upgrade/` files and the schema file of the version it writes. |
| [row.ts](src/row.ts) | Event row encoding: envelope columns and `data` as JSON text or one Zstandard frame. |
| [cold.ts](src/cold.ts) | Whole-Session Zstandard level-12 JSONL archive publication and verification. |
| [vacuum.ts](src/vacuum.ts), [worker.ts](src/worker.ts) | Explicit `VACUUM` and WAL truncation on an isolated worker connection. |
| [derive.ts](src/derive.ts) | Derived tables: the `Derivation` interface, writes beside events, and rebuilding from events. |
| [derivations.ts](src/derivations.ts) | The built-in derivations and the event members they read. |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Session persistence](../session-persistence/README.md) — the shared service and handle semantics.
- [JSONL persistence](../session-persistence-jsonl/README.md) — physical generations and version migration.
- [Persistence subsystem](../../../docs/subsystems/persistence.md) — recovery and consumer-facing APIs.

-----

<a id="model-experience"></a>
## Model Experience

### Restored history

#### What the model sees

This provider adds no prompt or tool schema. Restored `user/message` and `assistant/message` events supply the same conversation history; the Session consumer owns interrupted-turn repair.

#### Token effect

Storage adds no tokens. Restored history has its usual conversation cost.

#### KV Cache effect

Storage preserves event order and does not rewrite model request prefixes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These constraints apply when selecting this provider.

- The first legacy read open writes the SQLite database and requires write access to the storage root.
- Retained JSONL files contain the imported prefix and exclude later SQLite events; they cannot restore the latest history on their own.
- All processes writing imported Sessions must use the SQLite provider.
- SQLite accepts the current Session format; a future event-format upgrade needs its own SQLite history migration.
- Other SQL clients cannot read `data` stored with `codec` 1 without a Zstandard function; every other column, the derived tables and small events remain readable.
- The derived tables are the built-in four: no setting turns them off, and no service registers a `Derivation` from another plugin.
- Processes of different builds must not write one database at the same time. An earlier build fails once a later one upgrades the schema. A derived table is caught up when a build that holds its derivation opens the database; if a process of a build without that derivation is still running then and appends afterwards, the rows of those events are missing until the table's version changes.
- An open that meets another process's write lock, such as a running upgrade, blocks its process for the five-second busy timeout and then fails with `SESSION_STORAGE_LOCKED`, on every platform. SQLite releases its locks when a process exits, so a lock that outlives the timeout belongs to a live writer; replacing its file would leave that writer appending to bytes no Session reads. Close the other process and reopen.
- Recovery moves a damaged database aside instead of deleting it, so a storage root keeps one full copy per recovery. Remove an `*.unreadable-*` file once its Sessions are no longer needed.
- Sessions cannot be deleted, so storage shared between forks is never reclaimed.
- Restoring an archived Session commits all payloads in one transaction, so a partial restore cannot occur.
- Full-text Session search needs a durable index `path`; with `:memory:` the index rebuilds at startup and reopens every indexed cold Session.
- A new or rebuilt derived table cannot derive rows from archived payloads until those Sessions reopen.
- Unreferenced archives left by an interrupted process are not removed automatically.
- Online store compaction (`compactStorage()`) is internal to this provider rather than on `SessionPersistence`, because no other persistence backend requires `VACUUM`-style space reclamation and no external trigger invokes it.
- Each event with a large `data` leaves part of its last page unused: 12.8% of the store at 4 KiB pages, which a 16 KiB page reduces to 12.2%.
- The store is larger than the frame layout because each event is compressed on its own. Measured on a 242,523-event corpus, 294.3 MB stored against 186.7 MB for frames; recompressing the same events in groups of 64 gives 183.8 MB. Sharing a compression context therefore recovers the whole difference, but it makes a single-event read decode its whole group: 19× slower for the point reads a live Session makes. The row layout keeps those reads fast, and the [decision record](../../../.agents/notes/implemented/architecture/2026-11-25-sqlite-event-rows-and-derived-tables.md) holds the numbers.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
