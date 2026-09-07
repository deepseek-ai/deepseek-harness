# Agent Note: follow-up 入队与自有运行边界

Status: implemented

[English](2026-07-30-followup-enqueue-and-owned-runs.md) | 中文

## 问题

`Agent.followup()` 会标识一条用户消息并将其排入队列，但单次 follow-up 并不拥有随后发生的活动。在 agent（智能体）下一次进入 idle 前，steering（中途引导）、注入的上下文、工具续行、恢复和后续排队消息都可能参与活动。因此，`MessageId` 可以证明消息已获 inbox 准入，但不能标识哪一条 assistant 消息或哪一个 `turn/end` 是该输入的结果。

[one-send-one-turn 决策](../simplification/2026-07-17-one-send-one-turn.zh.md) 已经在核心 API 中排除了按 send 返回完成句柄的设计。凡是把一项提示词请求与一个轮次结果配对的协议层和 SDK 层，都会在下游人为构造这一缺失的关系。一旦活动准入更多输入，该配对就会产生歧义，还会把轮次机制暴露为提示词级结果。

## 决策

保留 `Agent.followup(message): void`，使其仅执行入队。`Agent.whenIdle()` 和 `agent/status` 仍用于观察整个 agent 的生命周期；二者都不结算单条消息。Inbox 持久性会记录已标识消息及其准入或取消，但不会把后续输出归属于该消息。

底层 SDK 协议在入队成功后立即以 `{ messageId }` 响应 `session/prompt`。它通过 `session.event` 流式传输持久事实，通过 `session.status` 发布整个 agent 的状态转换，且不包含 `session.finished`。底层客户端可以观察该回执和之后的 idle，但不会收到提示词结果。

只有明确拥有一个活动区间时，高层自动化 API 才返回 `RunResult`。TypeScript 和 Python SDK 的 `run()` 方法从已提交消息的持久 inbox 回执开始收集，直至整个 agent 下一次进入 `idle`；其最终响应是该区间内最后一条已提交的 assistant 消息，而不是按因果关系归属于已提交提示词的响应。Python SDK 还把根会话最后一个轮次的结束原因 kind 作为运行级 [`finish_reason`](../../archived/bug-fix/2026-08-11-owned-run-finish-reason.md) 返回，但不会将其归因于已提交的提示词。单次 CLI（命令行界面）拥有相应的 idle 到 idle 区间。隔离的子 agent 运行可以报告结果，因为调用方拥有完整的子级生命周期，任何 steering 都属于该运行。

ACP（Agent Client Protocol）必须返回协议规定的 `stopReason`。其桥接层对每个 ACP 会话中的提示词进行串行处理，并拥有从准入到整个 Agent idle 和有序更新交付的区间。它会关联准入该已识别 ACP 消息的轮次，但不会声称区间内所有活动都只由该消息引起。关联的 token 上限结尾映射为标准 `max_tokens`；关联模型错误在同一个完全停稳边界拒绝；无轮次 slot 与显式 ACP 取消或 dispose 一样以 `cancelled` 结算。其他正常完全停稳报告 `end_turn`。

Goal 续行只保留 `MessageId`，用于识别持久排队和已准入的 goal 消息。它在整个 agent 进入 idle 时根据持久 goal 状态推进，不把消息映射到轮次结果。

## 考虑过的替代方案

**将 `MessageId` 映射到准入它的轮次。** 一个轮次可能使用 steering 和注入的上下文，还可能经过多个模型／工具步骤继续执行。该映射只能标识准入，不能确立结果输出或停止原因的因果归属。

**返回按 follow-up 区分的完成句柄。** 这样的句柄暗示共享 agent 生命周期中存在并不实际成立的结果边界。它要么遗漏影响活动的工作，要么在不作说明的情况下吸收后续无关输入。

**使用进入 idle 前观察到的最后一个 `turn/end`。** 对于明确拥有的区间，这是一项有用的运行级观测；但如果将其命名为已提交消息的结果，就会再次作出错误的因果声明。

## 验证

- Agent 与 inbox 测试固定 follow-up 仅入队、持久准入或取消以及整个 agent 的 idle 观测。
- SDK 协议、TypeScript SDK 和 Python SDK 测试固定 `{ messageId }` 回执、`session.status`、不存在 `session.finished`，以及不含提示词级 `status` 或 `reason` 的回执到 idle `RunResult` 收集；Python SDK 测试另行固定其运行级 `finish_reason` 观测。
- ACP、单次 CLI、goal 续行和 subagent 测试固定各集成实际拥有的不同活动边界。
- 消费方测试固定生产集成都不会通过关联 `MessageId` 与 `turn/end` 来推导 follow-up 结果。

## 后果

自有活动区间可以包含进入 idle 前提交的 steering、注入上下文或其他工作，因此其最终响应、结束原因和事件有意比初始消息涵盖更广。底层 DSH SDK 结果仍不包含提示词级模型错误和 token 上限分类。ACP 会在区间完全停稳时把关联轮次投影成其必需的标准 error 或 `max_tokens` stop reason，但不增加 DSH 专用结果，也不声称排他因果关系。在同一会话上并发执行自动化操作时，必须采用显式串行或所有权策略，不能依赖隐式的逐 follow-up 结果。
