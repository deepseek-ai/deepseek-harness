# Agent Note: 将 agent 投递统一到 send(target × wakeup) 并把注入的上下文合并进 user/message

Status: implemented
Archived: 2026-09-04

[English](2026-07-22-unified-send-and-coalesced-user-messages.md) | 中文

## 问题

agent（智能体）的对外驱动接口逐渐长出三个近乎平行的动词——`send`、`steer`、`inject`——各自带有独立的选项类型、独立的实时事件叙事，以及独立的持久事件。`send` 和 `steer` 都会把一条冻结的 inbox 记录入队并发出 `agent/queued`；`inject` 则绕过 inbox，写入一条独立的 `context/message` 持久事件。这三个动词实际上只沿两条独立的轴变化：一个队列项加入哪个队列（一个全新的轮次，还是当前活跃的轮次），以及这个队列项是否让模型运行。把这个 2×2 编码成三个手写方法，掩盖了其中的对称性，让「排入一个轮次但不唤醒驱动器」无法表达，也让 `cancel()` 无从在保留排队工作的前提下中止一个轮次。

另外，`context/message` 与 `user/message` 已经趋同：对外接口把二者都原样投影为 user 角色内容，唯一真正的区别是注入的上下文携带非 user `source` 且「不是提示词」。一个投影对应两种事件类型，意味着每个消费方都要根据事件类型分支来回答「这是不是一条人类提示词？」，而 goal 系统把这种类型区分当作侧信道使用（第 0 个 Round 的状态变更是 `context/message`，已准入的 Round 是 `user/message`）。

## 决策

**一个原语，三个预设别名。** `Agent` 接口的 `send(message, target, wakeup)` 覆盖（`target` × `wakeup`）矩阵。完整的 `UserMessage` 持有标识、角色、模型可见 `content` 与生产方 `source`；其余参数只持有路由策略。`followup`（`next-turn`/wakeup）、`steer`（`next-step`/wakeup）和 `inject`（`next-step`/no-wakeup）都接收这一条消息并固定策略。`wakeup` 会在 agent 空闲时保留一个驱动器；已经活跃的驱动器不会获得第二次保留，只有在抵达后续 pre-step 边界时才能领取该输入。`next-turn`/no-wakeup（入队但不唤醒）可以表达，只是没有别名，也没有当前调用方。

**inject 是不会唤醒的 next-step 投递。** 它始终把完整消息追加到 next-step inbox，并在持久 `agent/inbox/spliced` 事件中记录该插入。驱动器会在后续 pre-step 领取它，并且只有最终决策把它放入进入步骤的批次时，才会将其记录为模型可见的 `user/message`；空闲注入会保持待处理，直到其他投递唤醒驱动器。必填的 `UserMessage.source` 会保留调用方提供的源字段。

**context/message 已移除。** 注入的上下文在 inbox 中使用同一个 `UserMessage` 值，并在获准时成为 `user/message` 事件；上下文生产方显式提供合适的非 `user` 类别 `source`，类型化 source 变体携带持久化的生产方专用字段。对外接口、派生逻辑和 `SurfaceEventType` 都不再包含 `context/message`；需要判断「这是不是一条人类提示词？」的消费方改为读取 `source.kind === 'user'`，而不是事件类型。

**Goal 继续执行归属使用正数 Round。** Goal 生命周期状态通过后续的[Goal 自有持久事件决策](2026-07-31-goal-owned-durable-events.zh.md)所定义的领域自有 `goal/change` 事件提交。正数 Round 只从已准入的继续执行 `user/message` 推进；goal 持久化不使用注入或 inbox 状态。

**`send` 不返回标识。** 调用方已经持有完整消息及其不透明的 `MessageId`；消息的创建与冻结由[带标识的不可变消息值决策](2026-07-28-identified-immutable-message-values.zh.md)负责，而不是由路由负责。

**Inbox 变更只有一份持久投影和三种最小实时通知。** 每次 append、prepend、编辑、删除、取消与领取都会记录规范化的 `agent/inbox/spliced` 坐标。插入会发出 `agent/inbox/inserted { message }`；普通删除携带持久 `outcome: 'canceled'`，并发出 `agent/inbox/discarded { message }`；循环的原子 `claim()` 会记录纯删除 splice，随后发出 `agent/inbox/claimed { message, turn }`。`MessageId` 是唯一的单次出现标识，并在两个待处理列表间保持唯一。实时载荷刻意不携带 placement、outcome 或批次封套，因为这些事实由持久 splice 持有。

