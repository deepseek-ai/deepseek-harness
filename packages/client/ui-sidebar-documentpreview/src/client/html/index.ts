/** Builtin HTML metadata and keyed body registration; assembly belongs to the package entry. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../index.ts'
import type { DocumentPreviewDefinition } from '../document/registry.ts'
import { hostFileOf } from '../rpc.ts'
import { HtmlBody } from './HtmlBody.tsx'
import type { HtmlBodyProps } from './HtmlBody.tsx'
import { en, zh } from './locales.ts'

/** HTML implementation identity, shared by metadata and the keyed slot. */
export const HTML_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/html'

/**
 * Describe the builtin HTML renderer's file types and loading mode.
 * @param title - locale-owned implementation name.
 * @returns metadata for complete HTML documents.
 */
export function htmlBodyDefinition(title: () => string): DocumentPreviewDefinition {
  return { id: HTML_BODY_ID, extensions: ['html', 'htm'], priority: 'builtin', title, loading: 'bytes-complete', wrap: false }
}

/**
 * Register the HTML dictionary, metadata and body with reversible effects.
 * @param ctx - owning plugin context.
 */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind('documentHtml')
  ctx.effect(() => ctx.locale.register('documentHtml', { zh, en }))
  ctx.effect(() => ctx.documentPreviews.register(htmlBodyDefinition(() => t('title'))))
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
    {
      name: 'sidebar.right.tab.document', key: HTML_BODY_ID, locale: 'documentHtml',
      inject: (): Pick<HtmlBodyProps, 'readRelated'> => ({
        readRelated: (address, relativePath, signal) => {
          const file = hostFileOf(address)
          return ctx.remote.workspaceFiles.readRelated(file.sessionId, file.path, relativePath, signal)
        },
      }),
    }, HtmlBody,
  )))
}
