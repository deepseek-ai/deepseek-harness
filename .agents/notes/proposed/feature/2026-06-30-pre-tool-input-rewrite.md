# Agent Note: Pre-tool input rewrite — a consistent design

Status: proposed

English | [中文](2026-06-30-pre-tool-input-rewrite.zh.md)

## Problem

The [interception extension-points reference](../../../../packages/core/tools/README.md) defines `tools/pre-execute` as an allow/deny/ask gate over an execution whose identity is already protected and whose arguments are deeply frozen. Claude Code's `PreToolUse` hook also offers `updatedInput`, so a faithful bridge needs an explicit rewrite mechanism. A rewrite cannot be a mutation escape hatch on the existing execution object: it must keep the durable history, audit record, presentation, and executed value consistent.

## The problem: three readers of pre-execution arguments

In the loop, a tool call's arguments are committed to the log and read by live consumers BEFORE the tool executes:

1. **`assistant/message`** is appended before tool dispatch — it is the model-history source `deriveMessages()` replays, so it carries the tool-call arguments the model itself emitted.
2. **`tool/call`** is the durable AUDIT record, appended before `ctx.tools.execute()`.
3. **Human-facing presentation reads `tool/call.arguments`**: UI renderers pass them to `presentResult`; `dsh-tool-bash` derives the card title, the rawInput, the cwd, and the terminal-vs-background treatment from them.

An execution-only rewrite would make the UI show one command while another ran and render the result against the wrong arguments. The registry prevents that failure mode: it structured-clones and deep-freezes `arguments`, makes the execution identity properties non-writable, and exposes no test shim or listener path that can replace them. The rewrite design must preserve that protected-identity boundary rather than weaken it.

## Proposal

A rewrite is a pre-identity consistency transaction. When a hook supplies `updatedInput`, the effective value must be chosen before the registry constructs its immutable `ToolExecution`, and it must be reflected in all three readers atomically:

- The `tool/call` audit event records the REWRITTEN arguments (with the original retained in a sidecar field for the audit trail — a hook changed the call, and both the original and the effective arguments are facts worth keeping).
- The `assistant/message` in derived history must agree with what executed — options to evaluate: rewrite the assistant message's tool-call block in place (changes what the model "sees it said"), or record a separate correction the next request carries. The CC model is that the model sees the rewrite took effect.
- Presentation (`presentCall`/`presentResult`) reads the rewritten arguments, so the UI shows what actually ran.

Extending `PreToolDecision` at its current firing point is insufficient: both durable records already exist by then, and the execution identity is protected. The implementation must either move the relevant decision before the log commit or add a dedicated earlier rewrite decision over the pending model call. After the loop commits the effective arguments to history and audit, it constructs the ordinary immutable execution and runs the existing allow/deny/ask and tool pipeline unchanged.

## Alternatives considered

### Why not mutate the execution object?

Allowing a pre-execute listener to assign `exec.arguments` would provide only an execution rewrite, leaving model history, audit, and presentation unchanged. Keeping the identity protected makes such partial behavior unrepresentable. Until the consistency transaction exists, a CC/Codex bridge logs and warns about `updatedInput` rather than claiming it was honored; `TODO(pre-tool-input-rewrite)` at the loop dispatch site anchors the missing earlier phase.

## Acceptance criteria

- A requested rewrite is resolved before `ToolExecution` identity is created and reflected in all three readers atomically: the `tool/call` audit records the rewritten arguments (the original retained in a sidecar field), derived history agrees with what executed, and presentation renders the rewritten arguments.
- The effective `ToolExecution.arguments` remains deeply frozen and non-writable throughout pre-policy, guards, dispatch, post-policy, and final observation; no mutation shim is introduced.
- The CC/Codex bridges honor `updatedInput` instead of logging the faithful-but-degraded warning.

## Risks

- Rewriting the `assistant/message` tool-call block changes what the model "sees it said"; whether any provider rejects that on replay is the open question that must be settled empirically before the decision shape freezes.
- An earlier rewrite phase changes the ordering relationship among `assistant/message`, `tool/call`, hook audit events, and execution; the design must pin that ordering without weakening turn enclosure or call/result adjacency.

## Open questions

- Does rewriting the `assistant/message` tool-call block corrupt any provider's expectation on replay, or is a separate correction safer?
- Should the original arguments be preserved on the `tool/call` event (audit) and, if so, under what field?
- Does the rewrite decision move before the log commit or become a dedicated earlier extension point, and how do existing pre-tool allow/deny hooks avoid running twice?
- How does this interact with a future permission `ask` flow (a user approving a rewritten call)?
