# Agent Note: Bounded session persistence write batching

Status: implemented

English | [中文](2026-08-08-bounded-session-persistence-write-batching.zh.md)

## Problem

Streaming responses can emit many `assistant/chunk` events in a short interval. The persistence coordinator previously scheduled a provider append as soon as an idle queue received one event. Events arriving while that append was active shared a follow-up batch, but a fast provider could still produce many small durable appends. Each JSONL append creates and syncs a Zstandard frame or raw suffix.

Dropping chunk events or replacing them with assembled messages would reduce logical storage, but it would also change the event log, replay, sequence numbers, timestamps, and the chunk seqs cited by assistant messages. The write-amplification problem does not require that larger semantic change.

### Quantified baseline

Repository fixtures make the logical volume concrete. Decoding the current packed rows in [`goal-multi-turn-actions`](../../../../snapshots/web/goal-multi-turn-actions/session.jsonl) yields 2,098 events: 2,017 chunks (96.1%). Their unpacked JSONL lines occupy 332,647 of 379,225 event bytes (87.7%), while chunk packing reduces the committed file to 89,176 bytes and 182 storage rows, including 23 packed chunk rows. [`permission-policy-context`](../../../../snapshots/web/permission-policy-context/session.jsonl) yields 813 events: 746 chunks (91.8%) and 118,935 of 184,821 unpacked event bytes (64.4%); its packed file is 84,917 bytes and 123 storage rows, including 14 packed rows. These are tracked deterministic fixtures, not a production workload distribution, but they demonstrate why deleting chunks would reduce logical volume and why the existing packed-row layout already removes much of their JSON envelope cost.

JSONL writes one Zstandard frame and fsync per durable append batch. Runtime files do not record former append boundaries, so fixture row counts cannot honestly be presented as fsync counts.

The scheduling bound is deterministic. With an immediately resolving sink, the former immediate controller could issue one append for each event arriving after the previous append completed. A controller test admits 20 events 10 ms apart: the 200 ms fixed window hands all 20 to one append. This is a 20-to-1 reduction for that cadence, not a universal ratio. Sparse events, mandatory flushes, slow prior writes, and different arrival rates produce different batch sizes.

## Decision

The fixed window is the JSONL provider's constant `LIVE_WRITE_BATCH_MAX_DELAY_MS` (200 ms), an internal scheduling policy rather than configuration: the backend's own session listeners route live events by id into the active write handle's buffer, so batching never crosses the package boundary ([handle note](2026-08-27-handle-based-session-persistence.md)).

Each active write handle owns its buffer directly. A routed event lands in the handle's pending array, and the first event of an idle buffer arms one fixed timer. Later events join that batch without resetting the deadline: this is bounded coalescing, not debounce. When the deadline expires, a single-flight drain persists the pending prefix through the handle's mutation chain, which already serializes it against explicit appends. Events admitted during a drain pass coalesce into the next chained batch, in order.

The window bounds only the controller's intentional batching wait. Event-loop scheduling, initialization, an earlier serialized operation, and backend I/O can delay durable completion, so the option is not a hard fsync or crash-loss SLA.

`session/flush` cancels any remaining wait and becomes a shared quiescence barrier. It drains the active attempt and every event admitted while the barrier is running before it resolves. Session retirement (`session/disposed`), the handle's close, and backend teardown's close sweep use that same barrier, so lifecycle teardown never waits for the batching timer. The checkpoint policy continues to place mandatory barriers before model requests and top-level tool side effects.

Every event remains durable in its original order and shape. The controller copies each event on admission; no `assistant/chunk`, `seq`, `time`, surface metadata, or storage record is removed or rewritten. JSONL can therefore encode more events in one append frame without changing its on-disk format.

A failed background drain retains its complete batch in order ahead of newer pending events, reports the failure once, and pauses the automatic timer. The next explicit drain — a `session/flush` barrier, service-level `flush()`, or close — retries immediately and surfaces a repeated failure to its caller. This avoids a timer-driven failure loop while preserving the existing recoverable flush boundary.

This decision supersedes only the immediate scheduling cadence in [Collapse live persistence into one flush controller](../simplification/2026-07-23-collapse-persistence-flush-state.md). That note remains authoritative for one buffer owner per live Session, retained failed batches, retirement, and quiescent disposal. The coordinator and the separate write-behind controller that first hosted this behavior are deleted; the buffer, timer, and drain live on the provider's handle, and the [handle-based seam](2026-08-27-handle-based-session-persistence.md) owns the storage boundary they write through.

## Alternatives considered

**Do not persist streaming chunk events.** Rejected here: it changes the event-sourced authority and recovery semantics rather than only physical write cadence. The existing [assembled-message rejection](../../rejected/simplification/2026-06-20-assembled-assistant-messages-only.md) remains the guardrail until a no-information-loss replacement defines replay, fork, cited source-event links, sequence, and crash behavior independently. The [packed-row decision](2026-07-26-packed-chunk-rows-by-default.md) remains the complementary JSONL storage-size optimization.

**Write only at semantic checkpoints.** Rejected: it maximizes batching but makes the ordinary crash-loss window depend on a separately mounted policy. Bounded background writes preserve progress between checkpoints while mandatory flushes keep their stronger ordering contract.

**Debounce from the latest event.** Rejected: a continuously streaming response could postpone its first write indefinitely. A fixed window from the first pending event provides a real upper bound on intentional coalescing wait.

**A shared provider-neutral controller component.** Rejected after one iteration shipped it: the handle's mutation chain already serializes writes, so a separate controller duplicated that ordering machinery. Each provider implements the buffer on its own handle, and the shared live-write contract suite pins the equivalent observable behavior for any provider.

## Verification

The shared live-write contract suite (`runLiveWritePathContract`) uses a fake clock to prove the fixed, non-resetting 200 ms window; the `session/flush` barrier and its loud failure surfacing; ordered failure retention with exactly-once recovery; the service-level `flush()` sweep with per-session failure aggregation; and the disposed/close/teardown drains. The JSONL suite retains its storage-format, recovery, and shared persistence-contract coverage.

## Consequences

High-frequency event bursts normally produce fewer durable append operations while preserving the exact logical event count. The reduction depends on arrival rate and backend latency: a burst inside one 200 ms window becomes one batch, while mandatory flushes and sparse events can still produce small batches.

This decision does not cap pending event count or bytes behind a slow provider, and it does not reduce the decoded logical log. A demonstrated memory bound or logical-retention policy would require its own failure and replay contract rather than another hidden timer rule.

An admitted event can remain only in memory during the fixed window, and then while scheduling or backend work is outstanding. Explicit durability boundaries remain unchanged and bypass the wait.

The handle gives the timer, active drain, pending prefix, retry pause, and barrier one owner; the backend's listeners own routing and lifecycle-driven drains. `SESSION_FORMAT_VERSION` remains unchanged.
