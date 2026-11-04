---
kind: upgrade-guide
description: "自定义 Client 组合必须提供 GUI 插件所需的右键菜单与文件动作服务。"
---

# 自定义 Client 组合中的右键菜单服务

[English](guide.md) | 中文

## 变更

GUI 插件现在注入 `contextMenus` 以打开共享对象菜单。open-in-app 插件还注入 `fileActions`、`sidebarRight`、`sidebarRightTabs` 和 `remote.workspaceFiles`。自定义组合若挂载这些 GUI 插件却没有新服务，将无法激活它们。随附 Web 应用 bundle（插件包）已包含提供方；现有 Session 和标签页菜单 Slot 名称仍可使用。

## 迁移

1. 在自定义组合所属的包清单中，添加与 Harness 版本一致的 `@deepseek-ai/dsh-client-ui-context-menu` 和 `@deepseek-ai/dsh-client-ui-file-actions` 依赖。
2. 在自定义 Client 组合中将两个包名添加为插件行，与已有 locale、slots、shortcuts、侧栏和工作区文件提供方并列。默认 `@deepseek-ai/dsh-web-app` bundle 已包含这些行。
3. 将 `ctx.menus` 改为 `ctx.contextMenus`，将 `MenuTargetMap` 改为 `ContextMenuTargetMap`，旧名均无兼容别名。挂载菜单插件，由其 `ctx.slots.provideRoot` 贡献向每个 Slot 提供 `useContextMenu`。组件调用一次 hook，将 `getTriggerProps(target, handlers?)` 展开到每个元素，包括循环生成的元素。处理器组合和外部动作注册见[菜单参考](../../../../packages/client/ui-context-menu/README.zh.md)。
4. 重新构建并启动自定义 profile（配置档）。确认 GUI 插件正常激活、右键后台 Session 不改变选择，且现有 Session/标签页 Slot 贡献仍然显示。
5. 自定义 Slot 宿主应移除对 `sidebar.workspaces.session.menu.item` 和 `sidebar.right.tab.menu.item` 的声明；现在由工作区和右侧栏适配器在 `contextMenu.content` 下拥有它们。会话行继续接收 `[open, setOpen]` hook context，标签行在所点击会话的 provider 内接收 `{ tab, dismiss }`。替换这些适配器的自定义宿主须自行声明相同的子 Slot 并提供这些 owner。使用 `getTabTriggerProps` 的 Dockkit 嵌入方负责弹窗和关闭，`renderTabMenuItems` 仅供组件自身的弹窗使用。通过响应式 `tabMenuOpen` 在自定义菜单准备或显示时禁用关闭按钮的 Tooltip。

6. 内置 Session 菜单项改为数据贡献。旧 React Slot 将外部条目集中显示在归档之前，Slot priority 不再覆盖内置动作。新增动作用 `ctx.contextMenus.register`，可通过 `commandId` 展示已有命令的当前绑定。针对捕获目标的执行仍放在 `run`，不增加命令调度。
7. 菜单贡献使用 `icon?: ReactNode`：将 `symbol` 改为图标元素，并用 `<img>` 包装图标 URL。在每个实际 Slot 入口获取 `useContextMenu`。普通子组件接收 `getTriggerProps` 或绑定后的 `contextMenuProps`；ToolRow 使用 `fileContextMenuProps` 和 `urlContextMenuProps`。删除 Chat 消息流和节点 owner 的菜单字段。助手入口向 `forClosing()` 传入普通文件适配函数，Markdown 则在 `MarkdownDelegateProvider.getTriggerProps` 处适配目标类型。业务注册保留 Session 归属和触发时路径解析。删除 `contextMenuTrigger` 和 `menuPoint` 导入，其独立工具包已删除。不要向 ui-primitives 增加手势导出。
