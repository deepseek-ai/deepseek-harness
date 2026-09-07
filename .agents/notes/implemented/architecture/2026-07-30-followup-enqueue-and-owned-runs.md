# Agent Note: Follow-up enqueue and owned run boundaries

Status: implemented

English | [中文](2026-07-30-followup-enqueue-and-owned-runs.zh.md)

## Problem

`Agent.followup()` identifies and queues a user message, but one follow-up does not own the activity that follows it. Steering, injected context, tool continuations, recovery, and later queued messages can all contribute before the agent next becomes idle. A `MessageId` can therefore prove inbox admission, but it cannot identify which assistant message or `turn/end` is the result of that input.

The [one-send-one-turn decision](../simplification/2026-07-17-one-send-one-turn.md) already rejects a per-send completion handle in the core API. Protocol and SDK layers that pair one prompt request with a turn result manufacture that missing relationship downstream. The pairing becomes ambiguous as soon as activity admits more input, and it exposes turn mechanics as if they were a prompt-level outcome.

## Decision

Keep `Agent.followup(message): void` as an enqueue-only operation. `Agent.whenIdle()` and `agent/status` remain whole-agent lifecycle observations; neither settles an individual message. Inbox durability records the identified message and its admission or cancellation, without assigning later output to it.

The low-level SDK protocol answers `session/prompt` as soon as enqueue succeeds with `{ messageId }`. It streams durable facts through `session.event`, publishes whole-agent transitions through `session.status`, and has no `session.finished`. A low-level client may observe that receipt and later idleness, but receives no prompt result.

High-level automation APIs return a `RunResult` only when they explicitly own an activity interval. The TypeScript and Python SDK `run()` methods collect from the submitted message's durable inbox receipt through the next whole-agent `idle`; their final response is the last committed assistant message in that interval, not a response causally attributed to the submitted prompt. The Python SDK also reports the last root turn's reason kind as the run-level [`finish_reason`](../../archived/bug-fix/2026-08-11-owned-run-finish-reason.md), without attributing it to the submitted prompt. The one-shot CLI owns the analogous idle-to-idle interval. An isolated child-agent run may report a result because its caller owns the complete child lifecycle and any steering belongs to that run.

ACP must return a protocol `stopReason`. Its bridge serializes one in-flight prompt per ACP session and owns the interval from admission through whole-Agent idle and ordered update delivery. It correlates the turn that admits the identified ACP message without claiming that every activity in the interval was caused only by that message. A correlated token-limit ending maps to standard `max_tokens`; a correlated model error rejects at the same quiescence boundary; a turnless slot settles as `cancelled` alongside explicit ACP cancellation or disposal. Other normal quiescence reports `end_turn`.

Goal continuation retains `MessageId` only to recognize its durable queued and admitted goal message. It advances from durable goal state at whole-agent idle, without mapping the message to a turn result.

## Alternatives considered

**Map `MessageId` to the turn that admits it.** A turn may consume steering and injected context and may continue through multiple model/tool steps. The mapping identifies admission, not causal ownership of the resulting output or stop reason.

**Return a per-follow-up completion handle.** A handle would imply a result boundary that the shared agent lifecycle does not have. It would either omit work that influenced the activity or silently absorb unrelated later input.

**Use the last `turn/end` observed before idle.** This is a useful run-level observation for an explicitly owned interval, but naming it as the submitted message's outcome recreates the false causal claim.

## Verification

- Agent and inbox tests pin enqueue-only follow-up, durable admission or cancellation, and whole-agent idle observation.
- SDK protocol, TypeScript SDK, and Python SDK tests pin the `{ messageId }` receipt, `session.status`, the absence of `session.finished`, and receipt-to-idle `RunResult` collection without prompt-level `status` or `reason`; Python SDK tests separately pin its run-level `finish_reason` observation.
- ACP, one-shot CLI, goal continuation, and subagent tests pin the distinct activity ownership each integration possesses.
- Consumer tests pin that no production integration derives a follow-up result by correlating `MessageId` with `turn/end`.

## Consequences

An owned activity interval can include steering, injected context, or other work submitted before idleness, so its final response, finish reason, and events are deliberately broader than the initiating message. Prompt-level model error and token-limit classifications remain absent from the low-level DSH SDK result. ACP projects the correlated turn into its required standard error or `max_tokens` stop reason at interval quiescence, without adding a DSH-specific result or claiming exclusive causality. Concurrent automation on one session requires an explicit serialization or ownership policy rather than an implicit per-follow-up result.
