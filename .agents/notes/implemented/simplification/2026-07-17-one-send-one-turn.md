# Agent Note: Remove implicit batching from ordinary sends

Status: implemented

English | [中文](2026-07-17-one-send-one-turn.zh.md)

## Problem

Suppose a caller submits message A and then message B with two `Agent.send()` calls. Implicit batching can put A and B in one turn simply because both are waiting when the driver reads its queue. The caller made two calls, but the loop silently turns them into one unit of work.

That grouping depends on timing rather than caller intent. Calls from one synchronous stack, neighboring microtasks, event listeners, and model callbacks could be grouped differently even though every caller used the same API.

This grouping changes behavior, not just the number of model calls. One ordinary turn owns one claimed follow-up, `turn/start`, `turn/end`, and a durability checkpoint. If message B shares message A's turn, B can enter A's model request instead of first seeing A's closed result in the session log. Entering one follow-up while rejecting another also requires a mixed state that no caller requested.

## Decision

Each successful `send()` creates one independent FIFO queue item. If that item runs, it is the only ordinary message in its turn. An item can be dropped before it starts, so the precise guarantee is at most one turn rather than exactly one; two sends are never silently combined.

Before inserting a message, `send()` checks the agent state and accepts an already identified, deeply frozen value. The durable splice and `agent/inbox/inserted { message }` retain its `MessageId`; the pending message remains addressable through `Inbox.replace()` and `Inbox.remove()` until the driver claims or discards it. The [claimed pre-step inbox reference](../../../../packages/core/agent-loop/README.md) owns the current lifecycle.

If messages A and B are both processed, B's turn starts only after A records `turn/end` and A's durability checkpoint settles. B's request therefore sees whatever closed result A left in the same session log. A checkpoint error is reported, but settlement only releases this ordering barrier; it does not make a failed write durable. Broad `cancel()`, disposal, or a failure before `turn/start` can instead discard an unstarted item without opening an empty turn.

At a turn boundary, the loop opens the turn and claims one follow-up after pending next-step input. `agent/pre-step` either rejects the proposal or returns the complete entering batch. A rejected follow-up remains removed and closes a blocked no-step turn without writing model-visible history. Mixed ordinary follow-up branches do not exist.

The no-batching rule applies only to ordinary follow-up input. `steer()` puts input in the next-step inbox and wakes the driver. During a turn, the loop can claim it at a later step boundary; while idle, the waking next-step batch starts a new turn. Input arriving after a batch was claimed waits for a later boundary, while cancellation or disposal can discard it.

`inject()` continues to add model-facing context without submitting ordinary input or waking the driver. It always waits in the next-step inbox for a later pre-step, including while idle; AgentLoop records it as `user/message` only when an enter decision returns it inside a turn. `cancel()` remains a whole-agent operation that can clear all unstarted ordinary input, steering, and injection and abort the current step. `status` and `whenIdle()` also describe the whole agent, not one message.

## Alternatives considered

**Keep automatic ordinary-send batching to reduce model calls.** This can improve throughput when producers outpace the driver, but it makes turn boundaries depend on scheduling and lets a later message run before the preceding turn closes and reaches its checkpoint. The decision keeps the predictable boundary and accepts the extra calls. Any future batching feature needs an explicit caller-visible contract backed by measurements.

## Verification

- Unit and property tests submit sends from the same stack, neighboring microtasks, different producers, and reentrant callbacks; every message gets its own FIFO-ordered turn.
- A built-stdio test submits two lines and observes two model requests and two turn boundaries.
- Delayed and rejected first-turn checkpoints keep the next turn waiting and prove that its request sees the preceding assistant result.
- Failure-path tests cover pre-step rejection, listener failure, broad cancellation, disposal, and failure before `turn/start`; initial pre-step exits close balanced no-step turns, messages do not merge, and surviving later work still drains.
- Separate tests cover open-turn, failed-turn, and idle `steer()`, pending `inject()`, whole-agent status, and `whenIdle()`.

## Consequences

Ordinary turn boundaries are predictable: messages A and B stay separate, and B runs only after A has closed and reached its checkpoint. Callers still do not receive a per-send completion handle; a pending message can be removed through its `MessageId`, broad cancellation can discard the entire unstarted tail, and status and quiescence remain agent-wide observations.

The trade-off is more model requests and more checkpoints. A busy queue can take longer to drain and can grow under sustained producers. Ordinary-send batching returns only through an explicit, measured contract.
