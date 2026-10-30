---
kind: upgrade-guide
description: "Retained Node PTC uses cooperative stop on timeout or cancellation, with process termination when acknowledgment fails."
---

# Retained PTC timeout recovery

English | [中文](guide.zh.md)

## Change

Timeouts and cancellation in `persistent-in-memory` mode and `vm-script` with `scriptPersistence: true` request cooperative stop. Previously, they always cleared the environment. Canceled tool calls throw, allowing `catch` and `finally` to run. Stop acknowledgment waits for the evaluation to settle and preserves variables and earlier mutations. The host waits up to `stopGraceMs` (default `3000`) for acknowledgment, then terminates the managed process range if acknowledgment is missing or fails. A blocked loop therefore still loses state. Temporary execution continues to terminate its process.

The runtime returns after acknowledgment or fallback cleanup, with the original `timeout` or `abort` kind and a diagnostic stating whether variables survived. Confirmed termination allows the next call to create an empty environment. Failed cleanup returns `worker-exit` and blocks reuse until host release succeeds. Timers, arbitrary user Promises, I/O callbacks, Workers and subprocesses have no per-evaluation cancellation guarantee; acknowledgment does not mean all Node activity has stopped.

## Migration

1. Check the reported state outcome instead of assuming that timeout or cancellation clears variables. Reuse retained bindings; recreate them after fallback termination. Earlier effects are not rolled back.
2. Use the host's `PtcExecutor.reset(agent)` or runtime `release(owner)` if cleanup failed or retained resources cannot be trusted. No reset tool is exposed to the model. Await reset before running more code.
3. Set `stopGraceMs` in the `@deepseek-ai/dsh-ptc-runtime-node` configuration if needed. It bounds acknowledgment separately from the existing process-cleanup `graceMs`. Verify that an asynchronous wait preserves an earlier variable and a blocked loop clears it. See the [runtime reference](../../../../packages/ptc-runtime/ptc-runtime-node/README.md).
4. When `launch.bootstrapPath` points to a separately installed Node bootstrap, upgrade it with the host. Readiness checks the protocol revision before dispatch; an older bootstrap reports `bootstrap protocol mismatch` instead of running code.
