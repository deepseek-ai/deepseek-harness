# Agent Note: Independent CI consumer build

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-30-independent-ci-consumer-build.zh.md)

## Problem

The [larger-runner topology](2026-07-22-evidence-based-larger-hosted-runners.md) gave the static and built-consumer inventories separate jobs, but the static job owned their shared build. It uploaded the emitted tree only after every static gate completed, and the consumer job declared a job-level dependency before restoring that tree. Compiled-output snapshots and publication checks genuinely require a complete build; they do not require runtime-closure checks, documentation generation, or module-graph verification.

That wider dependency made runner availability part of the required critical chain. In one failover run, static waited 8 minutes 1 second for a runner and ran for 1 minute 41 seconds; only then could consumers enter the same shared pool, where they waited another 10 minutes 34 seconds before running for 1 minute 58 seconds. Reusing the static build saved repository work but serialized two independent runner allocations.

## Decision

The three required Linux jobs enter runner allocation independently. Coverage remains source-only. Static owns source and documentation checks that do not consume emitted output. The consumer job owns the single Linux build together with documentation typechecking, compiled-output snapshots, publication checks, NodeNext checks, and built-bin smokes.

The consumer's internal gate graph preserves the real dependency. Build and source-only Node compatibility start first; publint waits for build, built-package invariants validate that publication view, and every compiled-output consumer waits for that validation. Example and Web snapshots therefore continue to exercise current `lib/` output under plain Node, while no GitHub job waits for an unrelated job or transfers a built-tree artifact.

Windows and serial reference aggregates retain their own build ownership. The change is confined to the required pull-request Linux topology; `all checks passed` still aggregates the same named jobs and fails for any unsuccessful dependency.

## Alternatives considered

**Keep publishing the static job's build.** This preserves one build but cannot express the actual step-level dependency: GitHub makes the consumer wait for the whole static job before it can request a runner. The saved build time is smaller than the repeated queue delay during failover saturation.

**Build independently in both jobs.** Removing the job dependency while leaving build in static would restore parallel allocation, but every pull request would compile the same tree twice. Moving documentation typechecking and build ownership to the consumer preserves one build.

**Add a dedicated build job.** A narrow producer would make the dependency name accurate, but it would add a fourth setup and runner-allocation stage before consumers. The consumer already owns every long-lived use of emitted output, so a separate producer has no second independent consumer.

**Combine static and consumers only during failover.** One long job would avoid the second allocation, but conditional job inventories and result aggregation would create a second CI topology. Independent jobs preserve the same graph on hosted and failover pools.

## Consequences

Static and consumer queue delays overlap instead of accumulating. The consumer's active time includes the build, while the static job becomes shorter and artifact upload, download, compression, and extraction disappear. Total Linux build count remains one.

A static failure no longer prevents the consumer inventory from producing its own evidence; the final verdict still fails. Build and documentation-typecheck failures appear under `node 24 / snapshots and artifacts` rather than `node 24 / static`, matching the job that owns their output dependency.
