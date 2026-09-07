# Agent Note: Serial cross-platform CI reference

Status: implemented

English | [中文](2026-07-21-serial-cross-platform-ci-reference.zh.md)

## Problem

The pull-request workflow consolidates required checks into dedicated Linux and Windows jobs. Those jobs still should not be the only completeness oracle: a defect in their gate inventory or dependency graph could omit work while the required aggregate stays green.

Encoding the one-minute non-Windows target and three-minute Windows target as job timeouts creates a separate failure mode. Hosted-runner startup and performance vary, so a correct gate can be cancelled at the target boundary before it emits useful diagnostics. The performance objective needs measurement against GitHub timestamps, while correctness needs enough time to finish.

Reviewers also need a direct answer to a simpler question: what happens when the repository's complete primary Node CI aggregate runs without matrix selection, shard variables, or concurrent gates on each selected hosted operating system?

Real-kernel sandbox proofs require specific hosted operating systems and architectures but do not provide a pull-request merge verdict. Repeating that four-job matrix for every pull request consumes Linux, arm64 Linux, and macOS capacity without satisfying branch protection or contributing to the required aggregate in another workflow.

## Decision

[CI](../../../../.github/workflows/ci.yml) (pull-request-only) and [CI master](../../../../.github/workflows/ci-master.yml) (master-push + workflow_dispatch) give pull-request and master-push events complementary responsibilities. Pull requests run Linux, native Windows, [Node compatibility with self-hosted routing under the Linux variable and trust conditions](2026-09-06-node-compatibility-selfhosted.md), and Python checks; [platform scheduling](2026-09-06-master-only-platform-ci.md) assigns Wine and three Python runtime carriers to master pushes. On a push to `master`, the active references are `serial / linux (self-hosted standby)` on the in-house `vm-backup` pool and `serial / windows (self-hosted standby)` on the in-house `dsh-win-ci` pool — the hot-standby drills that continuously re-prove the failover targets described in the [failover runbook](2026-07-26-ci-failover-runbook.md). There is no standard-hosted `serial / linux` definition; the standard-hosted `serial / macos` remains disabled under `TODO(hosted-serial-ci)` until its portable capacity can be restored. The current `serial / windows` definition is the in-house `dsh-win-ci` standby. The separate job definitions intentionally keep their short checkout, runtime setup, and immutable install sequences visible instead of hiding operating systems behind a matrix or reusable workflow. `workflow_dispatch` is reserved for runner benchmarks.

Each reference job runs `pnpm run check:ci` without any shard selector. `DSH_GATE_CONCURRENCY=1` makes the top-level aggregate execute one ready gate at a time; coverage, snapshot replay, built-bin smoke, and publication validation also receive worker counts of one. The reference jobs may run beside one another, but each host's repository gates are serial and complete. Linux installs bubblewrap before replaying snapshots, and Windows enables Developer Mode before installing the symlinked workspace.

Platform ownership remains explicit inside that complete aggregate. `terminal-bash` supports Linux and macOS and therefore owns its unit and per-file coverage contract on POSIX rather than loading a backend that rejects `win32`; the Windows run still executes every portable package. Portable fixtures derive native paths through `node:path`, compare canonical identities with the same native realpath implementation as production, and use filenames legal on every host. ACP snapshot runs also pass both JavaScript and native realpath spellings of their generated cwd to the normalizer, which replaces aliases longest-first so Windows short and long paths cannot churn shared fixtures.

The macOS reference runs the ordinary Vitest project in forked processes. Node 24 on macOS arm64 has aborted in its CJS lexer from a worker thread; the process boundary contains that external runtime failure without removing any test from the aggregate, while Linux and Windows retain the lower-overhead thread pool. Repository-owned races are fixed at their observation boundaries: dev bundle polling stages each candidate table, graph, and watch-baseline map before publishing a rescan, and a missing bundle remains dirty until a successful content hash. PTY readiness retains a prompt candidate while polling checks foreground ownership; the ordinary silence bound covers inherited markers from interactive children. Real PTY fixtures assemble synchronization tokens at runtime so the interactive shell's input echo cannot satisfy a child-readiness wait. The live-link package-manager e2e preserves the workflow-prepared Corepack home and pnpm metadata/store caches while isolating the other managers' mutable caches, so it does not discard reusable package-manager state before the install.

