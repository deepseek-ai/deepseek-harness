/** Plain text implementation registered through the same document extension points as other viewers. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../index.ts'
import type { DocumentPreviewDefinition } from '../document/registry.ts'
import { TextBody } from './TextBody.tsx'

/** Stable plain-text implementation identity within this package. */
export const PLAIN_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/text'

/**
 * Describe the plain-text fallback.
 * @param title - locale-owned implementation name.
 * @returns plain-text registration metadata.
 */
export function textBodyDefinition(title: () => string): DocumentPreviewDefinition {
  return { id: PLAIN_BODY_ID, extensions: [], priority: 'builtin', title, loading: 'text-pages', wrap: true }
}

/** @param ctx - owning plugin context. Register the fallback metadata and keyed body. */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind('sidebarDocumentPreview')
  ctx.effect(() => ctx.documentPreviews.register(textBodyDefinition(() => t('viewer.text'))))
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
    { name: 'sidebar.right.tab.document', key: PLAIN_BODY_ID }, TextBody,
  )))
}
