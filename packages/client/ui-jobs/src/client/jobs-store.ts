/**
 * Settled rows the user cleared from the background-jobs section, whether the
 * user opened or folded the settled rows, and which of the section's two
 * groups the user unfolded past their row limit. The registration declares it
 * as an exclusive store, so each Session keeps its own while its scope is
 * retained, across hiding and showing the panel.
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** A group of the section's rows: the live ones, or the settled ones under their fold. */
export type JobGroup = 'live' | 'settled'

/** Cleared row keys and the folds of one Session. */
export interface JobsSectionState {
  /** Keys of the settled rows the user cleared. */
  cleared: Record<string, true>
  /** Whether the user opened (true) or folded (false) the settled rows; null until the user chooses. */
  settledOpen: boolean | null
  /** Whether each group shows every row instead of holding back the rows past its limit. */
  unfolded: Record<JobGroup, boolean>
}

/** The jobs section store's write set. */
type JobsSectionActions = {
  cleared: (draft: JobsSectionState, keys: readonly string[]) => void
  settledOpened: (draft: JobsSectionState, open: boolean) => void
  unfoldedSet: (draft: JobsSectionState, group: JobGroup, unfolded: boolean) => void
}

/**
 * Declare the jobs section's store.
 * @returns the store handle to declare on the registration.
 */
export function createJobsSectionStore(): EngineStoreHandle<JobsSectionState, JobsSectionActions> {
  return defineStore({
    init: (): JobsSectionState => ({ cleared: {}, settledOpen: null, unfolded: { live: false, settled: false } }),
    actions: {
      /**
       * Hide settled rows from the section; the registry keeps their records.
       * The settled group folds to its limit again for the rows that settle next.
       * @param d - draft state.
       * @param keys - row keys to hide.
       */
      cleared: (d, keys: readonly string[]) => {
        for (const key of keys) d.cleared[key] = true
        d.unfolded.settled = false
      },
      /**
       * Record the user's choice to open or fold the settled rows.
       * @param d - draft state.
       * @param open - whether the settled rows are now open.
       */
      settledOpened: (d, open: boolean) => {
        d.settledOpen = open
      },
      /**
       * Record the user's choice to show every row of a group or fold it to its limit again.
       * @param d - draft state.
       * @param group - the group the choice is about.
       * @param unfolded - whether the group now shows every row.
       */
      unfoldedSet: (d, group: JobGroup, unfolded: boolean) => {
        d.unfolded[group] = unfolded
      },
    },
  })
}
