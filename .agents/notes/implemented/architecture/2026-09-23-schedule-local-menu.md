# Agent Note: Own the Schedule detail menus inside the Schedule client

Status: implemented

English | [中文](2026-09-23-schedule-local-menu.zh.md)

## Problem

The Automation tasks detail needs a menu whose list carries a pinned control: the Time zone row's search field must stay above the scrolling zone rows. The shared `Menu` in `@deepseek-ai/dsh-client-ui-primitives` renders rows, separators, labels, a selection mark, and a keyboard walk, but it has no header slot. The Delivery records tab shows a saved record's message id behind an info glyph, and the reader must be able to read and copy that id.

Serving either need by extending `ui-primitives` puts one feature's behavior into the package every client plugin consumes. The same branch had already removed unrelated `ui-layout` and `ui-sidebar-right` edits after review asked why a Schedule change touched them, and a shared primitive extended for a single caller still costs every future reader of that primitive.

## Decision

`packages/client/ui-schedule` owns its menu. `src/client/TaskMenu.tsx` with `TaskMenu.module.css` holds a schedule-local copy that renders rows, separators, labels, disabled and destructive rows, a trailing `selectedId` mark, the pointer and keyboard walk, portaled placement, the pinned `header` slot, and the `data-menu-field` focus handover. It imports the shared `useAnchoredPosition` and `useDismissOnOutsidePointer` hooks, which are the placement and dismissal behavior any anchored panel needs, and it imports no runtime value from `ui-primitives`. The four detail menus use it.

The Delivery records tab names and copies a record's message id through an info button. The button's accessible name states the action and the record (`Copy message ID: <id>`), the shared `Tooltip` states the id on hover and on keyboard focus, and activation copies it through the shared `writeClipboard` helper and reports `Copied` in a status region beside the glyph. `Tooltip` therefore keeps its master shape: the mode that held one bubble open under the pointer is gone, and the Delivery records view does not use the `HoverCard` that opens on the pointer alone.

`packages/client/ui-primitives` returns to master except the clock glyph's stroke. The client bundle purity gate in `packages/client/tsdown.client.ts` is the neighboring rule for the other direction of this boundary: a client plugin may import another plugin's package only as types or as a module-table request, so shared runtime vocabulary travels through an inline-safe layer or a cordis service rather than a package edge.

## Alternatives considered

**Add a `header` prop to the shared `Menu`.** This is what the branch first did: an optional slot plus the `data-menu-field` focus handover, with tests in the shared package. It gives the smallest diff and keeps one menu implementation, and it was rejected because the only caller is the Schedule detail: `ui-primitives` would carry API that exists for one feature, and every client plugin's bundle would read a header contract none of them use.

**Add an `interactive` mode to the shared `Tooltip`.** Shipped first and then removed: a grace period between anchor and bubble, pointer hold, click toggling, and selectable text, with six tests. It lost because the shared tooltip already opens on focus and the shared clipboard helper already performs the copy, so the mode added a second way to hold one bubble open for a single caller.

**Name and copy the message id through `HoverCard`.** Shipped second and then replaced: the card holds while the pointer rests on it, selects its text, and copies on activation. It lost because `HoverCard` opens on `onPointerEnter` alone, so the already-focusable glyph showed a keyboard reader nothing and offered no copy path.

**Render the zone search field outside the menu list.** A search input above the trigger, or a separate row in the rule card, needs no primitive change. It was rejected because the field would scroll away from the list it filters or sit in a different surface than the rows it filters.

**Build the zone picker on the schedule-local `PickerPopover`.** The Date and Time pickers already use that panel, so the zone list could reuse it. It was rejected because `PickerPopover` positions and dismisses a panel but renders no list semantics: the keyboard walk, the row roles, and the selected-row mark would have to be rebuilt inside the Schedule client anyway, which is the copy this note describes with more surface than the menu it replaces.

## Consequences

The Schedule client carries a second menu implementation: 346 lines of component, 189 lines of CSS, and 403 lines of tests, in exchange for `ui-primitives` returning to master except the clock glyph's stroke. The copy is trimmed to what the detail uses, and the absent capabilities stay absent: submenus, component-rendered rows, a pinned footer, multiple selection ids, the fill selection mode, dense and compact spacing, mount-time autofocus, a caller-supplied anchor rect, pointer-leave closing, and a side parameter. A later Schedule menu that needs one of them extends the copy or revisits this decision.

Copying is an activation, not a text selection: the tooltip shows the id but does not accept the pointer, so the desktop gesture that copies the id is a click on the glyph. That is the capability the removed interactive mode had and this shape gives up. Shared behavior stays shared: placement, dismissal, focus handover, the duplication gate's exclusion markers naming both owners, and per-file coverage all apply to the copy. The copied region carries `jscpd:ignore-start` and `jscpd:ignore-end` with the two owners named, following the [cross-package value dependencies note](../../archived/process/2026-08-23-client-cross-package-value-dependencies.md); the schedule-specific header, handover, and Tab semantics sit outside that region.

The copy places its list with `useAnchoredPosition`, which clamps every edge by the same 12px margin, while the shared menu's top edge used the frame-top clearance helper. A list that must clamp upward against the top of a macOS window can therefore sit about 12px lower than the shared menu did in the same situation; the stylesheet still reserves the clearance for the list's own maximum height, so the common case is unchanged.

## Testing

`packages/client/ui-schedule/tests/task-menu.client.spec.tsx` pins the pointer and keyboard walk, the `header` field's Home/End ownership, the `data-menu-field` handover after placement, the selected-row mark, disabled rows, portal placement, outside dismissal, and focus return; the three menu-header tests that lived in `ui-primitives` moved there with the capability. `delivery-history.client.spec.tsx` pins the tooltip that keyboard focus raises, the button's accessible name, the clipboard write, and the copy confirmation that clears. The coverage gate reports 100% per file for `packages/client/ui-schedule/src`, and the duplication gate reports no clones across `packages/client/ui-schedule` and `packages/client/ui-primitives`.
