/** Persisted Browser tab snapshots shared by the body and title slots. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { BrowserTabState } from './BrowserPersistence.ts'

/** All Browser tabs in one Session-scoped store. */
export interface BrowserState {
  byTab: Record<TabId, BrowserTabState>
}

type BrowserActions = {
  replace: (draft: BrowserState, tabId: TabId, state: BrowserTabState) => void
  forget: (draft: BrowserState, tabId: TabId) => void
}

/**
 * Declare the Session-scoped Browser persistence store.
 * @returns a fresh store handle for Slot registration.
 */
export function createBrowserStore(): EngineStoreHandle<BrowserState, BrowserActions> {
  return defineStore({
    init: (): BrowserState => ({ byTab: {} }),
    persist: 'dsh.sidebar-browser.v1',
    actions: {
      replace: (draft, tabId: TabId, state: BrowserTabState) => { draft.byTab[tabId] = state },
      forget: (draft, tabId: TabId) => {
        const byTab: BrowserState['byTab'] = {}
        for (const [id, state] of Object.entries(draft.byTab) as [TabId, BrowserTabState][]) {
          if (id !== tabId) byTab[id] = state
        }
        draft.byTab = byTab
      },
    },
  })
}

/** Browser store handle shared by body and title registrations. */
export type BrowserStore = ReturnType<typeof createBrowserStore>
