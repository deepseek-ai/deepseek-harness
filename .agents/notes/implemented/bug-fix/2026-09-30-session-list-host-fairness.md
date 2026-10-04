# Agent Note: Time-sliced Session-list work

Status: implemented

English | [中文](2026-09-30-session-list-host-fairness.zh.md)

## Problem

Large cached projection states can monopolize the Host while a Session list is assembled. Yielding after every row avoids that batch stall but adds thousands of event-loop round trips when a list contains many cheap rows. Row count alone is not a useful scheduling budget.

## Decision

[ApiSessionList](../../../../packages/api/session-controller/src/list.ts) uses one monotonic deadline for classification and summary generation. It yields only after elapsed work exhausts the configured `listWorkSliceMs`, then starts a new deadline after the wait. The optional deployment setting defaults to 16 positive integral milliseconds. Small lists have no forced final yield or no-op asynchronous helper. Cancellation is checked per row, after each yield, and before returning; no partial list is returned.

Every row remains synchronous. Live rows precede queued cold rows before the stable activity sort; the list promises no cross-Session atomic cut. A cold row already queued before an attachment remains cached, and Client mutation replay plus [cached/sequenced precedence](../architecture/2026-09-19-projection-cache-listing-identity-and-cached-rows.md) reconcile the newer live state. No projection data or validation is omitted.

## Measurement and calibration

The [production-entry benchmark](../../../../benchmarks/session-corpus/projection-list.bench.ts) measures the real Session Controller, query engine, persistence, projection registry/cache and storage domain. Persisted fixtures use `generationLogPath`, `toHeaderLine` and `compressZstdFrame` from the persistence owner. All content is deterministic generated data. Setup and explicit GC are outside timing; complete results and JSON remain reachable during memory sampling.

| Workload | Sessions | State observations | Request records | State JSON |
|---|---:|---:|---:|---:|
| Cheap live | 3,000 | 0 | 0 | 277,890 bytes |
| Modest persisted | 50 | 4,925 | 641 | 1,813,852 bytes |
| Heavy persisted | 300 | 300,000 | 37,575 | 111,255,440 bytes |

The cheap live case avoids disk enumeration masking scheduling cost. Persisted row counts use 50/75/100/175% strata of 100 or 1,000 generated observations. Each fresh child measures one first call and three repeats with a single fixed-cost immediate probe per call. A separate fifth call re-arms at most one pending probe to measure the worst queue delay over the complete list. Full-probe timings are not throughput evidence: per-row yielding would otherwise execute proportionally more diagnostic callbacks. Yield counts exclude post-measurement GC helpers. Peak RSS includes setup and the entire process lifetime.

Local Node 26.5.0/macOS arm64 comparisons alternate implementations and use three fresh children per workload. Repeat metrics first take each child's median, then the median across children. Queue delay takes the maximum in each separate diagnostic call, then the median across children.

| Repeated metric | Synchronous | Per-row yield | 16 ms slices |
|---|---:|---:|---:|
| Cheap live: list + JSON | 61.60 ms | 111.65 ms | 65.68 ms |
| Cheap live: yield calls | 0 | 3,000 | 3 |
| Cheap live: maximum queue delay | 54.35 ms | 0.54 ms | 16.54 ms |
| Modest persisted: list + JSON | 19.76 ms | 18.23 ms | 18.26 ms |
| Modest persisted: yield calls | 0 | 50 | 0 |
| Heavy persisted: list + JSON | 253.22 ms | 291.36 ms | 232.18 ms |
| Heavy persisted: yield calls | 0 | 300 | 10 |
| Heavy persisted: maximum queue delay | 172.39 ms | 0.80 ms | 16.67 ms |

For cheap lists, slicing removes 99.9% of per-row yields and reduces measured repeat time by 41.2%; the synchronous reference remains slightly faster. Heavy-list wall time varies substantially on the shared host, so no universal throughput speedup is asserted. Retained heap stays about 35 MB for cheap lists and 186–188 MB for heavy lists, without a decoded-state cache.

