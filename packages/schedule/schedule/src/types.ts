/**
 * Durable and model-facing Schedule value types.
 * @module @deepseek-ai/dsh-schedule
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-session/types'
// Type-only: the Workspace registry's archive-admission family map this plugin merges `schedule` into.
import type {} from '@deepseek-ai/dsh-workspace/types'

/** Stable globally unique reminder identity. */
export type ScheduleId = Branded<'ScheduleId'>

/** Durable one-shot reminder created from a positive delay. */
export interface AfterScheduleRecord {
  /** Globally unique task identity. */
  readonly id: ScheduleId
  /** Rule discriminator for a delayed one-shot reminder. */
  readonly kind: 'after'
  /** Required stored task name; already trimmed, non-empty, and at most 120 characters. */
  readonly title: string
  /** Trimmed reminder content supplied at creation. */
  readonly prompt: string
  /** Positive safe-integer delay accepted at creation. */
  readonly afterSeconds: number
  /** Four-digit-year RFC 3339 UTC target. */
  readonly scheduledAt: string
}

/** Durable one-shot reminder created from an absolute instant. */
export interface AtScheduleRecord {
  /** Globally unique task identity. */
  readonly id: ScheduleId
  /** Rule discriminator for an absolute one-shot reminder. */
  readonly kind: 'at'
  /** Required stored task name; already trimmed, non-empty, and at most 120 characters. */
  readonly title: string
  /** Trimmed reminder content supplied at creation. */
  readonly prompt: string
  /** Four-digit-year RFC 3339 UTC target. */
  readonly scheduledAt: string
}

/** Durable fixed-rate reminder aligned to creation or its most recent interval edit. */
export interface EveryScheduleRecord {
  /** Globally unique task identity. */
  readonly id: ScheduleId
  /** Rule discriminator for a fixed-rate recurring reminder. */
  readonly kind: 'every'
  /** Required stored task name; already trimmed, non-empty, and at most 120 characters. */
  readonly title: string
  /** Trimmed reminder content supplied at creation. */
  readonly prompt: string
  /** Fixed safe-integer interval, never below one minute. */
  readonly everySeconds: number
  /** Next anchor-aligned occurrence while active, or final occurrence when inactive. */
  readonly scheduledAt: string
}

/** Durable daily wall-clock reminder; gaps skip a date and overlaps use the earlier instant. */
export interface DailyScheduleRecord {
  /** Globally unique task identity. */
  readonly id: ScheduleId
  /** Rule discriminator for a daily wall-clock reminder. */
  readonly kind: 'daily'
  /** Required stored task name; already trimmed, non-empty, and at most 120 characters. */
  readonly title: string
  /** Trimmed reminder content supplied at creation. */
  readonly prompt: string
  /** Local time normalized to HH:mm:ss.SSS. */
  readonly time: string
  /** Explicit IANA zone; equivalent timing edits retain the stored spelling. */
  readonly timeZone: string
  /** Committed next UTC instant while active, or final occurrence when inactive. */
  readonly scheduledAt: string
}

/** Durable weekly wall-clock reminder; gaps skip a date and overlaps use the earlier instant. */
export interface WeeklyScheduleRecord {
  /** Globally unique task identity. */
  readonly id: ScheduleId
  /** Rule discriminator for a weekly wall-clock reminder. */
  readonly kind: 'weekly'
  /** Required stored task name; already trimmed, non-empty, and at most 120 characters. */
  readonly title: string
  /** Trimmed reminder content supplied at creation. */
  readonly prompt: string
  /** Local time normalized to HH:mm:ss.SSS. */
  readonly time: string
  /** Explicit canonical IANA zone; equivalent timing edits retain the stored spelling. */
  readonly timeZone: string
  /** Unique ascending ISO weekdays, Monday 1 through Sunday 7. */
  readonly weekdays: number[]
  /** Committed next UTC instant while active, or final occurrence when inactive. */
  readonly scheduledAt: string
}

/** Durable cron wall-clock reminder; gaps skip a date and overlaps use the earlier instant. */
export interface CronScheduleRecord {
  /** Globally unique task identity. */
  readonly id: ScheduleId
  /** Rule discriminator for a five-field cron wall-clock reminder. */
  readonly kind: 'cron'
  /** Required stored task name; already trimmed, non-empty, and at most 120 characters. */
  readonly title: string
  /** Trimmed reminder content supplied at creation. */
  readonly prompt: string
  /** Canonical five-field cron expression: minute hour day-of-month month day-of-week. */
  readonly expression: string
  /** Explicit IANA zone; equivalent timing edits retain the stored spelling. */
  readonly timeZone: string
  /** Committed next UTC instant while active, or final occurrence when inactive. */
  readonly scheduledAt: string
}

