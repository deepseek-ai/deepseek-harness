# Agent Note: Hook budget and Lefthook suite budget on the Windows coverage lane

Status: implemented

English | [中文](2026-08-29-windows-lane-hook-and-lefthook-budget.zh.md)

## Problem

Two facts kept the Windows coverage lane failing on branches that touched neither the suite nor the gate.

[`scripts/install-lefthook.spec.ts`](../../../../scripts/install-lefthook.spec.ts) took a `describe`-level `{ timeout: 30_000 }`, restated as a `MULTI_PROCESS_TEST_TIMEOUT_MS` constant on five of its cases. Every case builds scratch worktrees and drives them through spawned Git and Node subprocesses, so the suite is bound by process creation rather than by its assertions. On an idle macOS host its slowest case costs 7.5 s, so the ceiling carried roughly fourfold headroom — where the [translation-pairing-merge suite](2026-08-27-translation-pairing-merge-budget.md) fired at 15 s with more than tenfold. Under the self-hosted Windows runners' multi-second process-creation spikes this suite has been observed reporting `Test timed out in 30000ms` on branches that did not touch it, and the two cases observed failing are its slowest and its seventh-slowest.

Separately, `coverageTestTimeoutArgs` in [`scripts/coverage-partitions.ts`](../../../../scripts/coverage-partitions.ts) raised `--testTimeout` and `--expect.poll.timeout` from `DSH_COVERAGE_TEST_TIMEOUT_MS` but left `--hookTimeout` at Vitest's separate 10 s default. Setup and teardown pay the same contention the raised test budget accounts for: [`removeFixtureSafely`](../../../../scripts/test-fixture-cleanup.ts) retries Windows handle release across a documented 10-second window, so an `afterEach` that exercises that window meets the hook default exactly. Raising only the test budget moves a contended suite's failure from the case to its teardown rather than removing it.

## Decision

The Lefthook suite takes `{ timeout: 90_000 }`, matching `DSH_COVERAGE_TEST_TIMEOUT_MS` in [`.github/workflows/ci.yml`](../../../../.github/workflows/ci.yml). The per-case constant is deleted rather than raised: it restated the `describe` value, and the translation-pairing-merge note already rejected per-case allowances because a later case added without one silently inherits a different ceiling.

`coverageTestTimeoutArgs` emits `--hookTimeout` beside the other two arguments. One environment variable governs one budget for the work a contended lane must finish, whether that work sits in a case or in its setup and teardown.

## Consequences

A `git` or `node` spawn spike on the shared-volume runners no longer decides either suite's outcome, and a slow fixture teardown no longer fails a suite whose cases all passed. Neither value measures how long the work needs: the Lefthook suite's slowest case completes in about 7.5 s on an idle host, and a raised ceiling does not slow a passing run.

Both budgets widen what counts as an acceptable duration, so a real slowdown into tens of seconds now passes where the previous ceilings would have caught it. That detection is traded away deliberately: those ceilings were firing on host contention rather than on regressions.

The hook change applies wherever `DSH_COVERAGE_TEST_TIMEOUT_MS` is set: the Windows coverage lane in [ci.yml](../../../../.github/workflows/ci.yml) and the `serial-windows` master standby in [ci-master.yml](../../../../.github/workflows/ci-master.yml) ([the serial-windows notices timeout note](../process/2026-08-31-serial-windows-notices-timeout-budget.md) records the second lane's adoption). Lanes that leave it unset keep every Vitest default, including the 10 s hook budget.

## Alternatives considered

**Give `--hookTimeout` its own environment variable.** Two knobs would describe one property of the host, and a lane that raised one without the other would reproduce this failure in the other direction.

**Shorten the `removeFixtureSafely` retry window instead.** That trades a cleanup failure for temp residue on the shared self-hosted `/tmp`, which has twice exhausted the host's inode capacity.

**Raise only the Lefthook suite and leave the hook default.** The suite's `afterEach` is exactly where its Windows `EPERM` cleanup failures appear, so the raised case budget would have surfaced the same run as a hook timeout.
