---
description: "面向用户与维护者的默认 agent 驱动器说明，用于选择、配置或调试 agent 的创建方式以及轮次与步骤的运行方式。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-loop

[English](README.md) | 中文

## 概述

`dsh-agent-loop` 创建 agent——全新创建或从持久化历史恢复——并运行轮次与步骤生命周期：领取提示词、组装请求、流式接收模型响应、分发工具调用，并把每个结果追加回会话日志。作为默认驱动器，它实现 `dsh-agent` 的 `Agent` 接口并在此注册工厂，因此插件通过 `ctx.agents` 创建与驱动 agent，而不必依赖本包。声明式配置项会在启动时自动启动 agent，`maxParallelToolCalls` 限制同时运行的并行安全工具调用数量。它是 harness 唯一的具象循环——超出「调用模型、运行工具、重复」的所有内容都属于监听事件分类体系的插件。标准组合请选择它作为驱动器；如需替换，请实现 `Agent` 并通过 `ctx.agents` 注册。

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

在任何应运行 agent 的组合中挂载 `dsh-agent-loop`。它提供 `ctx.agents` 背后的驱动器，并启动你在配置中声明的 agent；[`dsh-base`](../../bundle/base/README.zh.md) 与 [`dsh-sdk-minimal`](../../bundle/sdk-minimal/README.zh.md) 都将它作为显式配置行挂载。

### 配置声明式 agent

配置中声明的 agent 会在插件加载时自动启动。每个条目需要一个 `id` 标签；模型调用还同时需要 `provider` 与 `model`（`agent/request` 可以在分发前补齐缺失的这一对值）。

```yaml
- name: '@deepseek-ai/dsh-agent-loop'
  config:
    maxParallelToolCalls: 10
    agents:
      - id: 'main'
        provider: deepseek
        model: deepseek-chat
        reasoningEffort: high
        cwd: /workspace
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxParallelToolCalls` | `10` | 每个步骤同时在途的并行安全工具调用数；`1` 为串行 |
| `agents[].id` | 必填 | 稳定标签；未设置 `sessionId` 时，全新会话会生成 `${id}-session-<uuid>` |
| `agents[].provider` / `agents[].model` | — | 模型路由；分发前两者都必须存在 |
| `agents[].reasoningEffort` | — | 非空的初始推理等级；`agent/request` 可以覆盖它 |
| `agents[].maxTokens` | — | 正数的逐请求输出 token 上限 |
| `agents[].cwd` | — | 全新会话的工作目录 |
| `agents[].sessionId` | — | 确切身份：首次使用创建，重新挂载时恢复已实体化的历史 |
| `agents[].resumeSessionId` | — | 加载这个持久化会话而不是创建新会话；与 `sessionId` 互斥 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-agent-loop)是每个受支持字段的穷尽式真源。适配器会校验有效推理等级，循环则把它记录在请求头中。`maxParallelToolCalls` 也是整个 `agent-loop` 设置分节，因此叠加在该条目之上的用户层无需重启即可限制下一组工具调用。

### 以编程方式创建或恢复 agent

插件与宿主通过 `ctx.agents.create()` 创建 agent，通过 `ctx.agents.resume()` 恢复持久化会话；两者都返回 `AgentHandle`，其 `dispose()` 拥有确切的 teardown 能力。循环会把每个创建的 agent 运行到完成——只有调用方需要自行拆除 agent 时才需要句柄。

```text
const handle = await ctx.agents.create({
  sessionId,
  agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
  setup: (agentCtx) => { /* scoped tools, prompt sections, listeners */ },
})
```

每次 inbox 变更都会提交一条规范化的 `agent/inbox/spliced` 事件。投影注册表会同步折叠该事件，因此 `Session.append()` 返回时，实时投影已经反映该 splice。插入、编辑、移除、领取与取消都通过同一组标准 splice 坐标回放。普通删除携带 `outcome: 'canceled'` 并发出 `agent/inbox/discarded { message }`；领取使用不带 outcome 的纯删除，并发出 `agent/inbox/claimed`。每次插入都会发出 `agent/inbox/inserted { message }`。`MessageId` 在两个待处理列表之间保持唯一。需要被移除消息的消费方应使用 claimed 或 discarded 通知，而不依赖 splice 前的 `session/event` 投影视图。

### 一个步骤做什么

每个步骤都会发送该 agent 渲染后的系统提示词、其可见工具 schema 与会话的派生历史；模型的工具调用经过受守卫的工具流水线，每个被接纳的事实都会在下一步据此派生之前追加到会话日志。并行安全调用最多可重叠 `maxParallelToolCalls` 个；独占调用单独运行并构成排序屏障。取消是协作式的：`agent.cancel()` 中止当前活动，并在未设置 `keepInbox` 时清除待处理工作；被取消的流会终结已送达用户的文本。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释该包如何实现上述行为；可观察约定已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该包是公开 `Agent` 约定的唯一具象实现。它在 `ctx.agents` 上把自身注册为 `AgentFactory`，因此消费方从不导入本包；每个创建 agent 的所有权归属于调用方 fiber 与循环提供方，并汇合到同一个记忆化的完全停稳边界。每个可观察效果都通过会话事件与 `agent/*` 分类体系发生——包内部从不属于公开表面。

