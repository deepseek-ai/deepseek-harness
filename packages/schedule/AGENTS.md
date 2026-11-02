# AGENTS.md — Schedule packages

These rules supplement the repository and package instructions for `packages/schedule/*`.

- Keep the `schedule` domain, backend routing, envelope, and whole-unit layout. Version 2 accepts version 1 through `compatibleVersions`; reads never write, and an edit stores the selected row in the current format. Current-version envelopes may contain untouched older rows. No importer or separate migration store.
- Every timing record has one normal kind: `after`, `at`, `every`, `daily`, `weekly`, `cron`, or `rrule`. Cron expression and time zone stay authoritative. Shared `dsh-util-time` owns pure Cron/RRULE parsing and bounded occurrence arithmetic; Schedule owns task policy and domain errors.
- Use one management API for Browser and Agent callers. Reads and deletion never activate a Session. Change notices run separately after commit as non-waking next-step messages to loaded involved Agents.
- Store explicit delivery targets. Ignore old top-level `sessionId` when a target exists; without one, use that binding or default to a stable reserved `new_once` target. Never write the old top-level binding. Keep new metadata optional when its historical value is unknown.
- Targets are one existing Session, one reserved-and-reused new Session, or a new Session per delivery. Validate an existing Session without activation; arming rechecks availability inside the mutation FIFO. Persist `pendingDelivery` before creating a `new` target. Due recurring tasks with a `session` target batch together; After and At use solo messages.
- Enqueue with source kind `schedule`, await Session persistence, then retire or advance the task. These writes are not atomic: a crash can duplicate delivery. A receipt is not model completion. Keep minimum delivery intervals and bounded recurrence evaluation for every kind.
- Failed delivery leaves the task stored and reports the failure. No generic retry loop. Shutdown drains accepted work and queued notices before closing storage.
- Historical `schedule/change` event types stay frozen for stored Session logs. No runtime interpreter, warning hook, replay, or importer remains for those reminders. Preserve version-1 Host task reads and write the current row format on edit or delivery.
- Keep recurrence arithmetic pure. Production uses platform wall time and segmented timers; tests use explicit samples or restored fake timers.
