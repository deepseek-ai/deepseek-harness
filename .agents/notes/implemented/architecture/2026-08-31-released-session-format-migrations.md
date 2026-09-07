# Agent Note: Released Session formats migrate through stateful streaming stages

Status: implemented

English | [中文](2026-08-31-released-session-format-migrations.zh.md)

## Problem

Session format v0 shipped in an alpha release, so a structural writer change can no longer treat existing JSONL as disposable pre-release state. The first whole-artifact migration implementation made those logs convertible, but its data model turned a 116 MB real Session into an operation that exhausted a 16 GB Node process before returning a handle.

### Whole-artifact performance failure

- Zstandard input was split into 317,540 frames and each frame used a separate asynchronous decompression call. The implementation retained every plaintext frame and then concatenated them before JSON parsing, creating the same number of Promise, thread-pool, and native decode transitions.
- Physical Decode materialized a complete plaintext Buffer, one complete string, every JSONL row, expanded source events, migrated target events, encoded target rows, a joined target string, and target physical Buffers at overlapping points in the same request.
- Every codec and migration edge called `snapshotSessionFormatJson()` or `snapshotSessionFormatArtifact()`. These operations detached, recursively copied, and deeply froze whole headers, rows, payloads, and event arrays before and after adjacent migrations.
- Released packed Assistant chunks expanded into about 9.14 million logical v0/v1 events before v1-to-v2 folded them into 72,784 current events. The whole-artifact API required both representations and the old-to-new sequence map to coexist.
- Encoding built the complete JSONL and compressed output in memory. The successful path then decoded the staged target, decoded the committed target, and decoded it again in persistence to construct the business object; it also reread the source for a full fingerprint comparison.
- Per-frame `await` calls did not provide useful bounded scheduling. The pre-migration reader instead reused one synchronous decoder and yielded from the outer loop about every 500 ms, avoiding hundreds of thousands of asynchronous transitions.

### The interfaces prevented local fixes from composing

`SessionFormatCodec` decoded and encoded complete arrays, each adjacent `SessionFormatMigration` accepted and returned a complete `SessionFormatArtifact`, and the compiled chain could only hand one materialized artifact to the next edge. A faster physical decoder therefore still encountered source-row arrays, expanded-event arrays, per-edge snapshots, and target-row arrays downstream.

The migrations are stateful even though the API presented them as one-shot functions. v0-to-v1 tracks message and retry identity. v1-to-v2 buffers one unsettled Assistant attempt, tracks events blocked behind it, and maintains old-to-new sequence references. Wrapping that state in closures or push/finish helper objects made the runtime structure different from the static declarations and made production, Worker verification, fixtures, and replay use different entry paths.

## Decision

The Session format packages use a stateful synchronous Stage API. Static migration declarations describe one adjacent version edge and create a new stage for each restored artifact. A stage owns that artifact's mutable state; no stage instance is shared across Sessions.

### Stage and Context protocol

```text
interface SessionFormatMigrationContext {
  emitEvent(event: SessionFormatEvent): void
  emitRun(run: SessionFormatEventRun): void
}

interface SessionFormatMigrationStage {
  readonly headerInheritedEventCount?: number
  transformEvent(
    event: SessionFormatEvent,
    context: SessionFormatMigrationContext,
  ): void
  transformRun(
    run: SessionFormatEventRun,
    context: SessionFormatMigrationContext,
  ): void
  finish(context: SessionFormatMigrationContext): number
}
```

`SessionFormatMigrationContext.emitEvent()` and `emitRun()` are synchronous. The producer declares whether it emits a scalar event or a compact run, so the hot path never infers the category from properties on a parsed file object. The caller owns scheduling and supplies the context to each operation instead of injecting a callback into the stage constructor. One input may emit zero, one, or many outputs without allocating a temporary return array or retaining an internal output queue.

`SessionFormatMigration` remains an immutable declaration: version numbers, header migration, target-header validation, and `createStage()`. `CompiledSessionFormatChain` validates a unique gap-free edge sequence once, creates per-artifact stages in source-to-target order, and connects them with context objects in reverse order. `finish()` settles stages in source-to-target order so each stage can emit its tail before the downstream stage closes.

```text
JSONL record
  → released physical row decoder
  → v0-to-v1 stage
  → v1-to-v2 stage
  → current event collector
```

The chain contains no `flatMap`, spread expansion, intermediate event array, or scheduler. The final event collector expands a compact run only after every migration stage has had the opportunity to consume it directly.

### Physical codecs and packed runs

Each released codec creates a row decoder with explicit `strict` or `recoverable` recovery. The decoder validates and emits one event or one codec-owned `SessionFormatEventRun` at a time through separate context methods. v0-to-v1 and v1-to-v2 implement both `transformEvent()` and `transformRun()`, so packed Assistant chunks can reach the folding edge without first becoming millions of ordinary events.

