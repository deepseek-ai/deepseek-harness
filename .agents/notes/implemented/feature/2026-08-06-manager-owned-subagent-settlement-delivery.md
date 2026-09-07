# Agent Note: Settlement delivery belongs to the continuation manager

Status: implemented

English | [中文](2026-08-06-manager-owned-subagent-settlement-delivery.zh.md)

## Problem

Continuable background delegation was the one asynchronous operation a model could start but could not reach the end of. Every other shape has a retrieval primitive or a return value: a background bash command and a one-shot background subagent both settle through a Task that `job_output(wait: true)` can block on, a workflow and a foreground subagent return their result to the caller. A continuable background child returned only its durable id, and nothing existed that a parent could wait on or would be handed.

Child-authored messages close the cooperative half of that gap: a child can send progress and a final handoff to its direct parent. Model choice cannot close the rest. A child stopped by a token ceiling, a model failure, cancellation, or teardown may never send such a message, and those are precisely the endings a waiting parent most needs to hear about. The observable downstream symptoms were parents busy-polling `list_agents`, re-sending messages to children that had already settled, and deployments abandoning `subagent` for `workflow` because a workflow at least returns something.

The signal already existed. `subagent/end` has carried `stopReason` and `lastAssistantMessage` since continuable Activations shipped. What was missing was any consumer that turned it into context the parent's model could see.

## Decision

The continuation manager delivers the account itself, from inside the disposal transaction that ends the Activation.

When a resident Activation settles, `notifySettlement()` resolves the child's durable direct parent and sends it one user-role message: the epoch's outcome as a sentence the parent can act on, then the child's final assistant content, or a statement that it produced none. Delivery is unconditional for every child whose id a caller actually received. It does not consult whether the child reported, and it keeps no bookkeeping that could make the promise conditional — that unconditionality is what lets `tool-subagent` promise a runtime notice containing the outcome and any final assistant message. A materialization rolled back before its first accepted message stays silent, because the caller was told that child was not established.

### Provenance

The notice carries `{ kind: 'subagent-settled', form: 'notice', summary, senderSessionId }`. It is deliberately not the `agent-message` kind used by `send_message`. An Agent message is content the child chose; this is the runtime stating what became of the child. Merging them would credit the child with words it never wrote, and would make a durable log unable to distinguish "the child said it was done" from "the harness observed that it stopped". The `notice` form also gives a UI the collapsed one-line presentation this message wants, where `relay` presents Agent correspondence.

### Two ordering rules, and why the manager owns them

An external `ctx.on('subagent/end')` listener looks more decoupled and is wrong. `SubagentRunEndInfo` names no parent, the child handle is already disposed when the edge fires so the parent cannot be recovered from it, and the ownership release that wakes the parent's own settlement watcher has already run. The manager holds the parent reference throughout disposal, so none of those obstacles exist for it.

**The send happens before `releaseOwnership`.** At that point the parent's owned-child set still contains this child, so the settlement predicate cannot succeed. Delivering after the release instead races a watcher that resumes one microtask later, finds itself childless and quiet, and disposes an Agent whose `cancel()` clears the very inbox the notice is sitting in. The failure mode is a silently missing message with no error anywhere.

**A resident parent receives it through its private `SubagentInbox`.** The wrapper checks the Activation's closing promise immediately before the synchronous waking send, and the manager renews the wake generation before returning. The final settlement decision rechecks that generation, the Session sequence, the pending Inbox, and the owned-child set under the child lock, then claims the Agent's idle phase through `runMaintenance()` before closing admission. This is not redundant with the first rule: `Agent.status` folds context maintenance into `idle`, and a waking send behind maintenance only arms a deferred wake.

Both rules are pinned by tests that fail when the ordering is reversed or the accounting removed.

### Establishment holds ownership open

The owned-child accounting also guards the creation side: `holdOwnership()` pre-registers the child id in a continuation-managed parent's owned set before the establishment or resume awaits (persistence stat, provider preparation, materialization), so an idle parent cannot be judged settled while a caller is still creating or resuming that child — an admitted delivery after settlement would find a stale parent identity. The returned releaser serves only the failure path: it removes just the hold this call added, and once a live Activation for the child exists the ownership edge belongs to that Activation and `finishDisposal`'s `releaseOwnership`. A parent with no Activation needs no hold (only this manager settles parents), and a parent whose own disposal transaction is already open rejects with `ACTIVATION_CLOSING` instead of establishing a child that could never be delivered to.

### Scheduling

An idle parent gets one ordinary later turn. A busy parent is steered into its nearest step boundary, because `Inbox.claim()` takes the whole next-step batch at one boundary: four children settling together then cost one step rather than four turns. Steering rather than injecting is deliberate — the wake is a no-op while the driver is running, and it closes the window where a driver retires between the status read and the send, which would strand the notice unclaimed until something unrelated woke the parent. This is a correctness rule, not a deployment preference, so it is not a `Config` field.

