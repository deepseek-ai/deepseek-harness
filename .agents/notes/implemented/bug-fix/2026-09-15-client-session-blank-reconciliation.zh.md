# Agent Note: 在列表刷新后保留已受理会话的展示状态

Status: implemented

[English](2026-09-15-client-session-blank-reconciliation.md) | 中文

## 问题

提示词请求成功后，客户端会把 `New Session` 行转换为普通会话，但此时轮次不一定已经开始。后续 `session.list` 响应仍可能返回 `blank: true`，从而撤销该转换。重连会触发同样的刷新。若只在 Session 对象内保留转换状态，对象被替换时也会丢失。

## 决策

[Manager](../../../../packages/api/session-controller/src/client/sessions/manager.ts) 使用按 Session id 索引的私有集合，保留已观察到的受理/运行。列表行与既有 Session blank 更新使用 `summary.blank && !engagedSessions.has(sessionId)`，其上仍叠加 `sessionListMetadata` 提示。既有摘要变更、Session 快照字段、构造函数和投影存储保留原有职责。

每个成功的提示词响应都会调用既有 `onEngaged` 回调，包括来自已被替换的 Session 对象的响应。Manager 按 id 更新其保留的观察、列表行和当前驻留 Session。拒绝不会记录受理/运行。`running: true` 状态、添加事件或列表基线也会记录运行；早于移除的基线不能恢复该观察，即使该行在拉取期间重新加入。

该观察跨刷新、重连和对象替换保留。移除、drop 和成功的列表刷新仅在列表行、Session 对象及子会话地址均不再保留该身份时清除它。刷新在重放请求期间的变更后判断保留资格；失败及被替代的请求不会清理观察。迟到的受理不能重建已移除的行或 Session 对象。Manager 销毁会清空集合，并阻止迟到的受理和未完成的列表响应发布。

受理/运行是展示记忆，不证明轮次已经开始、工作仍在排队，或消息已经写入持久存储。它不会跨页面重载持久化。历史 `sessionListMetadata.blank` 与 Host 摘要默认值保持不变。

## 考虑过的替代方案

**保留所有曾为 false 的摘要位。** 先前的 Host 摘要不能证明客户端观察过受理或运行。将所有 false 永久保留，也会在两种观察均不存在时阻止后续 Host 校正。

**引入共享 Session 记录。** 将这份记忆与投影存储合并，需要修改构造参数及缓存生命周期。这些改动独立于防止 blank 回退，因此不纳入。

**等待历史后再转换行。** 这会改变现有的受理时展示规则，属于独立的 UI 决策。

## 后果

已受理或观察过运行的 Session 保持既有展示转换，包括已受理输入始终没有开始轮次的情况。草稿、发送错误恢复、侧边栏筛选与标题规则、创建/复用、UUID、Host 协议、持久化及投影缓存生命周期保持不变。回退这项纯客户端修复不需要数据迁移。

Manager 额外维护一个按 id 保存的展示标记。它不替代 Session 本地展示字段，也不实施历史/草稿/展示状态重构。

对于来源不是 subagent、也没有保留子会话地址的身份，移除通知会丢弃它的投影存储——除非该存储已带有非空的 `subagentCatalog`；而仍被保留的 Session 对象继续持有构造时采用的存储，例如当前行被移除而它的 Session 仍留在舞台上。若投影存储已被丢弃，且该身份在其 Session 对象被销毁前回到列表，Manager 会新建并写入第二个存储，而常驻对象从不读取它，因此在替换实例采用当前存储之前，列表行与该对象的投影读取方可能不一致。该投影归属的修复延期到独立的改动；blank 展示不依赖它。

## 验证

Manager 测试覆盖无轮次刷新、运行转空闲、对象替换、迟到受理、通过通知或列表对账移除、保留实例与子会话地址、失败及被替代的请求，以及销毁。在存在实例的场景中，测试同时检查列表和 Session 状态。Session 测试保留首发拒绝及后续发送行为。浏览器验证使用已有首轮录制场景，在受理后、`turn/start` 前暂停并进行同页重连。测试仅替换重连列表响应中的时间戳，用其显示结果作为同步标记；Host 的 blank/running 值及持久日志保持不变。

## 相关决策

[作用域与供给决策](../architecture/2026-07-25-web-client-session-scope-and-provide-channel.zh.md) 拥有 Session 作用域、创建/复用及可见 blank 行。[Session/Conversation 归属决策](../architecture/2026-08-20-client-session-conversation-ownership.zh.md) 拥有传输、装配及快照内容。