| Raw child aggregates | Synchronous | Per-row yield | 16 ms slices |
|---|---|---|---|
| Cheap repeat ms | [63.10, 61.60, 59.08] | [108.19, 115.61, 111.65] | [65.68, 71.75, 65.17] |
| Cheap maximum queue ms | [112.69, 54.35, 49.67] | [0.54, 0.76, 0.41] | [16.41, 16.54, 41.15] |
| Heavy repeat ms | [277.06, 253.22, 236.22] | [291.36, 302.76, 282.01] | [212.35, 232.18, 304.38] |
| Heavy maximum queue ms | [297.76, 172.39, 164.17] | [0.56, 1.34, 0.80] | [16.39, 16.67, 16.76] |

Separate 4/8/16 ms experiments measured cheap-list repeat medians of 58.39/58.57/52.34 ms and heavy-list medians of 279.81/253.85/216.67 ms. Their heavy-list maximum queued-work delay medians were 5.19/8.45/16.70 ms. The 16 ms default chooses fewer round trips while retaining a short work target; deployments can select a smaller budget.

CI uses elapsed queue-delay and coarse throughput limits, not an exact batch size. The shared scale 2 and headroom 1.25 turn a 30 ms queue reference allowance into 75 ms, leaving room for one-row overshoot and scheduling variance while rejecting an unyielded heavy batch. Throughput reference allowances are 50/500/150 ms for modest/heavy/cheap, producing 125/1,250/375 ms bounds. These are safety ceilings, not claims of fine-grained non-regression. The earlier Linux Node 24.21 EPYC run measured 102.16/779.57 ms first calls for modest/heavy cases; the larger heavy allowance accounts for the observed hosted/reference ratio exceeding 2. Heap uses 240 MiB and only variance headroom, giving 300 MiB.

The existing [3,000-Session corpus lane](../testing/2026-09-28-session-corpus-performance.md) remains the stored-corpus throughput authority. Its earlier per-row CI run measured first-call samples 3,205.3/3,166.2/3,165.1 ms and repeat samples 2,643.5/2,577.8/2,589.6 ms, within its existing calibrated limits. The projection benchmark adds a distinct cheap-live and large-state dimension rather than replacing that corpus. On the same local machine, the stored-corpus per-row/sliced first medians are 885.5/859.4 ms and repeat medians are 700.3/692.1 ms; that small difference is within ordinary run variation, with no observed throughput regression. The new three-workload file takes 23.98 s locally, including fixture setup and all nine children; its previously measured two-workload CI version took 36.80 s on EPYC Node 24.21.0.

## Alternatives considered

**Unconditional per-row yielding.** It minimizes individual queue waits but charges an event-loop round trip for every cheap row. The many-live-Session comparison exposes that cost; a fixed number of rows would still ignore variable row cost.

**Larger or smaller time slices.** Smaller slices offer shorter queue waits at more scheduling cost. Larger slices reduce switching but extend the period other Host work waits. Configuration exposes this tradeoff without changing row semantics.

**Caching decoded state or wire views.** Decoded-state reuse retains another graph per stored row and changes schema-evaluation ownership. Wire views can depend on current runtime state. Scheduling needs neither cache and preserves all schema checks and dynamic views.

## Consequences

[Controlled-clock tests](../../../../packages/api/session-controller/tests/list-scheduling.host.spec.ts) require cheap rows to remain in one synchronous slice, budget exhaustion and post-wait reset to govern yields, and cancellation to stop work even when no yield is due. They also preserve stable ties and attachment/removal/status interleavings. The time-based benchmark guard rejects unyielded or first-only-yield heavy work without forbidding efficient batches.

A single row, provider enumeration, GC, final sorting and serialization can exceed the target. Concurrent lists and operating-system scheduling also affect latency. The budget is not a hard global bound, and these measurements do not claim browser paint or model/network latency improvements.
