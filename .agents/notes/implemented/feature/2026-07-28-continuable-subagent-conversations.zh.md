# Agent Note: 可继续的 subagent

Status: implemented

[English](2026-07-28-continuable-subagent-conversations.md) | 中文

本记录取代[可继续的后台 subagent](../../archived/feature/2026-07-21-continuable-background-subagents.md)中由 Task 支撑的继续执行管理器。它保留[将 subagent 控制合并到 subagent 服务](../../archived/simplification/2026-07-26-merge-subagent-control-service.md)确立的单一 `ctx.subagents` 服务。

## 问题

以前的继续执行管理器让一个 Task、一次提供方执行和一个结果边界共享同一生命周期。Task 结算会 dispose（资源释放）child Agent，Task 完成会注入完成通知，后续输入则重建另一个 Agent。这曾使通用后台工作抽象与会话投递耦合，而可继续 subagent 已经具备会话和 Agent inbox。

如果继续执行管理器为继续执行请求排队，而 Agent 保留自己的 inbox，系统就会出现两个 FIFO，且没有唯一的顺序权威。而把所有消息都交给 Task，则重复了 agent loop（智能体循环）已有的准入、取消和完全停稳机制。`Agent.whenIdle()` 无法恢复单项请求的 Task 结果，因为一个运行区间可能清空多个排队轮次；宽泛的 `Agent.cancel()` 也不能精确移除一项排队请求。

运行时生命周期也比单个轮次更长。subagent 可能已经结束自身轮次，但它创建的 child 仍在运行。此时 dispose parent 运行时，会移除仍负责后代拆卸的 Agent。反之，如果让所有历史 subagent 始终驻留，内存使用就会失去上界。

parent Agent 还需要在不改变当前轮次的前提下，向同一个在线 child 发送后续工作。将每条继续执行消息作为 follow-up 排队，可以保留唯一的排序规则。

## 决策

共享 activation 入口、外部执行所有权，以及调用方与父级之间的结果投递选择由[统一 subagent activation](../simplification/2026-09-17-unified-subagent-activations.zh.md) 决策拥有。本记录保留下述独立理由。

一个可继续 subagent 拥有一个持久化会话，并且至多拥有一个进程内激活：

```text
persisted Session
  -> optional live Activation
       -> one retained AgentHandle
       -> Agent inbox as the only turn FIFO
       -> zero or more owned child Activations
```

激活是重建 child Agent 的一次驻留周期。它可以执行多个 FIFO 轮次，并在等待后代时保持驻留。其回执持有这次确切驻留的结果与取消操作；它不会为每条已接受的消息分配独立结果或 Task。

继续执行管理器负责激活准入、权限检查、在线所有权图、冷恢复和 child-first dispose。Agent loop 负责全部轮次排序与执行。没有任何可继续 subagent 拥有 Task、激活 FIFO 或 queued 激活状态。

### 物化与公开操作

具名 subagent 提供方只参与准备初始创建规格，此时 `spawn` 与 `fork` 有所区别。其可选的 `prepareContinuable(request): Promise<ContinuableCreateSpec>` 方法就是可继续创建能力。返回的规格只包含与 Agent 实例分离且由提供方决定的创建输入，例如可选的 parent 历史种子；它不包含 Agent、`AgentHandle`、提示词投递、结果、dispose 或恢复操作。管理器会预留 child 身份，解析持久化描述符和通用 Agent 配置，通过私有 activation-owner 作用域调用 `ctx.agents.create()`，将返回的 `AgentHandle` 安装到激活中，建立适用的可继续 parent 所有权，然后调用 `Agent.followup(initialPrompt)`。inbox 接受消息后会产生一个 `MessageId`；`ctx.subagents.startActivation()` 在此边界返回包含 `childId`、`messageId`、`result` 与 `dispose()` 的回执，不等待轮次开始，也不等待消息写入会话日志。

