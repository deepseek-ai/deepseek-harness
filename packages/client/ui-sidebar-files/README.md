---
description: "The right Sidebar's workspace file browser for the dsh web client: the files page and one workspace tree per pane beside docked and floating file previews, listed one level at a time over the wire."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-files

English | [中文](README.zh.md)

## Summary

Browse a Session's workspace tree beside the files you preview. Each pane, docked or floating, keeps one tree that every file tab in it shows: switching, opening, or closing files keeps its width, expansion, and scroll, and the tree marks the current file. A preview's tree opens a file in place of that preview; the `files` page opens it in a new tab where the right Sidebar places it by default. The root and expanded directories refresh automatically from direct-entry watches; manual reload remains available. The `files` page is reached from the guide and claims no resource address.

## Table of Contents

- [What it registers](#what-it-registers)
- [The navigator](#the-navigator)
- [The tree](#the-tree)
- [Reusable tree Factory](#tree-factory)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="what-it-registers"></a>
## What it registers

The `workspace.files` command shows the navigator drawn beside a docked tab's content in the focused pane and moves keyboard focus to its tree, keeping the tab; from the conversation it uses the current Session's active dock pane. Elsewhere — the files page itself, a tab without the navigator, a Session without a working directory, a floating tab — it opens or focuses the files page, whose tree always shows. A guide gives way to the files page, and repeated opens retain one files page per pane. Desktop defaults to Mod+P. The guide entry displays the effective shortcut; Windows and macOS Web use the [shortcut service’s platform defaults](../shortcuts/README.md); Linux Web leaves this command unbound by default.

- **The type** — `ctx.sidebarRightTabs.register(...)` with kind `files`, id `@deepseek-ai/dsh-client-ui-sidebar-files`, band `builtin`, no patterns, and one guide entry (order 10, its title and description from the `sidebarFiles` namespace, its glyph a yellow folder) that opens the type.
- **The page body** — the keyed `sidebar.right.pane.tab` seat under that id. Its header row spans the page and shows the root through the shared [`PathLabel`](../ui-primitives/README.md#component-catalog) with subdued directories and a primary final segment; a clipped path retains its trailing characters with a left-edge fade, and hovering reveals the full path. The tree's reload control, the Session-scoped `sidebar.right.tab.files.actions` list, which the page's registration declares, with the displayed root passed as `absolutePath`, follow at its end, in the order a preview's header ends with its reload and file actions; [`ui-open-in-app`](../ui-open-in-app/README.md) contributes the workspace directory opener. The pane's navigator fills the page below the header, docked or floating, and has no toggle there.
- **The rows** — the root-scoped Component Factory `sidebar.files.tree`, with caller-owned entries and a local `accessory` slot; see [Reusable tree Factory](#tree-factory).
- **The navigator** — the Session-scoped Component Factory `sidebar.files.navigator`, rendered directly by the page body and [`ui-sidebar-documentpreview`](../ui-sidebar-documentpreview/README.md) beside every preview, docked or floating. It draws the tree and its resize edge without a header of its own: beside a preview the preview's header is the only one, and the tree's reload and directory actions stay on the `files` page.
- **The toggle** — the Session-scoped Factory `sidebar.files.navigator.toggle`, rendered directly at the end of the preview header with `useTabInfo`. Both Factories share the page's store handle and inject face, retaining one open choice per pane; the page body has no toggle.
- **The chip title** — the keyed `sidebar.right.pane.tab.title` seat under that id: a shared `FileTypeIcon` folder glyph at 16px before the type's label. The tree's own rows never draw this sheet.

The [registration](src/client/index.ts) assembles the page, navigator, toggle, and tree Factories over the shared [files face](src/client/face.ts) and [pane store](src/client/store.ts).

<a id="the-navigator"></a>
## The navigator

Render `sidebar.files.navigator` with `FileNavigatorInput`: `{ useTabInfo, page, onOpen }`. The required `onOpen: (address: string) => void` callback belongs to the containing plugin; the navigator builds the file address without choosing placement. `page` controls presentation only: `true` always fills the files page, while `false` follows the preview's pane preference and available width.

The navigator is drawn below the preview's header, which spans the pane, at the right of the row it shares with the body. Beside a preview, its pane's record decides whether it shows: a pane starts with it hidden, and the choice holds for every file tab of the pane until the toggle, Escape, the workspace command, or navigation to a covered preview changes it. A pane without a record of its own, such as a floating panel a tab was dragged out into, starts hidden at the default width. A click outside the tree does not hide it, and opening content in another pane does not hide it either. On the files page the tree fills the page below the header, docked or floating, without a separator, and always shows: the page draws no toggle and Escape leaves it. A file the page opens starts with the destination pane's own choice, hidden for a pane that has made none.

Its width is the pane's preference, 260px until the reader drags the separator on its left edge with the primary button or moves it with the arrow keys, Home (narrowest), or End (widest), clamped to the row: at least 180px when the row allows it, and at most the row's width less 336px where the navigator sits beside the body and less 120px where it floats. Beside a preview in a viewport at least 768px wide, the row's width, measured by the face, picks one of three layouts. From 560px on, the navigator is a raised panel beside the body, 8px inside the row's top, right, and bottom edges and 8px clear of the body, which narrows by the panel and its margins but keeps at least 320px. From 400px up to 560px, the same panel floats over the body's right part, so the body keeps its full width and the part the panel leaves uncovered stays scrollable and interactive; the panel covers the body's scrollbar and a renderer's sticky toolbar where they run beneath it. Both panels have rounded corners, the floating dock panel's surface and shadow in light mode, and the compact tree's dark background with a soft white shadow in dark mode. The 560px threshold depends on the row alone, so resizing the tree never moves it between the two layouts. In a row narrower than 400px, or a viewport narrower than 768px, where the right Sidebar presents its panel fullscreen, the navigator fills the row below the header without the separator, and navigation to that preview hides the tree so the file shows. While filled, the covered body is hidden from keyboard navigation, including embedded frames. If the body holds focus when the row or viewport enters this layout, including the tree's first drawing, focus moves into the tree without changing the pane's open choice. The browser may blur the hidden body before the new width is reported; that focus also moves into the tree unless the reader moves the keyboard or the pointer, or the window loses focus, before the report. Docked and floating panes follow the same rules; the floating pane's resize handle remains reachable with the tree open in every layout. Beside a preview, an unmodified Escape that reaches the page's document from the body or the tree in the row closes the navigator at any row width and moves keyboard focus to the toggle; a key pressed while an embedded frame's document holds focus does not bubble to the page's document, so it leaves the navigator open. Escape is heard on the document after the row's own handlers, so a handler in the row that prevents it keeps it.

The preview's `onOpen` passes [`replaceTab: true`](../ui-sidebar-right/README.md#ctxsidebarright); the files page passes `{ paneId: panel.id }` when docked and omits placement when floating. The right Sidebar owns replacement, default docked placement, and reveal. A replacement retains the pane's tree. When the tree holds keyboard focus and an open replaces or switches the tab in the same pane, the next drawing focuses the current file's row; revealing another pane leaves the initiating tree and its focus unchanged.

A new `tab.navigation.revision` closes only the destination preview's tree, and only when it covers the content row at the destination's current width. The rule applies to every navigation source, including an open from that floating preview's own tree. Hidden trees consume navigation too, so manually showing one does not replay an old close. Ordinary tab switches, floating or docking, and revision `0` restored by reload or undo do not close the tree. The files face retains consumption records for the tab lifetime; navigation subscriptions end on tab closure or plugin disposal. The page's always-visible tree is not closed by navigation.

The tree marks the row of the current file with `aria-current`. While the tree is drawn, a file not yet revealed in the pane has its ancestors expanded one listed level at a time and its row scrolled into view; a kept level that is being listed again, as when a hidden tree shows or a collapsed directory reopens, is waited for before a name missing from it ends the reveal; the pane remembers the file it revealed last, so a remount of the same tab changes neither expansion nor scroll. A directory the reader collapses during a reveal ends it, and the pane counts the file as revealed. A file outside the workspace root, or one of another Session, is not located; under a Windows drive or UNC root, containment ignores case and separator spelling, and under a POSIX root it is case-sensitive.

<a id="the-tree"></a>
## The tree

The root is the session's working directory, read from `useSessions().byId[sessionId].cwd`. Filesystem roots such as `/` and Windows drive roots are valid tree roots. Every level is keyed by absolute path; a child's path is its parent's joined with the entry name by `/`. A level is listed when it is first expanded, through `remote.workspaceFiles.list(sessionId, absolutePath)` on the `@deepseek-ai/dsh-api-workspace-files` namespace. The rows are drawn by the [tree Factory](#tree-factory), which orders them; `workspace-tree.ts` passes every listed entry with its listing's name and type as `meta.kind`, the root key without trailing separators, and localized failure lines. The Factory reads its own copy from the files locale. Dotfiles are shown like any other entry.

| Entry type | Row |
|---|---|
| `directory` | Toggles; reopening lists again and restores still-present expanded descendants. Displayed entries remain cached while collapsed. |
| `file` | Opens `dsh-resource://file/session/<sessionId>/<encoded path relative to the root>`, built by `fileAddressFor` from `@deepseek-ai/dsh-util-workspace-path` from the entry's absolute path and the tree's root, as [the navigator](#the-navigator) describes. While no registered tab type can open that address, for example without `ui-sidebar-documentpreview`, the row is shown greyed and not clickable with a line saying so, and it becomes clickable as soon as a type that opens it registers. |
| `other` | Shown greyed and not clickable, so the directory is reported whole. |

A level cut by the endpoint's entry cap ends with a marker; an empty level says so; a level that failed shows one line per code — `workspace-file/not-found`, `outside-workspace`, `not-directory` — and the transport's own message otherwise. Reload refreshes the root and expanded levels in place, retaining displayed entries during reads instead of resetting the whole tree; collapsed levels are fetched again when they next open. A session without a working directory shows a single line instead of a tree.

State lives outside the drawing, keyed by the pane id that `useTabInfo().panel` reports. The type's own store holds, per pane, the navigator's `open` choice and `width`, and its `tree` once first shown: `root`, `levels` (loading / ready / failed per absolute path, a ready level marked `refreshing` while it is listed again), `expanded`, and `autoRefresh`. Every file tab of a pane reads the same record, so switching, opening, or closing tabs redraws the navigator with its levels, expansion, width, and scroll intact; a tab switch lists nothing again. Hiding the tree, or showing only tabs without it, closes its directory watches; showing it again lists the root and the expanded directories again in place while their kept rows stay drawn. A tree rooted at a directory other than the Session's current working directory is replaced, and its scroll position and revealed file are reset. A pane keeps its tree while it shows the navigator or holds an open tab that last drew the navigator there: a file tab moved to another pane shows that pane's tree, a tab replaced in place, as a picked file replaces a preview, keeps it, and floating or docking a tab never ends it by itself. Once the last such tab closes or draws the navigator elsewhere, the pane's tree is forgotten. The page and every preview's navigator share one face per Session.

Each open `DirectoryNode` owns its target watch while the tree is drawn; collapse closes that node and its hidden descendants. Expansion changes during ancestor restoration update the store and pending nodes, so restored descendants follow the latest expansion preferences. Automatic refresh defaults to enabled; its separate toggle is hidden while state, labels, styles, and toggle logic remain. Changes received during a directory read or its completion remain pending for another refresh.

File rows expose the shared [context menu](../ui-context-menu/README.md) without invoking ordinary click navigation. Directory rows and the root path use the `directory` target for native reveal and path copying without expanding the tree.

<a id="tree-factory"></a>
## Reusable tree Factory

To draw workspace listings, changed files, or local diffs, declare `const TREE_OPTIONS = { slots: { accessory: ModuleLevelComponent }, fallback: null }` at module scope, then call `renderFactorySlot('sidebar.files.tree', input, TREE_OPTIONS)`. Keep the options and its `slots` object stable; recreating the local selection makes the whole tree redraw on parent renders. The root-scoped Factory is available only while the files plugin is loaded; without it, `renderFactorySlot` renders the supplied `fallback`, or nothing when omitted. Import declarations and `FileTreeInput`, `TreeEntry`, `TreeEntryMeta`, `TreeEntryKind`, and `TreeDirectoryState` type-only from `@deepseek-ai/dsh-client-ui-sidebar-files/client`; no component value is exported.

`FileTreeInput` carries `root`, flat `entries`, `expanded`, `onToggle(entry, expanded)`, and `onOpen(entry)`. Optional `directories` supplies loading, localized failure, and truncation states by key; `current` and `currentRef` mark and expose the current file button. `canOpen(entry)` can refuse a file without disabling its accessory. `rowTriggerProps(entry, kind)` supplies context menu handlers for directory rows and openable file rows. The Factory owns loading, empty, truncated, and unavailable copy through the files locale; callers own data access, expansion, opening, ancestor reveal, and scrolling.

A `TreeEntry` is `{ path, name, meta?: { kind?, hidden?, size? } }`. Only `/` separates levels; the parent is the prefix before the last `/`, or `root` when there is none. Names remain caller-supplied; repeated paths keep the first entry. Root-key entries are ignored, including the empty root. Missing intermediate directories are added once, with explicit entries taking precedence. An omitted kind means directory when entries lie below that path, otherwise file. Hidden rows use subdued ink without filtering; size is not drawn. Only visible levels sort, directories first and then by natural case-insensitive name order; each level keeps its sorting cache until its names or directory kinds change.

The local `accessory` slot has root scope and owner props `{ entry: TreeEntry }`; its Component may also use the derived `FactoryLocalComponentPropsOf<'sidebar.files.tree', 'accessory'>` seats. It receives only `entry` and the Factory's own seats, not the caller's store or inject face. Supply a module-level Component to preserve its identity. Its content sits beside the main button, never inside its action or disabled scope. The default Component renders nothing. The accessory wrapper always exists in the DOM; CSS hides it without taking row space when the slot is absent or its Component returns empty content.

<a id="model-experience"></a>
## Model Experience

None, as this package draws a workspace file tree in the browser and registers nothing model-facing.

#### KV Cache effect

None; directory listings travel over the Remote and assemble no model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>
- **Listing only.** No search, artifact filter, drag-and-drop, or rename.
- **One root.** The tree is rooted at the session's working directory; there is no way to browse above it, and the Host refuses paths outside the workspace root anyway.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

The page refresh shortcut refreshes the files page's tree through its ordinary directory reader while the tree shows; on a preview it reloads the preview. The page's reload control displays the effective binding on hover and keyboard focus.

</details>
