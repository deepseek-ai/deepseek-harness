# Agent Note: Coverage-lane budget for the translation-pairing-merge suite

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-27-translation-pairing-merge-budget.zh.md)

## Problem

[`scripts/translation-pairing-merge.spec.ts`](../../../../scripts/translation-pairing-merge.spec.ts) took a `describe`-level `{ timeout: 15_000 }`. All 23 of its cases inherit that value; none carries an allowance of its own.

Every case builds a scratch repository and drives it through spawned `git` invocations, so the suite is bound by process creation rather than by its assertions. On the self-hosted Windows runners all instances share one volume, and process creation there shows occasional multi-second spikes rather than a uniform slowdown. Under that contention this suite has been observed reporting `Test timed out in 15000ms` on a branch that did not touch the file, so the budget rather than the change under test decided the outcome.

## Decision

The suite takes `{ timeout: 90_000 }`, matching `DSH_COVERAGE_TEST_TIMEOUT_MS` in [`.github/workflows/ci.yml`](../../../../.github/workflows/ci.yml), which the Windows coverage lane passes as `--testTimeout`.

A `describe` value takes precedence over that flag rather than deferring to it. A smaller one therefore lowers what the lane already grants, and because no case here carries its own allowance, every one of the 23 was capped at 15 s while the lane offered 90 s.

## Consequences

The suite tolerates a multi-second `git` spawn spike on the shared-volume runners and defers to the budget the coverage lane provides. The value is not a measurement of how long these cases need: the slowest three complete in roughly 0.7-1.2 s depending on the host, and raising the ceiling does not slow a passing run.

A raised ceiling does not weaken the assertions: with the budget raised sixfold a suite still fails through its own assertions rather than through a timeout, because the ceiling only decides when waiting stops. It does widen what counts as acceptable duration, so a real slowdown from a few hundred milliseconds to tens of seconds now passes where the previous 15 s would have caught it. That detection is traded away deliberately: the 15 s ceiling was firing on contention rather than on regressions, so what it caught was the shared volume, not the code.

## Alternatives considered

**Raise `testTimeout` for the whole unit lane.** That would change every suite in the repository to fix one whose cost is specific to spawning `git`.

**Give each case its own allowance.** Twenty-three separate values restate one property of the machine, and a later case added without one would silently inherit the lower ceiling again.

**Leave the value and retry on failure.** A retry moves the failure to another case or another run and leaves a red gate that carries no information about the code under test.
