/**
 * Durable and model-facing Schedule value types.
 * @module @deepseek-ai/dsh-schedule/types
 */

import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-typert-protocol'
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
 * Frozen historical Session-event record types, independent of Host task storage.
 *
 * A version-1 event written before titles existed persists no `title` member, so
 * `after`, `at`, and `every` retain that absence. These events never become Host
 * tasks; every Host task record requires a title.
 */
export type LegacyScheduleRecord =
  | LegacyAfterScheduleRecord
  | LegacyAtScheduleRecord
  | LegacyEveryScheduleRecord

/** Recurring Host task variants. */
export type RecurringScheduleRecord =
  | EveryScheduleRecord
  | DailyScheduleRecord
  | WeeklyScheduleRecord
  | CronScheduleRecord
  | RRuleScheduleRecord

/** Historical Session-local reminder creation. */
export interface ScheduleCreateChange {
  readonly version: 1
  readonly operation: 'create'
  readonly schedule: LegacyScheduleRecord
}

/** Historical Session-local reminder deletion. */
export interface ScheduleDeleteChange {
  readonly version: 1
  readonly operation: 'delete'
  readonly id: ScheduleId
}

/** Historical one-shot reminder dispatch. */
export interface OneShotScheduleDispatchChange {
  readonly version: 1
  readonly operation: 'dispatch'
  readonly id: ScheduleId
}

/** Historical fixed-rate reminder dispatch. */
export interface EveryScheduleDispatchChange {
  readonly version: 1
  readonly operation: 'dispatch'
  readonly id: ScheduleId
  /** Wall-clock decision time used to select the latest due occurrence. */
  readonly acceptedAt: string
}

/** Frozen dispatch variants in historical Session logs. */
export type ScheduleDispatchChange = OneShotScheduleDispatchChange | EveryScheduleDispatchChange

/** Frozen version-1 Schedule mutation union retained in Session event types. */
export type ScheduleChange = ScheduleCreateChange | ScheduleDeleteChange | ScheduleDispatchChange

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

/** Stable error returned when a fixed-rate or RRULE rule runs more often than supported. */
export interface FrequencyTooHighError {
  readonly code: 'frequency_too_high'
  readonly message: string
}

/** Stable error returned when the target Session belongs to subagent routing, which never receives reminder delivery. */
export interface SubagentSessionError {
  readonly code: 'subagent_session'
  readonly message: string
}

/** Stable fallback that does not disclose an internal exception. */
export interface InternalScheduleError {
  readonly code: 'internal_error'
  readonly message: string
}

/** Schedule management error union. */
export type ScheduleToolError =
  | InvalidPromptError
  | InvalidSelectorError
  | InvalidRuleError
  | InvalidTimeZoneError
  | NotFutureError
  | TimeOutOfRangeError
  | FrequencyTooHighError
  | SubagentSessionError
  | InternalScheduleError

/** Input failure codes; every member except `internal_error` of the management error union. */
export type ScheduleInputErrorCode = Exclude<ScheduleToolError['code'], 'internal_error'>

/** Deletion outcome, including the non-mutating not-found result. */
export type ScheduleDeleteResult =
  | { readonly id: ScheduleId; readonly deleted: true }
  | { readonly id: ScheduleId; readonly deleted: false; readonly code: 'schedule_not_found' }

/** Configured limits applied when appending one task's delivery receipt. */
export interface DeliveryRetentionBounds {
  /** Retained window in days, measured back from the acknowledgment being appended. */
  readonly days: number
  /** Maximum retained records per task; the newest survive. */
  readonly records: number
}

/** RFC 5545 timing with an explicit DTSTART anchor and zone. */
export interface RRuleScheduleRecord {
  readonly kind: 'rrule'
  /** Host-generated canonical identity. */
  readonly id: ScheduleId
  /** Task name; already trimmed, non-empty, and at most 120 characters. */
  readonly title: string
  /** Trimmed instruction sent when an occurrence becomes due. */
  readonly prompt: string
  /** One normalized DTSTART line and one RRULE line. */
  readonly rrule: string
  /** Next unaccepted occurrence while active, or the final accepted occurrence when ended. */
  readonly scheduledAt: string
}

