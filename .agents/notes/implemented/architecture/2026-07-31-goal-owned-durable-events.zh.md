# Agent Note: Goal 自有的持久事件

Status: implemented

[English](2026-07-31-goal-owned-durable-events.md) | 中文

## 问题

Goal 状态与 inbox 状态具有不同的生命周期。无论相关模型上下文是否获准进入步骤，goal 变更都必须在重启与 fork 后保留；inbox 消息则可能在步骤调度期间被编辑、领取、拒绝或丢弃。把 goal 变更编码到 Round 为 0 的 inbox 消息中，会让队列放置成为领域提交点，并迫使回放对账插入、准入、消息标识、来源元数据与渲染内容。

Goal 领域需要持久状态，但不需要拥有待处理的模型输入。继续执行调度仍然需要 inbox；goal 持久化不需要。

## 决策

`@deepseek-ai/dsh-goal` 拥有持久的 `goal/change` 会话事件。每个事件携带变更后的完整 goal 快照，或带修订号的清除墓碑。`GoalService` 同步追加该事件，再发出 `goal/changed`；严格回放与 `goal` 会话投影只折叠 `goal/change` 来获得生命周期状态。

`GoalMessageSource` 只标识已准入且为正数的继续执行 Round。匹配的 `user/message` 会推进 `roundsStarted`；普通用户消息与 inbox splice 事件不会改变 goal 状态。Goal 包不会插入、领取、移除或检查 inbox 消息。`@deepseek-ai/dsh-goal-round-driver` 仍通过公开 inbox 生命周期负责排队和跟踪自己的继续执行提示词。

激活态仍只存在于进程中。服务在缓存观察事件时，将同步追加的事件序号与所请求的激活状态关联；回放或外部追加的变更默认处于 disarmed 状态。会话日志仍是唯一的持久权威。

该领域不会自动把每次变更投影为模型输入。Goal 工具返回当前状态；真正调度工作时，继续执行提示词包含目标描述与 Round 状态。未来如果需要始终可见的 goal 上下文，应由独立上下文插件拥有其 inbox 消息，而不是把它作为持久化副作用。

## 考虑过的替代方案

- **继续以 Round 为 0 的 goal 消息作为持久记录。** 不予采纳，因为这会把领域提交与队列变更绑定，并要求 goal 折叠理解领取和准入对账，尽管队列结果不能回滚领域状态。
- **只从模型可见消息派生 goal 状态。** 不予采纳，因为变更可以在不打开步骤的情况下有效且持久，取消或策略拒绝也不能擦除它。
- **把 goal 存入独立数据库。** 不予采纳，因为有序会话日志已经提供持久化、回放与 fork 继承，无需引入第二个原子性边界。

## 后果

Goal 状态不依赖 inbox 放置与准入。回放只有一条变更路径，投影直接由 `goal/change` 推进，继续执行消息只携带 Round 归属。模型不会收到仅用于变更的 `<goal_state>` 消息；模型可见状态来自 goal 工具与已调度的继续执行提示词。直接写入会话的写入方仍受信任，并且可以追加畸形变更；严格折叠与 invariant 配套模块会拒绝这些变更。

聚焦的 goal、goal-round-driver、command、TUI 与 Client RemoteMock 测试固定持久回放、正数 Round 计数、inbox 独立性、投影更新和恢复会话行为。无密钥进程测试检查持久的 `goal/change` 事件，并验证仅创建 goal 不会启动继续执行 Round。
