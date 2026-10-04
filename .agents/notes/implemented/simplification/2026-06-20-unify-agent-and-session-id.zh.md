# Agent Note: 统一 agent id 与会话 id

Status: implemented

[English](2026-06-20-unify-agent-and-session-id.md) | 中文

## 问题

一个存活的 agent（智能体）/会话对需要使用同一 identity 完成注册表路由、事件溯源和持久化。让 factory 接受相互独立的 `agentId` 和 `sessionId` 输入，会允许任何生产路径都无法使用的配对，同时迫使每个消费方为同一生命周期在两个名称之间选择或转换。

ACP（Agent Client Protocol）对两种 identity 使用相同值。Stdio 和钩子也在会话事件流上工作，并且直接需要对应的存活 agent；没有生产路径会把一个存活 agent 对象重新附着到多个会话，或通过多个 agent id 驱动一个会话。

[agent 范围运行时](../../../../packages/core/agent-loop/README.zh.md)使用同一个 `AgentCreationTransaction` 执行创建和恢复，agent/会话条目共享相同的最终条目冲突规则。第二个 identity 并不代表单独的存活性、回滚或完全停稳；它只会围绕同一事务增加 API 与转换状态。

会话 identity 同样只有一个归属，即 `Session.header.id`；`Session.id` 是派生访问器，而非需要重复验证的独立状态。

## 决策

agent 的注册表 id 等于其会话 id。`CreateAgentOptions` 接受一个 `sessionId`，同时用于两个最终注册表条目；恢复时以 `resumeSessionId` 注册 agent；进程内 subagent 创建使用子会话 id；`Session.id` 则派生自 `header.id`。远程 ACP 运行没有本地 agent/会话对：它保留一个由父项铸造的生命周期 id，而子服务器协议本地的会话 id 仍仅供 ACP 调用内部使用。现有创建事务、最终条目冲突检查和精确条目分离语义保持不变；唯一职责是在本地 id 之间转换的 map 与字段已经消失。

配置驱动路径保留 `agents[].id` 作为稳定配置标签，而非存活态路由 identity。普通的全新启动会铸造组合 id `${label}-session-${randomUUID()}`，使持久重启不会冲突。耦合应用可以预先铸造并传入精确的 `sessionId`：首次使用时创建它，而当持久化服务已经存在时，AgentLoop 重新挂载会在同一 identity 下恢复已物化历史。`resumeSessionId` 则要求已有的持久化 identity。两个精确 id 输入互斥。Stdio 使用「恢复或创建」形式，使配置创建的 agent 和 UI 在循环重载之间共享一个不透明 identity，而不是根据前缀猜测。日志可以使用稳定标签，而所有存活态与持久化查找都使用同一个 `SessionId`。

`agent/created` 和 `agent/disposed` 保留。它们是成对的发布生命周期事件，而非 identity 别名；以后若发现没有消费方并要移除，必须先重新搜索，再提出独立提案。

## 曾考虑的替代方案

**保持路由与日志 identity 分离。** 稳定的配置标签加全新的持久对话确实有用，但不需要两个存活 identity：标签可以继续作为配置/显示元数据，而每次运行的组合 `SessionId` 负责路由和持久化。保留两个 id 会让转换 map 持续存在，允许不可能的配对，却不会增加生命周期能力。

## 验证

- agent 创建/恢复和 subagent 创建只携带一个 identity，`Session` 也只在一个位置存储它。
- 创建事务继续覆盖最终条目冲突、精确条目分离、回滚和完全停稳，无需 identity 特有的生命周期状态。
- ACP、stdio、钩子、bash 归属、持久化和 lineage 直接使用共享 `SessionId`。ACP subagent 后端在父命名空间中铸造其生命周期 id，因为子服务器返回的会话 id 仅在服务器本地有效；ACP bridge 根据正向会话 map 验证精确的 `Agent` 归属；JSON-RPC 只转发生命周期事件中由服务快照保存的 `local` 标记为 true 的事件，从带范围的事件 carrier 取得委托父项，并且不保留子 identity 或 lineage cache。
- 配置驱动的恢复或创建策略是显式的，并在持久化重启场景下得到覆盖。
- 生产监听器搜索确认保留 `agent/created`/`agent/disposed` 及其发布语义。

## 后果

这排除了潜在的多会话 actor 和会话交接设计，并使由客户端选择、已持久化的会话 identity 成为注册表 identity。如果独立路由 identity 成为真实需求，就需要显式的生命周期设计，而不是由调用方提供一对不受约束的值。
