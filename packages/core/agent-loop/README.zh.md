---
description: "面向用户与维护者的默认 agent（智能体）驱动器说明，用于选择、配置或调试 agent 的创建方式以及轮次与步骤的运行方式。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-loop

[English](README.md) | 中文

## 概述

`dsh-agent-loop` 创建全新 agent 或恢复持久化会话，随后通过模型请求、流式响应、工具执行和持久会话历史驱动每个轮次。标准 agent 组合应挂载本包；声明式条目会在启动时启动 agent，公开的 `ctx.agents` API 则支持以编程方式创建和恢复 agent。`maxParallelToolCalls` 限制同时运行的并行安全调用数量，独占调用保留顺序。取消会保留已经流式交付给用户的文本。只有标准的「调用模型、运行工具、重复」生命周期无法满足需求时，才应选择自定义 `Agent` 实现。

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
| `agents[].reasoningEffort` | — | 非空的初始推理强度；`agent/request` 可以覆盖它 |
| `agents[].maxTokens` | — | 正数的逐请求输出 token 上限 |
| `agents[].cwd` | — | 全新会话的工作目录 |
| `agents[].sessionId` | — | 确切身份：首次使用创建，重新挂载时恢复已实体化的历史 |
| `agents[].resumeSessionId` | — | 加载这个持久化会话而不是创建新会话；与 `sessionId` 互斥 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-agent-loop) 列出所有接受的字段。`maxParallelToolCalls` 是在下一个工具组开始时读取的 volatile Config 字段；`agents` 仍是启动配置。

### 以编程方式创建或恢复 agent

插件与宿主通过 `ctx.agents.create()` 创建 agent，通过 `ctx.agents.resume()` 恢复持久化会话；两者都返回 `AgentHandle`，其 `dispose()`（资源释放）负责精确拆除对应的 agent。循环会把每个创建的 agent 运行到完成——只有调用方需要自行拆除 agent 时才需要句柄。

```text
const handle = await ctx.agents.create({
  sessionId,
  agentOptions: { provider: 'deepseek', model: 'deepseek-chat' },
  setup: (agentCtx, agent) => { /* scoped registrations plus explicit unpublished Agent */ },
})
```

每次 inbox 变更都会提交一条规范化的 `agent/inbox/spliced` 事件。投影注册表会同步折叠该事件，因此 `Session.append()` 返回时，实时投影已经反映该 splice。插入、编辑、移除、领取与取消都通过同一组标准 splice 坐标回放。普通删除携带 `outcome: 'canceled'` 并发出 `agent/inbox/discarded { message }`；领取使用不带 outcome 的纯删除，并发出 `agent/inbox/claimed`。每次插入都会发出 `agent/inbox/inserted { message }`。`MessageId` 在两个待处理列表之间保持唯一。需要被移除消息的消费方应使用 claimed 或 discarded 通知，而不依赖 splice 前的 `session/event` 投影视图。

### 一个步骤做什么

每个步骤都会发送会话的派生历史——最新的非空 `system/message` 节点是有效提示词，渲染提示词为空时则没有系统消息——及其可见工具 schema；模型的工具调用经过受守卫的工具流水线，每个被接纳的事实都会在下一步据此派生之前追加到会话日志。并行安全调用最多可重叠 `maxParallelToolCalls` 个；独占调用单独运行并构成排序屏障。取消是协作式的：`agent.cancel()` 中止当前活动，并在未设置 `keepInbox` 时清除待处理工作；被取消的流会终结已送达用户的文本。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释该包如何实现上述行为；可观察约定已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该包是公开 `Agent` 约定的唯一具象实现。它在 `ctx.agents` 上把自身注册为 `AgentFactory`，因此消费方从不导入本包；每个创建 agent 的所有权归属于调用方 fiber 与循环提供方，并汇合到同一个记忆化的完全停稳边界。每个可观察效果都通过会话事件与 `agent/*` 分类体系发生——包内部实现绝不属于公开接口。

### 请求 header 与适配器默认值

`agent/request` 返回后，`ctx.llm.prepareCall()` 会在活跃轮次信号下校验适配器持有的字段，并解析推理强度和输出 token 默认值。循环会在解析、`request/header` 记录与分派期间保留同一个适配器。循环会为首次请求、变化的 envelope（配置或工具——提示词不属于 header）、显式消息序列起点、surface 替换或图片省略决定后的请求及恢复写入完整 header；同一序列内内容未变的步骤、重试与普通后续轮次继承最新 header，历史内追加提示词不是替换，因此紧随其后的请求同样继承 header。在 header 之外，循环还会记录 `request/context`——提供方、模型、`contextWindow` 以及来自 `prepareCall()` 的路由 `systemPromptUpdate` 模式——且仅在其中任何一项与最新快照不同时记录。下一次 waterfall 分发前，循环移除适配器默认字段，使当前路由重新解析它们；显式设置则保留。未处理的路由仍以 `NO_ADAPTER` 失败。

