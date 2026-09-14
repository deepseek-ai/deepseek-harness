# Agent Note: Remove synthetic turns for log-only events

Status: implemented

English | [中文](2026-07-28-remove-synthetic-log-only-turns.zh.md)

## Problem

The session store exposed `appendOutOfBand()` so a plugin could publish a late log-only event while no agent turn was running. The method wrapped that event in `turn/start` and `turn/end`, then flushed it. This preserved the old rule that every durable event had to live inside a turn, but it made one identifier mean both a model-loop execution and a persistence-only update.

That rule was introduced when persistence recovery treated the last `turn/end` as the only committed boundary. The persistence scanners now preserve every valid contiguous event, and crash repair reacts only to an actually open turn. Retaining synthetic turns for title updates therefore inflated turn counts, produced execution outcomes for work that never ran the model, and let a late metadata write consume the next turn number.

The generic helper also duplicated domain policy. Its marker map said which plugin events were eligible, while the title capability already owned cancellation, liveness, and stale-result rules. Replacing it with another generic or title-specific append wrapper would preserve the same type indirection for two literal event types.

## Decision

`SessionStore.appendOutOfBand()`, `OutOfBandSessionEventMap`, and `OutOfBandSessionEventType` do not exist. A plugin that owns a log-only event appends it through `Session`; when the operation promises durability, it explicitly awaits `ctx.sessions.flush(session)`. No turn is opened solely to obtain that checkpoint.

Core session invariants continue to enforce core-owned execution relations: turn and step numbering, enclosure of steering, assistant, tool, todo, and request-header events, and same-step tool call/result pairing. Core permits merge-extensible events between turns because only their declaring plugin knows whether they are execution-scoped or standalone. Plugin invariant companions remain responsible for their own event relations.

The title service appends `session/title` directly after its existing service, revision, cancellation, and live-session checks. The bundled model helper appends its literal `session/title-llm-request` record before dispatch. Persistence admits both through the bounded `session/event` path and drains them at ordinary checkpoints and lifecycle teardown; neither append forces a flush merely because it is between turns. A fallback, auxiliary request record, or accepted provider title may therefore appear after `turn/end` and before the next `turn/start`. Manual compaction uses the same between-turn capability for a `compaction/* { turn: null }` bracket, but explicitly flushes the closed attempt because `/compact` promises durability before releasing queued prompt admission.

`SessionStore.fork()` may end at any stable event position outside an open turn, not only at `turn/end`. This preserves standalone title and other plugin-owned log-only records in a default store fork while still rejecting a prefix cut through active execution. The [Session Controller fork decision](../bug-fix/2026-09-11-session-controller-fork-turn-cut.md) limits its completed-turn operation to the selected closing event.

The historical [universal turn-enclosure decision](../../archived/architecture/2026-06-15-turn-enclosure-invariant.md) remains useful only as the reason the synthetic mechanism was introduced. The [context-injection decision](../architecture/2026-07-24-separate-context-injection-from-turn-execution.md) established the current meaning: one turn represents one model-loop execution. The [queued manual compaction decision](../feature/2026-07-30-queued-manual-compaction.md) applies that rule to a durable multi-event bracket and owns its marker and admission semantics.

## Alternatives considered

**Keep synthetic zero-step turns.** This preserves a uniform-looking log and reuses `turn/end` as a flush point, but it reports executions that never happened, perturbs turn numbering, and makes every turn consumer filter persistence-only records. Durability already has the independent `session/flush` boundary.

**Keep a generic core durable-append helper without synthetic turns.** A method that performs `append()` plus `flush()` is small, but its eligibility marker and concurrency promises would still centralize plugin policy in the session store. The event owners already have literal typed append sites, and a caller that truly needs a durability barrier can await the existing `session/flush` operation at that boundary.

**Store titles as mutable session metadata.** This avoids between-turn events but creates a second mutation, replay, persistence, and fork protocol beside the append-only log. Titles remain replayable latest-wins events instead.

**Require every plugin event to declare standalone eligibility to core.** This keeps a central allowlist but makes absence mean an execution relation that core cannot verify. Merge-extensible unions already assign semantic ownership to the declaring plugin; its invariant companion is the correct enforcement point.

## Verification

Core invariant tests accept an unknown plugin event between turns while continuing to reject built-in execution events there. Hook, plan-mode, PTC mode dispatch, and approval invariant companions reject their execution-scoped events when no turn is open; the compaction companion separately accepts a balanced `turn: null` manual bracket between turns and requires numeric owners to match an open turn. Session-title service tests pin one direct fallback event under concurrent refresh, detached-session rejection, and newest-revision acceptance. A JSONL round trip preserves a title appended after `turn/end` through the persistence lifecycle drain, and fork tests retain a standalone log-only tail while rejecting boundaries inside an open turn. A keyless assembled ACP snapshot delays the model-backed title until after `turn/end` and pins one standalone provider title with no synthetic turn. Generated API and type-equivalence catalogs contain no removed symbol.

## Consequences

Turn counts and outcomes again describe model-loop executions only. Standalone events and manual compaction brackets consume session seqs without consuming a turn number, enter bounded persistence like every other append, and require owners to request an explicit durability barrier only when their operation promises one. Generic plugin mistakes no longer fail under a core default enclosure rule, so each plugin that needs an execution relation must state and test that relation itself. The title capability keeps revision ordering and lifecycle persistence with less core state, and manual compaction gains durable control with no synthetic-turn or turn-number collision.
