/** One Sidebar view's Session reference, retained bodies and committed mount lifetime. */
import type { ISessions, SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    sidebarView: unknown
  }
}

/** Owns its reference until retirement finishes or the Sidebar plugin shuts down. */
export class SidebarSessionView {
  /** Session reference released exclusively by this View. */
  readonly reference: SessionReference
  private readonly tabs = new Map<TabId, number>()
  private mounts = 0
  private retired = false
  private disposed = false

  /**
   * @param sessionId - Session displayed by this view.
   * @param sessions - allocator for this view's independent reference.
   * @param onDispose - removes this view from the collection's index before reference release.
   * @param onTabRelease - reconsiders retention after a body releases its hold.
   */
  constructor(
    readonly sessionId: SessionId,
    sessions: ISessions,
    private readonly onDispose: (view: SidebarSessionView) => void,
    private readonly onTabRelease: (view: SidebarSessionView) => void,
  ) {
    this.reference = sessions.retain(sessionId, { source: 'sidebarView' })
    void this.reference.ready.catch((error: unknown) => { console.error('Sidebar Session opening failed:', error) })
  }

  /** Whether an initialized retained body still needs this view. */
  get hasRetainedTabs(): boolean {
    return this.tabs.size > 0
  }

  /**
   * Keep a retired View's reference until its committed roots finish unmounting.
   * @returns cleanup to call once for this root; the final cleanup releases a retired View.
   */
  mount(): () => void {
    this.mounts += 1
    return () => {
      this.mounts -= 1
      if (this.retired && this.mounts === 0) this.dispose()
    }
  }

  /**
   * Hold an initialized body until unmount or occurrence cancellation.
   * @param tabId - initialized body identity.
   * @param signal - occurrence lifetime; closing and undoing a tab creates a new lifetime.
   * @returns idempotent release of this body's hold.
   */
  readonly retainTab = (tabId: TabId, signal: AbortSignal): (() => void) => {
    if (signal.aborted || this.disposed) return () => {}
    this.tabs.set(tabId, (this.tabs.get(tabId) ?? 0) + 1)
    let held = true
    const release = (): void => {
      if (!held) return
      held = false
      signal.removeEventListener('abort', release)
      const count = this.tabs.get(tabId) as number
      if (count === 1) this.tabs.delete(tabId)
      else this.tabs.set(tabId, count - 1)
      this.onTabRelease(this)
    }
    signal.addEventListener('abort', release, { once: true })
    return release
  }

  /** End a withdrawn view after its existing committed mounts finish. */
  retire(): void {
    this.retired = true
    if (this.mounts === 0) this.dispose()
  }

  /** Release once; plugin shutdown does not wait for remaining React mounts. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.retired = true
    this.onDispose(this)
    this.reference.release()
  }
}
