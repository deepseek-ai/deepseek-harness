/**
 * The content preview's view state, kept per tab so it survives a remount:
 * the chosen renderer, line wrap, and the scroll offset. A tab's bucket is
 * created by its first write and forgotten when its tab record ends.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'

/** One tab's view. */
export interface ContentViewState {
  /** Explicit renderer choice; absence follows automatic selection. */
  rendererId?: string
  /** Whether long lines wrap; on until the reader turns it off. */
  wrap: boolean
  /** Scroll offset of the preview body, in px. */
  scrollTop: number
}

/** Every tab's view, keyed by tab id. */
export interface ContentPreviewState {
  byTab: Record<TabId, ContentViewState>
}

/**
 * A tab's view before any write.
 * @returns the default view.
 */
export function freshView(): ContentViewState {
  return { wrap: true, scrollTop: 0 }
}

function bucket(state: ContentPreviewState, tabId: TabId): ContentViewState {
  return state.byTab[tabId] ??= freshView()
}

/** The view store's write set; every action names the tab it writes. */
type ContentPreviewActions = {
  selected: (draft: ContentPreviewState, tabId: TabId, rendererId: string) => void
  toggledWrap: (draft: ContentPreviewState, tabId: TabId) => void
  scrolled: (draft: ContentPreviewState, tabId: TabId, scrollTop: number) => void
  forget: (draft: ContentPreviewState, tabId: TabId) => void
}

/**
 * Declare the content preview's view store.
 * @returns the store handle the body registration declares.
 */
export function createContentPreviewStore(): EngineStoreHandle<ContentPreviewState, ContentPreviewActions> {
  return defineStore({
    init: (): ContentPreviewState => ({ byTab: {} }),
    actions: {
      /** @param d - draft. @param tabId - owning tab. @param rendererId - the chosen implementation. */
      selected: (d, tabId: TabId, rendererId: string) => { bucket(d, tabId).rendererId = rendererId },
      /** @param d - draft. @param tabId - owning tab. */
      toggledWrap: (d, tabId: TabId) => {
        const view = bucket(d, tabId)
        view.wrap = !view.wrap
      },
      /** @param d - draft. @param tabId - owning tab. @param scrollTop - body scroll offset, in px. */
      scrolled: (d, tabId: TabId, scrollTop: number) => { bucket(d, tabId).scrollTop = scrollTop },
      /** @param d - draft. @param tabId - the tab whose record ended. */
      forget: (d, tabId: TabId) => {
        const byTab: ContentPreviewState['byTab'] = {}
        // Keys were written from tab ids; reading them back as ids is exact.
        for (const [id, view] of Object.entries(d.byTab) as [TabId, ContentViewState][]) {
          if (id !== tabId) byTab[id] = view
        }
        d.byTab = byTab
      },
    },
  })
}

/** The view store handle type. */
export type ContentPreviewStore = ReturnType<typeof createContentPreviewStore>
