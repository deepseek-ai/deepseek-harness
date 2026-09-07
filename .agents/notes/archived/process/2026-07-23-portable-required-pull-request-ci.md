# Agent Note: Portable pull-request CI recovery boundary

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-23-portable-required-pull-request-ci.zh.md)

## Problem

Required pull-request jobs assigned to organization-owned runner labels remain queued when GitHub cannot allocate those pools. The workflow is valid and standard GitHub-hosted jobs can still pass, but `all checks passed` never starts and an otherwise healthy pull request cannot satisfy branch protection.

Billing health, a runner definition's `Ready` state, and a large autoscaling ceiling do not prove that a named pool can receive a job. Required correctness checks need a known portable recovery path even when the ordinary low-latency path depends on repository-external runner provisioning.

## Decision

[CI](../../../../.github/workflows/ci.yml) (pull-request-only) runs the required primary Node 24 jobs, plus the stable `all checks passed` aggregate, on repo-restricted enterprise 32-core pools. The aggregate performs no checkout or repository gate, but sharing the enterprise pool prevents the required verdict from introducing a separate standard-hosted billing dependency after its substantive jobs have already succeeded. The required Windows job runs Windows Node under Wine on standard `ubuntu-latest` for the blocking surfaces; an independent native `windows-2025` job starts automatically but does not participate in the aggregate ([dual Windows decision](2026-08-08-native-windows-pull-request-ci.md)). Standard-hosted jobs retain Node 22.19, Node 26, the Python SDK unit suite, and [installed-wheel Python runtime validation](../testing/2026-08-23-installed-python-wheel-black-box-ci.md) on every published native target, while the serial references (in `ci-master.yml`) remain the complete unsharded cross-platform definitions. Those standard-hosted jobs keep the portable execution boundary observable without duplicating the primary inventory on every pull request.

The three Linux primary jobs, Node compatibility, Python SDK unit suite, Python runtime validation, and `windows node 24 / wine blocking` remain dependencies of `all checks passed`; `windows node 24 / native complete` is deliberately absent. Branch protection continues to require `e2e` and `all checks passed`. There is no automatic fallback when a remaining enterprise Linux label cannot allocate: the standard jobs continue to report their own contracts, but they cannot manufacture the missing required result.

The [larger-runner decision](2026-07-22-evidence-based-larger-hosted-runners.md) owns the current primary topology and its measurements. The [serial cross-platform reference](2026-07-21-serial-cross-platform-ci-reference.md) remains the independent completeness check, now provided by the self-hosted `vm-backup`/`dsh-win-ci` standby lanes on `master`; the only hosted serial reference is the disabled `serial-macos`. The manual larger-runner suites retain size comparisons without expanding the ordinary required matrix.

## Alternatives considered

**Keep the Linux primary jobs and aggregate on standard capacity.** This removes the remaining enterprise allocation dependency, but complete standard-runner jobs give materially slower feedback and still experience shared-capacity queues. The current split retains portable compatibility and serial evidence while spending enterprise capacity on the Linux primary critical path.

**Select enterprise size from advertised core count.** Benchmarks show non-monotonic scaling and setup variance, so exact complete-job measurements choose the required pools instead.

**Skip or demote checks while capacity is unavailable.** This would make the status green by dropping evidence rather than by running the repository's required contracts.

**Use one worker policy on every host.** Outer gate concurrency and inner tool workers contend differently on Linux, Windows, and standard runners; measured host-specific bounds avoid turning additional cores into slower execution.

## Consequences

Ordinary pull requests spend enterprise capacity on the Linux critical path while the Wine job keeps the required Windows verdict on standard Linux allocation. The independent native job uses standard Windows allocation without delaying or changing the aggregate. A live exact-head run distinguishes the commands branch protection consumes from the separate diagnostic contract; queue delay is reported separately from each job's `startedAt` to `completedAt` execution interval.

Standard compatibility, required Wine, and diagnostic native Windows jobs remain useful when enterprise allocation is degraded, but they do not make a blocked required Linux job or aggregate green. Recovering Linux availability may require restoring the complete standard-hosted topology; changing a pool definition's status alone is insufficient evidence that it can receive work.
