/**
 * The expansion the user chose for the change request cards of one Session, and whether its list shows every card. The
 * registration declares it as an exclusive store, so each Session keeps its
 * choices while its scope is retained, across hiding and showing the panel.
 */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** Card choices of one Session. */
export interface ChangeRequestsSectionState {
  /** Whether the user expanded (true) or collapsed (false) a card, by change request URL; unchosen cards are absent. */
  expanded: Record<string, boolean>
  /** Whether the list shows the cards past its first three. */
  unfolded: boolean
}

/** The change requests section store's write set. */
type ChangeRequestsSectionActions = {
  toggled: (draft: ChangeRequestsSectionState, url: string, expanded: boolean) => void
  unfoldedSet: (draft: ChangeRequestsSectionState, unfolded: boolean) => void
}

/**
 * Declare the change requests section's store.
 * @returns the store handle to declare on the registration.
 */
export function createChangeRequestsSectionStore(): EngineStoreHandle<ChangeRequestsSectionState, ChangeRequestsSectionActions> {
  return defineStore({
    init: (): ChangeRequestsSectionState => ({ expanded: {}, unfolded: false }),
    actions: {
      /**
       * Record the user's choice for one card.
       * @param d - draft state.
       * @param url - the change request's URL.
       * @param expanded - whether the card is now expanded.
       */
      toggled: (d, url: string, expanded: boolean) => {
        d.expanded[url] = expanded
      },
      /**
       * Show every card of the list, or fold it to its first three again.
       * @param d - draft state.
       * @param unfolded - whether the list now shows every card.
       */
      unfoldedSet: (d, unfolded: boolean) => {
        d.unfolded = unfolded
      },
    },
  })
}
