# Agent Note: 会话归档（注册表级全局集合）

Status: implemented
Archived: 2026-09-04

[English](2026-07-31-session-archive-global-set.md) | 中文

## 问题

Sidebar workspace 浏览区的会话行菜单里，「Delete session」一直是纯视觉占位（无 handler）。产品口径定为**归档**而非删除：会话日志与 workspace 记账都不动，只把该会话从所有分组视图（workspace 分组、Ungrouped、搜索、平铺列表）里隐藏。归档记录需要一个落点：Ungrouped 的会话不属于任何 workspace 实体，per-workspace 字段放不下它。

## 决策

**归档集合是 workspace domain 全局单例（`workspaceDomainState.archivedSessionIds`）上的一个新字段，覆盖在 workspace 记账之上；显示过滤全部收敛在 client 的 `tree.ts` 派生层；wire 面走全快照姿态。**

- 存储：`archivedSessionIds: z.array(sessionId).default([])`，domain version 保持 2——纯新增字段，旧介质经 schema default 解析为空集合，无迁移代码。被归档的会话保留其 `sessionIds` slot（未来取消归档恢复原位置），因此与「一个会话只被一个 workspace 记账」不变式零纠缠。
- 注册表：`ctx.workspaceRegistry.archiveSession(id)` 走 `enqueueOperation` 与 create/delete 串行；未知会话（实时与持久化都查不到）抛 `WorkspaceUnknownSessionError`；已归档 id 不写盘不发事件。`archivedSessionIds` getter 暴露只读集合。
- RPC：`workspace.archiveSession({sessionId}) → {archivedSessionIds}`（应答更新后的完整集合）；`workspace.list` 响应携带集合作为重连基线；新 host 帧 `host/archived-sessions-changed` 在每次持久变更后推完整快照（与 `host/workspace-changed` 同姿态，从 `domain/changed` 的 global put 分支比对推帧）。未知会话复用错误码 `session-not-found`。
- client 运行时：`WorkspaceListState.archivedSessionIds`（按 Host 顺序的 `readonly SessionId[]`，成员不变不换引用——公有快照状态保持 store 引擎的纯数据词汇：immer draft 不开 MapSet 插件就不接受 Set；membership 查询在派生函数内自建临时 Set，与 expandedProjects 同款）；list 基线、unary 回声、changed 帧三路都会用完整集合整体替换现有值。投影层在当前 selection 落入归档集合时统一清空回 New Session 视图（用户拍板：归档当前打开的会话会使主视图回到 hero）——一条规则同时覆盖本地 unary 回声、其他标签页的 changed 帧、以及重连基线发现当前 selection 已在此 client 离线期间被归档的情形；帧/回声落在 in-flight `workspace.list` 期间时还会屏蔽旧基线对新集合的回滚。
- UI：菜单项 `delete`（visual-only）改为 `archive`（label「Archive session」，非 danger 样式，无确认对话框——非破坏性操作，误触后果只是列表隐藏）；过滤实现为 `tree.ts` 的 `sessionVisible` 判据加一档，`deriveGroups`/`deriveFlat` 增加 `archived` 集合入参，四个视图（分组循环、stray 兜底、搜索、平铺）同源生效。

## 已考虑的替代方案

**per-workspace archivedSessionIds（最初表述）。** 否决：Ungrouped 会话无落点；用户改口全局。

**SessionSummary 打 archived 标（session.list 层）。** 否决：要把 workspace domain 事实 join 进 sessions domain 投影，summary 无增量帧还得另发通知，跨域耦合大于收益。

**host 侧在 `workspaceView`/`sessionIds` getter 过滤。** 否决：归档 ≠ 改记账，投影过滤会把两个概念搅浑；未来恢复入口也需要 client 拿到全量记账。

**增量帧（archived/removed 单条）。** 否决：集合极小、变更频率低，全快照免去 client 侧合并逻辑与去重状态，与 workspace-changed 现有姿态一致。

## 后果

归档后 UI 无查看/取消归档入口（本期口径，记录在 README 的 Known Limitation 中）；数据与 slot 完好，后续加恢复面只是 UI + 一个逆向 RPC。`workspace.list` 响应形状变化是 pre-release 直改（无兼容层）。e2e（workspace-management）钉住了「归档→行消失→reload 后仍隐藏、日志仍在」的全链路；domain 层测试钉住幂等、未知 id 拒绝、跨重启恢复与旧介质默认升级。
