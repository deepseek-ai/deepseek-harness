---
kind: upgrade-guide
description: "PTC output overflow uses CODE_OUTPUT_LIMIT instead of CODE_RUN_FAILED."
---

# PTC output-limit error code

English | [中文](guide.zh.md)

## Change

`run_code` and program tools created by `createRunCodeTool` report runtime `output-limit` failures as `CodeRunFailedError` / `CODE_OUTPUT_LIMIT`, instead of `CODE_RUN_FAILED`. They remain failed tool results. Other failure codes and historical Session records are unchanged.

Inspected output or logs can overflow during execution, so this error does not confirm program completion. Earlier actions are not rolled back; retained output and settled subcall records remain available. The diagnostic directs callers to observe current state before retrying and reduce output without repeating completed actions.

## Migration

1. Update consumers that match `tool/result.error.code` to recognize `CODE_OUTPUT_LIMIT`. Do not infer that earlier actions failed or can safely be repeated.
2. Observe current application state before any retry. Reduce values passed to `inspect(...)` or the amount of logged text without replaying completed actions. To display a CUA screenshot, use `inspect(await window.getScreenshot())`.
3. Verify a program that dispatches an action and then exceeds its output budget reports `CODE_OUTPUT_LIMIT`, preserves its settled subcall record, and leaves the action applied exactly once. Verify the diagnostic does not claim program completion.
