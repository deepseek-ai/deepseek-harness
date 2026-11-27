/** Controlled configuration input shared by generated and custom forms. */
import { useId } from 'react'
import css from './ConfigField.module.css'

/** Field state and localized controls supplied by the owning form. */
export interface ConfigFieldProps {
  /** Display label from the owning plugin. */
  label: string
  /** Editable text; containers may use JSON. */
  value: string
  /** Hide the input text and disable browser password autofill. */
  secret: boolean
  /** Finite choices; an empty list uses a text control. */
  choices: readonly string[]
  /** Whether the field is currently read-only. */
  disabled: boolean
  /** Whether the field has a user override. */
  overridden: boolean
  /** Whether the draft fails validation. */
  invalid: boolean
  /** Localized reset, inherited-value choice, and validation text. */
  labels: { reset: string; inherited: string; invalid: string }
  /** Stage a new text value. */
  onChange: (value: string) => void
  /** Stage removal of the user override. */
  onReset: () => void
}

/** Render a field without owning its schema, draft, or persistence.
 * @param props Controlled field state and actions.
 * @returns A labelled input with reset and validation feedback.
 */
export function ConfigField(props: ConfigFieldProps) {
  const id = useId()
  return <div className={css.field}>
    <div className={css.head}>
      <label htmlFor={id}>{props.label}</label>
      {props.overridden ? <button type="button" disabled={props.disabled} onClick={props.onReset}>{props.labels.reset}</button> : null}
    </div>
    {props.choices.length > 0
      ? <select id={id} value={props.value} disabled={props.disabled} aria-invalid={props.invalid}
        onChange={(event) => { if (event.target.value === '') props.onReset(); else props.onChange(event.target.value) }}>
        <option value="">{props.labels.inherited}</option>
        {props.choices.map(choice => <option key={choice} value={choice}>{choice}</option>)}
      </select>
      : props.secret
        ? <input id={id} type="password" autoComplete="new-password" value={props.value} disabled={props.disabled}
          aria-invalid={props.invalid} onChange={(event) => { props.onChange(event.target.value) }} />
        : <textarea id={id} value={props.value} disabled={props.disabled} aria-invalid={props.invalid}
          rows={Math.min(8, Math.max(1, props.value.split('\n').length))} onChange={(event) => { props.onChange(event.target.value) }} />}
    {props.invalid ? <p role="status">{props.labels.invalid}</p> : null}
  </div>
}
