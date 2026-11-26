# Agent Note: The inbox returns claims for an unopened step

Status: implemented

English | [中文](2026-11-24-inbox-returns-claims-for-an-unopened-step.zh.md)

## Problem

AgentLoop claims inbox input before prompt assembly and `agent/pre-step`. If either fails, the user stops the Agent, or the process exits before `step/start`, the batch has already left the inbox and no `user/message` records it. #5655 reports the user case: Stop during the compaction a second prompt triggered loses that prompt. #8700 and #8721 report the producer cases: subagent results, scheduled reminders, ACP prompts, and goal rounds disappear the same way. Every inbox producer shares one recovery owner, the inbox itself, because headless, ACP, SDK, and guest producers keep no copy of what they queued.

## Decision

**The `inbox` projection folds queues and claims from the same splices.** A claim splice records `start` and `removedCount` but not the removed messages, so the fold that reconstructs the queues is the only fold that can name the claimed batch. The projection state is `{ queues: { 'next-turn', 'next-step' }, claim: { pending, interrupted } }`. `queues` stays one object because the wire view returns it by reference, which lets claim-only changes republish nothing. `claim` mirrors that grouping. The transitions are:

| Event | Before this change | Now |
| --- | --- | --- |
| `agent/inbox/spliced`, queue update | Validate `start` and `removedCount`, splice the target, reject an identity pending twice | Unchanged |
| `agent/inbox/spliced`, removal without `outcome` | Queue update only | The removed messages append to `claim.pending` in queue order |
| `agent/inbox/spliced`, `outcome: 'canceled'` | Queue update only | The removed identities leave `claim.pending` and `claim.interrupted` unless the same splice reinserts them |
| `step/start` | Ignored | `claim.pending` empties |
| `turn/end` | Ignored | `claim.pending` empties; an `interrupted` reason moves it to `claim.interrupted`, any other reason empties both |
| `session/end-seed` with `inherited: true` | Ignored | Both claim lists empty: a fork inherits its parent's queue, never a claim the parent's turn left unopened |
| Other events | Same reference | Same reference |
| Wire view | The state | `queues`, by reference |

The Host checkpoint stores the full state under `stateVersion` 3; a version 1 or 2 row replays from the log.

**The inbox owns the return.** When a turn ends before `step/start`, the loop calls `inbox.returnClaims()` before recording `turn/end`, and the inbox decides: `clear()` marks the current claim discarded and `claim()` resets the mark, so a Stop that clears the queue drops the batch while a Stop that keeps the queue (`keepInbox`) returns it to the head of next-turn in claim order, skipping identities already queued. A return the Session refuses is reported through `agent/error`; `turn/end` still records the original failure and settles the claim. The loop keeps no return state of its own.

**Resume restores the interrupted claim before `agent/created`.** After `announce()` opens the Session for writes, AgentLoop calls `inbox.restoreInterrupted()` without consulting the creation source: `claim.interrupted` is non-empty only after the resume repair recorded `turn/end` as interrupted, so a fresh Session is a no-op. A fork is also a no-op: a cold read of a crashed parent closes its open turn as interrupted inside the inherited prefix, and the fold drops both claim lists at the inherited `session/end-seed`, so the child keeps the parent's queue but not the input the parent had taken out of it. A `session/created` listener cannot own this because the Session is read-only during that dispatch.

**Producers that own a request or a retry withdraw their returned input.** ACP withdraws the prompt of a settled request, the goal driver withdraws a round without a live reservation, and schedule recovery leaves a returned reminder queued instead of moving it or holding its slot. The subagent manager treats a child whose only queued input the latest turn returned as settled rather than parked.

## Alternatives considered

**A parallel projection holding only `pending` and `interrupted`.** It must replay the queues itself to learn which messages a claim removed, so each Session would carry two queue folds and two queue copies in its checkpoint, and a splice change would touch both. Carrying the removed messages in the splice event instead would duplicate every message in the log.

