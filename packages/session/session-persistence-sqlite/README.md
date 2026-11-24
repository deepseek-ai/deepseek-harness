---
description: "Save and reopen Session histories in SQLite, import existing JSONL histories, and coordinate concurrent readers and writers."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-sqlite

English | [中文](README.zh.md)

## Summary

Save Session histories in SQLite and reopen them through the existing persistence API. Existing JSONL histories import on first open while their source files remain intact. Readers can share a database with an active writer; each Session permits one writer. Choose this provider explicitly: shipped profiles continue to use JSONL.

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

Replace the JSONL provider's package name in your composition, preserving its root and legacy encoding settings:

```yaml
- name: '@deepseek-ai/dsh-session-persistence-sqlite'
  config:
    root: './.sessions'
```

Fork creation drains a local parent writer, then references the persisted parent prefix and writes the events after `endSeq` into a new Segment in one transaction. Read opens and fork creation wait for a local parent's in-progress close to drain; a drain or flush failure stops creation. Later parent writes remain in the parent history. A prefix beyond the parent's persisted event count rejects creation; a failed transaction rolls back the child and releases its write lease. If routing publication fails after commit, the error reports that history remains stored and the Session can be reopened.

The database lives at `<root>/.segments/sessions.sqlite`. Application callers continue to use `ctx.sessionPersistence` and its Session handles.

| Field | Default | Meaning |
|---|---|---|
| `root` | Required | Storage root containing the database and any existing JSONL histories. |
| `compression` | `zstd` | Encoding of existing JSONL histories and of new SQLite frames: `zstd` stores a frame compressed when that is smaller, `none` stores JSON text. Stored frames decode by their own codec. |
| `listConcurrency` | `3` | Concurrent filesystem reads for legacy metadata and routing records. |
| `frameEvents` | `64` | Maximum events per stored frame, the unit of compression and of decoding. A write stores its batch in frames of at most this many events, and a frame holding fewer events and less than `min(64 KiB, 2 MiB / frameEvents)` of JSON text is stored uncompressed; when the Segment's newest frames that each hold fewer events reach this many together, the same transaction re-encodes them as frames of up to this many events. Each time short frames reach this many events, one append decodes and recompresses them synchronously inside its write transaction, which raises append tail latency. Larger frames compress a few percent better, cost more to decode for a tail read, and make each merge larger. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-session-persistence-sqlite) documents all accepted fields.

### Opening existing history

A first read or write open decodes the selected JSONL generation through its version migration chain, then imports the current logical history into SQLite. Import preserves metadata, event order, source coordinates and the inheritance marker. It creates an independent root Segment and retains the JSONL source bytes. The imported Session and its later events reopen through SQLite.

An active JSONL writer retains ownership until it closes. A SQLite read open waits for that ownership; a competing write open rejects. Cancellation or provider disposal stops the wait. After import, readers can open while the SQLite writer remains active. `stat()` and `list()` observe metadata without importing history.

### Durability and shutdown

Direct append, live Session events and durability checkpoints use the same handle. `flush()` drains pending events; writer close and provider disposal finish admitted writes before releasing ownership. An automatic write failure retains its pending batch and pauses automatic writes; the next explicit checkpoint retries and reports any remaining failure.

Concurrent writers share a transaction when their encoded batches are queued together. Each batch has its own savepoint: a batch-local failure rejects that batch while its peers commit, but an error that ends the transaction rejects the whole group. Routing publication follows commit and settles each batch independently. An unknown commit or rollback result makes the provider unusable until restart.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin supplies the existing persistence service and uses a JSONL provider in an isolated service context to read legacy histories. Import acquires the Session's artifact lease, commits its metadata and events in a database transaction, then records SQLite routing. A write open retains the lease through the handoff.

SQLite keeps thread metadata, predecessor-linked Segment metadata and frames: each durable write stores its batch, at most `frameEvents` events per frame, as JSON lines in one row keyed by Segment and start sequence, Zstandard-compressed under `compression: zstd` when that is smaller. A frame holding fewer than `frameEvents` events and less than `min(64 KiB, 2 MiB / frameEvents)` of JSON text is stored uncompressed, skipping compression that a merge would redo; a run of such frames always fits one merge. When a writer closes, each run of adjacent short frames in its tail Segment is rewritten into frames of up to `frameEvents` events under the configured compression, one transaction per run; this covers a Session that never gathers `frameEvents` events in its newest short frames and short frames that a full batch follows. A run above the merge limit stays as stored, and a seal failure is reported without failing the close. An imported history compresses its short final frame when it is written. Live writes usually hold a few events, so when the Segment's newest short frames reach `frameEvents` events together, the commit of that batch decodes them and replaces them with frames of up to `frameEvents` events inside the batch's savepoint; readers observe either the short frames or their replacement. One merge reads fewer than `3 * frameEvents` events and at most 4 MiB of decoded text; a run above that size stays as short frames. Its decoding and compression run inside the write transaction. A short frame that cannot be decoded rejects the append that would merge it. Frames are never updated in place. A Segment's event count is its last frame's end. Reads select the frames overlapping the requested range, decompress them on the thread pool eight at a time, and take only the covered slice; a missing frame, a frame shorter than its recorded range, an unknown codec, or undecodable bytes reject the read as storage corruption. WAL is enabled before schema publication so a concurrent reader cannot prevent the first mode switch. Journal-mode lock contention retries within the five-second busy budget before any schema or Session write; persistent contention and other failures are reported. The backend owns write queues, live-event buffering, transaction completion and handle cleanup; callers do not address Segments.

| Source | Responsibility |
|---|---|
| [persistence.ts](src/persistence.ts) | Service routing and durable JSONL takeover. |
| [migration.ts](src/migration.ts) | Import sequencing, ownership handoff and cancellation. |
| [sqlite.ts](src/sqlite.ts) | Database, Segment access, handles and durability. |
| [frame.ts](src/frame.ts) | Frame encoding: JSON lines stored as text or one Zstandard frame. |

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
- Several processes writing one storage root share one database write lock. A merge decodes and recompresses its short frames inside the append transaction, so another process's commit can wait for it; with four writer processes the measured append p99 rose from 21 ms to 63 ms. Writers in one process are not delayed by the lock, and a Host's in-process subagents are such writers.
- A short frame that becomes undecodable after a write open stops that Session's writes: the append that would merge it and every later append reject, and live events admitted but not yet committed are lost when the handle closes.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
