# Agent Note: Latch wake-ups that land in the cancel-convergence window

Status: implemented

English | [中文](2026-08-07-cancel-convergence-wake-latch.zh.md)

## Problem

`Agent.cancel(cause, { keepInbox: true })` returns immediately after firing the abort signal, but the active driver may not have converged to `idle` yet: LLM stream teardown, tool cancellation, and the `turn/end` append all unwind asynchronously after `abort()` returns. A waking send arriving in that window was placed into `next-turn` while `wakeDriver()` returned early on the still-`running` phase, and the exiting driver never replayed the wake — the message stayed parked until another waking send arrived. The same dropped-wake window existed around aborted `runMaintenance` activities. Several tests enshrined the parked behavior ("waits for another wakeup"); the bug broke both `session.cancel` and the `subagent.interrupt` composition path (issue #1838). The owning cancellation and send contracts are the [explicit turn cancellation](../architecture/2026-07-16-explicit-turn-cancellation.md) and [unified send](../../archived/architecture/2026-07-22-unified-send-and-coalesced-user-messages.md) decisions; the production `keepInbox` consumer is [web stop preserves queue](../../archived/bug-fix/2026-07-31-web-stop-preserves-queue.md).

## Decision

The `running` phase carries a `wakeRequested` latch, mirroring the existing `maintenance` phase field. `wakeDriver()` latches whenever the current activity cannot deliver the wake — a maintenance task never reads the queue, and an aborted activity converges without restarting — while a live driver needs no latch because it claims queued work itself. The exiting activity replays the latch at its own convergence boundary (`kick`'s `finally` and `runMaintenance`'s `finally`): this placement guarantees `turn/end N` lands before the replayed driver opens `turn/start N+1`, and that `whenIdle()` sees the replayed driver through its `activityDone` loop. The replay sites run only while `inbox.hasPending`, so a latched wake removed from the inbox before convergence does not start an empty driver. A wake sent while the agent is already idle keeps its turn boundary even when its message is cleared before the driver claims — that `idle → running → idle` transition is an observable contract: the goal-round-driver driver's pause/disarm fallback fires on the `idle` transition after a cancelled reservation (moving the guard into `wakeDriver()` suppresses that boundary). `cancel()` without `keepInbox` clears the latch together with the inbox.

The `signal.aborted` discriminator is load-bearing: it separates pre-abort queued work — which `keepInbox` parks for a later wake (the `keepInbox` parking contract) — from post-abort explicit wakes, which must run after convergence.

## Alternatives considered

**Have `cancel()` set the phase to `idle` immediately.** Rejected: the driver is still unwinding, so this overlaps two drivers. The replay lives in the old driver's `finally`, which then never runs — 14 of 83 tests failed, several deadlocked. Repairing it requires identity-based phase ownership plus a turn-open quiescence barrier, which is strictly more machinery and is the latch in disguise.

**Latch unconditionally for every non-idle wake.** Rejected: pre-abort wakes would auto-start after a `keepInbox` cancel, violating the `keepInbox` parking contract; the "parks queued work" test and the error-window steering test both failed.

**Replay through a chained promise (`activityDone.then(...)`).** Rejected: the replay would run outside the activity's own settlement, so `whenIdle()`'s loop can resolve before the replayed driver starts; fixing that requires replacing `activityDone` at send time and depends on microtask reaction ordering — more fragile than a synchronous flag.

**Wait for quiescence in the subagent adapter.** Rejected by the issue scope: the cancel/wake state machine owns the fix, not a consumer.

## Consequences

The `running` phase gains a `wakeRequested` field; `cancel()` without `keepInbox` clears it alongside the inbox, and a `disposed` cancel never latches, so a wake landing after disposal begins stays parked and `whenIdle()` does not wait on a full model turn over the session being torn down. A wake arriving in the sub-microtask gap between the driver's final `hasPending` check and its exit still parks — no latch fires because the phase is `running` and not aborted; closing that gap requires the unconditional latch and is deliberately out of scope. Between the aborted turn and the replayed driver, status transitions emit a transient `idle → running` pair. A waking send whose message is cleared before any driver claims it still opens an empty completed turn, preserving the observable wake boundary.
