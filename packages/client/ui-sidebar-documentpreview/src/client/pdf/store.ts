/** Restorable PDF viewing preferences; document objects and canvases remain component-local. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'

/** One tab's last visible page. */
export interface PdfView {
  readonly page: number
}

/** Initial viewing position before a tab reaches another page. */
export const DEFAULT_PDF_VIEW: PdfView = { page: 1 }

/** Page state isolated by the owning tab record. */
export interface PdfState {
  byTab: Record<TabId, PdfView>
}

type PdfActions = {
  page: (draft: PdfState, tabId: TabId, page: number) => void
  forget: (draft: PdfState, tabId: TabId) => void
}

/**
 * Declare the last visible page isolated by tab identity.
 * @returns a store declaration instantiated by the document slot for each Session.
 */
export function createPdfStore(): EngineStoreHandle<PdfState, PdfActions> {
  return defineStore({
    init: (): PdfState => ({ byTab: {} }),
    actions: {
      /** @param draft - view state. @param tabId - owning tab. @param page - selected 1-based page. */
      page: (draft, tabId: TabId, page: number) => {
        draft.byTab[tabId] = { page }
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
