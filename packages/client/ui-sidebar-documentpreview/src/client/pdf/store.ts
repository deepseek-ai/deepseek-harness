/** Restorable PDF viewing preferences; document objects and canvases remain component-local. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { ZoomPreference } from '../zoom/types.ts'

/** One tab's last visible page and optional PDF zoom preference. */
export interface PdfView {
  readonly page: number
  readonly zoom?: ZoomPreference
}

/** Page state isolated by the owning tab record. */
export interface PdfState {
  byTab: Record<TabId, PdfView>
}

type PdfActions = {
  page: (draft: PdfState, tabId: TabId, page: number) => void
  zoom: (draft: PdfState, tabId: TabId, zoom: ZoomPreference) => void
  forget: (draft: PdfState, tabId: TabId) => void
}

/**
 * Declare the last visible page and zoom preference isolated by tab identity.
 * @returns a store declaration instantiated by the document slot for each Session.
 */
export function createPdfStore(): EngineStoreHandle<PdfState, PdfActions> {
  return defineStore({
    init: (): PdfState => ({ byTab: {} }),
    actions: {
      /** @param draft - view state. @param tabId - owning tab. @param page - selected 1-based page. */
      page: (draft, tabId: TabId, page: number) => {
        draft.byTab[tabId] = { ...draft.byTab[tabId], page }
      },
      /** @param draft - view state. @param tabId - owning tab. @param zoom - selected scale multiplier. */
      zoom: (draft, tabId: TabId, zoom: ZoomPreference) => {
        draft.byTab[tabId] = { page: draft.byTab[tabId]?.page ?? 1, zoom }
      },
      /** @param draft - view state. @param tabId - closed tab whose preferences are discarded. */
      forget: (draft, tabId: TabId) => {
        const remaining: PdfState['byTab'] = {}
        for (const [id, view] of Object.entries(draft.byTab) as [TabId, PdfView][]) {
          if (id !== tabId) remaining[id] = view
        }
        draft.byTab = remaining
      },
    },
  })
}

/** Store declaration used by the PDF body registration. */
export type PdfStore = ReturnType<typeof createPdfStore>
