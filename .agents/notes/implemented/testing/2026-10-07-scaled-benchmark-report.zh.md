# Agent Note: 按机器缩放与内存压力的基准报告

Status: implemented

[English](2026-10-07-scaled-benchmark-report.md) | 中文

## 问题

基准预算只说明某个端点是否在托管 runner 上回归。读者无法据此判断同一端点在旧笔记本或典型云服务器上有多慢，也无法判断其工作集能否放进 4 GB 或 8 GB 可用内存，因此通过或失败的数字无法体现对用户的影响。

## 决定

每次 `test:bench` 运行都会写出 `benchmarks/.dsh-report/report.html`，这是一个不依赖网络资源的独立页面。基准文件在断言预算之前，把每个有预算的墙钟中位数传给 [scaling-report.ts](../../../../benchmarks/support/scaling-report.ts) 的 `recordTimings`，把整进程峰值 RSS 传给 `recordPeakMemory`。每次调用都带有用例描述，说明该用例测量什么、影响哪个用户场景；读者悬停该用例时页面会显示它。Vitest global setup 在运行前清空结果，在运行后渲染页面，用例失败时也会渲染。预算和断言不变。

### 机器缩放

[machine-profiles.ts](../../../../benchmarks/support/machine-profiles.ts) 列出 2015、2019、2023、2026 年使用 SSD 的笔记本，带默认系统盘的主流云服务器，托管 runner，以及 M4 Pro 校准参考机。每个配置包含 2026-10-07 获取的 PassMark 单线程评分、逻辑 CPU 数，以及其存储的典型 4 KiB 队列深度 1 延迟。缩放后的端点为 `ms × ((1 − io) × cpuScore(measured) / cpuScore(target) × coreFactor + io × ioLatency(target) / ioLatency(measured))`。

当 worker 报告端点区间内的进程 CPU 时间时，`io` 是实测的非 CPU 墙钟时间占比 `max(0, 1 − cpuMs / ms)`，繁忙并行度为 `max(1, cpuMs / ms)`。Session 语料、投影列表、Session 首次历史与 Agent 恢复，以及 Agent 续聊用例会报告 CPU 时间。其他端点在基准旁声明并注释 `io`：内存中的 Client 与终端工作声明为 0，浏览器、Session-open 分阶段和 SDK profile 端点声明估计值。`coreFactor` 为 `max(1, parallelism / cores(target)) / max(1, parallelism / cores(measured))`，因此繁忙 CPU 数超过目标机器 CPU 数的端点会在该机器上变慢。页面显示每个默认值及其来源，读者可以按端点覆盖和重置 `io`。测量机器按 CPU 型号匹配，使用实际可用 CPU 数，也可以在页面中修改。

在 Apple M5 Pro 上，首次内容索引搜索实测 58.7 s；模型预测 EPYC 7763 runner 上为 168 s，托管 CI 记录的中位数为 144 s。

### 内存压力

Session 语料的列表、搜索和 fork 用例报告最大合成工作集的整进程峰值 RSS。页面把每个峰值显示为 4 GB 和 8 GB 可用内存的占比。峰值不做缩放。

### 排除项

长 Session 的 `first`、`input` 和 `streamWall` 包含按节奏回放的等待，不记录。浏览器页面堆在强制垃圾回收后读取，不是峰值，不记录。不建模内存容量和散热限制。实测的非 CPU 时间还包含定时器、事件循环让出和子进程调度；测量运行读取的是刚写入、主要位于页面缓存中的语料，因此用户机器上冷缓存的存储等待可能更长。垃圾回收辅助线程会增加 CPU 时间，因此实测并行度通常为 1–2，与这些工作重叠的存储等待不可见。声明的端点，包括 Chromium 与 Host 共用机器的浏览器用例，都假定只有一个繁忙 CPU。

## 备选方案

**在操作系统内存限制下运行用例。** Linux CI 上的 cgroup 限制需要 root，macOS 上不可用。实测峰值低于 1 GB，4 GB 限制不会改变计时路径，却会给必需门禁增加特权配置。

**只使用声明的存储占比。** 读者无法判断需要猜测的占比。在 worker 中测量进程 CPU 时间成本很低，并能给出可复现的默认值，尽管剩余的非 CPU 时间包含存储以外的等待。

**按基准统一存储占比。** Session open 在关闭文件后才执行恢复和投影，按基准使用一个占比会高估高延迟磁盘对纯内存端点的影响。

**多核或 Geekbench 分数。** 对于以单个 JavaScript 线程为主的端点，多核分数会高估多核机器；实测繁忙并行度只在相关时施加核心数限制。Geekbench 页面无法获取以供引用，PassMark 单线程评分可以获取。

## 影响

读者可以在经审阅的机器上查看每个端点及其实测默认值，并调整存储占比，而不改变任何门禁。页面依赖经审阅的常量：跨指令集评分、共享 vCPU 和磁盘延迟等级都较粗略，因此结果是估计值而不是测量值。内存视图不测量交换和回收成本。`node 24 / benchmarks` job 将该页面作为 `benchmark-report` 产物发布。