/** Current timing records; every kind is authoritative and uses the normal evaluator. */
export type ScheduleRecord = OneShotScheduleRecord | RecurringScheduleRecord

/** Timing accepted by the shared management API. */
export type ScheduleTiming =
  | { readonly kind: 'after'; readonly after_seconds: number }
  | { readonly kind: 'at'; readonly at: AtInput }
  | { readonly kind: 'every'; readonly every_seconds: number }
  | { readonly kind: 'daily'; readonly daily: DailyInput }
  | { readonly kind: 'weekly'; readonly weekly: WeeklyInput }
  | { readonly kind: 'cron'; readonly cron: CronInput }
  | { readonly kind: 'rrule'; readonly rrule: string }

/** Values used when a target creates a Session. */
export interface ScheduleSessionCreateSpec {
  /** Project directory of the created Session, which joins the Workspace registered there; omission uses the Host project directory. */
  readonly cwd?: string
  /** Agent preset of the created Session; omission uses the default preset. */
  readonly agentPreset?: string
}

/** Stored delivery destination; it is independent of the Session that manages the task. */
export type ScheduleTarget =
  | {
    /** Every occurrence goes to one existing Session. */
    readonly kind: 'session'
    /** Session that receives each delivery. */
    readonly sessionId: SessionId
  }
  | {
    /** The first delivery creates one Session; later deliveries go to that Session. */
    readonly kind: 'new_once'
    /** Reserved at creation; the first delivery creates it and the target becomes `session`. */
    readonly sessionId: SessionId
    /** Values used to create the reserved Session. */
    readonly create: ScheduleSessionCreateSpec
  }
  | {
    /** Every delivery creates a fresh Session. */
    readonly kind: 'new'
    /** Values used to create each Session. */
    readonly create: ScheduleSessionCreateSpec
  }

/** Destination accepted by create and edit; the Host reserves the `new_once` Session id. */
export type ScheduleTargetRequest =
  | {
    /** Deliver to one existing Session that is not a delegated child. */
    readonly kind: 'session'
    /** Existing Session that receives each delivery. */
    readonly sessionId: SessionId
  }
  | {
    /** Create one Session at the first delivery. */
    readonly kind: 'new_once'
    /** Creation values; omission uses the Host defaults. */
    readonly create?: ScheduleSessionCreateSpec
  }
  | {
    /** Create a fresh Session at each delivery. */
    readonly kind: 'new'
    /** Creation values; omission uses the Host defaults. */
    readonly create?: ScheduleSessionCreateSpec
  }

/** Durable Session inbox delivery acknowledgment, not model execution completion. */
export interface ScheduleDeliveryReceipt {
  /** Canonical UTC target of the delivered occurrence. */
  readonly scheduledAt: string
  /** Canonical UTC time sampled after Session persistence acknowledged delivery. */
  readonly deliveredAt: string
  /** Identity of the delivered message, shared by tasks in one recurring batch. */
  readonly messageId: MessageId
  /** Session that durably accepted the delivered message. */
  readonly targetSessionId: SessionId
}

/** Saved inbox delivery with its immutable sent prompt when recorded by this Host. */
export interface ScheduleDeliveryRecord extends ScheduleDeliveryReceipt {
  /** Prompt sent for this occurrence; unavailable for legacy receipts. */
  readonly prompt?: string
}

/** Bounded newest-first query over the saved deliveries of one task. */
export interface ScheduleDeliveryHistoryRequest {
  /** Task whose saved deliveries are read. */
  readonly id: ScheduleId
  /** Required safe-integer page size from 1 through 100. */
  readonly limit: number
  /** Message identity of the oldest entry in the previous page; excluded from this page. */
  readonly before?: MessageId
}

