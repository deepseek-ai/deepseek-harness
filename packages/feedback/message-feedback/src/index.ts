/**
 * Durable, lifecycle-bound feedback for finalized assistant messages.
 * @module @deepseek-ai/dsh-message-feedback
 */

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { deriveEventMessage, isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { messageFeedbackDomainSpec } from './spec.ts'
import type { MessageFeedbackRow, MessageFeedbackSessionIdentity } from './spec.ts'
import type {
  MessageFeedbackDeleteRequest,
  MessageFeedbackDeleteResult,
  MessageFeedbackDeleteValue,
  MessageFeedbackFailure,
  MessageFeedbackItem,
  MessageFeedbackListRequest,
  MessageFeedbackListResult,
  MessageFeedbackListValue,
  MessageFeedbackNoteBlank,
  MessageFeedbackNoteTooLarge,
  MessageFeedbackPutRequest,
  MessageFeedbackPutResult,
  MessageFeedbackRejected,
  MessageFeedbackSessionNotFound,
  MessageFeedbackSuccess,
  MessageFeedbackVersion,
  MessageFeedbackVersionConflict,
} from './types.ts'

export type * from './types.ts'
export {
  messageFeedbackDomainSpec,
  messageFeedbackItemSchema,
  messageFeedbackRatingSchema,
  messageFeedbackRowSchema,
  messageFeedbackSessionIdentitySchema,
  messageFeedbackVersionSchema,
} from './spec.ts'
export type { MessageFeedbackRow, MessageFeedbackSessionIdentity } from './spec.ts'

/** Required deployment policy for optional notes. */
export interface Config {
  /** Maximum UTF-8 byte length accepted for one note. */
  readonly maxNoteBytes: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    messageFeedback: MessageFeedbackService
  }
}

/** Immutable empty list reused only as an input to caller-owned copying. */
const EMPTY_ITEMS: readonly MessageFeedbackItem[] = Object.freeze([])

/** Validate the one deployment-varying limit at the configuration boundary. */
function resolveMaxNoteBytes(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(
      `message-feedback: maxNoteBytes must be a positive safe integer, got ${String(value)}`,
    )
  }
  return value
}

/** Copy and freeze one item before it crosses the service boundary. */
function snapshotItem(item: MessageFeedbackItem): MessageFeedbackItem {
  return Object.freeze({
    messageId: item.messageId,
    rating: item.rating,
    ...(item.note === undefined ? {} : { note: item.note }),
    version: item.version,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  })
}

/** Copy and freeze a list response. */
function snapshotList(items: readonly MessageFeedbackItem[]): MessageFeedbackListValue {
  return Object.freeze({ items: Object.freeze(items.map(snapshotItem)) })
}

/** Build a frozen success branch. */
function success<T>(value: T): MessageFeedbackSuccess<T> {
  return Object.freeze({ ok: true, value })
}

/** Build a frozen business-failure branch. */
function rejected<E extends MessageFeedbackFailure>(error: E): MessageFeedbackRejected<E> {
  return Object.freeze({ ok: false, error: Object.freeze(error) })
}

/** Project the Session fields that distinguish one persisted log lifecycle. */
function identityOf(header: SessionHeader): MessageFeedbackSessionIdentity {
  return Object.freeze({
    createdAt: header.createdAt,
    ...(header.cwd === undefined ? {} : { cwd: header.cwd }),
  })
}

/** Whether a stored row belongs to the inspected Session lifecycle. */
function sameIdentity(row: MessageFeedbackRow, header: SessionHeader): boolean {
  return row.session.createdAt === header.createdAt && row.session.cwd === header.cwd
}

/** Whether two observations name the same persisted Session lifecycle. */
function sameHeaderIdentity(left: SessionHeader, right: SessionHeader): boolean {
  return left.id === right.id && left.createdAt === right.createdAt && left.cwd === right.cwd
}

/** Freeze the replacement row so storage-domain never exposes mutable aliases. */
function rowSnapshot(
  session: MessageFeedbackSessionIdentity,
  items: readonly MessageFeedbackItem[],
): MessageFeedbackRow {
  const copiedItems = items.map(snapshotItem)
  Object.freeze(copiedItems)
  return Object.freeze({
    session,
    items: copiedItems,
  })
}

/** Generate an opaque equality token for one material mutation. */
function nextVersion(): MessageFeedbackVersion {
  return randomUUID() as MessageFeedbackVersion
}

/** Observed session view: header identity plus the logged events. */
interface SessionObservation {
  readonly meta: SessionHeader
  readonly events: readonly SessionEvent[]
}

/** Session observation result that keeps absence inside the business union. */
type KnownSession =
  | MessageFeedbackSuccess<SessionObservation>
  | MessageFeedbackRejected<MessageFeedbackSessionNotFound>

