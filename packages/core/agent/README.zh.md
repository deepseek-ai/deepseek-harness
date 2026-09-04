---
description: "面向插件、UI 与编排器的 Agent 句柄、实时注册表、进程本地发起方作用域，以及 agent/* 事件词汇。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent

[English](README.md) | 中文

## 概述

使用 `dsh-agent`，你可以创建或恢复 agent、发送后续提示词、中途引导（steering）当前步骤、注入面向模型（model-facing）的上下文、取消活动，并等待 agent 进入空闲——这一切都通过每个插件面向编程的 `Agent` 句柄与跟踪运行中 agent 的实时注册表（`ctx.agents`）完成。该包还携带进程本地发起方作用域，把异步工作归因于启动它的 agent，并声明插件用来观察或拦截进行中工作的 `agent/*` 事件词汇。它不依赖循环：具体的创建与驱动位于 `dsh-agent-loop`，它在此注册工厂，因此驱动器保持可替换。构建 UI、钩子、编排器或涉及实时 agent 的扩展插件时请选择本包；接口本身不运行任何模型调用。

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

在存在实时 agent 的任何地方挂载 `dsh-agent`：它提供 `ctx.agents` 以及插件、UI、钩子和编排器所面向编程的 `Agent` 句柄。在没有驱动器注册工厂之前，该服务保持惰性——随附驱动器是 `dsh-agent-loop`，因此最小的可用组合需要同时加载两者。

### 创建或恢复 agent

`ctx.agents.create()` 在一个身份下构建全新 agent 与会话；`ctx.agents.resume()` 加载持久化会话并在此基础上重建 agent。两者都委托给已注册工厂，并返回 `AgentHandle`——唯一能拆除该 agent 的对象。`get(id)`、`list()` 与 `roots()` 用于查找实时 agent；`isOwnedBy(id, owner)` 用于判断一个 agent 是否通过另一个 agent 的作用域上下文创建。

```text
const handle = await ctx.agents.create({
  sessionId,
  agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
})
// later:
await handle.dispose()   // stops the loop, unregisters, removes the session, unwinds the scope
```

`AgentOptions` 提供初始 provider/model 路由、可选的适配器所有 `reasoningEffort`，以及可选的正数 `maxTokens` 输出上限。循环会校验确切模型的推理支持、解析适配器默认值、把有效值记录在请求头中，并将它们应用到每个对话请求。可选的 `setup(agentCtx)` 回调会在 agent 发布之前组合其作用域世界——作用域工具、提示词段与监听器在任何创建公告之前就已存在。Setup 只做组合：创建完成后才能驱动 agent。

### 驱动 agent 的对话

句柄的方法把带标识的 user 角色消息路由进 agent 的收件箱。`followup()` 排队一条普通的下一个轮次提示词并唤醒驱动器；`steer()` 提交下一步输入并唤醒它；`inject()` 添加面向模型的上下文但不唤醒驱动器，因此它落在下一个被接纳的步骤中。`cancel(cause)` 中止当前活动，并在未设置 `keepInbox` 时清除待处理工作；`whenIdle()` 在整个 agent 达到完全停稳后兑现。

```text
handle.agent.followup({
  content: [{ type: 'text', text: 'Summarize this workspace.' }],
  source: { kind: 'user' },
})
handle.agent.steer({
  content: [{ type: 'text', text: 'Focus on the tests.' }],
  source: { kind: 'plugin', plugin: 'my-plugin' },
})
await handle.agent.whenIdle()
```

### 将注册限定到单个 agent

`Agent.ctx` 是该 agent 的作用域上下文：通过它进行的注册（工具、提示词段、变量、事件监听器、限制）只对该 agent 生效，并在 dispose（资源释放）时全部撤销。同一机制也是 agent preset 用来让一个会话获得不同能力集、同时不影响其邻居的方式。

### 拦截或观察进行中的工作

