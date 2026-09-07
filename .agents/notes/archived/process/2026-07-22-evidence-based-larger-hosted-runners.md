# Agent Note: Evidence-based larger hosted runners

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-22-evidence-based-larger-hosted-runners.zh.md)

## Problem

The shard-heavy CI topology met its latency targets by spreading primary Node work across 40 Linux jobs and Windows work across nine jobs. Most gates were shorter than checkout, runner setup, cache restore, and dependency installation, so repeated setup waves created both cost and latency variance. One hosted run finished its slowest Linux job in 49 seconds yet took 231 seconds for a Windows lint shard whose checkout, cache restore, and install alone consumed 158 seconds.

Larger runners make it possible to pay setup once and parallelize inside the repository scheduler, but the useful size cannot be selected from core counts alone. Critical-lane benchmarks did not scale monotonically, and a whole-repository aggregate exposed different bottlenecks from isolated typecheck or site builds.

## Decision

The enterprise keeps repo-restricted x64 larger-runner pools for Ubuntu and Windows. Ordinary pull requests run the three primary Linux jobs on the 16-core Ubuntu 24.04 pool and the independent native Windows signal on the 16-core Windows 2025 pool. The required Wine signal remains on standard hosted Linux. Public IPs are disabled, and workflow concurrency remains bounded because an autoscaling ceiling neither allocates idle machines nor makes repository work scale without limit.

The required primary path depends on those enterprise pools. Standard GitHub-hosted jobs retain the Node 22.19, Node 26, and Python SDK compatibility contracts, while the [portable recovery boundary](2026-07-23-portable-required-pull-request-ci.md) and [serial reference](2026-07-21-serial-cross-platform-ci-reference.md) keep complete-aggregate evidence available on `master` through the self-hosted standby pools (no Linux hosted serial reference remains). `suite=larger-runner-benchmark` compares isolated critical lanes across provisioned sizes, and `suite=consolidated-runner-benchmark` compares whole aggregates. Each benchmark reports its observed processor and memory capacity before running repository work.

The former gate-level and coarse primary shard jobs are absent from the workflow. Their workflow-facing static, lint, coverage, snapshot, and scenario selectors are also absent, so an unused diagnostic path cannot preserve a second CI architecture. Instrumented coverage may use [process-local partitions inside its existing job](2026-08-18-in-job-partitioned-coverage.md); that coordinator neither selects workflow jobs nor transfers reports between runners.

Linux primary work uses three independent 16-core jobs. Coverage runs alone and partitions its instrumented work inside that job with an explicit process bound; the static scheduler owns source and documentation gates that do not consume emitted output. The third job owns the single Linux build, then starts lint, Node 24 runtime compatibility, build-backed snapshots, documentation typechecking, and all artifact consumers against that tree. This [independent consumer build](2026-07-30-independent-ci-consumer-build.md) lets all three jobs request runners immediately without duplicating compilation or transferring a run-scoped artifact. Generated NodeNext consumer directories are excluded from Oxlint discovery because the artifact check removes them while these processes overlap. The pnpm store is restored without putting cache uploads on the pull-request critical path; Oxlint has no repository-managed result cache. Performance reports use each job's `startedAt` to `completedAt` interval; runner queue delay is capacity evidence, not repository execution time.

The gate dependencies remain explicit. Coverage consumes source and does not wait for build. Documentation typechecking consumes the consumer lane's complete project-reference output. Snapshot replay and publication consumers wait for emitted output, while Node-version compatibility jobs exercise runtime-sensitive source loading without repeating the primary source-graph typecheck. PTY and subprocess suites keep their bounded inner concurrency rather than inheriting the runner's core count.

The artifact boundary remains explicit. `scripts/publint-all.ts` calls publint's supported API against an in-memory publication view formed from each manifest's declared files plus npm's mandatory metadata, avoiding one package-manager pack process per package. `scripts/verify-built-package-invariants.mjs` stages the declared `lib/` files below the real package and imports its compiled self-reference through plain Node and Cordis Loader normalization; a runtime chunk omitted from the publication contract still fails.

The [dual Windows pull-request topology](2026-08-08-native-windows-pull-request-ci.md) keeps the required build and production-site verdict under Wine on standard hosted Linux. A separate non-blocking 16-core native job shares one Windows setup across workspace build, production-site validation, supported-source coverage, and the complete portability inventory. Linux owns the blocking verdict for duplicate static, documentation, package, built-artifact, lint, and snapshot checks; the native aggregate keeps those checks observational.

