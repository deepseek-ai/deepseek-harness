# Agent Note: Workspace UI 完整产品动线

Status: implemented
Archived: 2026-09-04

[English](2026-07-25-workspace-ui-product-flow.md) | 中文

## Problem

[Domain KV storage 与 Workspace entity](../../proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)定义了 Workspace 的持久实体、路径规范和有序 Session 账本，但没有定义 Host 接线、历史数据初始化或 GUI 动线。GUI 同时呈现 Workspace 和 Session；用户进入 New Session 后必须能够立即输入，即使此时还没有 Host Session，甚至没有 Host Workspace。

待创建 Workspace、待创建 Session、输入保留与 Host 实体发布必须具有明确所有者，并在 RPC completion 与 Host frame 以任意顺序到达时保持同一页面身份。若零态提前创建 Host Session，则无输入的页面状态会进入 Host 生命周期。历史 Session 又只有轻量 `SessionHeader.cwd` 可用于归组，初始化不能读取事件正文。

## Decision

### Host 与持久数据

Host 在 Workspace entity 上提供以下 GUI 接线：

| RPC | 行为 |
| --- | --- |
| `workspace.list` | 返回持久有序的 Workspace，并过滤未通过 header 校验的 Session id |
| `workspace.create({ path })` | 按 canonical path 收编已有目录；由 basename 派生的显示名可以重复 |
| `workspace.insertBefore({ workspaceId, beforeWorkspaceId? })` | 在持久注册表顺序内移动一个 Workspace，并返回完整的已提交顺序 |
| `workspace.delete({ workspaceId })` | 移除 Workspace 注册记录，同时保留目录和会话日志；相关 Session 进入 Ungrouped |
| `session.create({ workspaceId, sessionId? })` | 从 Workspace 解析 cwd，以可选预分配 id 幂等创建 Session 并 attach |
| `session.create({ cwd })` | 保留给非 Workspace 调用方，创建 Ungrouped Session |

Host 流推送 Workspace 与 Session 增量，包括 `host/workspace-removed`；Client 重连后分别刷新 `workspace.list` 与 `session.list` 基线。删除注册记录的所有权与安全边界由 [Workspace 注册记录删除 Agent Note](2026-07-27-workspace-registration-deletion.zh.md)定义。

Workspace 的 `sessionIds` 是有序候选索引。成员投影同时要求 id 位于索引且对应 `SessionHeader.cwd` canonical 后等于 Workspace path；SessionHeader 不增加 `workspaceId`。cwd 匹配但未入索引的 Session 保持 Ungrouped，索引命中但 header 缺失、cwd 无效或 cwd 不匹配的 id 被过滤。同一 Session 被两个 Workspace 索引占用属于损坏状态并明确报错。

Workspace domain 以 durable marker 区分「从未初始化」和「已初始化但为空」。marker 未设置时，注册表只调用 `SessionPersistence.list()` 读取 header 元数据，既不调用 `load` 或 `inspect`，也不读取历史数据或解析事件正文；有效 cwd 按 canonical path 分组，组内 Session 与 Workspace 组均按 header `createdAt` 降序初始化。Bootstrap 可重入，最后才写 marker；marker 写入后，绕过 `workspaceId` 的新 Session 不再被自动收编。

### Client 对象模型

`Session` 与 `Workspace` 从页面 Intent 阶段开始就是前端对象。

- 前端 Session 创建时预分配 SessionId，并在对象内持有 Intent target 与 `pendingPrompt`；Host `session.create` 成功后仍是同一个 Session 对象。
- 前端 Workspace 在 materialize 前没有 WorkspaceId，并在对象内持有 create input、phase 与 error；Host `workspace.create` 成功后同一个 Workspace 对象 adopt 返回的 view。
- `SessionManager` 与 `WorkspaceManager` 负责对象索引、Host 基线和增量合并；对象是 Intent 与 Host view 的唯一状态源。
- `SessionRuntime` 提供 Session 对象、真实 selection、scope 与列表投影；`WorkspaceRuntime` 依赖 `SessionRuntime`，负责默认 Workspace、跨对象 New Session 动线和 Workspace materialize。

页面至多有一个前端 Session Intent 和一个仅在零 Workspace 状态下配套的 Workspace Intent。Intent 只存在于当前页面，刷新后消失；真实 Session selection 可以持久恢复。选择真实 Session 或启动另一个 Session Intent 会放弃旧 Intent 的自动发送资格，但已经由 Host 发布的 Session 和已经接受的消息不会回滚。

