# Agent Note: Fixed header, sticky composer inside the transcript scrollport

Status: implemented
Archived: 2026-09-04

English | [中文](2026-07-29-sticky-composer-conversation-scroll.zh.md)

## Problem

The active conversation column split scrolling: the chat (and trajectory) view owned `overflow-y: auto`, while the composer stack sat as a sibling below that scrollport. A wheel gesture over the stats line or input therefore hit a non-scrolling region and did nothing — the transcript only moved when the pointer was over the message list. Long drafts made it worse: the textarea is itself a scrollport, so wheel over the composer could be trapped there. The session header must occupy the top of the column as ordinary chrome (not `position: sticky` inside the scrollport), while the composer must stick to the bottom of the same scrollport as the transcript so wheel over the footer moves the flow.

## Decision

`ConversationRoot` always owns one `data-conversation-scroll` body, with the strict `conversation.session` view outlet before a `data-composer-seat` around the whole `'conversation.composer'` chain output (fallback + elected overlay siblings from `overlay: true`). The separate strict `conversation.session.header` outlet remains `flex: none` column chrome above that scrollport and hides while the Session is blank. This fixed parent tree keeps the scroll body and composer seat mounted from no session through the blank Hero and active conversation. Active CSS sticks that seat with `position: sticky; bottom: 0` so Question/Approval takeovers stay visible when the user is not pinned to the floor; Hero CSS centers the fallback stack inside the scroll body. ChatView and Trajectory/Waterfall keep a local scroller only when mounted outside that host (unit tests); under the host they set `overflow: visible` and resolve bottom-follow / prepend anchoring through `closest('[data-conversation-scroll]')`.

Session stats live on `'conversation.composer.dock'` (above `'conversation.input.dock'`). The InputBar textarea, when inside the host, chains `wheel` with `{ passive: false }`: while the capped textarea can still scroll in that direction it keeps the native gesture; only at its own edge does it `preventDefault` and apply `deltaY` to the host.

Chat history prepend follows reader intent through stable rendered node/call identities rather than whole-scrollport height deltas. `ChatView` records the first visible `data-chat-anchor-key` and its top relative to the scrollport when paging starts, reselects the currently visible stable anchor after every reader scroll while the request is in flight, and compensates by that row's post-prepend rectangle delta. Reaching the bottom or appending the reader's own message cancels the paging anchor, so a late page cannot pull the view away from the newest content. Bottom follow is stored state rather than raw scroll geometry; how reader input is recognized — device-agnostic deviation from the observed-top ledger of the last delivered or written `scrollTop` — is owned by the [reader-scroll-attribution note](2026-08-06-reader-scroll-attribution-observed-top-ledger.md). ChatView's single `ResizeObserver` follows streaming, tool disclosure, and draft resize only while bottom ownership remains pinned, without a second per-chunk scroll write.

## Alternatives considered

**Sticky header and sticky composer inside one column scrollport.** Rejected for the header: it must occupy the top as fixed layout chrome, not participate in the scrollport's sticky layer.

**Fixed flex-none composer below the scrollport with wheel forwarding.** Rejected: the product requires the composer to stick inside the transcript scrollport so the footer is part of that scroll hit-testing surface, not a sibling that only forwards deltas.

**Portal the composer into ChatView's scroller.** Rejected: the composer is shared across view tabs; its target is the root-owned scrollport in the resident shell.

**Keep StatsLine inside ChatView below the message column.** Rejected: outside the sticky composer it would scroll away while the input stayed pinned.

**Model every browser scroll input source.** Rejected for this narrow fix: the reproduced desktop path uses wheel/trackpad input. Pointer/touch scrolling, native-scrollbar dragging, keyboard scrolling, focus navigation, and nested overflow ownership were left outside the input-source model instead of adding a general input state machine. The [reader-scroll-attribution note](2026-08-06-reader-scroll-attribution-observed-top-ledger.md) later closed this deferral by generalizing attribution through the observed-top ledger, still without an input state machine.

## Consequences

Wheel over the footer scrolls the transcript; the visible layout is a fixed header, scrolling transcript, and sticky bottom composer. Stats appear on every active view tab. Nested view scrollers under the host are suppressed so sticky Turn headers in Trajectory stick to the column host. Concurrent history, streaming, tool expansion, and composer reflow preserve reader scroll decisions, including Chromium's compositor-first delivery and stream-finalization shrink clamp. Follow ownership extends to every reader input under the [reader-scroll-attribution note](2026-08-06-reader-scroll-attribution-observed-top-ledger.md). No session → blank Hero and Hero → active both keep the same textarea DOM node and InputHub draft.
