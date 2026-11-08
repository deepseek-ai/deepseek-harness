/** Client Session status table: running state, the effective pending interaction, and completion reminders. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionPendingInteraction } from '@deepseek-ai/dsh-client-ui-session/client'
// Retains ui-session's Context and Slot prop declarations for every consumer of this face.
export type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Independent UI status facts for one Session identity. */
export interface SessionStatus {
  /** Latest known running state; absent until a baseline or event establishes it. */
  readonly running: boolean | undefined
  /** Highest-precedence domain request currently awaiting user interaction. */
  readonly pendingInteraction: SessionPendingInteraction | undefined
  /** Whether an observed stop outside the main view still needs acknowledgement. */
  readonly completionUnread: boolean
}

/** Current UI status indexed by Session identity. */
export type SessionStatusSnapshot = ReadonlyMap<SessionId, SessionStatus>
/** Selector hook over the unified Session UI status snapshot. */
export type UseSessionStatus = SnapshotSelectorHook<SessionStatusSnapshot>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface GlobalStandardProps {
    useSessionStatus: UseSessionStatus
  }
}

declare module '@deepseek-ai/dsh-client-ui-session/client' {
  interface UiSessionService {
    /** Session status table; a plugin that reads it injects `uiSession.sessionStatus`. */
    readonly sessionStatus: UiSessionStatus
  }
}

/**
 * Session status table provided as the `uiSession.sessionStatus` service and read as `ctx.uiSession.sessionStatus`.
 * Completion reminders live only in this Client; the [status table reference](../../README.md#status-table) states
 * when each field is set and cleared.
 */
export class UiSessionStatus extends Service implements HostObservable<SessionStatusSnapshot> {
  private readonly running = new Map<SessionId, boolean>()
  private readonly completionUnread = new Set<SessionId>()
  private statusSnapshot: SessionStatusSnapshot = new Map()
  private readonly statusListeners = new Set<() => void>()

  /**
   * @param ctx - Client root context.
   * @param sessions - Controller-owned Session catalog.
   * @param pendingInteractions - effective pending request by Session, published by ui-session.
   */
  constructor(
    ctx: Context,
    private readonly sessions: Pick<ISessions, 'list'>,
    private readonly pendingInteractions: HostObservable<ReadonlyMap<SessionId, SessionPendingInteraction>>,
  ) {
    super(ctx, 'uiSession.sessionStatus')
    ctx.effect(() => {
      const disposeStatus = sessions.list.subscribe(() => { this.reconcileStatus() })
      const disposeRemoteStatus = ctx.remote.$on('api-session/status', (sessionId, running) => {
        this.observeRunning(sessionId, running)
      })
      const disposePending = pendingInteractions.subscribe(() => { this.publishStatus() })
      this.reconcileStatus()
      return () => {
        disposeStatus()
        disposeRemoteStatus()
        disposePending()
      }
    }, 'session-status: Session status table')
  }

  /**
   * Read the current status table; the reference changes only when a status fact changes.
   * @returns status by Session identity.
   */
  readonly getSnapshot: () => SessionStatusSnapshot = () => this.statusSnapshot

  /**
   * Observe status table changes; a throwing listener is reported without stopping later listeners.
   * @param listener - called after each published change.
   * @returns unsubscribe.
   */
  readonly subscribe: (listener: () => void) => () => void = (listener) => {
    this.statusListeners.add(listener)
    return () => { this.statusListeners.delete(listener) }
  }

  private observeRunning(sessionId: SessionId, running: boolean): void {
    const previous = this.running.get(sessionId)
    const beforeBaseline = this.sessions.list.getSnapshot().phase === 'pending'
    this.running.set(sessionId, running)
    if (running) this.completionUnread.delete(sessionId)
    else if ((previous === true || (previous === undefined && beforeBaseline))
      && !this.isMain(sessionId)) this.completionUnread.add(sessionId)
    this.publishStatus()
  }

  private reconcileStatus(): void {
    const list = this.sessions.list.getSnapshot()
    const present = new Set(Object.keys(list.byId) as SessionId[])
    // Subagent catalog rows and retained subagent fallback rows do not establish Host running state.
    for (const id of list.ids) {
      const row = list.byId[id] as SessionSummary
      const previous = this.running.get(id)
      if (previous === undefined) this.running.set(id, row.running)
      else if (previous !== row.running) this.observeRunning(id, row.running)
    }
    for (const id of present) {
      if (this.isMain(id)) this.completionUnread.delete(id)
    }
    if (list.phase === 'ready') {
      for (const id of this.running.keys()) {
        if (present.has(id)) continue
        this.running.delete(id)
        this.completionUnread.delete(id)
      }
    }
    this.publishStatus()
  }

  private isMain(sessionId: SessionId): boolean {
    return (this.sessions.list.getSnapshot().byId[sessionId]?.retainedBy.mainView ?? 0) > 0
  }

  private publishStatus(): void {
    const pending = this.pendingInteractions.getSnapshot()
    const ids = new Set<SessionId>([
      ...(Object.keys(this.sessions.list.getSnapshot().byId) as SessionId[]),
      ...this.running.keys(),
      ...pending.keys(),
      ...this.completionUnread,
    ])
    const next = new Map<SessionId, SessionStatus>()
    for (const id of ids) {
      next.set(id, {
        running: this.running.get(id),
        pendingInteraction: pending.get(id),
        completionUnread: this.completionUnread.has(id),
      })
    }
    if (sameSessionStatus(this.statusSnapshot, next)) return
    this.statusSnapshot = next
    notifySubscribers(this.statusListeners, '[session-status] Session status')
  }
}

function sameSessionStatus(left: SessionStatusSnapshot, right: SessionStatusSnapshot): boolean {
  if (left.size !== right.size) return false
  for (const [id, status] of left) {
    const candidate = right.get(id)
    if (candidate === undefined
      || candidate.running !== status.running
      || candidate.pendingInteraction !== status.pendingInteraction
      || candidate.completionUnread !== status.completionUnread) return false
  }
  return true
}
