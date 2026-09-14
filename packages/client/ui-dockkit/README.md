---
description: "Docking layout kit for the dsh web client: a split tree of tabbed panes with invertible operations, planners, a linear history, and the components that render and drive it."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-dockkit

English | [中文](README.zh.md)

## Summary

A docking layout kit: a split tree of tabbed panes with invertible operations, and the components that render and drive it. The Harness Web client is its first embedder; nothing in here knows that.

> **Internal engine.** This package is published because the Sidebar links it statically, not as a stable API: its exports — `LayoutState`, `LayoutOp`, the planners, `DockIntents`, `DockLabels`, `DockMode` — may change in any release, and none of them appears in a service interface (`ctx.sidebarRight` exposes operations, never layout snapshots or operation logs).

## Table of Contents

- [The two layers](#the-two-layers)
- [Embedding it](#embedding-it)
- [Interaction rules worth keeping](#interaction-rules-worth-keeping)
- [Build shape](#build-shape)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="the-two-layers"></a>
## The two layers

**The engine** is pure logic — no UI framework, no DOM, no host concepts.

- A normalized recursive split tree: `nodes` keyed by id, `rootId` for the docked root, `floats` bottom-to-top. `PaneId`, `SplitId`, and `TabId` are branded strings: only a `Mint` (or the kit's own DOM round trip) produces one, so a pane, a split, and a tab never stand in for one another or for a bare string. A floating panel is not a second concept — it is a pane whose `host` is `'float'`, capacity one tab, drawn without a tab strip.
- `applyOp(state, op)` returns the next state **and the operations that undo it**. Inverses are captured when an operation runs, because by undo time the pre-operation state is gone.
- Every operation carries the ids it creates, so `replay(initial, ops)` reproduces the same tree. The engine reads no clock and no random source.
- `Sequencer` keeps a linear history with one entry per intent: the operations one gesture or command produced step back and forward together, a run of consecutive focus-only entries steps as one, and a new entry after stepping back drops the forward branch.
- `planSettle` is the opt-in rule that keeps every docked pane populated after an intent: panes an intent emptied are merged away, and an emptied root pane is reseeded through the embedder's factory — withholding the factory keeps the merge and leaves the root pane empty. An embedder that wants empty panes simply does not call it, or calls it without a factory. `planDropTab` takes the same factory: with one, a sole tab released on its own pane's edge splits and the factory's tab backfills the pane it vacates (the dragged tab stays focused); without one that release changes nothing.
- `DockController` is the intent layer and an observable source (`subscribe` + `getSnapshot`, whose reference only changes when the layout does).

**The components** render a layout snapshot and report settled intents — one per gesture, never a drag frame. A drag previews in local state while the gesture's own facts stay in its closure; on release the net result leaves through one `DockIntents` call — a strip release reports the caret slot as drawn, the dragged chip counted, and `planPlaceTab` turns that into the reorder or the move. That is what lets an embedder record exactly one history entry per gesture. The strip follows the WAI-ARIA tabs pattern with manual activation: the selected chip is in the tab order; Left and Right (wrapping), Home, and End move focus between chips without selecting; Enter or Space selects the focused chip through the same intent as a click. A chip is a capsule carrying one control, its close; the context menu (a secondary press on the chip) carries the same close plus the embedder's items — a menu that would hold no item at all never shows — and renders in a portal positioned against the chip because the chip box clips its overflow on purpose (see below). After the chips sits the add control, which asks the embedder (`DockIntents.addTab`) to seat its seeded tab; the embedder's `canAddTab(paneId)` decides per pane whether the control is drawn at all. Copying a tab has no kit control — it is the embedder's API — and floating is the drag released clear of the surface.

<a id="embedding-it"></a>
## Embedding it

Everything host-specific arrives through props:

| Contract | Carries |
|---|---|
| `DockLabels` | every rendered string, already localized, accessible names included |
| `TabRenderer` | one tab's body (`renderTab`), drawn flush to the pane's edges and the unbordered strip's bottom edge with the insets it chooses, and optionally what its chip or panel header shows as a title (`renderTabTitle`, falling back to the record's `title`); the embedder dispatches on `tab.kind` |
| `DockIntents` | the settled results of every gesture |

`DockController` satisfies `DockIntents` as written, so the simplest embedding hands the controller straight to `DockSurface`. An embedder that routes through its own store implements the same method names instead. Three props carry control policy rather than gestures: `canSplit` (surface-wide, the pane budget; disables the split control with `splitPaneDisabled`), `canAddTab(paneId)` (per pane, omits the add control; leave it out to draw one in every pane), and `canCloseTab(tabId)` (per tab, withholds the chip's close control and the menu's close item together; leave it out to keep every tab closable). Hiding the add control moves nothing else in the strip, and a withheld close moves nothing in the chip — the close control paints over the title's end rather than beside it. A pane's lone chip whose close is withheld draws quiet — no capsule, no hover fill — since there is nothing to select against and nothing to do to it. The kit adds one policy of its own, the room rule below, which disables a pane's split control with `splitPaneNarrow`; `onRoom(fits)` reports its readings so an embedder splitting programmatically can honour the same rule.

`dropZones="horizontal"` offers two half-pane hints; once budget or width forbids another split, the whole body accepts a move. A hint is a dashed card inset 8px inside its region, showing the zone's glyph and `labels.dropZone[zone]`; the preview layer covers all tab-body content, while the card under the pointer takes the accent and its neighbour stays a quiet outline. `minPaneFraction` sets the preview minimum, and `planResizeSplit` accepts the same minimum for the committed operation. The Sidebar uses 0.2 and enforces two panes in its own store. The generic engine retains its tree and other split directions. `hideSplitWhenBlocked` hides a blocked split control — pane budget spent or pane too narrow — instead of rendering it disabled; its default is false.

A tab's `kind` is an opaque string. Seeded tabs are factories (`DockControllerOptions`), so what a fresh pane contains is the embedder's decision, not this package's. Content identity is the pair (`kind`, `contentId`): `findContentTab(state, contentId, kind?)` finds the tab showing it anywhere and `findPaneContentTab(state, paneId, contentId, kind?)` within one pane, and `planOpenContent` focuses that tab instead of opening another unless told `revealIfOpened: false`; an explicit `index` seats a new tab at a strip slot rather than at the end.

`DockSurface` is the docked area. Chrome around it — a rail, a collapsed presentation, any history controls — belongs to the embedder, which reads `state.expanded` and decides; the kit ships no undo/redo control of its own. Surface-wide controls the embedder does want on the surface go through the `chrome` prop, which the kit places at the far end of the top-right pane's tab strip (the last child of every row split, the first of every column split), so a surface needs no header row of its own. `FloatLayer` owns its own gestures and positions panels in viewport coordinates, so it may be mounted anywhere, including a portal.

<a id="interaction-rules-worth-keeping"></a>
## Interaction rules worth keeping

These are not stylistic; each one fixes a defect found in a real browser.

- **Capture the pointer** when a gesture starts. Without it any scroll container the pointer crosses can claim the gesture, which the browser reports as a cancelled pointer and an abandoned drag. Capture is hardening — the window listeners carry the gesture either way, so an environment without the API still works.
- **The chips give way; the strip's end controls never do.** The chip box is the strip's one shrinking part (`flex: 0 1 auto; min-width: 0; overflow-x: auto`): chips shrink down to an 80px floor and then scroll on the wheel with no scrollbar drawn, and the box fades its chips out over 24px at each side that hides some (`data-dockkit-strip-scroll`, written from the box's scroll reading after each commit, scroll, and resize). Whenever the active tab or the row of chips changes, the box scrolls so the active chip stands clear of the fade band; a chip already in view moves nothing. A chip's title is never ellipsized: `TabTitle` reads its text against its box and sets `data-dockkit-tab-clipped` while the text is wider, which fades the text out over its last 16px. A chip's close control shows while the chip is active, hovered, or holds focus, over the title's last 14px, which fade under it, so the chip is the same width either way. The two slots beside the active chip draw no hairline, so the filled capsule stands between bare chips. The add, split, and chrome controls are `flex: none`, so they keep their width and place in any pane at least as wide as they are (about 130px with the chrome, 72px without). The surface's `min-width: 0` and the pane's `overflow: hidden` stop a body's longest unwrapped line from widening the pane past its box, which is what carried the controls and the body's scrollbar off-screen.
- **The chip box scrolls, but never claims a gesture.** A horizontal scroller would take press-and-move for itself and cancel the pointer; the box, the chips, and the strip set `touch-action: none` and the gesture captures the pointer, so a press-and-move on a chip is a drag and only the wheel scrolls the box.
- **A split needs room for two working halves.** A pane splits into equal halves, so each half must hold what cannot shrink: the strip's fixed part — measured as the strip's width minus the chip box and the fill, which is the padding, the gaps, and every control that pane draws (its own chrome included, so the top-right pane asks more) — plus one chip at its minimum — `.tab` declares `min-width: 80px` on a content-box, so its footprint is 80px plus 10px + 10px of padding, 100px, read from a rendered chip's computed style (the stylesheet figure when none can be read); the divider between the halves takes its rendered thickness (0 — its hairline paints over the seam without taking layout room, so a body's own rules run unbroken past it). A column split, which only an edge drop makes, needs each half to hold the strip (34px) plus a 48px body: one 13px secondary line at 1.6 line-height inside 12px of the body's own insets — the pane body itself is unpadded, so a tab's body reaches the strip's bottom edge and the pane's edges and draws its own. `halvesFit` in `geometry.ts` is the arithmetic; `measure.ts` reads the rectangles after every commit and whenever the surface resizes, because the layout state carries fractions, never pixels, and the engine's planners stay that way. A pane without room keeps its split control, disabled with `splitPaneNarrow` (hidden instead under `hideSplitWhenBlocked`), and offers no edge drop zone for that axis (the release is then not a move). Under `hideSplitWhenBlocked` the split control's own footprint — its box plus the strip's gap — is left out of the fixed part: hiding the control sheds exactly that footprint from the strip, so a reading that counted it would flip with the control's visibility and re-render forever; leaving it out is also what the half being asked about would carry, since a half too narrow to split hides its own control. A pane the user narrows afterwards — a divider or the embedder's column dragged — keeps its size: the rule only decides its next split.
- **Focus lands on click, not on press.** A state change between `pointerdown` and the first `pointermove` rebuilds the pressed subtree, and a replaced element cancels the pointer. It also keeps a drag from recording a redundant focus operation first. Clicks on the chips, the strip's controls, and the embedder's chrome stop at the strip: the intent each reports already decides the active pane, or is the embedder's own, so the pane's click-to-focus records nothing extra. A floating panel's grip and corner report through their gesture the same way — a press released in place is a click that raises the panel, and a drag records only the move or resize, whose operation raises it — while a press on the panel's body raises it directly. A click on the pane that is active already, a click or key on that pane's selected chip, or a press on the panel that is active and on top already, changes nothing and records nothing.
- **A control nested inside a draggable chip stops its own press.** Otherwise the press starts a drag, captures the pointer, and the nested control's click never lands.
- **Emphasis takes the platform's accent, never `--dsw-alias-brand-primary`.** This platform binds `brand-primary` to its near-black (light) or near-white (dark) foreground, so the drop caret and the drop-zone hint use `--dsw-alias-brand-primary-new-colorprimary-new-color`, as the trajectory views do; a hovered divider takes the caption label ink instead, reading as a handle rather than a highlight. A floating panel draws no border — the menu's shadow (`--dsw-elevation-prominent`) outlines it — and the active panel gets no heavier frame: it is already on top and casts the same shadow; a darker frame around it read as a defect.

<a id="build-shape"></a>
## Build shape

The package is statically linked: tsdown's `staticLinked` preset emits one browser ESM bundle at `lib/index.js` (every bare specifier stays an import, sourcemaps chain to the sources) and ships the stylesheet under `lib/` at its `src`-relative path, and the Web shell resolves the package name and bundles that artifact itself, so vite stays the only owner of class hashing. One consequence is load-bearing — the kit keeps **one** stylesheet, `dockkit.module.css`, because a consumer de-duplicates injected sheets by file name and a collision would drop one silently.

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side docking layout engine and component set that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Size semantics are deliberately small**: fractional weights with one minimum-size clamp. No snap, priority, or preferred size, so the cascading-squeeze behaviour of a full splitview is absent.
- **Touch is untuned.** Gestures are pointer-based and `touch-action` is set where a scroller would otherwise interfere, but no touch-specific tuning has been done.
- **Accessibility is incomplete**: no `separator` role on dividers and no keyboard route to split, move, or float.
- **No published stylesheet contract.** Consumers get hashed module class names; the kit exposes no theming API beyond the `--dsw-*` custom properties it reads.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The engine is pure functions over plain data and the components report intents only; the operation sequence's invertibility and the settle rule are asserted directly by this package's engine specs, and no cordis service is provided or observed.
