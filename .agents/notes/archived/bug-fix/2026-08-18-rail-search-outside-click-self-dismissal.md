# Agent Note: Rail search keeps its expansion when the opening click reaches document

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-18-rail-search-outside-click-self-dismissal.zh.md)

## Problem

The collapsed sidebar's rail search button arms the rail gesture (`searchOnExpand`), expands the search affordance (`searchExpanded`), and requests sidebar expansion — designed to land the user in a focused search input once the column slides open. In a real browser the gesture never completed: the sidebar expanded but the search box stayed closed and unfocused.

The initiating click destroys its own effect. React dispatches the rail button's handler mid-bubble; the state flip renders the wide header and mounts the WorkspaceBrowser's outside-click dismissal listener on `document` during that same dispatch. The click then keeps bubbling and reaches `document` with the now-unmounted rail button as its target — outside `searchRoot` — so the freshly mounted listener immediately collapses the search it was opening. The package test missed this because `fireEvent.click` on the button does not re-bubble through listeners mounted during dispatch the way a real browser event does.

## Decision

The outside-click dismissal listener does not mount while the rail gesture is in flight: its effect returns early while `searchOnExpand` is set, and `searchOnExpand` already ends exactly when the gesture settles (focus lands in the input after the column slide). After settle, outside clicks dismiss the search as before. A regression test replays the real-browser order — rail click, wide flip, then the same click arriving at `document` — and requires the search to stay expanded through it and to dismiss on the next genuine outside click.

## Alternatives considered

**Stop propagation on the rail button's click.** Suppressing bubbling at the initiator couples the rail button to a listener it cannot see, and every other expansion path — a future keyboard shortcut, another rail entry — would reintroduce the bug. The listener owns dismissal, so the listener carries the guard.

**Defer listener attachment by a frame or timeout.** A raw delay encodes the symptom (the click arrives "too early") instead of the cause (a gesture is in flight). `searchOnExpand` is already the explicit in-flight state with the correct end point; a frame boundary is neither.

**Dismiss on `pointerdown` instead of `click`.** The initiating gesture's `pointerdown` precedes the listener mount, so it cannot self-dismiss. Rejected because it changes dismissal semantics for every interaction — a drag or a press-and-slide-away would dismiss where a completed click does not — to fix a problem scoped to one gesture.

## Consequences

The rail search gesture works end to end in the assembled application, pinned by an `apps/web` real-browser scenario: a real click travels through the collapsed rail, the wide flip, and the document-level bubble, and the search stays expanded with focus landing in the input. During the in-flight window (~300 ms column slide) an outside click does not dismiss the search; that window ends the moment focus lands. The package-level regression test additionally pins the guard's timing at the unit level.
