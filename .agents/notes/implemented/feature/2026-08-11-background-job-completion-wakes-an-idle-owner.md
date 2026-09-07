# Agent Note: Background job completion wakes an idle owner

Status: implemented

English | [中文](2026-08-11-background-job-completion-wakes-an-idle-owner.zh.md)

## Problem

`tool-jobs` promised the model "You are notified in-session when a task finishes — do not busy-poll or sleep on one." The promise held only while the model was still working. Completion delivered through `agent.inject()`, which appends to the next-step inbox without reserving a driver, so a task settling after its turn closed left the notice parked until something unrelated woke the agent. The common shape is exactly the one that breaks: the model starts a long command, tells the user it started it, ends its turn, and the command finishes into an inbox nobody will claim. The prompt told the model not to poll, and then nothing arrived.

The gap was recorded as a limitation rather than reasoned about, so the fallback was `job_output(wait: true)` — the blocking wait the same prompt discourages.

This supersedes one fact of the [background-job runtime decision](../architecture/2026-06-20-generic-long-running-tool-runtime.md) — that completion never wakes an idle owner — and adds teardown as a `reported` setter. That note keeps every other task-runtime decision and is updated in place rather than replaced.

The delivery machinery was never the obstacle. `Agent.send(message, target, wakeup)` has covered the `target` × `wakeup` matrix since the [unified send decision](../../archived/architecture/2026-07-22-unified-send-and-coalesced-user-messages.md), and `wakeDriver()` already handles idle, maintenance, and cancelled-converging phases. The missing piece was the policy choice of which lane a completion takes, plus the bound that choice needs.

## Decision

An unreported completion picks its lane from what the owner is doing. A busy owner is injected, unchanged. An idle owner is woken with `followup()`.

This adopts the delivery rule the [continuation manager](2026-08-06-manager-owned-subagent-settlement-delivery.md) already ships for subagent settlement, where "steering rather than injecting is deliberate … This is a correctness rule, not a deployment preference." The two paths do not overlap: `tool-subagent` registers a Task only for a one-shot background child and returns `continuable` before reaching that code, so a child is delivered by exactly one of the two mechanisms.

### The busy owner keeps injection

For a driver that is genuinely running, `steer()` and `inject()` are the same delivery: `wakeDriver()` returns early without latching for a running, unaborted phase. They differ only for an owner whose turn is cancelled but has not yet converged, where steering redirects to the next turn and replays the wake at convergence.

Injection is correct there. A cancelled turn is a user pressing stop, and reopening one on their behalf launders an interrupt into a model request they did not ask for. The turn loop already covers the ordinary case: it cannot close while the next-step inbox holds anything, so a notice arriving before that check extends the current turn, and several tasks settling together cost one step rather than one turn each.

### Waking is bounded, and the bound is not time

`maxConsecutiveWakes` (default 3) caps the turns one owner may open this way; beyond it a notice degrades to injection and waits for the next turn. Claiming any user-authored message restores the budget — claiming, not arrival, because that is the point human input actually enters a step. Notices this plugin queued never refill it.

The bound exists because this chain is self-exciting in a way subagent settlement is not. Settlement is bounded by how many children the model spawned; a woken turn can start the background job whose completion wakes it again, with nobody watching. `dsh run` needs no separate policy: its one user message is claimed in the first turn and never repeats, so the budget is spent monotonically and the process terminates.

`completionDelivery: quiet` restores the old lane for idle owners. It exists for deterministic transcripts; job completion independently retains `quiet | wakeup` because its bounded owner-turn policy differs from next-step subagent reports.

### Teardown claims the report

`cancelForTeardown` now marks the record `reported`, exactly as `kill()` does after cancelling. The asymmetry was invisible while the notice was a harmless inject; a waking reporter turns it into one model request per teardown layer, on agents the host is destroying.

`reported` was already the right bit — "a kill, read, or wait has reported or committed to report the terminal state" — and teardown is a kill without a caller. Using it keeps every observer of the settlement intact: `onJobDone` still fires, so runtime invariants and the force-fail path stay covered, and only notice reporters go quiet.

