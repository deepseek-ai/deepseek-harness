# Agent Note: The workspace tree is per-pane state drawn inside each file tab, and the plugin mounting it decides where files open

Status: implemented

English | [中文](2026-10-20-workspace-tree-state-per-pane.zh.md)

## Problem

Reading several workspace files needs a tree beside their previews without losing expansion, loaded levels, width, scroll, or keyboard position on every tab switch. The dock mounts only the selected tab's body, so a component instance cannot own the state shared by a pane's file tabs.

A floating panel holds one tab. A preview's file picker must replace that tab in its panel, while the files page must remain available and open content in the dock. A covering tree must close where content is navigated to, not where the initiating click happened.

## Decision

### The tree is drawn inside each file tab, and its state is kept per pane

`ui-sidebar-right` supplies `useTabInfo().panel` with the containing pane's `id` and `isFloating`; moving a tab updates those fields without changing `tab.id`. It supplies no pane lifetime. `ui-sidebar-files` owns each pane's tree state, visibility, width, listing, directory watches, scroll, and last revealed file. The navigator and toggle are Session-scoped Component Factories; `ui-sidebar-documentpreview` renders them inside the tab's content row and header, with stable positions across loading states. The docking kit does not acquire a files-specific overlay or layout rule.

A pane's records follow the tabs whose navigator last drew there, using each tab's `signal`. A replacement in the same pane retains the records. A moved tab uses its destination pane's records; a pane without records starts hidden at the default width. Tab-owned preview scroll is independent of that tree state. Records are released after their last associated tab closes or draws the navigator elsewhere.

Directory watches follow visible drawings rather than retained records. Hidden trees hold no Host directory watch; showing them again refreshes the root and expanded directories while retaining rows. A same-pane tab switch keeps the listing and watches across the replacement drawing. This extends the [directory watch lifetimes](../feature/2026-09-17-sidebar-file-and-directory-auto-refresh.md) from one tab to the pane's drawn tree.

The files face owns ancestor reveal, scrolling, row measurement, and focus across drawings, so replacing a drawing does not discard an ongoing interaction. [The navigator reference](../../../../packages/client/ui-sidebar-files/README.md#the-navigator) owns layout, workspace-command, and keyboard rules.

### The rows are a controlled Component Factory over flat entries

The root-scoped `sidebar.files.tree` Factory keeps reusable rows, its local `accessory` slot, and localized copy with the files plugin. Callers own data access, expansion, opening, and reveal. The workspace navigator adapts its pane's directory states to these inputs.

### The plugin that mounts the tree decides where a file lands

`FileNavigatorInput.onOpen(address)` is the containing plugin's callback. The navigator constructs the file address but neither chooses placement nor closes the initiating tree after the call. Its `page` input controls layout only. A callback keeps the same navigator usable for the files page and document previews without teaching its rows either host's opening policy.

The [preview and files-page callbacks](../../../../packages/client/ui-sidebar-files/README.md#the-navigator) express different lifetimes: the preview gives way to new content, while the files page remains a directory browser. [Right Sidebar placement](../../../../packages/client/ui-sidebar-right/README.md#ctxsidebarright) owns replacement and reveal; the navigator does not duplicate those policies.

### Navigation is consumed by the destination tab

The files face follows the existing navigation observable only for tabs attached to its navigator. It retains each tab's consumed revision independently of the drawing and releases that subscription on tab closure or plugin disposal. It does not require a layout inventory, navigation-origin field, or an opening result from the right Sidebar.

The face waits for the destination drawing and measures its current row, so the previous tab's width cannot decide whether content is covered. It consumes navigation even while hidden to prevent a later manual show from replaying an old close. [The navigator reference](../../../../packages/client/ui-sidebar-files/README.md#the-navigator) defines the navigation sources and revision exclusions.

### Each package works without the others

The packages compose through the right Sidebar's tab information, the files Factories, and the tab-type registry. The preview imports only the files Factory declarations; files has no preview dependency. Without a registered viewer, the files page still lists the workspace and disables file rows it cannot open. Without the files plugin, the unregistered Factory positions render nothing and the preview keeps its own header, body, and file-handoff slots.

## Alternatives considered

**A static tree package or a component in `ui-primitives`.** The [package-shape rule](../../../../docs/defensive-patterns/package-surface.md) excludes new static libraries. A primitive would also require each caller to supply the generic tree labels. The Factory keeps that copy and registration with files, at the cost of requiring that plugin to draw rows.

**A tree that owns directory reads or requires a complete path list.** A workspace is listed one expanded directory at a time. The tree therefore accepts partial entries and per-directory loading, failure, and truncation state. Owning reads inside each drawing would split the state and watch lifetimes that must survive tab switches.

**A pane lifetime signal.** Floating and docking can replace the pane while retaining the tab. A pane signal would end tree state too early and invite attaching tab-owned resources to the wrong lifetime; transferring the signal would make it outlive the pane id used as the state key. The tabs' existing signals provide the required release condition.

**A pane-level overlay that stays mounted.** It requires a layer above docked and floating tab hosts and changes to layout, focus, measurement, and drop targets to avoid intercepting input, including floating resize handles. Drawing inside tabs keeps these concerns in their existing owners.

**Keep visited bodies mounted or copy per-tab trees.** Retaining every body still creates independent trees and watches for tabs sharing a pane and retains each preview's rendered content. Copying state cannot transfer watches and needs a conflict rule when tabs move between panes.

**Keep watches for a pane's whole lifetime or release by inspecting its layout.** The main docked pane rarely disappears, so lifetime-bound watches remain after hiding. Inspecting tab kinds in the layout couples files to every navigator consumer and still does not express whether the tree is drawn.

**A focus request bit consumed by a component effect.** A request stored on the initiating pane can survive a reveal elsewhere and affect a later drawing; a hidden consumer has no element to focus. The face ties focus to its actual drawings instead.

**Carry a dragged tab's tree preference into its new pane.** This needs another transfer policy and conflicts with the state already owned by the destination pane. A new pane starts with the same defaults as every other new pane.

## Consequences

Tab remounts do not own or reset the pane's tree. Moving a tab selects the destination's state rather than copying the source's; hiding releases directory watches without deleting expansion and scroll. Navigation consumption is per tab, while display preferences remain per pane, so an open in another pane does not close the source tree.

The files page retains directory reload and directory-action controls; a preview retains its file controls and handoff. Opening policy remains with those hosts, not the reusable rows.

## Verification

- `packages/client/ui-sidebar-right/tests/tab-info.client.spec.tsx`, `service.client.spec.ts`, and `seat.client.spec.tsx` cover live pane information, replacement, reveal, and framework tab hooks.
- `packages/client/ui-sidebar-files/tests/` covers per-pane state, navigation consumption, drawing lifetimes, workspace roots, and file opening callbacks.
- `packages/client/ui-sidebar-files/tests/file-tree.client.spec.tsx`, `file-tree-interactions.client.spec.tsx`, and `file-tree-factory.client.spec.tsx` cover generic rows, independent accessories, and real Factory composition with locale and fallback.
- `apps/web/tests/file-browser.e2e.ts` and `apps/web/tests/file-browser-composition.e2e.ts` own browser evidence; the latter disables each of `ui-sidebar-documentpreview` and `ui-sidebar-files` in the shipped Web composition.
