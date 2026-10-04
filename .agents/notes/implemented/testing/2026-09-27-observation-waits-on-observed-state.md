# Agent Note: Windows-lane observations wait on the state they read

Status: implemented

English | [中文](2026-09-27-observation-waits-on-observed-state.zh.md)

## Problem

Two self-hosted Windows lane cases observed state through a wall-clock window instead of the state they assert on.

`packages/boot/plugin-manager/tests/operations.spec.ts` armed a 100 ms timer when the case started and read the profile's `run.json` when it fired, to observe the run record while the run was still in flight. The repaired installation it observes runs only after a refused installation, a `pnpm view` lookup, the restoration of the profile files, and a second `launch`, so the timer measured that whole prefix rather than the record write. Under the loaded runner the repair began after the deadline and the case failed with `expected null to deeply equal { pid: 4343, grouped: false }` (PR #4595 `windows node 24 / coverage`, job 108402945554, 2026-09-26; the case took 345 ms, and its sibling single-run cases, which need no such prefix, passed in 113 ms and 116 ms).

`packages/shell/tool-pwsh-persistent/tests/loader-composition.spec.ts` counts each send's settlement tier and requires the controlled-prompt fast path, but reported only the count, so a failure could not say which tier settled which send — the one fact that separates a degraded readiness path from a mis-sized window.

## Decision

`observingChild` stays in flight until the test has read the run record, so the read cannot race the run's end, and its bounded wait starts at the mocked launcher's hand-over instead of at test start: the recorded run is one atomic write that follows the launch, so the bound only has to cover that write. `RECORD_WAIT_MS` (2 s) is deliberately below the case budget, so a record that never appears reports as the assertion that names it rather than as a runner timeout. Both the repair-install case and the single-run case hand the child over through the same `spawned` hook.

The loader-composition settle-reason assertions carry the recorded reasons and a per-send readiness timeline in their failure message: every decoded pty chunk with the sanitizer's marker verdict and prompt tail, every foreground poll result, every input write, each send's settle reason and elapsed time, the session's prompt evidence replayed from those chunks, and the host, shell, PSReadLine, and console-host versions. `onTestFailed` prints the same timeline when the runner's budget ends the case before the assertions. The threshold and the assertions are unchanged.

## Alternatives considered

**Raise the fixed timer, or poll for the record from test start.** Rejected: both keep the window anchored before the operation reached the run it observes, so the bound has to cover the whole prefix and grows with whatever the runner does before the repair run — the same mistake at a larger size. Anchoring on the hand-over measures only the state transition being waited for.

**Wait for the record without a bound.** Rejected: a record the operation never writes would hang the case until the runner's own timeout and report nothing about the record.

**Record only the settlements that matter, or assert a subset of sends.** Rejected: it weakens what the suite pins — that no send falls back to the silence tier — to make the failure go away.

## Consequences

Both plugin-manager record cases now observe the record while the run is in flight on a loaded runner, and a genuinely missing record still fails the same assertion. The bounded wait costs 2 s only when the operation never writes the record.

The [archived task-detail close diagnosis](../../archived/testing/2026-09-28-detail-close-waits-on-observed-state.md) records the same rule in a Web client case, where the sampled state landed in a passive effect one commit after the list the case had awaited.

## Deferred

The loader-composition failure on the self-hosted Windows lane (2026-09-25..27, issue #2487) remains open, and its mechanism is not a stalled prompt tail. The master run before the [prompt tail grace](../bug-fix/2026-09-27-pwsh-prompt-tail-grace.md) landed (run 36309006133, 2026-09-27 09:19Z) and the first run carrying it with `promptTailGraceMs: 5000` in this composition (run 36326153388, 14:30Z, reasons `["stdin_read","inferred_idle","inferred_idle","inferred_idle","inferred_idle","session_exit","inferred_idle"]`) both took 20.8 s, so the degraded sends settled at the plain `idleSilenceMs + handoffGraceMs` bound: either no marker was seen, or a marker was seen and its tail was invalidated by later printable text — the two states the tolerance does not cover. The foreground comparison is not a candidate on Windows: `WindowsProcessInspector.foregroundPgid` returns the shell pid unconditionally and `isStdinWaiting` returns false, so `shellPgid` always matches and `stdin_read` can only come from the controlled-prompt tail. The composition therefore keeps the field at its product default of `0`, and the failure message's timeline names the state directly the next time the lane fails; the 2026-09-27 12:51Z run (36320394583) instead hit the 120 s case budget before any assertion, which the same print covers.

Native evidence with pwsh 7.6.6 and PSReadLine 2.4.5 on Windows 11 25H2 (conhost 10.0.26100.1; the probes the tail-grace note cites ran under Windows PowerShell 5.1, the guest's only preinstalled shell): the case settles every send on the prompt at baseline, under eight CPU burners plus disk churn, under emulated x64 Node, under `vitest run --coverage --maxWorkers=1`, and with a 12-row viewport that scrolls from the second command, each prompt arriving as one in-order marker chunk followed by the five-byte tail. With an 8-row, 60-column viewport ConPTY re-emits the stored `133;D` mark inside repaint frames — five markers in one send, one followed by repainted row text (`\x07\e[Hdsh> Write-Output …`) — which leaves a tail that is not a prefix of the controlled prompt; on that console host the real prompt's marker still arrived last and the send settled `stdin_read`. That repaint path is the leading hypothesis for the lane, whose Windows build and console-host version are unknown (the job logs carry neither and the pool has no dispatchable job); the failure message records `os.release()`, `os.version()`, the pwsh and PSReadLine versions, and `conhost.exe`'s file version, and `dsh-subprocess-local` spawns node-pty without `useConptyDll`, so the system console host is the one in play. The pid `0` those probes also exposed on Windows is a separate defect, tracked by issue #5297.
