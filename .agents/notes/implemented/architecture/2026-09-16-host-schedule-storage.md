# Agent Note: Host-owned scheduled messages

Status: implemented

English | [中文](2026-09-16-host-schedule-storage.zh.md)

This note remains current for Host authority, whole-unit durability, and saved inbox receipts. [Typed rule storage](2026-10-21-schedule-rule-storage.md) and [Session targets](2026-09-17-standalone-schedules.md) replace its original management and target contracts.

## Problem

Scheduled messages must remain discoverable after restart without loading every Session. A timer attached to a live Agent cannot dispatch a task whose Session remains cold. Users also need to inspect pending and delivered tasks without activating their conversation; removing a task after delivery loses that management record.

## Decision

The original `schedule` domain and whole-unit layout remain authoritative; v2 accepts v1. [Typed rule storage](2026-10-21-schedule-rule-storage.md) supersedes the original Session-owned management API, top-level binding writes, and two-state lifecycle; [Session targets](2026-09-17-standalone-schedules.md) owns Host-wide management and delivery targets. The seven normal timing kinds preserve committed targets. An explicit target wins; absent targets read the old Session binding or reserve a stable new-once identity. No startup migration runs.

The task domain declares the whole-unit layout. Tasks are authoritative, so the JSON backend rejects an unreadable file, malformed document, unsupported version, or invalid task as a complete load failure instead of interpreting it as deletion. Failed recovery leaves `schedule.json` unchanged, while an initially absent file opens as an empty domain; repairing the file preserves task identity. `Service.init` waits for both storage validation and runtime setup, management methods wait for the same initialization result, and an unloading owner releases late-acquired storage without starting dispatch. Dispatch admission is separate from initialization: an ancestor can close Agent admission after a task mutation commits but before runtime cleanup starts. That refusal is logged without automatic retry and does not turn the persisted mutation into a failed management result. Invalid storage and failed cleanup registration still reject startup.

New tasks initialize an empty `deliveryHistory`. A task without that optional field exposes its existing latest receipt, if any, and marks earlier records unavailable. Reading never rewrites the old task or invents the lost history or instruction snapshot. Its next acknowledged delivery preserves that available receipt and appends the new one. Strict decoding rejects duplicate message ids and disagreement between the latest receipt and the last history entry. History follows append order, not wall-clock sorting, so clock rollback does not reverse acknowledged deliveries.

The client presentation derives from existing persisted data instead of widening a persisted format. The `schedule_create` transcript card reads the created task out of the call's model-visible result JSON, which already serializes the canonical task value, rather than declaring `presentationMeta`: a persisted metadata channel would add a durable field for a card that Session-log replay reconstructs from the result alone, and previously recorded Sessions render the card without a format change. The Sidebar Session-row clock mark occupies the root-scoped `sidebar.session.row.leading` seat rather than requesting a per-Session provider, because a Session-scoped seat would bind every listed Session and thereby activate and retain it; the same root-scoped owner share feeds `sidebar.session.row.hover`, and both read the shared Host catalog snapshot `schedule/catalog()` without reading a Session log.

Session inbox persistence and the task put occur in separate persistence systems. Inbox persistence precedes the task put to avoid marking delivery before its message exists. A crash or task-write failure after inbox persistence can repeat a message; storing status, target, and receipt together does not make the two stores atomic. Dispatch failures retain the task and produce a diagnostic; there is no independent retry timer. This feature does not create or replace a Goal.

## Alternatives considered

**Load every Session at startup.** Session activation is unnecessary for discovering tasks and would couple timer restoration to Agent initialization and conversation size.

**Introduce separate rule, run, scheduler, and delivery packages.** Durable schedules and their saved inbox receipts support task inspection without independent execution records or model completion tracking.

**Write history separately from the task.** The domain exposes independent per-record writes, not a multi-record transaction. Keeping history in the task row makes status, next target, latest receipt, and appended history commit together. A separate history store requires an explicit transactional or recovery design before adopting it.

**Advance before enqueue or promise exactly-once delivery.** Advance-first can lose a message on enqueue failure. Exactly-once delivery needs a shared transaction or a durable idempotency protocol that the two stores do not provide.

**Import every historical Session automatically.** A startup scan would reintroduce the cold-history dependency. Explicit recreation keeps the persisted authority unambiguous; historical decoding preserves access to existing logs.

**Represent daily reminders as 86,400-second intervals.** Fixed elapsed time cannot preserve a local wall-clock rule when offsets change. A distinct Daily record retains the rule needed to resolve each later date. Weekly extends the same decision with an explicit weekday set rather than a 604,800-second interval, so a later offset change still resolves each selected local date.

**Sample offsets manually or recalculate saved targets during decoding.** Temporal supplies maintained calendar and disambiguation behavior without a Schedule-owned offset search. A committed target remains due even when newer time-zone data would resolve the rule differently; only later targets use that data.

## Consequences

Task discovery and timers do not require loaded Sessions. History remains in the same task row and shares its acknowledgment commit; reads never invent missing prompts, timestamps, or earlier deliveries. Historical Session-log After, At, and Every remain frozen and do not populate this domain. The [Schedule reference](../../../../docs/subsystems/schedule.md) owns timing, management, UI projection, and retention contracts. The [built CLI test](../../../../apps/cli/tests/profiles/web/tests/schedule-timing.expected.e2e.ts) checks raw old rows, edit-time normalization, conflicts, and cold restart through public Remote requests; seeded receipts are retained-data evidence rather than delivery evidence.