**A flat projection state.** Four parallel fields read better but the wire view must then build a new object per state change, so each `step/start` and `turn/end` would republish an identical inbox to every client; a reference cache in the view costs more than the grouping.

**An error hook or `user/message` before preparation.** A hook cannot recover a claim after a process exit. Committing `user/message` before request preparation leaves an unanswered prompt in history when the user stops during preparation.

**Return only on failure, drop on every cancellation.** Stop during compaction is #5655's own report; treating it as a decision against the message keeps that message lost. `keepInbox` already distinguishes a Stop from a clear.

**Return input at each producer (#8741).** It restores Web prompts and nothing else: headless, ACP, SDK, and guests keep no copy of their input. Returning in the inbox makes recovery the default and lets producers with their own handling withdraw.

**Return each message to the queue it left.** A steer returned to next-step is invisible to the queue dock and runs with the next message without a chance to edit or remove it; the step it was steering ended with its turn. Next-turn is where the owner sees it.

**A return flag on the loop's running phase.** The loop recorded whether cancellation kept the inbox and consulted it in its turn-ending catch. The fact belongs to the inbox, which already sees `clear()` and `claim()`, and the flag was used as state although it is consumed once per driver. Wrapping the step loop in an inbox-owned recovery function was considered for the same reason; it moves the one call into a closure without moving the decision, at the cost of re-indenting the loop and routing its exits through a return value.

## Verification

- [agent-loop/tests/inbox-projection.spec.ts](../../../../packages/core/agent-loop/tests/inbox-projection.spec.ts): the transition table above, one case per row, plus same-reference results, view reference reuse across claim-only changes, rejected splices, and checkpoint replay from versions 1 and 2.
- [agent-loop/tests/inbox-settlement.spec.ts](../../../../packages/core/agent-loop/tests/inbox-settlement.spec.ts): a queue-keeping Stop and a failing pre-step return the whole batch without waking the Agent; a clearing Stop discards it; a failure after `step/start` leaves the batch settled; a refused return is reported and the turn still closes with the original failure; a fresh Agent records no return; a fork of a crashed parent keeps the parent's queue without restoring its claim.
- [agent-loop/tests/cancel.spec.ts](../../../../packages/core/agent-loop/tests/cancel.spec.ts), [loop.spec.ts](../../../../packages/core/agent-loop/tests/loop.spec.ts), [interception.spec.ts](../../../../packages/core/agent-loop/tests/interception.spec.ts): the returned prompt sits ahead of later input and the next wake runs it first.
- [agent-loop/tests/resume.spec.ts](../../../../packages/core/agent-loop/tests/resume.spec.ts): a resumed log whose interrupted turn claimed a prompt returns it before `agent/created`, once, ahead of input queued later.
- [subagent tests](../../../../packages/subagent/subagent/tests) cover idle children staying resident with returned input. [ACP tests](../../../../packages/acp/acp/tests/turns.spec.ts) cover rejected prompts running on the next wake. [Headless](../../../../packages/bundle/headless/tests/terminal-failures.spec.ts) and [SDK](../../../../packages/sdk/server/tests/wait.spec.ts) tests cover next-wake handling of returned child results and SDK prompts. [SDK resume tests](../../../../packages/sdk/server/tests/resume.spec.ts) cover a stale goal round leaving the first prompt queued.

## Consequences

- A failure before `step/start` leaves the complete claimed batch at the next-turn head; the queue dock shows it and the next wake runs it in order. Once the step starts, the batch is settled even when request preparation fails before the messages enter history.
- A message that fails before step start on every wake stays at the queue head until its cause is fixed or its owner removes it, and input arriving meanwhile is claimed and returned with it.
- Schedule recovery can repeatedly wake a returned reminder while a later occurrence stays due.
- The loop's turn code holds one `returnClaims()` call and no inbox recovery state.
