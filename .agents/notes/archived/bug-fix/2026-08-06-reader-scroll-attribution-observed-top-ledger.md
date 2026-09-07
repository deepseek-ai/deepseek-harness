# Agent Note: Reader scroll attribution through the observed-top ledger

Status: implemented
Archived: 2026-09-04

English | [中文](2026-08-06-reader-scroll-attribution-observed-top-ledger.zh.md)

## Problem

ChatView's bottom-follow recognized only wheel/trackpad gestures as reader input: while pinned to the floor, a scroll event without matching wheel movement was treated as programmatic and snapped back. Touch panning, native-scrollbar dragging, and keyboard paging therefore could not leave the bottom of a streaming transcript — on a phone the tail was effectively locked. That wheel-only input classification was a deliberate deferral in the [sticky-composer note](2026-07-29-sticky-composer-conversation-scroll.md), which rejected a general input state machine "for this narrow fix" and left every other scroll source outside the model.

## Decision

Reader input is no longer identified by device. ChatView keeps an observed-top ledger (`observedTopRef`): the last `scrollTop` either delivered on the main thread or written by the component, recorded synchronously at every programmatic write site — bottom follow, open restore, prepend anchoring, resize follow, and scroll delivery itself. When a scroll event arrives, a position that deviates from `min(ledger, floor)` by more than half a pixel is reader input; a position on the ledger (a delayed programmatic delivery) or exactly on the shrunken floor (a browser clamp after content shrank) preserves the current ownership state. Ownership then changes only through reader input under the existing threshold rule: within `FOLLOW_THRESHOLD` of the floor re-pins, beyond it releases follow and shows Back to bottom. The wheel listener and its epoch bookkeeping are deleted; the component listens to `scroll` alone, so wheel, touch, scrollbar, keyboard, and any future input source are covered by one rule.

## Contract change: coalesced shrink-plus-regrow clamps

A shrink clamp whose layout regrows within the same rendering update before the clamp's scroll event is delivered is geometrically indistinguishable from reader input, so it now reads as the reader and releases follow (Back to bottom recovers). Realistic React-commit-driven shrink and regrow is still absorbed: the layout-effect follow re-pins and re-records the ledger per commit, and a shrink-only clamp lands exactly on `min(ledger, floor)`. Only a non-React reflow that shrinks and regrows inside one update mis-attributes. The previous wheel model kept following in that raced case; the unit contract was rewritten to the absorbed-shrink-only guarantee in the same change.

## Testing

Unit specs in `packages/client/ui-chat/tests/chat-view.client.spec.tsx` pin the ledger contract directly: a `readerScroll` helper delivers a position the component never wrote, programmatic deliveries land on the ledger, and the stream-finalization shrink clamp keeps following. Two scenarios in `apps/web/tests/chat-scroll-contract.e2e.ts` extend the [browser e2e lane](../testing/2026-07-24-web-gui-browser-e2e-lane.md): keyboard paging over a settled transcript and a touch-style momentum fling against paced streaming, both red under the wheel-only implementation and green under the ledger.

The lane's Chromium cannot synthesize any non-wheel device scrolling, which bounds what the e2e can drive for real: `Input.synthesizeScrollGesture` with a touch source and hand-rolled `Input.dispatchTouchEvent` sequences deliver DOM events but never move a scroller (headless and headed-under-Xvfb alike); the `default` gesture source synthesizes wheel events; and compositor scrollbars ignore synthetic mouse input entirely, with a gutter visible only when `--hide-scrollbars` is removed. Keyboard is the one working non-wheel primitive, so it carries the real-input-pipeline proof, and the fling scenario replays touch's signature — per-frame decaying displacements the component never authored — through the scrollport directly.

## Alternatives considered

**Keep the wheel-only model.** Rejected: it is the defect. Touch, scrollbar, and keyboard readers cannot take ownership away from a streaming tail, and each newly supported device would need its own carve-out.

**Enumerate input devices.** Adding `touchstart`/`pointerdown`/`keydown` listeners beside the wheel epoch was the obvious extension. Rejected: native-scrollbar dragging exposes no input event to latch before its scrolls arrive, device lists rot as browsers add sources, and every listener would need its own compositor-delivery grace window — the input state machine the sticky-composer note already declined to build.

**Absorb the coalesced shrink-plus-regrow clamp with heuristics.** Floor-mismatch grace windows or deferred rAF re-checks could keep the raced clamp from reading as the reader. Rejected: streaming rewrites the floor at chunk pace (24 ms) against ~16 ms frames, so any grace window either swallows genuine touch input during streaming — reopening the bug this change fixes — or is too short to cover the race it targets. The mis-attribution is accepted and recoverable instead.

**Drive real touch and scrollbar devices in e2e.** Rejected by the environment, not by preference: every synthesis path (CDP touch gestures, touch event sequences, synthetic mouse on classic scrollbars, headed under Xvfb) was probed and cannot scroll; the details live in Testing above.

## Consequences

Every reader input owns bottom-follow uniformly, with less code: the wheel listener, its epoch counter, and the pre-input baseline bookkeeping are gone, and attribution rides state the component already maintained. The sticky-composer note's layout, wheel chaining, and prepend-anchoring decisions are untouched and remain authoritative; its wheel-only input rule is superseded by this note. The cost is the contract change above — a coalesced non-React shrink-plus-regrow clamp now pauses follow until the reader returns to the floor or presses Back to bottom — traded for touch, scrollbar, and keyboard correctness during streaming. The e2e lane gains non-wheel coverage only within what its browser can synthesize; if gesture synthesis starts working in a future Chromium, the fling emulation can be replaced by real touch strokes without changing the asserted contract.
