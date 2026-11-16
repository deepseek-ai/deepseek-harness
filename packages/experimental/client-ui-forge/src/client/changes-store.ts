/**
 * Choices of each changes tab: the local scope, the base branch of the
 * `branch` scope, the commits shown, the review layer, whether test files
 * hide, the side-by-side view, line wrapping, and the navigation it last
 * applied. One bucket per tab, so two views in one Session keep their own
 * choices; the bucket ends with the tab record's signal.
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { ForgeBaseBranch, ForgeCommitRange, ForgeFileLayer, ForgeLocalScope } from '../types.ts'

/** Files a changes tab shows: every file, or the files of one review layer. */
export type ChangesLens = 'all' | ForgeFileLayer

/** One changes tab's choices. */
export interface ChangesTabState {
  /** Local changes shown; a change request view ignores it. */
  scope: ForgeLocalScope['kind']
  /** Branch the `branch` scope compares with, or null for the automatic fork point; other scopes keep it. */
  base: ForgeBaseBranch | null
  /** Commits shown instead of the whole change request or `branch` scope, or null for all of them. */
  commits: ForgeCommitRange | null
  /** Review layer whose files show. */
  lens: ChangesLens
  /** Identity of the Host filter lens that keeps some of the shown files, or null for none. */
  filterLens: string | null
  /** Whether files of the `test` layer hide from the file tree and the diff. */
  hideTests: boolean
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
  based: (draft: ChangesState, tabId: string, base: ForgeBaseBranch | null) => void
  committed: (draft: ChangesState, tabId: string, commits: ForgeCommitRange | null) => void
  lensed: (draft: ChangesState, tabId: string, lens: ChangesLens) => void
  filtered: (draft: ChangesState, tabId: string, lens: string | null) => void
  toggledTests: (draft: ChangesState, tabId: string) => void
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
       * Apply a navigation; the first one seeds the `branch` scope with the automatic fork point, every commit and file,
       * no filter lens, test files shown, two columns, and wrapped lines.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param revision - the navigation revision being applied.
       */
      navigated: (d, tabId: string, revision: number) => {
        const tab = d.byTab[tabId]
        if (tab === undefined) {
          d.byTab[tabId] = {
            scope: 'branch', base: null, commits: null, lens: 'all', filterLens: null, hideTests: false, split: true, wrap: true, navigated: revision,
          }
        } else tab.navigated = revision
      },
      /**
       * Show another scope of local changes, with all of its commits.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param scope - the scope to show.
       */
      scoped: (d, tabId: string, scope: ForgeLocalScope['kind']) => {
        const tab = bucket(d, tabId)
        tab.scope = scope
        tab.commits = null
      },
      /**
       * Compare the `branch` scope with another branch, showing all of its commits.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param base - the branch, or null for the automatic fork point.
       */
      based: (d, tabId: string, base: ForgeBaseBranch | null) => {
        const tab = bucket(d, tabId)
        tab.base = base
        tab.commits = null
      },
      /**
       * Show consecutive commits instead of the whole change request or `branch` scope.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param commits - the commits, or null for all of them.
       */
      committed: (d, tabId: string, commits: ForgeCommitRange | null) => { bucket(d, tabId).commits = commits },
      /**
       * Show the files of another review layer.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param lens - every file, or one layer.
       */
      lensed: (d, tabId: string, lens: ChangesLens) => { bucket(d, tabId).lens = lens },
      /**
       * Choose the Host filter lens that keeps some of the shown files, or none.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       * @param lens - the lens identity, or null for none.
       */
      filtered: (d, tabId: string, lens: string | null) => { bucket(d, tabId).filterLens = lens },
      /**
       * Hide or show the files of the `test` layer; hiding them leaves the `test` lens for every file.
       * @param d - draft state.
       * @param tabId - the tab being drawn.
       */
      toggledTests: (d, tabId: string) => {
        const tab = bucket(d, tabId)
        tab.hideTests = !tab.hideTests
        if (tab.hideTests && tab.lens === 'test') tab.lens = 'all'
      },
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
