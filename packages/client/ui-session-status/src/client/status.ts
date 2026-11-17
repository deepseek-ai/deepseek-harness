/** Client Session status table: running state, the effective pending interaction, and shared reading reminders. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ISessions, SessionBinding, SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { HostObservable, SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only service merge for ctx.slots.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionPendingInteraction } from '@deepseek-ai/dsh-client-ui-session/client'
// Retains ui-session's Context and Slot prop declarations for every consumer of this face.
export type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionReadModel } from './model.ts'

/** Independent UI status facts for one Session identity. */
export interface SessionStatus {
  /** Latest known running state; absent until a baseline or event establishes it. */
  readonly running: boolean | undefined
  /** Highest-precedence domain request currently awaiting user interaction. */
  readonly pendingInteraction: SessionPendingInteraction | undefined
  /**
   * Host-confirmed unread completion or explicit unread mark; an unacknowledged completion of the open Session the
   * visible, focused main view retains is not shown until the view leaves it.
   */
  readonly completionUnread: boolean
  /** Latest unread completion ended with an execution error this Host observed. */
  readonly completionFailed: boolean
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
 * Completion reminders come from the Host reading records shared by every Client of one Host; the
 * [package reference](../../README.md#use-this-package) states when each field is set and cleared.
 */
export class UiSessionStatus extends Service implements HostObservable<SessionStatusSnapshot> {
  private readonly running = new Map<SessionId, boolean>()
  private statusSnapshot: SessionStatusSnapshot = new Map()
  private viewedBinding: SessionBinding | undefined
  private viewedOpenState: string | undefined
  private releaseViewed = (): void => {}
  private readonly statusListeners = new Set<() => void>()
  /**
   * Package-internal Client copy of the Host reading records, which the reading installer follows into.
   * @internal
   */
  readonly reading: SessionReadModel
  /** Whether reading marks can be sent: the current Host reading baseline has arrived. */
  readonly readingReady: HostObservable<boolean>

  /**
   * @param ctx - Client root context; its generated `sessionStatus` Remote namespace sends reading marks.
   * @param sessions - Controller-owned Session catalog and bindings.
   * @param pendingInteractions - effective pending request by Session, published by ui-session.
   */
  constructor(
    ctx: Context,
    private readonly sessions: Pick<ISessions, 'list' | 'binding'>,
    private readonly pendingInteractions: HostObservable<ReadonlyMap<SessionId, SessionPendingInteraction>>,
  ) {
    super(ctx, 'uiSession.sessionStatus')
    const reading = new SessionReadModel(ctx.remote.sessionStatus)
    this.reading = reading
    this.readingReady = {
      getSnapshot: () => reading.state.getSnapshot().ready,
      subscribe: listener => reading.state.subscribe(listener),
    }
    ctx.effect(() => {
      const disposeStatus = sessions.list.subscribe(() => { this.reconcileStatus() })
      const disposeRemoteStatus = ctx.remote.$on('api-session/status', (sessionId, running) => {
        this.observeRunning(sessionId, running)
      })
      const disposePending = pendingInteractions.subscribe(() => { this.publishStatus() })
      const disposeReading = reading.state.subscribe(() => { this.publishStatus() })
      const disposeView = watchViewVisibility(() => { this.publishStatus() })
      this.reconcileStatus()
      return () => {
        disposeStatus()
        disposeRemoteStatus()
        disposePending()
        disposeReading()
        disposeView()
        this.releaseViewed()
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

  /**
   * Mark one Session read or unread through the latest completion known to this Client.
   * @param sessionId - known Session identity.
   * @param unread - requested reminder state.
   * @throws when reading is not synchronized or the Host or carrier rejects; reconnect to refresh an unknown outcome.
   */
  async mark(sessionId: SessionId, unread: boolean): Promise<void> {
    await this.reading.mark(sessionId, unread)
  }

  private observeRunning(sessionId: SessionId, running: boolean): void {
    this.running.set(sessionId, running)
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
    if (list.phase === 'ready') {
      for (const id of this.running.keys()) {
        if (present.has(id)) continue
        this.running.delete(id)
      }
    }
    this.followMainView(list)
    this.publishStatus()
  }

  /** Follow the main-view Session's binding, whose open state decides whether its natural reminder is hidden. */
  private followMainView(list: SessionListState): void {
    const id = Object.values(list.byId).find(row => (row.retainedBy.mainView ?? 0) > 0)?.id
    const binding = id === undefined ? undefined : this.sessions.binding(id)
    if (binding === this.viewedBinding) return
    this.releaseViewed()
    this.viewedBinding = binding
    this.viewedOpenState = binding?.session.getSnapshot().openState
    // Session snapshots change with every streamed event; only the open state affects the table.
    this.releaseViewed = binding?.session.subscribe(() => {
      const openState = binding.session.getSnapshot().openState
      if (openState === this.viewedOpenState) return
      this.viewedOpenState = openState
      this.publishStatus()
    }) ?? (() => {})
  }

  private publishStatus(): void {
    const pending = this.pendingInteractions.getSnapshot()
    const reading = this.reading.state.getSnapshot().items
    const list = this.sessions.list.getSnapshot()
    // The visible, focused main view acknowledges its open Session's completions; hiding them meanwhile avoids a flash.
    const viewing = viewVisible() && this.viewedOpenState === 'open' ? this.viewedBinding?.sessionId : undefined
    const ids = new Set<SessionId>([
      ...(Object.keys(list.byId) as SessionId[]),
      ...this.running.keys(),
      ...pending.keys(),
      ...(Object.keys(reading) as SessionId[]),
    ])
    const next = new Map<SessionId, SessionStatus>()
    for (const id of ids) {
      const record = reading[id]
      const unread = record !== undefined
        && (record.manualUnread || (id !== viewing && record.completedTurn > record.readTurn))
      next.set(id, {
        running: this.running.get(id),
        pendingInteraction: pending.get(id),
        completionUnread: unread,
        completionFailed: unread && record.failed,
      })
    }
    if (sameSessionStatus(this.statusSnapshot, next)) return
    this.statusSnapshot = next
    notifySubscribers(this.statusListeners, '[session-status] Session status')
  }
}

/** Whether the page is visible and focused; without a document there is no view. */
function viewVisible(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'visible' && document.hasFocus()
}

/**
 * Report page visibility and window focus changes.
 * @param changed - called after each change.
 * @returns removes the listeners; a no-op without a document.
 */
function watchViewVisibility(changed: () => void): () => void {
  if (typeof document === 'undefined') return () => {}
  document.addEventListener('visibilitychange', changed)
  window.addEventListener('focus', changed)
  window.addEventListener('blur', changed)
  return () => {
    document.removeEventListener('visibilitychange', changed)
    window.removeEventListener('focus', changed)
    window.removeEventListener('blur', changed)
  }
}

function sameSessionStatus(left: SessionStatusSnapshot, right: SessionStatusSnapshot): boolean {
  if (left.size !== right.size) return false
  for (const [id, status] of left) {
    const candidate = right.get(id)
    if (candidate === undefined
      || candidate.running !== status.running
      || candidate.pendingInteraction !== status.pendingInteraction
      || candidate.completionUnread !== status.completionUnread
      || candidate.completionFailed !== status.completionFailed) return false
  }
  return true
}