inbox 接受消息前发生任何失败，操作都会在不返回任何 id 的情况下被拒绝。Agent 创建流程负责 handle 移交前的回滚；移交后，管理器会保留一个对并发投递和 drain 可见的关闭事务，dispose 已创建的 handle、移除激活并回滚 parent `ownedChildren` 中的任何成员关系，再拒绝操作。在驻留 start 事件发布前失败不会发布终止事件，start 发布后失败则通过正常 dispose 闭合生命周期配对。

提供方方法是否存在决定执行方式：`prepareContinuable()` 创建本地 activation，否则由 `start()` 启动外部执行。`delivery` 选择结果接收方，不改变本地生命周期。

冷恢复不会通过 subagent 提供方分发。继续执行管理器会归并通用的进程内描述符，通过同一个 activation-owner 作用域调用 `ctx.agents.resume()`，安装返回的 `AgentHandle`，并提交等待中的 `next-turn`。`SubagentProvider.resume?()` 和 `SubagentProviderResumeRequest` 均不存在。初始提供方注销后，描述符仍保留其名称；该名称不赋予恢复能力，也不要求后续驻留时该提供方存在。外部执行不支持冷恢复。

`SubagentProvider.start()` 与 `SubagentRun` 属于外部执行。本地 Activation 直接持有其 `AgentHandle`；两类执行共享管理器持有的容量、结算与 dispose。

`ctx.subagents.sendMessage(sender, targetId, content, { signal })` 是唯一由模型编写的继续执行消息操作。确切在线 sender 授权向其直接 parent 或直接可继续 child 投递；冷恢复会在重建前检查直接 child 权限，每条路径还会在最终无 await 的 inbox 准入区间再次检查，因此在物化期间被注销或替换的 Agent 无法授权投递。服务从该 sender 推导持久化 `agent-message` 来源信息。面向模型的 `send_message` 工具只保留 `agent_id` 和 `message`，并使用固定 Steer 调度。本地 start 返回包含已接受 `MessageId` 的 activation 回执；send 直接返回 `MessageId`。两者都不暴露物化过程是创建还是恢复 Agent。

对于 start 和 follow-up，调用方 signal 只在 inbox 接受消息前持有查找、物化和准入。inbox 接受消息后，管理器会独立持有该激活；调用方之后的取消不会取消已接受的轮次，也不会 dispose child。

### 持久化会话与在线激活

会话持有稳定的 child 身份、transcript（文本记录）、直接 parent 谱系、委派深度和带版本的继续执行描述符。`SessionHeader.parentSession` 记录直接 parent，并作为鉴权输入；它不是在线路由能力，也不表示记录的 parent 仍然驻留。

空闲的历史会话没有 `AgentHandle`。第一条通过鉴权的 `next-turn` 投递会根据持久化会话恢复激活，并将消息提交到其 inbox。冷恢复使用经过身份认证的确切在线 parent Agent 执行鉴权；当该 parent 有激活时，还使用它建立所有权，但绝不使用 parent 执行重建。

本地 Activation 直接持有已发布的 `AgentHandle` 直至结算；私有 activation-owner 作用域是其 Cordis 结构化所有者。它不创建中间 `SubagentRun`。统一管理器也通过提供方 handle 持有外部执行。dispose 后历史 Session 不保留 Agent 资源。

### 激活生命周期

内部驻留生命周期有三个条件，没有单独的 `queued` 状态：

```text
running
  | Agent quiescent with pending inbox or live children
  v
waiting
  | waking delivery
  +--------------------------> running

running or waiting
  | Agent quiescent, empty inbox, and no live children
  v
settled
  | AgentHandle.dispose completes
  v
no Activation
```

`running` 表示 Agent 正在执行准入或轮次。`waiting` 表示 Agent 已经完全停稳，但其 Inbox 非空，或激活仍持有至少一个尚未完成 dispose 的 child 激活。`settled` 表示 Agent 已经完全停稳、其 Inbox 为空且所有持有的 child 都已 dispose；随后管理器会 dispose `AgentHandle` 并移除激活。

