# Agent Note: Collapse live persistence into one flush controller

Status: implemented

English | [中文](2026-07-23-collapse-persistence-flush-state.zh.md)

The [bounded write-batching decision](../architecture/2026-08-08-bounded-session-persistence-write-batching.md) supersedes this note's immediate scheduling cadence. The single-controller ownership, failure retention, per-id serialization, retirement, and quiescent-disposal decisions remain current.

## Problem

The persistence coordinator represented one live session's write lifecycle with separate buffer, initialization, and retirement containers plus the per-id operation chain. Those structures mirrored the same fact: whether that exact `Session` still had initialization or events that must settle before its state could be released. The checkpoint-only drain also kept every event volatile until another plugin requested `session/flush`, even though the backend could begin durability work without blocking the synchronous producer.

## Decision

Each live `Session` has one lifecycle entry containing initialization and one package-private write controller. The controller owns `pending`, the fixed batching timer, the optional active write, automatic-retry pause, and the shared flush barrier. A `session/event` listener copies the frozen event into `pending`; the first event starts a fixed deadline, and later events join without resetting it. A write takes one stable pending prefix; events admitted while it runs remain pending for a separately bounded follow-up batch.

`session/flush` is an immediate quiescence barrier. It waits for initialization, cancels the batching timer, joins any active attempt, and drains pending events, including events admitted while the barrier runs. A background failure is logged without rejecting the synchronous event producer, restores the complete ordered batch, and pauses automatic retry. A new event starts a fresh fixed window; explicit flush, retirement, or backend teardown retries immediately and surfaces a repeated failure.

Initialization now enters the existing per-id operation chain once and calls the unserialized core operations while it owns that turn. The chain remains separate from the live controller because detached public `create`/`append`/`load` calls can race without a `Session` object and still require identity-level serialization.

Crash repair is cold-only. For a live identity, `load(id)` snapshots the authoritative in-memory events before awaiting their flush, then returns them with `SessionState.meta`, the header actually used for durable writes; it rejects an open turn without reading or repairing storage. A cold load reserves its identity synchronously inside the per-id chain before awaiting current-prefix reads or repair writes; the `session/created` publication boundary rejects and rolls back a same-id live session until the reservation clears. HMR adoption reaches the current prefix through the same serialized backend path plus the coordinator's cwd check. It may publish a supported historical generation first, while adoption of current storage truncates a torn tail without closing the authoritative live turn.

The live-controller map is also the retirement registry. Successful retirement drains and removes its controller; failed retirement leaves it in the map. Backend teardown stops event admission, flushes every controller still present, awaits remaining per-id operations, and closes the backend. No separate retirement set is needed to rediscover unfinished work.

## Alternatives considered

**Keep checkpoint-only write-behind.** This can form larger batches, but makes durability depend on a separately mounted checkpoint policy and maximizes the crash-loss window between checkpoints. Bounded background scheduling still coalesces bursts and persists progress between mandatory barriers.

**Use one coordinator-wide flush promise.** The attachment pattern works for one file, but a global promise would serialize unrelated sessions. One controller per live session preserves independent backend progress while the per-id chain protects same-identity operations.

**Latch the first background error permanently.** This makes every later flush deterministic, but prevents the existing teardown retry from recovering a transient storage failure. Retaining the batch without latching the error preserves both observability and retry.

**Reject every live load.** This is safe but removes established balanced live snapshots used by persistence consumers and tests. Snapshot-before-flush gives the call a stable linearization point: successful flush proves exactly that snapshot is durable, while the live path never invokes crash repair.

## Verification

- Focused controller tests use a fake clock to prove the non-resetting fixed window, gate the first append, admit another event during that write, and observe an automatic second durable batch without calling `session/flush`.
- The shared coordinator contract still covers live adoption, collisions, crash repair, and Session/provider disposal over the in-memory reference and JSONL provider.
- Failure and teardown tests keep rejected batches pending, retry them before close, and prove an in-flight controller delays backend close.
- The shared backend contract persists an open live turn, proves `load` rejects without writing synthetic closers, completes and retires the owner, then reloads the exact completed turn.
- An AgentLoop regression races `resume()` against a live open turn and proves the original agent can still durably complete it without an injected `interrupted` boundary.
- A controlled backend blocks `loadStored`, attempts same-id session publication while repair owns the reservation, and proves rollback leaves no ghost controller before a balanced resume succeeds.
- The ownerless-claim contract gives the live `Session` a different `createdAt`, then proves live and later cold loads both return the original stored header.

## Consequences

The live-session entry keeps initialization beside one controller for pending events, its timer, active write, retry pause, and flush barrier. Separate coordinator containers retain persisted identity state, prepared cold Sessions, retiring identity waiters, and per-id operation chains because those lifecycles also exist without one writable live Session. Bounded writes reduce the ordinary crash-loss window and produce fewer backend batches than immediate scheduling, while mandatory barriers remain unchanged.

`session/flush` no longer chooses when ordinary persistence begins. It remains the ordering and error-observation boundary used by the loop and checkpoint policy, so a successful checkpoint still means every event admitted before its completion is durable.
