/** Centered review submission with a summary, decision, and pending-comment count. */

import { useId, useSyncExternalStore, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReviewQueue } from './review-queue.ts'
import type { NS } from './locales.ts'
import css from './SubmitReview.module.css'
import reviewCss from './ReviewComposer.module.css'

/**
 * Submit a review independently of the diff scroll position; comments remain at their code locations.
 * @param props - durable queue, current head, submission outcome, and modal actions.
 * @returns a portalled modal with keyboard focus ownership.
 */
export function SubmitReview({ queue, url, headSha, busy, error, submit, close, check, reconcile, t }: PropsLocale<typeof NS> & {
  readonly queue: ReviewQueue
  readonly url: string
  readonly headSha: string
  readonly busy: boolean
  readonly error: string | null
  readonly submit: () => void
  readonly close: () => void
  readonly check: () => void
  readonly reconcile: () => void
}): ReactNode {
  const state = useSyncExternalStore(queue.subscribe, queue.getSnapshot)
  const name = useId()
  const summaryHint = `${name}-summary-hint`
  const requiresSummary = state.event === 'request-changes'
  const locked = busy || state.uncertain !== null
  const stale = state.comments.some(item => item.source.kind !== 'change' || item.source.url !== url || item.source.headSha !== headSha)
  const empty = state.comments.some(item => item.comment.body.trim() === '')
    || (requiresSummary && state.body.trim() === '')
    || (state.event === 'comment' && state.body.trim() === '' && state.comments.length === 0)
  const notice = state.error !== null ? t(state.error === 'load' ? 'review.loadFailed' : 'review.saveFailed')
    : stale ? t('review.stale') : error
  return <Modal open onClose={close} title={t('review.submit')} closeLabel={t('review.close')}
    className={clsx(css.modal)} contentClassName={clsx(css.content)}
    footer={<>
      <Button variant="outline" onClick={close}>{t('review.cancel')}</Button>
      <Button variant="primary" disabled={locked || stale || empty || state.error !== null} onClick={submit}>
        {t(busy ? 'review.submitting' : 'review.submit')}
      </Button>
    </>}>
    <div className={css.form}>
      <div className={css.count}>{t('review.drafts', { count: state.comments.length })}</div>
      <div className={css.summary}>
        <textarea data-modal-autofocus className={clsx(reviewCss.input, css.input)} rows={4} disabled={locked} value={state.body}
          aria-label={t('review.summary')} placeholder={t('review.summary')} required={requiresSummary}
          aria-describedby={requiresSummary ? summaryHint : undefined}
          onChange={(event) => { queue.summarize(event.target.value, state.event) }} />
        <div id={summaryHint} className={css.hint} role="status">{requiresSummary ? t('review.summaryRequired') : ''}</div>
      </div>
      <div className={css.decisions}>
        {(['comment', 'approve', 'request-changes'] as const).map(value => <label key={value}>
          <input type="radio" name={name} value={value} checked={state.event === value} disabled={locked}
            onChange={() => { queue.summarize(state.body, value) }} />
          {t(value === 'comment' ? 'review.commentOnly' : value === 'approve' ? 'review.approve' : 'review.requestChanges')}
        </label>)}
      </div>
      {notice !== null && <div className={css.error} role="alert">{notice}</div>}
      {state.uncertain !== null && !busy && <div className={css.reconcile}>
        <Button size="sm" variant="outline" onClick={check}>{t('review.recheck')}</Button>
        <Button size="sm" variant="outline" onClick={reconcile}>{t('review.confirmRetry')}</Button>
      </div>}
    </div>
  </Modal>
}
