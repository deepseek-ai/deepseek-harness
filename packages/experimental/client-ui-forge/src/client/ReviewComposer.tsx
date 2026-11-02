/** Plain-text comment editor for a frozen selection in either review tab. */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconChevronDownOutlineRegular, Menu, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReviewQueue } from './review-queue.ts'
import type { ReviewSelection, ReviewSource } from './review.ts'
import type { NS } from './locales.ts'
import css from './ReviewComposer.module.css'

/** Actions supplied by the owning changes tab. */
export interface ReviewActions {
  /** The source currently displayed; selecting a range freezes it. */
  readonly source: ReviewSource
  /** Browser records shared by the changes tab. */
  readonly records?: ReviewQueue
  /** Whether another comment already started a pending review. */
  readonly reviewStarted?: boolean
  /** Open the confirmed publication URL. */
  readonly openLink?: (url: string) => void
  /** A write is running or its outcome still needs confirmation. */
  readonly publishingBlocked?: boolean
  /** Append an atomic quote without sending the Agent a message. */
  readonly addToInput: (selection: ReviewSelection) => boolean
  /** Retain a new comment after its quote was accepted. */
  readonly onQuoted?: (selection: ReviewSelection) => void
  /** Publish one comment; an error string preserves the editor. */
  readonly publish?: (selection: ReviewSelection) => Promise<string | undefined>
  /** Keep one comment for the final review; false preserves the editor. */
  readonly queue?: (selection: ReviewSelection) => boolean
}

function GitHubAction({ disabled, busy, started, queue, publish, t }: PropsLocale<typeof NS> & {
  readonly disabled: boolean
  readonly busy: boolean
  readonly started: boolean
  readonly queue: () => void
  readonly publish: (() => void) | undefined
}): ReactNode {
  const [open, setOpen] = useState(false)
  return <div className={css.gitAction}>
    <Button size="sm" variant="primary" className={clsx(css.gitMain)} disabled={disabled} onClick={queue}>
      {t(busy ? 'review.publishing' : started ? 'review.queue' : 'review.startReview')}
    </Button>
    {publish !== undefined && <Menu open={open && !disabled} portal dense align="end" autoFocus onClose={() => { setOpen(false) }}
      anchor={<Button size="sm" variant="primary" className={clsx(css.gitArrow)} disabled={disabled} aria-haspopup="menu" aria-expanded={open && !disabled}
        aria-label={t('review.githubActions')} onClick={() => { setOpen(value => !value) }}><IconChevronDownOutlineRegular size={14} /></Button>}>
      <MenuItemButton onSelect={() => { setOpen(false); publish() }}>{t('review.publish')}</MenuItemButton>
    </Menu>}
  </div>
}

/**
 * Render the line range, plain-text editor, and explicitly named destinations.
 * @param props - frozen selection, actions, cancellation, and localized copy.
 * @returns the inline comment form.
 */
export function ReviewComposer({ selection, actions, close, visible = true, split = false, t }: PropsLocale<typeof NS> & {
  readonly visible?: boolean
  readonly split?: boolean
  readonly selection: ReviewSelection
  readonly actions: ReviewActions
  readonly close: () => void
}): ReactNode {
  // The native field owns draft text; only action availability invalidates the surrounding diff's React tree.
  const body = useRef(selection.comment.body)
  const [empty, setEmpty] = useState(body.current.trim() === '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const running = useRef(false)
  const input = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { input.current?.focus() }, [])
  const comment = (): ReviewSelection => ({ ...selection, comment: { ...selection.comment, body: body.current } })
  const range = `${selection.comment.side}${selection.comment.startLine}${selection.comment.endLine === selection.comment.startLine ? '' : `–${selection.comment.endLine}`}`
  const publish = async (): Promise<void> => {
    if (running.current || actions.publish === undefined) return
    running.current = true
    setBusy(true)
    setError(null)
    try {
      const failure = await actions.publish(comment())
      if (failure === undefined) close()
      else setError(failure)
    } catch (_error) {
      setError(t('review.unknown'))
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  return (
    <section className={css.root} data-side={selection.comment.side} data-split={split ? '' : undefined} aria-label={t('review.range', { range })} data-forge-comment="">
      <div className={css.title}>{t('review.range', { range })}</div>
      <textarea ref={input} className={css.input} rows={3} defaultValue={selection.comment.body} disabled={busy}
        aria-label={t('review.comment')} placeholder={t('review.comment')}
        onChange={(event) => {
          body.current = event.target.value
          const nextEmpty = body.current.trim() === ''
          if (nextEmpty !== empty) setEmpty(nextEmpty)
          if (error !== null) setError(null)
        }} />
      {error !== null && <div className={css.error} role="alert">{error}</div>}
      <div className={css.actions}>
        <Button size="sm" className={clsx(css.cancel)} disabled={busy} onClick={close}>{t('review.cancel')}</Button>
        <Button size="sm" variant={actions.queue === undefined ? 'primary' : 'outline'} disabled={busy || empty} onClick={() => {
          const selected = comment()
          if (actions.addToInput(selected)) { actions.onQuoted?.(selected); close() }
          else setError(t('review.inputFailed'))
        }}>{t('review.addToInput')}</Button>
        {visible && actions.queue !== undefined && <GitHubAction
          disabled={busy || actions.publishingBlocked === true || empty} busy={busy} started={actions.reviewStarted === true}
          queue={() => {
            if (actions.queue?.(comment()) === true) close()
            else setError(t('review.saveFailed'))
          }} publish={actions.publish === undefined ? undefined : () => { void publish() }} t={t} />}
        {actions.queue === undefined && actions.publish !== undefined && <Button size="sm" variant="primary"
          disabled={busy || actions.publishingBlocked === true || empty} onClick={() => { void publish() }}>{t('review.publish')}</Button>}

      </div>
    </section>
  )
}
