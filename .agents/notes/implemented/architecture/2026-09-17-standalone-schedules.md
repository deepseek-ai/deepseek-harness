# Agent Note: Standalone schedules and Session targets

Status: implemented

English | [中文](2026-09-17-standalone-schedules.zh.md)

## Problem

Host tasks need global management and explicit delivery targets while remaining recognizable in their Workspace.

## Decision

The storage domain, importer, placeholder RRULE, and parallel API decisions are superseded by [typed rule storage and shared recurrence](2026-10-21-schedule-rule-storage.md). Keep the existing `schedule` domain and one management API; the target, execution, and notice decisions below remain current.

Targets are `session`, `new_once`, or `new`. `session` stores one existing Session id; create and edit check, without activating that Session, that it exists and does not belong to a delegated child. `new_once` reserves a Session id when the task is created or retargeted, creates that exact Session at first delivery, and then becomes `session`. `new` saves a reserved Session id in `pendingDelivery` before each create attempt, so a retry after a failed delivery uses the same Session. A created Session uses the target's working directory and Agent preset, or the Host defaults. When the target names a working directory, the Session joins the Workspace registered there, if any. While the Session has no title, it takes the task title; a `new` target adds the Session's creation minute in the timing rule's zone, for example `Weekday digest · 2026-10-12 09:00`, so the Sessions of successive deliveries stay distinguishable. A failed join or rename is logged and does not block delivery. `involvedSessionIds` lists the creating and editing Agent Sessions and each existing or reserved target Session in first-involvement order; Sessions that a `new` target creates are not listed.

The runtime keeps latest-only catch-up. It delivers the latest occurrence at or before the delivery decision and advances to the next future occurrence; an exhausted rule stays stored with `ended` status, and a paused task has no timer. Each delivery of one task, timed or manual, comes at least 60 seconds after the occurrence of the previous delivery, and the occurrence of a manual run is its run time; for a `new` target, whose every delivery creates a Session, a deployment can raise that interval through `newSessionIntervalSeconds`, which defaults to 60. The floor counts from the previous occurrence when the next stored occurrence keeps the interval, and from the previous acknowledgment otherwise, so acknowledgment latency does not accumulate and a late delivery does not shift later occurrences; the next on-time occurrence can then follow the late delivery by less than one interval. A task delivered to a reused Session, `session` or `new_once`, holds its execution slot until the target Agent is idle, and occurrences that become due meanwhile coalesce into one later delivery, so that Session has at most one pending delivery of the task; a `new` target holds no slot, and its launches run beside one another with only the delivery interval between them. Due tasks with a `session` target share one message per target Session, except After and At tasks. Manual run shares target resolution, the delivery interval, Session inbox persistence, the receipt, and the involvement update with timed delivery, but keeps the next occurrence and status. Both refuse an archived destination Session, including a reserved retry, because the archived-Session gate would block the turn that the message wakes. Session inbox persistence precedes the task receipt write, so a crash between the two stores can repeat a message. The implementation adds no scheduler, run, or ownership service.

After a committed create, update, or delete, Schedule queues a change notice on its own chain, so Session I/O never holds the mutation and delivery queue. Each involved Session other than the actor whose Agent is loaded receives a `schedule`-sourced message for its next model step that does not start a model turn, so notices queued while the Session is idle reach the model with its next input instead of each running as a model turn; the message names the change and carries the task id and title as JSON strings. A Session without a loaded Agent receives nothing and reads the current task when it next lists tasks. A notice failure is logged and does not roll back the committed change. Shutdown drains queued notices before storage closes.

## Alternatives considered

**Require a caller-supplied schedule id.** A user-facing title and canonical identity serve different purposes, but accepting ids would expose collision and validation policy. The Host generates identity and returns it for later operations.

**Keep creator Session ownership.** Ownership would keep list and mutation APIs scoped and would conflict with global management, retargeting, and Session creation policies. Historical involvement is metadata and notification routing, not authorization.

**Check spacing by sampling upcoming occurrences.** Each occurrence query enumerates from `DTSTART`, so a high-frequency rule with an early start blocked the Host thread before a sampled check could refuse it, and a sample cannot bound the complete sequence. Static rule checks before enumeration and the per-task delivery interval enforce the spacing instead.

**Add scheduler, run, and notification services.** The existing Schedule service, storage domain, runtime, and Session controller already own these responsibilities at the required scale. New layers would add indirection without changing durability.

**Leave created Sessions untitled and outside Workspaces.** Such a Session appears as one more untitled Session outside the Workspace that owns its directory, so the user cannot tell which task created it or, for a `new` target, which delivery it received. Joining the Workspace at the target directory and naming the Session after the task, with the creation minute for `new`, needs no stored field. A failure is only logged because delivery has priority over presentation.

## Consequences

Tasks outlive Agents and are managed by id. Archive admission reports active Session targets; explicit stop deletes tasks. Host availability, cross-store at-least-once delivery, best-effort notices, and unbounded per-delivery concurrency remain limitations. The [Schedule reference](../../../../docs/subsystems/schedule.md) owns the exact current contracts and the [management upgrade guide](../../../../docs/upgrade-guide/v0.2.2-alpha.2/schedule-remote-host-tasks/guide.md) covers changed callers.
