# Agent Note: Task tab recovery after a reload

Status: implemented

English | [中文](2026-09-18-schedule-task-tab-restore.zh.md)

## Problem

The right Sidebar persists a Session's layout as tab records and not the navigation parameters an opener passed, per the [tab type and navigation decision](../architecture/2026-09-05-sidebar-tab-types-and-navigation.md). A `scheduleTask` tab restored by a reload therefore had no task identity: its body could show only its loading feedback and its chip only the constant label, until the user opened the task again from the Session entry. Recovering content belongs to the tab type's provider, as the [layout persistence decision](../architecture/2026-09-14-sidebar-layout-provider-recovery.md) established for terminals, and the Sidebar exposes no parameter store for a page type to reuse.

## Decision

The task tab page keeps a durable binding to the task it last showed and resolves a restored record from it.

The binding key is the Sidebar Session plus the layout record's own id. `dsh.sidebar-right.v1.<sessionId>` persists the tab records and the counter that mints their ids, so a record keeps its id across a reload and no record minted later in that layout reuses it. The record's `contentId` is not a usable key: every tab of one page kind is recorded under the same `sidebar://<kind>` address, and page deduplication is per pane, so two panes may each hold a task tab. Each entry also stores the `kind` and `contentId` of the record it was written for, and a read drops and ignores an entry whose pair differs from the record reading it.

One localStorage document per Session, keyed `dsh.schedule.task-tab.v1.<sessionId>`, holds one entry per tab id, mapping that page to the Session and id of its last task. No task content is stored. A write keeps only the entries whose tab the Session's committed layout still holds, read through `ctx.sidebarRight.tabsIn(sessionId)`; a Session whose layout is not adopted leaves its entries alone. An entry that a read succeeding after the tab appeared cannot resolve is removed, which leaves the tab with the unbound-tab notice, the same state as one that never had a binding.

The body writes the binding in an effect whenever a navigation carries this type's parameters, and reads it only while the record has no navigation parameters; parameters of another kind leave the record in its missing-task state. A recovered identity then follows the existing rules: the detail whenever the retained records hold the task, the catalog feedback until a read requested after the tab's baseline settles without the task, and the query-failure state with its retry when the read fails. A binding such a read cannot resolve shows the unbound-tab notice instead of the loading feedback, and never the missing-task notice, because that notice states that an opener named a task.

The body measures the answer from the catalog read request ordinal it observed for its current navigation, and asks for a read whenever the retained records leave it without a task and no read requested after that ordinal has succeeded, reporting the catalog feedback while that read is pending. The Sidebar navigates a tab again without remounting its body, so the navigation's revision moves the baseline; a read requested before the baseline never states that the tab's task is gone.

## Alternatives considered

**Key the binding by `contentId`.** Rejected: every tab of one page kind is recorded under the same address, and page deduplication is per pane, so two task tabs in two panes would share one binding and restore the same task.

**Persist navigation parameters in the Sidebar layout.** Rejected: it moves content parameters into the layout snapshot that the [navigation decision](../architecture/2026-09-05-sidebar-tab-types-and-navigation.md) keeps transient, and every future page type would inherit the format.

**Declare the kind `multiple: true` so every open mints a unique contentId.** Rejected: it changes what opening a task does — a second task opens a second tab instead of showing in the existing one — to obtain a key, and it cannot recover records restored before the change.

**Resolve the task from the catalog.** Rejected: the catalog holds no per-tab association, and the Session entry the tab was opened from is gone after a reload.

**Reuse the client store's localStorage persistence.** Rejected: `createSnapshotStore`'s `persist` option saves one whole store value under one name and rehydrates it when that store is created, so it needs a store per Session; the binding also has to reject reused ids and prune closed tabs on write, which a keyed document does in one place with no subscription for a body to re-render through.

**Store the task title beside the binding to confirm the recovery.** Rejected: a title is task content, it changes with an edit, and the settled catalog read already decides whether the bound id resolves.

## Consequences

A reloaded Session restores every task tab's detail and chip without reopening the task. The binding is window-local browser state: another browser, a cleared origin, or a tab the layout kit duplicated has none, and such a record states that the tab has no task instead of claiming the task is gone. A discarded layout snapshot can mint a tab id that a binding still names; the kind and contentId guard rejects an entry of another kind, and an entry of the same kind is overwritten by the next navigation of that tab or removed once its task stops resolving.

Entries of Sessions whose layouts are never adopted again remain until their next write; write-time pruning bounds every adopted Session, and no entry holds content.

## Testing

Unit tests cover writing on navigation, reading only without parameters, recovery into the detail and the chip, degradation of an unresolvable binding, committed-tab pruning, reused-id rejection, malformed stored documents, and storage that is absent or rejects writes.
