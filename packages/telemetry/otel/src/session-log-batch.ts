/** Batched Session-log records: one OTLP record per contiguous per-Session delivery batch. */
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SeverityNumber } from '@opentelemetry/api-logs'

/** One canonical event envelope with its separately redacted payload. */
export type SessionLogBatchEvent = Omit<SessionEvent, 'data'> & { data: unknown }

/**
 * One delivery batch reported as one OTLP log record. A batch covers a single
 * Session's contiguous sequence range: {@link events} are exactly
 * {@link afterSeq} + 1 .. {@link throughSeq} with no hole. Batches never mix
 * Sessions or purposes, and {@link batchId} is unique per formed batch.
 */
export interface SessionLogBatch {
  /** Session the whole range belongs to. */
  readonly sessionId: SessionId
  /** Session format generation the sequence numbers belong to. */
  readonly formatVersion: number
  /** Sequence before this batch's first event; skipped sequences are never covered. */
  readonly afterSeq: number
  /** Highest sequence represented by {@link events}. */
  readonly throughSeq: number
  /** Session working directory at capture time; omitted when the Session header carries none. */
  readonly cwd?: string
  /** Parent Session id of a seeded (forked) Session; omitted for unseeded Sessions. */
  readonly parentSessionId?: string
  /** Exact inherited prefix length of a seeded Session; omitted for unseeded Sessions. */
  readonly seedLength?: number
  /** Idempotency key; a UUID unique to this formed batch. */
  readonly batchId: string
  /**
   * Delivery purpose: {@link BATCH_PURPOSE_CONVERSATION} today; session-title,
   * compaction, auto-review, and translation are reserved for later capture paths.
   */
  readonly purpose: string
  /** Complete event envelopes for every sequence from {@link afterSeq} + 1 through {@link throughSeq}. */
  readonly events: readonly SessionLogBatchEvent[]
  /** Highest event severity in the batch; omitted uses INFO. */
  readonly severityNumber?: SeverityNumber
}
