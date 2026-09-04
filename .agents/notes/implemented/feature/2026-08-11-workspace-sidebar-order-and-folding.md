# Agent Note: Workspace Sidebar Order and Folding

Status: implemented

English | [中文](2026-08-11-workspace-sidebar-order-and-folding.zh.md)

## Problem

A Workspace with many Sessions can consume the entire sidebar and push other Workspaces out of reach. A compact list needs a bounded default while preserving an explicit route to every Session. The sidebar also needs an activity-oriented order, but `WorkspaceView.sessionIds` is the durable manual account and must not be rewritten by Session activity.

Workspace groups themselves had no user-controlled durable order. Browser-native drag additionally rejects a drop released outside the list and animates the row back even when the application still has a valid insertion marker. Expanded Workspace sections make header-only hit testing ambiguous because the visual boundary between two groups does not match either header's midpoint.

## Decision

### Workspace order

The Workspace registry owns a durable `workspaceIds` order and exposes `insertBefore(id, beforeId?)` with DOM `insertBefore` semantics. The Host RPC `workspace.insertBefore` returns the complete committed order, and a pure order mutation emits `host/workspace-order-changed` with the same complete order. Unknown source or anchor ids reject as `workspace-not-found`; self-anchored and already-positioned moves do not write.

The client installs a Workspace drag optimistically. Request and frame generations ensure that only the latest unary echo can replace local order and that a newer Host frame outranks an older response; a latest rejected request restores the last complete order accepted from a Host baseline, frame, or current unary echo. Every successful list baseline restores Host order so reconnects adopt durable changes made elsewhere.

### Session folding and view order

Each Workspace persists one browser-local open state: closed means zero Session rows and open means up to five non-blank rows plus the selected blank New Session as one provisional extra row. **Show more** reveals only the hidden remainder for the current mount; closing the whole Workspace clears this transient expansion, so reopening returns to the bounded folded projection. Selecting a Session search result waits for the current Workspace stream's complete Host baseline before opening its owning group, and reveals the hidden remainder for the current mount only when the target is behind the five-row fold. The current Session's group opens automatically only when the user has not already stored an explicit state for that Workspace. Creating a Session from a Workspace row opens the target group before starting the Session, keeping the new row visible when state propagation completes. After a ready Workspace baseline changes, the browser removes expansion, order, and observed-timestamp records for ids absent from that baseline while retaining the Ungrouped and flat-list accounts.

The combined view menu offers **Manual** and **Last updated** in grouped and flat presentation, with one browser-local persisted order per account. A real Workspace initializes from `WorkspaceView.sessionIds`; Ungrouped and the cross-Workspace flat list initialize from recency and have no Host Session account. Entering Last updated performs one complete recency sort; a later user prompt or steer promotes that Session once, and dragging may edit the resulting order. Returning to Manual preserves the current order and only disables later activity promotion. Manual-mode drags for a real Workspace also write the Host Session account, while Ungrouped and flat-list drags and activity promotion remain browser-local. Flat rows omit an empty leading status slot because they have no parent hierarchy, while a visible status retains its slot.

When New Session creation selects a blank Session, the browser promotes it once in both its grouped account and the flat-list account. This explicit creation promotion does not advance `updatedAt`. While the Session remains blank, grouped folding does not charge it against the five non-blank rows; the first prompt returns it to the ordinary quota without undoing a Manual-mode drag.

### Drag and compact chrome

Workspace hit testing uses the complete rendered group section, including visible Session rows. One insertion boundary is shared by the preceding group's lower half and the following group's upper half, and the indicator is an absolutely positioned line with a joined right-facing chevron that does not affect layout. A tree-body overlay draws the first boundary at the same negative offset outside the scrolling clip, so the leading chevron remains visible without moving the list. A collapsed Session drag resolves its insertion boundary from rendered rows, places the source before any hidden account members at that boundary, and rejects a result that would hide the source. During a Workspace or Session drag, document-level `dragover` and `drop` handlers accept the native operation; if release occurs outside the Workspace list, `dragend` commits the last valid marker.

Search is a header action while collapsed and expands across the title and trailing actions. An outside click collapses a query that is empty after trimming but retains a non-empty query; while the rail search gesture is still in flight the outside-click listener stays unmounted ([rail-search self-dismissal](../bug-fix/2026-08-18-rail-search-outside-click-self-dismissal.md)). Compact Workspace and Session rows, a 24px bottom fade, and the absence of per-Workspace Session counts preserve vertical space without removing navigation affordances.

## Alternatives considered

**Write every activity promotion into `Workspace.sessionIds`.** A browser presentation preference would overwrite the shared Host account whenever a user submits a prompt.

**Keep independent Manual and Last updated orders.** Switching modes would replace the visible list with stale positions from the other order, even though choosing Manual only means that later activity stops moving rows.

**Always show every Session in an open Workspace.** One large Workspace would continue to crowd out the rest, and remembering only the whole-group open state would not bound its height.

**Persist the expanded-remainder state.** A Workspace reopened much later could unexpectedly occupy the full sidebar. Only the bounded folded state represents a stable navigation preference; revealing the remainder is a local inspection.

**Use numeric drop indices or header-only hit testing.** Indices drift when rows change during a drag, while header midpoints disagree with the visible boundary when a Workspace is expanded. Anchor ids and full-section geometry remain stable under both conditions.

**Let the browser reject an outside release.** The application would commit the last valid marker while the browser displays a rejected-drop animation, presenting contradictory feedback.

## Consequences

- Workspace order is durable and shared through the Host, while grouping, open state, per-account Session view order, and query state remain browser-local presentation preferences. Ungrouped and the flat list support the same drag and promotion rules, but their orders are browser-local because neither has one Workspace account.
- Last updated performs a complete recency sort on entry, then preserves manual adjustments until a user prompt or steer advances one Session and moves it to the front. Returning to Manual preserves every current position.
- A newly selected blank New Session row enters grouped and flat orders first once. Grouped folding renders it in addition to five non-blank rows until its first prompt, then applies the ordinary quota.
- Opening a Workspace never shows more than five non-blank Sessions without an explicit **Show more** gesture or search-result navigation; the selected blank New Session may add one provisional row. Closing the Workspace resets transient remainder expansion.
- The Host Session account retains the manual-order meaning established by [Session List Browsing and Manual Workspace Order](2026-07-25-session-list-browsing-and-manual-order.md).

## Testing

Domain and Host tests cover durable Workspace moves, no-op and invalid anchors, restart recovery, full-order RPC responses, order frames, and one Workspace snapshot per Host-stream baseline. Runtime tests cover optimistic order, frame/response precedence, overlapping rejection rollback to Host-confirmed order, reconnect baselines, and New Session target priority. UI tests cover five-row folding, the blank-row quota and hidden count, collapsed drag anchors across hidden rows, transient expansion reset, search-result reveal beyond the fold, initial and reconnecting Workspace-baseline waits, pruning persisted state after Workspace removal, order-preserving mode switches, one-time recent-update and New Session promotion, Manual drag retention after the first prompt, browser-local Ungrouped and flat-list drag persistence, hierarchy-free flat-row leading spacing, selected view indicators, expanded-section Workspace hit testing, an unclipped first insertion boundary, outside-list Workspace and Session drops, search collapse rules, and compact CSS dimensions. A shipped-composition Web snapshot pins five established rows beside the provisional New Session.
