# Agent Note: One selection rule keeps subagent output past an empty terminal message

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-10-subagent-empty-terminal-message-output.zh.md)

## Problem

The agent loop appends an empty-content `assistant/message` when a `max-tokens` step assembled only tool-call blocks because `BlockAssembler.blocks()` drops truncated tool calls; the message retains its stream and usage but contributes no output blocks. Three consumers selected the child's output independently and treated that record as output. The in-process driver's `readResult` and the continuable Activation's `subagent/end` capture selected the last `assistant/message` without filtering, while the SDK backend's observer let any `assistant/message` take precedence over accumulated text. In a multi-step turn cut off at max-tokens, the final empty message caused the real partial answer to be omitted from `SubagentResult.output`, the tool result, telemetry, and `subagent/end.lastAssistantMessage`. The in-process driver also lacked a streamed-text fallback, so a cancelled child whose only text existed in an embedded Assistant stream reported `[]`.

## Decision

`dsh-subagent` owns one canonical selection rule in `src/assistant-output.ts`: select the last non-empty Assistant message; without one, select accumulated `text-delta` content from embedded `assistant/message` and `assistant/attempt` streams or a chunk-only transport; ignore empty-content messages. The incremental `AssistantOutputFold` implements the rule through `push(event)`, `pushText(text)`, and `collect()`. `finalAssistantOutput(events)` applies it to a complete event suffix for the in-process `readResult` and Activation capture. The SDK backend folds notification events; the ACP backend exposes no complete Assistant messages and folds raw chunk text. `SubagentResult.output` defines the result contract, and `subagent/end.lastAssistantMessage` uses the same rule. When a child produces neither form of output, the lifecycle field is absent rather than an empty array for both one-shot and continuable runs. A `max-tokens` or `aborted` result retains its actual stop reason.

The foreground delegation tool uses the same selection. A non-`completed` result remains an `isError` tool result, but its message presents the optional safe Provider diagnostic owned by the [non-interactive permissions decision](../feature/2026-08-15-product-subagent-noninteractive-permissions.md) after the stop-reason headline and appends the child's partial text afterward. The parent model receives the failure, separate infrastructure detail, and available assistant output without conflating them.

## Verification

The keyless SDK backend test uses `FAKE_EMPTY_MESSAGE` to emit a usage-only terminal message. The `subagent-max-tokens-partial` ACP snapshot records a child that streams text and a tool call, ends at a tool-only max-tokens step with an empty usage message in its durable log, and returns the partial text through the parent's errored tool result. Unit coverage checks empty terminal messages, cancellation, message ordering, textless non-empty messages, and exclusion of tool-result content.

## Alternatives considered

**Fix each consumer in place without a shared helper.** Rejected: three independent selections had diverged, while observers of one run must agree on its output.

**Stop the loop from appending the empty message.** Rejected: the message records usage and preserves the step in the durable log ("model-visible ⟺ logged"); changing session events to address output selection would affect every replay and projection consumer.

**Treat empty-content messages as an error.** Rejected: the streamed text is the child's real partial answer, and the stop reason already tells the consumer the turn was cut short.

## Consequences

Multi-step children cut off at max-tokens report their earlier text; cancelled in-process children retain text streamed before the abort; one-shot and continuable `subagent/end` events agree with `SubagentResult.output`. A message whose content is non-empty but textless, such as reasoning-only content, is selected instead of streamed text because the rule tests content length rather than text presence. A non-empty message is also selected instead of text streamed after it: a child cancelled while streaming a later step reports its earlier complete message, while the stop reason records the truncation.
