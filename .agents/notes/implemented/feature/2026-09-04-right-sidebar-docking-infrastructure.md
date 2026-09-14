# Agent Note: Right Sidebar docking infrastructure

Status: implemented

English | [中文](2026-09-04-right-sidebar-docking-infrastructure.zh.md)

## Problem

The Web client's right column was a single-purpose Detail panel: `ui-chat` occupied the `details` slot with `DetailsPanel`, which showed one selected Tool call's raw payload through a `conversation.details.tool` child seat. Nothing else could live there. A plugin that wanted a persistent side surface — a file preview, a task list, a diff — had no seat to register into, no way to open its content from the conversation, and no shared layout to share the column with.

Files the agent produced were the sharpest case. A produced-file chip or a `read` row's path link handed the path to the operating system through `session/openWorkspacePath`, so a browser that was not on the Host machine could not look at the file at all, and even a local one left the product to do so. The details panel meanwhile duplicated the chat rows' cards at full height, a second presentation surface every card had to keep in step.

## Decision

The right column is a per-session docking surface — split panes, tabs, floating panels, and an undoable operation sequence — owned by `ui-sidebar-right` over the `ui-dockkit` engine, replacing the Detail panel. This note owns the surface: the engine, the frame's right column, the panel's presentations and controls, and the per-session state. What lives in the surface is decided elsewhere: how plugins declare tab types, open content, and receive their props is [tab types and navigation](../architecture/2026-09-05-sidebar-tab-types-and-navigation.md); live data behind an address is the [client resource model](../architecture/2026-09-05-client-resource-model.md); reading workspace files is the [workspace file service](../architecture/2026-09-05-workspace-files-service.md); and the guide, the text preview, and the file tree are the [shipped types](2026-09-05-sidebar-text-preview-and-file-tree.md).

### Package topology

| Package | Kind | Owns |
|---|---|---|
| `packages/client/ui-dockkit` | static-linked library, zero DSH dependencies | the layout engine and the React components that render and drive it; consumers compile its sources, and it keeps exactly one stylesheet because a consumer de-duplicates injected sheets by file name |
| `packages/client/ui-sidebar-right` | dynamic plugin | the `rightbar` panel seat and the `conversation.session.header.corner` expand button over one store, one surface per session, both presentations, the float host, `ctx.sidebarRight`, `ctx.sidebarRightTabs`, the tab domain (one occurrence per tab record), the three extension seats, the guide tab type, and the `sidebarRight` copy namespace |

The kit is the product's first embedder and knows nothing about it: every string arrives through `DockLabels`, every tab body through a `TabRenderer` dispatching on an opaque `kind`, and every gesture leaves through `DockIntents`. The integration package supplies what the kit refuses to know.

### Layout engine

The engine is a normalized recursive split tree: `nodes` keyed by id, `rootId` for the docked root, `floats` bottom-to-top. The ids are branded (`PaneId`, `SplitId`, `TabId`; `NodeId` is the pane/split union), minted only by a `Mint`, so no id kind stands in for another or for a bare string. A floating panel is a pane whose `host` is `'float'` with capacity one, drawn without a tab strip. `applyOp(state, op)` returns the next state and the operations that undo it, captured when the operation runs because the pre-operation state is gone by undo time. Every operation carries the ids it creates, so `replay(initial, ops)` reproduces the same tree from the same start; the engine reads no clock and no random source. The `Sequencer` keeps a linear history with one entry per intent — the operations one gesture or command produced undo and redo together — a run of consecutive focus-only entries steps as one, and a new entry after stepping back drops the forward branch. Planners are the pure intent layer — `(state, mint, args) → LayoutOp[]` — and `DockController` is a thin observable shell over them. `planSettle` is the opt-in follow-up planner that merges away every docked pane an intent emptied and reseeds an emptied root pane through the embedder's factory.

Components render a snapshot and report settled intents, one per gesture: a drag previews in local state while the gesture's facts stay in its closure, and the release folds the net result into one operation. Gestures are pointer events with pointer capture rather than HTML5 drag-and-drop. A chip is a capsule carrying one control, its close; a secondary press opens the context menu (close plus the embedder's `renderTabMenuItems`). After the chips sits the add control, which asks the embedder through `DockIntents.addTab` to seat its seeded tab (`planAddTab`). Floating is the drag released clear of the surface, and copying has no kit control at all — `DockIntents.duplicateTab` stays for embedder APIs. The split control's glyph is a frame bisected vertically, as the split is. Four interaction rules fix defects found in a real browser and are kept on purpose: capture the pointer on gesture start, never make the tab strip a scroll container, land focus on click rather than press, and let a control nested in a draggable chip stop its own press. The tab's actions menu renders in a portal positioned against its control, because the strip's deliberate overflow clip would otherwise cut it off. The kit ships no undo/redo control, and no header: an embedder's surface-wide controls go through `DockSurface`'s `chrome` prop, which the kit places at the far end of the top-right pane's strip (`topRightPaneId`: the last child of every row split, the first of every column split). The generic kit defaults to four panes; the Sidebar supplies its two-pane product limit.

### The frame's right column

