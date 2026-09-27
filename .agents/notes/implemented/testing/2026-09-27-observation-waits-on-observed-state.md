# Agent Note: Windows-lane observations wait on the state they read

Status: implemented

English | [中文](2026-09-27-observation-waits-on-observed-state.zh.md)

## Problem

Two self-hosted Windows lane cases observed state through a wall-clock window instead of the state they assert on.

`packages/boot/plugin-manager/tests/operations.spec.ts` armed a 100 ms timer when the case started and read the profile's `run.json` when it fired, to observe the run record while the run was still in flight. The repaired installation it observes runs only after a refused installation, a `pnpm view` lookup, the restoration of the profile files, and a second `launch`, so the timer measured that whole prefix rather than the record write. Under the loaded runner the repair began after the deadline and the case failed with `expected null to deeply equal { pid: 4343, grouped: false }` (PR #4595 `windows node 24 / coverage`, job 108402945554, 2026-09-26; the case took 345 ms, and its sibling single-run cases, which need no such prefix, passed in 113 ms and 116 ms).

`packages/shell/tool-pwsh-persistent/tests/loader-composition.spec.ts` counts each send's settlement tier and requires the controlled-prompt fast path, but reported only the count, so a failure could not say which tier settled which send — the one fact that separates a degraded readiness path from a mis-sized window.

## Decision

`observingChild` stays in flight until the test has read the run record, so the read cannot race the run's end, and its bounded wait starts at the mocked launcher's hand-over instead of at test start: the recorded run is one atomic write that follows the launch, so the bound only has to cover that write. `RECORD_WAIT_MS` (2 s) is deliberately below the case budget, so a record that never appears reports as the assertion that names it rather than as a runner timeout. Both the repair-install case and the single-run case hand the child over through the same `spawned` hook.

The loader-composition settle-reason assertion carries `JSON.stringify(settleReasons)` as its failure message. The threshold and the assertions are unchanged.

## Alternatives considered

**Raise the fixed timer, or poll for the record from test start.** Rejected: both keep the window anchored before the operation reached the run it observes, so the bound has to cover the whole prefix and grows with whatever the runner does before the repair run — the same mistake at a larger size. Anchoring on the hand-over measures only the state transition being waited for.

**Wait for the record without a bound.** Rejected: a record the operation never writes would hang the case until the runner's own timeout and report nothing about the record.

**Record only the settlements that matter, or assert a subset of sends.** Rejected: it weakens what the suite pins — that no send falls back to the silence tier — to make the failure go away.

## Consequences

Both plugin-manager record cases now observe the record while the run is in flight on a loaded runner, and a genuinely missing record still fails the same assertion. The bounded wait costs 2 s only when the operation never writes the record.

## Deferred

The loader-composition failure of 2026-09-25/26 remains unexplained. On Windows `isStdinWaiting` returns false and `foregroundPgid` returns the shell pid, so `stdin_read` can only come from the controlled-prompt tail; the three failing runs settled one or two of seven sends on that prompt, and their durations (17.5 s, 20.9 s against 4.7 s healthy) match one silence tier per degraded send while every output assertion passed. A fourth run timed out at the case bound. Native Windows reproduction was unavailable for this change (the local guest rejected its guest-operations credentials), so the assertion, the session's readiness path, and the prompt installation are unchanged; the next failure now names the tiers each send settled on.
