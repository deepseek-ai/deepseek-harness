/** Builtin PDF registration through document metadata and the keyed body slot. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../index.ts'
import type { DocumentPreviewDefinition } from '../document/registry.ts'
import type { PdfBodyInjected } from './pdf.tsx'
import { LazyPdfBody } from './LazyPdfBody.tsx'
import { createPdfStore } from './store.ts'
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
  const store = createPdfStore()
  const retained = new Map<AbortSignal, () => void>()
  ctx.effect(() => () => {
    for (const forget of retained.values()) forget()
  })
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
    name: 'sidebar.right.tab.document', key: PDF_BODY_ID, locale: 'sidebarPdf', store,
    inject: (_sessionId, actions): PdfBodyInjected => ({
      retainTab: (tabId, signal) => {
        if (signal.aborted) { actions.forget(tabId); return }
        if (retained.has(signal)) return
        const forget = (): void => {
          signal.removeEventListener('abort', forget)
          retained.delete(signal)
          actions.forget(tabId)
        }
        retained.set(signal, forget)
        signal.addEventListener('abort', forget, { once: true })
      },
    }),
  }, LazyPdfBody)))
}
