/** Inline comment records and the editing of comment drafts kept in the browser at their captured code location. */

import { useCallback, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReviewActions } from './ReviewComposer.tsx'
import { CardMenu, DeleteConfirm } from './ReviewThreads.tsx'
import { EMPTY_FILE_REVIEW, type FileReviewState, type ReviewThread as Thread } from './review-queue.ts'
import { INPUT_QUOTE_COPY, reviewRange, settleQuote } from './review.ts'
import type { NS } from './locales.ts'
import css from './ReviewThreads.module.css'
import composerCss from './ReviewComposer.module.css'

const noSubscription = (): (() => void) => () => {}

/**
 * Subscribe only to comments that belong to the displayed file and source.
 * @param actions - review actions and their browser store.
 * @param path - displayed file path.
 * @returns stable file-scoped comments and write availability.
 */
export function useFileReview(actions: ReviewActions | undefined, path: string): FileReviewState {
  const read = useCallback(() => actions?.records?.fileComments(path, actions.source) ?? EMPTY_FILE_REVIEW,
    [actions?.records, actions?.source, path])
  return useSyncExternalStore(actions?.records?.subscribe ?? noSubscription, read)
}

/**
 * Render a saved comment at its line: its lines and state, the menu of its less frequent actions, its text, and Add to
 * input. A reference or a publication receipt can be removed from the view, which leaves the main input and the code
 * host as they are. A comment draft kept in the browser can be edited, deleted after a confirmation, or moved into the
 * pending review on the code host.
 * @param props - record, edit availability, source actions, and localized copy.
 * @returns one compact inline comment card.
 */
export function ReviewThread({ thread, actions, locked, outdated, t }: PropsLocale<typeof NS> & {
  readonly thread: Thread
  readonly actions: ReviewActions
  readonly locked: boolean
  readonly outdated: boolean
}): ReactNode {
  const [mode, setMode] = useState<'view' | 'edit' | 'delete'>('view')
  const [body, setBody] = useState(thread.selection.comment.body)
  const [error, setError] = useState<string | null>(null)
  const [moving, setMoving] = useState(false)
  const comment = thread.selection.comment
  // A draft published while its form is open becomes a receipt, which has neither form.
  const editing = mode === 'edit' && thread.kind === 'pending'
  const confirming = mode === 'delete' && thread.kind === 'pending'
  const quoted = editing ? { ...thread.selection, comment: { ...comment, body } } : thread.selection
  const range = reviewRange(comment)
  const copy = actions.quoteCopy ?? INPUT_QUOTE_COPY
  const status = thread.kind === 'pending' ? 'review.browserDraft' : thread.kind === 'published' ? 'review.published' : copy.added
  const save = (): boolean => actions.records?.editThread(thread.key, body) === true
  const queue = actions.queue
  const waiting = locked || moving
  /** Add the draft to the pending review on the code host, then delete it from the browser. */
  const move = async (add: NonNullable<ReviewActions['queue']>): Promise<void> => {
    setMoving(true)
    setError(null)
    try {
      const failure = await add(thread.selection)
      if (failure !== undefined) setError(failure)
      else if (actions.records?.editThread(thread.key, null) !== true) setError(t('review.saveFailed'))
    } catch (_error) {
      setError(t('review.unknown'))
    } finally {
      setMoving(false)
    }
  }
  const select = (id: string): void => {
    if (id === 'edit') {
      setBody(comment.body)
      setMode('edit')
    } else if (id === 'delete') setMode('delete')
    else {
      const removed = actions.records?.removeRecord(thread.key) ?? null
      if (removed === null) setError(t('review.saveFailed'))
      else actions.onRemoved?.(removed)
    }
  }
  return <section className={css.card} data-forge-review-thread={thread.kind} data-side={comment.side} aria-label={t('review.range', { range })}>
    <div className={css.recordHeader}>
      <div className={css.recordInfo}>
        <span className={css.place}>{range}</span>
        <Tag tone="neutral">{t(status)}</Tag>
        {outdated && <Tag tone="neutral">{t('review.outdated')}</Tag>}
      </div>
      {!confirming && <CardMenu label={t('review.recordActions', { range })} disabled={thread.kind === 'pending' && waiting}
        select={select} items={thread.kind === 'pending'
          // A draft being edited keeps Delete, the way out of a draft whose text the reader emptied.
          ? [...editing ? [] : [{ id: 'edit', label: t('review.edit') }], { id: 'delete', label: t('review.remove') }]
          : [{ id: 'remove', label: t('review.removeRecord') }]} />}
    </div>
    {editing
      ? <textarea autoFocus className={composerCss.input} rows={3} value={body} disabled={locked} aria-label={t('review.comment')}
        onChange={(event) => {
          setBody(event.target.value)
          if (actions.records?.editThread(thread.key, event.target.value) === true) setError(null)
          else setError(t('review.saveFailed'))
        }} />
      : <div className={css.plain}>{comment.body}</div>}
    {confirming && <DeleteConfirm question={t('thread.deleteConfirm')} confirmLabel={t('review.remove')} disabled={waiting} error={error}
      cancel={() => { setError(null); setMode('view') }}
      confirm={() => { if (actions.records?.editThread(thread.key, null) !== true) setError(t('review.saveFailed')) }} t={t} />}
    {error !== null && !confirming && <div className={composerCss.error} role="alert">{error}</div>}
    <div className={css.actions}>
      <Button size="sm" disabled={quoted.comment.body.trim() === ''} onClick={() => {
        settleQuote(actions.addToInput(quoted), (accepted) => { if (!accepted) setError(t(copy.failed)) })
      }}>{t(copy.add)}</Button>
      {editing && <Button size="sm" disabled={waiting || body.trim() === ''} onClick={() => {
        if (save()) { setMode('view'); setError(null) } else setError(t('review.saveFailed'))
      }}>{t('review.done')}</Button>}
      {thread.kind === 'pending' && queue !== undefined && mode === 'view' && !outdated && <Button size="sm" disabled={waiting}
        onClick={() => { void move(queue) }}>
        {t(moving ? 'review.publishing' : actions.reviewStarted === true ? 'review.queue' : 'review.startReview')}
      </Button>}
      {thread.kind === 'published' && actions.openLink !== undefined && <Button size="sm" onClick={() => { actions.openLink?.(thread.url) }}>{t('review.recheck')}</Button>}
    </div>
  </section>
}
