# Session-local Schedule

English | [中文](schedule.zh.md)

Schedule owns durable reminders that return to the original live Session as ordinary later conversation turns. The [durable Schedule Agent Note](../../.agents/notes/implemented/feature/2026-08-05-durable-web-schedule.md) owns persistence, lifecycle, and active-state presentation, [conversational delivery](../../.agents/notes/implemented/simplification/2026-08-09-conversational-schedule-delivery.md) owns the no-receipt boundary, the [explicit time-zone boundary](../../.agents/notes/implemented/simplification/2026-08-09-explicit-schedule-time-zone.md) owns browser-local interpretation, and [bounded fixed-rate Schedule](../../.agents/notes/implemented/simplification/2026-08-09-bounded-fixed-rate-schedule.md) owns recurrence. This page records the durable and model-facing shapes from [`packages/schedule/schedule/src/types.ts`](../../packages/schedule/schedule/src/types.ts); the [package README](../../packages/schedule/schedule/README.md) owns composition, tool behavior, and the exact reminder framing.

## Durable records

`ScheduleId` is a [branded id](core.md#branded-ids), unique and never reused within one Session. Version 1 supports a positive safe-integer `after_seconds` delay, an explicit absolute `at` target, or a safe-integer `every_seconds` interval of at least five minutes. Creation canonicalizes every first target into a four-digit-year RFC 3339 UTC `scheduledAt`; an `after` record retains its submitted delay, an `at` record stores only the resulting instant, and an `every` record retains its fixed interval and next target.

```ts type-equiv
/** Durable one-shot reminder created from a positive delay. */
interface AfterScheduleRecord {
  /** Session-local stable identity. */
  readonly id: ScheduleId
  /** Rule discriminator for a delayed one-shot reminder. */
  readonly kind: 'after'
  /** Trimmed reminder content supplied at creation. */
  readonly prompt: string
  /** Positive safe-integer delay accepted at creation. */
  readonly afterSeconds: number
  /** Four-digit-year RFC 3339 UTC target. */
  readonly scheduledAt: string
}
```

```ts type-equiv
/** Durable one-shot reminder created from an absolute instant. */
interface AtScheduleRecord {
  /** Session-local stable identity. */
  readonly id: ScheduleId
  /** Rule discriminator for an absolute one-shot reminder. */
  readonly kind: 'at'
  /** Trimmed reminder content supplied at creation. */
  readonly prompt: string
  /** Four-digit-year RFC 3339 UTC target. */
  readonly scheduledAt: string
}
```

```ts type-equiv
/** Durable fixed-rate reminder whose next target remains creation-anchor-aligned. */
interface EveryScheduleRecord {
  /** Session-local stable identity. */
  readonly id: ScheduleId
  /** Rule discriminator for a fixed-rate recurring reminder. */
  readonly kind: 'every'
  /** Trimmed reminder content supplied at creation. */
  readonly prompt: string
  /** Fixed safe-integer interval, never below five minutes. */
  readonly everySeconds: number
  /** Earliest anchor-aligned occurrence not yet dispatched. */
  readonly scheduledAt: string
}
```

```ts type-equiv
/** One-shot record variants that terminate on an id-only dispatch. */
type OneShotScheduleRecord = AfterScheduleRecord | AtScheduleRecord
```

```ts type-equiv
/** The v1 durable reminder record union. */
type ScheduleRecord = OneShotScheduleRecord | EveryScheduleRecord
```

## Absolute-time input

The `at` selector is either a strict offset-bearing RFC 3339 string or an exact local-calendar object. The local form keeps its interpretation explicit at the tool boundary:

```ts type-equiv
/** Structured local-calendar input accepted by `schedule_create`. */
interface LocalAtInput {
  /** Four-digit ISO calendar date. */
  readonly date: string
  /** Local wall-clock time with optional one-to-three digit milliseconds. */
  readonly time: string
  /** Explicit UTC or IANA Area/Location zone. */
  readonly time_zone: string
}
```

```ts type-equiv
/** Absolute selector accepted by `schedule_create`. */
type AtInput = string | LocalAtInput
```

The official Web overlay samples the browser's IANA zone for every prompt. Time-context tells the model to interpret otherwise-unqualified natural-language dates and times in that request-local zone when the open turn has one unambiguous browser zone; mixed or missing provenance tells the model to ask. That guidance is not a durable Session default: the model must still pass an offset in the string form or `time_zone` in the local form, and Schedule never reads browser, Session, process, or model context.

Schedule rejects invalid offsets and zones, offset-free strings, non-future targets, and local times inside daylight-saving gaps. A daylight-saving overlap chooses its first, earlier instant. Successful creation stores only canonical UTC `scheduledAt`, so replay never depends on ambient time-zone state.

## Fixed-rate input and catch-up

`every_seconds` is a per-record interval of at least 300 seconds, anchored to creation time. It is fixed-rate recurrence only: the protocol has no calendar or Cron expression, recurrence time zone, shared cooldown, or cross-record admission gate.

When a Session was cold or busy across several targets, one Every record contributes only its latest due occurrence. The dispatch advances it directly to the first creation-anchor-aligned target after the dispatch decision time, without enumerating, persisting, or replaying missed intervals. If that next target cannot fit in a four-digit UTC year, the final dispatch terminates the record.

When multiple distinct Every records are overdue and no one-shot is due, each contributes one occurrence to the same follow-up batch in target and creation order. Every record keeps independent state, while all dispatches in that admitted batch use the same decision time. Batching bounds model turns; the five-minute minimum bounds each record's timer frequency.

## Durable changes and replay

The version-1 `schedule/change` Session event is the only durable Schedule authority. Create stores the complete record, and delete is a terminal id-only transition. A one-shot dispatch is also terminal and id-only. An Every dispatch carries the wall-clock decision time used to select its latest due occurrence and normally advances the active record instead of terminating it. Dispatch means the follow-up was synchronously queued, not that a model answer succeeded or the user read it.

```ts type-equiv
/** Creates one durable reminder record. */
interface ScheduleCreateChange {
  readonly version: 1
  readonly operation: 'create'
  readonly schedule: ScheduleRecord
}
```

```ts type-equiv
/** Deletes one currently active reminder. */
interface ScheduleDeleteChange {
  readonly version: 1
  readonly operation: 'delete'
  readonly id: ScheduleId
}
```

```ts type-equiv
/** Records that one active one-shot reminder entered the durable dispatch history. */
interface OneShotScheduleDispatchChange {
  readonly version: 1
  readonly operation: 'dispatch'
  readonly id: ScheduleId
}
```

```ts type-equiv
/** Records one fixed-rate decision and advances directly past missed occurrences. */
interface EveryScheduleDispatchChange {
  readonly version: 1
  readonly operation: 'dispatch'
  readonly id: ScheduleId
  /** Wall-clock decision time used to select the latest due occurrence. */
  readonly acceptedAt: string
}
```

```ts type-equiv
/** Durable dispatch shapes supported by the current rule set. */
type ScheduleDispatchChange = OneShotScheduleDispatchChange | EveryScheduleDispatchChange
```

```ts type-equiv
/** Strict version-1 durable Schedule mutation union. */
type ScheduleChange = ScheduleCreateChange | ScheduleDeleteChange | ScheduleDispatchChange
```

The strict decoder and fold reject unknown versions, extra fields, reused ids, mismatched one-shot or Every dispatch shapes, and delete or dispatch transitions against inactive records. A normal Session folds its complete event stream. A fork folds only events at or after its exact `inheritedEventCount`, so it retains history without adopting the parent Session's active reminders. Projection initialization receives that cut beside the immutable header, uses the shared transition, and persists both the cut, active records, and used-id history so cached restore preserves strict replay. The `schedule/change` declaration and source location are also indexed in the [persistence catalog](../persistence-catalog.md#schedulechange--log-only).

## Active views and management

Tool values combine the durable record with delivery state derived from the current wall clock. `session-local` means the original Session must be live: no external notification channel or cold-session scheduler exists.

```ts type-equiv
/** Current delivery timing derived from the durable record and wall clock. */
type ScheduleState = 'scheduled' | 'overdue'
```

```ts type-equiv
/** Fixed v1 delivery boundary: the original session must be live. */
type ScheduleDeliveryMode = 'session-local'
```

```ts type-equiv
/** Complete model-facing view of one active reminder. */
type ScheduleView = ScheduleRecord & {
  /** Whether the target remains in the future. */
  readonly state: ScheduleState
  /** Reminder delivery never leaves the owning session. */
  readonly deliveryMode: ScheduleDeliveryMode
}
```

The generated [tool catalog](../tool-catalog.md#deepseek-aidsh-schedule) owns the argument and result schemas for `schedule_create`, `schedule_list`, and `schedule_delete`. Management calls serialize with due work in one Agent-scoped queue. Every read or decision first waits for the shared Session persistence barrier; create and an actual delete wait again after appending. A barrier failure reports `persistence_uncertain` instead of guessing whether an eager write committed. The other stable error codes are `invalid_prompt`, `invalid_selector`, `invalid_rule`, `invalid_time_zone`, `not_future`, `time_out_of_range`, `frequency_too_high`, `corrupt_schedule_log`, and `internal_error`.

## Read-only Web catalog

When the optional Session projection registry is present, Schedule registers the client-visible `schedule` key whose value is the complete active `ScheduleRecord[]`. Live, cache, history, and detached reads use the same header-aware strict fold; malformed authoritative input fails the existing read path instead of publishing a partial value.

The shipped Web bundle keeps `ui-schedule` disabled by default, while the explicit Schedule overlay enables it together with the Host capability. [`dsh-client-ui-schedule`](../../packages/client/ui-schedule/README.md) owns the header interaction, [`dsh-client-ui-workspace`](../../packages/client/ui-workspace/README.md) owns list-row presentation, and the durable Schedule Agent Note owns their shared active-state boundary. The shared value represents current active state, never delivery history or a receipt; due reminders still appear through the ordinary Assistant output described below.

## Live delivery

The process-local owner derives its earliest timer from the durable fold and rereads the wall clock after every bounded wait. Cold Sessions do no work; reopening one reconstructs timers and makes past targets overdue. Due one-shots take priority and enter one later turn at a time. When no one-shot is due, all overdue Every records form the single batch described above.

Due work waits for the Agent to become fully idle and claims the maintenance phase before it refolds state, samples the decision, queues one `followup()`, and appends the corresponding dispatch changes. It never calls `steer()` and never interrupts a current turn.

The admitted one-shot or fixed-rate batch starts one normal later turn and appears only through the ordinary conversation transcript; Schedule has no independent durable Web receipt. The read-only active catalog above never represents delivery success. If framing or synchronous queue admission fails, no dispatch is recorded and the reminder stays active. The narrow crash interval after admission but before durable dispatch can repeat reminder content after recovery, so the boundary is best-effort at-least-once rather than exactly-once delivery.
