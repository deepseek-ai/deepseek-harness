/** Host-authoritative Session reading records, kept in memory, and their Remote service. */
import { Context, Service } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-api-remote-access'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { SessionReadFollower } from './feed.ts'
import type { SessionReadRecord } from './spec.ts'
import type { SessionReadAction, SessionReadFrame, SessionReadState } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the in-memory Session reading records behind the `sessionStatus` Remote namespace. */
    sessionStatus: SessionStatusService
  }
}

const emptyRecord: SessionReadRecord = {
  completedTurn: 0, failed: false, readTurn: 0, manualUnread: false,
}

/** Shared owner reading records; no reading operation changes model history. */
export class SessionStatusService extends TypertRemoteService {
  static inject = ['remoteAccess', 'sessions', 'sessionPersistence', 'typert']

  private readonly records = new Map<SessionId, SessionReadRecord>()
  private closing = false
  private readonly followers = new Set<SessionReadFollower>()

  /** @param ctx - Host services supplying Session events and metadata. */
  constructor(ctx: Context) {
    super(ctx, 'sessionStatus', { namespace: 'sessionStatus' })
  }

  protected [Service.init](): void {
    this.ctx.effect(() => () => {
      this.closing = true
      for (const follower of this.followers) follower.close()
      this.followers.clear()
      this.records.clear()
    }, 'session-status: close followers and discard records')
    // History recorded before this service started is read: only a turn that
    // ends while it runs can raise a reminder. A `turn/end` replayed from a
    // restored or forked log reaches no listener, so it raises none either.
    this.ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      this.complete(session.id, event.data.turn, event.data.reason.kind === 'error')
    })
  }

  /**
   * Update one Session; read positions advance only through Client-observed completions.
   * @param sessionId - Session identity.
   * @param action - Explicit reminder change or automatic read-position acknowledgement.
   * @throws RemoteError when closing, the Session is missing, or its metadata cannot be read.
   */
  @Remote
  async mark(sessionId: SessionId, action: SessionReadAction): Promise<void> {
    this.assertOpen()
    const sessions = this.ctx.sessions
    if (sessions.get(sessionId) === undefined) {
      let exists: boolean
      try {
        exists = await this.ctx.sessionPersistence.stat(sessionId) !== undefined
      } catch (cause) {
        throw this.unavailable(cause)
      }
      this.assertOpen()
      if (!exists) throw new RemoteError('session-status/not-found', 'Session no longer exists', { sessionId })
    }
    const record = this.records.get(sessionId) ?? emptyRecord
    const next = { ...record,
      manualUnread: action.type === 'acknowledge' ? record.manualUnread : action.type === 'unread',
      readTurn: action.type === 'unread' ? record.readTurn
        : Math.max(record.readTurn, Math.min(action.throughTurn, record.completedTurn)) }
    this.records.set(sessionId, next)
    this.publish(sessionId, next)
  }

  /**
   * Follow accessible reading records; every connection starts with a complete baseline.
   * @param signal - generation cancellation.
   * @returns the baseline and whole-record changes, filtered by Session access.
   * @throws RemoteError when the service is closing.
   */
  @Remote({ mode: 'stream' })
  async *follow(signal: AbortSignal): AsyncIterable<SessionReadFrame> {
    this.assertOpen()
    signal.throwIfAborted()
    const allowed = (id: SessionId): boolean => this.ctx.remoteAccess.allows({ kind: 'session', id })
    const follower = new SessionReadFollower()
    const access = this.followAccess(follower, AbortSignal.any([signal, follower.signal]))
    this.followers.add(follower)
    try {
      yield { type: 'baseline', items: [...this.records.entries()]
        .filter(([id]) => allowed(id)).map(([id, record]) => this.view(id, record)) }
      for await (const frame of follower.read(signal)) {
        if (allowed(frame.state.sessionId)) yield frame
      }
    } finally {
      this.followers.delete(follower)
      follower.close()
      await access
    }
  }

  private async followAccess(follower: SessionReadFollower, signal: AbortSignal): Promise<void> {
    try {
      for await (const frame of this.ctx.remoteAccess.follow(signal)) {
        if (frame.type !== 'baseline') break
      }
    } catch (cause) {
      follower.close(this.unavailable(cause))
    } finally {
      follower.close()
    }
  }

  private assertOpen(): void {
    if (this.closing) throw this.unavailable(new Error('Session status service is closing'))
  }

  private complete(sessionId: SessionId, turn: number, failed: boolean): void {
    const next: SessionReadRecord = { ...(this.records.get(sessionId) ?? emptyRecord), completedTurn: turn, failed }
    this.records.set(sessionId, next)
    this.publish(sessionId, next)
  }

  private view(sessionId: SessionId, record: SessionReadRecord): SessionReadState {
    return { sessionId, completedTurn: record.completedTurn, failed: record.failed,
      readTurn: record.readTurn, manualUnread: record.manualUnread }
  }

  private publish(sessionId: SessionId, record: SessionReadRecord): void {
    const state = this.view(sessionId, record)
    for (const follower of this.followers) follower.push({ type: 'changed', state })
  }

  private unavailable(cause: unknown): RemoteError {
    return new RemoteError('session-status/unavailable', 'Reading state could not be updated. Try the operation again; reload the page if synchronization is unavailable.', {}, { cause })
  }
}

export default SessionStatusService