`agent/*` 事件让插件无需依赖循环包即可作用于实时工作。`agent/pre-step` 可以拒绝拟进入的步骤或替换进入它的消息；`agent/request-error` 让监听器重试失败的模型请求；`agent/turn-stopping` 在本可完成的轮次关闭前运行，并可通过 steer 使其保持打开。`agent/assistant-stream` 携带一个进程本地 Assistant attempt 的有序 start、瞬态 chunk 与 end frame。start 给出该 attempt 的 turn 与 step，chunk index 从零开始密集递增，`end.index` 则是下一个 chunk 位置。loop 会在 committed end frame 前把完整紧凑 stream 提交为一个 `assistant/message` 或 `assistant/attempt`，因此 live event 仍是呈现数据而非重放来源。`agent/status`、`agent/created` 与 `agent/disposed` 驱动 UI 与协调状态，逐消息的 `agent/inbox/*` 通知则让收件箱投影保持同步。确切签名、分发 mode 与 payload 约定见 [core 子系统页](../../../docs/subsystems/core.zh.md#cordis-surface) 的生成区块。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释该包如何实现上述行为；可观察约定已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该包建立在一个分离之上：公开的 `Agent` 表面与注册表在此处，而构造与驱动位于循环包中、注册工厂之后。消费方因此依赖 `dsh-agent` 而从不依赖 `dsh-agent-loop`，驱动器保持可替换。第二个理念是发起方作用域：一条 `AsyncLocalStorage` 链把确切的实时 `Agent` 携带经过它启动的异步驱动器工作，使驱动器之下的辅助函数无需逐调用转发 agent 即可归因自己的工作。

### 步骤准入

`PreStepDecision` 要么是 `{ kind: 'reject' }`，要么是 `{ kind: 'enter', messages, startsRequestSeries? }`。enter 分支包含完整、带标识且冻结的消息批次。`startsRequestSeries: true` 声明一个独立的模型消息序列；包装下游 enter 的监听器会保留该声明与批次，除非有意替换其中一项。领取会从 inbox 移除候选消息，领取后插入的消息则等待后续边界。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`AgentRegistry`、工厂槽位、发起方作用域、`CreateAgentOptions`/`ResumeAgentOptions` |
| [`src/runtime-types.ts`](src/runtime-types.ts) | `Agent`、`AgentStatus` 与 `agent/*` 事件声明 |
| [`src/types.ts`](src/types.ts) | `AgentOptions`、取消原因与收件箱词汇 |
| [`src/inbox.ts`](src/inbox.ts) | 持久 `agent/inbox/spliced` 事件之上的 `Inbox` 投影 |
| [`src/dispatch.ts`](src/dispatch.ts) | `agentEvents` 融合分发器与 `assembleContextFor(agent)` |
| [`src/consumed-work.ts`](src/consumed-work.ts) | `foldConsumedWork(events)`：日志消费掉的工作最终怎样了 |
| [`src/model-selection.ts`](src/model-selection.ts) | `installModelSelection`：把一个选择耦合到组装与路由 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式配套：无操作的 `agent/status` 转换会失败 |

### 注册表与生命周期

`AgentRegistry` 为每个实时 agent 保留一个条目，含其载体与创建者关系。`register()` 记录一个已构造完成的 agent；异步工厂使用拆分的 `enter()`/`announce()` 对，使 setup 与发布始终处于回滚保护之下。创建分发期间请求的 detach 会等待该次分发退栈，且每次 detach 都绑定到确切条目，因此陈旧 disposer 无法移除之后出现的同 id 替代项。Teardown 顺序是停止并排空循环、撤销作用域、detach agent、detach 会话；私有清理完成后该 id 即可复用。

### 发起方作用域

每个驱动器在 `ctx.agents.withInitiator(agent, ...)` 内运行其完整生命周期，因此继承的异步链会观察到该 agent；`withoutInitiator()` 为共享定时器等无关的进程本地工作隐藏它。该边界只是进程本地归因——环境中的身份既不是存活证明，也不是授权，显式身份在 worker、进程、持久化与 wire 边界保持权威。Teardown 拒绝新边界，让返回 Promise 的边界排空，然后禁用底层存储。[发起方作用域决策](../../../.agents/notes/implemented/architecture/2026-07-15-agent-initiator-scope.zh.md) 拥有详细约定。

### 所有权不变式

`AgentHandle` disposer 是一项能力：在消费方中，只有其持有者能拆除该 agent。已注册的工厂提供方是结构化共同拥有者，因为作用域 agent 依赖该提供方的服务 API；提供方卸载会停止并排空它创建的每个实时句柄。`ctx.agents.get(id)` 仍返回裸 `Agent`——句柄只暴露给创建它的消费方。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定对大多数消费方已经足够；需要周边领域与设计原理时再阅读以下页面。

- [Core 子系统](../../../docs/subsystems/core.zh.md)——循环图、`Agent` 句柄、拦截决策与生成的服务 API。
- [agent-loop 包](../agent-loop/README.zh.md)——创建、驱动并拆除 agent 的默认驱动器。
- [会话子系统](../../../docs/subsystems/session.zh.md)——句柄背后的持久日志与派生历史。
- [发起方作用域 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-15-agent-initiator-scope.zh.md)——边界与 teardown 约定。
- [core 分组地图](../README.zh.md)——core 各包如何组合。

-----

<a id="model-experience"></a>
## 模型体验

### 用户、steering 与注入消息

#### 模型看到什么

`followup`、`steer` 与 `inject` 以带标识的 user 角色消息馈送所属会话；被接纳的内容成为模型在后续步骤中读取的派生历史的一部分。`agent/pre-step` 与其他已声明事件让插件能够拒绝拟进入的步骤或添加持久请求材料；此接口本身不贡献固定文案。

#### Token 影响

被接纳内容成为保留历史，或成为每次请求重复的会话前缀；被阻止内容不贡献请求 token。大小取决于调用方与插件。

#### KV Cache 影响

被接纳历史与 steering 只追加；被阻止的提交不发送请求。会话前缀在循环实例内保持稳定，而新建或恢复的实例可能建立不同前缀。

### Agent 作用域的请求组合

#### 模型看到什么

通过 `agent.ctx` 进行的注册可以遮蔽提示词段或工具，也可以在未发布 setup 期间安装仅适用于该 agent 的拦截器，因此一个 agent 看到的提示词与工具集会与其邻居不同。

#### Token 影响

此包自身不增加 token；带作用域贡献只影响该 agent，并在 dispose 时消失。

#### KV Cache 影响

只要 agent 的作用域注册不变，前缀就保持稳定。改变提示词段、工具定义或请求监听器的 setup 或 reload，可能从第一个受影响的请求 token 起使复用失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本包何时需要特别留意。它们是当前包约束，不是任务积压。

- **发起方作用域只存在于进程内**：worker、子进程、HTTP、持久队列和重启必须显式传递所需身份。
- **环境身份可能比存活状态更久**：消费方在生命周期敏感工作前，仍要检查 `agent.status`、取消状态和所属能力约定。
- **`agent/session-start` 不能为启动设置门禁**：它仍是同步且不可 veto 的通知；必须在发布前完成的异步组合属于工厂的 `setup(agentCtx)` 事务。
- **`cancel()` 默认清空收件箱**：它会中止正在处理的轮次以及排队和 steering 工作；`cancel(cause, { keepInbox: true })` 只中止轮次并保留待处理项，且不存在让轮次继续运行、只中止步骤的操作。
- **每条附加 `UserMessage` 恰好携带一个 `MessageSource`**：多个插件合并到一条消息上的贡献会归入同一来源，因此该消息无法列出多个生产者。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文；它明确不具权威性。尚未决定的开放方向：委派之外的 agent 间通道——共享状态、流式子输出以及后台或轮询语义仍不在当前委派 seam 之内；以及 `SessionStartSource` 的 `'clear'`/`'compact'` 值已保留但尚无发出方，待驱动子系统落地。

</details>
