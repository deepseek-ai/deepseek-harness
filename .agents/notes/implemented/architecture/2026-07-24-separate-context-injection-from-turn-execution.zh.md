# Agent Note: 将上下文注入与轮次执行分离

Status: implemented

[English](2026-07-24-separate-context-injection-from-turn-execution.md) | 中文

## 问题

agent（智能体） API 曾用三种相互重叠的方式表示面向模型的补充输入：调用方通过 `SendOptions.contexts` 附加 `HookContext[]`，拦截钩子和工具钩子返回 `additionalContexts`，插件则调用 `agent.inject()`。这些路径最终都把上下文写入同一份模型历史，但各自携带不同的放置、元数据、准入、队列和轮次生命周期规则。

将上下文原子附加到收件箱消息后，agent loop（智能体循环）曾被迫让上下文跟随提示词准入、steering（中途引导）转换、取消和终止丢弃的完整生命周期。`prompt-prefix` 放置方式又曾把上下文与直接提示词合并为一个事件，因此 transcript（文本记录）消费方不得不依赖模型不可见的封套，才能还原用户实际输入。这样一来，outbox 条目、会话投影和 UI 回放都曾负责处理本应由生产方负责的区分。

空闲状态下的 `inject()` 还暴露了另一处语义错位。注入当时并不请求模型执行，但实现仅为了满足轮次封闭不变量并获得持久性检查点，就会打开并关闭一个零步骤的 `injection` 轮次。于是，当时的轮次有时表示「运行 agent loop」，有时却表示「不运行 agent，仅持久化上下文」。

`HookContext` 的名字也描述了生产方，而非该值的职责。它可能来自原生插件、钩子桥接、提示词准入或工具后处理；其稳定含义是面向模型的额外上下文，并且 source 会指明生产方。

## 决策

`inject()` 是调用方交付补充模型输入的唯一操作，而轮次表示一次模型循环执行。

拥有上下文的调用方通过 `inject()` 交付带标识且冻结的 `UserMessage`，再独立使用 `followup()` 或 `steer()` 提交直接消息。

pre-step 的 enter 分支会为正在最终确定的请求返回完整的 `PreStepDecision.messages` 批次。工具扩展点仍可返回 `additionalContexts`，这些上下文只会在对应工具结果之后进入 next-step inbox。这些值是扩展点的输出，而不是从调用方 inbox 条目捕获的附件。

每项额外上下文都是独立的 `UserMessage`，其 `source` 会指明生产方，并携带生产方专用字段。inbox 插入会立即持久化；后续准入会将同一个值记录为 `user/message`。不再有 `context/message`、prompt-prefix 放置方式、稳定请求分隔符或提示词封套。transcript 与 UI 消费方通过 `source` 区分直接用户消息和注入上下文。

## 注入生命周期

`inject()` 始终把上下文插入不会唤醒的 `next-step` inbox，并以 `agent/inbox/spliced` 提交该队列变更。运行中的驱动器会在最近的后续 pre-step 边界领取它。idle 驱动器会让它保持待处理，直至 `followup()` 或 `steer()` 提供可唤醒工作；在此之前，取消或 dispose（资源释放）可能将其丢弃，但不会抹除持久队列历史。

循环会先领取当前 next-step 批次，再运行 `agent/pre-step`，因此领取后到达的注入可能赶不上正在最终确定的请求，而由下一次边界领取。enter decision 返回的消息会在所属轮次内、消费它们的请求之前追加。在助手工具调用批次期间产生的上下文因此只会出现在该批次全部有序结果之后。

如果 pre-step reject 或抛错，其已领取的注入上下文、steering 与排队提示词都会保持已删除，也不会追加返回批次。原子领取后插入的消息不受影响，继续保持待处理。

agent loop 只会在轮次内从进入步骤的批次追加注入的 `user/message`。核心执行事件、steering、助手输出和工具事件仍受轮次边界约束；可合并扩展事件的关系由声明它们的插件拥有，而不是采用核心默认规则。

## 扩展点与调用方语义

enter 分支的 `PreStepDecision.messages` 是拟议步骤的完整批次。waterfall（瀑布式事件）监听器调用 `next()` 委托时，会保留下游消息，除非有意替换；新增消息遵循 waterfall 的自然返回顺序。工具结果的 `additionalContexts` 保留 FIFO 顺序及每条消息的 source。

