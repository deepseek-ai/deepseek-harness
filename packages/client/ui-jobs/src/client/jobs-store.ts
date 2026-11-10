/**
 * Settled rows the user cleared from the background-jobs section, and whether
 * the user opened or folded the settled rows. The registration declares it as
 * an exclusive store, so each Session keeps its own while its scope is
 * retained, across hiding and showing the panel.
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** Cleared row keys and the settled fold of one Session. */
export interface JobsSectionState {
  /** Keys of the settled rows the user cleared. */
  cleared: Record<string, true>
  /** Whether the user opened (true) or folded (false) the settled rows; null until the user chooses. */
  settledOpen: boolean | null
}

/** The jobs section store's write set. */
type JobsSectionActions = {
  cleared: (draft: JobsSectionState, keys: readonly string[]) => void
  settledOpened: (draft: JobsSectionState, open: boolean) => void
}

/**
 * Declare the jobs section's store.
 * @returns the store handle to declare on the registration.
 */
export function createJobsSectionStore(): EngineStoreHandle<JobsSectionState, JobsSectionActions> {
  return defineStore({
    init: (): JobsSectionState => ({ cleared: {}, settledOpen: null }),
    actions: {
      /**
       * Hide settled rows from the section; the registry keeps their records.
       * @param d - draft state.
       * @param keys - row keys to hide.
       */
      cleared: (d, keys: readonly string[]) => {
        for (const key of keys) d.cleared[key] = true
      },
      /**
       * Record the user's choice to open or fold the settled rows.
       * @param d - draft state.
       * @param open - whether the settled rows are now open.
       */
      settledOpened: (d, open: boolean) => {
        d.settledOpen = open
      },
    },
  })
}
