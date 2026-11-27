/** Transient Markdown read from a compaction event by its Chat row. */
import { FileTypeIcon, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots/client'
import css from './TextPreview.module.css'
import markdown from './markdown/MarkdownBody.module.css'

/** @param props - current tab navigation and Markdown labels.
 * @returns the summary or its expired state after a page reload.
 */
export function SummaryPreview({ useTabInfo, t }: PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'documentMarkdown'>) {
  const params = useTabInfo().tab.navigation.params
  const text = params && 'summaryMarkdown' in params ? params.summaryMarkdown : undefined
  return <section className={css.body} aria-label={t('summary.title')} data-compaction-preview>
    {text === undefined ? <p className={css.statusLine} role="status">{t('summary.expired')}</p>
      : <div className={markdown.document} data-document-markdown>
        <MarkdownText text={text} labels={{
          code: { copyLabel: t('code.copy'), copiedLabel: t('code.copied'), toolbarLabels: {
            codeLabel: t('codeBlock.title'), wrapLabel: t('codeBlock.wrap'), unwrapLabel: t('codeBlock.unwrap'),
          } }, footnotes: t('footnotes'),
        }} />
      </div>}
  </section>
}

/** @param props - current locale.
 * @returns the Markdown tab icon and localized summary title.
 */
export function SummaryTitle({ t }: PropsLocale<'documentMarkdown'>) {
  return <><FileTypeIcon kind="markdown" size={16} className={css.titleIcon} />{t('summary.title')}</>
}
