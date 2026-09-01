---
description: "为运行具体 AgentLoop 的测试挂载共享服务先决依赖，面向接线真实循环前置依赖的测试作者。"
kind: "package-library"
---

# @deepseek-ai/dsh-agent-loop-testkit

[English](README.md) | 中文

## 概述

`dsh-agent-loop-testkit` 为测试在加载具体 `AgentLoop` 之前所需的全部标准先决服务——LLM（大语言模型）运行时、会话存储、系统提示词注册表、工具注册表与 agent（智能体）注册表——按依赖顺序一键挂载。loop 本身、适配器、可选插件、agent 与清理仍由测试掌控，因此每个场景都保持自己的加载顺序与拓扑。当测试对象是 loop 行为而非服务接线时使用它；针对注入失败或部分拓扑的测试会直接挂载其依赖。它自身不注册任何模型可见行为。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

本包在 loop 挂载前为 AgentLoop 测试提供可用的服务拓扑：在测试上下文上调用此辅助函数，然后用待测配置挂载 `AgentLoop`，并注册你的适配器与可选插件。

### 最小示例

```ts
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'

const ctx = new Context()

await mountAgentLoopTestDependencies(ctx)
// Register the test adapter and any optional plugins here.
await ctx.plugin(AgentLoop, { agents: [] })
```

该辅助函数按依赖顺序激活 LLM、会话、系统提示词、工具与 agent 服务，并在 loop 挂载前返回。系统提示词与工具注册表配置可通过 `options` 转发；除服务自有的默认值外，本辅助函数不提供测试默认值。

### 何时使用

当测试对象是 loop 本身——在真实先决依赖栈上的加载顺序、重试、工具执行或会话行为——时使用此辅助函数。当测试要探测服务加载顺序、注入失败、部分拓扑或清理时，请直接挂载依赖——辅助函数隐藏的正是这类测试必须控制的接线。

### 可能出什么问题

插件加载失败会使辅助函数调用被拒绝；顺序中较早激活的服务仍归你的上下文所有，并随上下文一起解除。上下文拥有所有已挂载服务，因此测试结束后请 dispose（资源释放）它。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释辅助函数的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计

**运行时不变式：** 不发布伴生入口。本包不持有生产事件流或可变数据；消费它的测试套件会直接检验 harness 行为。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从 loop 逐步进入辅助函数挂载的服务以及使用它的测试。

- [Agent loop 包](../../core/agent-loop/README.zh.md)——本辅助函数为之准备测试的具体 loop。
- [会话包](../../core/session/README.zh.md)——辅助函数挂载的会话存储。
- [LLM 包](../../llm/llm/README.zh.md)——辅助函数挂载的 LLM 运行时与适配器约定。
- [测试策略](../../../docs/testing.zh.md)——这些测试所服务的覆盖层级。
- [test-support 组地图](../README.zh.md)——兄弟 harness 与支持包。

-----

<a id="model-experience"></a>
## 模型体验

无。该测试专用组合辅助函数既不驱动也不修改模型请求。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明辅助函数不共享什么。它们是当前包约束，不是任务积压。

- **只共享必需的先决主干**——适配器、可选插件、`AgentLoop`、agent 与上下文清理仍由调用方负责，以使特定场景的挂载顺序清晰可见。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