循环在每个派生消息对象首次进入请求时执行深冻结，并且仅在同一 agent 内复用该证明。恢复的消息保留对象身份；构造请求不会冻结包含消息的事件包装对象。每个请求都会冻结本地规范化 header、新消息数组和请求封装，同时保留取消信号的可变性。[请求冻结决策](../../../.agents/notes/implemented/simplification/2026-09-06-agent-request-freeze-evidence.zh.md)解释了所有权与测量依据。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`AgentLoop` 服务、配置 schema、声明式 agent 启动、工厂注册 |
| [`src/agent.ts`](src/agent.ts) | 具体 `ReactLoopAgent` 驱动器：收件箱、轮次／步骤状态机、取消 |
| [`src/inbox.ts`](src/inbox.ts) | 包内部的 `ReactLoopInbox`：持久投影、结构化命令与仅供循环使用的领取状态 |
| [`src/tool-calls.ts`](src/tool-calls.ts) | 工具调度：独占屏障与有界并行池 |
| [`src/runtime-context.ts`](src/runtime-context.ts) | 逐步骤运行时上下文快照处理 |
| [`src/constants.ts`](src/constants.ts) | `DEFAULT_MAX_PARALLEL_TOOL_CALLS` |
| [`src/invariant.ts`](src/invariant.ts) | 不变式配套：从会话日志重建请求 |

### 创建与拆除

创建是同一个受回滚保护的事务：构造私有会话、具象 agent 与带作用域上下文；等待可选 setup；进入两个注册表；宣告 `session/created`；等待串行 `agent/created` 监听器；随后释放已排队输入。创建运行时子 Agent 的调用方设置 `options.parentAgent`；调用方 Context 则单独拥有事务和存活句柄。Setup、commit、监听器失败或所有者 dispose 都会回滚已准备的资源。已送达的宣告仍可被观察，并有配对的销毁通知。Teardown 停止并排空驱动器、撤销作用域、关闭会话写路径、detach agent，再 detach 会话。每次 detach 都绑定到确切进入的对象，因此陈旧 disposer 无法移除之后出现的同 id 替代项。

### 持久化集成

循环是会话写句柄在生产环境中的获取点。挂载 `ctx.sessionPersistence` 后，`create`/`createAgent` 调用 `persistence.create(header)`——在发布之前存储持久身份并取得写所有权——并通过句柄追加构造 seed；`resume` 先调用 `persistence.open(id, 'write')`（排除同 id 的并发恢复），通过句柄读取物理上有效的日志，并为在轮次中途崩溃的日志把 `interruptedTurnClosers` 作为普通批次追加——语义崩溃修复是 agent 层的职责，而非存储入口。发布前的最后一刻，`appendUnstoredSuffix` 存储 setup 窗口期间追加的事件（seed 标记、委派策略记录），它们绝不会经由 `session/event` 重新发出。发布之后，挂载的后端按会话 id 把该会话的 `session/event` 批次、`session/flush` 屏障与 `session/disposed` 退役路由进活跃写句柄；循环只通过它拥有的句柄触碰存储。记忆化的 teardown 在循环提交会话的收尾事件之后关闭句柄——close 会排空任何已路由的缓冲——可证明地释放写所有权。没有后端时，会话只存在于内存中，其余一切不变。

### 轮次与步骤流程

驱动器在其整个生命周期内拥有一个 agent，并在 `ctx.agents.withInitiator(agent, ...)` 内运行。`AgentLoop` 在服务生命周期内注册标准 `inbox` 投影，因此冷读取在没有 Agent 和所有 Agent 卸载后都可用。其包内部 `ReactLoopInbox` 使用该共享投影执行结构化命令与仅供 loop 使用的领取操作。在轮次边界，它先打开持久轮次，再原子领取待处理的 next-step 输入与一条排队提示词；在步骤之间则只领取 next-step 输入。驱动器组装提示词与工具、投影运行时上下文，并运行 `agent/pre-step`。被拒绝的决定或空的首批输入不打开步骤。接纳后的首次尝试先记录 `step/start`，再运行 `agent/request` waterfall 与 `prepareCall()`；这两个异步阶段都看不到待提交的系统提示词与已接纳用户消息进入历史，在任一阶段取消都不会提交这两者。每次尝试时，循环随后依据已准备调用的能力，同步将渲染后的提示词与存活的 `system/message` 节点协调一致、仅在首次尝试追加已接纳的 `user/message` 批次、按需记录 header 与 context，再派生并冻结请求，通过该绑定的已准备调用发起流式请求。重试复用同一份已渲染组装结果，不重复组装、`agent/pre-step` 或用户消息准入。协调过程可见 pre-step 与重试中的压缩；序列中断时将提示词归并到头部，而非在已提交用户消息之后追加更新。请求由 `header.config`、`deriveMessages()` 与 `header.tools` 构成，不携带 `system` 字段。每次模型尝试会发出一个进程本地 `start`，仅在匹配的持久 assistant-frame 结算之后发出各个 `chunk`，并恰好发出一个终态 `end`；最终组装或消息追加失败时以 `aborted` 结算，`committed` 则出现在持久 `assistant/message` 之后。每次成功的模型调用都恰好追加一个 message 锚点，被取消的流则追加带 `interrupted: true` 的锚点并携带已交付前缀，使下一次请求包含用户看到的内容。在步骤内，独占调用形成屏障，并行安全调用使用有界滚动池；策略、持久结果与结果上下文保持模型顺序。