An exact-head all-size benchmark ran the complete unsharded primary Node aggregate on every Linux pool before the eager-build correction:

| Complete Linux primary | 4 cores | 8 cores | 16 cores | 32 cores | 64 cores | 96 cores |
|---|---:|---:|---:|---:|---:|---:|
| Active time | 243 s | 144 s | 103 s | 87 s | 62 s | 65 s |

The 96-core trace spent 39.14 seconds in repository gates. Typecheck occupied 25.71 seconds, then a scheduler dependency delayed the 2.13-second build and 11.29-second snapshot replay until it finished. The same run already proved build and typecheck independently, and the former CPU lane ran them concurrently. Removing that dependency makes lint at 33.30 seconds the measured critical gate while preserving dependencies only for consumers of build output. The 64-core trace exposed the same idle chain: typecheck, build, and snapshot consumed 44.85 seconds in sequence while its independent lint and documentation builds finished in 36.83 and 36.15 seconds. More cores therefore become useful only after the repository scheduler can feed them.

The same benchmark measured the required Windows build surfaces across every provisioned size:

| Windows blocking builds | 4 cores | 8 cores | 16 cores | 32 cores | 64 cores | 96 cores |
|---|---:|---:|---:|---:|---:|---:|
| Active time | 152 s | 104 s | 104 s | 92 s | 103 s | 110 s |

Repository work gains little above 16 Windows cores. The native lane keeps blocking build, production-site validation, and coverage together with the observational portability inventory in one 16-core job; a 32-core comparison improved its aggregate gate time by only 1.47 seconds and failed inside Node's CJS lexer. The required Wine job remains separate because it owns critical-path status rather than native-runner scaling.

The larger client package graph makes cache mechanics and scheduler pressure part of the measured workload. In one exact-head candidate run, Linux spent 39 seconds in repository gates but 69 seconds in the complete job, while Windows spent 117 seconds in repository gates and 228 seconds in the complete job. The Windows pnpm cache downloaded its 154 MB archive in about two seconds but spent 27 seconds extracting it, followed by a 23-second install and a 14-second post-job save. A cacheless all-size trace completed the same 32-core Windows install in 27 seconds. A future larger-runner rollout therefore needs complete-job measurements rather than gate-only timing.

Host setup remains part of any comparison. A standard Node 26 job once spent 36 of its 67 seconds in `Set up job`, while `actions/setup-node` spent 46.56 seconds printing cached Windows environment details after finding Node in the hosted toolcache. A Linux candidate also spent 18 seconds registering a 50 KB Bubblewrap package because the hosted image scanned 202,507 package-database files. [`scripts/prepare-ci-bubblewrap.sh`](../../../../scripts/prepare-ci-bubblewrap.sh) instead verifies and extracts the pinned payload into the ephemeral runner directory, runs a functional confinement probe, and overlaps that preparation with dependency installation.

Inner and outer worker limits are separate controls. An exact-head 32-worker ESLint experiment slowed lint to 52.28 seconds and coverage to 42.71 seconds, where an adapter idle-timeout test failed. A later 8-gate trace reduced coverage to 35.17 seconds but delayed the production-site build until the aggregate reached 41.06 seconds. Core count therefore does not justify copying an equally large worker limit.

The process-bound coverage project contains exactly five suite files. Thirty-two forks crashed Node 24's CJS lexer twice, and a later 16-fork run reproduced the worker loss and invalid coverage result. The single Vitest invocation therefore uses threads for the broad inventory and reserves forks for suites that exercise process-global state, `process` APIs, or timing-sensitive process I/O. That narrow fork inventory includes the local bash process-plumbing suite and the pi-ai adapter suite because aggregate contention changed timing observations in both. These failures make deterministic coverage, not advertised cores, the upper bound on worker selection.

The self-hosted serial Linux and Windows standby references and the disabled `serial-macos` job exist. Pull requests use the enterprise required path plus standard-hosted compatibility jobs, while other larger-runner sizes run only by manual dispatch.

