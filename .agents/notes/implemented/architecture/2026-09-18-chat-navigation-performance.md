# Agent Note: Bound turn navigation work and batch historical jumps

Status: implemented

English | [中文](2026-09-18-chat-navigation-performance.zh.md)

## Problem

A long Session makes three independent costs visible: a turn rail with one DOM mark per known turn, transcript navigation that rediscovers an already known landing, and historical jumps that publish every fetched page. Each intermediate prepend rebuilds growing conversation indexes and exposes another transcript update before the requested turn is available. Combining these concerns into one controller obscures which operations require DOM geometry and which only apply reading or paging policy.

## Decision

### Fixed-pitch virtual rail

[TurnNavigator](../../../../packages/client/ui-chat/src/client/chat/TurnNavigator.tsx) uses TanStack React Virtual with a fixed 10px pitch. Only the visible range, overscan, and the focused mark with its neighbors remain mounted. The library owns the size container and absolute mark transforms. The full turn metadata remains resident; this is rail virtualization, not transcript virtualization.

The rail uses ResizeObserver-delivered viewport dimensions and fixed item sizes. Its offset calculation clamps against cached geometry and invokes the supported `scrollBy` operation, avoiding the library's DOM-based maximum-offset calculation used by `scrollToIndex`. The first usable size places the latest committed active turn directly after the body has restored its reading state. A ref exposes independent activation and rail-only scrolling. Native pointer targets replace coordinate hit testing, and mark length changes use transforms. Layout containment belongs to the floating rail frame; it does not promise that browser geometry reads flush only that subtree.

### Two-layer transcript navigation

[ChatViewport](../../../../packages/client/ui-chat/src/client/chat/use-chat-viewport.ts) owns DOM reads, clamped writes, native events, and turn anchors. It returns the actual landing with available turn and semantic-position facts. Reading policy consumes those facts without another hit test; the viewport ignores its own unchanged scroll echoes and events from the nested rail.

[ChatReading](../../../../packages/client/ui-chat/src/client/chat/use-chat-reading.ts) owns follow-tail policy, semantic restoration, and sampled reader movement. [ChatNavigation](../../../../packages/client/ui-chat/src/client/chat/use-chat-navigation.ts) owns loaded or unloaded jumps, paging anchors, replacement tasks, and fallback. [useChatScroll](../../../../packages/client/ui-chat/src/client/chat/use-chat-scroll.ts) supplies committed inputs and coordinates these owners. Timer and animation-frame completion invoke the owners directly instead of incrementing React tick state. The [pinned-delivery rule](../../../../packages/client/ui-chat/README.md#scroll-ownership) remains independently necessary: small reader gestures cannot be erased by intervening layout growth.

Shared nested-follow mechanics and control placement are recorded in the [Chat scroll and footer decision](../bug-fix/2026-09-22-chat-scroll-follow-and-footer-geometry.md); sampled outer reading and historical navigation retain the owners above.

### One publication per historical jump

[Session.loadThrough](../../../../packages/api/session-controller/src/client/sessions/session.ts) retains accepted pages and a private paging cursor until its shared target is covered or loading ends. It reverses the page list and flattens it once, then publishes one ordered prepend. Live events continue through their normal publication path. A later page failure publishes the successful prefix once; stream or window replacement discards obsolete buffered pages. Single-page `loadOlder` remains immediate, and repeated jump requests retain the existing lowest-target policy.

### Theoretical work model

Let `T` be known turns, `V` mounted virtual marks, `P` fetched pages, `B` entries per page, and `W0` entries already loaded. These are work-count estimates, not timing measurements.

| Operation | Previous work | Current work |
|---|---|---|
| Rail DOM and React mark traversal | `O(T)` | `O(V)`; turn metadata and initial index/cache construction remain `O(T)` |
| Active-turn index lookup with unchanged items | Linear search, `O(T)` | Map lookup, expected `O(1)` |
| Rail target-offset calculation | Synchronous DOM extent/viewport reads | Fixed arithmetic and cached sizes; no DOM extent read on this path |
| Known transcript jump | Landing followed by position rediscovery | Reuse the landing; no hit test, but existing anchor-selector and turn lookup costs remain |
| History-driven linear index passes | `O(P * W0 + B * P²)` | `O(W0 + B * P)` for one final pass, plus `O(B * P)` buffer flattening |
| History-driven sorting | Repeated sorting of each growing window | One final-window sort, `O((W0 + B * P) log(W0 + B * P))` |
| Historical prepend publications | `P` | One; live-event and loading-state updates remain independent |

For illustration, 10,000 turns and about 50 mounted marks imply roughly 99.5% fewer rail marks, not a 200× end-to-end speedup. With 20 equal pages and a negligible initial window, a full linear pass after each page visits `210B` entries in aggregate; one final pass visits `20B`, about 10.5× less work for that pass. Page requests remain 20, and the final transcript still needs assembly, rendering, and layout.

## Alternatives considered

**Containment or React batching alone.** Containment does not remove repeated JavaScript work. Suppressing React renders after each published page still leaves conversation assembly and index rebuilds upstream.

**Patch the virtualizer.** The supported callbacks and relative-scroll operation cover fixed-height placement without maintaining a dependency fork. The native scroll container still needs a total extent; removing that extent would remove native scrolling, not virtualize it.

**One large scrolling controller.** It centralizes state but couples DOM mechanics to follow and paging policy. Separate owners allow business changes without copying geometry operations.

**Virtualize the whole transcript.** That introduces renderer lifetime and semantic-anchor constraints outside this change. Batching the requested historical jump removes intermediate publications without changing transcript residency.

## Consequences

Loading a distant turn retains the current transcript until the batch lands, instead of revealing intermediate pages. Buffered pages add references proportional to newly fetched entries. Main-transcript geometry reads, semantic-anchor queries, ordinary native-scroll metrics, final layout, and center-width reflow during Sidebar animation remain; none is claimed eliminated by this change. Transform and color changes may still repaint, and assigning `scrollTop` may still deliver a native scroll event.

[Rail tests](../../../../packages/client/ui-chat/tests/turn-navigator.client.spec.tsx) cover bounded mounting, first placement, fixed-size controls, and focus retention. [Chat tests](../../../../packages/client/ui-chat/tests/chat-view.client.spec.tsx) cover semantic restoration, follow attribution, own-scroll echoes, and navigation without hit testing. [Session tests](../../../../packages/api/session-controller/tests/session.client.spec.ts) cover atomic prepend publication with live delivery, failure, and replacement. [Browser navigation](../../../../apps/web/tests/chat-scroll-contract.e2e.ts) covers real scrolling and unloaded-turn landing. Functional evidence is separate from the theoretical estimates above.
