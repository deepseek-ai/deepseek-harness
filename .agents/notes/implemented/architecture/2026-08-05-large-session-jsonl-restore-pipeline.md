# Agent Note: Large-session JSONL restore pipeline

Status: implemented

English | [中文](2026-08-05-large-session-jsonl-restore-pipeline.zh.md)

## Problem

Restoring a stored session activates it and materializes its complete authoritative event log before the agent can run. Large JSONL artifacts made that one-time operation pay several avoidable costs: each independent Zstandard frame created and closed a decoder context, decoded plaintext was accumulated and rescanned as whole-log buffers and strings, and freshly parsed events went through generic snapshot and deep-freeze paths designed for borrowed or cyclic values.

A representative profile contained 61.8 MiB of Zstandard data, 97.1 MiB of plaintext, and 1,307,073 events. The restore path must reduce its CPU and memory cost without weakening checksum validation, committed-region corruption detection, torn-tail recovery, sequence and surface validation, or the session log's immutability.

## Decision

Restoration is one ownership-transfer pipeline from the persistence artifact into `Session.fromRestore`. The compressed artifact remains the source buffer, while each decoding and scanning stage consumes the previous stage's output incrementally without retaining a whole-log plaintext or parsed copy; the resulting event array is the only complete decoded representation.

### Frame decoding

The structural Zstandard scanner identifies complete frame ranges before decoding. The dedicated first frame is decoded and parsed separately as the session header; subsequent plaintext frames are yielded in order into the JSONL scanner.

`ZstdFrameDecoder` gives the reader one lifecycle for interchangeable synchronous implementations. The preferred implementation probes the supported Node 22, 24, and 26 stream shape, reuses one private native decoder context and scratch buffer across all complete frames, and closes it once. If that private shape is unavailable, the factory selects a public `zstdDecompressSync` implementation with the same iterator and checksum-error contract. A yielded scratch view is consumed before the iterator advances.

After approximately 500 ms of accumulated frame work, the asynchronous reader yields at the next frame boundary and observes cancellation before continuing. A single frame remains an indivisible synchronous operation. Complete frames require end-of-frame and checksum validation; only a structurally incomplete final frame uses the existing prefix decoder for recovery.

### Incremental JSONL scanning

`SessionLogScanner` searches raw buffers with `Buffer.indexOf(0x0A)` and converts only complete records to UTF-8 for `JSON.parse`. It carries an incomplete record across decoder writes and copies only that fragment because the private decoder may reuse its output buffer. It does not build a whole plaintext buffer or string, a line array, or a second parsed-record array.

The scanner stops retaining events at the first unparsable row or sequence gap but continues inspecting later complete records. A later `turn/end` proves that the issue lies in the committed region and rejects the log. The Zstandard reader also rejects any unresolved parse, sequence, or partial-record issue after all complete frames; only a structurally torn final frame may contribute a recoverable suffix. Complete records emitted from that torn frame pass through the same scanner and retain the existing repair offset and recovered-event semantics.

### Restore admission

Persistence transfers freshly materialized current JSON values to `Session.fromRestore`. These values are detached, acyclic trees; historical packed rows and adjacent migrations have already produced newly allocated v2 settlements. The restore-only path validates the fixed event envelope with one `for...in` and `switch`, dispatches current-shape checks by event discriminant, and iteratively freezes the owned graph with an explicit `pending` array and no cycle-tracking set. Surface validation records one transition plan and commits that plan when the exact candidate enters the log instead of planning the same event twice.

Borrowed seeds used by ordinary creation and fork paths still take a JSON snapshot and use the generic cycle-safe deep freeze. The specialization therefore changes only durable restoration; it does not weaken acceptance for caller-owned values.

## Alternatives considered

- **One asynchronous native operation per frame** — rejected because dispatch and callback overhead dominates logs containing many small durable batches. Cooperative synchronous decoding pays that overhead only at periodic yield boundaries.
- **Process the complete log synchronously without yielding** — rejected because it prevents cancellation and event-loop progress for the full restore duration. Frame-boundary yields retain a bounded observation point without splitting codec operations.
- **Concatenate all plaintext before scanning** — rejected because it retains the compressed input, complete plaintext, whole-log UTF-8 string, line metadata, and parsed rows at the same time, and it rescans a torn-frame prefix.
- **Implement a streaming JSON parser** — rejected because JSONL already provides record boundaries; native newline search plus `JSON.parse` removes the large intermediates without owning another parser or changing JSON semantics.
- **Use a shared `WeakSet` while freezing restored events** — rejected because JSON materialization cannot produce cycles, and the set adds a lookup per object while retaining the complete graph during traversal.
- **Skip validation or freezing for restored values** — rejected because durable storage is a runtime boundary and Session read methods promise immutable accepted history. The optimized path specializes those operations around stronger ownership facts instead of removing them.

## Consequences

On the representative profile, incremental scanning reduced JSONL scan time from about 598 ms to 397 ms and peak RSS from about 1,494 MiB to 1,060 MiB. Restore admission reduced `Session.fromRestore` from 604–608 ms to about 263 ms, including an `assertSessionEventEnvelope` reduction from about 77 ms to 13 ms. These measurements characterize the optimization input rather than establish runtime limits.

The fast decoder depends on runtime-probed Node internals, but incompatibility selects the public implementation rather than changing correctness. Cancellation is observed around cooperative frame-boundary yields; the deadline is not a hard wall-clock bound inside one frame. The complete event array remains resident because it is the active session's authoritative log; the pipeline removes duplicate representations rather than paginating that state.

Tests force both decoder implementations, compare their frame order and corruption behavior, exercise cooperative cancellation and torn-tail recovery, and retain the existing session envelope, surface, and immutability contracts.
