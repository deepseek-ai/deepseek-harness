# Agent Note: Team messaging uses one Steer send_message operation

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-30-team-send-message-steer.zh.md)

## Problem

Agent Teams exposed two model operations for one durable mailbox: quiet `send_message` injected into a live target without waking it, while `followup_task` queued a distinct waking turn and cold-resumed an inactive teammate. Models had to choose a scheduling policy instead of stating whom to message, and quiet messages could accumulate for an inactive teammate until unrelated work resumed it.

The ordinary continuable-Agent controls already use one direction-neutral `send_message` with fixed Steer scheduling. Retaining separate Team names and delivery modes made equivalent model communication depend on whether the target happened to be a direct child or a Team peer.

## Decision

Every Team member receives one `send_message({ target, message })` tool. The Team tool set contains nine operations; `followup_task` and model-selectable quiet delivery are absent. The durable `TeamMessageSnapshot` stores sender, target, content, and message identity without a scheduling field.

Every accepted Team message uses Steer. A running target receives it at the nearest step boundary, an idle target starts a turn, and an inactive teammate cold-resumes through the continuation lifecycle. A successful Team send remains durable before delivery starts. `accepted` means the target inbox accepted the message; `queued` means a temporary inspection, resume, or inbox-admission failure left it in the Team mailbox for recovery. Neither result means the target completed the requested work.

The Lead receives the Team-attributed user message through `Agent.steer()`. A teammate receives it through a symbol-keyed host-only continuation adapter that authorizes the exact Lead-to-direct-child edge, preserves the original `TeamMessageSource`, and performs resident or cold-resume Steer admission. Sibling and teammate-to-Lead messages therefore retain the real sender; the Team runtime never calls public adjacent-Agent `sendMessage()` while impersonating the Lead.

The Lead Session remains the mailbox transaction owner. It flushes `team/message/queued` before dispatch, serializes immediate admissions per target in Lead-log order, and records `team/message/delivered` only after the target Session durably contains the same Team message id. Recovery retries queued-minus-delivered records in order, and target-side source folding prevents duplicate acceptance across the crash window between inbox insertion and acknowledgement.

## Alternatives considered

**Keep quiet `send_message` and waking `followup_task`.** This preserves caller control over turn scheduling but makes the model choose an implementation policy, permits unread durable mail on inactive targets, and diverges from adjacent-Agent messaging.

**Keep `followup_task` as an alias for Steer.** Two names for identical behavior would preserve the tool-selection failure without adding an observable capability.

**Route siblings through public adjacent-Agent `sendMessage()`.** That operation authorizes only exact direct-parent or direct-child model senders and derives its own `AgentMessageSource`. Calling it with the Lead would misattribute sibling mail; widening it to Team membership would weaken its adjacency rule.

**Drop the Team mailbox and deliver directly.** Direct delivery loses durable enqueue-before-admission, recovery after temporary failure, stable message ids, and target-side de-duplication.

## Testing

Package tests pin running, idle, inactive, Lead, sibling, and recovery delivery; target-local ordering; sender attribution; inbox/history de-duplication; temporary failure returning `queued`; and the nine-tool schema. The keyless Agent Teams profile snapshot drives a running implementer, steers a researcher message into its next step, and verifies that both teammates still complete their assigned tasks before the Lead aggregates the result.

## Consequences

Models have one Team communication choice and cannot park quiet information intentionally. A message may extend the target's current turn, so prompts and tests require teammates to integrate new messages without abandoning work already in progress.

The host-only Steer adapter becomes part of the internal continuation integration used by Team delivery. Human browser prompts keep the separate Queue adapter and remain distinct turns. The broader [Agent Teams decision](../feature/2026-08-05-agent-teams.md) retains mailbox, roster, task, and shared-checkout ownership; the [adjacent-Agent messaging decision](../architecture/2026-08-27-adjacent-agent-steer-messaging.md) retains the public direct-edge authorization and model-message source.
