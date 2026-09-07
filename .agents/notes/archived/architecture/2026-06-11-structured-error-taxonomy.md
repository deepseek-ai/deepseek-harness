# Agent Note: Structured error taxonomy

Status: implemented
Archived: 2026-09-04

English | [中文](2026-06-11-structured-error-taxonomy.zh.md)

## Problem

Failures crossed seams as bare strings. A tool error flattened to a text block — name, code, and stack lost — so a future sandbox/retry plugin couldn't tell ENOENT from EACCES, and the model got less actionable feedback than it could. A non-Error throw degraded further: the loop wrapped it in `new Error(String(x))`, dropping any code. And `LlmError` was the only typed error in the system, with no shared base, so there was nothing for a consumer to `instanceof` against generically.

## Decision

A single `HarnessError extends Error` base in `dsh-llm` (the leaf package every other imports — no new dependency edge): a stable `code` distinct from `message`, `cause` chaining via `ErrorOptions`, and `name` defaulting to the subclass. `isHarnessError` narrows at seams.

- `LlmError` and `ToolArgsError` (dsh-tools) extend it, keeping their existing codes.
- `ToolExecutionResult` gains optional `error: { name, code }`, populated in the registry's catch when the thrown value is a `HarnessError`. The agent loop forwards it onto the `tool/result` session event (which gained the same optional field), so the structured failure survives into the log for retry/sandbox plugins and replay. The model-facing text block is unchanged.
- The loop's `toError` wraps a non-Error throw in a `HarnessError` (`code: 'UNKNOWN'`, original chained as `cause`) instead of a bare `Error`, so even a bad throw carries a routable code into the session `error` event (which already surfaced `code`).

## Consequences

- Errors are machine-routable end-to-end: a plugin can branch on `error.code` rather than substring-matching a message.
- One base class is imported widely, but it lives in the package everyone already depends on, so the cost is a single import, not a new edge.
- `deriveMessages` does not surface `error` into model history — the model still sees the text block; the structured field is for code and replay.
- Argument validation retains its existing code and behavior; package-owned diagnostic invariants carry their stable code independently so the invariant registry does not import a product package. The shared base adds cross-seam routing metadata without changing model-facing text.

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