One `running` parent is not steerable: one whose turn is already cancelled but has not yet exited. `Agent.send()` redirects waking input submitted after cancellation to the next turn, latches the wake, and replays it once the cancelled driver converges — except for a disposal cancellation, which never latches and belongs to the teardown rule below. The notice therefore still opens its own turn without waiting for unrelated input; the cost is a redirected turn boundary, not the message.

**A parent whose own teardown began gets no wake.** Waking is not a queue operation: `Agent.followup()` on a quiescent Agent starts a turn, and `cancel()` on an idle Agent is a documented no-op that does not arm against a later one. Every teardown path therefore ends with a live, cancelled, still-registered parent — `drainContinuableDescendants()` is called by the ACP bridge between cancelling its session agents and disposing them — so an unguarded notice starts a real model request on an Agent about to be destroyed, once per tree layer, because each layer's own notice then wakes the layer above it. `notifySettlement()` asks the same question `assertAdmitting()` asks (is this lineage's continuable admission closed?) and injects instead. Injection is not a durable mailbox — Accepted risks records what the parent's own disposal then does to it — but it is the only send that reaches a parent still reading its inbox without arming a turn on one that is not, and nothing is lost that the wake would have delivered: the turn a wake started was itself disposed mid-flight.

Delivery never blocks or fails teardown. A rejected send is logged and dropped, because retaining a child to retry a notice would pin its whole ancestry in `waiting` forever, and a parent that has left the registry is an ordinary outcome rather than an error.

### The epoch's own log is the whole account

`epochStopReason()` reads the epoch's outcome from its own log, because teardown succeeding says nothing about whether the model errored, hit its ceiling, or was stopped. Reading turns alone got that wrong twice, in the same shape both times: a turn stopped before its first step leaves a `turn/end` indistinguishable from the balanced no-op turns a rejection or an emptied claim produces, so the filter that skipped those also skipped real endings and answered with the previous turn's clean completion. The durability checkpoint (`dsh-session-checkpoint-policy`, in every shipped profile) and prompt assembly both run at that boundary and both propagate, and `Inbox.claim()` has already taken the messages by then — so the parent was told a child finished while the delivery it was waiting on had been swallowed. Under the advertised automatic settlement notice, that is the one failure a parent cannot detect and will not retry.

The missing fact was never the turn's; it was the inbox's. `Inbox` logs every mutation with `removedCount` and marks a cancellation `outcome: 'canceled'`, which separates a turn claiming its input from work being dropped unrun. `foldConsumedWork()` in `dsh-agent` folds both vocabularies into one answer: the latest turn that accounts for consumed work — stepped, or claimed-then-failed, stopped, or rejected — and whether accepted work was cancelled after it with no turn opening over it. A `blocked` end over claimed input is an account too: the pre-step rejection that produced it — a hook deny, a policy plugin — discarded the messages the turn claimed, so the notice says the child declined rather than finished. Only a `blocked` turn that claimed nothing stays invisible.

Deriving it from the log rather than from live state is what makes it whole. An earlier version sampled the manager's own Activation immediately before cancelling, which could only ever see cancellations this manager was about to perform: an ancestor's `interrupt()`, or an unloading plugin cancelling an agent it tracks, left the sample false and the notice still saying `finished`. It also left the accepted-but-never-claimed case pinned to nothing a test could distinguish from its absence. One fold over the log covers every issuer, and both halves fail their own tests when removed.

Precedence is the consumer's: a recorded failure or ceiling wins over a cancellation, because stopping a child that had already failed does not turn its failure into a cancellation. `dsh-agent` owns the fold because it owns the inbox marker the answer depends on, and both consumers already depend on it — the continuable epoch here, and the one-shot `readResult()`, which had the same hole.

Both matter past the notice: `subagent/end` carries `stopReason` to the jsonrpc UI and the Claude hook bridge, which reported a torn-down mid-turn child as `completed`.

### Snapshot coverage

Three assembled ACP scenarios cover the notice: a child that sends no message, a child that sends a message first, and a child driven through several Agent-message turns. All three need an explicit fence. The notice arrives once the child's teardown finishes, which races whatever the parent is already doing, so each scenario holds the child behind the parent's spawn turn and then waits for the parent turn the notice opens (`waitForTurnStart` at that turn, then `waitForTurnEnd`) before the script continues. Waiting for a turn the run is not fenced to produce is not coverage: it is a timeout when the notice lands in the turn already running instead.

`subagent-continuable` is the one that pins a failure. Its child's last turn dies on the forced durability checkpoint without entering a step, so that transcript is where the stop-reason rule above is visible end to end: the notice says the child *failed*, carries the earlier `SECOND_OK` as its last content rather than as a result, and the parent's own acknowledgement turn reaches the ACP client.

A keyless headless Loader snapshot covers the user-visible path end to end. Its replay parent omits `run_in_background` to exercise the continuable background default, never calls `list_agents`, `send_message`, or Task tools, consumes the manager-authored `subagent-settled` notice, and produces its final answer. The child sends no Agent message, so the transcript depends only on the runtime notice. A test-only Loader fence holds the parent's post-spawn request until the real manager notice enters its inbox, removing platform scheduling from the transcript without synthesizing the notice.

