# Agent Note: Durable scheduled reminders

Status: implemented

English | [中文](2026-08-05-durable-web-schedule.zh.md)

The [Host-owned scheduled messages decision](../architecture/2026-09-16-host-schedule-storage.md) owns task storage, timer activation, dispatch, delivery records, and the task catalog. This note owns the two timing decisions that survive it — the explicit absolute-time boundary and bounded fixed-rate arithmetic — and the queue-admission boundary they share.

## Problem

A reminder created inside a conversation must remain attributable to that exact Session and survive a process restart. Busy Agents, long waits, wall-clock changes, cold Sessions, and persistence failures make a simple timeout insufficient. Absolute calendar input and repeated wake-ups raise two timing questions that storage and activation choices do not answer: what an absolute time means when no recurring rule stores a zone, and how a fixed interval catches up after downtime without replaying every missed occurrence.

## Decision

### Explicit absolute-time boundary

Natural-language interpretation and Schedule parsing are deliberately separate ([time-zone simplification](../simplification/2026-08-09-explicit-schedule-time-zone.md)). Each browser prompt carries its Host-validated IANA zone only on that durable user message. Time-context tells the model to assume that zone for otherwise-unqualified dates and times. Schedule neither imports that plugin nor stores a Session zone: the model must turn its interpretation into an offset-bearing RFC 3339 value or a local object with explicit `time_zone`.

Schedule validates exact calendar shapes, offsets, zone names, and a strictly future four-digit-year instant. A structured local time inside a daylight-saving gap is rejected; an overlap chooses its first, earlier instant. A one-time `at` or `after` record stores only the canonical UTC `scheduledAt`, not the input offset, local fields, or zone. A `daily`, `weekly`, or `cron` record instead stores its normalized local rule with an explicit `timeZone` ([timing selectors](../../../../packages/schedule/schedule/README.md)).

### Bounded fixed-rate semantics

Every is a fixed-duration interval, not a calendar rule. Its first target is creation time plus the interval. At a due decision, integer division selects the latest sequence point at or before the sampled wall clock and the first sequence point after it. The selected occurrence is presented once and the record advances directly to the future target, so a cold Session never accumulates a replay backlog and delayed model work never shifts the sequence. Every, Daily, Weekly, and Cron records overdue for one Session share one message, and each record contributes only its latest occurrence ([storage and dispatch](../architecture/2026-09-16-host-schedule-storage.md)).

A five-minute minimum bounds wake and model-request frequency. There is no cross-record cooldown, gate, quota, or retained batch timestamp. If the next sequence point would exceed the four-digit-year storage range, dispatch terminates that record.

### Queue admission is not completion

Dispatch records queue admission, not model completion or user receipt. Framing or synchronous enqueue failure appends no dispatch. A crash after follow-up admission but before the durable receipt can repeat the reminder after recovery; the design makes no exactly-once promise.

## Alternatives considered

**Use `ctx.jobs`.** Jobs own process-local work, outcomes, and notifications rather than durable task state and conversation follow-ups.

**Persist a Session time zone and infer local `at`.** This spreads one interpretive default through Session core, Host create/fork, persistence formats, clients, and mismatch recovery. Request-local model guidance plus an explicit tool boundary deletes that coupling.

**Claim dispatch before `followup()` or add exactly-once fencing.** Claim-first can silently lose a reminder when enqueue fails. Cross-process exactly-once needs a lease, outbox, acknowledgement, and downstream idempotency boundary outside this design.

**Add a general recurring-rule engine for fixed intervals.** Fixed-duration intervals need only anchor arithmetic. A shared recurrence abstraction, global admission gate, and calendar evaluator would enlarge replay and runtime state without serving fixed-rate behavior. The cron selector is a separate wall-clock rule with its own Host-owned dialect and evaluation ([cron input](../../../../docs/subsystems/schedule.md#cron-wall-clock-input)).

## Verification

Package tests pin fixed-rate arithmetic, creation anchors, latest-only catch-up, batch selection, IANA validation, daylight-saving gaps and overlaps, and time bounds at per-file 100% coverage. A property test compares Every calculation and replay across varied intervals and skipped spans.

## Consequences

- Absolute input is deterministic without persistent Session-zone state or a dependency from Schedule to time-context.
- A fixed interval stays aligned to its creation anchor, presents one occurrence per overdue record, and cannot accumulate a replay backlog.
- Delivery never overstates model success or acknowledgment, and a crash between queue admission and the durable receipt can repeat a message.
