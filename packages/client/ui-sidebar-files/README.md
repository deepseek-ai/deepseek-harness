---
description: "The right Sidebar's file-tree tab type for the dsh web client: the session workspace root listed one level at a time over the wire, opening files into the Sidebar by resource address."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-sidebar-files

English | [中文](README.zh.md)

## Summary

Browse a Session's workspace tree and open files in Sidebar previews. The root and expanded directories refresh automatically from direct-entry watches; manual reload remains available. The tab is reached from the guide and claims no resource address.

## Table of Contents

- [What it registers](#what-it-registers)
- [The tree](#the-tree)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="what-it-registers"></a>
## What it registers

The `workspace.files` command opens or focuses the file page in the focused pane; from the conversation it uses the current Session's active dock pane. A guide gives way to the file page, and repeated opens retain one file page per pane. Desktop defaults to Mod+P. The guide entry displays the effective shortcut; Windows and macOS Web use the [shortcut service’s platform defaults](../shortcuts/README.md); Linux Web leaves this command unbound by default.

- **The type** — `ctx.sidebarRightTabs.register(...)` with kind `files`, id `@deepseek-ai/dsh-client-ui-sidebar-files`, band `builtin`, no patterns, and one guide entry (order 10, its title and description from the `sidebarFiles` namespace, its glyph a yellow folder) that opens the type.
- **The body** — the keyed `sidebar.right.pane.tab` seat under that id: a header row under the strip, then the tree. The shared [`PathLabel`](../ui-primitives/README.md#component-catalog) displays the root path with subdued directories and a primary final segment. A clipped path retains its trailing characters with a left-edge fade; hovering reveals the full path. The reload control stays at its right.
- **The chip title** — the keyed `sidebar.right.pane.tab.title` seat under that id: a shared `FileTypeIcon` folder glyph at 16px before the type's label. The tree's own rows never draw this sheet.

Source files under `src/client/`: `definition.tsx` (the type), `store.ts` (what it keeps), `face.ts` (Remote reads and watches), `directory-node.ts` (open directories and their lifetimes), `FilesBody.tsx` (what it draws, with its ordering and failure-line helpers), `FilesTitle.tsx` (the chip title), `locales.ts` (what it says), and `index.ts` (the wiring).

<a id="the-tree"></a>
## The tree

The root is the session's working directory, read from `useSessions().byId[sessionId].cwd`. Filesystem roots such as `/` and Windows drive roots are valid tree roots. Every level is keyed by absolute path; a child's path is its parent's joined with the entry name by `/`. A level is listed when it is first expanded, through `remote.workspaceFiles.list(sessionId, absolutePath)` on the `@deepseek-ai/dsh-api-workspace-files` namespace; the adapter keeps the listing's entries and truncation flag and drops its workspace-relative path. Rows are ordered directories first, then by natural, case-insensitive name; dotfiles are shown like any other entry.

| Entry type | Row |
|---|---|
| `directory` | Toggles; reopening lists again and restores still-present expanded descendants. Displayed entries remain cached while collapsed. |
| `file` | Opens `dsh-resource://file/session/<sessionId>/<encoded path relative to the root>`, built by `fileAddressFor` from `@deepseek-ai/dsh-util-workspace-path` from the entry's absolute path and the tree's root, through `useTabInfo().tab.actions.openResource`, landing in the tab's own pane. |
| `other` | Shown greyed and not clickable, so the directory is reported whole. |

A level cut by the endpoint's entry cap ends with a marker; an empty level says so; a level that failed shows one line per code — `workspace-file/not-found`, `outside-workspace`, `not-directory` — and the transport's own message otherwise. Reload refreshes the root and expanded levels in place, retaining displayed entries during reads instead of resetting the whole tree; collapsed levels are fetched again when they next open. A session without a working directory shows a single line instead of a tree.

State lives in the type's own store, bucketed by tab id: `root`, `levels` (loading / ready / failed per absolute path), `expanded`, `autoRefresh`, and `scrollTop`, which the body tracks locally while scrolling and commits once when it unmounts. Because the store outlives the body, switching to another sidebar tab and back remounts the tree with its levels intact and its scroll offset restored. The owner's `signal` ends a bucket: on abort the tab is forgotten, and neither a listing that settles afterwards nor the unmount's offset commit writes anything.

Each open `DirectoryNode` owns its target watch for the Tab lifetime; collapse closes that node and its hidden descendants. Expansion changes during ancestor restoration update the store and pending nodes, so restored descendants follow the latest expansion preferences. Automatic refresh defaults to enabled; its separate toggle is hidden while state, labels, styles, and toggle logic remain. Changes received during a directory read or its completion remain pending for another refresh.

<a id="model-experience"></a>
## Model Experience

None, as this package draws a workspace file tree in the browser and registers nothing model-facing.

#### KV Cache effect

None; directory listings travel over the Remote and assemble no model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>
- **Listing only.** No search, artifact filter, drag-and-drop, rename, context menu, or current-file highlight.
- **One root.** The tree is rooted at the session's working directory; there is no way to browse above it, and the Host refuses paths outside the workspace root anyway.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

The page refresh shortcut refreshes the focused file tree through its ordinary directory reader. The reload control displays the effective binding on hover and keyboard focus.

</details>

**Runtime invariant:** No companion is published. The tab-owned face keeps directory reads and watches private, and writes displayed state through its Slot store; tab cancellation releases both. The package exposes no independent observation for a runtime comparison.
