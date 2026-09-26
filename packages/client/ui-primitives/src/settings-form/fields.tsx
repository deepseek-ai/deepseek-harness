/**
 * The controls of a settings form. Each renders one field's label, its staged
 * text, whether saving would leave an override, and — when one stands — the
 * reset that stages a clear back to the composition layer. Nothing here
 * writes: a control reports what the user typed, and the form's save is the
 * single point where a draft becomes a document mutation.
 */

import { useState, type ReactNode } from 'react'
import { IconInfoOutlineRegular } from '../icons/index.tsx'
import { Tag } from '../Tag.tsx'
import css from './fields.module.css'

/** What every settings field control needs regardless of its value type. */
export interface SettingsFieldProps {
  /** Stable id associating the label with its control. */
  id: string
  /** Visible label. */
  label: string
  /** One-line explanation rendered under the control. */
  hint: string
  /** Draft text this control renders. */
  text: string
  /** True when saving would leave a user-layer entry for this field. */
  overridden: boolean
  /** True when the draft is not a value this field accepts. */
  invalid: boolean
  /** Copy for the overridden badge. */
  overriddenLabel: string
  /** Copy for the reset control. */
  resetLabel: string
  /** Copy shown in place of the hint while the draft is invalid. */
  invalidLabel: string
  /** Disables every control (read-only document, or an unavailable namespace). */
  disabled: boolean
  /** Stage draft text. */
  onEdit: (text: string) => void
  /** Stage a clear so the field re-inherits the composition layer. */
  onReset: () => void
}

/**
 * A staged value field. `numeric` only hints the keypad: which drafts a field
 * accepts is decided by its spec, so the control never silently rewrites what
 * the user typed.
 * @param props - the field's copy, its staged text, and the edit actions.
 * @returns the labelled control.
 */
export function SettingsValueField(props: Omit<SettingsFieldProps, 'hint'> & {
  /** Optional explanation shown below the input. */
  hint?: string
  /** Rules disclosed by the information button beside the label. */
  help?: { label: string; content: ReactNode }
  /** Hints a numeric keypad without narrowing what the control accepts. */
  numeric?: boolean
  /** Placeholder shown while the draft is empty. */
  placeholder?: string
}) {
  const [helpOpen, setHelpOpen] = useState(false)
  const helpId = `${props.id}-help`
  const messageId = `${props.id}-message`
  const hasMessage = props.invalid || Boolean(props.hint)
  const description = [hasMessage ? messageId : '', helpOpen ? helpId : ''].filter(Boolean).join(' ')
  return (
    <div className={css.field}>
      <div className={css.head}>
        <div className={css.labelGroup}>
          <label className={css.label} htmlFor={props.id}>{props.label}</label>
          {props.help !== undefined
            ? (
              <button type="button" className={css.helpButton}
                aria-label={props.help.label} aria-expanded={helpOpen} aria-controls={helpId}
                onClick={() => { setHelpOpen(!helpOpen) }}>
                <IconInfoOutlineRegular size={12} />
              </button>
            )
            : null}
        </div>
        {props.overridden
          ? (
            <span className={css.badges}>
              <Tag tone="neutral">{props.overriddenLabel}</Tag>
              <button
                type="button"
                className={css.reset}
                disabled={props.disabled}
                onClick={props.onReset}
              >
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
      </div>
      <input
        id={props.id}
        className={css.input}
        type="text"
        {...props.numeric === true ? { inputMode: 'numeric' as const } : {}}
        {...props.invalid ? { 'aria-invalid': true } : {}}
        aria-describedby={description || undefined}
        value={props.text}
        placeholder={props.placeholder ?? ''}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
      {hasMessage
        ? <p id={messageId} className={props.invalid ? css.invalid : css.hint}>{props.invalid ? props.invalidLabel : props.hint}</p>
        : null}
      {props.help !== undefined && helpOpen
        ? <div id={helpId} className={css.help} role="region" aria-label={props.help.label}>{props.help.content}</div>
        : null}
    </div>
  )
}

/**
 * A write-only credential control. The value never rides a response, so the
 * control reports only whether one is configured and starts blank; a blank
 * draft writes nothing, which keeps the stored key rather than clearing it.
 * The control asks browsers not to autofill saved login passwords.
 * @param props - the field's copy, its staged text, and the configured state.
 * @returns the labelled control.
 */
export function SettingsSecretField(props: Pick<SettingsFieldProps, 'id' | 'label' | 'hint' | 'text' | 'disabled' | 'onEdit'> & {
  /** Whether the Host reports a configured credential for this reference. */
  configured: boolean
  /** Copy describing the configured state. */
  stateLabel: string
}) {
  return (
    <div className={css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        <span className={css.badges}>
          <Tag tone={props.configured ? 'neutral' : 'quiet'}>{props.stateLabel}</Tag>
        </span>
      </div>
      <input
        id={props.id}
        className={css.input}
        type="password"
        autoComplete="new-password"
        value={props.text}
        disabled={props.disabled}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
      <p className={css.hint}>{props.hint}</p>
    </div>
  )
}
