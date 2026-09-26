/** Builtin PDF registration through document metadata and the keyed body slot. */
import type { Context } from '@deepseek-ai/cordis'
import { retainDocumentTabs } from '../document/tab-lifetime.ts'
import type {} from '../index.ts'
import type { DocumentPreviewDefinition } from '../document/registry.ts'
import type { PdfBodyInjected } from './pdf.tsx'
import { LazyPdfBody } from './LazyPdfBody.tsx'
import type { BoundActions } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createPdfStore, type PdfStore } from './store.ts'
import { ZoomViewport, zoomSurfaceClass } from '../zoom/ZoomViewport.tsx'
import { en, zh } from './locales.ts'

/** PDF metadata and keyed body share this package-local implementation identity. */
export const PDF_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/pdf'

/**
 * Describe the builtin PDF renderer independently from its keyed body slot.
 * @param title - locale-owned implementation name.
 * @returns the complete-file PDF registration.
 */
export function pdfBodyDefinition(title: () => string): DocumentPreviewDefinition {
  return { id: PDF_BODY_ID, extensions: ['pdf'], binaryExtensions: ['pdf'], priority: 'builtin', title, loading: 'bytes-complete', wrap: false }
}

/** @param ctx - context carrying the locale, document registry, and slot registry. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('sidebarPdf', { zh, en }))
  const t = ctx.locale.bind('sidebarPdf')
  ctx.effect(() => ctx.documentPreviews.register(pdfBodyDefinition(() => t('title'))))
  const presentation = pdfBodyRegistration(ctx)
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
    name: 'sidebar.right.tab.document', key: PDF_BODY_ID, locale: 'sidebarPdf', ...presentation,
  }, LazyPdfBody)))
}

/**
 * Retain PDF viewing state for a document entry's tab lifetime.
 * @param ctx - owning registration context.
 * @returns the store and injection shared by ordinary and Office PDF registrations.
 */
export function pdfBodyRegistration(ctx: Context): {
  store: PdfStore
  inject: (sessionId: SessionId, actions: BoundActions<PdfStore>) => PdfBodyInjected
} {
  const store = createPdfStore()
  const retainTab = retainDocumentTabs(ctx)
  return {
    store,
    inject: (_sessionId, actions): PdfBodyInjected => ({
      retainTab: (tabId, signal) => { retainTab(tabId, signal, actions.forget) },
      ZoomViewport,
      zoomSurfaceClass,
    }),
  }
}
