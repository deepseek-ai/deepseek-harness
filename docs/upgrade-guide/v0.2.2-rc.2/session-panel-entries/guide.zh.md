---
kind: upgrade-guide
description: "后台任务、子智能体与 forge 变更请求从会话标题栏和右侧边栏移入会话面板，子智能体页脚 slot 随之移除，forge 标签页类型退役。"
---

# 会话标题栏入口移入会话面板

[English](guide.md) | 中文

## 变更

Web 与 Desktop 的会话标题栏此前显示后台任务按钮、子智能体按钮（其菜单末尾是 `conversation.session.header.actions.subagent.footer` slot），以及启用 forge 套件时打开 `forge-panel` 右侧边栏标签页的变更请求按钮。这些入口现在位于由标题栏开关打开的[会话面板](../../../../packages/client/ui-session-panel/README.zh.md)中：

- [`dsh-client-ui-jobs`](../../../../packages/client/ui-jobs/README.zh.md) 与 [`dsh-client-ui-subagent`](../../../../packages/client/ui-subagent/README.zh.md) 注册“后台任务”与“子智能体”分栏；子智能体页脚 slot 已移除，原来填充它的共享任务板现在是独立的“共享任务”分栏。
- [`dsh-experimental-client-ui-forge`](../../../../packages/experimental/client-ui-forge/README.zh.md) 注册“变更请求”分栏、“环境”分栏中的检出行与本地变更行，以及开关上的提醒标记。它不再注册 `forge-panel` 标签页类型及其标题，也不再注册 `conversation.session.header.utilities` 条目；变更视图仍使用 `forge-changes` 标签页类型。
- forge 变更视图扩展 API 中，`ctx.forgeChanges.kinds` 只保留 `changes`，因为 `panel` 指的是已退役的标签页类型；`forge.change-request.card.actions` slot 的 owner props 不变，改为渲染在“变更请求”分栏每张卡片的操作菜单之前。
- 类型导出随组件改名：`JobsSection*` 取代 `JobListAction*`/`JobListInjected`，`SubagentsSection*` 取代 `SubagentCatalogAction*`，forge 的 `ChangeRequestsSection*`、`ChangeRequestsActions*`、`CheckoutRow*`、`LocalChangesRow*` 与 `AttentionIndicator*` 类型取代 `ForgeTab*`、`HeaderButton*` 与 `LocalChangesCardProps`。

注册到旧页脚 slot、打开 `forge-panel` 标签页类型、读取 `ctx.forgeChanges.kinds.panel` 或导入已移除类型的 Client 插件与运行时扩展会受影响。恢复右侧边栏时，`forge-panel` 标签页不再显示。Session 数据与配置键不变。

## 迁移

1. 在 Client 插件与运行时扩展中，把对 `conversation.session.header.actions.subagent.footer` 的注册改为带自己的 `id`、`order` 和 `label` 的 `conversation.session.panel.section` 注册，并移除旧 slot 的子 slot 声明。
2. 把 `ctx.sidebarRight.openTab('forge-panel')` 之类的调用与对 `ctx.forgeChanges.kinds.panel` 的读取改为提示用户打开会话面板；如需在变更请求旁放置内容，按[会话面板 README](../../../../packages/client/ui-session-panel/README.zh.md) 的说明注册 `conversation.session.panel.section` 条目。
3. 按“变更”中列出的名称更新类型导入。
4. 运行 `pnpm run typecheck`，然后在 Web 中打开一个 Session，点击标题栏中的会话面板开关，在其独立分栏中找到这些内容，即确认迁移完成。