/** Daily local-time selector accepted by creation and timing edits. */
export interface DailyInput {
  /** Local HH:mm:ss time with optional one-to-three fractional digits. */
  readonly time: string
  /** Explicit UTC or IANA Area/Location zone. */
  readonly time_zone: string
}

/** Weekly local-time and weekday selector accepted by creation and timing edits. */
export interface WeeklyInput {
  /** Local HH:mm:ss time with optional one-to-three fractional digits. */
  readonly time: string
  /** Explicit UTC or IANA Area/Location zone. */
  readonly time_zone: string
  /** Non-empty ISO weekday set, Monday 1 through Sunday 7, without repetitions. */
  readonly weekdays: number[]
}

/** Five-field cron selector accepted by creation and timing edits. */
export interface CronInput {
  /** Five-field Vixie cron expression: minute hour day-of-month month day-of-week. */
  readonly expression: string
  /** Explicit UTC or IANA Area/Location zone. */
  readonly time_zone: string
}

/** Structured local-calendar input accepted by creation and timing edits. */
export interface LocalAtInput {
  /** Four-digit ISO calendar date. */
  readonly date: string
  /** Local wall-clock time with optional one-to-three digit milliseconds. */
  readonly time: string
  /** Explicit UTC or IANA Area/Location zone. */
  readonly time_zone: string
}

/** Absolute selector accepted by creation and timing edits. */
export type AtInput = string | LocalAtInput

/** One-shot task variants. */
export type OneShotScheduleRecord = AfterScheduleRecord | AtScheduleRecord

/** One-shot delay persisted by a version-1 Session event, without the later `title`. */
export interface LegacyAfterScheduleRecord extends Omit<AfterScheduleRecord, 'title'> {
  /** Stored task name; absent in an event written before titles existed. */
  readonly title?: string
}

/** Absolute one-shot persisted by a version-1 Session event, without the later `title`. */
export interface LegacyAtScheduleRecord extends Omit<AtScheduleRecord, 'title'> {
  /** Stored task name; absent in an event written before titles existed. */
  readonly title?: string
}

/** Fixed-rate reminder persisted by a version-1 Session event, without the later `title`. */
export interface LegacyEveryScheduleRecord extends Omit<EveryScheduleRecord, 'title'> {
  /** Stored task name; absent in an event written before titles existed. */
  readonly title?: string
}

/**
 * Frozen Session event and fold vocabulary; daily rules belong only to Host storage.
 *
 * A version-1 event written before titles existed persists no `title` member, so
 * `after`, `at`, and `every` decode without one and stay readable. The Host task
 * record requires the member and never persists a record without it.
 */
export type LegacyScheduleRecord =
  | LegacyAfterScheduleRecord
  | LegacyAtScheduleRecord
  | LegacyEveryScheduleRecord

/** Recurring Host task variants. */
export type RecurringScheduleRecord = EveryScheduleRecord | DailyScheduleRecord | WeeklyScheduleRecord | CronScheduleRecord

/** Reminder rule and target, stored with its original Session binding. */
export type ScheduleRecord = OneShotScheduleRecord | RecurringScheduleRecord

/** Durable Session inbox delivery acknowledgment, not model execution completion. */
export interface ScheduleDeliveryReceipt {
  /** Canonical UTC target of the delivered occurrence. */
  readonly scheduledAt: string
  /** Canonical UTC time sampled after Session persistence acknowledged delivery. */
  readonly deliveredAt: string
  /** Identity of the delivered message, shared by tasks in one recurring batch. */
  readonly messageId: MessageId
}

/** Saved inbox delivery with its immutable sent prompt when recorded by this Host. */
export interface ScheduleDeliveryRecord extends ScheduleDeliveryReceipt {
  /** Prompt sent for this occurrence; unavailable for legacy receipts. */
  readonly prompt?: string
}

/** Browser-safe retained reminder with its original Session binding. */
export type ScheduleCatalogEntry = ScheduleRecord & {
  /** Session receiving this reminder when it becomes due. */
  readonly sessionId: SessionId
  /** Inactive reminders remain visible but never schedule another delivery. */
  readonly status: 'active' | 'inactive'
  /** Most recent durably acknowledged inbox delivery, when available. */
  readonly lastDelivery?: ScheduleDeliveryReceipt
}

