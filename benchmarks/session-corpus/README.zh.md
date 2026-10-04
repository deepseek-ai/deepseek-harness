# Session 语料基准

[English](README.md) | 中文

## 概述

在合成语料上测量 Web Host 的 Session 列表、内容搜索和 fork；语料中每个 Session 的长度都不短于一份实测本地 DSH 语料在同一分位上的长度。搜索和 fork 用例分别运行在独立的 1,000 个 Session 语料上；列表用例运行 3,000 个 Session，这是在标准托管 CI 上让此文件五分钟内完成的最大数量。内容搜索模拟通过 `openAt: first-search` 启用该功能的部署；已发布的 profile 默认禁用它。所有用例均不使用网络服务、录制的 Session 或浏览器。

## 目录

- [运行](#run)
- [测量](#measurements)
- [开发备注](#dev-note)

<a id="run"></a>

## 运行

在仓库根目录使用 `pnpm run build:bench` 构建库和 worker，然后运行 `pnpm exec vitest run --config vitest.bench.config.ts benchmarks/session-corpus/session-corpus.bench.ts`。不要让计时运行与构建或其他基准重叠。播种过程会在私有临时根目录下写入约 1.5 GB 的 Zstandard 日志，测试成功或失败后都会删除该目录。

测试报告每个新进程样本、CPU 型号、可用并行度、平台和 Node 版本，并约束中位数预算。当整个文件（包括播种）超过五分钟时，最后一个用例失败。worker 失败时报告退出状态、信号、超时和 stderr 末尾。必需基准通道自动发现此文件。

<a id="measurements"></a>

## 测量

[corpus-shape.ts](corpus-shape.ts) 保存实测分位锚点。[synthetic-corpus.ts](synthetic-corpus.ts) 为每个锚点生成一份事件主体，并把每个 Session 存储为独立的 header 帧加上该主体。[Agent Note](../../.agents/notes/implemented/testing/2026-09-28-session-corpus-performance.zh.md) 负责说明工作负载推导、计时终点、校准和排除项。

| 用例 | 语料 | 计时终点 |
|---|---|---|
| 列表 | 3,000 个 Session | Host 启动；首次和重复的 `session.list`，每次都返回全部 Session 及其缓存投影 |
| 内容搜索 | 1,000 个 Session | 构建内存索引的首次 `session.search`；在已构建索引上的第二次查询 |
| Fork | 1,000 个 Session | 十个长度分层、p99 Session 和最长 Session 的 `session.fork` 返回 |

<a id="dev-note"></a>

## 开发备注

无。
