# Agent Note: Oxlint contract cases that spawn a process carry a 90 s ceiling

Status: implemented
Archived: 2026-09-30

English | [中文](2026-09-27-oxlint-contract-spawn-case-budgets.zh.md)

## Problem

Twelve of the fourteen cases in [`scripts/oxlint-contract.spec.ts`](../../../../scripts/oxlint-contract.spec.ts) spawn a real child process: `runOxlint` starts the oxlint CLI, and `runRepositoryOxlint` boots [`scripts/run-oxlint.ts`](../../../../scripts/run-oxlint.ts) under tsx, which runs oxlint and, after `--fix`, runs it once more. The root `vitest.config.ts` sets no `testTimeout`, so a case without its own budget inherits Vitest's 5000 ms default; the coverage lanes raise it through `DSH_COVERAGE_TEST_TIMEOUT_MS=90000` and the Windows native lane passes `--testTimeout 90000`, while the `unit tests (darwin parity, macos-latest)` job in `sandbox.yml` and a developer's `pnpm run test` run plain. Seven cases (five `it` declarations, one of them a three-way `it.each`) carried the explicit `90_000` that #3115 aligned the contended Windows spawn budgets to; the other seven ran on the default, and five of those spawn. Two runner classes exposed it: the self-hosted Windows pool, where process creation spikes to several seconds (#2581), and the hosted macos-latest runner of Sandbox run 36332053320, which ran the whole file 2.2× slower than the passing run 36320394290 and timed out `prints only the final diagnostics when a fix retry still fails` at 6309 ms, a case that took 1122 ms on the passing run. `Test timed out in 5000ms` names neither a contract violation nor the spawn that overran.

## Decision

Every case in the file that spawns oxlint or the repository lint entrypoint carries the same explicit per-case `90_000` ceiling. The two configuration-only cases, `keeps the complete stylistic contract in Oxlint` and `keeps repository lint workflows Oxlint-only`, spawn nothing and keep the default. The value is a completion ceiling for a hang, not a latency target: the slowest case on the slow darwin runner took 9507 ms, and the file under six-fold CPU oversubscription on a 12-core host peaked at 20767 ms, both under a quarter of the ceiling. Assertions, the absence of retries, and Vitest's global `testTimeout` are unchanged.

## Alternatives considered

**A `describe`-level `{ timeout: 90_000 }`.** Rejected: case-level values already bound seven cases and take precedence over a `describe` value, so a suite-level number would govern only the remaining seven, including the two configuration-only cases that spawn nothing, and the file would carry two budget styles. Per-case values keep one style, one place to read each case's ceiling, and the default on the cases that spawn nothing. Either form overrides the lane's `--testTimeout` rather than yielding to it (#2677). The archived [translation-pairing-merge](../../archived/testing/2026-08-27-translation-pairing-merge-budget.md) and [Lefthook budget](../../archived/testing/2026-08-29-windows-lane-hook-and-lefthook-budget.md) notes chose the `describe` form for files whose cases carried no constants of their own, because a case added later without an allowance inherits the default; this file already carried per-case constants, so that risk is accepted here and named under Consequences.

**Passing `--testTimeout 90000` to the darwin parity job and letting the cases inherit the lane budget**, the form the [CI test reliability workflow](../../../skills/dsh-ci-test-reliability/SKILL.md#budget-timeouts-against-the-lane) prefers for suites bound by process creation. Rejected: the cost is the file's own tsx boot plus two oxlint runs, not a darwin property, so a developer's plain `pnpm run test` would keep the default; the parity job exists to run the same command developers run; and seven cases already carry constants, so a lane flag would split the file's budget between two sources.

**Raising Vitest's global `testTimeout`.** Rejected: the whole unit inventory runs on the default; widening it to absorb one file's process spawns removes the hang detection the default provides everywhere else.

**A tighter value sized to the observed 6.3 s.** Rejected: the Windows contention fires as multi-second spikes that rotated across cases under 15–30 s budgets before the 90 s alignment; a smaller number moves the flake rather than removing it.

## Consequences

A contract violation still fails through its own assertion well inside the ceiling; the five cases bounded here settle in 0.5–1.7 s on an idle host and no spawning case in the file exceeded 3.8 s there, so only a genuine hang waits the full 90 s. The Windows self-hosted lane, the Linux coverage lanes, the darwin parity job, and a local `pnpm run test` read the same ceiling for this file regardless of `DSH_COVERAGE_TEST_TIMEOUT_MS`. A spawning case added later without its own `90_000` runs on the default until the file's inventory is checked. Under 72 busy-loop processes on a 12-core host the unbounded fix-retry case reproduced `Test timed out in 5000ms` at 7084 ms before the change and passes with the ceiling after it.
