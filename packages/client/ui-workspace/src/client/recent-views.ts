/** Recently viewed Sessions that keep their history stream after leaving the main view. */
import type {
  ISessions, SessionListState, SessionReference,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session-status/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

// TODO: move to plugin Config once the Client supports plugin configuration.
/** Retained recently viewed Sessions that need no attention, excluding the current main-view Session. */
const RECENT_VIEW_LIMIT = 10

interface RecentView {
  readonly sessionId: SessionId
  readonly reference: SessionReference
}

/**
 * Attention-ordered retention of non-blank Sessions left by the main view.
 * Each entry holds one `recentViews` reference without facets, so its history
 * stays loaded but nothing is derived from it. A Session that is running,
 * awaits the user, or has an unread completion is neither counted nor evicted;
 * beyond the limit, the least recently left unpinned Session is evicted first,
 * then the least recently left pinned one.
 */
export class RecentSessionViews {
  /** Most recently left first. */
  private entries: RecentView[] = []
  private disposed = false

  /**
   * @param sessions - Session Controller that owns the references.
   * @param workspaces - Workspace Controller whose archived Sessions leave the list and whose pins order eviction.
   * @param status - unified Session UI status deciding which Sessions need attention.
   */
  constructor(
    private readonly sessions: Pick<ISessions, 'list' | 'retain' | 'subagentAddress'>,
    private readonly workspaces: Pick<IWorkspaces, 'list'>,
    private readonly status: ObservableSnapshot<SessionStatusSnapshot>,
  ) {}

  /**
   * Retain a Session the main view is leaving; call before releasing its main-view reference.
   * @param sessionId - Session leaving the main view.
   */
  leave(sessionId: SessionId): void {
    const row = this.sessions.list.getSnapshot().byId[sessionId]
    if (row === undefined || row.blank || this.archived(sessionId)) return
    const target = this.sessions.subagentAddress(sessionId) ?? sessionId
    let reference: SessionReference
    try {
      reference = this.sessions.retain(target, { source: 'recentViews' })
    } catch (error: unknown) {
      // Without the reference the Session is released with its main-view reference; navigation continues.
      console.warn('recent Session view retention failed:', error)
      return
    }
    // Retaining publishes the list synchronously, which may reconcile or dispose this list before the
    // new entry exists, so the entry is inserted into the entries current after retention returns.
    if (this.disposed) {
      reference.release()
      return
    }
    const previous = this.entries.find(entry => entry.sessionId === sessionId)
    this.entries = [{ sessionId, reference }, ...this.entries.filter(entry => entry !== previous)]
    previous?.reference.release()
    this.reconcile()
  }

  /**
   * Release the entry of a Session the main view now shows; call after retaining its main-view reference.
   * @param sessionId - Session entering the main view.
   */
  enter(sessionId: SessionId): void {
    this.remove(sessionId)
  }

  /** Drop removed and archived Sessions, then evict entries needing no attention beyond the limit. */
  reconcile(): void {
    const { byId } = this.sessions.list.getSnapshot()
    for (const entry of [...this.entries]) {
      if (byId[entry.sessionId] === undefined || this.archived(entry.sessionId)) this.remove(entry.sessionId)
    }
    this.evict(byId)
  }

  /**
   * Reconcile whenever the Session list, Workspace list, or Session UI status changes.
   * @returns disposer that stops reconciling and releases every entry.
   */
  start(): () => void {
    const reconcile = (): void => { this.reconcile() }
    const stops = [
      this.sessions.list.subscribe(reconcile),
      this.workspaces.list.subscribe(reconcile),
      this.status.subscribe(reconcile),
    ]
    return () => {
      for (const stop of stops) stop()
      this.dispose()
    }
  }

  /** Release every entry. */
  dispose(): void {
    this.disposed = true
    const entries = this.entries
    this.entries = []
    for (const entry of entries) entry.reference.release()
  }

  private evict(byId: SessionListState['byId']): void {
    const status = this.status.getSnapshot()
    const counted = this.entries.filter(entry => !needsAttention(entry.sessionId, byId, status))
    const excess = counted.length - RECENT_VIEW_LIMIT
    if (excess <= 0) return
    const pinned = new Set(this.workspaces.list.getSnapshot().pinnedSessionIds)
    // Least recently left first, unpinned before pinned.
    const candidates = [
      ...counted.filter(entry => !pinned.has(entry.sessionId)).reverse(),
      ...counted.filter(entry => pinned.has(entry.sessionId)).reverse(),
    ]
    const evicted = new Set(candidates.slice(0, excess))
    this.entries = this.entries.filter(entry => !evicted.has(entry))
    for (const entry of evicted) entry.reference.release()
  }

  private remove(sessionId: SessionId): void {
    const entry = this.entries.find(candidate => candidate.sessionId === sessionId)
    if (entry === undefined) return
    this.entries = this.entries.filter(candidate => candidate !== entry)
    entry.reference.release()
  }

  private archived(sessionId: SessionId): boolean {
    return this.workspaces.list.getSnapshot().archivedSessionIds.includes(sessionId)
  }
}

/** Whether the user is likely to return to a Session: it runs, awaits the user, or has an unread completion. */
function needsAttention(sessionId: SessionId, byId: SessionListState['byId'], status: SessionStatusSnapshot): boolean {
  const current = status.get(sessionId)
  return byId[sessionId]?.running === true || current?.running === true
    || current?.pendingInteraction !== undefined || current?.completionUnread === true
}