调用方主动注入与当前步骤上下文刻意采用不同的时序。`inject()` 会加入下一个可用 pre-step，无法保证正在最终确定的请求会消费它。必须影响该请求的监听器在 `PreStepDecision.messages` 中返回上下文；下游 reject 或失败时，该上下文不会落入日志。

跨会话引用采用这种领域组合方式：TUI 先准备快照，然后在 idle 直接消息的 pre-step 中把快照与该消息一同返回，或在 running 轮次中先注入快照再唤醒 steering。目标日志包含两条简单消息，因此来源会话后续变化不会改变回放，transcript 消费方也不需要提示词封套。本决策取代[跨会话引用决策](../../archived/feature/2026-07-21-cross-session-references.md)中的附件机制，但保留其快照与信任边界规则。

本决策保留[移除注入内容封套](../simplification/2026-07-20-unwrap-injected-content-envelopes.zh.md)确立的由调用方决定内容框架的原则，以及[一次 send、一个轮次](../simplification/2026-07-17-one-send-one-turn.zh.md)确立的单条目轮次规则。后续的[独立纯日志事件决策](../simplification/2026-07-28-remove-synthetic-log-only-turns.zh.md)将同样的「轮次仅表示执行」语义应用于插件所属记录。

## 曾考虑的替代方案

**保留 `SendOptions.contexts` 作为原子附件。** 提示词准入阻止消息时，这种方式能保留全有或全无交付，但也会让上下文继续成为收件箱生命周期状态的一部分，并迫使每次队列转换和观察事件携带它。大多数调用方都可以通过先注入上下文、再交付消息来表达需求，通用 agent API 不应内置领域事务。

**保留独立的 `context/message` 会话事件。** 面向模型的 user-role 输入会再次拥有两个投影完全相同的事件类型。`user/message.source` 已能为策略、transcript 和回放消费方提供所需区分。

**为空闲注入保留一次性轮次。** 持久 inbox 插入已经能在不打开轮次的情况下记录空闲上下文。合成轮次会让轮次计数与观察方报告从未运行模型的工作；不会唤醒的上下文会保持待处理，直至真实的可唤醒工作提供请求。

**保留 `prompt-prefix` 可选放置方式。** 前缀烘焙可以让上下文和请求位于同一条提供方消息中，但它会引入直接提示词的第二种表示，并把放置处理扩散到准入、steering、日志、回放和 UI 代码。需要文本框架的生产方可以直接把它写入自身上下文内容。

**让提示词钩子调用 `inject()`，而不是返回消息。** 注入可能赶不上提示词正在最终确定的请求，也会逃逸下游对该 decision 的阻止。返回完整消息批次能让当前请求上下文继续受 waterfall 约束。

## 验证

- 投递输入与 steering inbox 记录不包含附加上下文；`agent/inbox/inserted` 只报告插入消息，目标列表由持久 splice 保留。
- `UserMessage` 是提示词拦截、工具执行、钩子桥接、guard 和上下文生产方共享的带标识且冻结的形状。
- 公共类型、持久事件、投影和 UI 回放中均不存在 prompt-prefix 放置方式、提示词封套与 `context/message`。
- idle 状态下的 `inject()` 会立即追加一条持久 inbox 插入记录，但不会追加模型可见的 `user/message`；后续可唤醒投递可能开始 pre-step 处理。
- 活跃轮次中的注入会在最近的后续 pre-step 边界领取，并位于完整工具结果批次之后、消费它的请求之前。
- pre-step reject 或失败会丢弃其已领取批次；领取后插入的输入继续保持待处理。
- 单元测试、持久化与 resume 测试、不变量测试和 TUI 覆盖会固定事件顺序、领取归属和持久回放。

## 后果

- idle 注入只有在后续 pre-step 接纳它后才会对模型可见，并可能被取消或 dispose 丢弃，而其持久 inbox 生命周期仍会保留记录。
- 两条连续的 user-role 消息会取代一条烘焙后的提示词消息；提供方适配器会保留这一顺序。
- 必须影响当前请求的上下文要从 `agent/pre-step` 返回；普通注入只支持在最近的后续边界交付。
- 公共投递约定和收件箱记录保持精简：没有上下文附件、上下文放置元数据、提示词封套或重复的持久事件类型。
