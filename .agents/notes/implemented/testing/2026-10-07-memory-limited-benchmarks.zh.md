# Agent Note: 内存受限的基准重跑

Status: implemented

[English](2026-10-07-memory-limited-benchmarks.md) | 中文

## 问题

基准运行在 16 GB 内存的托管 runner 和内存更大的开发机上。两者都无法显示 DSH 在可用内存为 4 GB 或 8 GB 的机器上的表现，而这类机器上 Host、Chromium 和页缓存共享同一份内存预算。

## 决定

[run-memory-pressure-bench.ts](../../../../scripts/run-memory-pressure-bench.ts) 先在无约束环境中构建基准产物，再在 `memory.max` 为 4 或 8 GiB、`memory.swap.max` 为零的 cgroup v2 中，重跑一份固定的现有基准文件列表。这些文件保留各自的负载和预算；某个用例未达到其常规预算或 cgroup 杀死进程时，该场景失败。

### 用例

列表包含常驻内存实测最大的文件和长历史 UI 路径：[session-corpus](../../../../benchmarks/session-corpus/README.zh.md)（3,000 个 Session 的列表、1,000 个 Session 的内容搜索、fork）、其 projection-list 文件、[session-open](2026-09-04-session-open-performance-gate.zh.md)（127,400 个事件的 Session）和 [long-session-browser](../../../../benchmarks/long-session-browser/README.zh.md)（Chromium 及其 Host）。终端、fold、重连和续写文件测量的是较小的进程内负载，不在列表中。

### 上限与端点

cgroup 包含 Vitest、每个基准 worker、脚手架 Host 和 Chromium。Node 24 按 cgroup 上限确定默认堆大小，Session 日志的页缓存也计入同一上限，因此淘汰和重读会体现在耗时中。在 Linux 主机上，`systemd-run --user --scope` 提供一个新的 cgroup。在已经执行该上限的容器中，`--scoped` 使用容器的 cgroup。运行前，启动脚本要求 `memory.max`、`memory.swap.max` 和 `process.constrainedMemory()` 与机器一致。运行后，它报告该 cgroup 的 `memory.peak` 和 `oom_kill`；两者覆盖 cgroup 的整个生命周期。

## 校准证据

2026-10-07，Apple silicon 上的 Docker（Linux VM，`--cpus=4`，Node 24.21）对每个上限各运行一次该列表，并在无上限时运行一次。两个上限下全部 38 个用例都通过了预算，没有 OOM kill。

| 测量项 | 无上限 | 8 GiB | 4 GiB |
|---|---:|---:|---:|
| cgroup 峰值（MB） | 3,538 | 3,649 | 3,895 |
| 列出 3,000 个：首次 / 重复（ms） | 1,235 / 1,023 | 1,365 / 1,072 | 2,613 / 1,994 |
| 搜索 1,000 个：首次（ms） | 54,015 | 50,766 | 61,662 |
| 浏览器最慢一页 / 输入（ms） | 152 / 95 | 144 / 91 | 187 / 123 |

## 考虑过的替代方案

- 为每个 worker 设置 `--max-old-space-size`：列表和搜索 worker 使用约 100 MB JavaScript 堆，而常驻内存达到 0.7–1.2 GB，主要是原生内存，因此堆参数无法模拟机器。Node 已为 4 GB 和 8 GB cgroup 推导出相同的 2 GB old space。
- `RLIMIT_AS`：V8 预留的地址空间远超其常驻内存，在虚拟内存上限下会失败。
- PR CI 作业：PR 工作流最多保持十个并发 worker 作业，而每次内存受限运行与基准 lane 耗时相当，因此该场景为手动运行。

## 影响

macOS 没有按进程树的内存上限；那里的开发者在以等于上限的 `--memory` 和 `--memory-swap` 启动的 Linux 容器中运行 `--scoped`。加入列表的文件必须在两个上限下都保持预算有效。
