# Agent Note: Loaded-Turn chat navigation

Status: implemented

English | [中文](2026-08-25-loaded-turn-chat-navigation.zh.md)

## Problem

Long Chat transcripts require repeated scrolling to revisit an earlier Turn. Session history is paged, so the browser may hold only a suffix of the conversation and the first loaded Turn may begin after its user message. A navigator that implies knowledge of unloaded Turns, or keys marks by their current array position, becomes misleading or unstable when Session Controller prepends the preceding event page.

## Decision

The Chat snapshot builder accumulates one navigation item for every currently loaded Turn that has a visible transcript node. Each item uses the Turn number as its stable React key and the first loaded user node, falling back to the Turn's first loaded node, as its scroll anchor. This is a pure projection of loaded Chat state: the feature adds no Session event, persisted index, or pagination request.

Accumulation, not a render-time scan: a structural upsert re-derives the loaded Turn set, a content-only upsert re-derives only the Turns whose nodes changed, and each preview is capped at 160 characters so navigation state never holds a copy of the transcript. The published array keeps its identity until an item changes, so ChatView selects it as both the rail's data and its change signal — the renderer never walks the loaded window, and a streaming reply's preview follows the in-place node update instead of the last structural publication.

The rail renders the complete loaded Turn set with a 10px natural interval and never renders an ellipsis or unloaded-history placeholder. Its height shrink-wraps small sets; when the loaded set exceeds the available height, percentage positions compress every mark into the capped rail. When an earlier page arrives, existing Turn keys and DOM elements remain stable while their resolved positions change; CSS transitions animate that redistribution. A Turn split by the page boundary initially previews its Turn number and loaded assistant response, then gains the user prompt when the preceding page supplies it.

The rail sits against the scrollport's right edge and centers on the band the sticky composer leaves visible. That band is the scrollport's own height minus the seat's, so ConversationRoot publishes `--dsh-conversation-viewport-height` beside the `--dsh-composer-height` it already measures on the same element, and the rail centers on their difference instead of a viewport height that ignores the Session header.

The active mark follows a reading line near the top of the shared Chat scrollport. A pinned frame selects the final loaded Turn from scroll distance before reading any row geometry; streaming and other observed height changes can therefore follow the floor without a hit test or scan. Away from the floor, a scroll frame resolves the owning Turn with one hit test at the reading line, falling back to a single row scan where layout cannot answer, so cost does not grow with the number of marks. Flow-height changes that move rows across the line without a scroll event resync through the existing column observer. Scroll updates are coalesced with `requestAnimationFrame`. Activating a mark computes the target node's position in the existing scroll coordinate system, moves that same scrollport, and records the resulting Chat scroll-restoration anchor.

Every Turn remains an accessible button even when dense marks visually overlap. The rail maps pointer height to the nearest loaded Turn, while keyboard focus and activation operate the individual buttons. Hover and focus show a compact prompt-and-response preview, the active mark is longer and darker, the rail is hidden when the Chat container is at most 900px wide, and reduced-motion preferences disable redistribution and mark-entry animation.

## Alternatives considered

**Persist a complete Turn index separately from the loaded Session page.** Rejected: the current client cannot navigate to an unloaded transcript anchor without first materializing that history, and a second index would duplicate Session projection state.

**Show an ellipsis for unloaded history.** Rejected: pagination exposes only `hasMore`, not the number or distribution of earlier Turns, so an ellipsis would add no actionable destination. Loading a page and redistributing the actual loaded set communicates the available navigation precisely.

**Always spread marks across the available height.** Rejected: a small loaded set produces visually unrelated marks separated by large empty regions. A fixed natural interval preserves a compact index while percentage compression still admits dense histories.

**Derive the rail in the renderer from the Chat snapshot.** Rejected: renderers do not scan the loaded Chat Nodes ([client discipline](../../../../packages/client/AGENTS.md)). A render-time projection also re-copied every Turn's prompt and reply text on each structural publication, and could not see the in-place node updates a streaming reply produces, so previews froze at the first chunk.

**Key marks by loaded-array position.** Rejected: prepending a page would reuse each DOM element for a different Turn, lose focus and preview identity, and prevent the existing marks from animating to their new positions.

**Call `scrollIntoView` on the Turn row.** Rejected: Chat owns a shared scroller, bottom-follow state, paging anchors, and persisted restoration coordinates. An opaque browser scroll would bypass those state updates.

## Consequences

Desktop-width Chat views can jump among all currently loaded Turns and inspect a short preview without expanding transcript content. Pagination prepends new destinations without presenting fabricated coverage or remounting existing marks. The first loaded mark can temporarily lack a prompt when the page boundary cuts through its Turn; its Turn label remains usable until the earlier page fills that data. If a future transcript virtualizer unmounts loaded anchors, navigation will need an explicit materialization operation before scrolling rather than changing this loaded-Turn projection.

## Testing

Builder tests pin the accumulated projection, the bounded preview, and preview freshness under an in-place chunk update. Component tests pin the published items, accessible previews, scroll-coordinate jumps, DOM identity, percentage redistribution after prepend, and a pinned `ResizeObserver` update that rejects every row-geometry read. The long-interaction Chromium scenario pins the real paginated boundary, prompt completion after `Load earlier`, stable-mark movement, keyboard activation, active-state update, and the narrow-container hide. The multi-Turn recorded Web snapshot includes the navigation landmark and buttons.
