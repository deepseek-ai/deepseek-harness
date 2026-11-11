/** Plain-text comment editor for a frozen selection in either review tab. */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { Button, IconChevronDownOutlineRegular, Menu, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ReviewQueue } from './review-queue.ts'
import { reviewRange, type ReviewSelection, type ReviewSource } from './review.ts'
import type { NS } from './locales.ts'
import css from './ReviewComposer.module.css'

/** Actions supplied by the owning changes tab. */
export interface ReviewActions {
  /** The source currently displayed; selecting a range freezes it. */
  readonly source: ReviewSource
  /** Browser records shared by the changes tab. */
  readonly records?: ReviewQueue
  /** Whether the signed-in user has a pending review on the code host that the next comment joins. */
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
  /** Add one comment to the pending review on the code host, starting one when needed; an error string preserves the editor. */
  readonly queue?: (selection: ReviewSelection) => Promise<string | undefined>
}

/**
 * Render a primary action with an optional second action in its menu.
 * @param props - the main action, the optional menu action, the menu's name, and availability.
 * @returns the split button.
 */
export function SplitAction({ disabled, label, run, menuLabel, menu, other }: {
  readonly disabled: boolean
  readonly label: string
  readonly run: () => void
  /** Accessible name of the menu button. */
  readonly menuLabel: string
  /** Label of the action in the menu, or undefined without one. */
  readonly other: string | undefined
  readonly menu: () => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  return <div className={css.gitAction}>
    <Button size="sm" variant="primary" className={clsx(other !== undefined && css.gitMain)} disabled={disabled} onClick={run}>{label}</Button>
    {other !== undefined && <Menu open={open && !disabled} portal dense align="end" autoFocus onClose={() => { setOpen(false) }}
      anchor={<Button size="sm" variant="primary" className={clsx(css.gitArrow)} disabled={disabled} aria-haspopup="menu" aria-expanded={open && !disabled}
        aria-label={menuLabel} onClick={() => { setOpen(value => !value) }}><IconChevronDownOutlineRegular size={14} /></Button>}>
      <MenuItemButton onSelect={() => { setOpen(false); menu() }}>{other}</MenuItemButton>
    </Menu>}
  </div>
}

/**
 * Render the line range, plain-text editor, and explicitly named destinations.
 * @param props - frozen selection, actions, cancellation, and localized copy.
 * @returns the inline comment form.
 */
export function ReviewComposer({ selection, actions, close, visible = true, t }: PropsLocale<typeof NS> & {
  readonly visible?: boolean
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
  const range = reviewRange(selection.comment)
  /** Send the comment to the code host, closing the form once it is taken and keeping its text otherwise. */
  const send = async (destination: ((selection: ReviewSelection) => Promise<string | undefined>) | undefined): Promise<void> => {
    if (running.current || destination === undefined) return
    running.current = true
    setBusy(true)
    setError(null)
    try {
      const failure = await destination(comment())
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
    <section className={css.root} aria-label={t('review.range', { range })}
      data-forge-comment={`${selection.comment.side}${selection.comment.startLine}-${selection.comment.endLine}`}>
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
        {visible && actions.queue !== undefined && <SplitAction disabled={busy || actions.publishingBlocked === true || empty}
          label={t(busy ? 'review.publishing' : actions.reviewStarted === true ? 'review.queue' : 'review.startReview')}
          run={() => { void send(actions.queue) }} menuLabel={t('review.githubActions')}
          other={actions.publish === undefined ? undefined : t('review.publish')} menu={() => { void send(actions.publish) }} />}
        {actions.queue === undefined && actions.publish !== undefined && <Button size="sm" variant="primary"
          disabled={busy || actions.publishingBlocked === true || empty} onClick={() => { void send(actions.publish) }}>{t('review.publish')}</Button>}

      </div>
    </section>
  )
}
