# Agent Note: Session pinning and the sidebar archived filter

Status: implemented

English | [中文](2026-09-18-session-pin-and-sidebar-archive.zh.md)

## Problem

The sidebar session list had no way to keep important sessions at the top, and archived sessions could only be reached through a settings page (`ui-settings-unarchive-sessions`) far from the list they came from. Users archived a session and then lost sight of it.

A visibility filter can hide a Session without removing it from its Workspace. Saving filtered rows as the account's complete order loses hidden positions. Independent pin ordering also makes dragging depend on a second sequence instead of the Session order the user edits.

## Decision

The `dsh-workspace` registry stores registry-global pin and archive sets as Session id arrays (`pinnedSessionIds` and `archivedSessionIds`), with durable `pinSession`/`unpinSession` operations. The pin array keeps the most recently pinned id first. Pinning and archival are mutually exclusive: archiving drops the session's pin in the same durable write, and pinning an archived session fails with `WorkspaceArchivedSessionPinError`.

### Complete Session order

Each browser-local account has one complete Session sequence, including pinned and archived members. Workspace membership bounds each account; registry-global pin and archive sets never add a Session to an unrelated Workspace. Grouped, Ungrouped, and flat views use the same rules.

- Existing members retain their positions. Missing pinned members prepend in the pin array's order. New ordinary forks enter immediately before their source, including nested forks, without inheriting its pin. Saved members keep their relative order, and visible pinned rows still lead ordinary forks. Other missing members append by descending Session `updatedAt`, with missing archived members last. Supplementation never duplicates an id.
- Supplementation is an in-memory projection, not an automatic storage migration. A Session-order write records the complete supplemented sequence, including hidden archived rows. Filtering alone never rewrites Session positions.
- A successful Pin action marks the Session pinned and moves its position to the front of its complete account sequence. Completion uses current saved positions and the latest Workspace membership, preserving reorders completed while the request was pending. Unpin removes the mark without restoring an earlier position. Both pinned and ordinary drags edit the same complete sequence; display indices never replace its hidden members.
- The current blank New Session precedes both partitions; other pinned Sessions lead unpinned Sessions. Manual preserves the complete sequence's relative order within both partitions. Last updated sorts both partitions strictly by descending `updatedAt`, with Session id as the tie-break. Pin records carry only Session identities, not timestamps.
- Archive takes precedence if both sets contain a Session. Archiving clears the Host pin but retains the Session's account position. The archive filter changes visibility and disabled-row presentation, not membership or ordering.

The existing [mode-switch and provisional-New-Session rules](../simplification/2026-09-10-derived-workspace-recency.md) remain: a drag selects Manual, Last updated discards the prior manual layout, entering Manual captures the current chronological order, and the selected blank Session retains its provisional first slot. An explicit Pin updates saved positions without changing the selected mode; chronological display still ignores those positions.

### Archive restoration

`WorkspaceRegistry.unarchiveSession` removes one id from the global archive set on the same serialized operation chain as archive and other registry writes. An absent id is an idempotent no-op with no durable write or notification. Restoration preserves Workspace membership and Session logs, and it neither restores a pin nor changes saved ordering.

Unarchive performs no Session-existence probe: removing an id cannot introduce an unknown referent, so even an entry whose Session is gone can be removed without listing persistence. The Remote returns the complete archive set, and the existing `archived` increment carries the same state to other Clients. A Client installs a unary reply only while it remains the latest archive-set request; a newer request, follow increment, or replacement baseline supersedes it. Failed writes leave the set unchanged, and the sidebar logs the rejection while retaining the row, except the running-work refusal, which opens the stop-and-archive confirmation ([archiving a Session with running work](2026-09-21-archive-stops-running-session-work.md)).

### Archived visibility and row motion

The sidebar derives its visible rows in `ui-workspace`:

