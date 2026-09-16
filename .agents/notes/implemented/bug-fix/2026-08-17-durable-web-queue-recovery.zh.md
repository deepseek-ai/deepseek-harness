# Agent Note: 从持久 Inbox 状态恢复 Web Queue

Status: implemented

[English](2026-08-17-durable-web-queue-recovery.md) | 中文

## 问题

Inbox 接受消息时会记录规范化的 `agent/inbox/spliced` 事件，但 Web Queue 使用另一份通过枚举 live Agent 构建的 mux 基线。Host 进程重启后，持久化的普通 Session 会保持冷状态，直到某项操作需要其 Agent，因此 live-only 基线会遗漏仍存在于持久日志中的已接受待处理消息。

只修复重连逻辑仍会保留两套恢复实现：一套用于 live Inbox，另一套用于 Web 冷读取。正确的所有者是 Inbox 领域，而会话投影框架已经提供 live 驱动、冷折叠、重连基线和缓存恢复。

## 决策

组合了 Session projection registry 时，`AgentLoop` 在服务激活时注册标准 `inbox` 投影，使冷 Session 无需 live Agent 即可读取。[Inbox 认领生命周期](../architecture/2026-07-31-claimed-pre-step-inbox-lifecycle.zh.md) 定义 splice 规范化、消息唯一性、live 通知和持久重建。投影共用一份 schema 与 `InboxState` 定义；消息值依赖既有的类型化 `UserMessage` 约定，而不增加第二套运行时消息校验器。

注册表在 `Session.append()` 返回前折叠已提交的 splice；每个 Agent 的 `ReactLoopInbox` 命令 facade 都读取同一份 live 状态，而不另行维护折叠状态。

通用会话投影传输层是唯一 Web 传输。它发送 seq 更高的 `session/projection` 值，在每次 `session.follow` 的起始快照中包含完整 values 块，折叠已分离的冷日志，并在缓存有效时使用投影缓存。系统不存在 Host 拥有的 `queue` 投影、placement 词汇、handoff 列表、专用 queue 帧或枚举 live Agent 的重连逻辑。

对已就绪 Host generation 的同步订阅会先丢弃所有保留的投影值及其水位，再刷新查询并重新打开 control stream，其中也包括进程本地 control baseline 中没有列出的冷 Session。首次 control stream 会等待 generation 就绪；baseline 不会先于旧状态清理到达，再被较晚的 Cordis `connection/reset` 通知清除。Observable face 保留自身标识及订阅。较早 generation 的 list 请求不能发布值或使当前请求结束，因此新 generation 的历史与 list 值可以建立较低的持久 seq，而不会被尚未持久化的状态挡住。同一 generation 内，所有收到的 baseline 都遵循较高 seq 优先，因此延迟到达的 control baseline 不能删除或覆盖较新的 list 或 history 值。

客户端 Session binding 在通用逐会话投影存储中保留 `inbox`，不会把它复制进 `SessionSnapshot`。QueueDock 直接读取 `next-turn`。ChatView 直接读取用户来源的 `next-step` 消息，并忽略注入上下文。认领操作通过持久 splice 移除待处理值；后续 `user/message` 由普通会话投影渲染。

`session.updateQueue` 在修改 Inbox 前通过共享 Agent 解析器解析普通冷 Session。因此，恢复出的待处理行在重启后仍可编辑、移除或 steering，而 subagent ownership 保持与其他 Agent 操作相同的 fence。

系统没有引入新的会话事件或磁盘格式。既有 splice 流仍是持久真源。

## 验证

Host 投影覆盖会读取包含待处理输入的已分离持久 Session，在 `session.follow` 的起始快照中返回 `values.inbox`，并证明不需要 live Agent。冷操作覆盖证明 `session.updateQueue` 会恢复 Session 并追加持久删除 splice。

客户端覆盖固定通用 Inbox 投影投递、重连时清理遗漏冷 Session 的旧值、基线的两种到达顺序、过期 list 请求的结果、Session 实例化前保留 seq 更高的值，以及 `SessionSnapshot` 不含 queue 状态。UI 覆盖固定 QueueDock 直接渲染 `next-turn`，以及 ChatView 渲染用户来源的 `next-step`。无密钥 Web fixture 会打开一份冷持久 Session，并在重启后观察其待处理行。

## 考虑过的替代方案

**把冷 Session 加入旧 queue 重连循环。** 不予采纳，因为这会重复投影注册表的冷折叠，并让实时推送、历史、缓存和重连继续使用不同实现。

**在 Session Controller 注册 Web 专属 `queue` 投影。** 不予采纳，因为待处理输入属于 Inbox。placement 行与 handoff 列表会只为一个客户端引入第二套领域模型。

**在每条 splice 事件中保存完整 Inbox 快照。** 不予采纳，因为持久事件是规范化变更，不是重复聚合。聚合重建与 checkpoint 属于投影框架。

**在客户端根据原始会话事件重建 Inbox。** 不予采纳，因为分页可能省略建立当前状态的插入事件，每个客户端也会重复实现 splice 语义。

**打开 mux 流时恢复每个冷 Agent。** 不予采纳，因为展示持久状态不应发布运行时资源、挂载 preset 或启动生命周期工作。

## 后果

待处理 Queue 与 steering 输入可在 Host 进程重启后恢复，而无需恢复 Agent。live Inbox 读取、冷历史、重连与投影缓存使用同一份领域拥有的折叠与注册表状态。操作恢复出的行时会恢复其普通 Agent，从而保留 preset 组合与所有权检查。

客户端接收原始的两列表 Inbox 值，并自行决定界面呈现哪些消息。投影的状态版本会在其序列化状态或折叠语义变化时使缓存行失效。
