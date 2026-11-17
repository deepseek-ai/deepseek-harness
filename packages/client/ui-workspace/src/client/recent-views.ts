/** Recently viewed Sessions that keep their history stream after leaving the main view. */
import type {
  ISessions, SessionListState, SessionReference,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session-status/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/**
 * Attention-ordered retention of non-blank Sessions left by the main view.
 *
 * The state records only what the user did: the order in which Sessions left the main view and the Session it
 * shows now. {@link RecentSessionViews.sync} derives the Sessions to hold from that state and the current Session,
 * Workspace, and status snapshots, then retains the missing ones before releasing the rest. Each held Session has
 * one `recentViews` reference without facets, so its history stays loaded but nothing is derived from it.
 *
 * A Session that is running, awaits the user, or has an unread completion is neither counted nor evicted; beyond
 * the limit, the least recently left unpinned Session is evicted first, then the least recently left pinned one.
 * An evicted, removed, archived, or blank Session also leaves the order, so it returns only when the main view
 * leaves it again.
 */
export class RecentSessionViews {
  /** Sessions the main view left that are still candidates, most recently left first. */
  private order: SessionId[] = []
  private current: SessionId | undefined
  private readonly held = new Map<SessionId, SessionReference>()
  private syncing = false
  /** Incremented by every sync request, so a running pass repeats while requests arrive during it. */
  private requests = 0

  /**
   * @param sessions - Session Controller that owns the references.
   * @param workspaces - Workspace Controller whose archived Sessions leave the list and whose pins order eviction.
   * @param status - unified Session UI status deciding which Sessions need attention.
   * @param limit - Host-synced count of Sessions needing no attention kept besides the main-view Session;
   * absent until a value arrives.
   */
  constructor(
    private readonly sessions: Pick<ISessions, 'list' | 'retain' | 'subagentAddress'>,
    private readonly workspaces: Pick<IWorkspaces, 'list'>,
    private readonly status: ObservableSnapshot<SessionStatusSnapshot>,
    private readonly limit: ObservableSnapshot<number | undefined>,
  ) {}

  /**
   * Record the Session the main view shows now and sync; call after retaining its main-view reference and before
   * releasing the previous one, so the previous Session is retained here first.
   * @param sessionId - Session the main view shows, or undefined when it shows none.
   */
  show(sessionId: SessionId | undefined): void {
    const previous = this.current
    if (previous !== undefined && previous !== sessionId) {
      this.order = [previous, ...this.order.filter(id => id !== previous)]
    }
    if (sessionId !== undefined) this.order = this.order.filter(id => id !== sessionId)
    this.current = sessionId
    this.sync()
  }

  /**
   * Sync whenever the Session list, Workspace list, Session UI status, or recent-view limit changes.
   * @returns disposer that stops syncing and releases every held Session.
   */
  start(): () => void {
    const sync = (): void => { this.sync() }
    const stops = [
      this.sessions.list.subscribe(sync),
      this.workspaces.list.subscribe(sync),
      this.status.subscribe(sync),
      this.limit.subscribe(sync),
    ]
    return () => {
      for (const stop of stops) stop()
      this.order = []
      this.current = undefined
      this.sync()
    }
  }

  /**
   * Hold exactly the Sessions the current state selects, retaining before releasing. Retaining publishes the
   * Session list synchronously, so a re-entrant call only records its request and the running sync repeats.
   */
  sync(): void {
    this.requests++
    if (this.syncing) return
    this.syncing = true
    try {
      let handled: number
      do {
        handled = this.requests
        this.order = this.selected()
        const wanted = new Set(this.order)
        for (const sessionId of this.order) {
          if (!this.held.has(sessionId)) this.acquire(sessionId)
        }
        for (const [sessionId, reference] of [...this.held]) {
          if (wanted.has(sessionId)) continue
          this.held.delete(sessionId)
          reference.release()
        }
      } while (this.requests !== handled)
    } finally {
      this.syncing = false
    }
  }

  /**
   * The candidates to keep, in order: every eligible Session needing attention plus the first `limit` others.
   * No limit keeps every counted Session, which reaches the same result as the main view alone being loaded before
   * the Host sends one.
   */
  private selected(): SessionId[] {
    const { byId } = this.sessions.list.getSnapshot()
    const workspaces = this.workspaces.list.getSnapshot()
    const status = this.status.getSnapshot()
    const eligible = this.order.filter(id => id !== this.current && isEligible(id, byId, workspaces))
    // A Session the main view already retains, but has not shown yet, takes no recent-view slot.
    const counted = eligible.filter(id => !needsAttention(id, byId, status) && (byId[id]?.retainedBy.mainView ?? 0) === 0)
    const countedIds = new Set(counted)
    const pinned = new Set(workspaces.pinnedSessionIds)
    // Pinned Sessions take the limit first, so eviction reaches them only after every unpinned Session.
    const kept = new Set([
      ...counted.filter(id => pinned.has(id)),
      ...counted.filter(id => !pinned.has(id)),
    ].slice(0, this.limit.getSnapshot() ?? Number.POSITIVE_INFINITY))
    return eligible.filter(id => kept.has(id) || !countedIds.has(id))
  }

  private acquire(sessionId: SessionId): void {
    const target = this.sessions.subagentAddress(sessionId) ?? sessionId
    try {
      this.held.set(sessionId, this.sessions.retain(target, { source: 'recentViews' }))
    } catch (error: unknown) {
      // Without the reference the Session is released with its main-view reference; navigation continues.
      console.warn('recent Session view retention failed:', error)
      this.order = this.order.filter(id => id !== sessionId)
      this.requests++
    }
  }
}

/** Whether a left Session may be kept: it is listed, not blank, and not archived. */
function isEligible(sessionId: SessionId, byId: SessionListState['byId'], workspaces: WorkspaceSnapshot): boolean {
  const row = byId[sessionId]
  return row !== undefined && !row.blank && !workspaces.archivedSessionIds.includes(sessionId)
}

/** Whether the user is likely to return to a Session: it runs, awaits the user, or has an unread completion. */
function needsAttention(sessionId: SessionId, byId: SessionListState['byId'], status: SessionStatusSnapshot): boolean {
  const current = status.get(sessionId)
  return byId[sessionId]?.running === true || current?.running === true
    || current?.pendingInteraction !== undefined || current?.completionUnread === true
}
