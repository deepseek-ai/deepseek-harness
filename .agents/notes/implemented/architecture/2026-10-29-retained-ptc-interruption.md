# Agent Note: Retained PTC interruption

Status: implemented

English | [中文](2026-10-29-retained-ptc-interruption.zh.md)

## Problem

Terminating a retained Node process on every timeout or cancellation loses unrelated application objects and imported modules. A control handler on the evaluation thread cannot stop a synchronous loop. The [in-memory execution decision](2026-09-23-best-effort-persistent-ptc.md) still owns disposable state and Session behavior; this decision replaces its timeout and cancellation cleanup policy.

## Decision

The host revokes execution authority immediately and requests cooperative stop over the existing control channel. The runtime rejects pending bindings; the original `run()` response confirms that evaluation has settled. Revocation is a one-way notification. The ordered pipe and single active evaluation determine notification ownership; RPC requests associate replies with callers. Acknowledgment permits reuse of the VM and retained objects; earlier mutations remain. Callers await acknowledgment or fallback process cleanup before starting another evaluation.

The host bounds acknowledgment with `stopGraceMs`. Missing or failed acknowledgment terminates the managed process range and awaits cleanup. Results retain the original timeout or cancellation kind and report whether variables survived. Confirmed termination allows a fresh environment on the next call; failed cleanup blocks reuse until host release succeeds. Explicit reset, disposal and policy invalidation terminate immediately. Reset uses the existing release path and exposes no additional model tool.

## Alternatives considered

Unconditional termination unnecessarily discards state during ordinary asynchronous waits. Cooperative stop alone cannot bound synchronous loops. Inspector termination is unsuitable as a state-preserving default: local probes on Node 24.9 and 26.6 crashed native async-context handling when terminating an awaited VM loop with an enabled async hook; Node 24 REPL also crashed without an explicit user hook. A successful Inspector command does not establish that the runtime remains reusable. Any future forced in-process interruption must demonstrate safe recovery with the supported Node versions and async hooks.

## Consequences

Canceled tools throw normally, allowing user `catch` and `finally` handlers to run. A blocked handler or unresolved user Promise prevents acknowledgment and triggers fallback termination. Timers, arbitrary user Promises, I/O callbacks and user-created Workers or subprocesses have no per-evaluation cancellation guarantee and can still mutate retained state after acknowledgment. Acknowledgment confirms revocation of managed execution, not cancellation of all Node activity. Fallback termination loses all state in that process; neither path rolls back external effects. Host reset remains available when retained resources cannot be trusted.
