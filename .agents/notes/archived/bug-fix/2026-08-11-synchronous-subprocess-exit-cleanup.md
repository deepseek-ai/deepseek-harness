# Agent Note: Synchronous cleanup of managed subprocesses on host exit

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-11-synchronous-subprocess-exit-cleanup.zh.md)

## Problem

The local subprocess provider owns ordinary detached process trees and terminal sessions, but it previously reached them only through asynchronous Cordis disposal. A fatal launcher may call `process.exit()` before that disposal finishes: the [fail-loud release](2026-07-31-fail-loud-releases-the-terminal.md) waits at most two seconds, while a local process can have a longer termination grace. Once Node enters its synchronous exit phase, pending promises and escalation timers do not continue, so a TERM-resistant child can outlive the host and keep CPU, memory, or ports. Some ACP, JSON-RPC, and SDK entry points also have no root release callback.

The public subprocess seam correctly promises awaited quiescence during normal disposal. The defect is a separate final host-exit path below that seam, not a reason to weaken the normal lifecycle or duplicate process ownership in every launcher.

## Decision

`LocalSubprocessRuntime` installs one synchronous Node `exit` listener in its Cordis effect. The same effect removes the listener only after normal disposal settles. Ordinary and terminal handles remain in the service's existing live sets while asynchronous cleanup is pending, so a shorter outer exit bound still sees and force-terminates them. If awaited disposal reports a cleanup failure, the service invokes the same synchronous final operations before clearing the sets and removing the listener.

The listener uses local-only final operations that are absent from the public `SubprocessHandle` and `SubprocessTerminalHandle` interfaces:

- An ordinary handle immediately sends SIGKILL to its detached POSIX process group or runs synchronous `taskkill /PID <pid> /T /F` on Windows.
- A terminal handle synchronously signals every captured and currently observable descendant with SIGKILL, kills the PTY root, then rescans once for members that became observable during that boundary.
- The service contains each target's failure and continues with the remaining handles. The callback creates no promise or timer, writes no diagnostic, and does not change the original exit code or error.

Normal disposal remains the [subprocess seam's](../architecture/2026-07-26-subprocess-seam.md) terminate-and-join path: ordinary trees receive TERM, the configured grace, then KILL, and every ordinary or terminal cleanup is awaited to quiescence. The synchronous path requests final termination but does not publish a completion result or claim the OS tree is already gone when the callback returns. Remote providers retain their own sandbox ownership and do not inherit a local Node listener.

| Host path | Local provider action | Completion evidence |
| --- | --- | --- |
| Normal Cordis disposal | Cooperative termination, bounded escalation, and awaited ordinary/terminal cleanup | Every owned handle reaches quiescence before disposal settles |
| `process.exit()`, default uncaught exception, or default unhandled rejection | Synchronous final signals against the service's current live sets | External observation after the host exits |
| Default termination for an unhandled `SIGTERM`, `SIGINT`, or `SIGHUP`; `SIGKILL`; fatal OOM; `process.abort()`; native crash; or power loss | No in-process action can run | External supervisor, container, or OS ownership is required unless the application installs a signal handler that performs disposal or calls `process.exit()` |

## Verification

A parent test starts an isolated TypeScript host through the repository source launcher, waits until exact root and descendant process identities are observable, then allows the host to take each fatal path. Direct exit, default uncaught exception, and default unhandled rejection cover ordinary TERM-resistant trees; direct exit also covers a real terminal root and descendant. The parent asserts the original host exit category and waits for every recorded process to disappear, while failure cleanup targets only recorded identities or the recorded Windows tree.

Unit evidence pins synchronous POSIX group and Windows taskkill delivery, terminal scans before and after the PTY root kill, repeated finalization, per-target failure containment, normal TERM-to-KILL disposal, live-set retention during pending disposal, and listener removal after disposal.

## Alternatives considered

**Rely only on launcher release callbacks.** Rejected because not every entry point supplies one, and a bounded release can still end before the subprocess provider's grace and timers complete.

**Call the existing asynchronous `terminate()` methods from the `exit` listener.** Rejected because Node does not await exit listeners; promises, timers, output draining, and quiescence polling cannot finish after the callback returns.

**Add a public raw `forceKill()` operation to subprocess handles.** Rejected because consumers need one cooperative termination contract. Immediate final termination is an implementation responsibility used only by the local service's host-exit owner.

**Delegate every failure mode to an external supervisor.** Rejected as the only solution because Node exposes a reliable synchronous callback for several common fatal paths and the provider already owns the exact targets. External ownership remains necessary when JavaScript cannot run.

## Consequences

Each active local subprocess service contributes one process-global exit listener, removed with the service effect. Fatal exit gives up grace, output draining, and an in-process quiescence proof in exchange for issuing the strongest available local termination before the host disappears. Normal disposal keeps those guarantees and costs unchanged.

The listener cannot cover failures that do not execute JavaScript, and it cannot discover a terminal descendant that escaped before the provider ever observed it; that separate ownership gap remains tracked by Issue #1726.
