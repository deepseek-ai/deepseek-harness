---
kind: upgrade-guide
description: "Client 插件须使用带前缀的右键菜单类型和 hook，并注册 keyed 图标组件。"
---

# 右键菜单类型和图标

[English](guide.md) | 中文

## 变更

`@deepseek-ai/dsh-client-ui-context-menu/client` 导出的 `MenuTarget` 更名为 `ContextMenuTarget`，与 `ContextMenuTargetMap` 保持一致。旧名不保留兼容别名，目标字段和运行时行为不变。工作区与侧栏注入的 `menuTarget` / `useMenuTarget` 改为 `contextMenuTarget` / `useContextMenuTarget`。操作图标改用 `{ key, src? }`，通过 keyed Slot `contextMenu.icon` 渲染，不再接收 React 节点。

## 迁移

1. 将 `MenuTarget` 导入及类型引用替换为 `ContextMenuTarget`。
2. 将注入源 `menuTarget` 和消费者 `useMenuTarget` 分别改为 `contextMenuTarget`、`useContextMenuTarget`。
3. 将操作图标元素替换为 `{ key: 'my-plugin.action' }`，需要时通过 `src` 携带已捕获的图片 URL。通过 `ctx.slots.inject('contextMenu.icon', ...)` 和 `ctx.slots.register()` 在该 key 下注册图标组件，参见[菜单包](../../../../packages/client/ui-context-menu/README.zh.md#use-this-package)。
4. 重新构建自定义 Client 插件，确认类型检查通过，并打开菜单验证图标渲染和插件卸载后的清理。
