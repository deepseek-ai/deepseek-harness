# Agent Note: Derive Workspace recency independently of manual order

Status: implemented

English | [中文](2026-09-10-derived-workspace-recency.zh.md)

## Problem

An editable activity-promoted list can disagree with its displayed timestamps without a drag: an older Session arriving late is promoted ahead of a newer Session already observed. Repeating the same complete list preserves that inversion. The historical [sidebar-order decision](../../archived/feature/2026-08-11-workspace-sidebar-order-and-folding.md) shared one editable order between Manual and Last updated to preserve positions when switching modes. That trade-off does not satisfy chronological browsing.

## Decision

Last updated is a pure projection of current Session summaries: ordinary rows sort by descending `updatedAt`, with Session id as the tie-break. The selected blank New Session precedes ordinary rows until its first prompt. Grouped, Ungrouped, and flat views use the same policy. Reloads and delayed summaries require no observed-timestamp history or promotion events in the view store.

Only Manual uses browser-persisted Session display order. A Session drag snapshots every active account, applies the move to its browser-local account, and selects Manual atomically. Entering Manual also freezes every active account from the current chronological ordering. Returning to Last updated discards the manual layout; entering Manual again starts from the current timestamps. Reconciliation retains saved members that remain in the Workspace account, removes departed members, and appends newly known members at the end, newest first when several arrive together. New members without summaries wait for the summary, while previously saved slots survive a temporarily missing summary. Workspace membership and Workspace-group order remain Host-owned; Workspace-group drags still call the Host reorder operation.

The selected blank New Session is a display invariant applied after either base order: it remains first and cannot start a drag. Manual persists the observed blank position even while the Workspace stream reconnects, preserving every other saved member until the complete baseline permits reconciliation. Waiting to record that position would lose it if the first prompt arrives before the baseline. Its first prompt removes the blank state. Manual then keeps the existing first slot and allows dragging; Last updated projects it from the prompt timestamp. The ordering subscription and reconciliation remain mounted when the sidebar is collapsed or search replaces the list body.

The persistence key stores grouping, expansion, and saved Manual positions. Persisted observed-timestamp data is removed when active account keys are retained. Current metadata owns timestamp accuracy: a cold summary without prompt metadata can fall back to creation time, independently of view ordering.

## Alternatives considered

**Keep activity promotion and sort again on reconnect.** Late summaries and metadata corrections also arrive within a connection. A reconnect-only repair still allows chronology to depend on observation order.

**Restore a separate manual layout on mode switches.** Replacing the visible list with old positions makes entering Manual surprising. Resetting the layout on a mode change gives Manual the simpler meaning of pausing the current ordering.

**Persist a second chronological order.** Current timestamps already determine that order. A second ledger retains synchronization and recovery work without representing an independent user choice.

**Disable dragging in Last updated.** Switching to Manual on a committed drag keeps the existing affordance and gives the edited order an explicit mode. A cancelled or ineffective drag leaves the selected mode unchanged.

## Consequences

Manual pauses automatic sorting of the current list. The default is Last updated, and reloads retain the selected mode and current manual positions. Chronological browsing gives up persistent drag exceptions. The view store owns manual Session positions but no activity timestamps; the Host Session-account order does not participate in this browser's display order.

The archived sidebar note remains frozen historical evidence; its folding and Workspace-order decisions are outside this change. No active note owns the superseded shared-order policy.

## Testing

Component regressions cover older first arrivals, corrected and decreasing timestamps, delayed summaries, discarded-layout isolation, atomic mode switches, blank insertion and drag prevention, the first-prompt transition, collapsed-sidebar reconciliation, reloads, and automatic Manual selection on drag. The recorded-session Web scenario exercises the shipped composition with persisted positions, native dragging, grouped and flat views, a pinned blank, and reloads. Existing folding cases retain the provisional blank quota.
