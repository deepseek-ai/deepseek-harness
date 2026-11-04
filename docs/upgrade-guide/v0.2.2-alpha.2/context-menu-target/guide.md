---
kind: upgrade-guide
description: "Client plugins must use the prefixed context menu types and hooks and register keyed icon components."
---

# Context menu types and icons

English | [中文](guide.zh.md)

## Change

The `@deepseek-ai/dsh-client-ui-context-menu/client` export `MenuTarget` is renamed to `ContextMenuTarget`, matching `ContextMenuTargetMap`. The old name has no compatibility alias. Target fields and runtime behavior are unchanged. Workspace and sidebar injections rename `menuTarget` / `useMenuTarget` to `contextMenuTarget` / `useContextMenuTarget`. Action icons accept `{ key, src? }` instead of React nodes and render through the keyed `contextMenu.icon` Slot.

## Migration

1. Replace `MenuTarget` imports and type references with `ContextMenuTarget`.
2. Rename injected `menuTarget` sources and `useMenuTarget` consumers to `contextMenuTarget` and `useContextMenuTarget`.
3. Replace action icon elements with `{ key: 'my-plugin.action' }`; carry a captured image URL in `src` when needed. Register the icon component under that key through `ctx.slots.inject('contextMenu.icon', ...)` and `ctx.slots.register()`. See the [menu package](../../../../packages/client/ui-context-menu/README.md#use-this-package).
4. Rebuild custom Client plugins, confirm that type checks pass, and open their menus to verify icon rendering and plugin-unload cleanup.
