---
kind: upgrade-guide
description: "PTC output failures use distinct structured error codes instead of CODE_RUN_FAILED."
---

# PTC output failure codes

English | [中文](guide.zh.md)

## Change

`run_code` reports invalid completion values with `CodeRunFailedError` / `CODE_OUTPUT_INVALID`, and output-budget overflow with `CodeRunFailedError` / `CODE_OUTPUT_LIMIT`. Previously both used `CODE_RUN_FAILED`. They remain failed tool results. Other execution failures retain `CODE_RUN_FAILED`; caller cancellation retains `AbortError` / `ABORTED`. Historical Session records are unchanged.

Invalid completion means the program reached its end but could not return lossless JSON. Output overflow can interrupt execution and does not confirm completion. Neither rolls back earlier actions; settled subcall records and captured logs remain available.

## Migration

1. Update consumers that match `tool/result.error.code` to recognize the two output codes. Do not interpret either as evidence that earlier actions failed or are safe to repeat.
2. Observe current application state before any retry. Correct the completion value or reduce output without replaying completed actions. For CUA screenshots that already emit images, use `void await window.getScreenshot()` instead of returning the byte array.
3. Verify a program that dispatches an action and returns a non-JSON value reports `CODE_OUTPUT_INVALID`, retains its subcall evidence, and leaves the action applied exactly once. Verify overflow reports `CODE_OUTPUT_LIMIT` without claiming program completion.