**pre-step 会领取 next-step 输入，但不会为它单独创建轮次。** steering（中途引导）和注入始终进入同一个 next-step inbox；steering 会唤醒驱动器，注入则不会。在轮次边界，驱动器会原子领取待处理的 next-step 输入，再领取一条排队提示词；在步骤之间则只领取 next-step 输入。领取会记录纯删除 splice，并针对每条消息发出一次 `agent/inbox/claimed { message, turn }`。随后 `agent/pre-step` 会拒绝拟议步骤，或返回进入步骤的完整批次。拒绝与监听器失败都会让已领取批次保持已删除；领取后才到达的输入会等待后续边界。

**一条已接受消息只保留一种表示。** 持久的用户角色输入和附加的模型可见上下文都直接使用带标识且冻结的 `UserMessage`。循环把该值与私有路由状态存放在一起，不会将其标识、内容或来源复制到另一种公开形状中。steering、注入和工具产生的上下文都会在 next-step inbox 中保留各自带标识的消息。[带标识的不可变消息值决策](2026-07-28-identified-immutable-message-values.zh.md)取代了本记录此前的 `UserMessageData`/`AgentMessage` 层级，并将这一表示扩展到 assistant 消息和工具结果消息。

**空闲唤醒在插入之后发生。** 会唤醒的发送会先插入输入，再于返回前进入 running 驱动器。首次 pre-step 可能立即领取该输入；因此，后续同步发送会加入正在运行的循环，并等待更晚的边界。自唤醒开始，取消就归属于 running 轮次信号，中间不会插入独立的预运行 phase。

**cancel 新增 keepInbox。** `cancel(cause, { keepInbox? })`；调用方显式选择 cause，且 `keepInbox: true` 会中止活跃轮次，同时保留排队项和 steering 项（不发出 discard 事件，尚未启动的工作也不会被丢弃）。

## 考虑过的替代方案

- **为注入内容设立专门的 `MessageSource` 类别 `context`。** 不予采纳，因为 `plugin` 已经表示「不是人类」，因此第四种类别会增加一条平行的轴，让授权检查不得不去学习它。由插件产生的注入上下文会显式提供其插件来源。
- **在 `UserMessage` 上设一个类型化的判别字段**（例如 `origin: 'prompt' | 'context'`）来取代事件类型的区分。不予采纳，转而采用 `source`——每个消费方都已经携带它，goal 系统也已经以它为键；第二个判别字段会重复这一事实。
- **在 inbox 事件之外保留 `agent/queued`。** 作为镜像而被否决：`agent/inbox/inserted` 已经是实时插入信号，claimed/discarded 通知描述退出，而持久 splice 保留 placement。
- **根据 agent 状态推导 inbox 放置方式。** 不予采纳，因为 `running` 同时涵盖 pre-step 处理与结算。生产方已经把精确目标写入持久 splice。

## 后果

投递接口现在是一个原语加三个自解释的预设，（`target` × `wakeup`）矩阵把此前无法表达的组合显式化。同一个带标识消息值同时服务提示词、注入的上下文和 Goal Round，因此每一处「是否人类提示词？」检查都简化为一次 `source` 判断。`Agent` 约定仍是接口，因此其他实现和对象字面量形式的测试替身只需实现同一个最小结构接口。正数 Goal Round 从已准入的 `user/message` 事件折叠，而 goal 生命周期状态位于投递接口之外。空闲注入会保持待处理，不打开轮次也不运行模型；后续会唤醒的投递在 pre-step 将其放入进入步骤的批次时，它才成为 `user/message`。

`wakeup` 是「模型是否应当运行」的信号，因此 inbox 会区分能唤醒的排队工作与任何可领取的项：一个孤立的 `next-turn`/no-wakeup 队列项会停泊在空闲状态，并随下一次唤醒 send 一同带出，而 `whenIdle`/`cancel` 依据唤醒信号来结算完全停稳。每次插入与退出都会发布对应的实时通知，特定于领域的持久事实则通过类型化消息 source 传递，而非通过平行的元数据通道。直接使用待处理消息的表示方式，使持久 splice 与实时事件保持可关联，既无需维护第二个 steering 包装层，也避免数据发生分歧。后续的[已领取 pre-step inbox 生命周期](2026-07-31-claimed-pre-step-inbox-lifecycle.zh.md)决策保留通过 `MessageId` 寻址的实时队列变更，并把单消息生命周期通知与持久的整体队列 splice 投影分离。

## 相关

- [one-send-one-turn](../simplification/2026-07-17-one-send-one-turn.zh.md)——本决策所依托的「每轮次只认领一条消息」规则。
- [remove-agent-steering-mirror](../../archived/simplification/2026-07-04-remove-agent-steering-mirror.md)——折叠镜像实时事件的先例。
- [explicit-turn-cancellation](2026-07-16-explicit-turn-cancellation.zh.md)——`keepInbox` 所扩展的取消原因信号。
- [带标识的不可变消息值](2026-07-28-identified-immutable-message-values.zh.md)——本路由决策现在所依托的消息标识与表示约定。
