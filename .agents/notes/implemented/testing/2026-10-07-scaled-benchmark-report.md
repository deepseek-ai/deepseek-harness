# Agent Note: Scaled machine and memory-pressure benchmark report

Status: implemented

English | [中文](2026-10-07-scaled-benchmark-report.zh.md)

## Problem

Benchmark budgets state whether one endpoint regressed on the hosted runner. They do not tell readers how slow the same endpoint is on an older laptop or a typical cloud instance, or whether its working set fits a machine with 4 GB or 8 GB of available memory, so a passing or failing number does not convey user impact.

## Decision

Every `test:bench` run writes `benchmarks/.dsh-report/report.html`, a self-contained page without network resources. Bench files pass each budgeted wall-clock median to `recordTimings` and whole-process peak RSS to `recordPeakMemory` from [scaling-report.ts](../../../../benchmarks/support/scaling-report.ts) before asserting budgets. Each call carries a case description stating what the case measures and which user scenario it affects; the page shows it when the reader hovers the case. A Vitest global setup clears the results before the run and renders the page after it, including after failed cases. Budgets and assertions do not change.

### Machine scaling

[machine-profiles.ts](../../../../benchmarks/support/machine-profiles.ts) lists laptops from 2015, 2019, 2023, and 2026 with SSD storage, mainstream cloud instances with their default system disks, the hosted runners, and the M4 Pro calibration reference. Each profile has a PassMark single-thread rating, retrieved on 2026-10-07, its logical CPU count, and a typical 4 KiB queue-depth-1 latency of its storage. A scaled endpoint is `ms × ((1 − io) × cpuScore(measured) / cpuScore(target) × coreFactor + io × ioLatency(target) / ioLatency(measured))`.

Where the worker reports process CPU time over the endpoint interval, `io` is the measured share of wall time not spent on CPU, `max(0, 1 − cpuMs / ms)`, and the busy parallelism is `max(1, cpuMs / ms)`. The Session corpus, projection list, Session first history and Agent resume, and Agent continuation cases report it. Other endpoints declare a commented `io` beside the benchmark: in-memory Client and terminal work declares 0, and the browser, Session-open phase, and SDK profile endpoints declare estimates. `coreFactor` is `max(1, parallelism / cores(target)) / max(1, parallelism / cores(measured))`, so an endpoint that kept more CPUs busy than a target has slows down there. The page shows each default and its source, and readers can override and reset `io` per endpoint. The measuring machine is matched from the CPU model, uses its actual available CPU count, and can be changed in the page.

On Apple M5 Pro the first content-index search measured 58.7 s; the model predicts 168 s on the EPYC 7763 runner, against a recorded hosted median of 144 s.

### Memory pressure

The Session corpus list, search, and fork cases report whole-process peak RSS for the largest synthetic working sets. The page shows each peak as a share of 4 GB and 8 GB of available memory. Peaks are not scaled.

### Exclusions

Long-Session `first`, `input`, and `streamWall` include paced replay waits and are not recorded. The browser page heap is read after a forced garbage collection, so it is not a peak and is not recorded. Memory size and thermal limits are not modelled. Measured non-CPU time also contains timers, event-loop yields, and child scheduling, and the measuring run reads a just-written corpus that the page cache mostly holds, so cold-cache storage waits on a user machine can be larger. Garbage-collection helper threads add CPU time, so measured parallelism is typically 1–2 and storage wait overlapping that work is not visible. Declared endpoints, including the browser case where Chromium and the Host share the machine, assume one busy CPU.

## Alternatives considered

**Run cases under an operating-system memory limit.** A cgroup limit needs root on Linux CI and is unavailable on macOS. The measured peaks stay below 1 GB, so a 4 GB limit would not change the timed path while adding privileged setup to a required gate.

**Only declared storage shares.** Readers cannot judge a share they have to guess. Process CPU time is cheap to measure in the workers and gives a reproducible default, although the non-CPU time it leaves includes waits other than storage.

**Benchmark-wide storage share.** Session open restores and projects after closing its file, so one share per benchmark overstates high-latency disks for memory-only endpoints.

**Multi-core or Geekbench scores.** A multi-core score would overstate machines with many cores for endpoints dominated by one JavaScript thread; the measured busy parallelism applies core limits only where they matter. Geekbench pages were not retrievable for citation; PassMark single-thread ratings were.

## Consequences

Readers can see each endpoint on reviewed machines with measured defaults, and adjust the storage share, without changing any gate. The page depends on reviewed constants: cross-ISA ratings, shared vCPUs, and disk latency classes are coarse, so results are estimates rather than measurements. The memory view does not measure swap or reclaim costs. The `node 24 / benchmarks` job publishes the page as the `benchmark-report` artifact.