/** One newest-first page of saved deliveries. */
export interface ScheduleDeliveryHistoryPage {
  /** Task whose saved deliveries this page lists. */
  readonly id: ScheduleId
  /** Saved deliveries, newest first. */
  readonly records: ScheduleDeliveryRecord[]
  /** Whether deliveries before the saved records may exist; the Host never reconstructs them. */
  readonly earlierRecordsUnavailable: boolean
  /** Whether a retention limit removed saved records; legacy history without that fact is false. */
  readonly earlierRecordsPruned: boolean
  /** Current Host retention limits; the delivery writer applies the same limits. */
  readonly retention: DeliveryRetentionBounds
  /** Cursor for the next page; present only when older saved records remain. */
  readonly nextBefore?: MessageId
}

/** Non-mutating miss: the task or the page cursor does not exist. */
export interface ScheduleDeliveryHistoryMiss {
  /** Requested task identity. */
  readonly id: ScheduleId
  /** `delivery_cursor_not_found` means `before` names no saved record of this task. */
  readonly code: 'schedule_not_found' | 'delivery_cursor_not_found'
}

/** One saved-delivery page, or a non-mutating lookup miss. */
export type ScheduleDeliveryHistoryResult = ScheduleDeliveryHistoryPage | ScheduleDeliveryHistoryMiss

/** Browser-safe Host task state. */
export type ScheduleCatalogEntry = ScheduleRecord & {
  /** Destination of the next delivery. */
  readonly target: ScheduleTarget
  /**
   * Sessions told about later changes while their Agent is live: the creating and editing Agent Sessions and each
   * existing or reserved target Session. Sessions created by a `new` target are excluded.
   */
  readonly involvedSessionIds: SessionId[]
  /** Only `active` tasks have a timer obligation; `paused` and `ended` tasks stay visible. */
  readonly status: 'active' | 'paused' | 'ended'
  /** Canonical UTC creation time. */
  readonly createdAt?: string
  /** Canonical UTC time of the latest stored change; editors send it back as `expectedUpdatedAt`. */
  readonly updatedAt?: string
  /**
   * The latest delivery is queued or running in its reused target Session; a `new` target, whose deliveries run beside one
   * another, never sets it.
   */
  readonly executionActive?: true
  /** End of the minimum delivery interval, present while it remains in the future. */
  readonly deliveryFloorEndsAt?: string
  /** Most recent durably acknowledged inbox delivery, when available. */
  readonly lastDelivery?: ScheduleDeliveryReceipt
}

/** Host task creation request. */
export interface ScheduleCreateRequest {
  /** Task name of at most 120 characters, non-empty after trimming. */
  readonly title: string
  /** Instruction sent at each occurrence; non-empty after trimming. */
  readonly prompt: string
  /** Authoritative typed timing with at least one future occurrence. */
  readonly timing: ScheduleTiming
  /** Delivery destination; omission creates one Session at first delivery and reuses it. */
  readonly target?: ScheduleTargetRequest
}

/** Host-wide task list request. */
export interface ScheduleListRequest {
  /** `true` lists only active tasks; `false` lists only paused and ended tasks; omission lists all tasks. */
  readonly active?: boolean
  /** Page size from 1 through 500; the default is 100. */
  readonly limit?: number
  /** Number of sorted tasks to skip; the default is 0. */
  readonly offset?: number
}

/** One page of the Host-wide task list; active tasks come first, ordered by next occurrence. */
export interface ScheduleListResult {
  /** Tasks in this page. */
  readonly items: ScheduleCatalogEntry[]
  /** Number of tasks in this page. */
  readonly shown: number
  /** Number of tasks that match the filter. */
  readonly total: number
  /** Applied page size. */
  readonly limit: number
  /** Applied offset. */
  readonly offset: number
}

