# Agent Note: Separate Chat clipping and independent follow intent

Status: implemented

English | [中文](2026-09-22-chat-scroll-follow-and-footer-geometry.zh.md)

## Problem

Transcript overflow must remain clipped without trapping floating controls or changing the scroll ancestor of sticky content. An `overflow-y: hidden` ancestor becomes the nearest scroll container even when readers scroll a different outer element. It prevents Markdown code banners and expanded compaction headers from sticking to the visible conversation scrollport; floating controls inside that ancestor also use transcript geometry instead of viewport geometry.

A height-capped process group also has a separate reading position. Outer bottom-follow cannot expose newly appended content inside a group whose own scroll offset stays unchanged. Treating every non-bottom scroll event as reader input does not support native smooth following: the browser emits those same events while an animation approaches its target.

## Decision

The transcript, floating controls, and scroll intent retain separate ownership. The [scroll-state table](../../../../packages/client/ui-chat/README.md#scroll-ownership) and [group display rules](../../../../packages/client/ui-chat/src/client/conversation-nodes/README.md#display-modes) define the current product behavior.

| Area | Implementation | Reason |
|---|---|---|
| Transcript clipping | `ChatView` uses `overflow-x: visible; overflow-y: clip` on `.root` inside an unclipped frame. | Constrain vertical overflow without introducing a scroll container between sticky content and its actual scrollport. |
| Floating controls | TurnNavigator and the back-to-bottom button are siblings of the clipped transcript. | Shared Conversations use the outer scrollport for sticky positioning; standalone Chat uses its frame for absolute positioning. |
| Follow intent | `useScrollFollow` retains one independent controller per scrollport. | Reuse thresholds, position sampling, and native scrolling without sharing one follow flag. |
| Group lifecycle | `useProcessScroll` owns its existing body/content observer, directional fades, and one-shot opening position. | Group growth remains observable after the body reaches its cap; opening performs no immediate geometry read. |

The clipped root owns no scroll offset. Shared Conversation scrolling, standalone Chat scrolling, capped process groups, and terminal sections retain their existing scrollports. The horizontal axis stays `visible`: pairing vertical `clip` with horizontal `auto` or `hidden` computes the vertical overflow back to `hidden` and restores the unwanted scroll container.

An unclosed group opens at its bottom; a closed group opens at its top. The group’s `closed` value, not the whole Turn’s status or an all-node search, decides that initial position. A later close does not reset an already-open reader. Browser find keeps its own reveal position, and display-mode changes preserve mounted members.

Native smooth growth keeps an outstanding target separate from the current position. Animation progress retains follow intent. Input interrupts native motion before the browser applies reader movement; the resulting actual displacement determines whether following stops or resumes. Further growth retains the issued target until `scrollend`. Arrival at that target, including shrink clamping, allows one request to the latest floor; an off-target stop releases following so focus and find keep their landing. Reduced motion and explicit opening positions use immediate scrolling. Outer following keeps its existing immediate behavior and sampling policy.

The back-to-bottom button depends only on outer follow intent and restores only that intent. Inner scrolling affects the outer controller only when scroll chaining actually moves the outer scrollport. Group height growth can resize the outer transcript, but the controllers do not invoke each other’s follow actions. Paging and semantic restoration remain with the existing outer reading/navigation owners.

## Alternatives considered

**Remove transcript clipping.** That would abandon the overflow constraint. Vertical `clip` retains clipping without creating a scroll container; the unclipped sibling frame keeps floating controls outside the clipped area without a Portal or document-level coordinate synchronization.

**Keep `overflow-y: hidden` and move only floating controls.** That protects the controls but leaves sticky content inside the unwanted scroll container. Changing the root to `clip` also preserves the scroll ancestor of code and compaction headers without moving those headers out of their content.

**Share one follow flag, or duplicate the complete controllers.** One flag would pull a group away from a reader merely because the outer transcript follows. Two complete implementations would duplicate animation attribution and threshold rules. Sharing the small controller retains independent state without moving paging, Turn navigation, or semantic memory into it.

**Only replace `scrollTop` assignment with smooth `scrollTo`.** Intermediate animation offsets would appear to be reader movement and disable following. Native motion needs an explicit target and input interruption; a custom animation-frame interpolator is unnecessary.

## Verification

[Controller tests](../../../../packages/client/ui-chat/tests/scroll-follow.client.spec.ts) cover independent thresholds, animation progress, target reuse, input interruption, reduced motion, and immediate positioning. [Chat component tests](../../../../packages/client/ui-chat/tests/chat-view.client.spec.tsx) cover group opening, pause/resume, closing while open, and browser-find preservation. [Viewport tests](../../../../packages/client/ui-chat/tests/chat-viewport.client.spec.ts) retain the outer anchor and attribution behavior.

[Browser scroll cases](../../../../apps/web/tests/chat-scroll-contract.e2e.ts) exercise floating-control geometry, nested following, paging, streaming, and real wheel input through the shipped Web composition.

[Seeded-history cases](../../../../apps/web/tests/seeded-history.e2e.ts) check an expanded compaction header and its nested code banner against the actual conversation scrollport, including their stacking and copy-button access.

## Consequences

The shared controller stores intent without scheduling React renders; callers still publish visible state changes, and group edge fades update only when their booleans change. Follow operations read the affected scrollport, not its Node collection. Native scrolling still performs browser layout and paint work. These changes establish behavior and ownership, not a measured latency or memory improvement.

The [navigation decision](../architecture/2026-09-18-chat-navigation-performance.md) still owns sampled reading, known landings, and batched historical jumps. The [grouping decision](../architecture/2026-09-21-conversation-build-groups.md) still owns Definition-based membership and stable rendering identities. Extracting scroll-follow mechanics does not supersede either decision.