/** Validated note or one explicit request failure. */
type ResolvedNote =
  | MessageFeedbackSuccess<string | undefined>
  | MessageFeedbackRejected<MessageFeedbackNoteBlank | MessageFeedbackNoteTooLarge>

/**
 * Storage-domain sidecar service. It inspects persisted Session history and
 * never creates or resumes an Agent or Session.
 */
export class MessageFeedbackService extends TypertRemoteService {
  static inject = ['storageDomain', 'sessionPersistence', 'sessions']

  /** Loader validation for the required note-size policy. */
  static Config: s<Config> = s.object({
    maxNoteBytes: s.number().step(1).min(1).required(),
  })

  private readonly maxNoteBytes: number
  private table?: KvTable<SessionId, MessageFeedbackRow>
  private readonly operationTails = new Map<SessionId, Promise<void>>()
  private mutationAdmissionOpen = true

  /**
   * @param ctx - Host context carrying persistence and the storage-domain form.
   * @param config - Required note-size policy.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'messageFeedback')
    this.maxNoteBytes = resolveMaxNoteBytes(config.maxNoteBytes)
  }

  /** Open and own the one message-feedback sidecar domain. */
  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(messageFeedbackDomainSpec)
    this.ctx.effect(() => async () => {
      this.mutationAdmissionOpen = false
      await Promise.all(this.operationTails.values())
      await domain.close()
    }, 'message-feedback.domainClose')
    this.table = domain.table('sessions')
  }

  /**
   * Read feedback belonging to the current persisted Session lifecycle.
   * A stale row from a reused Session id is invisible.
   * @param request - Session identity to inspect and list.
   * @returns current immutable items or `session-not-found`.
   */
  @Remote('list')
  async list(request: MessageFeedbackListRequest): Promise<MessageFeedbackListResult> {
    const known = await this.inspectSession(request.sessionId)
    if (!known.ok) return known
    const row = this.requireTable().get(request.sessionId)
    const items = row !== undefined && sameIdentity(row, known.value.meta) ? row.items : EMPTY_ITEMS
    return success(snapshotList(items))
  }

  /**
   * Create or replace feedback for one derived append-origin assistant
   * message. Every request must match the addressed item's current version;
   * a matching no-op returns the stored item without changing its revision.
   * @param request - target, desired value, and observed item version.
   * @returns the committed item or an explicit business failure.
   */
  @Remote('put')
  put(request: MessageFeedbackPutRequest): Promise<MessageFeedbackPutResult> {
    const note = this.resolveNote(request.note)
    if (!note.ok) return Promise.resolve(note)
    return this.enqueue(request.sessionId, async () => {
      const known = await this.inspectSession(request.sessionId)
      if (!known.ok) return known
      if (!this.hasFeedbackTarget(known.value, request.messageId)) {
        return rejected({
          code: 'target-not-found',
          sessionId: request.sessionId,
          messageId: request.messageId,
        })
      }

      const durable = await this.ensureTargetDurable(known.value)
      if (!sameHeaderIdentity(durable.meta, known.value.meta)
        || !this.hasFeedbackTarget(durable, request.messageId)) {
        return rejected({
          code: 'target-not-found',
          sessionId: request.sessionId,
          messageId: request.messageId,
        })
      }

      const table = this.requireTable()
      const stored = table.get(request.sessionId)
      const current = stored !== undefined && sameIdentity(stored, durable.meta) ? stored : undefined
      const items = current?.items ?? EMPTY_ITEMS
      const index = items.findIndex(item => item.messageId === request.messageId)
      const existing = items[index]
      if (request.ifVersion !== (existing?.version ?? null)) {
        return rejected(this.versionConflict(existing ?? null))
      }
      if (existing !== undefined
        && existing.rating === request.rating
        && existing.note === note.value) {
        return success(snapshotItem(existing))
      }

      const now = Date.now()
      const item = snapshotItem({
        messageId: request.messageId,
        rating: request.rating,
        ...(note.value === undefined ? {} : { note: note.value }),
        version: nextVersion(),
        createdAt: existing?.createdAt ?? now,
        updatedAt: existing === undefined ? now : Math.max(now, existing.updatedAt),
      })
      const nextItems = [...items]
      if (index === -1) nextItems.push(item)
      else nextItems[index] = item
      await table.put(
        request.sessionId,
        rowSnapshot(identityOf(durable.meta), nextItems),
      )
      return success(snapshotItem(item))
    })
  }

  /**
   * Delete one feedback item. Absence is successful regardless of the
   * supplied version; an existing item requires an exact version match.
   * @param request - Session, message, and observed item version.
   * @returns the stable absent postcondition, or an explicit failure.
   */
  @Remote('delete')
  delete(request: MessageFeedbackDeleteRequest): Promise<MessageFeedbackDeleteResult> {
    return this.enqueue(request.sessionId, async () => {
      const known = await this.inspectSession(request.sessionId)
      if (!known.ok) return known

      const table = this.requireTable()
      const stored = table.get(request.sessionId)
      const current = stored !== undefined && sameIdentity(stored, known.value.meta) ? stored : undefined
      const items = current?.items ?? EMPTY_ITEMS
      const existing = items.find(item => item.messageId === request.messageId)
      if (existing === undefined) {
        return success<MessageFeedbackDeleteValue>(Object.freeze({ absent: true }))
      }
      if (request.ifVersion !== existing.version) {
        return rejected(this.versionConflict(existing))
      }

      await table.put(
        request.sessionId,
        rowSnapshot(identityOf(known.value.meta), items.filter(item => item !== existing)),
      )
      return success<MessageFeedbackDeleteValue>(Object.freeze({ absent: true }))
    })
  }

  /**
   * Resolve a live owner directly; otherwise use `stat` as the existence
   * authority before reading the log. Read failures for a Session that `stat`
   * confirmed remain infrastructure failures rather than being guessed into
   * the business `session-not-found` branch.
   */
  private async inspectSession(sessionId: SessionId): Promise<KnownSession> {
    if (this.ctx.sessions.get(sessionId) === undefined) {
      if (await this.ctx.sessionPersistence.stat(sessionId) === undefined
        && this.ctx.sessions.get(sessionId) === undefined) {
        return rejected({ code: 'session-not-found', sessionId })
      }
    }
    return success(await this.observeSession(sessionId))
  }

  /** Observe a live owner's in-memory log when one exists, else the durable log. */
  private async observeSession(sessionId: SessionId): Promise<SessionObservation> {
    const live = this.ctx.sessions.get(sessionId)
    if (live !== undefined) return { meta: live.header, events: live.snapshotEvents() }
    return await this.readDurable(sessionId)
  }

  /** Read the complete durable log prefix through a fresh read handle. */
  private async readDurable(sessionId: SessionId): Promise<SessionObservation> {
    const handle = await this.ctx.sessionPersistence.open(sessionId, 'read')
    try {
      return { meta: handle.header, events: await handle.read() }
    } finally {
      await handle.close()
    }
  }

  /** Require the exact finalized append-origin assistant message projection. */
  private hasFeedbackTarget(observation: SessionObservation, messageId: MessageFeedbackItem['messageId']): boolean {
    return observation.events.some((event) => {
      if (event.type !== 'assistant/message' || !isAppendSurfaceEvent(event)) return false
      const message = deriveEventMessage(event)
      return message?.role === 'assistant' && message.id === messageId
    })
  }

  /**
   * Put the target log prefix behind a durability barrier before its sidecar.
   * A live owner flushes through the SessionStore's canonical checkpoint; the
   * physical durable prefix is then re-read, which observes at least the
   * flushed prefix by the `SessionPersistence` freshness guarantee.
   */
  private async ensureTargetDurable(observation: SessionObservation): Promise<SessionObservation> {
    const live = this.ctx.sessions.get(observation.meta.id)
    if (live !== undefined && sameHeaderIdentity(live.header, observation.meta)) {
      if (!(await this.ctx.sessions.flush(live))) {
        throw new Error(
          `message-feedback: no durability listener participated for live session '${observation.meta.id}'`,
        )
      }
    }
    return await this.readDurable(observation.meta.id)
  }

  /** Validate optional-note semantics and the configured complete UTF-8 byte bound. */
  private resolveNote(note: string | undefined): ResolvedNote {
    if (note === undefined) return success(undefined)
    if (note.trim().length === 0) return rejected({ code: 'note-blank' })
    const actualBytes = Buffer.byteLength(note, 'utf8')
    if (actualBytes > this.maxNoteBytes) {
      return rejected({ code: 'note-too-large', maxBytes: this.maxNoteBytes, actualBytes })
    }
    return success(note)
  }

  /** Return the authoritative item needed to reconcile one failed comparison. */
  private versionConflict(current: MessageFeedbackItem | null): MessageFeedbackVersionConflict {
    return {
      code: 'version-conflict',
      current: current === null ? null : snapshotItem(current),
    }
  }

  /** Queue a complete read/compare/write mutation behind this Session's prior mutation. */
  private enqueue<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
    if (!this.mutationAdmissionOpen) {
      return Promise.reject(new Error('message-feedback: service is disposing'))
    }
    const previous = this.operationTails.get(sessionId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.operationTails.set(sessionId, tail)
    return result.finally(() => {
      if (this.operationTails.get(sessionId) === tail) this.operationTails.delete(sessionId)
    })
  }

  /** Resolve the initialized durable table or fail a broken service lifecycle. */
  private requireTable(): KvTable<SessionId, MessageFeedbackRow> {
    if (this.table === undefined) {
      throw new Error('message-feedback: durable domain is not initialized')
    }
    return this.table
  }
}

export default MessageFeedbackService