The self-hosted serial Linux reference runs on the in-house self-hosted pool (`vm-backup` label: a 64-core VM with six always-on systemd-managed runner instances) on every `master` push. It is a hot-standby drill, not a required check: each run re-proves that the persistent VM can execute the complete unsharded aggregate. The actual switch is pre-wired: the three required Linux jobs resolve their pool through the writer-manageable `DSH_CI_FAILOVER_LINUX` repository variable, so an outage response is setting one variable and re-running — no merge, which would be deadlocked behind the failing checks themselves ([runbook](2026-07-26-ci-failover-runbook.md)). The standby lane is push-triggered, so it always executes the base branch's workflow definition. Under failover, however, `pull_request` jobs do reach these runners with the PR merge ref's own workflow definition — the trust boundary is repository membership (the repository is private with forking disabled, and the selectors exclude Dependabot), as the [failover runbook](2026-07-26-ci-failover-runbook.md) records.

## Alternatives considered

**Keep the three coarse primary Linux lanes.** The core, CPU, and production-site jobs met the latency targets, but they paid three setup waves and left primary Node work sharded after larger runners were available. The all-size trace showed that one unnecessary dependency, not a lack of host capacity, kept the single-box aggregate above one minute.

**Keep the former gate-level shard topology as a manual reference.** A dormant second topology kept hundreds of workflow lines, selector modules, and scenario-partition behavior alive. The all-size and serial suites provide timing and completeness controls without preserving production code that no required job exercises.

**Return to package-manager packing in each publication validator.** Rejected because it repeats a package-manager subprocess for every package. The manifest-derived publication view and staged compiled self-reference preserve the published-file contract with one in-process inventory.

**Build before coverage or typecheck on every Node version.** Rejected because coverage is source-only and compiler analysis is not runtime-specific. Build-backed consumers still wait for emitted output, and compatibility jobs exercise the runtime-sensitive paths on every advertised Node line.

**Use the 64-core pool for the complete primary aggregate.** Its sampled active time was three seconds lower than the 96-core result because hosted setup was nine seconds faster, but its repository gates were 5.72 seconds slower. The benchmark suite retains both pools because a sustained image or pricing change can reverse the comparison.

**Keep build behind typecheck.** This orders independent compiler invocations and turns snapshot replay into a three-stage critical chain. Build output has its own success dependency, so only snapshot and publication consumers wait for it.

**Publish the static job's build to post-build consumers.** A run-scoped artifact preserves one exact build, but the workflow can only consume it by waiting for the entire static job and then requesting another runner. The [independent consumer build](2026-07-30-independent-ci-consumer-build.md) assigns the single Linux build to its actual consumers instead.

**Keep the complete required path on standard GitHub-hosted capacity.** This avoids repository-external runner configuration, but exact-head standard-runner runs remain materially slower and can spend longer queued behind shared capacity. Standard-hosted compatibility jobs preserve portable evidence, while the self-hosted serial standby preserves complete-aggregate evidence, without making that slower topology the ordinary primary path.

**Keep blocking and observational native Windows checks in separate jobs.** This would preserve their distinction at the workflow level but pay Windows setup twice. `run-gates` preserves the same blocking versus observational result inside one job.

**Install Bubblewrap through the system package manager.** This uses the host's package database and can dominate the job even when the payload is tiny. Pinned extraction plus a confinement probe preserves the runtime contract without mutating the hosted image.

## Consequences

The primary topology pays one setup wave per 16-core lane and retains no workflow-level shard jobs or selectors. Process-local coverage partitions share that one setup and workspace. Every ordinary pull request consumes paid enterprise Linux and Windows minutes; manual benchmarks add other sizes only when remeasurement is useful.

GitHub rounds each larger-runner execution up to a whole minute, so complete-job measurement exposes both billed time and workflow complexity. Splitting Linux repeats setup twice, but the consumer lane owns the only built tree and coverage, static gates, and post-build consumers enter runner allocation independently. Native Windows keeps its blocking and observational inventory in one setup, while Wine remains separate to preserve the required critical path.

Performance targets are observations, not cancellation deadlines or correctness requirements. Manual all-size and serial suites remain available when image, dependency, scheduler, or pricing changes need remeasurement.

Missing or renamed enterprise labels leave required primary jobs queued. Standard-hosted compatibility jobs and `master` references still report useful evidence, but they do not substitute for the required aggregate; runner assignment is therefore an operational dependency that repository CI cannot repair.