/** Read one task by canonical identity. */
export interface ScheduleViewRequest {
  /** Task to read. */
  readonly id: ScheduleId
}

/** Non-mutating miss for an unknown task identity. */
export interface ScheduleNotFoundResult {
  /** Requested task identity. */
  readonly id: ScheduleId
  /** Lookup miss discriminator. */
  readonly code: 'schedule_not_found'
}

/** Current task state, or a lookup miss. */
export type ScheduleViewResult = ScheduleCatalogEntry | ScheduleNotFoundResult

/** Fields changed together by one atomic update; an omitted field keeps its stored value. */
export interface SchedulePatch {
  /** Replacement task name. */
  readonly title?: string
  /** Replacement instruction. */
  readonly prompt?: string
  /** Replacement timing; a changed rule recomputes the next occurrence. */
  readonly timing?: ScheduleTiming
  /** Replacement destination. */
  readonly target?: ScheduleTargetRequest
  /** `false` pauses the task; `true` resumes a recurrence from its first future occurrence. */
  readonly active?: boolean
}

/** One closed edit operation. */
export type ScheduleEditRequest =
  | {
    /** Task to change. */
    readonly id: ScheduleId
    /** Apply `patch` as one atomic change. */
    readonly action: 'update'
    /** Fields to change; at least one member is required. */
    readonly patch: SchedulePatch
    /** `updatedAt` value that the editor read; a different stored value returns `schedule_conflict`. */
    readonly expectedUpdatedAt?: string | null
  }
  | {
    /** Task to remove. */
    readonly id: ScheduleId
    /** Remove the task and its saved deliveries. */
    readonly action: 'delete'
    /** `updatedAt` value that the editor read; a different stored value returns `schedule_conflict`. */
    readonly expectedUpdatedAt?: string | null
  }

/** Non-mutating refusal: the stored task changed after the editor read it. */
export interface ScheduleConflictResult {
  /** Requested task identity. */
  readonly id: ScheduleId
  /** Optimistic revision mismatch discriminator. */
  readonly code: 'schedule_conflict'
}

/** Updated task state, a completed deletion, or a non-mutating miss or conflict. */
export type ScheduleEditResult =
  | ScheduleCatalogEntry
  | Extract<ScheduleDeleteResult, { readonly deleted: true }>
  | ScheduleNotFoundResult
  | ScheduleConflictResult

/** Manual execution request from the human task manager. */
export interface ScheduleRunRequest {
  /** Task to run now. */
  readonly id: ScheduleId
}

/** Non-mutating refusal: one execution of this task already owns its admission slot. */
export interface ScheduleExecutionPendingResult {
  /** Requested task identity. */
  readonly id: ScheduleId
  /** Consolidated execution discriminator. */
  readonly code: 'schedule_execution_pending'
}

/** Task state after a manual delivery, or a non-mutating miss or refusal. */
export type ScheduleRunResult = ScheduleCatalogEntry | ScheduleNotFoundResult | ScheduleExecutionPendingResult

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The Schedule request failed validation before it was stored. */
    'schedule/input-invalid': { readonly code: ScheduleInputErrorCode }
    /** A delivery or run reached a `session` target that the Workspace registry lists as archived. */
    'schedule/target-archived': { readonly sessionId: SessionId }
  }
}

/** Successful Host-wide removal of every ended task, whether or not any remained. */
export interface ScheduleDeleteInactiveResult {
  /** Ended task rows this call removed; zero when the Host held none. */
  readonly deleted: number
}

declare module '@deepseek-ai/dsh-workspace/types' {
  interface SessionActivityKindMap {
    /** A scheduled follow-up for this session is still active. */
    schedule: true
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Historical version-1 Session-local reminder mutation. New tasks live in Host storage;
     * these events remain inert and never populate the Host task store.
     */
    'schedule/change': ScheduleChange
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Durable task set changed; clients refetch global task and Session-active catalogs.
     * @mode emit
     */
    'schedule/changed'(): void
  }
}
