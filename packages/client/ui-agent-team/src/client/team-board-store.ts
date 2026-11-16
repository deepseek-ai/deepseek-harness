/**
 * Whether the user unfolded the shared tasks list of the Session panel. The
 * registration declares it as an exclusive store, so each Session keeps its
 * own while its scope is retained, across hiding and showing the panel.
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** The fold of one Session's shared tasks list. */
export interface TeamBoardState {
  /** Whether the list shows every task instead of holding back the tasks past its limit. */
  unfolded: boolean
}

/** The shared tasks store's write set. */
type TeamBoardActions = {
  unfoldedSet: (draft: TeamBoardState, unfolded: boolean) => void
}

/**
 * Declare the shared tasks section's store.
 * @returns the store handle to declare on the registration.
 */
export function createTeamBoardStore(): EngineStoreHandle<TeamBoardState, TeamBoardActions> {
  return defineStore({
    init: (): TeamBoardState => ({ unfolded: false }),
    actions: {
      /**
       * Record the user's choice to show every task or fold the list again.
       * @param d - draft state.
       * @param unfolded - whether the list now shows every task.
       */
      unfoldedSet: (d, unfolded: boolean) => {
        d.unfolded = unfolded
      },
    },
  })
}
