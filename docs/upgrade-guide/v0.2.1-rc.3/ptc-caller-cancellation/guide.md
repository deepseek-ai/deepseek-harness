---
kind: upgrade-guide
description: "Caller-cancelled run_code results use ABORTED instead of CODE_RUN_FAILED."
---

# PTC caller cancellation uses the standard tool error code

English | [中文](guide.zh.md)

## Change

When a running `run_code` call is cancelled by its caller and the runtime reports `abort`, its `tool/result` error changes from `CodeRunFailedError` / `CODE_RUN_FAILED` to `AbortError` / `ABORTED`. The result content is `Error: tool call aborted`, replacing the runtime diagnostic, captured output and sandbox summary. SDK clients and Session consumers that classify these results are affected.

The Agent continues to record the specific cancellation cause in `turn/end`, including a hook's `reason`. Runtime failures such as timeout and cleanup failure, and runtime-local cancellation without caller cancellation, retain `CODE_RUN_FAILED`. Cancellation still waits for cleanup; it does not roll back completed tool effects, and retained runtime variables may be cleared.

## Migration

1. In consumers of new `tool/result` events, classify caller cancellation by `data.error.code === 'ABORTED'`. Read the Agent cancellation cause from the corresponding `turn/end` event's `data.reason.reason` when `data.reason.kind === 'aborted'`.
2. Keep support for `CODE_RUN_FAILED` when reading historical PTC cancellation results. Existing Session logs are not rewritten.
3. Cancel a running `run_code` call and confirm its result has code `ABORTED`, followed by a `turn/end` event containing the original Agent cancellation cause. Confirm ordinary runtime failures still report `CODE_RUN_FAILED`.