管理器根据 Agent 是否完全停稳、Inbox 的待处理状态以及所持 child 集合派生这些状态，而不是维护第二套执行状态机。在 `running` 时投递的 `next-turn` 会进入 Agent inbox。在 `waiting` 时到达的唤醒投递会唤醒同一个 Agent，并使激活回到 `running`。在 dispose 完成后投递消息则会冷恢复新激活。

管理器会针对每个持久化 child，将 manager 所有的投递、child 释放和 dispose 线性化。管理器的私有投递将 Queue 与 Steer 委托给 Agent inbox，并检查 Activation 的 closing promise。如果 manager 投递与最终 dispose 发生竞争，只有一方能越过这条准入截止点：投递要么进入仍在线的 Agent inbox，要么观察到正在关闭，并遵循该操作特有的拒绝或冷恢复路径。直接操作 Agent 的工作不经过这层包装，因此自然结算会通过短暂的 maintenance 占用，在最终 flush 与最终 dispose 决策之前验证 idle 阶段，并在 child lock 内重新验证 Session 序号、Inbox 待处理状态、wake generation 与 owned-child set。仍然活跃或改变 Session、Inbox 或所有权状态的已接受工作会让本次结算尝试失效，而不会被它取消；完全在 flush 期间开始并结束的 maintenance 已在截止点前完成。

### 一个 inbox 与 follow-up 投递

Agent inbox 是唯一队列。Agent 消息使用 Steer；人类提示词选择 Queue 或 Steer。每个待处理 Inbox 项（包括静默注入的上下文）都会让当前 Activation 保持在线，直到被认领或丢弃。管理器与宿主都不维护第二条消息队列。

路由只取决于激活的驻留状态：

| 激活状态 | 唤醒消息投递 |
|---|---|
| `running` | 在同一激活中排队 |
| `waiting` | 唤醒同一激活 |
| 无激活 | 冷恢复新激活 |

成功的 `sendMessage()` 返回已接受的 `MessageId`；投递失败则抛错。Inbox 事件仍是消息生命周期的观察来源。服务不暴露独立的 started/queued/resumed 路由结果。

### child 所有权

每次激活都持有自身的 `AgentHandle` 和一个 `ownedChildren: Set<SessionId>`。由于一个会话至多有一次在线激活，child 会话 id 足以标识在线 child，无需另一个运行时 incarnation 引用。`SessionHeader.parentSession` 记录持久化的直接 parent 身份，`ownedChildren` 中的成员关系则记录进程内所有权关系。

当经过身份认证的 parent 自身是由继续执行管理器管理的激活时，启动 child 或提交由 parent 发起的工作，会在 child 可以运行或消息可以进入其 inbox 前，将 child 会话 id 加入该 parent 的 `ownedChildren`。该集合非空时，这个 parent 不能结算或 dispose。顶层 Agent 或其他非继续执行 Agent 没有激活，也不会加入该等待图。

只有在 child Agent 完全停稳、其 Inbox 为空、该 child 持有的每个 child 都已 dispose、best-effort 的最终会话 flush 结算、相同结算事实通过 child-lock 重验且 child 的 `AgentHandle` 完成 dispose 后，系统才释放 child。管理器会在关闭准入前等待 `ctx.sessions.flush(child.session)`，但不解释其参与布尔值：任意 listener 都无法证明所选持久化后端已存储该状态。系统会记录 rejection，但不会让它阻止重验、handle dispose 或释放所有权，因为保留 child 会让其祖先永久固定在 `waiting`。如果 child 归 parent 所有，管理器随后会通过 `SessionHeader.parentSession` 解析在线 parent，并从其 `ownedChildren` 中移除 child 会话 id。Manager teardown 使用相同的 child-first 顺序，但会立即关闭准入并停止工作，而不执行自然结算重验。

系统会一直保留所有权，直至 child 激活完成 dispose。后续改进可以更早释放限定到请求的 lease，但这需要精确关联轮次完成，而本 Task-free 设计特意不增加该机制。

