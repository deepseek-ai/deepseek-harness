/**
 * The action row every provider card ends with: dismiss on the left, commit on
 * the right.
 *
 * The two cards commit different things — one creates a route, one edits an
 * existing profile — but the row itself carries no such knowledge. It renders
 * what it is handed, so the cards keep sole ownership of when a commit is
 * allowed and what the in-flight wording is.
 *
 * Cancel refuses input only while a commit is in flight, never because the card
 * is disabled: a card the deployment cannot write to must still be dismissable.
 *
 * The card's notes — what blocks the commit, or what the last one was refused
 * for — render inside the row, before the actions. A sticky row stays at the
 * scroll edge of the page while its card is taller than the page, so the notes
 * and the actions are read together wherever the card is scrolled to.
 *
 * @module dsh-client-ui-settings-models/client/EditorFooter
 */

import type { ReactNode } from 'react'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** Props of {@link EditorFooter}. */
export interface EditorFooterProps {
  /** Localizer for the row's own labels. */
  t: (key: keyof typeof en) => string
  /** Whether a commit is in flight; holds Cancel and swaps the commit label. */
  busy: boolean
  /** Whether the commit is refused, as judged by the owning card. */
  submitDisabled: boolean
  /** Commit label while idle. */
  submitLabelKey: keyof typeof en
  /** Commit label while a commit is in flight. */
  submitBusyLabelKey: keyof typeof en
  /** Dismiss label; defaults to the settings editor copy. */
  cancelLabelKey?: keyof typeof en
  /** Dismiss the card without committing. */
  onCancel: () => void
  /** Run the card's commit. */
  onSubmit: () => void
  /** Keep the row at the scroll edge of the page while the card is taller than the page. */
  sticky?: boolean
  /** Notes shown before the actions: what blocks the commit or refused the last one. */
  children?: ReactNode
}

/**
 * Render the notes and the action row.
 * @param props - labels, commit state, the two actions, and the card's notes as children.
 * @returns the footer.
 */
export function EditorFooter(props: EditorFooterProps): ReactNode {
  const { t } = props
  return (
    <div className={`${styles['editorFooter']} ${props.sticky === true ? styles['editorFooterSticky'] : ''}`}>
      <div className={styles['editorNotes']}>{props.children}</div>
      <div className={styles['editorActions']}>
        <button
          type="button"
          className={styles['secondaryButton']}
          disabled={props.busy}
          onClick={props.onCancel}
        >
          {t(props.cancelLabelKey ?? 'cancel')}
        </button>
        <button
          type="button"
          className={styles['primaryButton']}
          disabled={props.submitDisabled}
          onClick={props.onSubmit}
        >
          {props.busy ? t(props.submitBusyLabelKey) : t(props.submitLabelKey)}
        </button>
      </div>
    </div>
  )
}
