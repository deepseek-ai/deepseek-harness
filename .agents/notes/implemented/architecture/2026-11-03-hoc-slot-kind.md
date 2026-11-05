# Agent Note: Add the `hoc` slot kind so plugins can wrap owner content in layers

Status: implemented

English | [中文](2026-11-03-hoc-slot-kind.zh.md)

## Problem

The home whale plays when blank space is clicked. Its canvas must paint below the content, and `.scrollBody` fills the whole body, so the canvas itself never receives clicks; only an ancestor of the content does.

No existing slot kind lets a plugin become an ancestor of the content:

| Kind | Behavior | Why it is not enough |
|---|---|---|
| `single` / `list` / `keyed` | Render the occupant at an owner-chosen position | The occupant is a sibling of the content |
| `chain` | The elected entry replaces the fallback; with `overlay` it renders beside the fallback | It does not wrap |
| Factory local slot | The caller replaces a local Component per occurrence | Only the caller chooses; plugins cannot stack |

The previous approach had the Conversation classify blank clicks on its body and notify the background plugin through `onBlankClick(listener) => dispose`. The Conversation thereby maintained click classification and subscription forwarding that served only a decorative plugin.

## Decision

Add a fifth kind: `hoc`.

| Item | Contract |
|---|---|
| Declaration | The parent entry's `children` lists `{ kind: 'hoc', scope }`; `SlotMap` declares `kind: 'hoc'` |
| Rendering | `renderSlot(key, owner, { children })`; `entryKey` / `only` / `fallback` / `hookContext` are unavailable; omitted `children` renders the layers around nothing |
| Registration | Same as `list`: required `id`, optional `order` and `priority`; the same `id` at the same `priority` throws, a different `priority` shadows |
| Nesting order | Ascending `order`, then `priority`, then registration order; lowest outermost |
| Layer props | Every layer receives the same owner props plus the framework-supplied `children` (the next inner layer; the innermost is the owner content); `children` is not an owner prop, `HocShare` types it, and owner props must not use that name |
| Layer obligation | Render `children` exactly once without creating a box of its own; do not change the props passed inward |
| No entry | `children` renders unchanged |
| Layer crash | Each layer has its own error boundary; a crashed layer renders its `children` and abdicates, so the next render omits it |
| Content error | An error thrown by the wrapped content passes every layer as its original error and is reported against no layer |
| Remounting | Adding or removing a layer remounts the content inside it; a `session` or `session-maybe` layer also remounts it when its Session binding changes |

### Implementation

| Package | Realization |
|---|---|
| `ui-slots` | `SlotKind` includes `'hoc'`; `HocRenderOpts`, `HocKeysOf`, `HocShare`; `RenderSlotFn` has a hoc-key overload taking optional `{ children }`; `KindOptions` has a hoc branch; `SlotCore.register` / `entriesOfSlot` key hoc cells by `id` |
| `ui-renderer` | `HocOutlet` calls `composeHocLayers` when the slot's ledger version or declaration changes (`useMemo` on the outlet instance) and nests the layers into one render function. Each layer is one Component that fixes its scope-specific Entry (`StrictSessionEntry` / `SessionMaybeEntry` / `RootEntry`), entry, slot inject, and crash reporting at composition, and receives only `owner` and the next inner layer when rendering. With no layer the outlet returns the owner content directly. `HocContentBoundary` wraps each layer's inner content and rethrows its errors as `HocContentError`, which layer boundaries pass through and `HocOutletBoundary` unwraps to the original error. The Entry chain passes `children` to the registered Component as JSX children; non-hoc entries receive `undefined`. `SlotErrorBoundary` takes a `crashed` replacement node |
| `scripts/gen-client-catalog.ts` | Register options, a `children`-rendering example, and the `wraps-owner-content` replace risk for hoc slots |

### First consumer

| Location | Realization |
|---|---|
| `ui-conversation` | `conversation.hero.frame` (hoc, root) with owner props `{ hero: boolean }` wraps `.scrollBody` in every phase, so the composer does not remount when the home ends. On the home (`.root[data-phase='hero']`), the Conversation root, which paints the background, sets `isolation: isolate` as part of the frame contract, so layer decorations at negative `z-index` paint above that background and below all Conversation content. The Conversation performs no click classification for its layers |
| `ui-brand-official` | `PixelWhale` is a frame layer: a React `onClick` on a `display: contents` frame plays the whale for primary clicks on blank space, excluding portaled overlays (`currentTarget.contains(target)`), controls (a selector), and clicks that end a text selection inside the frame. While `hero` is true it paints a canvas at negative `z-index`. The frame atlas loads through the package asset route; the renderer returns `{ play, dispose }` |

## Alternatives considered

- `onBlankClick` subscription forwarding: the Conversation owns click classification that serves only a decorative plugin.
- Canvas below with `pointer-events: none` on `.scrollBody`: blank space cannot scroll when the home overflows.
- A canvas with no `z-index`: it needs no stacking context, but it paints over every unpositioned Conversation content outside the `z-index: 1` home composer stack, such as composer takeovers, and depends on that unrelated rule.
- A layer box that establishes the stacking context itself: the layer has to mirror the body's flex column layout.
- A separate `renderNestedSlot` or a JSX `<HocSlot>` component: one more set of bindings; `hookContext` already shows that `renderSlot` can constrain its third argument per key.
- Precompiling every slot kind per ledger version: no measurable end-to-end time difference, see #7838.

## Consequences

- Adding or removing a layer remounts everything inside it, including the composer on the home.
- Every non-hoc registered Component receives `children: undefined`, which overrides any owner prop of that name.
- Each layer adds one Component and two error boundaries to the tree; each hoc slot with layers adds one outlet boundary.
- The outlet's `[data-slot]` element sits between the owner and its content, so owner selectors cannot assume the content is a direct child.
- React 18 recollects the component stack where an error is rethrown, so a content error reaching boundaries above a hoc slot with layers carries a component stack that starts at `HocOutletBoundary`.
- A layer that wraps its `children` in its own error boundary catches the internal `HocContentError` rather than the original content error.
- The frame contract holds only on the home: other phases leave the Conversation root out of the stacking order, so unportaled Conversation popovers still rise above AppFrame chrome that floats over the column, while on the home they stack only within the root.
- `HocOutlet` keeps its layer Components through `useMemo`, as Factory local Components keep theirs; if React ever discards memoized values, both need an explicit cache, because these Components are the remount boundary of the content inside them.
- [The slot system standard](2026-07-22-slot-type-chain-implementation.md) remains authoritative for the other kinds; this note adds the fifth.