- Archived rows keep their accounting slots, render grayed, and are not openable. The view-options menu owns an `ArchivedFilter` (`default` hide / `show` / `only`) applied to lists and search alike; the settings-page archived list is deleted with its package.
- Archiving raises a toast with undo and filter-archived actions. Parent rerenders do not extend its lifetime; the fully faded banner cannot retain clickable actions.
- Row motion uses a private React component with native position and opacity animations. It captures row positions around structural commits without observers or polling; removed rows leave inert fading copies outside the scrolling list. Initial loading, drag commits, overflow expansion/collapse, and grouping/ordering/filter switches settle immediately.

### Persistence

Workspace KV, Remote values, and Client snapshots store archive and pin membership as Session id arrays, without object wrappers or pin timestamps. Missing collections default to empty; object-form pin entries are not accepted. Pinning and restoration do not change the Workspace domain version or Session-log format, and neither operation edits Session logs.

## Alternatives considered

**Keep the settings-page archived list.** Two homes for one state; the sidebar filter shows archived rows in the browsing context they came from, so the package is removed outright.

**A restore action without an archived-row filter.** Hidden rows cannot expose actions. The filter makes those rows reachable, so restoration can live with the Session list instead of a separate settings page.

**A separate restore delta or an existence check on unarchive.** A second frame type duplicates the complete-set response and requires another merge path. An existence probe would turn removal of an orphan archive id into an error even though removal cannot introduce an unresolved id. Restoration therefore shares the archive-set protocol and omits the probe.

**Render archive ids whose Session summaries are missing.** Such entries could explain orphan state, but they cannot provide the normal conversation row. The sidebar displays loaded summaries; direct restoration remains available through the API, and orphan management remains outside this browser.

**A separately editable pin sequence.** This duplicates ordering authority and requires another drag write path. The global pin array only seeds missing pinned members; established positions belong to the complete Session sequence.

**Restore pre-pin or pre-archive positions.** Keeping Pin separate from manual positions would restore pre-pin slots, but Pin is an intentional reorder. A separate restoration record adds a product guarantee that this interaction does not require; hiding an archived row already preserves its existing position.

**Rank pins by their pin timestamp.** This makes Last updated mean something other than Session activity. A newly pinned old Session need not lead the pinned partition in that mode; Manual shows the Pin action's first position.

**Persist every derived or filtered list.** Rendering and visibility changes are not ordering commands. An incomplete or filtered projection cannot replace the complete saved sequence.

**Animate every list pass.** Revealing hidden rows, committing a drag, or switching the filter moves rows wholesale and reads as exaggerated motion; those passes apply instantly while pin jumps, archive fades, and neighboring-row movement retain their animations.

## Consequences

The sidebar owns archived visibility end to end and settings loses a package. The pin set is registry-global, so pins survive grouping and ordering switches. Row animation owns no persistent state or dependency.

Filtering and reordering share one complete membership sequence, so hidden archives survive drags and filter switches. Older saved orders recover omitted members in memory and adopt the supplemented sequence on their next Session-order write. Host pin/archive membership semantics remain unchanged. The browser gives up pin-time promotion in Last updated and automatic restoration of pre-pin positions.

An archived id without a loaded Session summary has no visible row or sidebar restore action, even though the API can remove it. This UI limit does not change the registry's idempotent restoration behavior.

Unit suites cover supplementation, complete-sequence dragging, Pin completion after intervening changes, New Session priority, archived navigation guards, filters, toast lifetime, and animation lifecycle. Workspace and Controller tests cover pin/archive exclusivity, identity-only persistence and snapshots, idempotent no-op restoration, missing-Session restoration without persistence probes, restart recovery, and stale unary replies superseded by newer requests or pushed state. The keyless sidebar restore scenario verifies the row action and reload durability.

## Related

- [Session archive (registry-global set)](../../archived/feature/2026-07-31-session-archive-global-set.md) — the frozen record of the archive set and its follow increment.
