/** Loaded Office previews and native-rendering outcomes survive body remounts until reload or tab closure. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit/client'
import type { OfficeFileBytes } from './cache.ts'
import type { DocumentFileBytes } from '../rpc.ts'

/** One requested source revision and its settled preview. */
export interface OfficeView {
  readonly revision: number
  readonly file?: OfficeFileBytes | DocumentFileBytes
  readonly failure?: { readonly code: string; readonly message: string }
}

/** Office-owned content, isolated by tab identity. */
export interface OfficeState {
  byTab: Record<TabId, OfficeView>
  /** Content revision whose native rendering became unavailable; another revision attempts native rendering again. */
  nativeUnavailable: Record<TabId, number>
}

type OfficeActions = {
  loading: (state: OfficeState, tab: TabId, revision: number) => void
  complete: (state: OfficeState, tab: TabId, revision: number, file: OfficeFileBytes | DocumentFileBytes) => void
  failed: (state: OfficeState, tab: TabId, revision: number, failure: NonNullable<OfficeView['failure']>) => void
  nativeUnavailable: (state: OfficeState, tab: TabId, revision: number) => void
  forget: (state: OfficeState, tab: TabId) => void
}

/**
 * Retain Office contents across body remounts within a Session.
 * @returns the tab-content store declaration.
 */
export function createOfficeStore(): EngineStoreHandle<OfficeState, OfficeActions> {
  return defineStore({
    init: (): OfficeState => ({ byTab: {}, nativeUnavailable: {} }),
    actions: {
      /** @param state - draft. @param tab - owning tab. @param revision - new content revision. */
      loading(state, tab: TabId, revision: number) { state.byTab[tab] = { revision } },
      /** @param state - draft. @param tab - owning tab. @param revision - completed revision. @param file - borrowed fallback bytes. */
      complete(state, tab: TabId, revision: number, file: OfficeFileBytes | DocumentFileBytes) {
        state.byTab[tab] = { revision, file }
      },
      /** @param state - draft. @param tab - owning tab. @param revision - failed revision. @param failure - displayable failure. */
      failed(state, tab: TabId, revision: number, failure: NonNullable<OfficeView['failure']>) {
        state.byTab[tab] = { revision, failure }
      },
      /**
       * Content revisions only increase within a tab, so a report from a superseded revision cannot replace a newer one.
       * @param state - draft. @param tab - owning tab. @param revision - content revision whose native rendering failed.
       */
      nativeUnavailable(state, tab: TabId, revision: number) {
        const recorded = state.nativeUnavailable[tab]
        if (recorded === undefined || recorded < revision) state.nativeUnavailable[tab] = revision
      },
      /** @param state - draft. @param tab - closed tab. */
      forget(state, tab: TabId) {
        const { [tab]: _closed, ...remaining } = state.byTab
        const { [tab]: _native, ...native } = state.nativeUnavailable
        state.byTab = remaining
        state.nativeUnavailable = native
      },
    },
  })
}

/** Store declaration used by the Office body. */
export type OfficeStore = ReturnType<typeof createOfficeStore>
