# Agent Note: Dual-release install layout work budget

Status: implemented

English | [中文](2026-09-28-dual-release-install-layout-work-budget.zh.md)

## Problem

The `Dependency layout` lane packs two incompatible synthetic DSH releases into a temporary consumer, runs one real npm resolution over them, and asserts the physical placement npm chose. It decided pass or fail with `TIMEOUT_MS = 300_000` on the npm child process. That deadline measures the runner, not the graph: the same graph resolves in 137-205 s on an idle developer host and in 288.59 s on the CI runner, 4% below the deadline, while the placement assertion reported no error. The diagnostic named only elapsed time, so a slow runner and a graph that had grown were indistinguishable.

## Decision

`scripts/verify-npm-install-layout.ts` decides growth with `assertResolutionWorkBudget`, which bounds `dshPackagesPerVersion * checkedDshEdges` against `MAX_RESOLUTION_WORK_UNITS = 875_000`. Both counts come from the summary `assertDualDshInstallLayout` returns, so the budget applies to the graph npm actually produced rather than to a prediction of it. A graph above the budget fails with its own counts, the budget, and the instruction to measure the new resolution cost and raise the constant.

The npm child keeps a wall-clock limit, `NPM_HANG_GUARD_MS`, derived as `4 * MAX_RESOLUTION_WORK_UNITS * SECONDS_PER_WORK_UNIT` (910 s). It is a hang guard, not the growth criterion: a runner up to four times slower than the measured host cannot decide the gate's outcome, and deriving it from the budget keeps the two values from drifting apart.

This restores the [published dependency faces](2026-08-26-published-dependency-faces.md) decision that `verify-npm-install-layout` does not enforce resolver duration; the 300 s deadline had contradicted it.

## What the resolution costs

Measured 2026-09-28 on an idle M-series host, against `origin/master` (277 DSH packages per release, 2524 internal edges), by running the lane's own npm invocation with `--timing` and `--cpu-prof`:

| Phase | Cost |
|---|---|
| Registry synthesis (`buildRegistryIndex`, 3952 installed manifests plus 319 DSH workspace manifests into 1544 names) | 1.67 s |
| npm child process | 180.66 s of 185.07 s end to end |
| `idealTree:buildDeps` inside that child | 153.30 s, and nearly all of it lands in 14 of 877 per-node timers |
| `checkCanPlace` / `canPlacePeers` peer-conflict analysis | 117.3 s, of which `new URL()` 65.9 s and `SemVer` 27.9 s |
| Registry traffic | 682 requests, 383 KB of packument bodies |
| Layout assertion and process startup | 4.4 s |

The same graph resolved in 1.12 s with `--legacy-peer-deps`, so peer placement is 152.7 s of the 153.8 s. `canPlacePeers` re-checks each internal edge against the incoming edges of its peer target, which makes the cost grow with placements times edge count; the nested release's copy of `@deepseek-ai/dsh-base` alone takes 48.8 s against 1.3 s for the identical package at the root of the same tree. About three quarters of the verified internal edges are peer edges (1874 of 2524), so this work is the assertion, not overhead around it.

Repeated runs of the same graph on one host span 137.8 s to 204.8 s of npm time, a factor of 1.5 with no input change, which is why a wall-clock threshold cannot separate a slow host from a larger graph.

## Alternatives considered

**Reuse one npm cache directory across runs.** The lane's `npm_config_cache` lives inside the temporary consumer, and the registry listens on an ephemeral port, so `make-fetch-happen` keys every cache entry as `http://127.0.0.1:<port>/<name>` and a persisted cache cannot hit. Re-running the full graph warm with `--prefer-offline` over the cold run's 4.4 MB cache produced a byte-identical package lock in 189.8 s, against 153.8 s cold: correct, and slower. The profile's 10.2 s of idle time is the ceiling on any network saving, because npm spends the rest of the run in its own placement code.

**Merge or parallelize the two releases.** The lane already resolves both releases in one npm invocation, which is what makes the co-existence claim checkable, and one release cannot reuse the other's peer analysis because `canPlacePeers` examines the whole tree. Splitting the graph into two independent resolutions would remove the shared-Cordis and cross-release placement facts the assertion exists to check.

**Raise `TIMEOUT_MS`.** A larger deadline leaves the failure mode in place: the verdict still depends on runner speed, and a graph that grows until it is slow on every machine still fails with no measurement of what grew.

**`--prefer-dedupe`.** It resolves the same graph in 126.8 s but chooses a different placement (809 lock entries against 815, eight differing entries), so the lane would assert a non-default npm placement.

**`--legacy-peer-deps`.** It resolves in 1.12 s and drops the 52 peer-installed packages, along with the peer edges that make up most of the assertion's coverage.

## Consequences

The lane's failure now depends on the graph, so a pull request that adds a few DSH packages passes on any runner, and a graph that grows the packages-times-edges product by more than about a quarter — about 12% in packages and internal edges together — fails deterministically with its measured counts. The budget is a ratchet: raising it is a deliberate edit that must come with a new resolution measurement, and the constant's comment records the counts it was derived from. A graph inside the budget still spends its full resolution time, because the change moves the decision and not the work; nothing here reduces the 153 s npm needs to place the dual release. A genuine npm hang now consumes up to 910 s of the lane before failing, where the old deadline capped it at 300 s. Growth that changes the shape of the graph without changing packages times edges stays inside the budget and is caught only if the hang guard expires.
