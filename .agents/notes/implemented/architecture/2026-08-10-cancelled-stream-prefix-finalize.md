# Agent Note: Cancelled streams finalize their delivered prefix

Status: implemented

English | [中文](2026-08-10-cancelled-stream-prefix-finalize.zh.md)

## Problem

A cancelled stream can leave transient chunks that clients have rendered while `deriveMessages()` excludes them because no `assistant/message` records the delivered prefix. A follow-up such as "expand on your second point" then lacks text the user read, and a fork at the cancelled turn inherits the same gap.

The model history must contain assistant content that remains visible to the user after cancellation.

## Decision

`ReactLoopAgent.step()` catches cancellation while consuming a model stream, when its `BlockAssembler`, compact stream accumulator, and provider route identify the delivered prefix. It appends that prefix as the step's `assistant/message` with `interrupted: true`, `surfaceOp: 'append'`, and the exact embedded timed stream. The append precedes the committed `agent/assistant-stream` end frame, `step/end`, and the aborted `turn/end`.

`BlockAssembler.interruptedBlocks()` returns closed and open `text` and `reasoning` blocks with non-whitespace content in stream order. It omits tool calls because interruption precedes dispatch and no real result exists; it also omits empty blocks and open unknown block types. An empty result appends `assistant/attempt` instead of a surface message. Provider `error` and `aborted` finishes also commit `assistant/attempt` before `agent/request-error`, so their streams remain durable without contributing failed-request content to model history.

Chat and Trajectory Conversation Definitions read `interrupted` from the durable message. Chat renders the Stopped marker, while Trajectory keeps the provider request in the error lifecycle after `step/end` and retains the durable result seq and provider information. Cancellation during tool execution follows the tool scheduler contract because the assistant message has already committed: started calls produce real results, and undispatched calls receive `ABORTED_BEFORE_DISPATCH` results.

## Alternatives considered

**Always discard the prefix.** This avoids a new durable marker but makes every cancel-then-follow-up and fork omit assistant content that remains visible to the user.

**Assemble the prefix from the embedded attempt during projection.** `deriveMessages()` and Client Conversation Definitions would each need interruption assembly rules, and the log would have no authoritative surface message for the prefix. This also expands model history beyond the three `SurfaceEventType` events.

**Retain complete tool calls with synthetic aborted results.** These calls never dispatched, so synthetic results would claim an execution outcome that did not occur and add content the user did not receive as a tool result.

**Append a model-visible interruption message such as `[interrupted by user]`.** This can tell the model that the prefix is incomplete, but it requires a separate source type, projection rule, UI treatment, and localized wording. The durable aborted `turn/end` preserves the fact needed for that later decision.

## Consequences

Post-cancel follow-ups and forks include the delivered prefix. The ACP bridge drains ordered assistant output before settling the prompt, so the final `agent_message_chunk` update precedes the cancelled stop reason.

Terminal provider errors retain their stream in `assistant/attempt` but keep its content out of model history. Only the user's cancellation decision turns visible delivered text into an interrupted surface message.

## Testing

`packages/core/agent-loop/tests/cancel.spec.ts` covers content, embedded streams, event order, next-request parity, reasoning-only output, tool-call omission, recovery cancellation, and the empty-prefix attempt. `packages/llm/llm/tests/assembler.spec.ts` covers `interruptedBlocks()`. `packages/client/ui-chat/tests/conversation-node-definitions.client.spec.ts` and `packages/client/ui-trajectory/tests/conversation-definitions.client.spec.ts` cover both Client projections. The keyless `cancel` ACP snapshot and `goal-round-driver` goal snapshot cover assembled applications.