顶层拆卸由宿主负责，而不表示为另一次激活。管理器卸载会调用其内部的管理器全局 drain，同步关闭准入，等待每个已获准的物化过程完成发布或回滚，停止稳定的在线森林，并按 child-first 顺序释放。拥有选定顶层 Agent 的宿主使用 `drainDescendants(parents)`：确切的 Agent 身份只关闭这些根之下的准入，直到每个身份离开注册表，而无关森林和管理器全局准入保持在线；管理器会在第一次 await 之前停止其可见后代，只等待这些根之下已获准的物化过程，并且只释放选定分支。每个已物化的 start 和在线投递都会在与 inbox 提交相同的同步区间内重新检查调用方取消、适用的 draining 作用域、Activation dispose 和确切的 parent 权限，因此只要拆卸或 parent 替换先于接受发生，就会阻止向正在关闭的 handle 投递。只有适用的 drain 结算后，宿主才能 dispose 自己的顶层 Agent；只有管理器全局 drain 会先于管理器作用域 dispose。

activation-owner 作用域之所以存在，是因为普通 Cordis owner effect 按注册逆序撤销，无法表达动态 child 图。管理器初始化时先注册私有作用域的结构化 disposer，再注册自身的 drain disposer，使逆序撤销先执行 drain、再释放该作用域；如果只在与后续 Agent handle 相同的作用域上注册 cleanup effect，结构化 handle dispose 就可能绕过 child-first 顺序。每个物化过程都会在启动内部事务前注册其屏障参与项，并对其确切的在线祖先建立快照，然后保持跟踪，直到安装 Activation 或完全回滚。Activation 会保留其在这组祖先中的弱成员关系，因此中间 Agent 即使离开注册表，也不会让仍在线的后代脱离宿主根节点的可见范围。管理器会在取消或递归回调前安装一个记忆化的 closing promise，使限定作用域的宿主关闭、全局管理器卸载、child 释放和正常结算能够汇合，而不会重复释放。取消会在等待缓慢的后代清理之前自顶向下传播；handle 释放仍是 child-first。同级分支独立 drain；系统会记录单次 dispose 失败，但仍会尝试其余选中 handle，聚合 drain 则在所有选中分支结算后报告失败。这次进程内拆卸不会销毁持久化 child 会话。

### 相邻 Agent 消息

共享的 `sendMessage(sender, targetId, content, options)` 服务操作不会增加第二条队列。它接收确切在线 sender，只允许其直接 parent 或直接可继续 child，并通过 Agent inbox 使用固定 Steer 调度。全局 `send_message({ agent_id, message })` 工具在两个方向暴露同一个操作；当 child 可以看到该工具时，其初始任务会标明直接 parent。[相邻 Agent 消息 Agent Note](../architecture/2026-08-27-adjacent-agent-steer-messaging.zh.md)规定其 schema、权限、来源信息与提示词位置。

### Agent 与人类调度

每条已接受的 Agent 消息都使用 `Agent.steer()`。运行中的目标会在最近的 step 边界领取消息；空闲或冷恢复的目标会启动一个轮次。浏览器编写的人类输入会另行通过 `subagent.prompt` 携带 `delivery: 'queue' | 'steer'`：Queue 开启后续 FIFO 轮次，Steer 使用相同的 best-effort 最近 step 调度，并保留消息的人类来源。公开服务不为 Agent 消息提供调用方可选的调度模式。

### 权限与已记录的发送方身份

权限来自确切的在线 Agent 工具上下文。准入后，`MessageSource` 和 `senderSessionId` 记录谁提供了消息；调用方不能用这些字段取得权限。

本版本只授权持久化 child 的直接 parent。管理器会在将 child 注册到该 parent 的 `ownedChildren` 之前，于最终无 await 的 inbox 准入边界根据确切的在线 parent Agent 检查 `SessionHeader.parentSession`；冷恢复还会在重建前执行一次更早的检查，以便快速失败。其他 Agent、祖先、宿主、团队和工作流仍被拒绝，直至有具体消费方证明另一种权限协议合理。

由 parent 发起的投递要求 parent 在准入时在线，并通过所有权关系使其继续在线。

### 持久性、dispose 与恢复

