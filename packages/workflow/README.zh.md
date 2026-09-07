---
description: "workflow 组地图：由模型编写的、可扇出 subagent 的编排脚本，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# packages/workflow

[English](README.md) | 中文

## 概述

workflow 组让 agent 可以运行一段由模型编写的编排脚本，把工作扇出到多个 subagent 并返回最终值。`workflow` 包提供运行服务，worker-thread 包在隔离线程中执行脚本，两个面向模型的工具公开编排能力：通用的 `workflow` 工具用于脚本化扇出，固定的 `ralph` 工具用于全新 agent 迭代循环。脚本用钩子协调 agent，实际工作由 agent 完成。引擎把脚本的同步工作移出宿主事件循环，但这只是隔离，不是安全边界。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`workflow`](workflow/README.zh.md) | 运行由模型编写的、扇出 subagent 的编排脚本 | `ctx.workflowEngine` |
| [`workflow-worker-thread`](workflow-worker-thread/README.zh.md) | 在独立 worker thread 中执行每个工作流脚本，移出宿主事件循环 | 注册到 `ctx.workflowEngine` |
| [`tool-workflow`](tool-workflow/README.zh.md) | 把 `workflow` 工具交给模型，用于脚本化多 agent 编排 | 注册到 `ctx.tools` |
| [`tool-ralph`](tool-ralph/README.zh.md) | 把 `ralph` 工具交给模型，用于全新 agent 迭代循环 | 注册到 `ctx.tools` |

-----

<a id="related-documentation"></a>
## 相关文档

- [工作流子系统](../../docs/subsystems/workflow.zh.md)——seam 的类型、启动请求与 `workflow/*` 事件。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-workflow)——模型接收的 `workflow` 工具 schema。
- [生成的工具目录](../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-ralph)——模型接收的 `ralph` 工具 schema。
- [生成的配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-workflow-worker-thread)——每个受支持的引擎配置字段。
- [动态工作流 Agent Note](../../.agents/notes/implemented/feature/2026-07-05-dynamic-workflows.zh.md)——seam 设计及其决策。
- [Harness 层目标式执行 Agent Note](../../.agents/notes/implemented/feature/2026-07-16-harness-level-loop.zh.md)——固定全新 agent 循环的设计与暂缓事项。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
