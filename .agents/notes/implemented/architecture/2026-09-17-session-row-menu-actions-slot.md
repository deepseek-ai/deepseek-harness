# Agent Note: Session row actions as slot lists

Status: implemented

English | [中文](2026-09-17-session-row-menu-actions-slot.zh.md)

## Problem

The Session row's "..." menu and its hover buttons were closed lists owned by `ui-workspace`: the browser built the menu `items` by row state, rendered the pin and archive buttons itself, and dispatched every verb through callbacks it threaded down the tree, together with the toast and rename dialog those verbs needed. A client plugin could add a sidebar control of its own, but not an action beside the shipped ones without editing the owning package or copying the menu interaction.

## Decision

`ui-workspace` declares two root-scoped `list` slots under its `sidebar.workspaces` registration — `sidebar.workspaces.session.menu.item` for the menu rows and `sidebar.workspaces.session.row.action` for the hover buttons — and registers its own actions into them from `apply` exactly as a client plugin would: `pin` (menu 100, button 200), `rename` (200), `fork` (300), `archive` (menu 400, button 100). The lists are the menu and the button strip: entries render in ascending `order`, a plugin action lands wherever its order says, and reusing a shipped id at another `priority` shadows that action through the registry's ordinary cell rules. There is no separate "extension group": the owner draws no separator, and a group start is the entry's own `separatorBefore`.

An entry receives only the row identity, `{ sessionId, displayTitle }`, and owns everything else. It reads the Host state it cares about through hooks its own face injects (`usePinned` and `useArchived`, Sets derived once per Workspace snapshot) and decides its own visibility from it: pin renders nothing on an archived row because the Host keeps the two sets exclusive; archive never consults pin. Its whole behavior lives in its registration's `inject` face, so a component only calls one callback: `pinSession` delegates to `uiWorkspace.pinSession`, which performs the Host pin and then fronts the Session in its accounts' saved orders with `pinSessionOrder`, reading the memberships current at completion from the object-layer snapshots (`pin-order.ts`), beside `archiveSession`, which the same service already owned; the archive action's callback adds the notice. The service writes view order through the viewing-store instance the apply creates and hands the browser's registration as its handle, the pattern `ui-layout` uses for its layout store. The registry-global pin and archive sets reach the entries as Sets through the faces' `hooks`, derived once per Workspace snapshot, so a row reads its own membership with one lookup.

The surfaces an action raises outlive the row menu, so they are this package's `shell.overlay` entries: the rename dialog and the row-action notice. An action reaches its surface through the plugin's own apply-closure observable, injected as a callback on the action side (`requestSessionRename`, `notify`) and as a `hooks` source on the surface side (`useRenameRequest`, `useToast`). The browser raises the same rename request from a title double-click and the same notice when an archived row is clicked; the archived notice's second action switches the archived filter to "show" through the same store instance, since the browser's view-options menu is no longer in the loop.

The shipped menu entries render `MenuItemButton`, the `ui-primitives` row component for menus whose rows are components: a plain row, markup and styling only. Any `role="menuitem"` button joins the menu's keyboard walk, submenu exclusivity, and focus return, because `Menu` decides all three from the DOM (the arrow walk queries the rows; submenu collapse and the post-selection focus return run on the list's own bubbles, for data rows and component rows alike) — a `cordis-client-runner` closure, which cannot import the primitive, renders such a button directly. Closing is the owner's state for both kinds of row: data rows through the owner's `onSelect`, component rows through the slot-level `useMenuOpenState` hook — the declaration carries `inject: { hooks: { menuOpenState } }`, `SessionNodeItem` passes its `[open, setOpen]` pair as the occurrence's `hookContext`, and the factory hands the pair back. That is the channel `sidebar.right.pane.tab` already uses for `useTabInfo`.

## Alternatives considered

**A React context between `Menu` and the row component.** Rejected: business components see zero React contexts ([client rules](../../../../packages/client/AGENTS.md)); the Menu-to-row relationship is parent-to-child through the slot system, so its control travels through the slot channels.

**Owner-supplied row capabilities.** Passing `pinned`/`archived` and `pin`/`archive`/`rename`/`fork` callbacks to entries, through owner props or a slot-level hook, keeps the browser the owner of every verb and makes the shipped actions thin wrappers over it. Rejected: these are not capabilities of a menu; each action's behavior is that action's own, and an entry can read the Host state it needs directly.

**A dedicated slot appended below the shipped rows.** Rejected: it makes the shipped rows a privileged group a plugin can only follow, and it needs a second rendering path in the primitive for what is one ordered list.

**Entries that compute their own view-order writes.** A pin entry subscribing to the whole Session list and Workspace snapshot to assemble `pinSessionOrder`'s inputs re-renders every visible row on every list change and puts ordering detail into a menu row. Rejected: the injected callback owns the write and reads the snapshots once, at completion.

**Declared shared stores for the rename request and the notice.** The request and the notice are one plugin's transient facts, so they travel as apply-closure observables through the entries' own inject faces.

## Consequences

Plugins add, reorder, or shadow Session row actions in the menu and in the hover strip without editing `ui-workspace`, and the shipped actions follow the same rules and the same registration path. `WorkspaceBrowser` no longer threads action callbacks, renders a toast, or hosts the rename dialog; `Menu` grew `children` and made `items`/`onSelect` optional; `shell.overlay` gained two `ui-workspace` entries. The archived notice applies the "show archived" filter directly instead of opening the view-options menu.