activation 回执无需 Jobs 即可暴露 `result` 与 `dispose()`。调用方 signal 持有未发布工作；回执 dispose 会取消确切的 activation，并等待后代启动回滚与 child-first 释放。[当前轮次中断](../../../../packages/subagent/subagent/README.zh.md)仅以 `keepInbox` 取消在线目标轮次，保留驻留、待处理工作与后代。

宿主和管理器拆卸仍是生命周期停止路径。管理器卸载会全局应用它；宿主只会在自己确切拥有的顶层 Agent 之下应用它。两种形式都会关闭适用的准入作用域，停止选中的可见 Activation，等待该作用域中已获准的物化过程，按 child-first 顺序释放，并保留持久化 Session。

每个轮次都会请求执行会话持久性检查点，而 Activation 最终结算还会在关闭准入前等待 `ctx.sessions.flush()`，将其作为 best-effort 屏障。管理器随后会重新验证 await 期间没有 Agent、Inbox、Session 或 owned-child 状态发生变化；观察发生变化时，系统会重试结算并 flush 更新后的状态。管理器特意忽略 flush 布尔结果，因为 listener 是否参与无法标识持久化后端。系统会记录 rejection，但不会改变生命周期结果或宿主 drain 的结果；管理器仍会执行最终重验，在重验成功时 dispose handle 并释放所有权，后续恢复时持久化 child 状态可能缺失或陈旧。

只有实际写入 child 会话日志的消息，才能在重建时保留提供它的来源；仅被 inbox 接受并不提供重启保证。

会话和描述符的持久化状态可在重启后保留。激活状态、Agent inbox 内容和所有权图都是进程内状态。进程崩溃可能丢失已被接受但仍留在 inbox、尚未写入会话日志的初始提示词或 follow-up。会话和描述符可能保留，因此后续获得授权的消息仍可冷恢复 child，但丢失的消息不会自动回放。恢复已接受但未完成或未写入日志的消息需要持久化 inbox 协议，本提案不隐含该能力。

### 范围

本地可继续控制与外部执行共享 activation 所有权。只有本地 child 支持后续消息与冷恢复。

人工 Queue/Steer 投递和[当前轮次中断](../../../../packages/subagent/subagent/README.zh.md)使用此生命周期；回执释放会停止这次确切 activation 及其所属后代。持久化邮箱、跨进程 lease、中断 inbox 工作的自动回放、团队权限、工作流权限、公开驻留查询和运行时缓存仍不属于此能力。委派深度策略和相邻 Agent 消息授权各自由其原有组件管理。

## 曾考虑的替代方案

**保留由 Task 支撑的激活。** Task 可以提供通用状态、结果收集和取消，但使用 Task 投递会话会产生第二条队列，并重复轮次所有权。本设计放弃这些通用 Task 控制，让 Agent inbox 成为唯一执行顺序。

**每个 `next-turn` 创建一次激活。** 这会恢复独立的结果与取消边界，但需要在 Agent inbox 旁维护管理器 FIFO，还会使所保留的 Agent 跨越人为划分的激活边界。每个驻留周期对应一次激活更小，也直接跟随 `AgentHandle` 生命周期。

**等待期间 dispose Agent。** child 仍属于上一个进程内所有权图时重建 parent，需要持久化所有权与拆卸协议。只为尚未完成的所有权图保留 `AgentHandle`，可以在不让已结算历史驻留的前提下，保留 child-first 拆卸。

**让提供方通过 Agent handle 创建、恢复 child 或投递消息。** 初始提供方只持有 `prepareContinuable()` 及其分离式创建规格这一项差异：child 是全新启动，还是带有 parent 前缀。管理器必须通过私有 activation-owner 作用域自行调用 `ctx.agents.create()`，使该作用域成为每个 handle 的结构化所有者。持久化的进程内会话已经包含初始前缀及通用重建描述符，消息投递则属于 Agent inbox。让提供方持有任何后续 handle、`SubagentRun` 或消息所有权，会让提供方保留所有权，却没有已发布行为需要它。

