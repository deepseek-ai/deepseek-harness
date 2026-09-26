/** Code preview metadata and body registered through the public document extension points. */
import type { Context } from '@deepseek-ai/cordis'
import { CODE_HIGHLIGHT_EXTENSIONS } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '../index.ts'
import { CodeBody } from './CodeBody.tsx'
import { en, zh } from './locales.ts'

const ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/code'
const NS = 'sidebarCodePreview'

/** @param ctx - owning plugin context. Register localized metadata and the matching keyed document body. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }))
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.documentPreviews.register({
    id: ID,
    extensions: CODE_HIGHLIGHT_EXTENSIONS,
    priority: 'builtin',
    title: () => t('title'),
    loading: 'text-pages',
    wrap: true,
  }))
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register(
    { name: 'sidebar.right.tab.document', key: ID, locale: NS }, CodeBody,
  )))
}
