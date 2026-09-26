/** Tab-local zoom preferences for renderers without additional view state. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { FIT_WIDTH, type ZoomPreference } from './types.ts'

/** Tab-lifetime callback supplied by a zoomable renderer registration. */
export interface ZoomInjected {
  /** @param tabId - owning tab. @param signal - complete tab-record lifetime. */
  readonly retainTab: (tabId: TabId, signal: AbortSignal) => void
}

/** Zoom state isolated by the owning tab record. */
export interface ZoomState {
  byTab: Record<TabId, ZoomPreference>
}

type ZoomActions = {
  zoom: (draft: ZoomState, tabId: TabId, preference: ZoomPreference) => void
  forget: (draft: ZoomState, tabId: TabId) => void
}

/**
 * Create tab-local zoom state for a document renderer registration.
 * @returns a store declaration retaining zoom until its tab closes.
 */
export function createZoomStore(): EngineStoreHandle<ZoomState, ZoomActions> {
  return defineStore({
    init: (): ZoomState => ({ byTab: {} }),
    actions: {
      zoom: (draft, tabId: TabId, preference: ZoomPreference) => { draft.byTab[tabId] = preference },
      forget: (draft, tabId: TabId) => {
        const { [tabId]: _closed, ...remaining } = draft.byTab
        draft.byTab = remaining
      },
    },
  })
}

/** Default zoom value for a tab without retained state. */
export const DEFAULT_ZOOM = FIT_WIDTH

/** Store declaration used by image previews. */
export type ZoomStore = ReturnType<typeof createZoomStore>
