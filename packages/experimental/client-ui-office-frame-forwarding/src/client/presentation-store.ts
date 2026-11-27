/** Mounted presentation controls shared with the owning document header. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit/client'

/** One mounted presentation's playback command and availability. */
export interface PresentationAction {
  readonly disabled: boolean
  /** Start playback of the current slide. */
  readonly play: () => void
}

type PresentationState = { byTab: Record<TabId, PresentationAction> }
type PresentationActions = {
  present: (state: PresentationState, tab: TabId, action: PresentationAction) => void
  retire: (state: PresentationState, tab: TabId, play: PresentationAction['play']) => void
}

/** Declare tab-owned presentation controls without retaining a closed view.
 * @returns the shared header/body store declaration.
 */
export function createPresentationStore(): EngineStoreHandle<PresentationState, PresentationActions> {
  return defineStore({
    init: (): PresentationState => ({ byTab: {} }),
    actions: {
      /** @param state - draft. @param tab - owning tab. @param action - current playback controls. */
      present(state, tab: TabId, action: PresentationAction) { state.byTab[tab] = action },
      /** @param state - draft. @param tab - retired tab. @param play - retired playback callback. */
      retire(state, tab: TabId, play: PresentationAction['play']) {
        if (state.byTab[tab]?.play !== play) return
        const { [tab]: _retired, ...remaining } = state.byTab
        state.byTab = remaining
      },
    },
  })
}

/** Header and body share the same Session-scoped declaration. */
export type PresentationStore = ReturnType<typeof createPresentationStore>
