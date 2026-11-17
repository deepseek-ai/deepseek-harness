---
kind: upgrade-guide
description: "Experimental and hook plugin tool failures record error codes, NativeError, OarFailure, and StagehandDrainError become HarnessError subclasses, and browser cleanup rejects with BrowserSessionError."
---

# Experimental plugin failures carry error codes

English | [中文](guide.zh.md)

## Change

Tool failures from the CUA, browser-use, Cua Driver, worktree, Ralph, terminal, OAR subagent, Liveshare, Claude Code and Codex hook, and claude-code-mods plugins now record `error: { name, code }` on `tool/result`; previously most of these results had no `error`. The [package READMEs](../../../../packages/experimental/README.md) list each class and code.

Code that handles these failures in-process sees these changes:

- `NativeError` from `@deepseek-ai/dsh-cua` and `OarFailure` from `@deepseek-ai/dsh-experimental-subagent-oar` now extend `HarnessError` from `@deepseek-ai/dsh-error`. `NativeError` keeps its name, codes, and `CODE: message` text. `OarFailure` drops its `stage` and `category` fields; the same summary stays in `message`, and `code` names the stage. Cancellation before an OAR run starts rejects with a `DOMException` named `AbortError` instead of an `OarFailure`.
- `StagehandDrainError` from `@deepseek-ai/dsh-experimental-browser-use-stagehand-native` now extends `StagehandError` and has the code `STAGEHAND_CLEANUP_FAILED`.
- `SessionResources.dispose()` from `@deepseek-ai/dsh-experimental-browser-use-runtime` rejects with `BrowserSessionError` (`BROWSER_CLEANUP_FAILED`) whose `cause` is the `AggregateError` it previously threw; `instanceof AggregateError` no longer matches.
- Liveshare guard functions return `{ reason, info }` instead of a reason string.
- Argument failures that now throw `ToolArgsError` show `invalid arguments: ` before the message the model sees, and a CUA screenshot request for a model without image input shows `MODEL_DOES_NOT_SUPPORT_IMAGES: ` before its message.

## Migration

1. If analytics or retry rules read `tool/result` `error`, add the new names and codes from the package READMEs. Earlier Session logs keep results without `error`.
2. Replace `instanceof AggregateError` checks on `SessionResources.dispose()` rejections with `instanceof BrowserSessionError` and read the individual failures from `error.cause.errors`.
3. Replace reads of `OarFailure.stage` or `category` with `error.code`.
4. If code catches `HarnessError` before `NativeError`, `OarFailure`, or `StagehandDrainError`, move the specific check first where the handling differs.
5. Confirm with `pnpm run typecheck` and your own failure-path tests.
