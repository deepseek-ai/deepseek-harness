# Agent Note: The conversation column reserves one scrollbar gutter for every view

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-04-composer-tab-gutter-reservation.zh.md)

## Problem

The composer seat is one node in one place in the tree, and it was laid out against a different edge depending on which view tab was shown.

In Chat it is a sticky CHILD of the column's scroller (`[data-conversation-scroll]`), so it rides that scroller's content box — the box a space-consuming scrollbar shortens by the bar's width. A view that declares `data-conversation-composer-overlay`, which Trajectory does, moves the column's scrolling into the view itself: the branch keyed on that attribute left the scroller `overflow: hidden` and positioned the seat absolutely, against the padding box, which no scrollbar reduces.

So for as long as the transcript overflowed — the ordinary state of any session with history — the two tabs disagreed by exactly the bar's width. The input card is centred, so switching tabs moved it 4px sideways on an 8px bar, and its right-hand clearance changed by the full 8. The same displacement appeared inside Chat alone at the moment a growing transcript started to scroll, and again between the hero phase and the first scrolling turn.

## Decision

`.scrollBody` declares `scrollbar-gutter: stable` for the Chat state, and the overlay branch overrides it with `scrollbar-gutter: auto` while staying a scroll container on both axes — `overflow-x: hidden; overflow-y: auto`. The reservation is Chat's alone: it holds the seat's content box at the same width whether or not the transcript overflows, so the card never jumps as a growing transcript starts to scroll, nor between the hero phase and the first scrolling turn. The overlay branch reserves nothing — the view owns its own scrollers, so a gutter there would only narrow the view's content — and its seat compensates for the bar instead ([the seat-width compensation](2026-08-12-composer-overlay-seat-width-compensation.md)).

`stable` rather than `auto` because `auto` reserves only while the box actually overflows, and the difference between overflowing and not is precisely the difference between Chat's two phases — an `auto` gutter would state the bug rather than fix it.

The reservation lives on an `overflow-y: auto` box, and that form is load-bearing: WebKit applies `scrollbar-gutter` to an `overflow-y: auto` box and ignores it on a hidden one — measured on this app's own composer layers and recorded in [the composer scrollport note](../../archived/bug-fix/2026-07-31-composer-text-layers-share-one-scrollport.md) — so a reservation on a hidden box would hold in Chromium and silently not in Safari. The overlay branch keeps its `overflow-y: auto` form too, as a clipping box nothing scrolls out of: a single-axis scroller computes the other axis to `auto`, so the horizontal axis is declared `hidden` rather than left to compute, and would otherwise grow a horizontal scrollbar of its own the first time a view's content reached past the column.

The reservation is worth what it costs only because the bar takes layout space here at all, which is not the browser's default behavior but this client's: `::-webkit-scrollbar` carries a width in ui-theme's sheet ([themed scrollbars](2026-07-28-themed-scrollbars-and-reserved-gutter.md)), and the sidebar's session list already reserves its own gutter for the same reason.

## Alternatives considered

**Inset the overlay seat by the bar's width.** The narrow reading of the bug — the two states differ by 8px, so subtract 8px from one. Rejected because the number is the engine's, not ours: the WebKit path draws the sheet's 8px bar, the Firefox path draws whatever `scrollbar-width: thin` resolves to, and a hardcoded inset would line the two states up in Chromium while drifting everywhere else. The gutter asks the engine to reserve its own bar's width, whatever that is.

**Keep `overflow: hidden` and add `scrollbar-gutter: stable` alone.** The one-line version. It fixes the visible symptom on the engine the browser lane runs, and leaves it in place on Safari, with no test failing anywhere — the failure mode the second half of the change exists to prevent.

**Move the composer seat out of the scroller in Chat too, making the overlay geometry the only geometry.** This deletes the difference at its root rather than reconciling it, and gives up a deliberate property: the sticky seat sits inside the scroll flow, so a wheel over the composer moves the transcript ([sticky composer](2026-07-29-sticky-composer-conversation-scroll.md)), and the fade mask above it is painted by the seat's own background. Both are owned behavior with their own coverage; rebuilding them to remove 8px of asymmetry is the larger change, not the smaller one.

**Pad the column by the bar's width instead of reserving a gutter.** Padding applies whether or not a bar is present, so it costs the width unconditionally in every state, and it pins a value in the stylesheet that the engine picks at layout time. Rejected for the same reason the sidebar list rejected it.

## Consequences

- Chat's content column is permanently 8px narrower — in the hero phase and while the transcript is short as well, where no bar is drawn. That is the trade: one card position at every content height, instead of the widest possible column.
- The card holds one position across three transitions, by two mechanisms: the reservation keeps Chat's seat at one width across its own phases (short ↔ scrolling transcript, hero ↔ first scrolling turn), and the overlay seat's compensation matches it on the Chat ↔ Trajectory transition ([the seat-width compensation](2026-08-12-composer-overlay-seat-width-compensation.md)).
- The overlay state is now a scroll container. No shipped content can overflow it; a future view that let its content exceed the column would scroll this box instead of clipping, and would need its own clip the way the Trajectory view already has one.
- The committed golden records the reserved band, so a change to the sheet's `::-webkit-scrollbar` width — the value that decides how wide the reservation is — arrives as a reviewable diff in this scenario as well as in the sidebar's.

## Testing

`apps/web/tests/composer-tab-geometry.e2e.ts` measures the input card's rectangle in both tabs, at a viewport where the card sits at its width cap and one where it shrinks with the column, and asserts the two rectangles are the same rectangle. Only a real engine reports this: jsdom gives every element a zero-sized box and no scrollbar, so a unit spec could assert the declarations exist but not that the two states land in the same place. For the same reason no CSS-text spec accompanies it — it would restate the declarations without adding a fact the browser lane does not already establish.

The scenario launches chromium without Playwright's default `--hide-scrollbars`, which is load-bearing: under that argument a bar consumes no layout width, so the tabs agree with and without the compensation and every comparison in the file holds vacuously. Measured, both bands sit at 0 under the argument and at 8 and 0 with it dropped.

The uncompensated cascade is then applied in the page — the overlay seat's `right` compensation dropped to 0 via `!important`, Chat's reservation untouched — and the same two tabs measured through it, which is what separates a card that does not move from a tab switch that never reached the layout. It reproduces the reported symptom as a number: 4px on each edge, half the 8px band. The golden records that control beside the fixed state, so the fixture carries the difference the change removes rather than only its absence.
