# Agent Note: Archive admission reads the stored tasks

Status: implemented

English | [中文](2026-09-22-archive-admission-reads-stored-tasks.zh.md)

## Problem

Archive admission asks every provider what still runs for a Session before the archive is written, and a stop-archive then asks those providers to end it ([archiving a Session with running work](2026-09-21-archive-stops-running-session-work.md)). The Schedule provider answered from its owned runtime's fold of the live Session log, so only a Session with a live Agent reported the `schedule` family, and the stop deleted through the management `delete` path.

Host tasks are stored in the Schedule domain and outlive their Session's Agent ([the storage decision](../architecture/2026-09-16-host-schedule-storage.md)), so that fold no longer exists: `ScheduleRuntime.activeRecords()` is gone, and the stored task table is the only place a due reminder can be seen. A cold Session whose stored rows were still armed therefore reported nothing, archived without the confirmation dialog the running case asks for, and nobody was told which reminder the Host would keep.

## Decision

The Schedule provider answers archive admission from the stored Host task rows, and a stop deletes them. `workspace/session-activity` reads the stored tasks whose status is active and whose `session` or reserved `new_once` target has the matching Session id, reports them as the `schedule` family, one item per task with its stored id and title, and prepends that family to `next()` so every other provider keeps its entries. `workspace/session-stop` removes those rows in one `deleteMany` batch inside one slot of the same serialized queue the tools use, so a stop is ordered behind a create whose write is still in flight and cannot miss the row that create is about to commit. A successful nonempty batch announces `schedule/changed`, re-drives the timer once, and queues deletion notices for other loaded involved Agents. Session liveness is never consulted: an idle or cold Session whose stored rows are armed refuses the archive, and the confirmation dialog names exactly those reminders. Both listeners are registered in one effect named `schedule.archiveAdmission()`, so unloading the plugin withdraws them together.

## Alternatives considered

**Report the `schedule` family from live Sessions only.** The stored tasks are authoritative and outlive their Session's Agent, so consulting liveness would let a cold Session with armed rows archive silently; its due delivery then rejects the archived destination. The admission answer costs one table read either way.

**Delete each row through the `delete` action of public `edit`.** Re-entering the serialized queue from inside the slot that already holds it deadlocks, so the stop removes the rows itself: the same durable change, with one `schedule/changed` notification and one timer re-drive per stop instead of one per row.

**Keep a runtime-side mirror of the Session's active tasks.** A mirror duplicates the authoritative store, drifts after a restart, and disappears with the Agent — the exact case admission must still answer for.

## Consequences

Admission costs one stored-table read, and a Session with no live Agent can refuse the archive: a Session that looks quiet may now ask for confirmation because its stored reminders are armed. A stop uses one domain `deleteMany` batch. A normal write failure preserves every row; an `unknown-state` failure may have removed rows and quarantines the domain until it is reopened. Either failure announces `schedule/changed` so observers reread and then reaches the caller. A crash between the archive write and the stop can leave stored rows armed in an archived Session; delivery rejects with `schedule/target-archived` before enqueue, without writing a receipt or consuming the occurrence. The seam itself is unchanged: the workspace package still knows no Schedule vocabulary, and this provider owns only reminders.