The `subagent-send-message` scenario holds the child until the parent's spawn turn ends, then holds the parent in maintenance until settlement follows the child-authored message. The resumed parent claims the next-step Agent message before the queued next-turn settlement. The [message/settlement ordering decision](../bug-fix/2026-08-17-subagent-message-settlement-ordering.md) owns this cross-state ordering.

The refusal and interruption wordings are pinned verbatim in unit tests rather than in a replayed transcript: producing them needs a rejecting policy plugin or a cancellation fenced at a step boundary, which the keyless assemblies do not otherwise carry, and the assembled scenarios already pin the notice pathway itself end to end.

## Alternatives considered

**Give continuable children a Task.** A Task is a one-shot contract: one producer, one settlement, one result. An Activation runs many turns, outlives any single one, and can be resumed after it ends. Wrapping it in a Task recreates exactly the lifetime mismatch continuable children were introduced to remove, and would make one turn look terminal.

**Attach an external `subagent/end` listener.** Rejected on three counts above — no parent in the payload, a disposed child handle, and an ordering the listener cannot influence. A listener would also have to be strictly synchronous to beat the release, and nothing at that seam enforces it, so the correct version would be correct only by accident.

**Deliver only when the child sent no message.** This was the first design. It needs per-Activation bookkeeping, still misses the child that sent progress and then died before its result, and — decisively — makes the parent-facing promise conditional. "Usually you are told" is not a contract a tool description can state, and a model that cannot rely on the notice will poll anyway.

**Make delivery configurable.** A deployment switch would return the model-facing text to "usually", which is the failure this change exists to remove. Protocol constants and safety invariants stay fixed; this is one of them.

**Change `subagent/end` to carry the parent, and let a plugin deliver.** That widens a published payload for one in-package consumer, keeps every ordering hazard, and makes the return channel an optional plugin again. Extending the package-private `ActivationObserver` with `terminal(failure)` keeps one computation of the terminal facts and no public surface change.

**Always use `followup`.** Simpler and uniform, but a fan-out of children settling together would cost one parent turn each. The step-boundary batch already exists; using it is free.

## Consequences

- A continuable child's parent receives one message per settled Activation. Fan-out deployments therefore add parent turns; steering keeps a simultaneous batch to one step.
- `tool-subagent` promises the notice in its schema because the return channel is service behavior, not an optional plugin.
- `Activation` carries `parentSession` and `announced`. The first exists because the child handle is disposed before delivery; the second is what keeps a rolled-back materialization silent.
- `foldConsumedWork()` replaces `dsh-session`'s `findLastMessageTurnEnd()` and moves to `dsh-agent`, which owns the inbox marker it reads; the one-shot in-process path folds the same answer and does not classify a cut-short one-shot child as `completed`.
- Unit coverage pins the unconditional contract, each terminal reason, idle and busy scheduling, the batch, the maintenance regression, the pre-release ordering, a parent that is gone, and a rejected send that must not fail teardown.
- Three ACP scenarios use an explicit settlement fence, and `subagent-send-message` pins the Agent-message-before-settlement next-step order.
- A keyless headless Loader snapshot pins background start → manager-authored settlement notice → final parent answer with no polling or child-authored message.

### Accepted risks

The notice is delivered, not confirmed. There is no durable mailbox, receipt, or retry: a parent that is not live loses it, and the child's Session remains the only durable record. Closing that needs an offline mailbox protocol with its own addressing, authorization, and replay rules.

A notice injected during teardown is not read by a model when that parent is disposed next, which every teardown caller does: the disposal cancel clears the unclaimed message and the log keeps the insert/cancel pair as the record. Making teardown delivery readable after resume requires either the offline mailbox above or a change to disposal of durable pending work. Disposal discards every unclaimed inbox item, including user input, so changing that behavior is a core-agent decision rather than a settlement-delivery detail. After resume, the parent can discover the child but does not receive the outcome: `list_agents` reports existence and live-or-stored status only — `SubagentListEntry.activity` says so — and recovering the ending requires asking the child through `send_message`.

Stop-reason attribution is a best effort over the log's existing splice vocabulary, biased against overstating success. `Inbox.remove()` and teardown's `clear()` write identical cancellation splices, so removing a message whose content survives elsewhere — `agent-instructions` vacuuming a pending instruction refresh, or settlement's own cancel clearing one left pending — can read as work dropped unrun and report a finished child as stopped. Separating them requires a richer removal vocabulary in `dsh-agent`; without it, the misread is narrow and errs toward the parent double-checking a finished child, never toward trusting an unfinished one.

Turn amplification is real for deep or wide trees, and it is not configurable by design. The step-boundary batch bounds it for simultaneous settlement but not for children that settle apart.

Agent messages and their later settlement notices are ordered through the parent's next-step FIFO. Independent settlements from sibling children retain their actual delivery order rather than a synthetic sibling ordering.