The v0-to-v1 edge preserves logical headers, sequence numbers, references, timestamps, and payloads except for bounded released-v0 normalizations. It translates the retired `steering/message` and `compact/*` event names, accepts a released `llm/retry` after its matching `step/end`, deterministically supplies a missing `llm/retry.retryId` per turn/step/provider/policy chain, and supplies one deterministic `compactionId` across a legacy compaction group that omitted it. The v1-to-v2 edge owns attempt folding and reference remapping, and emits only settled current events. It splits a legacy goal-sourced user message into `goal/change` plus the original model-visible message. It also inserts an interrupted `turn/end` for the bounded released restart in which an open turn with no open step is followed by a non-empty `next-turn` inbox splice and the next numbered `turn/start`.

The catalog exposes one `createRestore()` operation for production, Worker, fixture, and replay callers. Recovery policy and final validation policy are chosen once at restore creation. Historical production uses recoverable source parsing with transformed-current validation; this validates the released current result after migration, while input that is already current receives only codec validation. Worker and fixture verification use strict parsing with full installed current restoration. A migration-stage or transformed-current validation refusal remains `SessionFormatUnsupportedMigrationError`; physical decoding failures remain corruption. Test support keeps only fixture-specific token and envelope materialization.

### JSONL integration

The JSONL provider scans frame boundaries once, reuses one Zstandard decoder, parses complete JSONL records incrementally, and feeds rows directly into the catalog restore. The outer loop yields at a bounded cadence; there is no per-frame `await` and no complete plaintext or source-row array.

Current encoding is record based. The provider serializes about 1 MiB of plaintext per main-thread slice, streams it through one Zstandard context with source-error propagation, writes compressed output in 4 MiB batches to an exclusively created same-directory temporary file, and syncs it before publication. A process-wide scheduler admits at most two full verification Workers and hands a released permit directly to the oldest waiter.

Preparation forwards cancellation through source reads and observes it at the existing approximately 500 ms Decode yield boundary. Once `publish()` starts, encode, Worker verification, and publication do not receive caller cancellation and run to settlement; write open checks its caller signal again afterward. A published generation is never rolled back.

The Stage pipeline ends at one prepared current artifact. [Historical Session read preparation](2026-09-05-read-only-session-migration-preparation.md) defines how read open consumes that artifact immediately while write open performs encode, verification, and publication before returning append access.

### Durable format and publication rules

Canonical filenames encode physical format generation: v0 is `session.jsonl[.zstd]` and positive generations use `session.vN.jsonl[.zstd]`. Migration never moves, replaces, or deletes a committed generation and writes only the final current target; intermediate versions exist only as stage state.

POSIX publication uses hard-link creation plus directory sync. Windows uses no-overwrite, write-through `MoveFileExW`. An existing target is accepted only when its verified migration prefix equals the staged bytes; any append tail belongs to current-generation reading rather than migration winner verification.

Existing write handles retain the process-local claim and kernel-backed cross-process `SessionWriteLease`. Header-only `stat` and `list` translate supported historical headers without opening the body or publishing a generation. Projection-cache records bind their fold to the Session header's format version so a cache row cannot bypass a cardinality-changing migration.

## Problem-to-solution mapping

| Whole-artifact problem | Implemented mechanism | Result |
|---|---|---|
| One asynchronous decode call per Zstandard frame | One reusable decoder; outer 500 ms scheduling cadence | Removes 317,540 async transitions |
| Complete plaintext, string, and row arrays | Incremental JSONL parser and row decoder | Retains only one cross-chunk record fragment |
| Complete event array between every edge | Context-connected stateful stages | No intermediate version event arrays |
| Packed chunks expand before folding | `SessionFormatEventRun` plus `transformRun()` | 9.14 million source events need not materialize |
| Whole-artifact snapshot and deep freeze at every edge | Stage-owned exclusive values and final validation | Removes repeated recursive copy/freeze |
| One-shot migration functions hide state | Per-artifact stage classes from immutable declarations | State ownership and concurrency are explicit |
| Bulk current encode builds whole strings and Buffers | Record encoder, 1 MiB input slices, 4 MiB write batches | Bounds allocation and main-thread slices |
| Verification repeats on the main thread | At most two complete-generation Workers | Keeps verification CPU off the main thread |
| Production and fixture migration use different APIs | Catalog `createRestore()` with explicit policies | One decoder/chain implementation |

## Verification

### Benchmark input and meanings

The benchmark uses Node v24.18.0 and one 116,228,655-byte v0 Zstandard log containing 317,540 frames and 454,151 physical rows. The old reader restores 9,143,111 expanded v0 events. Migration produces 72,784 current v2 events with artifact SHA-256 `fa16ff9472ca350595a3112c20a3db79655bc2673973469987ecaf2a57ebd17c`.

