---
description: "面向用户与维护者的默认 agent（智能体）驱动器说明，用于选择、配置或调试 agent 的创建方式以及轮次与步骤的运行方式。"
kind: "package-reference"
---

# @deepseek-ai/dsh-agent-loop

[English](README.md) | 中文

## 概述

`dsh-agent-loop` 创建全新 agent 或恢复持久化会话，随后通过模型请求、流式响应、工具执行和持久会话历史驱动每个轮次。标准 agent 组合应挂载本包；声明式条目会在启动时启动 agent，公开的 `ctx.agents` API 则支持以编程方式创建和恢复 agent。Agent 所选的根注册表负责分发、并发、取消和工具日志。取消会保留已经流式交付给用户的文本。只有标准的「调用模型、运行工具、重复」生命周期无法满足需求时，才应选择自定义 `Agent` 实现。

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

配置中声明的 agent 会在插件加载时自动启动。每个条目需要一个 `id` 标签；模型步骤还要求 Session 选择或初始选项在提示词组装前同时提供 `provider` 与 `model`。

```yaml
- name: '@deepseek-ai/dsh-agent-loop'
  config:
    agents:
      - id: 'main'
        provider: deepseek
        model: deepseek-chat
        reasoningEffort: high
        cwd: /workspace
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `agents[].id` | 必填 | 稳定标签；未设置 `sessionId` 时，全新会话会生成 `${id}-session-<uuid>` |
| `agents[].provider` / `agents[].model` | — | 模型路由；步骤准备前两者都必须存在 |
| `agents[].reasoningEffort` | — | 非空的初始推理强度；后续选择记录在 Session 中 |
| `agents[].maxTokens` | — | 正数的逐请求输出 token 上限 |
| `agents[].cwd` | — | 全新会话的工作目录 |
| `agents[].sessionId` | — | 确切身份：首次使用创建，重新挂载时恢复已实体化的历史 |
| `agents[].resumeSessionId` | — | 加载这个持久化会话而不是创建新会话；与 `sessionId` 互斥 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-agent-loop) 列出所有接受的字段。`maxParallelToolCalls` 仍是 volatile 正整数 Config 字段，默认值为 `10`；`1` 表示串行执行。循环在每个批次调用 `execute()` 时传入当前值，其优先级高于根注册表自身的上限。实时修改从下一个批次生效；`agents` 仍是启动配置。

配置式恢复会在发布前将声明的路由记录为 Session 选择。程序化恢复保留 Session 选择，除非其 setup 显式记录另一条路由；仅传入初始 `agentOptions` 不会覆盖已有历史。

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

每个步骤发送派生 Session 历史及其可见工具 schema。系统消息包含初始指令及后续段更新。工具调用经过受守卫的流水线，每项模型可见事实都在派生请求前记录。循环把完整的原始调用批次传给 `ctx.tools.execute()`；内置根注册表保留模型顺序的结果和独占屏障。取消会中止当前活动，并在未设置 `keepInbox` 时清空待处理工作；中断的流会结算已送达文本。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释该包如何实现上述行为；可观察约定已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该包是公开 `Agent` 约定的唯一具象实现。它在 `ctx.agents` 上把自身注册为 `AgentFactory`，因此消费方从不导入本包；每个创建 agent 的所有权归属于调用方 fiber 与循环提供方，并汇合到同一个记忆化的完全停稳边界。每个可观察效果都通过会话事件与 `agent/*` 分类体系发生——包内部实现绝不属于公开接口。

### 请求 header 与适配器默认值

循环在提示词组装前调用 `agent.model.current()`，并为该步骤及其重试捕获提供方、模型及可选的显式推理强度。`AssembleContext.modelSelection` 与 `agent/pre-step.modelSelection` 携带该选择；提示词变量使用其中的路由，省略强度时使用适配器默认值。已弃用的 `agent/request` hook 仍可供现有监听器使用，可以替换采样等其他控制参数。改变提供方或模型，或添加、修改、清除推理强度，都会在提交输入前拒绝该步骤。之后记录的选择从下一个步骤开始生效，包括同一轮次中的工具后续步骤。

`agent/request` 返回后，`ctx.llm.prepareCall()` 会在活跃轮次信号下校验适配器持有的字段，并解析推理强度和输出 token 默认值。循环会在解析、`request/header` 记录与分派期间保留同一个适配器。循环会为首次请求、变化的 envelope（配置或工具——提示词不属于 header）、显式消息序列起点、surface 替换或图片省略决定后的请求及恢复写入完整 header；同一序列内内容未变的步骤、重试与普通后续轮次继承最新 header，历史内追加提示词不是替换，因此紧随其后的请求同样继承 header。在 header 之外，循环还会记录 `request/context`——提供方、模型、`contextWindow` 以及来自 `prepareCall()` 的路由 `systemPromptUpdate` 模式——且仅在其中任何一项与最新快照不同时记录。下一次 waterfall 分发前，循环移除适配器默认字段，使当前路由重新解析它们；显式设置则保留。未处理的路由仍以 `NO_ADAPTER` 失败。

循环在每个派生消息对象首次进入请求时执行深冻结，并且仅在同一 agent 内复用该证明。恢复的消息保留对象身份；构造请求不会冻结包含消息的事件包装对象。每个请求都会冻结本地规范化 header、新消息数组和请求封装，同时保留取消信号的可变性。[已归档的请求冻结决策](../../../.agents/notes/archived/simplification/2026-09-06-agent-request-freeze-evidence.md)解释了所有权与测量依据。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`AgentLoop` 服务、配置 schema、声明式 agent 启动、工厂注册 |
| [`src/agent.ts`](src/agent.ts) | 具体 `ReactLoopAgent` 驱动器：收件箱、轮次／步骤状态机、取消 |
| [`src/inbox.ts`](src/inbox.ts) | `ReactLoopInbox` 以及维护队列和领取落定的共享投影 |
| [`src/runtime-context.ts`](src/runtime-context.ts) | 逐步骤运行时上下文快照处理 |

### 创建与拆除

fork 创建按与直接回放完全相同的方式准备调用方的 `seed`，不打开也不 flush 父会话；`parentSource` 只指定父会话和截点。共享已存储前缀的后端在引用前自行排空父写者。

新建和恢复共用一个受回滚保护的初始化流程：围绕已取得的 Session 构造具象 agent 与带作用域上下文；存储构造历史、进入 SessionStore 并完成 `session/created`；等待可选 setup 及其 commit；进入 AgentRegistry；等待串行 `agent/created` 监听器；随后释放已排队输入。调用方 Context 拥有事务和存活句柄；委派服务在 setup 期间绑定自己的运行时关系。Setup、commit、监听器失败或所有者 dispose 都会回滚已准备的资源。setup 期间 Session 可写；每次移除都会发出 `session/disposed`，包括 Agent 创建宣告前的 setup 失败。初始化失败保留恢复出的收件箱输入及已存储事件，并在释放自身作用域及已取得的写句柄后才拒绝。持久化层仍在创建写句柄时发生取消，可以更早拒绝；该句柄在创建完成后关闭。已送达的宣告仍可被观察，并有配对的销毁通知。Teardown 停止并排空驱动器、撤销作用域、关闭会话写路径、detach agent，再 detach 会话。每次 detach 都绑定到确切进入的对象，因此陈旧 disposer 无法移除之后出现的同 id 替代项。

loop 在发布工厂前等待必需的注册完成。它对模型选择和 inbox 句柄调用 `readerFor(session)`，将读取回调放入一个类型化对象传给驱动器；模型和 inbox 小组件接收各自的回调。工厂卸载时，全局注册可以先于 teardown 完成而消失；保留句柄在整个作用域清理期间仍可读取，包括作用域内 abort 监听器发起取消的时刻。调用方卸载、工厂卸载和句柄释放等待同一次 teardown。清队列错误不会跳过取消或等待已接纳工作，资源会保留到该工作结束。

### 持久化集成

循环是 Session 写句柄在生产环境中的获取点。全新创建通过取得的句柄存储构造历史；fork 创建向 `persistence.create()` 传入父引用、截点和构造完成的 log，该方法存储这些历史后才返回。SQLite 负责前缀共享、父写者排空与 Segment 创建；JSONL 复制整个 log。随后 setup 通过实时事件流追加。恢复先取得写句柄再读取历史，并将中断尾部的修复作为普通事件追加。后端将已发布 Session 的事件、flush 屏障和退役路由到活跃句柄。驱动器提交收尾事件后，teardown 关闭句柄；close 排空已路由的缓冲并释放所有权。没有后端时，Session 只存在于内存中。

### 轮次与步骤流程

驱动器在其整个生命周期内拥有一个 agent，并在 `ctx.agents.withInitiator(agent, ...)` 内运行。`AgentLoop` 在服务生命周期内注册标准 `inbox` 投影，因此冷读取在没有 Agent 和所有 Agent 卸载后都可用。它还拥有 `modelSelection`，并为每个 Agent 构建 `AgentModel`，实现公开的 [Model API](../agent/README.zh.md#model-selection)。其包内部 `ReactLoopInbox` 使用该共享投影执行结构化命令与仅供 loop 使用的领取操作。在轮次边界，它先打开持久轮次，再原子领取待处理的 next-step 输入与一条排队提示词；在步骤之间则只领取 next-step 输入。驱动器把所选根注册表的条目捕获为该步骤的 `ToolStep`，以该 `ToolStep` 组装提示词，并运行 `agent/pre-step`；fallback 在监听器执行后投影运行时上下文。被拒绝的决定或空的首批输入不打开步骤。接纳后的首次尝试先记录 `step/start`，再运行 `agent/request` waterfall 与 `prepareCall()`；这两个异步阶段都看不到待提交的系统提示词与已接纳用户消息进入历史，在任一阶段取消都不会提交这两者。每次尝试都会刷新已注册运行时事实，并保留该步骤的 `ToolStep` 与模型选择。首次尝试追加组装的 `systemUpdates()` 返回的写入，并提交已接纳的 `user/message` 批次，并原位替换循环自有上下文候选。循环恢复被移除的运行时上下文、按需记录 header 与 context，再派生并冻结请求，通过该绑定的已准备调用发起流式请求。重试复用已提交历史，不再次捕获工具，也不重复组装、`agent/pre-step` 或用户消息准入。已记录压缩摘要之后的下一次尝试（包括重试）追加 `systemUpdates()` 根据同一批已捕获段返回的重建写入。组装之后的来源变化留到下一次组装处理。请求由 `header.config`、`deriveMessages()` 与 `header.tools` 构成，不携带 `system` 字段。每次模型尝试会发出一个进程本地 `start`，仅在匹配的持久 assistant-frame 结算之后发出各个 `chunk`，并恰好发出一个终态 `end`；最终组装或消息追加失败时以 `aborted` 结算，`committed` 则出现在持久 `assistant/message` 之后。每次成功的模型调用都恰好追加一个 message 锚点，被取消的流则追加带 `interrupted: true` 的锚点并携带已交付前缀，使下一次请求包含用户看到的内容。在步骤内，独占调用形成屏障，并行安全调用使用有界滚动池；策略、持久结果与结果上下文保持模型顺序。

系统提示词组装由系统服务负责。它捕获来源文本和生命周期；组装的 `systemUpdates()` 在调用时将其与该 Session 的已提交准入比较。循环在首次尝试中、在新接纳用户消息之前追加返回的写入。首次提交即使没有指令也包含系统头节点；空头节点保留在日志中，但不进入派生模型消息。提交前的拒绝或取消不会写入头节点。压缩后的下一次已接纳模型尝试先清空保留的系统增量，再以其组装的完整提示词替换初始系统节点。这些普通 `system/message` 替换属于该开放步骤。头节点重置完成待处理的重建；此前的拒绝或取消会使重建在重启后仍保持待处理。因此，空闲压缩会保持保留的系统显示，直到另一次模型尝试发生。[system-prompt 包](../system-prompt/README.zh.md) 拥有贡献与准入语义。

运行时上下文投影比较已提交 `source.sections` 中有序的名称与文本，不依赖提醒文案。未提交的候选消息不推进其状态。消息文本会转义 `system-reminder` 结束标签，包括大小写及尾随空白变体；日志中的 sections 则保留原始文本。这种包装是格式约定，不是安全边界。

### 失败与取消

`turn/end` 声明的类型是 `TurnEndCancelCause`；取消时，循环在其中记录一份新的 `AgentCancelCause`，保留调用方的 `kind` 和 hook 的 `reason` 文本。实时 `AbortSignal.reason` 仍是调用方的那个对象，传输层可能向其添加属性——Node 的 fetch 会给它赋一个 `stack`——因此这份拷贝既让该调用栈不进入日志，也让结束事件保持可追加。

最终适配器选择、分发与迭代失败以终止结束的形式到达并进入 `agent/request-error`；处理该失败的监听器返回 `{ kind: 'retry' }` 且不调用 `next()`，未被处理的失败则是终态。Middleware、结果处理、工具及其他扩展失败仍会抛出并直接关闭轮次——插件失败结束的是轮次，不是循环。取消后未分发的模型工具调用会收到合成的 `tool/call` 加 `ABORTED_BEFORE_DISPATCH` 结果对。

<a id="returned-input"></a>

`inbox` 投影从同一组 splice 推导队列和已领取的消息。Host 检查点保存队列以及为尚未开启的步骤领取的消息。这些消息来自当前轮次，或来自因中断而结束的最近一个轮次。客户端视图提供队列。

如果轮次在 `step/start` 前因失败或保留队列的 Stop 而结束，inbox 在循环记录 `turn/end` 前把已领取的整批消息按领取顺序放回 next-turn 队首；inbox 根据自己的 `clear()` 和 `claim()` 调用做决定，循环不持有放回状态。放回的输入等待正常唤醒。步骤开始、轮次被阻止或正常结束、以及清空队列的取消都会落定领取。Session 从中断轮次恢复时，inbox 在 `agent/created` 前放回为尚未开启的步骤领取的消息；fork 保留父会话的队列，但不放回父会话轮次留下的未开启领取。每次唤醒都在步骤开始前失败的消息留在队首，直到原因修复或拥有者移除它。

如果 Goal 驱动拒绝了回到队首的轮次，本次唤醒会结束，其余输入继续排队。

关闭失败步骤之前，驱动器为每个尚无结果的 assistant 工具调用记录错误结果。已有 `tool/call` 记录但尚无已提交结果的调用获得 `TOOL_OUTCOME_UNKNOWN`；没有调用记录的请求获得 `TOOL_NOT_STARTED`。已提交的结果保持完整，已启动的派发先结算再恢复，轮次保留原始失败。这些结果让后续请求使用配对完整的工具历史，而不自动重试结果不明的操作。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定对大多数消费方已经足够；需要周边领域与设计原理时再阅读以下页面。

- [agent 包](../agent/README.zh.md)——本循环实现的 `Agent` 句柄、注册表与 `agent/*` 事件。
- [Core 子系统](../../../docs/subsystems/core.zh.md)——轮次流与拦截决策。
- [会话子系统](../../../docs/subsystems/session.zh.md)——循环写入并据此派生的持久日志。
- [工具子系统](../../../docs/subsystems/tools.zh.md)——循环分发所经过的流水线。
- [core 分组地图](../README.zh.md)——core 各包如何组合。

-----

<a id="model-experience"></a>
## 模型体验

### 完整对话请求

#### 模型看到什么

模型收到派生消息（含初始系统指令和追加段更新）及可见工具 schema。循环提供 `provider` 和 `model` 变量；working-directory 提供必需的用户上下文。请求头记录活跃工具，名称变化独立于模型能力发出 `developer/message`。请求携带 `Session.toolHistory()`，用于适配器拥有的声明。

#### Token 影响

系统文本与 schema 在每一步都重新计费，保留的系统增量会持续存在，直到压缩后的下一次模型尝试将其归并到头节点。每个 agent 的作用域选择贡献内容，组装 waterfall 可修改其展示。

#### KV Cache 影响

变化的段通过追加保留此前消息。压缩用摘要替换选区；下一次模型尝试将当前指令归并到头节点。适配器序列化决定线上前缀是否保持相同；原生历史内更新和 pi-ai 提醒保留前缀，合并的顶层系统字段则会改变它。工具声明变化有各自的缓存影响。

### 运行时上下文提醒

#### 模型看到什么

运行时上下文以 `<system-reminder>` 包装的 user 消息呈现。首份快照以 `The following information describes your current session:` 开头；后续快照以 `The following information describes your current session. It replaces earlier versions of this context, including any retained in conversation summaries.` 开头。贡献未变化时不再注入；压缩移除保留的快照后会重新注入提醒，恢复会话后也如此。有效集合变空时，在同一包装内发送 `Current runtime context: none. Earlier runtime-context snapshots no longer apply.`，并记录空的 sections。

#### Token 影响

每条保留的提醒都会增加包装、引导语及贡献内容，后续快照还包含覆盖声明。没有 `source.sections` 的旧快照或清空标记，会在下一次获准请求时刷新一次，即使其文本已经描述了当前状态。

#### KV Cache 影响

运行时提醒（包括旧记录刷新）追加在现有消息之后，保留该前缀。结构化贡献避免未变化的快照仅因文案而刷新；压缩本身会改变被替换的前缀。

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

### 步骤失败后尚无结果的调用

#### 模型看到什么

每个尚无结果的工具调用都会在后续历史中获得错误结果。对于已有记录的调用，结果说明 `Its outcome is unknown.`，且仅允许重试只读或幂等操作；可能存在副作用时，必须先核验外部状态或询问用户。没有启动记录的调用说明 `The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.`。

#### Token 影响

每个尚无结果的调用都会在历史中保留一个恢复结果，直到压缩将其遮蔽。

#### KV Cache 影响

恢复结果追加在既有历史之后，保留其可复用前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明循环何时需要特别留意。它们是当前包约束，不是任务积压。

- **分类是一元的**：安全性取决于比较同级调用或资源的调用必须保持独占（[原理](../../../.agents/notes/implemented/feature/2026-07-10-parallel-tool-call-execution.zh.md)）。
- **根上下文关停的持久化**：存在活跃 Agent 时，关停根上下文可能使最终的 `turn/end` 仅留在内存中，未写入持久化日志。Agent teardown 完成不保证该事件已保存。
- **此前已关闭的不一致历史**：失败步骤恢复不会改写已关闭历史轮次中尚无结果的调用。
- **配置标签默认对应新会话**：省略 `sessionId` 时，每次启动都会创建新的 `${id}-session-<uuid>`；如需确切的恢复或创建行为，必须显式提供稳定的 `sessionId`，而 `resumeSessionId` 要求已有持久化历史。
- **配置 agent 没有逐 agent persona 字段或 setup 钩子**：它们使用部署 persona；只有编程式 `ctx.agents.create()` / `resume()` 工厂选项支持带作用域的 persona 与工具组合。
- **没有内置轮次预算**：工具调用或 steering 会让当前轮次继续；限制失控轮次的策略必须从既有生命周期扩展点（如 `agent/turn-stopping`）执行取消。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
