/**
 * Session-log batch assembly: one contiguous per-Session delivery batch per
 * flush. The assembler buffers captured ledger events per Session and reports
 * `SessionLogBatch` records to the OTel channel; it never spans Sessions.
 *
 * @module @deepseek-ai/dsh-session-telemetry-otel/batch
 */

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionLogBatch } from '@deepseek-ai/dsh-otel'
import { SeverityNumber } from '@opentelemetry/api-logs'

/** Captured ledger event handed to the assembler. */
export interface SessionLogBatchItem {
  /** Session the event belongs to; batches never span Sessions. */
  readonly sessionId: SessionId
  /** Session format generation the event sequence belongs to. */
  readonly formatVersion: number
  /** Complete event envelope with its already-redacted payload. */
  readonly event: Omit<SessionEvent, 'data'> & { data: unknown }
  /** Pre-mapped OTel severity; the batch reports the highest in its range. */
  readonly severityNumber: SeverityNumber
  /** Session working directory; the batch reports the first record's value. */
  readonly cwd?: string
  /** Parent Session id of a seeded Session; the batch reports the first record's value. */
  readonly parentSessionId?: string
  /** Inherited prefix length of a seeded Session; the batch reports the first record's value. */
  readonly seedLength?: number
}

/** Batch assembly limits resolved from plugin configuration. */
export interface SessionLogBatchOptions {
  /** Maximum events per batch. */
  readonly maxBatchEvents: number
  /** Maximum batch body JSON bytes, measured as the OTLP body `{"events":[...]}`. */
  readonly maxBatchBytes: number
  /** Maximum age in milliseconds of a batch's oldest buffered event. */
  readonly batchDelayMillis: number
}

/** Default maximum events per batch. */
export const DEFAULT_MAX_BATCH_EVENTS = 128
/** Default maximum batch body bytes (1 MiB). */
export const DEFAULT_MAX_BATCH_BYTES = 1_048_576
/** Default maximum batch age in milliseconds. */
export const DEFAULT_BATCH_DELAY_MILLIS = 1_000

/** Every batch this backend assembles is authorized conversation context. */
const BATCH_PURPOSE = 'conversation'
/** UTF-8 bytes of the empty body wrapper `{"events":[]}`. */
const EMPTY_BODY_BYTES = Buffer.byteLength('{"events":[]}')

/** Assembler state for one Session. */
interface SessionBatchState {
  readonly formatVersion: number
  /** Session working directory from the first captured record; constant for the Session. */
  readonly cwd: string | undefined
  /** Parent Session id from the first captured record; constant for the Session. */
  readonly parentSessionId: string | undefined
  /** Inherited prefix length from the first captured record; constant for the Session. */
  readonly seedLength: number | undefined
  /** First buffered event's seq minus one; recomputed for every new batch. */
  afterSeq: number
  /** Highest sequence appended in this Session, flushed or still buffered. */
  lastSeq: number
  events: SessionLogBatchItem['event'][]
  /** Exact body byte count of the buffered events. */
  bodyBytes: number
  severityNumber: SeverityNumber
  timer: ReturnType<typeof setTimeout> | undefined
  duplicateWarned: boolean
}

/**
 * Assembles captured Session events into contiguous delivery batches.
 *
 * Flush triggers, first one wins: the event-count ceiling, the body byte
 * ceiling, the oldest buffered event's age, and an explicit per-Session flush
 * for idle or closed Sessions. A Session's highest appended sequence is its
 * watermark, so one sequence never enters two batches while its state is
 * retained; a flush keeps the watermark, and closing the Session drops it.
 */
export class SessionLogBatcher {
  private readonly sessions = new Map<SessionId, SessionBatchState>()
  private stopped = false

  /**
   * @param options - resolved batch limits.
   * @param report - channel handoff for each formed batch; runs synchronously.
   * @param warn - diagnostic sink for unusable records and report failures.
   */
  constructor(
    private readonly options: SessionLogBatchOptions,
    private readonly report: (batch: SessionLogBatch) => void,
    private readonly warn: (message: string) => void,
  ) {}

