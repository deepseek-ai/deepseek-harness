/** Centered review submission with a summary, decision, and pending-comment count, and the discarding of a pending review. */

import { useId, useState, useSyncExternalStore, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { ForgePendingReview, ForgeReviewEvent } from '@deepseek-ai/dsh-experimental-forge/types'
import type { ReviewQueue } from './review-queue.ts'
import type { NS } from './locales.ts'
import css from './SubmitReview.module.css'
import reviewCss from './ReviewComposer.module.css'

/**
 * Submit a review independently of the diff scroll position; comments remain at their code locations. With a pending
 * review on the code host, the review holds its comments, and comment drafts kept in the browser must leave first.
 * @param props - durable queue, current head, the pending review, submission outcome, and modal actions.
 * @returns a portalled modal with keyboard focus ownership.
 */
export function SubmitReview({
  queue, url, headSha, pending, events, busy, error, submit, discard, close, check, reconcile, t,
}: PropsLocale<typeof NS> & {
  readonly queue: ReviewQueue
  readonly url: string
  readonly headSha: string
  /** The signed-in user's pending review on the code host, or null without one. */
  readonly pending: ForgePendingReview | null
  /** Decisions the code host lets the signed-in user record, or null before the review threads are read, which offers all. */
  readonly events: readonly ForgeReviewEvent[] | null
  readonly busy: boolean
  readonly error: string | null
  readonly submit: () => void
  /** Discard the pending review, or undefined without one. */
  readonly discard: (() => void) | undefined
  readonly close: () => void
  readonly check: () => void
  readonly reconcile: () => void
}): ReactNode {
  const state = useSyncExternalStore(queue.subscribe, queue.getSnapshot)
  const [confirming, setConfirming] = useState(false)
  const name = useId()
  const summaryHint = `${name}-summary-hint`
  const requiresSummary = state.event === 'request-changes'
  const locked = busy || state.uncertain !== null
  const allowed = (event: ForgeReviewEvent): boolean => events === null || events.includes(event)
  // A decision kept from another change request stays chosen until the reader picks an allowed one.
  const refused = !allowed(state.event)
  // The host allows only comments, as GitHub does for the author of a pull request.
  const commentOnly = events !== null && events.length === 1 && events[0] === 'comment'
  const count = pending?.comments ?? state.comments.length
  // Drafts kept in the browser join only a review published without a pending one on the code host.
  const blocked = pending !== null && state.comments.length > 0
  const stale = pending === null
    && state.comments.some(item => item.source.kind !== 'change' || item.source.url !== url || item.source.headSha !== headSha)
  const empty = (pending === null && state.comments.some(item => item.comment.body.trim() === ''))
    || (requiresSummary && state.body.trim() === '')
    || (state.event === 'comment' && state.body.trim() === '' && count === 0)
  const notice = state.error !== null ? t(state.error === 'load' ? 'review.loadFailed' : 'review.saveFailed')
    : blocked ? t('review.browserDrafts', { count: state.comments.length }) : stale ? t('review.stale') : error
  return <Modal open onClose={close} title={t('review.submit')} closeLabel={t('review.close')}
    className={clsx(css.modal)} contentClassName={clsx(css.content)}
    footer={<>
      {discard !== undefined && <Button variant="outline" className={clsx(css.discard)} disabled={locked || confirming}
        onClick={() => { setConfirming(true) }}>{t('review.discard')}</Button>}
      <Button variant="outline" onClick={close}>{t('review.cancel')}</Button>
      <Button variant="primary" disabled={locked || confirming || blocked || stale || empty || refused || state.error !== null} onClick={submit}>
        {t(busy && !confirming ? 'review.submitting' : 'review.submit')}
      </Button>
    </>}>
    <div className={css.form}>
      <div className={css.count}>{t('review.drafts', { count })}</div>
      {discard !== undefined && confirming && <div className={css.confirm} role="group" aria-label={t('review.discard')}>
        <span className={css.confirmText}>{t('review.discardConfirm', { count })}</span>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => { setConfirming(false) }}>{t('review.cancel')}</Button>
        <Button size="sm" variant="primary" disabled={busy} onClick={discard}>{t(busy ? 'review.discarding' : 'review.discard')}</Button>
      </div>}
      <div className={css.summary}>
        <textarea data-modal-autofocus className={clsx(reviewCss.input, css.input)} rows={4} disabled={locked} value={state.body}
          aria-label={t('review.summary')} placeholder={t('review.summary')} required={requiresSummary}
          aria-describedby={requiresSummary ? summaryHint : undefined}
          onChange={(event) => { queue.summarize(event.target.value, state.event) }} />
        <div id={summaryHint} className={css.hint} role="status">{requiresSummary ? t('review.summaryRequired') : ''}</div>
      </div>
      <div className={css.decisions}>
        {(['comment', 'approve', 'request-changes'] as const).map(value => <label key={value}>
          <input type="radio" name={name} value={value} checked={state.event === value} disabled={locked || !allowed(value)}
            onChange={() => { queue.summarize(state.body, value) }} />
          {t(value === 'comment' ? 'review.commentOnly' : value === 'approve' ? 'review.approve' : 'review.requestChanges')}
        </label>)}
      </div>
      {commentOnly && <div className={css.hint}>{t('review.decisionsLimited')}</div>}
      {notice !== null && <div className={css.error} role="alert">{notice}</div>}
      {state.uncertain !== null && !busy && <div className={css.reconcile}>
        <Button size="sm" variant="outline" onClick={check}>{t('review.recheck')}</Button>
        <Button size="sm" variant="outline" onClick={reconcile}>{t('review.confirmRetry')}</Button>
      </div>}
    </div>
  </Modal>
}
