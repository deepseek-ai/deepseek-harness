---
kind: upgrade-guide
description: "Custom Client compositions must provide the context-menu and file-action services required by GUI plugins."
---

# Context menu services in custom Client compositions

English | [中文](guide.zh.md)

## Change

GUI plugins now inject `contextMenus` to open shared object menus. The open-in-app plugin also injects `fileActions`, `sidebarRight`, `sidebarRightTabs`, and `remote.workspaceFiles`. Custom compositions that mount these GUI plugins without the new services cannot activate them. The shipped Web application bundle includes the providers; existing Session and tab menu Slot names remain available.

## Migration

1. In the package manifest that owns a custom composition, add dependencies on `@deepseek-ai/dsh-client-ui-context-menu` and `@deepseek-ai/dsh-client-ui-file-actions` at the same Harness version.
2. Add both package names as plugin rows in the custom Client composition alongside the existing locale, slots, shortcuts, sidebar, and workspace-file providers. The default `@deepseek-ai/dsh-web-app` bundle already contains these rows.
3. Rename `ctx.menus` to `ctx.contextMenus` and `MenuTargetMap` to `ContextMenuTargetMap`; neither old name has an alias. Mount the menu plugin so its `ctx.slots.provideRoot` contribution supplies `useContextMenu` to every Slot. Components call the hook once and spread `getTriggerProps(target, handlers?)` onto each element, including elements created in loops. See the [menu reference](../../../../packages/client/ui-context-menu/README.md) for handler composition and external action registration.
4. Rebuild and launch the custom profile. Confirm that GUI plugins activate, right-clicking a background Session preserves selection, and existing Session/tab Slot contributions still appear.
5. Custom Slot hosts must remove their declarations of `sidebar.workspaces.session.menu.item` and `sidebar.right.tab.menu.item`; the workspace and right-sidebar adapters now own these under `contextMenu.content`. Session rows retain the `[open, setOpen]` hook context, and tab rows receive `{ tab, dismiss }` within the clicked Session’s provider. A custom host replacing these adapters must declare the same children and supply those owners itself. Dockkit embedders using `getTabTriggerProps` own the popup and dismissal; `renderTabMenuItems` is used only by the kit popup. Supply reactive `tabMenuOpen` to suppress close-button tooltips while a custom menu prepares or remains open.

6. Built-in Session menu items are data contributions. The legacy React Slot retains external entries together before Archive; Slot priority no longer shadows built-in actions. Use `ctx.contextMenus.register` for new actions and optional `commandId` to display an existing command’s current binding. Keep captured-target execution in `run`; no command dispatch is added.
7. Menu contributions use `icon?: ReactNode`; replace `symbol` with a glyph element and wrap icon URLs in `<img>`. Obtain `useContextMenu` at each actual Slot entry. Plain children receive `getTriggerProps` or bound `contextMenuProps`; ToolRow uses `fileContextMenuProps` and `urlContextMenuProps`. Remove menu fields from Chat flow/node owners. The assistant entry supplies an ordinary file adapter to `forClosing()`, while Markdown adapts its target type at `MarkdownDelegateProvider.getTriggerProps`. Keep Session identity and gesture-time path resolution in the business registration. Remove imports of `contextMenuTrigger` and `menuPoint`; their independent utility package is removed. Do not add gesture exports to ui-primitives.
