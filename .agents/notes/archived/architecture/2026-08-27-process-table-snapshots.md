# Agent Note: Process-table snapshots replace per-question inspector reads

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-27-process-table-snapshots.zh.md)

## Problem

A terminal readiness poll asks the platform three questions: the shell's descendant tree, its POSIX session membership, and whether each tracked descendant is still running. When each question reads the process table independently, the poll's cost scales with the number of descendants the running command spawned.

On macOS each read is a `/bin/ps -axo` fork that parses the entire table — 14.33 ms for 795 processes on the measured host. `LocalTerminalHandle.inspectForeground()` reads the tree once and then asks liveness once per tracked descendant, so one poll costs N+1 table reads for N descendants. `dsh-terminal-bash` polls every 50 ms for up to 30 s, and `ProcessInspectorInternals.exec` is `execFileSync`, so each poll blocks the event loop for its full duration.

Measured by driving the production `MacProcessInspector` against a real process tree:

| tracked descendants | one poll | share of the 50 ms interval |
|---|---|---|
| 0 | 18.0 ms | 36% |
| 1 | 33.8 ms | 68% |
| 2 | 49.1 ms | 98% |
| 5 | 87.1 ms | 174% |
| 10 | 178.4 ms | 357% |

Any command spawning two or more children — a pipeline, `make`, `pnpm`, `git` — saturates the host event loop until it exits.

Teardown has the same structure. `signalProcess` fences each signal against PID reuse by asking liveness itself, so signalling N members costs N table reads.

## Decision

`ProcessInspector.snapshot()` returns a `ProcessSnapshot`, one observation of the process table that answers `tree(rootPid)`, `session(sessionId)`, and `alive(identity)`. It replaces the three per-question methods; the inspector's remaining surface is `foregroundPgid`, `isStdinWaiting`, `signalGroup`, and `signalProcess`.

Each caller captures one snapshot and answers every question of a single pass from it. `LocalTerminalHandle.descendants()` takes a snapshot, reads the tree and session from it, and filters survivors through the same `alive`, so a readiness poll costs one table read regardless of descendant count. `waitForMembers` captures a fresh snapshot per polling iteration, because its whole purpose is observing change.

Signalling does not share that observation. `ProcessInspector.isAlive(identity)` answers current state from the narrowest per-identity source a platform offers — one `/proc/<pid>/stat` read on Linux, one `ps` table on macOS, one process-handle check on Windows — and `signalProcess` takes that fence immediately before delivering the signal. An observation cannot stand in for it: the observation preserves the original PID-to-start-time pairing, so a recycled PID would still match it and take a signal meant for the process that exited. Reading the fence per target also keeps a failed read costing one target instead of the rest of a teardown round, which is what the [synchronous exit-cleanup contract](../bug-fix/2026-08-11-synchronous-subprocess-exit-cleanup.md) requires.

`signalMembers` and `waitForMembers` return before capturing anything when a round has no members, so a command that spawned no descendants pays no table read for its teardown sweeps.

Platform differences live in how a snapshot is built, not in what it promises:

- **macOS** builds it from one `ps` table. That table exposes neither a session id nor a state column, so `session` is empty and `alive` reports presence with a matching start identity.
- **Linux** walks `/proc` once, carrying each entry's parent, start identity, session, and state. `alive` treats the `Z`, `X`, and `x` states as quiescent, as a per-pid `stat` read did.
- **Windows** enumerates Toolhelp32 lazily, on the first `tree` question. It has no POSIX sessions, and answers `alive` from the live process handle, because wait state is not a table column there — so a snapshot asked only for liveness never enumerates. The terminal's Windows teardown polls liveness every 25 ms and would otherwise walk and discard the whole table each time.

`PosixProcessSnapshot` holds both POSIX shapes: a row's `session` and `state` are `undefined` where the platform's table omits them, which is what makes the macOS answers fall out of the shared implementation instead of a second class.

## Testing

`packages/subprocess/subprocess-local/tests/terminal.spec.ts` drives a real `MacProcessInspector` over an injected `exec` and asserts one foreground inspection performs exactly one `-axo` table read at 0, 2, and 10 descendants. That count, not wall time, is the durable invariant: it holds on any host and fails the moment a caller re-reads the table per member. The same file pins that a signalling round with no members captures nothing, and that a capture failure during synchronous host exit still lets the PTY root be killed.

`process-inspector.spec.ts` pins the fence directly: an identity observed alive and then absent from the table takes no signal. `windows-inspector.spec.ts` pins that a snapshot answering only liveness performs no Toolhelp32 enumeration.

## Alternatives considered

**A batched `aliveMembers(members)` call, leaving the other methods alone.** This collapses the per-member reads and is a much smaller edit, but the tree read stays separate, so a macOS poll still forks `ps` twice plus the `tpgid` read — about 32 ms at 10 descendants, still 64% of the 50 ms interval. The event loop remains mostly blocked, so the measured problem survives the fix.

**Caching the macOS table inside `MacProcessInspector` behind a short TTL.** This needs no interface change, but it makes staleness invisible: a caller cannot tell whether a liveness answer came from this instant or from the end of the previous poll, and a signal decided on a stale row is exactly what the PID-reuse fence exists to prevent. Hidden caching also conflicts with the repository's preference for explicit defaulting and explicit boundaries.

**Fencing signals with the round's shared observation.** This removes the last per-member read and was the shape first implemented here. Review rejected it: the fence exists to defeat PID reuse, and an observation defeats the fence instead, because it carries the original PID-to-start-time pairing forward. The window is narrow — the kills in one round are microseconds apart, against a PID space of 99999 on macOS and 4194304 on Linux — but the `README` states the guarantee without qualification, and buying microseconds of teardown time by weakening it is the wrong trade. Keeping both `snapshot().alive` and `isAlive` is therefore not two ways to ask one question: one asks what the table showed, the other asks what is true now, and only the second may decide a signal.

**Making `exec` asynchronous instead of reducing the read count.** An async `execFile` stops the poll from blocking the loop but still forks N+1 processes per poll; on a busy machine that trades a stall for sustained fork pressure. It remains a worthwhile follow-up on top of the reduced count, not a substitute for it.

## Consequences

A readiness poll's process-table cost is now constant in descendant count. On macOS one poll performs one full table read plus the small `tpgid` read, which is the 0-descendant cost in the table above for every descendant count.

Teardown keeps its previous per-signal cost: one narrow liveness read per target, which on macOS is one `ps` fork per member. That cost was never the measured problem — a terminal tears down once, while its readiness path polls up to 600 times — so the fix deliberately spends it to keep the fence reading current state.

A snapshot is a point-in-time view, and the type's documentation says so. `waitForMembers` re-captures per iteration because observing change is its purpose, and no signal is ever decided from a captured view.

Every `ProcessInspector` implementation and test fake carries the new shape, including the Windows inspector and the `dsh-terminal-bash` session fake. Test fakes that previously replaced `processTree`, `processSession`, or `isAlive` to stage a scan now replace the corresponding per-question read hook, which keeps their staging behavior and call-counting identical.

The synchronous `execFileSync` boundary and the fixed 50 ms poll interval are unchanged; both remain open follow-ups for the same readiness path.
