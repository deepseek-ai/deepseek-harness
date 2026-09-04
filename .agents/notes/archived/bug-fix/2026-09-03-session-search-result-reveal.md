# Agent Note: Session search result reveal

Status: implemented
Archived: 2026-09-03

English | [中文](2026-09-03-session-search-result-reveal.zh.md)

## Problem

Selecting a Session search result opened its conversation while leaving the sidebar in the filtered search view. The user could not see where the Session belonged in the normal Workspace hierarchy. Clearing search alone was insufficient because the owning Workspace could be closed, the Session could be hidden beyond the five-row fold, and either grouped or flat navigation could place the row outside the scrollport.

## Decision

[`WorkspaceBrowser`](../../../../packages/client/ui-workspace/README.md) treats result selection as a transition back to normal browsing. It records the target Session id, clears the query, collapses search, and opens the Session. In grouped browsing, `SessionTree` waits until the current Workspace stream has a complete Host baseline, derives and opens the owning Workspace or Ungrouped group, and transiently reveals the hidden remainder only when the target is behind the five-row fold. Flat browsing needs no fold override.

The normal Session row owns completion of the one-shot reveal. A matching mounted row scrolls itself into the nearest visible position and acknowledges the target id, preventing later renders from repeating the scroll. Starting another non-empty search cancels an unacknowledged reveal. Metadata and content matches use the same transition because both result kinds resolve to a Session id.

## Alternatives considered

**Preserve the query after opening the Session.** This keeps the discovery context but leaves the user in the temporary result list and does not identify the Session's normal location.

**Clear search without opening or unfolding the owning group.** The conversation would open while its selected row could remain hidden, reproducing the missing-location problem in a different sidebar state.

**Persist an expanded-all preference for the group.** One navigation would permanently replace the bounded five-row presentation. The reveal instead expands the remainder only for the current tree mount.

**Scroll from the browser parent.** The parent cannot complete the operation before a folded target row mounts. The row that owns the DOM element performs and acknowledges the scroll.

## Consequences

Selecting a result discards the current query and returns the sidebar to normal browsing. The owning group stays open, and its hidden remainder is visible for that tree mount when required, so the selected row supplies both hierarchy context and an on-screen location. Waiting for the current Workspace baseline prevents a reconnect's retained membership from acknowledging the reveal before replacement state arrives. A later search or ordinary render does not repeat the scroll after acknowledgment.

The target row is the only completion signal. If another client archives or moves the Session between result selection and row mount, the reveal remains armed; the row will scroll if it mounts later, unless a new non-empty search cancels the reveal or the browser unmounts.

## Testing

UI tests cover a content-only hit in the sixth position of a closed Workspace, pending and reconnecting Workspace baselines, cancellation by a new search, transient group expansion and scroll acknowledgment, and the same one-shot scroll in flat mode. The assembled Web navigation test verifies that one click clears search and leaves exactly one selected Session row in the normal tree. The long-conversation browser test opens its seeded Session with that single-click transition.
