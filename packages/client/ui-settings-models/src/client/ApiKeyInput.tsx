/** Write-only credential input with the same reveal behavior as masked conversation text. */
import { useState } from 'react'
import type { InputHTMLAttributes, ReactNode } from 'react'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

const EYE_CONTOUR = 'M1.5 8C2.9 5.25 5.25 3.5 8 3.5C10.75 3.5 13.1 5.25 14.5 8C13.1 10.75 10.75 12.5 8 12.5C5.25 12.5 2.9 10.75 1.5 8Z'
const EYE_PATH = `${EYE_CONTOUR}M10 8C10 9.1 9.1 10 8 10C6.9 10 6 9.1 6 8C6 6.9 6.9 6 8 6C9.1 6 10 6.9 10 8Z`
const EYE_OFF_PATH = `${EYE_CONTOUR}M2.5 2.5L13.5 13.5`

/** Input attributes and section copy for the current credential draft. */
interface ApiKeyInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'type' | 'className' | 'autoComplete'> {
  /** Unsaved input; stored credentials are never read into this field. */
  readonly value: string
  /** Section copy, including the same reveal labels as SecretText. */
  readonly t: (key: keyof typeof en) => string
}

/**
 * Reveal only a nonempty draft; a different value starts masked, as in SecretText.
 * @param props - current draft, input attributes, and translated control labels.
 * @returns a password input with an optional reveal button.
 */
export function ApiKeyInput({ value, t, ...props }: ApiKeyInputProps): ReactNode {
  const [revealedValue, setRevealedValue] = useState<string | undefined>()
  const revealed = value.length > 0 && revealedValue === value
  return (
    <div className={styles['keyInput']}>
      <input
        {...props}
        className={`${styles['input']} ${value.length > 0 ? styles['keyInputFilled'] : ''}`}
        type={revealed ? 'text' : 'password'}
        autoComplete="new-password"
        value={value}
        onChange={(event) => {
          setRevealedValue(undefined)
          props.onChange?.(event)
        }}
      />
      {value.length === 0 ? null : <button
        type="button"
        className={styles['keyToggle']}
        aria-label={t(revealed ? 'keyHide' : 'keyReveal')}
        aria-pressed={revealed}
        disabled={props.disabled}
        onClick={() => { setRevealedValue(revealed ? undefined : value) }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" aria-hidden="true">
          <path d={revealed ? EYE_OFF_PATH : EYE_PATH} />
        </svg>
      </button>}
    </div>
  )
}