/** Creates one durable reminder record. */
export interface ScheduleCreateChange {
  readonly version: 1
  readonly operation: 'create'
  readonly schedule: LegacyScheduleRecord
}

/** Deletes one currently active reminder. */
export interface ScheduleDeleteChange {
  readonly version: 1
  readonly operation: 'delete'
  readonly id: ScheduleId
}

/** Records that one active one-shot reminder entered the durable dispatch history. */
export interface OneShotScheduleDispatchChange {
  readonly version: 1
  readonly operation: 'dispatch'
  readonly id: ScheduleId
}

/** Records one fixed-rate decision and advances directly past missed occurrences. */
export interface EveryScheduleDispatchChange {
  readonly version: 1
  readonly operation: 'dispatch'
  readonly id: ScheduleId
  /** Wall-clock decision time used to select the latest due occurrence. */
  readonly acceptedAt: string
}

/** Durable dispatch shapes supported by the current rule set. */
export type ScheduleDispatchChange = OneShotScheduleDispatchChange | EveryScheduleDispatchChange

/** Strict version-1 durable Schedule mutation union. */
export type ScheduleChange = ScheduleCreateChange | ScheduleDeleteChange | ScheduleDispatchChange

/** Current delivery timing derived from the durable record and wall clock. */
export type ScheduleState = 'scheduled' | 'overdue'

/** Host-driven delivery resumes the original Session when needed. */
export type ScheduleDeliveryMode = 'host'

/** Complete model-facing view of one active reminder. */
export type ScheduleView = ScheduleRecord & {
  /** Whether the target remains in the future. */
  readonly state: ScheduleState
  /** Reminder delivery never leaves the owning session. */
  readonly deliveryMode: ScheduleDeliveryMode
}

/** Stable error returned for an empty, over-long, or untrimmed reminder prompt or title. */
export interface InvalidPromptError {
  readonly code: 'invalid_prompt'
  readonly message: string
}

/** Stable error returned for a missing, conflicting, or unsupported rule selector. */
export interface InvalidSelectorError {
  readonly code: 'invalid_selector'
  readonly message: string
}

/** Stable error returned for an invalid rule or management argument. */
export interface InvalidRuleError {
  readonly code: 'invalid_rule'
  readonly message: string
}

/** Stable error returned for an invalid or unsupported IANA time zone. */
export interface InvalidTimeZoneError {
  readonly code: 'invalid_time_zone'
  readonly message: string
}

/** Stable error returned when an absolute target is not strictly future. */
export interface NotFutureError {
  readonly code: 'not_future'
  readonly message: string
}

/** Stable error returned when the computed instant cannot use a four-digit UTC year. */
export interface TimeOutOfRangeError {
  readonly code: 'time_out_of_range'
  readonly message: string
}

/** Stable error returned when a fixed-rate rule runs more often than supported. */
export interface FrequencyTooHighError {
  readonly code: 'frequency_too_high'
  readonly message: string
}

/** Stable fallback that does not disclose an internal exception. */
export interface InternalScheduleError {
  readonly code: 'internal_error'
  readonly message: string
}

/** Closed v1 Schedule management error union. */
export type ScheduleToolError =
  | InvalidPromptError
  | InvalidSelectorError
  | InvalidRuleError
  | InvalidTimeZoneError
  | NotFutureError
  | TimeOutOfRangeError
  | FrequencyTooHighError
  | InternalScheduleError

/** Canonical `schedule_create` value. */
export type ScheduleCreateValue = ScheduleView | ScheduleToolError

/** Canonical `schedule_list` value. */
export type ScheduleListValue = ScheduleView[] | ScheduleToolError

/** Successful `schedule_delete` value, including the non-mutating not-found result. */
export type ScheduleDeleteResult =
  | { readonly id: ScheduleId; readonly deleted: true }
  | { readonly id: ScheduleId; readonly deleted: false; readonly code: 'schedule_not_found' }

/** Canonical `schedule_delete` value. */
export type ScheduleDeleteValue = ScheduleDeleteResult | ScheduleToolError

declare module '@deepseek-ai/dsh-workspace/types' {
  interface SessionActivityKindMap {
    /** A scheduled follow-up for this session is still active. */
    schedule: true
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Versioned Schedule mutation. The owning package validates the complete
     * session-local transition stream before accepting a candidate event.
     */
    'schedule/change': ScheduleChange
  }
}