### 请求 header 与适配器默认值

`agent/request` 返回后，`ctx.llm.prepareCall()` 会在活跃轮次信号下校验适配器持有的字段，并解析推理强度和输出 token 默认值。循环会在解析、`request/header` 记录与分派期间保留同一个适配器。循环会为首次请求、变化的 envelope、显式消息序列起点、表层替换后的请求及恢复写入完整 header；同一序列内内容未变的步骤、重试与普通后续轮次继承最新 header。下一次 waterfall 前，循环移除适配器默认字段，使当前路由重新解析它们；显式设置则保留。未处理的路由仍以 `NO_ADAPTER` 失败。

循环在每个派生消息对象首次进入请求时执行深冻结，并且仅在同一 agent 内复用该证明。恢复的消息保留对象身份；构造请求不会冻结包含消息的事件包装对象。每个请求都会冻结本地规范化 header、新消息数组和请求封装，同时保留取消信号的可变性。[请求冻结决策](../../../.agents/notes/implemented/simplification/2026-09-06-agent-request-freeze-provenance.zh.md)解释了所有权与测量依据。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`AgentLoop` 服务、配置 schema、声明式 agent 启动、工厂注册 |
| [`src/agent.ts`](src/agent.ts) | 具体 `ReactLoopAgent` 驱动器：收件箱、轮次／步骤状态机、取消 |
| [`src/inbox.ts`](src/inbox.ts) | 包内部的 `ReactLoopInbox`：持久投影、结构化命令与仅供循环使用的领取状态 |
| [`src/tool-calls.ts`](src/tool-calls.ts) | 工具调度：独占屏障与有界并行池 |
| [`src/runtime-context.ts`](src/runtime-context.ts) | 每步骤 runtime-context 快照处理 |
| [`src/constants.ts`](src/constants.ts) | `DEFAULT_MAX_PARALLEL_TOOL_CALLS` |
| [`src/invariant.ts`](src/invariant.ts) | 不变式配套：从会话日志重建请求 |

### 创建与拆除

创建是同一个受回滚保护的事务：构造私有会话、具象 agent 与带作用域上下文；等待可选 setup；进入两个注册表；依次宣告 `session/created` 与 `agent/created`；发出 `agent/session-start`；此后才启动驱动器。Setup 抛出、commit 失败或所有者 dispose 都会回滚事务而不发布任一 id。Teardown 顺序是停止并排空、关闭会话的写路径、撤销作用域、detach agent、再 detach 会话，且每次 detach 都绑定到确切进入的对象，因此陈旧 disposer 无法移除之后出现的同 id 替代项。

### 持久化集成

循环是会话写句柄在生产环境中的获取点。挂载 `ctx.sessionPersistence` 后，`create`/`createAgent` 调用 `persistence.create(header)`——在发布之前存储持久身份并取得写所有权——并通过句柄追加构造 seed；`resume` 先调用 `persistence.open(id, 'write')`（排除同 id 的并发恢复），通过句柄读取物理上有效的日志，并为在轮次中途崩溃的日志把 `interruptedTurnClosers` 作为普通批次追加——语义崩溃修复是 agent 层的职责，而非存储入口。发布前的最后一刻，`appendUnstoredSuffix` 存储 setup 窗口期间追加的事件（seed 标记、委派策略记录），它们绝不会经由 `session/event` 重新发出。发布之后，挂载的后端按会话 id 把该会话的 `session/event` 批次、`session/flush` 屏障与 `session/disposed` 退役路由进活跃写句柄；循环只通过它拥有的句柄触碰存储。记忆化的 teardown 在循环提交会话的收尾事件之后关闭句柄——close 会排空任何已路由的缓冲——可证明地释放写所有权。没有后端时，会话只存在于内存中，其余一切不变。

### 轮次与步骤流程

