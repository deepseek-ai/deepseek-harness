# Agent Note: Child Agent 消息先于其结算通知

Status: implemented

[English](2026-08-17-subagent-message-settlement-ordering.md) | 中文

## 问题

可继续 child 可以发送选中内容，之后还会产生一条由管理器编写且无条件投递的结算通知。如果这两条消息进入领取优先级不同的队列，较晚的结算通知可能先于较早的 child 消息到达 parent 模型。一个轮次的第一个 step 会先领取完整 `next-step` 批次，再领取一条 `next-turn` 消息，因此混用 FIFO 后续轮次发送与 next-step 结算会颠倒因果顺序。[Issue #2600](https://github.com/deepseek-harness/deepseek-harness/issues/2600)记录了该缺陷。

child 指令要求在发现会改变 parent 下一步动作时发送该发现。把这条消息推迟到后续轮次既违背其调度含义，也会把具有因果顺序的消息拆到领取优先级不同的队列。

## 决策

每条模型编写的相邻 Agent 消息都通过 `SubagentRuntime.sendMessage()` 使用固定 Steer 投递。运行中的 parent 在最近安全 step 边界读取 child 消息，空闲 parent 则启动一个轮次。模型没有静默或 next-turn 投递选项。

继续执行管理器会在投递到驻留可继续 parent 的消息周围保留 `sendWaking()`，并通过 parent 的私有 `SubagentInbox` 执行同步发送。包装层会在安装 closing promise 前接受发送，并在安装后拒绝发送；被接受的尝试会在返回前更新 Activation 的 wake generation。因此，接收方 Activation 不会越过一条已接受的唤醒发送完成结算。

### 不同 parent 状态下的顺序

运行中的 parent 在同一条 `next-step` FIFO 中接收已接受的 child 消息与该 child 随后的结算通知。如果 parent 在结算到达前变为空闲，它已经领取 child 消息；结算随后可以开启后续轮次，而不会颠倒观察顺序。

parent 处于 maintenance 时，child 消息占用 `next-step` 并锁存一次唤醒，而结算可能因 maintenance 报告空闲状态而占用 `next-turn`。初始领取仍会先取 next-step 输入，再取排队轮次。取消后提交的唤醒输入遵循核心 Agent 的取消收敛，而不会绕过它。

### 验证

控制工具测试套件让 parent 保持在活跃模型请求中，提交 child 消息、结算 child，并验证 sender 身份、Steer 准入、FIFO 批处理与结算后保留。继续执行覆盖固定驻留可继续 parent 的唤醒准入记账，并让 runtime 所有的结算来源与 `agent-message` 保持不同。

无密钥可继续 subagent 快照使用随附的固定投递。其 child 可见工具 schema 与 parent 相同，且已接受的 child 消息先于之后的结算通知，无需调度 overlay。

## 考虑过的替代方案

**提供静默投递。** 空闲 parent 停驻后可能永远不读取静默消息。它还会让等价的模型编写消息具有不同存活语义，并重新引入依赖部署的顺序。

**提供 next-turn 投递。** 较晚的 next-step 结算通知仍可能越过它。保持消息先于结算需要跨队列顺序屏障，而当前没有模型操作对后续轮次隔离的需求强到足以承担该机制。

**把结算通知移到 `next-turn`。** 结算批处理使用 next-step 队列，使多个 child 同时结束只消耗 parent 的一个 step，而不是每个 child 一个轮次。移动结算会为了保留不必要的消息调度模式而增加延迟与模型工作。

## 后果

- child 消息可以延长开放的 parent 轮次。它绝不会中断活跃模型请求或工具执行；agent loop 只在 step 边界接纳它。
- 一起被接受的消息共享一个 next-step 批次，保持 FIFO 顺序并限制轮次放大。
- 模型调用方不能选择投递模式，因此顺序与唤醒行为不会随部署或调用而变化。
- child 到 parent 的发送仍要求直接 parent 保持在线；服务不提供持久 parent mailbox。
