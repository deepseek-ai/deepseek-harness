/** Read-only Markdown viewer for logged plans and temporary review documents. */
import { useMemo } from 'react'
import { FileTypeIcon, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from './plan-resource.ts'
import { isReviewPreviewAddress } from './review-preview.ts'
import { planFailureLine } from './failure-line.ts'
import css from './PlanPreview.module.css'

type PlanPreviewProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'plan'>

/**
 * Render the submitted plan with its complete Markdown.
 * @param props - Framework-bound tab identity, resource, and copy.
 * @returns the plan document or a localized loading/failure state.
 */
export function PlanPreview({ useTabInfo, useResource, t }: PlanPreviewProps) {
  const tab = useTabInfo()
  const resource = useResource<'plan'>(tab.tab.navigation.address)
  const temporary = isReviewPreviewAddress(tab.tab.navigation.address)
  const params = tab.tab.navigation.params
  const plan = temporary ? (params !== undefined && 'planReview' in params ? params.planReview : undefined) : resource.value
  const labels = useMemo(() => ({
    code: { copyLabel: t('copy'), copiedLabel: t('copied'), toolbarLabels: { codeLabel: t('codeBlock.title'), wrapLabel: t('codeBlock.wrap'), unwrapLabel: t('codeBlock.unwrap') } },
    footnotes: t('markdown.footnotes'),
  }), [t])
  if (plan === undefined) return (
    <div className={css.message} role="status">
      {temporary ? t('preview.expired') : resource.status === 'none' ? t('preview.unavailable')
        : resource.status === 'failed' ? t('preview.failed') : t('preview.loading')}
      {!temporary && resource.failure !== undefined && <p>{planFailureLine(t, resource.failure)}</p>}
    </div>
  )
  return (
    <section className={css.preview} data-plan-preview={'callId' in plan ? plan.callId : tab.tab.navigation.address} aria-label={plan.title}>
      <div className={css.document}><MarkdownText text={plan.markdown} labels={labels} /></div>
    </section>
  )
}

/**
 * Display a plain file icon and the heading in its tab after resource recovery.
 * @param props - Framework-bound tab identity and resource reader.
 * @returns a decorative file icon followed by the recovered title or initial localized label.
 */
export function PlanTitle({ useTabInfo, useResource }: PropsRuntime<'sidebar.right.pane.tab.title'>) {
  const tab = useTabInfo()
  const resource = useResource<'plan'>(tab.tab.navigation.address)
  const params = tab.tab.navigation.params
  const plan = isReviewPreviewAddress(tab.tab.navigation.address)
    ? (params !== undefined && 'planReview' in params ? params.planReview : undefined) : resource.value
  return <><FileTypeIcon kind="other" size={16} className={css.titleIcon} />{plan?.title ?? tab.tab.title}</>
}