驱动器在其整个生命周期内拥有一个 agent，并在 `ctx.agents.withInitiator(agent, ...)` 内运行。其包内部 `ReactLoopInbox` 构造函数在 agent 作用域上注册标准 `inbox` 投影，随后将该投影用于结构化命令与仅供 loop 使用的领取操作。注册表引用计数会使共享 key 持续有效，直至最后一个 agent 作用域卸载。在轮次边界，驱动器先打开持久轮次，再原子领取待处理的 next-step 输入与一条排队提示词；在步骤之间则只领取 next-step 输入。`agent/pre-step` 决定什么进入该步骤。进入步骤的决定会在驱动器再次领取消息前追加完整的 `user/message` 批次，被拒绝的决定则不追加任何消息。每次模型尝试会发出一个进程本地 `start`，仅在匹配的持久 `assistant/chunk` 之后发出各个 `chunk`，并恰好发出一个终态 `end`；最终组装或消息追加失败时以 `aborted` 结算，`committed` 则出现在持久 `assistant/message` 之后。每次成功的模型调用都恰好追加一个引用其分片 seq 的 message 锚点，被取消的流则追加带 `interrupted: true` 的锚点并携带已交付前缀，使下一次请求包含用户看到的内容。在步骤内，独占调用形成屏障，并行安全调用使用有界滚动池；策略、持久结果与结果上下文保持模型顺序。

### 失败与取消

最终适配器选择、分发与迭代失败以终止结束的形式到达并进入 `agent/request-error`；拥有恢复权的监听器返回 `{ kind: 'retry' }` 且不调用 `next()`，未被处理的失败则是终态。Middleware、结果处理、工具及其他扩展失败仍会抛出并直接关闭轮次——插件失败结束的是轮次，不是循环。取消后未分发的模型工具调用会收到合成的 `tool/call` 加 `ABORTED_BEFORE_DISPATCH` 结果对。[显式取消决策](../../../.agents/notes/implemented/architecture/2026-07-16-explicit-turn-cancellation.zh.md) 拥有信号生命周期。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定对大多数消费方已经足够；需要周边领域与设计原理时再阅读以下页面。

- [agent 包](../agent/README.zh.md)——本循环实现的 `Agent` 句柄、注册表与 `agent/*` 事件。
- [Core 子系统](../../../docs/subsystems/core.zh.md)——轮次流与拦截决策。
- [会话子系统](../../../docs/subsystems/session.zh.md)——循环写入并据此派生的持久日志。
- [工具子系统](../../../docs/subsystems/tools.zh.md)——循环分发所经过的流水线。
- [显式取消 Agent Note](../../../.agents/notes/implemented/architecture/2026-07-16-explicit-turn-cancellation.zh.md)——信号生命周期与取消竞态。
- [core 分组地图](../README.zh.md)——core 各包如何组合。

-----

<a id="model-experience"></a>
## 模型体验

### 完整对话请求

#### 模型看到什么

每个步骤中，循环会发送针对该 agent 渲染的系统提示词、可见工具 schema 与会话的派生消息。它提供 `provider`、`model` 与 `cwd` 变量值，但不添加固定文案。

#### Token 影响

系统文本与 schema 在每个步骤都会再次计入。逐 agent 作用域决定贡献，而权威组装 waterfall 可以改变最终请求，并使其监听器负责保持协议连贯。

#### KV Cache 影响

只有在同一提供方与模型路由下，且系统文本、schema 与此前历史都保持逐字节一致时，请求才保持仅追加。携带 token 的组装改写或组合变更可能从第一个改变的请求 token 起使复用失效。

### 保留的消息历史

#### 模型看到什么

已接纳的 user 消息、assistant 消息、工具调用与结果、注入上下文与 steering 都会记录，并在后续步骤中发送。原始流分片、生命周期边界与其他仅写入日志的事件会被排除。

#### Token 影响

输入会随每条表层消息增长，直到压缩（compaction）替换遮蔽较旧节点；包含多个步骤的工具轮次会在每个步骤重新发送累积的历史。

#### KV Cache 影响

普通历史增长仅追加，并保留可复用条目。表层替换或压缩会从第一个被遮蔽的历史 token 起使复用失效。

### 取消后未分发的调用

#### 模型看到什么

如果后续请求回放一个中止的步骤，取消所阻止分发的每个工具调用都有错误码 `ABORTED_BEFORE_DISPATCH`，结果文本为 `Error: tool call aborted before dispatch`。

#### Token 影响

每个跳过的调用都会在历史中保留一个固定错误结果，直到压缩将其遮蔽。

#### KV Cache 影响

仅追加；每个合成结果都位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明循环何时需要特别留意。它们是当前包约束，不是任务积压。

- **分类是一元的**：安全性取决于比较同级调用或资源的调用必须保持独占（[原理](../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.zh.md)）。
- **配置标签默认对应新会话**：省略 `sessionId` 时，每次启动都会创建新的 `${id}-session-<uuid>`；如需确切的恢复或创建行为，必须显式提供稳定的 `sessionId`，而 `resumeSessionId` 要求已有持久化历史。
- **配置 agent 没有逐 agent persona 字段或 setup 钩子**：它们使用部署 persona；只有编程式 `ctx.agents.create()` / `resume()` 工厂选项支持带作用域的 persona 与工具组合。
- **没有内置轮次预算**：工具调用或 steering 会让当前轮次继续；限制失控轮次的策略必须从既有生命周期扩展点（如 `agent/turn-stopping`）执行取消。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
