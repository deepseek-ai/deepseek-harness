/** Loaded Office previews survive body remounts until reload or tab closure. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { OfficeFileBytes } from './cache.ts'

/** One requested source revision and its settled preview. */
export interface OfficeView {
  readonly revision: number
  readonly file?: OfficeFileBytes
  readonly failure?: { readonly code: string; readonly message: string }
}

/** Office-owned content, isolated by tab identity. */
export interface OfficeState {
  byTab: Record<TabId, OfficeView>
}

type OfficeActions = {
  loading: (state: OfficeState, tab: TabId, revision: number) => void
  complete: (state: OfficeState, tab: TabId, revision: number, file: OfficeFileBytes) => void
  failed: (state: OfficeState, tab: TabId, revision: number, failure: NonNullable<OfficeView['failure']>) => void
  forget: (state: OfficeState, tab: TabId) => void
}

/**
 * Retain Office contents across body remounts within a Session.
 * @returns the tab-content store declaration.
 */
export function createOfficeStore(): EngineStoreHandle<OfficeState, OfficeActions> {
  return defineStore({
    init: (): OfficeState => ({ byTab: {} }),
    actions: {
      /** @param state - draft. @param tab - owning tab. @param revision - new content revision. */
      loading(state, tab: TabId, revision: number) { state.byTab[tab] = { revision } },
      /** @param state - draft. @param tab - owning tab. @param revision - completed revision. @param file - borrowed PDF bytes. */
      complete(state, tab: TabId, revision: number, file: OfficeFileBytes) {
        state.byTab[tab] = { revision, file }
      },
      /** @param state - draft. @param tab - owning tab. @param revision - failed revision. @param failure - displayable failure. */
      failed(state, tab: TabId, revision: number, failure: NonNullable<OfficeView['failure']>) {
        state.byTab[tab] = { revision, failure }
      },
      /** @param state - draft. @param tab - closed tab. */
      forget(state, tab: TabId) {
        const { [tab]: _closed, ...remaining } = state.byTab
        state.byTab = remaining
      },
    },
  })
}

/** Store declaration used by the Office body. */
export type OfficeStore = ReturnType<typeof createOfficeStore>