[Responsive Sidebar and tab information](../architecture/2026-09-07-sidebar-responsive-tab-info.md) supersedes this note's no-concession layout, overlay presentation and product pane limit. `ui-layout` still owns three-column geometry and pixel width preferences; the Sidebar occupant reports presentation through `ctx.layout.openRightbar(track, fullscreen)` and `closeRightbar()`, without the frame injecting the Sidebar package. Exact width rules belong to [ui-layout](../../../../packages/client/ui-layout/README.md).

The right Sidebar uses one mounted content tree in normal and fullscreen modes; hiding preserves tab state, and fullscreen covers the viewport while retaining underlying column reservation. Floats still use viewport coordinates through a portal and remain open when the Sidebar closes. The product limits docking to two horizontal panes and a 20–80% divider; the generic engine keeps its own defaults.

### State

[Default pages](2026-09-08-sidebar-default-pages.md) supersede default-guide reseeding here; [last-tab close rules](2026-09-08-sidebar-last-tab-close-rules.md) own explicit closing, while moving tabs still settles emptied panes.

`ui-sidebar-right` keeps one `SurfaceState` per session id — the layout, its history, and the mint counter — in a store declared at the seat registration. Every action mints the ids its intent needs, asks a kit planner for the operations, runs the settle planner over the result, and records the whole intent as one history entry before assigning the session's surface back; no action edits a layout in place. The settle step is the product's rule: a docked pane whose last tab is closed, moved out, or floated is merged away, and an expanded empty root pane receives the current default page. A collapsed surface may remain empty until its next expansion; no separate pane-closing gesture exists. State is memory-only: a reload returns every session to the collapsed default, and switching sessions keeps each surface where it was. Layout is presentation state and never enters the session log.

### Beyond the surface

The surface renders tabs whose bodies it does not know: each tab carries a `kind`, and the panel asks the type registry for the implementation in force and dispatches to its keyed body seat. Everything a body may rely on — its record, its pane, whether it is visible, how it was navigated to, an abort signal, and the actions it may take — is read through the framework-injected `useTabInfo()`. The registry, the navigation face `ctx.sidebarRight`, the seats, and the tab information are specified in [tab types and navigation](../architecture/2026-09-05-sidebar-tab-types-and-navigation.md); a body that shows data reads it through the [client resource model](../architecture/2026-09-05-client-resource-model.md).

### Entry points and removals

`ui-chat`'s `openFile(path, { line? })` — reached by tool-row path links, produced-file chips, and closing-message mentions — now opens the file into the Sidebar through the navigation face (see [tab types and navigation](../architecture/2026-09-05-sidebar-tab-types-and-navigation.md)). The `Show in folder` action and its `canOpenWorkspacePath` probe are removed from `ui-deliverables`: the Sidebar has no directory form, and the product keeps no secondary entry. `DetailsPanel`, `ToolDetails`, the tool-node reader, the chat store's selection, `ToolDetailsProps`, and `CENTER_MIN` are removed. `session/openWorkspacePath` remains on the Host with no web caller.

## Alternatives considered

**Adopt a docking library.** Six engines were evaluated against the product's state-ownership requirement (the layout is a recorded, replayable sequence the product owns). dockview is uncontrolled and its only external entry is a destructive `fromJSON`, with undo in a paid tier; react-mosaic has no floating layer and rests on a drag base unmaintained for years; rc-dock, golden-layout, and Lumino failed on state ownership. FlexLayout 0.10.x was the one viable candidate — external Model, vetoable `onAction`, content-preserving `fromJson` — and was kept as a verified fallback whose switch points were the prototype's five-zone dock and multi-float tests. Both passed self-built with no switch signal, and its 0.x minors carry breaking changes, so it was not adopted.

**Layered reuse: `react-resizable-panels` for sizes, Pragmatic drag-and-drop for gestures.** The planned main line before the prototype. Rejected once the prototype's own size and gesture layers passed in a real browser: the layers the plan meant to save had already been written and verified, so the remaining value was only long-tail edge handling. It stays a replaceable layer if snap or priority sizing is ever required.

**A drawer over `shell.overlay`, or a double-layer shell (root rail, session content).** The prototype shipped as a drawer to avoid touching the frame. Rejected for the product: a drawer is not a column and never squeezes the conversation, and the double-layer shell hit the slot core's one-handle-one-scope rule, which would have made collapsing un-undoable. The frame owns a real column; content and state stay session-bound.

**A frame-owned 32px rail as the collapsed state, the panel living inside the animated grid track, and the overlay as a separate portal.** The first shipped form. Rejected after review: a solid rail track pushes the conversation's scrollbar inboard for a strip that exists only while collapsed; a panel inside the animating track is stretched and re-laid-out by every track transition, so the Sidebar itself visibly moved when it should not; and two code paths for one panel meant switching presentation remounted it. The panel is now one edge-anchored box that slides and the track only reserves room.

**A 40px rail inside the conversation column, with its own `sidebar.right.rail.item` seat.** Tried next, so the rail could leave with the panel. Rejected on review as visually too heavy for what it carried: a full-height strip for one button and a placeholder. The expand control is now a single header button and the collapsed-state seat is deferred until something needs it.