Session 自己持有首条输入并驱动一条内部流水线：必要时以预分配 id attach 到 Workspace，然后发送 `pendingPrompt`。attach 与 send 的失败都落回同一 Session。Workspace 创建 phase/error 只属于 Workspace 对象，Session 不模拟 Workspace 生命周期。

### 用户动线

应用首次进入时等待 Workspace 与 Session 两份基线 ready。仍有效的真实 Session selection 被恢复；否则进入 New Session，并固定选择一次最近 Workspace。最近 Workspace 取其成员 Session 的最大 `updatedAt`，空 Workspace 回退到 `createdAt`；该派生只决定默认目标，不改变 Host Workspace 顺序，也不会在后续 hydration 时二次改选。

完全没有 Workspace 时，页面创建默认名为 `workspace` 的前端 Workspace 对象和指向它的前端 Session。两者不写 Host，composer 始终可输入；首次发送才依次 materialize Workspace、attach Session、发送消息。

顶部 New Session、Workspace 行内加号和 Workspace picker 最终都调用同一 New Session 动作：显式 Workspace id 直接成为目标，未指定时先使用当前 Session 所属 Workspace，再使用最近 Workspace；没有真实 Workspace 时进入空白 New Session 页面。Workspace picker 的单一 Add workspace 动作（见[单一路径 Note](../simplification/2026-07-31-one-route-to-add-a-workspace.zh.md)；本决策做出时是 Use an existing folder 与按名称创建两个动作）会在用户确认目录时立即创建真实 Workspace，再将前端 Session 的目标改为该 Workspace；即使用户不发送消息，显式创建的空 Workspace 也保留。

新建 Workspace 的显示名取自其所在目录。不同 canonical path 可以拥有相同的 basename 派生显示名（见[身份决策](../bug-fix/2026-07-31-same-basename-workspace-adoption.zh.md)）；显式的重命名操作仍保留显示名重名检查。跨 Workspace 移动 Session、从 Ungrouped 手动收编以及分别输入显示名和目录名仍不在此动线范围内。

### 首次发送与恢复

前端 Session 的 `pendingPrompt` 在 Host 接受消息前始终保留原文。首次发送按 Workspace materialize、Session attach、提示词发送顺序推进：

1. Workspace 创建失败时，Workspace Intent 保留输入与错误，Session 仍指向该对象。
2. Session 创建在发布前失败时，Session Intent 回到可编辑状态，以同一预分配 SessionId 重试。
3. `workspace-attach-failed` 证明 Session 已发布；同一 Session 对象进入真实列表并保留提示词，后续重试 attach。
4. 提示词发送失败时，Session 保留提示词并只重试发送，不重复创建 Workspace 或 Session。
5. Session 创建期间若页面切换到另一个 Intent，旧 Session 即使随后发布也不自动发送；它保留原提示词和可见错误。

RPC 响应丢失、Host frame 先于 completion 和 completion 先于 Host frame 都通过预分配 SessionId 与对象身份收敛。Manager 对 Host view 做有序 upsert，本地 materialize 时优先保留原对象身份，不生成同 id 的临时第二行。

### Sidebar 与排序

Workspace 组使用 Host 返回的持久顺序。Bootstrap 一次性确定历史顺序，显式创建的新 Workspace 放在首位，`workspace.insertBefore` 则持久应用用户拖拽顺序；Session 活跃不会移动 Workspace 组。

Host 记账保持手动的 `Workspace.sessionIds` 顺序：新 attach 的 Session 放在首位，活动不会改动该顺序。分组浏览器可以改选浏览器本地的最近更新视图；当 Session 的 `updatedAt` 增大时该视图会把它移到首位，同时仍允许手动调整。每个打开的 Workspace 默认显示五条 Session，用户可临时展开其余条目。持久 Workspace 重排序和浏览器本地 Session 顺序见 [Workspace 侧边栏顺序与折叠](2026-08-11-workspace-sidebar-order-and-folding.zh.md)。

当前空白 Session 会显示为一条「New session」行，但不显示数量、时间标签或行菜单；其他空白 Session 保持隐藏，并可由对应 Workspace 复用。搜索会排除空白行。

无法归入任何 Workspace 的真实 Session 进入 Ungrouped。Host `session-added` 与 `workspace-changed` 可以任意顺序到达，列表合并不依赖 frame 顺序。

删除 Workspace 注册记录会移除其分组，但不会删除或关闭任何 Session。已记账的 Session（包括当前 Session）会立即进入 Ungrouped；刷新后，独立的 Workspace 与 Session 基线会重建出相同结果。

### React 与 slot 边界

