/**
 * One plugin's settings form as its page on the Plugins page shows it: the
 * read-only notice when the deployment stores settings read-only, the
 * plugin's controls, and the save that writes every staged edit. The page
 * draws the plugin's title and one-liner itself.
 *
 * Only a save writes. Leaving the page drops every staged edit, so the form
 * discards on unmount and offers no discard control. A form whose namespace
 * the Host stopped serving says so in place of its controls rather than
 * showing fields nothing would accept.
 */

import { useEffect, useRef, type ReactNode } from 'react'
import type { SettingsFormShell } from './form-model.ts'
import css from './SettingsForm.module.css'

/** The copy the form frame renders, from the owning plugin's dictionary. */
export interface SettingsFormLabels {
  /** Shown in place of the controls while the namespace is not served. */
  unavailable: string
  /** Shown over the controls while the document is read-only. */
  readOnly: string
  /** Shown beside the save after a save the Host did not accept. */
  saveFailed: string
  /** The save control. */
  save: string
  /** The save control while a save is crossing the wire. */
  saving: string
}

/** Form chrome shared by every settings page. */
export interface SettingsFormProps {
  /** The frame's copy. */
  labels: SettingsFormLabels
  /** The form state: availability, writability, and what a save would do. */
  state: SettingsFormShell
  /** Write every staged edit. */
  onSave: () => void
  /** Drop every staged edit; the form calls it when it leaves the page. */
  onDiscard: () => void
  /** The plugin's controls. */
  children: ReactNode
}

/**
 * Render one plugin's settings form.
 * @param props - the form's copy and state, its controls, and the save and discard actions.
 * @returns the form, or the unavailable line while the namespace is not served.
 */
export function SettingsForm(props: SettingsFormProps) {
  const { state, labels } = props
  const discard = useRef(props.onDiscard)
  discard.current = props.onDiscard
  useEffect(() => () => { discard.current() }, [])
  if (!state.available) return <p className={css.unavailable} role="status">{labels.unavailable}</p>
  const blocked = !state.dirty || state.invalid || state.saving
  return (
    <div className={css.form}>
      {!state.writable ? <p className={css.readOnly} role="status">{labels.readOnly}</p> : null}
      {props.children}
      <div className={css.footer}>
        {state.failed ? <p className={css.failed} role="status">{labels.saveFailed}</p> : null}
        <button
          type="button"
          className={css.save}
          disabled={blocked}
          onClick={props.onSave}
        >
          {state.saving ? labels.saving : labels.save}
        </button>
      </div>
    </div>
  )
}