**A header row on the panel.** The first form carried a title and its controls in a 40px row above the strip. Removed: the strip already is the panel's top edge, so the controls sit at the strip's end in the top-right pane through the kit's chrome seat, and the title said nothing the tabs did not.

**The expand button as a `conversation.session.header.utilities` entry.** Tried after the rail. Rejected on review: as a list entry it sat inside the utilities row, so it was not at the header's true corner, and its appearance and disappearance shifted the Session log control beside it. A dedicated corner seat with a reserved footprint fixes both.

**A per-chip "more" control with copy and float items.** The first form gave every chip a `⋯` menu holding close, copy, and float. Rejected on review: the chip now carries only its close, the menu moved to the secondary press with only close (plus embedder items), and copy and float left the panel entirely — copy stays an API (`open` with `duplicate: true`), float stays the drag. The kit's `duplicateTab` / `floatTab` intents and planners are unchanged.

**Undo and redo buttons on the panel header.** Shipped first, then removed: the sequence is an architectural fact, and stepping it is not a product action yet. The API stays reachable as `@internal` methods for tests and the future navigation controller.

**Empty panes as a persistent state.** The first design allowed a pane to stay after its last tab left, with a placeholder. Rejected because nothing offered a way to close such a pane; every intent settles the surface so an emptied side pane is merged away. An empty root receives the current default page only while the column is expanded.

**Inline the kit through `packages/util` and the `INLINE_SAFE` list.** A build probe showed it works, but the util build chain has no CSS pipeline and the kit ships a stylesheet; the static-linked client package (the `ui-primitives` precedent) was chosen knowing that changing the kit means rebuilding the shell and reloading.

## Consequences

- The docking surface itself no longer overflows its panel: `.surface` and `.pane` clamp to the column (`min-width: 0`, `overflow: hidden`), so a long unwrapped line scrolls inside the body and the strip's controls stay in view in every split.
- Layout is undoable and per session, and it is memory-only; a reload starts every session collapsed. Undo is reachable only through `@internal` service methods; the product shows no history controls.
- An expanded surface has no empty panes. Empty side panes merge away; an empty root receives the current default page only while expanded. New sessions and a collapsed surface whose last tab closed remain empty until expansion.
- A pane holds at most one guide tab: a second one cannot be added, opened, duplicated, or moved in; the guide's uniqueness is per pane, so a split still seeds its new pane with a guide.
- A pane may split only when each equal half can still hold what cannot shrink: the strip's fixed controls (its width minus the chip box and the fill, so the top-right pane's chrome counts on the half that hosts it) plus one chip at its minimum, measured in the component layer after every commit and on resize. Otherwise the split control stays, disabled with its own copy, the matching edge drop zones are withheld, and panes the user narrows keep their size; the product permits at most two horizontal panes, regardless of widening or divider movement.
- The Sidebar panel never moves when the presentation switches, and its slide is the same in both presentations; the conversation is the only thing that animates on a switch. A hidden panel keeps its tabs mounted, so a preview survives a collapse.
- Collapsed, the Sidebar is one header-corner button: the conversation keeps its full width and its scrollbar at its edge, the button leaves when the panel opens, and its footprint stays so nothing else in the header moves.
- A tab is closed from its chip; copying and floating have no panel control (copying is API-only, floating is the drag). The context menu is reachable by right-click and carries close plus embedder items.
- The Detail panel and its duplicate card presentation are gone (a net removal of roughly 1,400 lines); cards are read in place, and `inspect` opens the trajectory view.
- The frame has no centre floor: a viewport narrower than the two edge columns squeezes the conversation toward zero instead of closing a column.
- The kit is compiled by its consumers, so a kit change requires a shell rebuild and a page reload; there is no HMR for it.
- The panel, the float host, and the portalled tab menu use hard-coded z-index values; the client still has no z-index token layer.

## Testing

`ui-dockkit` specs pin the engine's invariants — every operation's inverse round-trips, `replay` over any prefix of the history equals the recorded state, one compound intent steps as one entry, focus runs coalesce symmetrically, the pane cap and the width rule refuse with no record — and drive the components with props alone, with no scaffold. `ui-sidebar-right` specs cover the per-session store, the seat's presentations and controls, per-pane guide uniqueness, and the width-aware split. The Web e2e suite drives the shipped Sidebar in Chromium through the real plugin graph: expand and collapse, split to the limit and the greyed control, floats, docking back, and the guide. Both suites are keyless.

## Deferred

- A z-index token layer, then the panel's, the float host's, and the menu's hard-coded values.
- The assembled session-switch case, blocked on the fixture composition opening its settings surface by default.
- Chinese counterparts for the new packages' READMEs and for the English documentation this change edited.
- Snap or priority pane sizing, touch tuning, and keyboard routes for split, move, and float.
- Persistence of the layout, popout windows, and a content navigation stack (entries keyed by pane and content, adjacent duplicates replaced, a `navigating` guard, closed tabs left in the stack).
- A non-closable tab (a `closable` flag on `TabRecord`, drawn as a fixed leading marker rather than a capsule) once a tab type needs one.
