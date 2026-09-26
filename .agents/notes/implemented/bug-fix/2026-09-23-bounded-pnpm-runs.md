# Agent Note: Bounding a pnpm run that stops progressing

Status: implemented

English | [中文](2026-09-23-bounded-pnpm-runs.zh.md)

## Problem

A profile package operation could hold the profile write lock forever. A `dsh web` process held `~/.dsh/profiles/web/package.json.lock` for 22 minutes after its pnpm child printed `Done in 2s`: that child never exited, so the operation awaited an end that never came, the lock was never released, and every later management call in the process queued behind it. pnpm 11.13.0 consumes its one-shot worker-pool teardown once, re-creates the pool lazily afterwards, and unreferences a worker only during destruction, so the pool keeps the parent process alive with no repository-side change able to fix it.

A second cause reaches the same end by another route: a lifecycle script that inherited pnpm's stdout and stderr keeps those pipes open after pnpm exits, so a reader waiting for end of file never sees one, and the lock stays held while that reader waits.

## Decision

- A run completes when its process exits, not when its pipes end. The operation awaits the raw child's `exit` event and races execa's promise, which resolves only once the piped stdio closes.
- The pipes then drain under a fixed 2000 ms grace period, after which this operation closes them. Failure classification reads a tail pnpm writes before it exits, so the grace period belongs to finishing a run rather than to deployment configuration.
- Only the close this drain causes is ignored. A reading that failed before the cut still surfaces as the run's failure, and the log records that the tail was cut short.
- A run whose captured output stays silent for `idleTimeoutMs` is terminated, reports `timedOut` beside its own exit status, and is not asked of the next registry, which bounds how long one operation can hold the lock.
- A terminated run is classified `timeout` whatever exit status the signal left behind. Installation and removal report failure instead of success, so a manifest pnpm had half written is restored rather than activated.
- A terminated run stops its whole process tree and waits for it to disappear before the caller restores the profile and releases the lock, because an approved lifecycle script runs as a child of pnpm and outlives it. execa's `killDescendants` addresses the tree on every kill path, including cancellation, and is passed only for a captured run, so a run that inherits the terminal keeps the caller's process group.
- `dsh plugin` inherits the caller's terminal and captures nothing, so no silence bound applies to it and its operator keeps the ability to interrupt.

## Why a silence bound rather than a duration bound

A capture-only run that prints nothing for ten minutes is stuck: pnpm reports its own progress and its scripts' output there. A total duration bound would instead kill legitimate work, because a non-TTY pnpm prints a build script's output when that script finishes, and a native build on a slow machine compiles silently for longer than any fixed budget we could justify for it. Silence separates a stalled run from a slow one without guessing a duration, and 600000 ms leaves an approved build ten times the slowest silent stretch maintainers expect from it.

## Alternatives considered

**Wait for execa's promise.** execa resolves after the piped stdio ends, which is the end a held pipe withholds, so the completion signal had to move to the process itself.

**Bound total duration instead of silence.** A stalled run and a compiling run are indistinguishable by duration alone, and the bound would destroy legitimate work whenever the machine is slow enough.

**Terminate only the pnpm process.** An approved `postinstall` keeps writing into the profile after the operation reports a timeout and releases the lock, so a later restoration races that script. Reproduced with a local dependency whose postinstall writes a file, and with pnpm 11.13.0.

**Detach the run and reap the tree later.** Rollback and lock release must happen after the tree stopped writing, and deferring the reap leaves open exactly the window this decision closes.

**Keep the pipes as the completion signal and bound only that wait.** The drain does bound the wait, but a stalled worker pool never ends its pipes, so the process exit remains the completion signal.

## Testing

| Evidence | Behaviour |
|---|---|
| [operations.spec.ts](../../../../packages/boot/plugin-manager/tests/operations.spec.ts) | Silence-bound termination, a run that trapped the signal and exited 0, the bounded drain over a held pipe, a reading failure that still surfaces through the cut, a rejection reason that is not an Error, and the cut notice. |
| [operations-process.spec.ts](../../../../packages/boot/plugin-manager/tests/operations-process.spec.ts) | Real descendants: a pipe that outlives its process still drains, and a stalled run's tree is stopped before the operation returns, so a marker its script would have written never appears. |
| [run-tree.spec.ts](../../../../packages/boot/plugin-manager/tests/run-tree.spec.ts) | Platform group-leadership decisions, the probe target each platform addresses, and the wait bound. |
| [manager.spec.ts](../../../../packages/boot/plugin-manager/tests/manager.spec.ts) | A terminated run that exited 0 restores the manifest, reports `timeout`, and is not activated; a terminated removal reports failure. |

The real-process cases cover POSIX only: Windows cannot stage a descendant that keeps inherited pipes open past its parent, and the drain itself is platform-independent. With those cases skipped, the mocked cases still hold the per-file coverage gate on Windows.

## Related

[Guided plugin installation](../architecture/2026-09-15-guided-plugin-installation.md) remains the owner of what an installation or removal does with a finished run: the manifest snapshot it restores, the classification it renders, and the cancellation contract. This note owns only how a run ends and how long it may hold the profile lock.

## Consequences

- A stalled run is reported up to `idleTimeoutMs` late and the profile lock is held for that long. A silent but healthy native build longer than the default is killed and classified `timeout`; a profile that compiles such a dependency raises `idleTimeoutMs`, trading slower stall detection for tolerance.
- A cut tail is incomplete, so the failure classification and the returned output see only what pnpm wrote inside the grace period. The diagnostic log records the cut.
- Terminating a run kills its whole tree, so a lifecycle script that had already started is stopped instead of being allowed to finish.
- The bound is a workaround for a third-party defect (issue #4981, PR #4982) and becomes unnecessary once pnpm tears down its worker pool before a command returns.