The standalone [Sandbox](../../../../.github/workflows/sandbox.yml) workflow belongs to the reference side of the same split. Its bwrap, Landlock x64/arm64, and Seatbelt real-kernel matrix runs only after a push to `master`. Those four jobs are diagnostic: they are not branch-protection requirements and do not feed `all checks passed` across workflow files. Pull-request CI still checks sandbox source through its ordinary unit and coverage inventory; the host-kernel and packed-install proofs report after merge.

Master reference jobs are diagnostic and do not participate in the pull request's required `all checks passed` result. The ci-master and Sandbox workflows keep their cross-platform references on master pushes. Performance is evaluated from completed hosted-job timestamps and reported as a measurement; it is not encoded as a `timeout-minutes` value.

The active serial references run on the self-hosted `vm-backup` (`serial / linux`) and `dsh-win-ci` (`serial / windows`) pools; the one remaining disabled hosted serial reference (`serial-macos`) uses `macos-latest`, and there is no standard-hosted `serial / linux` label. The master-only Wine job runs on `ubuntu-latest`, while the pull-request native jobs use the hosted `dsh-windows-2025-16core` runner under normal operation and the self-hosted `[self-hosted, dsh-win-ci, windows]` pool under failover (see the [failover runbook](2026-07-26-ci-failover-runbook.md)), with build and targeted process checks required under the [native Windows decision](2026-08-08-native-windows-pull-request-ci.md). Required pull-request jobs use portable standard capacity under the [required-CI decision](../../archived/process/2026-07-23-portable-required-pull-request-ci.md). Higher-core hosted runners remain manual benchmarks because a correctness path must remain runnable without repository-external runner configuration.

## Alternatives considered

- **Set each timeout equal to its latency target** - rejected because scheduling variance would cancel correct work and suppress the evidence needed to diagnose a regression.
- **Trust only the concurrent primary inventory** - rejected because scheduling and validation share implementation assumptions; a serial aggregate is an independent completeness check.
- **Run the serial references on every pull request** - rejected because they duplicate complete cross-platform aggregates and add macOS work to every change; the required jobs already execute the blocking Linux and native Windows checks, and the other native jobs supply the complete Windows result.
- **Run the real-kernel Sandbox matrix on every pull request** - rejected because its four statuses do not participate in branch protection, while repeated installs, Landlock builds, and macOS unit parity consume runner capacity without changing the merge verdict. The master run retains the platform and installed-launcher signal.
- **Use one operating-system matrix** - rejected because three named jobs make the reference surface visible without another selection mechanism.
- **Run the serial reference on larger runners** - rejected because both required CI and its independent reference must remain runnable when organization-owned pools cannot allocate jobs.

## Consequences

The workflow contains duplicated setup steps and a master reference run can take much longer than the optimized pull-request path. That duplication is deliberate: reviewers can inspect each operating system's complete command without resolving a matrix or concurrent scheduler.

The reference may expose platform failures that the optimized blocking set does not yet claim to support, especially on Windows. Such a failure is evidence about current cross-platform behavior rather than a reason to weaken or silently skip the aggregate.

A sandbox regression visible only to a real host kernel or the packed Landlock install can merge before the master run reports it. That post-merge detection window is accepted in exchange for removing four non-blocking jobs from every pull request; the default branch retains the complete signal.

The explicit `terminal-bash` ownership boundary means Windows does not claim coverage for a backend it cannot load, and forked macOS unit workers cost more process startup time. In return, every supported surface has an honest platform oracle, a native runtime abort cannot erase the rest of the unit result, and timing-sensitive observers start from state established before callers can mutate it.

Removing strict duration timeouts means a latency regression is observed rather than automatically cancelled. Hosted measurements must therefore accompany performance changes, while the completed logs retain the information needed to optimize the slow lane.
