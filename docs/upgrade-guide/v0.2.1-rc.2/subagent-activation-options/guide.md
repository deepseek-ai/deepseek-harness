---
kind: upgrade-guide
description: "SubagentActivationSpec accepts task options directly instead of a nested request object."
---

# Subagent activation options

English | [中文](guide.zh.md)

## Change

Plugin code calling `ctx.subagents.startActivation()` must pass `prompt`, `parent`, and optional execution settings directly on `SubagentActivationSpec`. The nested `request` field is removed. Type names, provider requests, cancellation, and result delivery are unchanged.

## Migration

1. In each `startActivation()` call, move the fields from `request` to the outer object. For an existing task object, replace `request: task` with `...task`; keep the activation's `label` and `signal` after the spread so they take precedence.
2. Replace reads such as `spec.request.prompt` with `spec.prompt`. Keep backend `SubagentStartRequest` implementations unchanged.
3. Typecheck the plugin and run its delegation tests to verify the updated calls.
