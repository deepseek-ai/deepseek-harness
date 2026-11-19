/** Render a persisted compaction summary through the shared Markdown document body. */
import { FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type {} from './resource.ts'
import css from './SummaryPreview.module.css'

type SummaryProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'compaction'> & PropsRenderFactories

/** Localized tab title, including after layout restoration.
 * @param props - preview translations.
 * @returns the summary title.
 */
export function SummaryTitle({ t }: PropsLocale<'compaction'>) {
  return <><FileTypeIcon kind="markdown" size={16} className={css.titleIcon} />{t('preview.title')}</>
}

/** Render a saved summary address or its current read status.
 * @param props - tab, resource subscription, shared document Factory, and locale.
 * @returns the summary view.
 */
export function SummaryPreview({ useTabInfo, useResource, renderFactorySlot, t }: SummaryProps) {
  const { tab } = useTabInfo()
  const resource = useResource<'compaction'>(tab.contentId)
  if (resource.value === undefined) {
    const missing = resource.status === 'none' || resource.failure?.code === 'compaction-summary/not-found'
      || resource.failure?.code === 'compaction-summary/invalid-address'
    const failed = resource.status === 'failed'
    return <div className={css.message} role={missing || failed ? 'alert' : 'status'}>
      {missing ? t('preview.notFound') : failed ? t('preview.readFailed') : t('preview.loading')}
    </div>
  }
  return renderFactorySlot('sidebar.right.document.body', {
    title: t('preview.title'), content: { mediaType: 'text/markdown', text: resource.value.markdown }, useTabInfo,
  })
}
