# Agent Note: Linear drain for long-lived stream queues

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-28-linear-stream-queue-drain.zh.md)

## Problem

Long-lived stream queues can accumulate thousands of frames while their consumers are busy. Removing each frame with `Array.prototype.shift()` moves the remaining array range on the observed V8 path, so draining `N` queued frames performs quadratic reference movement and delays unrelated work on the same event loop. [Issue #3270](https://github.com/deepseek-harness/deepseek-harness/issues/3270) records the production sample that identified `ArrayShift`, `MoveRange`, and `memmove` as the dominant stack.

The affected streams have different wake-up, failure, cancellation, and disposal behavior. Their shared requirement is storage that preserves FIFO order without making those lifecycle decisions.

## Decision

`@deepseek-ai/dsh-deque` owns one zero-dependency circular array for Host and browser consumers. `pushBack()`, `pushFront()`, and `popFront()` change indices instead of moving the live range. A removal clears its slot immediately. The backing array doubles when full and halves when a non-empty deque reaches one quarter of capacity, so growth and compaction copy work remains amortized constant time and vacant storage stays bounded over interleaved queue use.

The package has no singleton state, symbols, or class identity shared between consumers. Each consumer constructs and confines its own deque, so duplicate npm copies preserve runtime behavior and the published dependency policy treats `Deque` as a safe Host export. The Client bundle purity rule also treats the package as an inline-safe library. The Gateway browser artifact carries its deque implementation without introducing a module-table entry or a Cordis service.

The Host Remote event source, each connected Client Remote event queue, the browser Remote stream inbox, each Session history follower, each Session control stream, and each Workspace follower store frames in this deque. Their owning classes retain all wake-up, failure, cancellation, buffered-drain, and disposal behavior. Session history uses front insertion to place constructor-seed events before live events received during its opening observation.

Queue capacity, frame coalescing, overload rejection, and global agent admission remain consumer or application policy. The deque does not infer any of them from storage pressure.

## Verification

The deque unit suite covers FIFO order, front insertion, array-boundary wrapping, geometric growth, quarter-full compaction after interleaved enqueue and dequeue, clearing, reuse, and `undefined` entries. Focused coverage reports 100% statements, branches, functions, and lines for `packages/util/deque/src/index.ts`.

The API Remote, Gateway, Session control/history, and Workspace follow suites exercise the migrated lifecycle behavior. They retain their package-owned ordering, failure, cancellation, and disposal assertions.

The command `pnpm exec tsx packages/util/deque/benchmarks/drain.ts` ran on Node v26.0.0, arm64 macOS 26.4. Five samples per size produced these median deque drain times; enqueue time is outside the measurement:

| Entries | Median drain | Nanoseconds per entry |
|---:|---:|---:|
| 250,000 | 1.705 ms | 6.818 ns |
| 500,000 | 2.541 ms | 5.082 ns |
| 1,000,000 | 4.668 ms | 4.668 ns |
| 2,000,000 | 9.656 ms | 4.828 ns |

The checked-in benchmark makes the measurement reproducible, but CI does not enforce a wall-clock threshold. Deterministic unit coverage owns the algorithm and compaction paths; the benchmark demonstrates approximately linear drain work on the recorded runtime.

## Alternatives considered

**Array head removal.** Keeping `shift()` preserves the smallest source diff but repeats the production failure mode and provides no amortized constant-time guarantee.

**A monotonic head cursor with occasional slicing.** This can provide amortized constant-time FIFO removal, but Session history also needs front insertion before concurrently buffered entries. A circular deque provides both operations through one storage rule without a special history prefix buffer.

**A linked deque.** Linked nodes make every end operation constant time and release removed nodes immediately, but each frame also allocates a node and pointer fields. The circular array keeps contiguous storage and amortizes the less frequent copies.

**An external deque dependency.** The required API is small, and the retention rule includes immediate slot clearing plus a specific shrink condition that the regression suite must exercise. A local zero-dependency utility keeps that storage lifecycle inspectable in both compiler faces; an external collection would still require the same integration and retention verification.

## Consequences

Draining a backlog performs linear deque work instead of quadratic array-range movement. Removed frame references become collectible before backing-storage compaction, and a stream that remains active does not retain every historical slot.

The repository owns a small generic collection implementation and its compatibility surface. Changes to its indexing, growth, or shrink rules require focused ordering and compaction coverage because every migrated stream shares the result.

Unbounded producers can still exhaust memory or delay consumers through the volume of legitimate per-frame work. Capacity and admission policy remain separate decisions rather than hidden behavior in a generic collection.
