# Agent Note: Memory-limited benchmark reruns

Status: implemented

English | [中文](2026-10-07-memory-limited-benchmarks.zh.md)

## Problem

Benchmarks run on hosted runners with 16 GB of memory and on developer machines with more. Neither shows how DSH behaves on a machine with 4 GB or 8 GB available, where the Host, Chromium, and page cache share one memory budget.

## Decision

[run-memory-pressure-bench.ts](../../../../scripts/run-memory-pressure-bench.ts) builds the benchmark artifacts unconfined, then reruns a fixed list of existing benchmark files inside a cgroup v2 whose `memory.max` is 4 or 8 GiB and whose `memory.swap.max` is zero. The files keep their own workloads and budgets; the scenario fails when a case misses its normal budget or the cgroup kills a process.

### Cases

The list holds the files with the largest measured resident memory or the long-history UI path: [session-corpus](../../../../benchmarks/session-corpus/README.md) (list of 3,000 Sessions, content search over 1,000, fork), its projection-list file, [session-open](2026-09-04-session-open-performance-gate.md) (127,400-event Session), and [long-session-browser](../../../../benchmarks/long-session-browser/README.md) (Chromium and its Host). Terminal, fold, reconnect, and continuation files measure small in-process workloads and stay out.

### Limit and endpoint

The cgroup contains Vitest, every benchmark worker, the scaffold Host, and Chromium. Node 24 sizes its default heap from the cgroup limit, and page cache from Session logs is charged to the same limit, so eviction and rereads appear in the timings. On Linux hosts a `systemd-run --user --scope` provides a fresh cgroup. In a container that already enforces the limit, `--scoped` uses the container cgroup. Before running, the launcher requires `memory.max`, `memory.swap.max`, and `process.constrainedMemory()` to match the machine. After the run it reports the cgroup's `memory.peak` and `oom_kill`; both cover the cgroup's lifetime.

## Calibration evidence

On 2026-10-07, Docker on Apple silicon (Linux VM, `--cpus=4`, Node 24.21) ran the list once per limit and once without a limit. All 38 cases passed their budgets under both limits, with no OOM kill.

| Measurement | No limit | 8 GiB | 4 GiB |
|---|---:|---:|---:|
| cgroup peak (MB) | 3,538 | 3,649 | 3,895 |
| List 3,000 first / repeat (ms) | 1,235 / 1,023 | 1,365 / 1,072 | 2,613 / 1,994 |
| Search 1,000 first (ms) | 54,015 | 50,766 | 61,662 |
| Browser slowest page / input (ms) | 152 / 95 | 144 / 91 | 187 / 123 |

## Alternatives considered

- `--max-old-space-size` per worker: the list and search workers use about 100 MB of JavaScript heap while their resident memory reaches 0.7–1.2 GB, mostly native memory, so a heap flag does not model the machine. Node already derives the same 2 GB old space for 4 GB and 8 GB cgroups.
- `RLIMIT_AS`: V8 reserves address space far beyond its resident memory and fails under a virtual-memory limit.
- A pull-request CI job: the PR workflow keeps at most ten concurrent worker jobs, and each memory-limited run takes as long as the benchmark lane, so the scenario is manual.

## Consequences

macOS has no per-process-tree memory cap; developers there run `--scoped` inside a Linux container started with `--memory` and `--memory-swap` equal to the limit. A file added to the list must keep its budgets valid under both limits.
