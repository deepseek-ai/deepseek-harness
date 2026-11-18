/** Metadata inventory of saved and adopted layouts without mounting their content. */
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabId, TabRecord } from '@deepseek-ai/dsh-client-ui-dockkit'
import { readSidebarLayout, sidebarPersistence } from './persistence.ts'

/** One open occurrence; resource recovery belongs to its kind's provider. */
export interface SidebarRightOpenTab {
  readonly sessionId: SessionId
  readonly tabId: TabId
  readonly kind: string
  readonly contentId: string
}

/** Derived membership only; layout stores remain the persisted authority. */
export class SidebarTabInventory {
  private readonly sessions = new Map<SessionId, readonly SidebarRightOpenTab[]>()
  private readonly snapshot = createSnapshotStore<readonly SidebarRightOpenTab[]>([])
  /** Read-only metadata observable shared with content providers. */
  readonly source: ObservableSnapshot<readonly SidebarRightOpenTab[]> = this.snapshot

  /** Read saved layouts once before the root service is published. */
  constructor() {
    let keys: readonly (string | null)[] = []
    try {
      keys = typeof localStorage === 'undefined' ? [] : Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
    } catch (_storageUnavailable) {
      // Inaccessible storage holds no saved layouts; adopted in-memory layouts still publish their open tabs.
    }
    for (const key of keys) {
      if (key === null || !key.startsWith(`${sidebarPersistence}.`)) continue
      const sessionId = key.slice(sidebarPersistence.length + 1) as SessionId
      const saved = readSidebarLayout(sessionId)
      if (saved !== undefined) this.sessions.set(sessionId, Object.values(saved.layout.tabs).map(tab => ({
        sessionId, tabId: tab.id, kind: tab.kind, contentId: tab.contentId,
      })))
    }
    this.publish()
  }

  /**
   * Replace membership from the authoritative in-window store.
   * @param sessionId - adopted Session.
   * @param tabs - current committed records.
   */
  update(sessionId: SessionId, tabs: readonly TabRecord[]): void {
    this.sessions.set(sessionId, tabs.map(tab => ({ sessionId, tabId: tab.id, kind: tab.kind, contentId: tab.contentId })))
    this.publish()
  }

  /**
   * Forget a permanently cleared scope.
   * @param sessionId - removed Session scope.
   */
  remove(sessionId: SessionId): void { this.sessions.delete(sessionId); this.publish() }

  private publish(): void {
    const next = [...this.sessions.values()].flat()
    if (JSON.stringify(next) !== JSON.stringify(this.snapshot.getSnapshot())) this.snapshot.set(next)
  }
}
