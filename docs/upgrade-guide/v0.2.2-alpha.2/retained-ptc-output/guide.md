---
kind: upgrade-guide
description: "Retained Node PTC environments stop reporting inherited native output."
---

# Retained PTC output and unfinished tools

English | [中文](guide.zh.md)

## Change

In retained Node PTC environments, raw inherited stdout/stderr no longer appears in program logs because it cannot be attributed to one evaluation. Previously, bytes arriving during a program could belong to an earlier child process. Captured `console` and `process.stdout.write` / `process.stderr.write` remain supported; raw stderr remains available in process-exit diagnostics.

In retained Node environments, unfinished tool calls reject when their evaluation ends or is canceled. Temporary executions leave unfinished promises pending after completion until the process exits. User `catch` and `finally` handlers can run, but ended evaluations cannot start new tool calls or emit captured output. Arbitrary user Promises and callbacks have no cancellation guarantee.

## Migration

1. In retained `run_code` programs, collect subprocess output explicitly and print it with `console.log`, or use the SDK's `tools.bash` result instead of `stdio: "inherit"`.
2. Await every tool call before returning. Await required cleanup; forced process termination cannot run JavaScript cleanup handlers.
3. Upgrade any preinstalled `launch.bootstrapPath` with the host; control messages now carry evaluation identities, and the readiness handshake rejects a mismatched bootstrap before dispatch.
4. Run the program twice and confirm each result contains only its own output and awaited tool results. See the [Node runtime limitations](../../../../packages/ptc-runtime/ptc-runtime-node/README.md#known-limitations-and-deferred-work).