提示词准入依据实际的 `prepareCall()` 结果，而非先前的 `request/context`。没有系统节点时，即使提示词为空也追加（预留第 0 号节点，但不产生协议消息）。在不具备能力的路由上或新请求序列开始时，非空渲染文本归并到首个系统节点：每个非空的后续系统节点分别收到有日志记录的空内容替换，随后按需重写头节点。未生效的空尾节点无需替换，也不决定有效文本。即使最新有效文本未变，也执行归并。延续中的 `in-history` 序列在有效提示词不变时不产生事件，非空变更则追加。无论路由或序列状态如何，空渲染文本都会通过有日志记录的逐节点空内容替换清除每个非空的后续系统节点，再按需清空头节点。模型不会继续看到旧指令。空头节点且没有生效的后续系统节点表示没有提示词；重复清除与恢复会话都保持为空。重新提供的非空提示词遵循同一路由／序列规则：延续中的具备能力路由可以追加它，不具备能力的路由或新序列则重新填充头节点。以下情况开启序列：pre-step 决定声明 `startsRequestSeries`，或 `session.surface.contentGeneration` 自附接或上次请求以来发生变化（替换或图片省略决定）。仅当已准备路由未声明 `toolUpdate` 时，可见工具 schema 变化才强制归并提示词。同时支持工具和系统提示词更新的路由可以追加变更后的提示词并激活新增工具，无需改写此前消息。如果其他准入条件替换系统节点，请求会以当前工具声明开启新序列。恢复与单纯的提供方或模型切换都延续序列；准入仍由已准备的路由决定。逐节点的空内容替换保留其间历史，无需 surface 删除操作。

### 失败与取消

`turn/end` 声明的类型是 `TurnEndCancelCause`；取消时，循环在其中记录一份新的 `AgentCancelCause`，保留调用方的 `kind` 和 hook 的 `reason` 文本。实时 `AbortSignal.reason` 仍是调用方的那个对象，传输层可能向其添加属性——Node 的 fetch 会给它赋一个 `stack`——因此这份拷贝既让该调用栈不进入日志，也让结束事件保持可追加。

最终适配器选择、分发与迭代失败以终止结束的形式到达并进入 `agent/request-error`；处理该失败的监听器返回 `{ kind: 'retry' }` 且不调用 `next()`，未被处理的失败则是终态。Middleware、结果处理、工具及其他扩展失败仍会抛出并直接关闭轮次——插件失败结束的是轮次，不是循环。取消后未分发的模型工具调用会收到合成的 `tool/call` 加 `ABORTED_BEFORE_DISPATCH` 结果对。[显式取消决策](../../../.agents/notes/implemented/architecture/2026-07-16-explicit-turn-cancellation.zh.md)拥有信号生命周期。

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

每个步骤中，循环会发送会话的派生消息与可见工具 schema。非空的 `system/message` 节点承载提示词，最新一条是有效版本；空渲染文本会从派生历史中清除所有提示词版本。它提供 `provider`、`model` 与 `cwd` 变量值，但不添加固定文案。 请求头始终记录当前有效工具。将其名称与前一请求头比较后，添加和移除合并为一条 `developer/message`，不依赖模型能力；添加记录引用新请求头。请求还携带 `Session.toolHistory()`，供 LLM 运行时构造提供方声明。

#### Token 影响

系统文本与 schema 在每个步骤都会再次计入，在 `in-history` 路由上，每个保留的提示词版本都会持续计入，直到压缩将其遮蔽或提示词协调将其清空。逐 agent 作用域决定贡献，而权威组装 waterfall 可以改变最终请求，并使其监听器负责保持协议连贯。

#### KV Cache 影响

前缀复用要求在同一提供方与模型路由下，此前消息和声明保持逐字节一致。渲染后的提示词未变时，缓存前缀得以保留，除非不具备能力的路由或新请求序列必须归并保留的历史内系统节点。原地替换某个系统节点的提示词变更会使请求从该节点的第一个 token 起就不同——该节点是第 0 号节点时则整个请求都不同——因此提供方前缀缓存从那里开始未命中；当已准备调用声明 `systemPromptUpdate: 'in-history'` 时，同一请求序列延续期间的非空提示词变更会追加到已缓存历史之后，因此直到该历史末尾的前缀仍可复用。更改保留工具的定义或重建声明，会从第一个改变的请求 token 起使复用失效。

### 保留的消息历史

#### 模型看到什么

已接纳的 user 消息、assistant 消息、工具调用与结果、注入上下文与 steering（中途引导）都会记录，并在后续步骤中发送。原始流分片、生命周期边界与其他仅写入日志的事件会被排除。

#### Token 影响

输入会随每条表层消息增长，直到压缩替换遮蔽较旧节点；包含多个步骤的工具轮次会在每个步骤重新发送累积的历史。

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
