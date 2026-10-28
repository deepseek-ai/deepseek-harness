/** Inline comment records and editing of a pending review at its captured code location. */

import { useCallback, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReviewActions } from './ReviewComposer.tsx'
import { EMPTY_FILE_REVIEW, type FileReviewState, type ReviewThread as Thread } from './review-queue.ts'
import type { NS } from './locales.ts'
import css from './ReviewComposer.module.css'

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
 * Render a saved comment at its line, with pending edits kept in the browser queue.
 * @param props - record, edit availability, source actions, and localized copy.
 * @returns one compact inline comment card.
 */
export function ReviewThread({ thread, actions, locked, outdated, split, t }: PropsLocale<typeof NS> & {
  readonly thread: Thread
  readonly actions: ReviewActions
  readonly locked: boolean
  readonly outdated: boolean
  readonly split: boolean
}): ReactNode {
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(thread.selection.comment.body)
  const [error, setError] = useState<string | null>(null)
  const comment = thread.selection.comment
  const quoted = editing && thread.kind === 'pending' ? { ...thread.selection, comment: { ...comment, body } } : thread.selection
  const range = `${comment.side}${comment.startLine}${comment.endLine === comment.startLine ? '' : `–${comment.endLine}`}`
  const status = thread.kind === 'pending' ? 'review.pending' : thread.kind === 'published' ? 'review.published' : 'review.quoted'
  const save = (): boolean => actions.records?.editThread(thread.key, body) === true
  return <section className={css.thread} data-forge-review-thread={thread.kind} data-side={comment.side}
    data-split={split ? '' : undefined} aria-label={t('review.range', { range })}>
    <div className={css.threadHeader}>
      <span className={css.author}>{t('review.yourComment')}</span>
      <span className={css.range}>{range}</span>
      <Tag tone="neutral">{t(outdated ? 'review.outdated' : status)}</Tag>
    </div>
    {editing && thread.kind === 'pending'
      ? <textarea autoFocus className={css.input} rows={3} value={body} disabled={locked} aria-label={t('review.comment')}
        onChange={(event) => {
          setBody(event.target.value)
          if (actions.records?.editThread(thread.key, event.target.value) === true) setError(null)
          else setError(t('review.saveFailed'))
        }} />
      : <div className={css.commentBody}>{comment.body}</div>}
    {error !== null && <div className={css.error} role="alert">{error}</div>}
    <div className={css.threadActions}>
      <Button size="sm" disabled={quoted.comment.body.trim() === ''} onClick={() => {
        if (!actions.addToInput(quoted)) setError(t('review.inputFailed'))
      }}>{t('review.addToInput')}</Button>
      {thread.kind === 'pending' && <>
        {editing
          ? <Button size="sm" disabled={locked || body.trim() === ''} onClick={() => {
            if (save()) { setEditing(false); setError(null) } else setError(t('review.saveFailed'))
          }}>{t('review.done')}</Button>
          : <Button size="sm" disabled={locked} onClick={() => { setBody(comment.body); setEditing(true) }}>{t('review.edit')}</Button>}
        <Button size="sm" disabled={locked} onClick={() => {
          if (actions.records?.editThread(thread.key, null) !== true) setError(t('review.saveFailed'))
        }}>{t('review.remove')}</Button>
      </>}
      {thread.kind === 'published' && actions.openLink !== undefined && <Button size="sm" onClick={() => { actions.openLink?.(thread.url) }}>{t('review.recheck')}</Button>}
    </div>
  </section>
}
