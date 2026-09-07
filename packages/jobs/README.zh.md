---
description: "jobs 组地图：后台任务控制——注册表约定、进程本地存储与面向模型的任务工具，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# jobs/：后台任务能力家族

[English](README.md) | 中文

## 概述

jobs 组是后台工作能力家族：运行长时间工作的工具把工作注册为任务，拥有它的 agent 可以在不阻塞自身轮次的情况下读取、等待、列出或取消任务。任务属于启动它的 agent 会话，因此一个 agent 永远不会看到另一个 agent 的工作；任务完成时以会话内通知送达给拥有它的 agent，无需轮询。本组拆分为注册表约定（`jobs`）、其进程本地存储（`jobs-local`）以及带完成通知的模型侧控制工具（`tool-jobs`）。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`jobs`](jobs/README.zh.md) | 定义后台任务约定：id、归属、生命周期与完成监听器 | `ctx.jobs` |
| [`jobs-local`](jobs-local/README.zh.md) | 在本进程中运行并存储任务，按所有者隔离 | 注册到 `ctx.jobs` |
| [`tool-jobs`](tool-jobs/README.zh.md) | 让模型读取、列出和终止任务，并投递完成通知 | 注册到 `ctx.tools` |

-----

<a id="related-documentation"></a>
## 相关文档

- [后台任务运行时子系统](../../docs/subsystems/jobs.zh.md)——任务类型、快照字段与 `ctx.jobs` API。
- [通用长时间运行工具运行时 Agent Note](../../.agents/notes/implemented/architecture/2026-06-20-generic-long-running-tool-runtime.zh.md)——后台任务运行时背后的设计。
- [任务注册表 seam Agent Note](../../.agents/notes/archived/architecture/2026-07-26-job-registry-seam.md)——按所有者隔离的注册表约定及其理由。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