**把 child 编写的报告纳入驻留。** 相邻 Agent 消息通过 `send_message` 独立组合；其权限与调度独立于驻留。父级结果投递由管理器持有，即使 child 没有发消息，也会包含运行时结算通知。

**将 `SessionHeader.parentSession` 视为在线所有权。** 持久化谱系不能证明已记录的 parent 当前持有 child。在线 parent 的 `ownedChildren` 成员关系会记录进程内关系，而不改变持久化 parent id。

**在单独的 link 中保留确切的 parent Agent。** parent 激活已经持有自身 `AgentHandle`，而且 `ownedChildren` 会在 child 仍然在线时阻止该激活 dispose。因此，通过会话 id 解析 parent 已经足够，也可以避免冗余的运行时引用。

**为继续执行消息维护单独队列。** 第二个 FIFO 会让它和 Agent 已接受消息之间顺序不明确。单个 Agent inbox 为每个已接受轮次提供唯一且可观察的顺序。

**现在就暴露 subagent steering。** parent steering 需要当前轮次控制方状态，以及不同于 follow-up 投递的单独准入策略。首个版本将每条继续执行消息都排队，可以避免引入该状态及其准入竞争。

**在没有 host 消费方的情况下暴露 host-user follow-up。** 公开的权限铸造方法和用户分支可以在没有历史 parent 的情况下实现冷恢复，但没有生产 host 适配器调用该操作。在具体的经认证宿主交互能够收到私有能力之前，继续执行 API 只接受确切的在线 parent。

**返回 subagent 专属的投递路由。** `started`、`queued` 和 `resumed` 等标签重复了激活与 inbox 状态，却没有给调用方提供独立结果。复用 `MessageId` 和现有 inbox 事件，可以让投递关联继续由其所属的 Agent 约定承载。

**使用 child 引用计数。** 计数无法识别哪个 child 仍持有拆卸工作，也允许重复递减错误。身份集合会显式保留取消和 dispose 义务。

## 影响

本实现固定了以下行为：

