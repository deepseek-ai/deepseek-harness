/**
 * Canonical Session-log feedback for finalized assistant messages.
 * @module @deepseek-ai/dsh-message-feedback
 */

import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { Context, Service } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { deriveEventMessage, isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type {
  MessageFeedbackDeleteRequest,
  MessageFeedbackDeleteResult,
  MessageFeedbackFailure,
  MessageFeedbackItem,
  MessageFeedbackListRequest,
  MessageFeedbackListResult,
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

/** Required deployment policy for optional notes. */
export interface Config {
  /** Maximum UTF-8 byte length accepted for one note. */
  readonly maxNoteBytes: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    messageFeedback: MessageFeedbackService
  }
  interface Events {
    /**
     * Observe a durable cold feedback mutation without publishing a live Session.
     * Observers run before write ownership is released and must not await
     * another message-feedback operation for this Session. The payload is borrowed
     * read-only; deep-clone it before transferring ownership (for example, to Session.fromRestore).
     * @param inspection - committed canonical prefix, including the feedback as its last event.
     * @mode parallel
     */
    'feedback/committed'(inspection: SessionInspection): void
  }
}

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const itemSchema = z.object({
  messageId: z.string().min(1),
  rating: z.enum(['positive', 'negative']),
  note: z.string().refine(note => note.trim().length > 0).optional(),
  version: z.uuid(),
  createdAt: timestamp,
  updatedAt: timestamp,
}).refine(item => item.updatedAt >= item.createdAt)
const putSchema = z.object({ sessionId: z.string().min(1), item: itemSchema })
const deleteSchema = z.object({ sessionId: z.string().min(1), messageId: z.string().min(1) })

type FeedbackEvent = SessionEvent<'feedback/message-put' | 'feedback/message-delete'>
type Mutation = Pick<SessionEvent<'feedback/message-put'>, 'type' | 'data'>
  | Pick<SessionEvent<'feedback/message-delete'>, 'type' | 'data'>
type Append = (event?: Mutation) => Promise<void>
type MissingSession = MessageFeedbackRejected<MessageFeedbackSessionNotFound>
type ResolvedNote = MessageFeedbackSuccess<string | undefined>
  | MessageFeedbackRejected<MessageFeedbackNoteBlank | MessageFeedbackNoteTooLarge>

/** Return a caller-owned immutable value, detached from the log. */
function snapshotItem(item: MessageFeedbackItem): MessageFeedbackItem {
  return Object.freeze({ ...item })
}

function success<T>(value: T): MessageFeedbackSuccess<T> {
  return Object.freeze({ ok: true, value })
}

function rejected<E extends MessageFeedbackFailure>(error: E): MessageFeedbackRejected<E> {
  return Object.freeze({ ok: false, error: Object.freeze(error) })
}

/** Validate persisted payloads before deriving current, Session-owned feedback. */
function currentItems(sessionId: SessionId, events: readonly SessionEvent[]): MessageFeedbackItem[] {
  const items = new Map<MessageFeedbackItem['messageId'], MessageFeedbackItem>()
  for (const event of events) {
    switch (event.type) {
      case 'feedback/message-put':
        putSchema.parse(event.data)
        if (event.data.sessionId === sessionId) items.set(event.data.item.messageId, event.data.item)
        break
      case 'feedback/message-delete':
        deleteSchema.parse(event.data)
        if (event.data.sessionId === sessionId) items.delete(event.data.messageId)
        break
      default:
        // Other plugins' events do not change message feedback.
        break
    }
  }
  return [...items.values()]
}

/** Session-log service; cold operations never construct a Session or Agent. */
export class MessageFeedbackService extends TypertRemoteService {
  static inject = ['sessionPersistence', 'sessions']

  /** Loader validation for the required note-size policy. */
  static Config: s<Config> = s.object({
    maxNoteBytes: s.number().step(1).min(1).required(),
  })

  private readonly maxNoteBytes: number
  private readonly operationTails = new Map<SessionId, Promise<void>>()
  private mutationAdmissionOpen = true

  /**
   * @param ctx - Host context carrying Session persistence and live owners.
   * @param config - Required note-size policy.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'messageFeedback')
    if (!Number.isSafeInteger(config.maxNoteBytes) || config.maxNoteBytes < 1) {
      throw new TypeError('message-feedback: maxNoteBytes must be a positive safe integer')
    }
    this.maxNoteBytes = config.maxNoteBytes
  }

  protected [Service.init](): void {
    this.ctx.effect(() => async () => {
      this.mutationAdmissionOpen = false
      await Promise.all(this.operationTails.values())
    }, 'message-feedback.drain')
  }

  /**
   * Read current feedback from the canonical log.
   * @param request - Session to inspect.
   * @returns immutable items or a definite persistence miss.
   */
  @Remote('list')
  list(request: MessageFeedbackListRequest): Promise<MessageFeedbackListResult> {
    return this.enqueue(request.sessionId, () => this.withSession(request.sessionId, false, events =>
      success(Object.freeze({ items: Object.freeze(currentItems(request.sessionId, events).map(snapshotItem)) }))))
  }

  /**
   * Create or replace feedback after checking its current version.
   * Matching no-ops retain the version and append no event.
   * @param request - Target, desired value, and observed item version.
   * @returns the durable item or an explicit business failure.
   */
  @Remote('put')
  put(request: MessageFeedbackPutRequest): Promise<MessageFeedbackPutResult> {
    const note = this.resolveNote(request.note)
    if (!note.ok) return Promise.resolve(note)
    return this.enqueue(request.sessionId, () => this.withSession(request.sessionId, true, async (events, append) => {
      const items = currentItems(request.sessionId, events)
      if (!events.some(event => event.type === 'assistant/message'
        && isAppendSurfaceEvent(event)
        && deriveEventMessage(event)?.id === request.messageId)) {
        return rejected({ code: 'target-not-found', sessionId: request.sessionId, messageId: request.messageId })
      }
      const existing = items.find(item => item.messageId === request.messageId)
      if (request.ifVersion !== (existing?.version ?? null)) {
        return rejected(this.versionConflict(existing ?? null))
      }
      if (existing !== undefined && existing.rating === request.rating && existing.note === note.value) {
        await append()
        return success(snapshotItem(existing))
      }
      const now = Date.now()
      const item: MessageFeedbackItem = {
        messageId: request.messageId,
        rating: request.rating,
        ...(note.value === undefined ? {} : { note: note.value }),
        version: randomUUID() as MessageFeedbackVersion,
        createdAt: existing?.createdAt ?? now,
        updatedAt: existing === undefined ? now : Math.max(now, existing.updatedAt),
      }
      await append({ type: 'feedback/message-put', data: { sessionId: request.sessionId, item } })
      return success(snapshotItem(item))
    }))
  }

  /**
   * Delete one item after checking its version; absence succeeds without an event.
   * @param request - Session, message, and observed item version.
   * @returns the stable absent postcondition or an explicit failure.
   */
  @Remote('delete')
  delete(request: MessageFeedbackDeleteRequest): Promise<MessageFeedbackDeleteResult> {
    return this.enqueue(request.sessionId, () => this.withSession(request.sessionId, true, async (events, append) => {
      const existing = currentItems(request.sessionId, events).find(item => item.messageId === request.messageId)
      if (existing !== undefined) {
        if (request.ifVersion !== existing.version) return rejected(this.versionConflict(existing))
        await append({ type: 'feedback/message-delete', data: { sessionId: request.sessionId, messageId: request.messageId } })
      } else {
        await append()
      }
      return success(Object.freeze({ absent: true as const }))
    }))
  }

  /** Hold cold write ownership across read/compare/append; use live owners directly. */
  private async withSession<T>(
    sessionId: SessionId,
    write: boolean,
    operation: (events: readonly SessionEvent[], append: Append) => T | Promise<T>,
  ): Promise<T | MissingSession> {
    if (this.ctx.sessions.get(sessionId) === undefined
      && await this.ctx.sessionPersistence.stat(sessionId) === undefined
      && this.ctx.sessions.get(sessionId) === undefined) {
      return rejected({ code: 'session-not-found', sessionId })
    }
    const live = this.ctx.sessions.get(sessionId)
    if (live !== undefined) {
      return operation(live.snapshotEvents(), async (event) => {
        if (event !== undefined) {
          live.append(event.type, event.data)
        }
        const last = live.snapshotEvents().at(-1)
        if (!(await this.ctx.sessions.flush(live))) {
          throw new Error(
            `message-feedback: no durability listener participated for live session '${sessionId}'`,
          )
        }
        // Listener participation alone does not prove this Session has a persistence writer.
        const handle = await this.ctx.sessionPersistence.open(sessionId, 'read')
        try {
          const { events: stored } = await handle.read(last?.seq ?? 0, 1)
          if (!isDeepStrictEqual(
            [handle.header.id, handle.header.createdAt, handle.header.cwd],
            [live.header.id, live.header.createdAt, live.header.cwd],
          )
            || (last !== undefined && !isDeepStrictEqual(stored[0], last))) {
            throw new Error(`message-feedback: feedback prefix is not durable for live session '${sessionId}'`)
          }
        } finally {
          await handle.close()
        }
      })
    }
    const handle = await this.ctx.sessionPersistence.open(sessionId, write ? 'write' : 'read')
    try {
      const { events } = await handle.read()
      return await operation(events, async (event) => {
        const entry: FeedbackEvent | undefined = event === undefined ? undefined
          : { ...event, seq: SessionSeq(events.length), time: Date.now() }
        if (entry !== undefined) await handle.append([entry])
        await handle.flush()
        if (entry !== undefined) {
          try {
            await this.ctx.parallel('feedback/committed', {
              meta: handle.header,
              inheritedEventCount: handle.inheritedEventCount,
              events: [...events, entry],
            })
          } catch (error) {
            this.ctx.logger.warn('message-feedback: committed feedback observer failed', error)
          }
        }
      })
    } finally {
      await handle.close()
    }
  }

  private resolveNote(note: string | undefined): ResolvedNote {
    if (note === undefined) return success(undefined)
    if (note.trim().length === 0) return rejected({ code: 'note-blank' })
    const actualBytes = Buffer.byteLength(note, 'utf8')
    if (actualBytes > this.maxNoteBytes) {
      return rejected({ code: 'note-too-large', maxBytes: this.maxNoteBytes, actualBytes })
    }
    return success(note)
  }

  private versionConflict(current: MessageFeedbackItem | null): MessageFeedbackVersionConflict {
    return { code: 'version-conflict', current: current === null ? null : snapshotItem(current) }
  }

  /** Serialize complete operations and drain their handles before disposal. */
  private enqueue<T>(sessionId: SessionId, operation: () => Promise<T>): Promise<T> {
    if (!this.mutationAdmissionOpen) return Promise.reject(new Error('message-feedback: service is disposing'))
    const previous = this.operationTails.get(sessionId) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.operationTails.set(sessionId, tail)
    return result.finally(() => {
      if (this.operationTails.get(sessionId) === tail) this.operationTails.delete(sessionId)
    })
  }
}

export default MessageFeedbackService