React 组件只消费 `useSessions`、`useWorkspaces` 与 session-scoped 钩子，不拥有实体生命周期。Zustand store 只保留布局、当前 view、普通真实 Session 的 composer 文本和其他纯呈现状态；Session/Workspace Intent、materialize phase、错误和保留的提示词位于 React-free 运行时对象层。

Sidebar 与 conversation empty hero 通过 slot 获得标准化动作：`startSession`、`updateSessionPrompt`、`sendSession`、`open` 与 `toggleSidebar`。Workspace picker 复用同一组件与 `createWorkspace` 动作；owner 只提供 popover 开关、锚点和选中回调。呈现层不直接发送 `host/workspace-changed`，Host 事件只由 Host mutation 与流适配器产生。

## Alternatives considered

**为待创建 Workspace 与 Session 保存独立页面记录。** 该方案在 materialize 后需要替换身份并转交输入、错误、焦点和 sidebar 行；对象自身的 Intent 状态可以保持身份连续。

**由呈现层或 root Zustand store 编排对象生命周期。** 该方案会重复 Manager 与服务的职责，并把领域状态带回 React。标准化动作由运行时服务提供，slot 只注入呈现所需的窄接口。

**零态立即创建 Host Session 或 Host 持久化 Intent。** 未输入页面会进入 Host 生命周期，并改变刷新语义；前端 Session 在首次发送前只保留 page-local Intent。

**显式 Create Workspace 延迟到首次发送。** 用户确认后 sidebar 仍看不到真实空 Workspace，「创建 Workspace」与「准备 Session」语义混合；只有系统自动产生的零 Workspace Intent 延迟 materialize。

**持续按 cwd 动态派生 Workspace。** 该方案无法表达空 Workspace、稳定显示名和显式顺序，也会自动收编非 Workspace 调用方；cwd 只用于一次历史 bootstrap 与成员双向校验。

**Client 在 Session list 到达后按时间批量重排。** 首屏会先展示 Host 顺序再整体跳动，重连也可能改变位置；排序由 Host 持久账本拥有，Client 只合并单项更新。

**在 SessionHeader 增加 workspaceId。** 它会与 Workspace 索引形成两个持久归属字段并要求双写；header 保留 Session 自身 cwd 事实，Workspace 索引负责显式归属。

## Verification

- 完全无 Workspace 的零态不写 Host 且允许输入；显式 Create Workspace 立即创建并显示空 Workspace。
- 前端 Session 与 Workspace 在 materialize 前后保持对象身份，输入、错误、焦点和 sidebar 投影始终来自对象层。
- 首发按 Workspace、Session、提示词顺序推进，各成功阶段不回滚，输入在提示词被接受前不丢失，创建重试使用同一 SessionId。
- Workspace list 只读取 header 完成一次可重入 bootstrap；已初始化的空注册表重启不重复初始化，成员读取同时校验索引与 canonical cwd。
- 初始默认目标只在两份基线 ready 后确定一次；Workspace 组不因 hydration 或 Session 活跃重排，显式 Workspace 拖拽顺序在重连后仍然保持。
- 当前空白 Session 可显示为唯一的 New Session 行，同时不暴露其他可复用空白会话，也不显示 Session 数量。
- UI 与 Host 会将 canonical path 不同但 basename 相同的目录接纳为独立 Workspace，而显式的重命名操作会拒绝重复显示名；cwd-only Session、无效历史 cwd 和未 attach Session 保持 Ungrouped。
- 经确认的 Workspace 删除只移除注册记录，保留当前 Session、目录、文件和会话日志，并在刷新后保持该状态；包级测试固定一元响应／帧／基线竞态和失败回滚行为。
- keyless runnable 快照覆盖零态、显式创建和首次发送；包级测试覆盖 bootstrap、成员校验、排序、幂等、失败恢复及任意 frame 顺序。

## Consequences

- SessionHeader 不记录最后活跃时间，历史 bootstrap 只能按 `createdAt` 初始化 Host 手动顺序；浏览器可选的最近更新视图在 hydration 后从 Session 摘要开始建立。
- 历史 cwd 缺失、目录无效或 realpath 失败的 Session 留在 Ungrouped；本期没有手动收编入口。
- 页面刷新会丢弃未 materialize 的 Workspace/Session Intent 和尚未被 Host 接受的输入，这是 page-local 约定。
- 显式 Create Workspace 立即落盘，用户不发送就离开也会留下空 Workspace。
- Host Session 在首个事件前仍遵循现有懒持久化语义；前端 Intent 不改变 Host 重启后的空 Session 行为。
