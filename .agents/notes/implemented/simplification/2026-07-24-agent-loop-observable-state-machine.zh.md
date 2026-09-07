# Agent Note: 围绕可观察状态机收拢 agent loop 事件

Status: implemented

[English](2026-07-24-agent-loop-observable-state-machine.md) | 中文

## 问题

agent loop（智能体循环）曾将其控制流暴露为大量 Cordis 事件。`pre-step` 和 `post-step` 两个独立检查点分列步骤前后，`session-prefix` 和 `step-result` 分别变换请求消息与响应消息，`request-error` 决定失败的请求是否在当前轮次内重试，`turn-continuation` 与 `turn-stop` 则组合相互竞争的继续执行决策。

即使持久会话日志已经记录了对应的轮次与步骤事实，这些事件仍会将内部阶段公开。它们还混用了两种扩展模型：部分监听器观察边界并发出 agent 命令，另一些监听器则返回由循环解释的控制决策。因此，要理解公开状态机，必须同时还原事件顺序、waterfall（瀑布式事件）优先级和特殊的终止覆盖规则。

agent 生命周期、agent 整体活动状态、收件箱条目的进度以及每轮次的结算，是彼此独立的状态维度。若将它们视为一个状态或一条线性回调序列，常见问题就会产生歧义：agent 可以在多个轮次之间持续保持 `running`；已接受的条目可以不启动轮次就被丢弃；一个轮次可以完成结算，而后续工作仍让 agent 保持活动。

## 决策

公开约定暴露四个正交的状态维度：

- 注册生命周期是从 `agent/created` 到 `agent/disposed` 的区间。dispose（资源释放）是注册表的终止边界，而不是一种 `AgentStatus`。
- agent 整体活动状态为 `AgentStatus = 'idle' | 'running'`。连续多个轮次可以共用同一个 `running` 区间。
- 待处理消息插入时会发出 `agent/inbox/inserted`，随后要么在原子纯删除领取后发出 `agent/inbox/claimed`，要么在普通删除后发出 `agent/inbox/discarded`。`MessageId` 关联确切消息；持久 splice 坐标保留位置信息与取消信息。inbox 事件描述插入、领取和丢弃，而不是轮次完成。
- 已领取的轮次经过 pre-step 进入决策和零个或多个请求步骤。自动重试会关闭失败轮次并立即开启另一个轮次；`agent/settled` 只报告该重试链的终态轮次，且仍不同于 agent 整体转换到 `status === 'idle'`。

循环保留四个状态机扩展事件。`agent/pre-step` 对独占的已领取批次执行 reject 或 enter 决策，并在每个拟议步骤前运行。`agent/request` 是冻结调用配置所用的 waterfall；配置只能来自 `await next()`，不再通过重复的位置参数提供。`agent/request-error` 串行确定需要等待的模型请求恢复由谁负责。当轮次原本已经没有剩余工作时，`agent/turn-stopping` 运行；需要再执行一个步骤的监听器使用 `agent.steer()` 记录真实的 steering（中途引导），循环在所有监听器完成后根据这份数据作出决定。

是否继续和终止执行由数据表达，不再由返回的控制枚举表达。工具调用和已接受的 steering 要求再执行一个步骤。携带 `concludesTurn` 的工具结果会在其所属步骤终止工具循环。循环不再暴露通用的 `ContinuationDecision` 或终止返回通道。

模型请求失败会先关闭当前步骤，再携带该错误本身、标准化 `LlmFailure` 和仍有效的轮次信号进入 `agent/request-error`。负责恢复的监听器修复状态、返回 `{ kind: 'retry' }`，并停止继续委托。循环会关闭失败轮次，并基于该状态开启一个重试轮次，中间不发布空闲通知；重试不是失败轮次内的另一个步骤。`agent/settled` 报告终态结果；对于需要脱离轮次结算单独报告失败的消费方，`agent/error` 仍作为实时错误通知保留。[重试动作决策](2026-07-27-request-error-retry-action.zh.md)取代了本设计中命令形式的部分。

事件分类体系移除了旧的提示词准备／提交与串行步骤钩子，以及 `agent/post-step`、`agent/session-prefix`、`agent/step-result`、`agent/turn-continuation` 和 `agent/turn-stop`。唯一的 `agent/pre-step` waterfall 负责已领取消息能否进入步骤。持久的轮次与步骤边界仍由会话事件记录。面向模型的新增内容使用有日志记录的消息通道，请求配置使用 `agent/request`，响应内容按组装后的原样记录，失败请求恢复使用 `agent/request-error` 返回动作，轮次结束时是否继续则使用 `agent/turn-stopping` 加 steering 表达。

## 考虑过的替代方案

**保留细粒度事件序列。** 这样可以为每个内部阶段保留专用拦截点，包括仅用于请求的前缀、助手消息改写、步骤后处理、轮次内请求恢复以及终止覆盖。但这也会使循环的私有执行顺序成为永久的公开约定，并允许相互重叠的扩展点表达彼此冲突的决策。当前决策接受这些拦截点的缺失，以换取每项受支持的扩展职责仅对应一个边界。

**将 dispose 表示为第三种 `AgentStatus`。** 这样会让仍被持有的句柄得到一个终止状态值，但也会重复表达 `agent/disposed` 已经体现的注册表生命周期。当前决策让 `AgentStatus` 只表示 agent 存续期间的活动状态，并将注册生命周期作为独立维度。

**让 `agent/request-error` 返回重试决策。** 这一替代方案已由[重试动作决策](2026-07-27-request-error-retry-action.zh.md)取代；新决策移除了重复命令，并将决策局限于 waterfall 的返回结果。

**将持久的轮次与步骤边界映射为 agent 事件。** 这样会为同一事实向实时消费方提供第二条事件流。当前决策将会话日志保留为真源，仅暴露扩展检查点或持久事件流无法承载的纯实时事实。

## 影响

可观察状态机更小，也更容易组合：注册生命周期、活动状态、条目进度和终态结算可以分别追踪。尤其是，`agent/settled` 并不意味着 `agent.status === 'idle'`；前者报告一次排空链的终态轮次，`agent/status` 则报告整个 agent 是否处于活动状态。

插件不再能够改写循环的每个阶段。不再提供仅用于请求的消息前缀、助手消息变换、步骤后检查点、通用的继续执行枚举、通用的终止结果或轮次内请求重试。扩展改用剩余的归属明确的通道，而不是重新构造这些阶段。

负责继续执行的插件发布可持久化的 steering，而不是返回未记录到日志中的原因。恢复插件在失败步骤结束后处理错误，并返回显式重试动作。这样，每次尝试都会成为完整轮次，同时异步修复和策略归属集中在一个狭窄的 waterfall 边界。

收件箱生命周期用于补充持久会话日志，而非取代它。`MessageId` 将接受操作与领取或丢弃操作关联起来；轮次编号与步骤编号、消息、工具活动和终止原因仍属于会话事实。

## 相关内容

- [统一 agent 交付路由，并将注入上下文合并到 user/message](../../archived/architecture/2026-07-22-unified-send-and-coalesced-user-messages.md)
- [移除普通发送中的隐式批处理](2026-07-17-one-send-one-turn.zh.md)
- [微内核事件分类体系](../architecture/2026-06-11-microkernel-event-taxonomy.zh.md)
- [有界 LLM（大语言模型）请求恢复](../architecture/2026-06-21-bounded-llm-request-recovery.zh.md)
- [可重建的请求](../architecture/2026-07-05-reconstructable-requests.zh.md)
