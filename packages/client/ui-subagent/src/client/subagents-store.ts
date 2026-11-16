/**
 * Whether the user unfolded the subagents list of the Session panel. The
 * registration declares it as an exclusive store, so each Session keeps its
 * own while its scope is retained, across hiding and showing the panel.
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** The fold of one Session's subagents list. */
export interface SubagentsSectionState {
  /** Whether the list shows every row instead of holding back the rows past its limit. */
  unfolded: boolean
}

/** The subagents section store's write set. */
type SubagentsSectionActions = {
  unfoldedSet: (draft: SubagentsSectionState, unfolded: boolean) => void
}

/**
 * Declare the subagents section's store.
 * @returns the store handle to declare on the registration.
 */
export function createSubagentsSectionStore(): EngineStoreHandle<SubagentsSectionState, SubagentsSectionActions> {
  return defineStore({
    init: (): SubagentsSectionState => ({ unfolded: false }),
    actions: {
      /**
       * Record the user's choice to show every row or fold the list again.
       * @param d - draft state.
       * @param unfolded - whether the list now shows every row.
       */
      unfoldedSet: (d, unfolded: boolean) => {
        d.unfolded = unfolded
      },
    },
  })
}
