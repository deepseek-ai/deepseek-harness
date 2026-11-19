/** Render a persisted compaction summary through the shared Markdown document body. */
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
  return <>{t('preview.title')}</>
}

/** Summary documents have no file dependencies or renderer-owned scrollport. */
function ignore(): void {}

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
  const text = resource.value.markdown
  const pageText = text.replace(/\n$/, '')
  return <section className={css.preview} data-compaction-preview={tab.contentId} aria-label={t('preview.title')}>
    {renderFactorySlot('sidebar.right.document.body', {
      rendererId: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/markdown', useTabInfo, resourceAddress: tab.contentId,
      content: { kind: 'text', text, eof: true, pages: [{ offset: 1, text: pageText, lines: pageText.split('\n').length }] },
      wrap: true, scrollportRef: ignore, addResource: ignore, setResources: ignore,
    })}
  </section>
}