### Completion is announced last

`settle()` released waiters, marked the record settled, and published the visible-set change *after* running completion listeners. A reporter that opens a turn does so synchronously, so that order let a woken turn's `turn/start` land before the settlement it was reacting to was committed, and before any `onJobsChanged` observer had seen it. Announcing completion last makes the reporter the final observer of a settlement every other observer has already seen.

## Alternatives considered

**A producer-declared wake bit on `JobStart`,** matching Codex's `trigger_turn` and Kimi's `admission` enum. It is the better long-run shape — a `tail -f` stream and a two-hour build want different answers — but no current producer distinguishes them, and the repository requires a current owner and need for public surface. The natural trigger to add it is the first producer that wants one task to wake and another not to.

**A general unsolicited-input queue** with priority lanes, as Claude Code uses to merge background jobs, cron, MCP push, and hooks into one drain. DSH's inbox already is that queue — durable `agent/inbox/spliced` splices over `next-turn`/`next-step` — so this would add a layer above an existing one to decide a single bit.

**Refusing to reopen a turn that already produced a visible answer,** Codex's `MailboxDeliveryPhase` latch. That latch is the default this decision deliberately inverts: waking after the model has spoken is the entire point, and the wake budget is the bound instead.

**A wall-clock window** on top of the counter. For an interactive agent the slow case is the wanted one — an hour-long build finishing and the agent resuming is the feature — and `dsh run` is already bounded by the counter it cannot refill. Worth revisiting only if an unattended long-lived deployment appears.

**Suppressing `onJobDone` entirely during owner drain,** symmetric with the service-wide `listenersClosed`. It reads cleaner and removes a signal that is not only for notices: the force-fail record and the runtime invariant both observe teardown settlements. The `reported` bit denies exactly the reporters and nothing else.

## Consequences

- Default behavior changes: an idle owner now spends a model request per completion, capped at `maxConsecutiveWakes` per owner between user messages. Deployments that want the old behavior set `completionDelivery: quiet`.
- The `tool-jobs` prompt section needs no edit; "You are notified in-session when a task finishes" became true rather than aspirational.
- `JobSnapshot.reported` gains teardown as a fourth setter, documented at the Service Definition and in [the subsystem reference](../../../../docs/subsystems/jobs.md).
- `settle()` announces completion after committing the record and publishing the visible-set change. Any listener relying on running before waiters were released or before `onJobsChanged` now runs after both.
- The `tool-bash` real-composition test dropped its second user message: settlement alone carries the notice into a turn that collects the output. It asserts the durable outcome rather than a turn boundary, because whether the command outlives its turn is a race; the lane choice is pinned in `tool-jobs` unit tests instead.
- Unit coverage pins idle wake, busy injection, quiet delivery, budget exhaustion, budget restore on user input, non-restore on plugin notices, and teardown silence.

### Accepted risks

A spent budget is restored only by user input. An unattended agent that exhausts it collects its remaining notices whenever something else opens a turn, and nothing re-arms it in the meantime.

A notice pending on an idle owner under `quiet` still dies with that owner's disposal, unchanged from before: the disposal cancel clears the unclaimed inbox and the log keeps the insert/cancel pair as the record. The [settlement delivery note](2026-08-06-manager-owned-subagent-settlement-delivery.md) owns the offline-mailbox discussion this would need.

Whether a completion extends the running turn or opens a new one is a genuine race for short-lived tasks, so no authored transcript can hold both orders. Assembled coverage asserts the outcome; the lane choice is pinned in unit tests.

One microtask window survives: a settlement landing after the turn loop's last inbox check but before the driver commits its idle phase still reads `status === 'running'`, so it injects and nothing wakes. Steering would not close it either — `wakeDriver()` latches only for maintenance and post-cancel phases, not for a driver between its final check and its own retirement. Closing it needs an `agent-loop` boundary that publishes retirement before the last claim, which is a core-agent decision rather than a delivery-policy one.