/** Reminder creation selector, shared by the model consumer and Host service. */
export interface ScheduleCreateRequest {
  /** Non-empty reminder text. */
  prompt: string
  /** Required task name of at most 120 characters, non-empty after trimming; names the card, detail heading, and task lists. */
  title: string
  /** Relative one-shot delay in seconds. */
  after_seconds?: number
  /** Absolute one-shot target. */
  at?: AtInput
  /** Fixed recurrence interval in seconds. */
  every_seconds?: number
  /** Daily wall-clock time in an explicit IANA zone. */
  daily?: DailyInput
  /** Weekly wall-clock time and explicit ISO weekday set in an IANA zone. */
  weekly?: WeeklyInput
  /** Five-field cron expression evaluated in an explicit IANA zone. */
  cron?: CronInput
}

/** Session-scoped task list, without Agent activation. */
export interface ScheduleListRequest {
  /** Original Session binding. */
  sessionId: SessionId
}

/** Delete request identifying a task within its original Session binding. */
export interface ScheduleDeleteRequest extends ScheduleListRequest {
  /** Task to remove. */
  id: ScheduleId
}

/** Timing-only edit; it may select a different recurrence kind than the stored record, and one-shot targets use an absolute `at`. */
export type ScheduleTimingChange =
  | { readonly kind: 'at'; readonly at: AtInput }
  | { readonly kind: 'every'; readonly every_seconds: number }
  | { readonly kind: 'daily'; readonly daily: DailyInput }
  | { readonly kind: 'weekly'; readonly weekly: WeeklyInput }
  | { readonly kind: 'cron'; readonly cron: CronInput }

/** Replacement task name and instruction carried by one compare-and-update request. */
export interface ScheduleUpdateContent {
  /** Task name of at most 120 characters, non-empty after trimming; omitted keeps the stored name. */
  readonly title?: string
  /** Reminder instruction, non-empty after trimming; omitted keeps the stored instruction. */
  readonly prompt?: string
}

/** Compare-and-update request within the original Session binding. */
export interface ScheduleUpdateRequest extends ScheduleDeleteRequest, ScheduleUpdateContent {
  /** Complete record observed when editing began, including the committed target. */
  readonly expected: ScheduleRecord
  /** New timing; its kind may differ from the stored record's kind, and an omitted value keeps the committed target. */
  readonly change?: ScheduleTimingChange
}

/** Non-mutating compare-and-update outcome: unknown, inactive, or changed since the read. */
export interface ScheduleUpdateMiss {
  readonly id: ScheduleId
  readonly updated: false
  readonly code: 'schedule_not_found' | 'schedule_ended' | 'schedule_conflict'
}

/** Successful current record, non-mutating lookup/conflict failure, or invalid name/instruction/timing. */
export type ScheduleUpdateResult =
  | { readonly id: ScheduleId; readonly updated: boolean; readonly record: ScheduleRecord }
  | ScheduleUpdateMiss
  | ScheduleToolError

/** Canonical `schedule_update` value: the committed record as a view, or the non-mutating lookup/conflict result. */
export type ScheduleUpdateValue = ScheduleView | ScheduleUpdateMiss | ScheduleToolError

/** Explicitly bounded saved-delivery query within one Session binding. */
export interface ScheduleDeliveryHistoryRequest extends ScheduleDeleteRequest {
  /** Required safe-integer page size from 1 through 100. */
  limit: number
  /** Message identity of the oldest entry in the previous page; excluded from this page. */
  before?: MessageId
}

/** Configured limits applied when appending one task's delivery receipt. */
export interface DeliveryRetentionBounds {
  /** Retained window in days, measured back from the acknowledgment being appended. */
  readonly days: number
  /** Maximum retained records per task; the newest survive. */
  readonly records: number
}

/** Newest-first saved deliveries, or a non-mutating task/cursor lookup failure. */
export type ScheduleDeliveryHistoryResult =
  | {
    readonly id: ScheduleId
    readonly records: ScheduleDeliveryRecord[]
    /** Whether earlier delivery records may be unavailable; missing receipts are never reconstructed. */
    readonly earlierRecordsUnavailable: boolean
    /** True only after an append removed saved records; absent legacy evidence is false. */
    readonly earlierRecordsPruned: boolean
    /** Current Host retention configuration, also used by the delivery writer. */
    readonly retention: DeliveryRetentionBounds
    /** Oldest returned message identity, present only when older saved records remain. */
    readonly nextBefore?: MessageId
  }
  | { readonly id: ScheduleId; readonly code: 'schedule_not_found' | 'delivery_cursor_not_found' }

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Durable task set changed; clients refetch global task and Session-active catalogs.
     * @mode emit
     */
    'schedule/changed'(): void
  }
}
