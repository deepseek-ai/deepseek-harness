# Agent Note: Parallel pre-push gates

Status: implemented

English | [中文](2026-07-06-parallel-pre-push-gates.zh.md)

The local-hook portion of this record is superseded by [Fast local Git hooks](../../archived/process/2026-07-22-fast-local-git-hooks.md). The bounded gate scheduler and package-level `publint` parallelism remain in force for CI, `doc-sync`, and explicit local commands. The scheduler's fail-fast option is recorded in [Gate-runner fail-fast](../../archived/process/2026-08-27-gate-runner-fail-fast.md).

## Problem

Aggregate jobs such as documentation synchronization hide long sequential chains whose members are read-only and independent. Duplicating their leaf inventory in workflow YAML gives future script changes multiple places to drift, while running package publication checks serially makes one gate consume time proportional to the package count.

## Decision

[scripts/run-gates.ts](../../../../scripts/run-gates.ts) owns the bounded scheduler used by CI, `doc-sync`, and the opt-in `check:all` command. It expands named modes into leaf gates, rejects empty or ambiguous dependency graphs before starting a child, respects artifact dependencies, buffers attributable output by default, reports exit and signal outcomes independently, and accepts `DSH_GATE_CONCURRENCY` when a caller needs a different worker bound. A `needs` edge requires the predecessor to pass and skips its dependent otherwise; an `after` edge waits for any terminal outcome and then permits the follower to run. A gate marked `allowFailure` still reports its result but does not fail the aggregate.

Long coordinator gates whose own subprocesses preserve useful attribution may opt into `streamOutput`. Their stdout and stderr reach the parent immediately without being buffered or printed again at completion. Partitioned coverage and parallel Web snapshots use this mode so a mid-run failure is visible without waiting for sibling work.

The Node 24 consumer job is one ten-gate mode rather than a shell-owned process pool. Its default worker count equals its gate count, while pull-request CI caps active gates at eight and dependencies control readiness. Build and source compatibility start immediately; after build, `publint` and built-package invariant validation run in parallel. Lint, both snapshot suites, documentation typechecking, NodeNext type checks, and built-bin smokes wait for the invariant validator to remove its temporary package views.

[scripts/publint-all.ts](../../../../scripts/publint-all.ts) discovers packages from `packages/<group>/<pkg>` and runs `publint` with a worker pool sized from `availableParallelism()`. `DSH_PUBLINT_CONCURRENCY` can cap or raise the worker count for local machines and CI runners with different resource profiles. Results are buffered per package and printed in deterministic package order, so parallel execution does not scramble each package's log block.

The per-gate package scripts remain the vocabulary for ad hoc local runs. `hygiene` invokes a scheduler mode containing the same thirteen checks with the local four-worker cap, while `doc-sync` owns its member list in the scheduler ([doc-sync through the gate scheduler](../../archived/process/2026-07-21-doc-sync-through-gate-scheduler.md)).

## Verification

[scripts/run-gates.spec.ts](../../../../scripts/run-gates.spec.ts) rejects invalid graphs before the executor runs, pins pass-required and settle-only ordering, pins the hygiene, consumer, and native Windows inventories and their failure semantics, exercises signal termination through a real child process, and proves that streamed output is immediate and unbuffered. [scripts/publint-all.spec.ts](../../../../scripts/publint-all.spec.ts) rejects a missing public export before downstream artifact consumers run.

## Alternatives considered

- **Keep aggregate jobs serial** — simpler execution but makes wall clock equal the sum of independent checks and repeats command-wrapper startup.
- **Declare one CI job per leaf gate** — exposes maximum workflow parallelism but repeats checkout, setup, and install overhead and duplicates the scheduler inventory in YAML.
- **Background subcommands inside shell scripts** — parallelizes work but loses per-gate timing, deterministic failure grouping, and straightforward signal handling.
- **Inherit stdio for every gate** — exposes progress immediately but interleaves ordinary independent gates and discards the scheduler's attributable output record. Streaming remains an explicit gate property.
- **Declare one `publint` job per package** — exposes maximum package parallelism but creates a hand-maintained package inventory that drifts when packages change.
- **Run `publint` with unbounded concurrency** — minimizes elapsed time on small repositories only by gambling with process count, memory pressure, package tarball creation, and readable logs.

## Consequences

Scheduler-backed commands take the slowest dependency chain instead of the sum of independent gates and report the gate that dominates. Invalid graphs fail before partial execution. The cost is a custom scheduler with an explicit mode inventory.

The consumer validation chain delays validated-artifact consumers and lint until the shared artifact view is known-good and transient staging is gone; those downstream gates can still overlap one another. `publint` needs the build but not the staged validation view, so it overlaps the validator instead of extending that chain.

Most gates retain deterministic output blocks. Selected long coordinators trade cross-gate ordering and buffered logs for immediate diagnostics, while their final status remains available to the aggregate summary.

`publint-all.ts` is asynchronous and buffers command output instead of inheriting stdio live. The payoff is package-level parallelism with stable output order and one environment variable for resource tuning.
