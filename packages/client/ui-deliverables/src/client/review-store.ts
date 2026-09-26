/**
 * The review tab's view state: which listed file is shown, whether hunks are
 * drawn side by side, and whether long lines wrap. One bucket per tab, so two
 * reviews in one session keep their own choices; the bucket ends with the
 * tab record's signal.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'

/** One review tab's choices. */
export interface ReviewTabState {
  /** Original index of the shown file in the summary's files array. */
  index: number
  /** Whether deletions and additions are drawn in two columns; new tabs start enabled. */
  split: boolean
  /** Whether long lines wrap instead of scrolling. */
  wrap: boolean
  /** The navigation revision whose file index was last applied. */
  navigated: number
}

/** Every review tab's choices, keyed by tab id. */
export interface ReviewState {
  byTab: Record<TabId, ReviewTabState>
}

function bucket(state: ReviewState, tabId: TabId): ReviewTabState {
  const tab = state.byTab[tabId]
  if (tab === undefined) throw new Error(`ui-deliverables: no review state for tab "${tabId}"`)
  return tab
}

/** The review store's write set; every action names the tab it writes. */
type ReviewActions = {
  navigated: (draft: ReviewState, tabId: TabId, revision: number, index: number) => void
  selected: (draft: ReviewState, tabId: TabId, index: number) => void
  toggledSplit: (draft: ReviewState, tabId: TabId) => void
  toggledWrap: (draft: ReviewState, tabId: TabId) => void
  forget: (draft: ReviewState, tabId: TabId) => void
}

/**
 * Declare the review tab's store; the registration declares it as an
 * exclusive store, so the framework mints one instance per session.
 * @returns the store handle to declare on the registration.
 */
export function createReviewStore(): EngineStoreHandle<ReviewState, ReviewActions> {
  return defineStore({
    init: (): ReviewState => ({ byTab: {} }),
    actions: {
      /**
       * Apply a navigation: seed a side-by-side, unwrapped tab on its first one, then show the navigated file.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param revision - the navigation revision being applied.
       * @param index - the file index the navigation named, or the current one.
       */
      navigated: (d, tabId: TabId, revision: number, index: number) => {
        const tab = d.byTab[tabId]
        if (tab === undefined) d.byTab[tabId] = { index, split: true, wrap: false, navigated: revision }
        else { tab.index = index; tab.navigated = revision }
      },
      /**
       * Show another listed file.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param index - original index in the summary's files array.
       */
      selected: (d, tabId: TabId, index: number) => { bucket(d, tabId).index = index },
      /**
       * Switch between the unified and the side-by-side view.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       */
      toggledSplit: (d, tabId: TabId) => { const tab = bucket(d, tabId); tab.split = !tab.split },
      /**
       * Switch line wrapping.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       */
      toggledWrap: (d, tabId: TabId) => { const tab = bucket(d, tabId); tab.wrap = !tab.wrap },
      /**
       * Drop a tab's bucket once its record is gone.
       * @param d - draft state.
       * @param tabId - the tab that ended.
       */
      forget: (d, tabId: TabId) => {
        d.byTab = Object.fromEntries(Object.entries(d.byTab).filter(([id]) => id !== tabId))
      },
    },
  })
}
