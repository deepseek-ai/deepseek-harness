# Agent Note: PR artifact builds and aggregate TypeScript checks

Status: implemented

English | [中文](2026-10-05-pr-artifact-typechecks.zh.md)

## Problem

PR jobs need the same compiled packages for benchmarks, compatibility, packaging, and runtime checks. Building the repository-wide test and script programs in every artifact job repeats expensive diagnostics. In the allowed #3661 baseline, benchmark build preparation takes about 304 seconds before 432 seconds of serial measurements. A cold macOS arm64 Host compiler profile on Node 24.19.0 takes 84.01 seconds, including 55.92 seconds in the aggregate program; its 282 emitted projects take 24.33 seconds combined. Increasing concurrency consumes more shared-runner resources.

## Decision

Required Linux consumer and native Windows build jobs retain normal builds, including both complete aggregate programs. Public `build` and `typecheck` keep the same checks. [Node version ownership](2026-07-06-node-engine-floor.md) and [native Windows ownership](2026-08-08-native-windows-pull-request-ci.md) remain in force.

Checked PR artifact builds compile every existing project reference from each compiler face with one serial `tsc -b` process, then run the ordinary Typert, bundling, Desktop, and Web stages. The helper reads the existing Host and Client aggregates rather than maintaining another package list. It omits only each root's additional test and script program; package diagnostics, emitted outputs, and Host-before-Client ordering remain required. Non-PR release and real-API workflow builds retain their normal checks.

Only the CI benchmark helper selects `tsc -b --noCheck` for package emission. Benchmarks consume JavaScript and Typert runtime metadata; their declaration and build-information files are disposable and never published. Typert analyzes source types independently, while required complete builds own semantic diagnostics. Syntax and configuration failures still reject benchmark preparation. TypeScript records pending checks so a later ordinary incremental build diagnoses the same source without deleting caches or forcing a rebuild. Public benchmark scripts and every release, Python, preview, compatibility, and normal artifact builder keep their checked defaults.

The Python executable builder selects artifact compilation with `--artifacts-only` after verifying its runtime closure. Invalid closure inputs fail before compilation, deployment, or packing; the default complete build and prebuilt `--skip-build` mode keep their existing stages.

CI invokes the internal build helpers directly and keeps the root package manifest unchanged. Root manifest edits activate the separate native-addon platform matrix even when only build aliases change; avoiding that trigger preserves the existing workflow set and concurrent-job ceiling without weakening native validation.

Job inventory, runner selectors, and benchmark sample counts stay fixed; gate and worker ceilings do not increase. The three compatibility cases run one job at a time; the two-target Python runtime matrix starts after the keyless Python SDK job succeeds. Four Linux lanes, the Python SDK, three Windows lanes, and one compatibility job permit at most nine worker jobs initially. Once the SDK job finishes, the remaining seven independent lanes, one compatibility job, and two runtime targets permit at most ten. The runtime plan and wheel stages precede those targets and each use one job. This permits runtime validation to overlap the Node 22 build within the original ten-job ceiling. Coverage partitions reuse compact file-cost metadata within their platform and runner pool. Parallel release packing uses pnpm's existing bounded scheduler; serial publication keeps family order.

Each Node version runs the same seven source compatibility specs in one serial Vitest invocation. Both file parallelism and the CLI worker limit are fixed to one, and the gate sets `VITEST_MAX_WORKERS=1` because that environment variable overrides Vitest's CLI limit. Files retain fork isolation; the build-backed Node 22 lazy-search smoke keeps its separate build dependency. Three paired local samples preserve all 253 assertion outcomes and reduce startup-only median time from 11.52 to 8.69 seconds, without increasing owned descendant-process peak.

## Alternatives considered

**Raise job or worker concurrency.** Rejected because the shared runner must keep its current resource ceiling.

**Remove aggregate checks from every build.** Rejected because package projects do not typecheck all repository tests and scripts; required Linux and Windows jobs must retain those diagnostics.

**Cache compiled outputs across revisions.** Deferred because cache correctness and invalidation add obligations that removing duplicate aggregate work does not need.

## Consequences

The cold Host reference build takes 23.49 seconds with 1.91 GiB peak RSS, compared with 84.01 seconds and 3.87 GiB for the complete compiler pass. All 5,932 emitted files match by path and SHA-256. These are single local compiler samples, excluding bundling and tests; current-head CI owns the PR latency result. The benchmark scenarios and their budgets remain unchanged.

Three alternating cold preparation pairs on Apple M4 Pro / Node 24.19.0 compare checked reference compilation with benchmark-only emission: 61.16, 82.53, and 57.80 seconds versus 55.53, 50.82, and 50.75 seconds. Median preparation falls from 61.16 to 50.82 seconds (16.9%); this includes native support, libraries, benchmark workers, and Web assets, excluding dependency installation and measurements. Every pair has the same 11,894 output paths, including 3,181 byte-identical JavaScript files and unchanged source maps. The 356 build-information files differ, and nine declarations only reorder union members; those files are not published from the benchmark lane. Library-build median user CPU falls from 76.45 to 64.23 seconds, while median maximum RSS stays near 2.75 GiB. Required CI determines the complete PR timing.

Parallel packing relies on the pinned pnpm CLI to honor exact recursive filters, the pack destination, the workspace concurrency limit, and each package's lifecycle hooks. A pnpm upgrade must pass the real-CLI checks in `scripts/release/pack.spec.ts` before release packing adopts it.

Coverage weights sum Vitest's distinct environment, preparation, setup, collection, and execution costs. CI's platform/environment/pool cache prefixes exclude the previous `coverage-times-<run>` archives. Persistent local checkouts can retain wall-clock weights for files not measured during rollout; removing `.coverage-times.json` resets that history. These advisory weights affect partition assignment, while the complete inventory and merged coverage thresholds remain required.

Checked artifact builds deliberately do not diagnose aggregate-only test or script errors. Required normal builds reject those errors; fixture checks also reject package errors on both paths and compare emitted JavaScript, declarations, maps, and build information. Removing or changing a required full build requires transferring both aggregate checks to another blocking owner first. Master serial references remain complete under their [existing policy](2026-07-21-serial-cross-platform-ci-reference.md).
