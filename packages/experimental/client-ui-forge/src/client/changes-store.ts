/**
 * Choices of each changes tab: the local scope, the side-by-side view, line
 * wrapping, and the navigation it last applied. One bucket per tab, so two
 * views in one Session keep their own choices; the bucket ends with the tab
 * record's signal.
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { ForgeLocalScope } from '../types.ts'

/** One changes tab's choices. */
export interface ChangesTabState {
  /** Local changes shown; a change request view ignores it. */
  scope: ForgeLocalScope['kind']
  /** Whether deletions and additions show in two columns. */
  split: boolean
  /** Whether long lines wrap instead of being cut at the column edge. */
  wrap: boolean
  /** The navigation revision last applied, whose file the view scrolled to. */
  navigated: number
}

/** Every changes tab's choices, keyed by tab id. */
export interface ChangesState {
  byTab: Record<string, ChangesTabState>
}

function bucket(state: ChangesState, tabId: string): ChangesTabState {
  const tab = state.byTab[tabId]
  if (tab === undefined) throw new Error(`forge-panel: no changes state for tab "${tabId}"`)
  return tab
}

/** The changes store's write set; every action names the tab it writes. */
type ChangesActions = {
  navigated: (draft: ChangesState, tabId: string, revision: number) => void
  scoped: (draft: ChangesState, tabId: string, scope: ForgeLocalScope['kind']) => void
  toggledSplit: (draft: ChangesState, tabId: string) => void
  toggledWrap: (draft: ChangesState, tabId: string) => void
  forget: (draft: ChangesState, tabId: string) => void
}

/**
 * Declare the changes tab's store; the registration declares it as an
 * exclusive store, so the framework mints one instance per Session.
 * @returns the store handle to declare on the registration.
 */
export function createChangesStore(): EngineStoreHandle<ChangesState, ChangesActions> {
  return defineStore({
    init: (): ChangesState => ({ byTab: {} }),
    actions: {
      /**
       * Apply a navigation; the first one seeds the `branch` scope, two columns, and wrapped lines.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param revision - the navigation revision being applied.
       */
      navigated: (d, tabId: string, revision: number) => {
        const tab = d.byTab[tabId]
        if (tab === undefined) d.byTab[tabId] = { scope: 'branch', split: true, wrap: true, navigated: revision }
        else tab.navigated = revision
      },
      /**
       * Show another scope of local changes.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param scope - the scope to show.
       */
      scoped: (d, tabId: string, scope: ForgeLocalScope['kind']) => { bucket(d, tabId).scope = scope },
      /**
       * Switch between one column and two.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       */
      toggledSplit: (d, tabId: string) => {
        const tab = bucket(d, tabId)
        tab.split = !tab.split
      },
      /**
       * Switch line wrapping.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       */
      toggledWrap: (d, tabId: string) => {
        const tab = bucket(d, tabId)
        tab.wrap = !tab.wrap
      },
      /**
       * Drop a tab's bucket once its record is gone.
       * @param d - draft state.
       * @param tabId - the tab that ended.
       */
      forget: (d, tabId: string) => {
        d.byTab = Object.fromEntries(Object.entries(d.byTab).filter(([id]) => id !== tabId))
      },
    },
  })
}
