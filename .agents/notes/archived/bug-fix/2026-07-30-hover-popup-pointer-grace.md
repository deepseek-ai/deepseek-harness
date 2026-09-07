# Agent Note: Hover popup pointer grace

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-30-hover-popup-pointer-grace.zh.md)

## Problem

Both popups the workspace browser rows raise floated out of reach of the pointer. `HoverCard` closed on the first `pointerleave` from its anchor and rendered its card `pointer-events: none`, but the card sits 8px off the anchor's right edge, so every path to it crossed ground belonging to neither and killed the card before it arrived — the full workspace path and session title it exists to show could be read only in passing. The row action menus passed `closeOnPointerLeave`, whose handler sat on the portaled list: aiming back at the `...` trigger that opened the list closed it, and so did any overshoot past a list edge, with no window to come back.

## Decision

`usePointerGrace` ([packages/client/ui-primitives/src/pointer-grace.ts](../../../../packages/client/ui-primitives/src/pointer-grace.ts)) owns one cancelable delayed close, shared by both atoms, with `POINTER_GRACE_MS` at 200. Leaving arms the close; coming back cancels it. Transit through an anchor-to-popup gap is therefore survivable, while a pointer that has genuinely moved on still dismisses the popup.

`HoverCard` arms the grace on leave instead of closing, and its card no longer sets `pointer-events: none`, so resting on the card holds it open. Re-entering while already open cancels the pending close without restarting the dwell, which keeps the card from blinking when the pointer crosses the gap. A press on the card starts a selection instead of dismissing it; only anchor-region presses and an owner flipping `disabled` dismiss immediately, ahead of the grace.

`Menu` moves pointer-leave dismissal from the portaled list to the wrapper span. React's enter/leave traversal runs over the React tree, so the trigger and the portaled list are one region there: crossing the 4px gap between them, or aiming back at the trigger, no longer counts as leaving. Leaving is only armed while the list is open, and an owner-driven close (selection, Escape, outside click) disarms a pending grace close in an effect keyed on `open` alone — folding that into the outside-click effect would cancel the grace on every re-render, since owners pass a fresh `onClose` closure each time.

## Alternatives considered

**Close the popups only on outside click and Escape.** Rejected because both popups are hover-raised and unlabeled as dismissible; leaving them up after the pointer has moved to another row would strand a card over unrelated content.

**Widen the anchor's hit area to abut the popup.** Rejected because the 8px and 4px offsets are the design's, and an invisible bridge element would have to track every reposition the fixed-positioned popups already do on scroll and resize.

**Keep the hover card `pointer-events: none` and only add the grace.** Rejected because the pointer resting on the card would then hit whatever is behind it, so the grace would expire and close the card the user had just reached.

**Give each atom its own timer.** Rejected because the two closes are the same behavior with the same tuning; a shared hook keeps them from drifting apart.

## Consequences

The hover card is now hit-testable and covers 244px of whatever it overlays while shown, which is the price of being reachable; it still lives only as long as the pointer is on the row or the card. Row menus survive the round trip between trigger and list, and a menu that closes for its own reason cannot be reopened into a stale pending close. Menus without `closeOnPointerLeave` are untouched — the wrapper handlers are only attached when it is set.

## Testing

`packages/client/ui-primitives/tests/hover-card.client.spec.tsx` and `tests/atoms.spec.tsx` pin the grace boundary, cancel-on-return, no-second-dwell, disarm-on-owner-close, and the no-arming-while-closed case. The reachability gestures themselves — hovering onto the card, and moving between an open list and its trigger — are pinned in the real browser by `apps/web/tests/workspace-management.e2e.ts`, since they depend on hit testing and layout that jsdom does not model.