Runs use built artifacts under plain Node, one process per sample, and a 16 GB V8 heap limit. “Retained heap” is measured after forced GC while the restored Session remains live. Values below are three-run medians except the whole-artifact failure, which consistently cannot reach a handle.

### Physical Decode

| Data path | Decode time | Peak RSS | Scheduling |
|---|---:|---:|---|
| Pre-migration optimized reader | 1.553s | 916MB | One decoder; 2–3 outer yields |
| Whole-artifact migration | 7.527s | 7,219MB | 317,540 async decoder calls |
| Streaming Stage path | 1.467s | 908MB | One decoder; 2 outer yields |

### Historical-file cold open

| Version | Time to restored Session | CPU time | Peak RSS | Retained heap | Restored events | Outcome |
|---|---:|---:|---:|---:|---:|---|
| Pre-migration high-performance v0 reader | 4.594s | 6.048s | 2.720GB | 2.016GB | 9,143,111 | Reads v0; does not migrate |
| Whole-artifact migration | >72.8s | — | ≥7.219GB during Decode | — | — | OOM before a handle |
| Streaming Stage migration with serial publication | 6.241s | 8.493s | 2.107GB | 477MB | 72,784 | Publishes and opens v2 |

The old reader has lower one-time wall time because it performs no format conversion or durable publication. It also keeps the 9.14-million-event representation live. The Stage path pays encode and verification once, then retains the folded v2 state.

### Current-format cold open

| Version reading its current format | Time to restored Session | Peak RSS | Retained heap |
|---|---:|---:|---:|
| Old reader on v0 | 4.594s | 2.720GB | 2.016GB |
| Whole-artifact-era reader on v2 | 1.273s | 1.107GB | 476MB |
| Streaming Stage reader on v2 | 1.284s | 1.109GB | 476MB |

The current-v2 fast path remains performance-equivalent. The architectural change does not route current data through historical stages.

### Streaming serial migration breakdown

This table records the serial open flow measured for this Stage decision. The current preparation-first scheduling and its measurements are owned by [Historical Session read preparation](2026-09-05-read-only-session-migration-preparation.md).

| Phase | Median |
|---|---:|
| Source Decode and migration | 2.784s |
| Encode, write, and sync | 0.956s |
| Full staged-file Worker verification | 1.415s |
| Source recheck and no-overwrite publication | 0.106s |
| Committed-prefix verification and header reopen | 0.046s |
| Generation ensure-current total | 5.318s |
| Final current decode observed by persistence | 0.620s |
| Session restoration | 0.594s |
| End-to-end restored Session | 6.241s |

The generation breakdown and end-to-end table come from separate instrumented runs, so rounded rows are not expected to sum exactly.

Format, catalog, edge, JSONL, fixture, replay, and built-Worker tests cover both encodings, packed runs, header-only classification, torn tails, migration refusal, deterministic legacy normalization, source changes, target collisions, write leases, and Worker failure.

## Consequences

At least one final current-event array remains necessary because Session restoration and Agent execution retain complete history. The Stage architecture removes full source and intermediate target arrays; it does not promise memory proportional to a page window.

Decoded scalar `assistant/chunk` rows receive envelope validation and final target validation, but their complete frozen-v1 source payload-member validation is deferred because that per-event check materially affects Decode and migration time on released logs. Packed Assistant runs remain strictly decoded. The scalar check must be restored only with performance evidence that preserves this migration path's measured behavior.

Read-only access consumes the Stage result before durable publication, while write open reuses the same result and waits for publication before append. The persistence scheduling remains independent from the format pipeline.

Lower generations remain for operator inspection. Retention does not promise downgrade compatibility, automatic fallback, or that an older runtime can safely interpret a newer generation.

## Alternatives considered

- **Optimize only Zstandard Decode** — restores physical Decode speed but leaves source rows, expanded events, snapshots, intermediate artifacts, and bulk encode in memory.
- **Synchronous Generator stages** — retain execution frames and batches at each yield. Real-log measurements increased migration time and migrate-complete RSS from about 1.0 GB to about 1.2 GB.
- **Return arrays from each stage** — preserves the old allocation, traversal, and flattening costs under a new name.
- **Give each stage an internal output queue** — adds drain, EOF, and error ownership while still retaining intermediate values.
- **Inject an emit callback through constructors** — forces reverse construction or a partially connected lifecycle. Passing a context to operations keeps stage construction independent of downstream wiring.
- **Share stateful codec instances globally** — would mix pending attempts, mappings, and counters across concurrent Session restores.
- **Persist every intermediate format version** — creates durable states with no runtime consumer; only the exact source and final current generation are needed.
- **Let mounted plugins register migrations** — makes historical readability deployment dependent. The static catalog must restore released formats before feature plugins mount.
