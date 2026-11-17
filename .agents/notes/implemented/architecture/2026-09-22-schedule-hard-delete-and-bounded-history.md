# Agent Note: Schedule deletes task rows and bounds delivery history

Status: implemented

English | [中文](2026-09-22-schedule-hard-delete-and-bounded-history.zh.md)

## Problem

The Schedule domain stores each task as one JSON document that the backend rewrites whole on every change of that task, so every retained byte in a task row grows every write of that task. Saved delivery records were unbounded: each acknowledgment appended to the array, and a deleted task kept its row and records so the open detail could still read them. The document's size therefore followed a task's delivery count, and deletion added a state every reader had to skip.

## Decision

Deletion is hard deletion. The `delete` action of `ScheduleService.edit` removes the storage row through `tasks.delete`, so the task stops scheduling, leaves `list` and `catalog`, and `history` answers `schedule_not_found` for its id; the row's saved delivery records are removed with it. `deleteInactive` removes only ended tasks in one `tasks.deleteMany` batch and preserves active and paused tasks. The task schema has no `deleted` field, and no client surface offers a recycle bin or a read of an already deleted task's records.

Delivery history is bounded by plugin `Config`: `deliveryHistoryDays` (default 30, 1–3650) and `deliveryHistoryRecords` (default 200, 1–10000). `appendDelivery` applies both bounds on the only write path. It keeps the records whose `deliveredAt` is at or after the appended receipt's `deliveredAt` minus the configured day window, keeps the newest `deliveryHistoryRecords` of those, and always retains the appended latest receipt; a pruned window sets `earlierRecordsUnavailable` and `earlierRecordsPruned`, which later appends preserve. The latter flag is optional in stored rows and confirms actual removal; legacy unavailability alone does not imply pruning. The history response includes the current retention limits, and the Client shows the cleanup notice only for confirmed pruning after loading the final nonempty page.

The [Host-owned scheduled messages](2026-09-16-host-schedule-storage.md) note keeps the rest of its decision: timer restoration for active tasks only, cold-Session delivery through the Session controller, the catalog and detail surfaces, and the historical-versus-Host decoder split. That note stays active: this supersession is partial, so it is neither archived nor frozen, and it remains the owner of everything above while the deletion and retention decisions it recorded are replaced here. [Standalone schedules and Session targets](2026-09-17-standalone-schedules.md) owns the authoritative task domain and its `active`, `paused`, or `ended` status. Native and Remote catalogs report these same three statuses across the Host. The Automation tasks page's status filter row reads All, Enabled, Paused, and Ended.

## Alternatives considered

**Keep the retained `deleted` row.** The flag existed so `history` could answer after deletion. Nothing read those records after deletion, the row kept every prompt snapshot in the storage document, and the state had to be excluded by hand from `list`, `catalog`, and the timer. Removing the row makes deletion mean one thing.

**Bound only by record count.** A count cap alone keeps arbitrarily old receipts when deliveries are sparse, and it drops a burst of recent ones when they are not. The day window bounds staleness while the cap bounds the document.

**Measure the window from the task instead of from each receipt.** Anchoring the window to the task's creation or committed target would discard a newly written receipt of an old task. Measuring back from the appended receipt's `deliveredAt` keeps the window anchored to the data being kept.

**Keep history unbounded and let operators clean up.** The backend rewrites each task document whole on every write of that task, so unbounded history makes the task document's size a function of delivery counts. Retention is a bound the storage layout requires, not a retention preference.

## Consequences

Deletion now offers no recovery: a deleted task's saved deliveries cannot be read back, and a task that still needs its full history must be read before deletion. Configured retention also discards receipts the task once had; the retained flag records that a window was pruned rather than pretending the history is complete.

In exchange, the persisted task set has one deletion semantics, the size of each task document is bounded by configuration instead of by delivery counts, and deletion adds no lifecycle state. The plugin `Config` is the place to raise the bounds when a deployment needs longer delivery history.