- 可继续 child 至多拥有一个在线激活和一个 Agent inbox；继续执行管理器没有激活 FIFO 或 queued 激活状态。
- `SubagentProvider.prepareContinuable?()` 返回独立的本地创建输入；`start()` 建立外部执行。
- 管理器通过私有 activation-owner 作用域调用 `ctx.agents.create()`，安装返回的 `AgentHandle` 并建立 parent 所有权，调用 `Agent.followup(initialPrompt)`，然后在 inbox 接受消息并产生 `MessageId` 时返回包含 `childId`、`messageId`、`result` 与 `dispose()` 的回执，而不等待轮次开始或消息写入会话日志。
- 初始提示词被 inbox 接受前的每条失败路径都会导致操作被拒绝且不返回 id，并通过一个对并发投递和 drain 可见的关闭事务回滚已创建的任何 handle、激活和 parent `ownedChildren` 成员关系；生命周期发布失败不会产生无配对的终止事件。
- 冷恢复由继续执行管理器调用 `ctx.agents.resume()`，绝不通过或依赖初始 subagent 提供方；提供方移除后，描述符仍保留初始提供方名称，且 `SubagentProvider.resume?()` 和 `SubagentProviderResumeRequest` 均不存在。
- 本地 Activation 直接持有 `AgentHandle`；外部 Activation 持有 `SubagentRun`。
- `sendMessage()` 只接受确切在线的相邻 Agent，并在物化后的最终 inbox 准入处重新检查权限；记录的来源字段不能授权投递。
- Agent 消息使用 Steer；人类 Queue 提示词保留 FIFO 轮次顺序。
- `ctx.subagents.sendMessage()` 返回已接受的 `MessageId`，不暴露物化路由。
- 调用方 signal 停止未发布工作；activation 回执与宿主 drain 持有 child-first 拆卸。[当前轮次中断](../../../../packages/subagent/subagent/README.zh.md)保留待处理工作与驻留。
- 人类提示词投递与当前轮次中断保留各自的权限检查。
- 带有在线所持 child 的空闲 Agent 会产生 `waiting` 激活，其 `AgentHandle` 继续保留。
- 向 `waiting` 投递 `next-turn` 会唤醒同一个激活；完成 dispose 后投递消息会冷恢复新激活。
- 每个由继续执行管理器管理的 parent 激活只会在直接持有的所有 child 激活完成 `AgentHandle` dispose 后进行 dispose；顶层 Agent 不加入等待图。
- Activation 最终结算会在准入开放时等待 `ctx.sessions.flush(child.session)`，将其作为 best-effort 屏障；它会记录 rejection，但不会把 listener 参与解释为持久性证明，随后在 child lock 内重新验证最终状态，再关闭准入、dispose child handle 并释放 parent 所有权，使 flush 失败不会泄漏 `waiting` Activation。
- 管理器拆卸会全局关闭准入；拥有选定顶层 Agent 的宿主则只关闭这些确切身份之下的准入，直到这些根离开注册表。两者都会按确切祖先关系跟踪已获准的物化过程，为每个选中的可见 Activation 安装一个记忆化 dispose 截止点，自顶向下传播取消，按 child-first 顺序释放 handle，即使个别分支失败也会等待所有选中分支，之后才 dispose 对应的顶层 Agent 或管理器作用域。
- parent 投递独立于 child 编写的消息发出运行时结算通知。
- 会话日志只会重建实际写入的消息，并保留每条消息的提供来源；已被 inbox 接受但未写入日志的消息没有重启保证。
- 可继续 subagent 路径不创建或依赖 Task、`JobId`、Task 完成通知、Task 取消或中间的带结果执行包装层。
- 单元覆盖固定 `startActivation()` 在 inbox 接受消息时的返回边界、每条接受前和生命周期发布失败路径的完整回滚、全局和限定到 parent 作用域的 drain 都会等待夹在 Agent 发布与 Activation 注册之间的物化过程完全停稳、同级森林隔离、中间 Agent 离开注册表后的确切祖先关系、不依赖提供方的冷恢复、冷恢复物化后的最终确切 parent 再授权、接受前后两个阶段的调用方 signal 与拆卸所有权，以及已接受但未写入日志的消息不会自动回放。
- 单元覆盖固定仅由驻留状态决定的路由表、单 inbox 顺序、通过 inbox 事件关联 `MessageId`、在开放轮次期间 follow-up、等待唤醒、冷恢复、所有权注册与释放、child-first dispose、发送与 dispose 的竞争、在最终 flush await 期间接受的直接 Agent 轮次、仅修改 Session 的工作与 maintenance、没有 listener 和 listener 失败时的 best-effort 最终 flush，以及单独鉴权的人类提示词投递与中断。
- 相邻 Agent 测试覆盖直接 parent 权限、工具可见性、冷恢复与结算期间投递。
- keyless 组装应用快照覆盖委派、相邻 Agent 消息、运行时结算通知与 child-first dispose。

### 已接受的代价

移除 Task 会放弃通用后台工作检查、结果收集和精确 Task 取消。如果这些产品功能成为需求，就需要不会重新引入第二条执行队列的请求 ticket 或 inbox 能力。

在后代运行期间保留激活，会按尚未完成所有权图的规模消耗 Agent 资源。现有委派深度策略仍会限制嵌套层级，而[共享 Activation 容量](../../../../packages/subagent/subagent/README.zh.md)限制存活的可续接后代数；已结算的历史会话不保留 `AgentHandle`。

进程内 inbox 和所有权图无法协调两个 harness 进程。允许多个进程并发访问同一持久化存储的部署，仍需要持久化 lease 和邮箱协议。

child 编写的 `send_message` 调用与管理器编写的结算通知在父级日志中保持区分。本地 child 的完整文本记录保留在其自身的持久化 Session 中。

Steer 投递抵达下一个可用 step 边界，不会抢占正在执行的工具。Queue 投递保留后续轮次顺序。

best-effort 最终 flush 失败时会记录日志，同时运行时所有权图继续 drain；持久化 child 状态可能缺失或陈旧。重试与修复需要单独的恢复设计。
