/** Excel previews use ordinary authorized file bytes without Office conversion. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../index.ts'
import type { Config } from '../../config.ts'
import { LazyExcelBody } from './LazyExcelBody.tsx'
import { en, zh } from './locales.ts'

/**
 * Register the browser Excel viewer and its lifecycle-owned slot.
 * @param ctx - Preview and locale registries.
 * @param limits - Resolved parser limits.
 */
export function apply(ctx: Context, limits: Config['excel']): void {
  const id = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/excel'
  ctx.effect(() => ctx.locale.register('sidebarExcel', { zh, en }))
  const t = ctx.locale.bind('sidebarExcel')
  ctx.effect(() => ctx.documentPreviews.register({
    id, extensions: ['xlsx', 'xls', 'csv', 'tsv'], binaryExtensions: ['xlsx', 'xls'], priority: 'builtin',
    title: () => t('title'), loading: 'bytes-complete', wrap: false,
  }))
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
    name: 'sidebar.right.tab.document', key: id, locale: 'sidebarExcel', inject: () => ({ limits }),
  }, LazyExcelBody)))
}
