---
description: "为 agent-loop 测试提供先决依赖挂载、生产 AgentLoop 驱动与职责明确的 Inbox 桩。"
kind: "package-library"
---

# @deepseek-ai/dsh-agent-loop-testkit

[English](README.md) | 中文

## 概述

`dsh-agent-loop-testkit` 为测试在加载具体 `AgentLoop` 之前所需的标准先决服务——LLM（大语言模型）运行时、会话存储、会话投影注册表、系统提示词注册表、工具注册表与 agent（智能体）注册表——按依赖顺序一键挂载。另一个辅助函数会挂载生产 loop，并返回一个精简驱动，用于创建真实 Agent 和通过真实 Inbox 认领输入。只需要公开队列操作的消费方测试可以改用明确标记为进程内实现的 Inbox 桩；不涉及待处理输入的测试则可以使用快速失败且不支持操作的 Inbox。适配器、可选插件、加载顺序与清理由测试掌控。本包自身不注册任何模型可见行为。

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

本包为 AgentLoop 测试提供可用的服务拓扑，并要求测试明确选择生产 Inbox 行为或结构化桩。

### 驱动生产 Agent

当测试覆盖持久 Inbox 事件、投影恢复或校验、实时 Inbox 通知，或 loop 驱动的认领策略时，使用 `mountAgentLoopTestHarness()`。应在挂载先决依赖后、创建 Agent 前挂载所有对加载顺序敏感的消费方。上下文拥有 loop 以及该 harness 返回的每个 Agent。

```ts
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type UserMessage } from '@deepseek-ai/dsh-session'
import {
  mountAgentLoopTestDependencies,
  mountAgentLoopTestHarness,
} from '@deepseek-ai/dsh-agent-loop-testkit'

const ctx = new Context()

await mountAgentLoopTestDependencies(ctx)
// Register the test adapter and any load-order-sensitive plugins here.
const harness = await mountAgentLoopTestHarness(ctx)
const agent = await harness.create(SessionId('test-agent'))
declare const message: UserMessage

agent.inbox.append('next-turn', message)
const admitted = harness.claim(agent, 'next-turn', 1)
```

依赖辅助函数通过 `options` 转发系统提示词与工具注册表配置，除这些服务自有的默认值外不提供测试默认值。插件加载失败会使辅助函数调用被拒绝；顺序中较早激活的服务仍归上下文所有，并在上下文释放时一并解除。

### 构造结构化 Agent 桩

当测试对象需要可变的待处理列表，但不测试持久性、投影校验、实时 Inbox 通知或驱动的认领策略时，使用 `createInboxStub()`。该桩通过两个进程内数组实现公开队列操作，且绝不会写入 Session。当测试对象不应访问待处理输入时，使用 `unsupportedInbox()`；每次变更都会在首个意外依赖处抛错。

```ts
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'

const agent = {
  // ...
  inbox: createInboxStub(),
}
```

### 何时使用

当测试对象是生产 loop 或持久 Inbox 行为时，使用依赖与 loop 辅助函数。只需要编辑队列的消费方领域测试使用结构化桩。当测试探测服务注入失败或部分拓扑时，请直接挂载依赖，因为辅助函数隐藏的正是这类测试必须控制的接线。

### 可能出什么问题

harness 不会挂载任何 LLM 适配器。若测试发送的任务会启动模型请求，请先注册被测路由的适配器。每个测试结束后都应释放所属上下文，使 Agent 达到静止状态并解除其作用域注册。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释测试辅助工具的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计

`mountAgentLoopTestDependencies` 按固定依赖顺序——LLM、会话、会话投影注册表、系统提示词注册表、工具注册表、agent 注册表——挂载六个服务插件，并在 `AgentLoop` 之前停下，使调用方控制 loop 加载顺序。`mountAgentLoopTestHarness` 挂载公开的生产插件，通过其服务创建 Agent，并公开生产驱动的认领操作，而不导出 loop 的具体 Inbox 类或投影定义。[`src/inbox.ts`](src/inbox.ts) 仅包含进程内可变桩和快速失败且不支持操作的占位值；它不持有投影或持久事件实现。挂载与驱动实现位于 [`src/index.ts`](src/index.ts)。本包不发布 invariant companion，因为它只持有测试辅助工具，不存在可能相互偏离的独立生产观测。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级行为不够用时阅读以下页面。它们从 loop 逐步进入辅助函数挂载的服务以及使用它的测试。

- [Agent loop 包](../../core/agent-loop/README.zh.md)——本辅助函数为生产行为挂载的具体 loop。
- [会话包](../../core/session/README.zh.md)——生产 Inbox 行为使用的持久事件日志。
- [LLM 包](../../llm/llm/README.zh.md)——本辅助函数准备的 LLM 运行时与适配器接口。
- [测试策略](../../../docs/testing.zh.md)——这些测试所服务的覆盖层级。
- [test-support 组地图](../README.zh.md)——兄弟 harness 与支持包。

-----

<a id="model-experience"></a>
## 模型体验

无。这些测试专用辅助工具既不组装也不修改模型请求。

#### KV Cache 影响

无；本包自身不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明辅助工具不共享什么。它们是当前包约束，不是任务积压。

- **只共享必需的先决主干**——适配器、可选插件、场景特定的加载顺序与上下文清理仍由调用方负责。
- **生产 harness 没有适配器默认值**——启动 loop 的测试必须注册其实际使用的路由。
- **可变 Inbox 桩仅存在于进程内**——只要持久事件、投影恢复或校验、实时通知或认领策略属于测试对象，就应使用 harness 创建的 Agent。
- **不支持操作的 Inbox 不接受变更**——只要待处理输入属于测试对象，就应使用可变桩或 harness 创建的 Agent。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
