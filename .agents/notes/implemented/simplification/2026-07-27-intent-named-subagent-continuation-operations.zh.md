# Agent Note: 按意图命名的 subagent 继续执行操作

Status: implemented

[English](2026-07-27-intent-named-subagent-continuation-operations.md) | 中文

提供方请求与会话 flush 决策仍然有效。[相邻 Agent 共享一个 Steer 消息操作](../architecture/2026-08-27-adjacent-agent-steer-messaging.zh.md)取代了本记录的 `followup` 命名与 options：公开操作现在是可用于任一相邻方向的 `sendMessage(sender, targetId, content, { signal })`。

## 问题

将可继续 child 的编排合并到 `ctx.subagents` 后，提供方分发与调用方意图共存于同一个公开服务中。`resume(name, request)` 接受描述符、已鉴权的 parent、持久化 child id 与激活信号，而只有内部继续执行管理器才能正确解析这些数据。方向专属的 `followup` 与 `reportFrom` 操作还会为一项相邻 Agent 能力编码不同的路由与调度。

持久性边界还同时公开了 `SessionStore.flush()` 与 `flushRequired()`。二者执行相同的作用域内并行分发，唯一差别是是否接受空的监听器快照，因此会话接口将一个消费方的策略编码为第二项操作。

## 决策

`SubagentRuntime` 分离三种调用方意图：`start(name, request)` 返回普通的、由持有方负责的 one-shot run；`startContinuable(spec)` 建立持久化 child，并返回其 id 与已接受的初始 `MessageId`；`sendMessage(sender, targetId, content, { signal })` 则跨一条直接 parent-child 边发送由模型编写的内容。消息操作从确切在线 sender 推导来源信息，并负责相邻关系检查、冷恢复与固定 Steer 调度。唯一面向模型的 `send_message({ agent_id, message })` 工具会在两个方向委托给该操作。

调用方请求与提供方请求相互分离。`SubagentStartRequest` 包含调用方提供的 one-shot 数据；`ResolvedSubagentStartRequest` 会在调用 `SubagentProvider.start()` 前加入由服务解析的描述符。创建可继续 child 时，管理器将 `ContinuableCreateRequest` 传给可选的 `SubagentProvider.prepareContinuable()`，且只接收分离的创建数据。`SubagentRuntime.resume()` 与提供方恢复分发均不存在：继续执行管理器加载描述符、对 parent 进行鉴权，并负责 Agent 实体化、提示词投递、冷恢复与 teardown。

`SessionStore.flush(session)` 是唯一的持久性屏障，并返回 `Promise<boolean>`。至少一个作用域内监听器成功参与后，它解析为 `true`；监听器快照为空时解析为 `false`；所有监听器结算后，如有失败，则以注册顺序最靠前的监听器错误拒绝。参与结果无法表明所选的持久化后端是否已经存储状态。普通检查点可以忽略该布尔值；继续执行管理器同样将最终 flush 视为 best-effort 屏障，有意忽略参与结果，记录拒绝日志，并仍会对 child 执行 dispose（资源释放）并释放所有权。

## 已考虑的替代方案

**保留公开的提供方恢复分发。** 继续执行管理器之外，没有任何生产调用方同时负责安全调用所需的描述符查找、直接 parent 鉴权、Agent 实体化、Activation 所有权与 child-first teardown。公开方法会暴露已解析的实现数据，却没有合理的独立调用意图；提供方改为通过 `prepareContinuable` 贡献分离的首次创建数据，且从不参与冷恢复。

**保留方向专属的 `followup` 与 `reportFrom` 操作。** 这样可以保留 child 无需填写接收方的短调用，但会重复权限、来源信息与投递行为，并让服务词汇取决于方向。一个 `sendMessage` 操作可以命名共享意图，并让目标保持显式。

**保留 `flushRequired()`。** 第二个方法只封装了空监听器检查。由现有屏障返回是否有监听器参与，可以让分发只保留一套实现，并让每个调用方自行判定缺少监听器是否可接受。

**合并普通启动与可继续启动。** 一个标志会让同一方法要么等待由持有方负责的 one-shot run 就绪后返回，要么立即返回持久化 child 与消息标识。按意图拆分的方法无需返回值联合类型即可保留所有权与时序差异。

## 影响

- Cordis 服务目录只包含调用方操作；提供方可以通过 `SubagentProvider.prepareContinuable?()` 选择参与可继续 child 的首次创建，但不会获得 Agent 生命周期权限或公开恢复操作。
- sender 权限来自确切在线 `Agent`；取消信号通过一个选项对象传递，并且只负责 inbox 接受前的工作。
- 会话持久性只有一个屏障操作。参与结果仍可观测，但任何可继续 child 路径都不会将任意监听器参与视为持久化后端已存储状态的证明。
- 单一 `send_message` schema、已接受的消息标识、`AgentHandle` 所有权、持久化事件词汇与模型可见的 transcript（文本记录）遵循上文链接的基于 Activation 的实现。