  /**
   * Buffer one captured event, flushing whatever batch reached a ceiling.
   * @param item - captured ledger event and its Session identity.
   */
  push(item: SessionLogBatchItem): void {
    if (this.stopped) return
    let state = this.sessions.get(item.sessionId)
    if (state !== undefined && state.formatVersion !== item.formatVersion) {
      // A new format generation cannot share the previous generation's cursor.
      this.flushState(item.sessionId, state)
      this.sessions.delete(item.sessionId)
      state = undefined
    }
    const seq = Number(item.event.seq)
    if (state !== undefined && seq <= state.lastSeq) {
      if (!state.duplicateWarned) {
        state.duplicateWarned = true
        this.warn(`session telemetry ignored batch event ${String(seq)} for session "${String(item.sessionId)}"; it is already covered`)
      }
      return
    }
    if (state === undefined) {
      state = {
        formatVersion: item.formatVersion,
        cwd: item.cwd,
        parentSessionId: item.parentSessionId,
        seedLength: item.seedLength,
        afterSeq: -1,
        lastSeq: -1,
        events: [],
        bodyBytes: EMPTY_BODY_BYTES,
        severityNumber: SeverityNumber.INFO,
        timer: undefined,
        duplicateWarned: false,
      }
      this.sessions.set(item.sessionId, state)
    } else if (state.events.length > 0 && seq !== state.lastSeq + 1) {
      // One batch cannot cover a hole; close the contiguous prefix first.
      this.flushState(item.sessionId, state)
    }
    // The batch body carries `JSON.stringify(event)` per event, so the same
    // serialization measures exactly what will be sent.
    const eventBytes = Buffer.byteLength(JSON.stringify(item.event), 'utf8')
    if (state.events.length > 0 && state.bodyBytes + 1 + eventBytes > this.options.maxBatchBytes) {
      this.flushState(item.sessionId, state)
    }
    this.append(item.sessionId, state, item, seq, eventBytes)
    if (state.events.length >= this.options.maxBatchEvents || state.bodyBytes >= this.options.maxBatchBytes) {
      this.flushState(item.sessionId, state)
    }
  }

  /** Buffer one event and arm the batch-age timer on a new batch's first event. */
  private append(sessionId: SessionId, state: SessionBatchState, item: SessionLogBatchItem, seq: number, eventBytes: number): void {
    if (state.events.length === 0) {
      state.afterSeq = seq - 1
      state.timer = setTimeout(() => {
        state.timer = undefined
        this.flushState(sessionId, state)
      }, this.options.batchDelayMillis)
      state.timer.unref()
    }
    state.bodyBytes += (state.events.length === 0 ? 0 : 1) + eventBytes
    state.events.push(item.event)
    state.lastSeq = seq
    if (item.severityNumber > state.severityNumber) state.severityNumber = item.severityNumber
  }

  /**
   * Flush one Session's buffered batch without forgetting its watermark.
   * @param sessionId - the Session whose idle or checkpoint boundary arrived.
   */
  flushSession(sessionId: SessionId): void {
    const state = this.sessions.get(sessionId)
    if (state !== undefined) this.flushState(sessionId, state)
  }

  /**
   * Flush one Session's buffered batch and drop its watermark, e.g. after disposal.
   * @param sessionId - the closed Session.
   */
  closeSession(sessionId: SessionId): void {
    const state = this.sessions.get(sessionId)
    if (state === undefined) return
    this.flushState(sessionId, state)
    this.sessions.delete(sessionId)
  }

  /** Flush every buffered batch, release timers, and reject later events. */
  shutdown(): void {
    this.stopped = true
    for (const [sessionId, state] of this.sessions) this.flushState(sessionId, state)
    this.sessions.clear()
  }

  /** Form one batch from the buffered prefix, then reset the buffer. */
  private flushState(sessionId: SessionId, state: SessionBatchState): void {
    if (state.timer !== undefined) {
      clearTimeout(state.timer)
      state.timer = undefined
    }
    if (state.events.length === 0) return
    const batch: SessionLogBatch = {
      sessionId,
      formatVersion: state.formatVersion,
      ...state.cwd === undefined ? {} : { cwd: state.cwd },
      ...state.parentSessionId === undefined ? {} : { parentSessionId: state.parentSessionId },
      ...state.seedLength === undefined ? {} : { seedLength: state.seedLength },
      afterSeq: state.afterSeq,
      throughSeq: state.lastSeq,
      batchId: randomUUID(),
      purpose: BATCH_PURPOSE,
      events: state.events,
      severityNumber: state.severityNumber,
    }
    state.events = []
    state.bodyBytes = EMPTY_BODY_BYTES
    state.severityNumber = SeverityNumber.INFO
    try {
      this.report(batch)
    } catch (error) {
      this.warn(`session telemetry batch report failed: ${String(error)}`)
    }
  }
}
