---
description: "core 分组地图：构成产品 API 主干的会话日志、系统提示词组装、工具注册表、agent（智能体）词汇与默认循环。"
kind: "package-group"
---

# packages/core

[English](README.md) | 中文

## 概述

使用 core 包可以构建或扩展能够记录持久会话历史、组装系统提示词、提供工具、选择默认模型并运行模型轮次的 agent。这些包定义每个组合都会使用的共享 API，而可执行的产品组合位于 [`packages/bundle`](../bundle/README.zh.md)。开发 agent 行为或替换其中一项能力时请选择本分组；需要默认可运行组合时，请从 [`dsh-base`](../bundle/base/README.zh.md) 开始。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx key |
|---|---|---|
| [`scope/`](scope/README.zh.md) | 隔离单个 agent 贡献的作用域注册与事件路由 | 库，不使用 ctx key |
| [`session/`](session/README.zh.md) | 每个 agent 的历史均派生自该仅追加会话事件日志 | `ctx.sessions` |
| [`system-prompt/`](system-prompt/README.zh.md) | 由有序段、工具 schema 与变量进行的系统提示词组装 | `ctx.systemPrompt` |
| [`tools/`](tools/README.zh.md) | 供循环分发使用的工具注册表与带防护机制的执行流水线 | `ctx.tools` |
| [`agent-tool-presentation/`](agent-tool-presentation/README.zh.md) | 为 preset 提供按 agent 的工具呈现方式选择器 | 无 ctx key |
| [`agent/`](agent/README.zh.md) | 供插件编程使用的 `Agent` 句柄，以及其实时注册表与事件 | `ctx.agents` |
| [`agent-default-model/`](agent-default-model/README.zh.md) | 入口对全新 agent 应用的部署默认模型选择 | `ctx.agentDefaultModel` |
| [`agent-loop/`](agent-loop/README.zh.md) | 默认 agent 驱动器：创建 agent 并运行轮次与步骤生命周期 | `ctx.agentLoop` |

`scope` 提供共享作用域原语；`agent` 负责公开的 `Agent` 约定，而 `agent-loop` 是其默认实现，因此扩展插件依赖 `agent`，驱动器保持可替换。`agent-default-model` 负责入口在会话自身没有选择时应用的部署选择。可运行组合位于 [`packages/bundle`](../bundle/README.zh.md)；本分组只负责可替换的主干组件。

-----

<a id="related-documentation"></a>
## 相关文档

- [Core 子系统](../../docs/subsystems/core.zh.md)——逐包循环图与 `Agent` 句柄约定。
- [会话子系统](../../docs/subsystems/session.zh.md)——会话事件词汇与派生历史。
- [系统提示词子系统](../../docs/subsystems/system-prompt.zh.md)——提示词段、动态上下文与工具 schema 类型。
- [工具子系统](../../docs/subsystems/tools.zh.md)——工具执行流水线与呈现词汇。
- [作用域注册子系统](../../docs/subsystems/scope.zh.md)——这些注册表所依赖的作用域层原语。
- [架构](../../docs/architecture.zh.md)——轮次流与新行为归属。
- [基础组合包](../bundle/base/README.zh.md)——默认产品组合。
- [SDK 最小组合包](../bundle/sdk-minimal/README.zh.md)——完整、独立且功能集经过刻意精简的组合。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
