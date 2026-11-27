/** API key field: an editable draft, or a saved key shown read-only until its replace action. */
import { useState } from 'react'
import type { InputHTMLAttributes, ReactNode } from 'react'
import { IconEditOutlineRegular, IconTrashOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

const EYE_CONTOUR = 'M1.5 8C2.9 5.25 5.25 3.5 8 3.5C10.75 3.5 13.1 5.25 14.5 8C13.1 10.75 10.75 12.5 8 12.5C5.25 12.5 2.9 10.75 1.5 8Z'
const EYE_PATH = `${EYE_CONTOUR}M10 8C10 9.1 9.1 10 8 10C6.9 10 6 9.1 6 8C6 6.9 6.9 6 8 6C9.1 6 10 6.9 10 8Z`
const EYE_OFF_PATH = `${EYE_CONTOUR}M2.5 2.5L13.5 13.5`
const MASK = '•'
/** Read-only text of a saved key whose credential provider reports no preview. */
const SAVED_KEY_MASK = MASK.repeat(8)

/** Input attributes and section copy for the current credential draft. */
interface ApiKeyInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>,
  'value' | 'type' | 'className' | 'autoComplete' | 'onBlur' | 'onKeyDown' | 'aria-invalid'> {
  /** Unsaved input; stored credentials are never read into this field. */
  readonly value: string
  /** The saved key this draft would replace; absent when none is saved or its removal is staged. */
  readonly saved?: {
    /** Provider-generated preview; the full stored credential stays on the Host. */
    readonly masked: string | undefined
    /** Stage removal of the saved key; absent when the credential store refuses writes. */
    readonly clear?: () => void
  }
  /** Whether the draft fails validation. A failing draft stays in the input when focus leaves. */
  readonly invalid?: boolean
  /** Section copy, including the same reveal labels as SecretText. */
  readonly t: (key: keyof typeof en) => string
}

/**
 * Show a saved key as read-only text with replace and clear actions. The replace
 * action opens the input; focus leaving the field or Enter returns a draft that
 * passes validation to read-only text. Without a saved key the input is always shown.
 * Only a nonempty draft can be revealed.
 * @param props - current draft, saved-key state, input attributes, and translated control labels.
 * @returns the read-only row, or a password input with an optional reveal button.
 */
export function ApiKeyInput({ value, saved, invalid = false, t, ...props }: ApiKeyInputProps): ReactNode {
  // `returned` is the read-only row reached with Enter: its replace button takes the focus the input held.
  const [mode, setMode] = useState<'readOnly' | 'editing' | 'returned'>('readOnly')
  const [revealedValue, setRevealedValue] = useState<string | undefined>()
  if (saved !== undefined && mode !== 'editing') {
    const { clear } = saved
    return (
      <div className={styles['keyDisplay']}>
        <span className={styles['keyDisplayValue']}>
          {value === '' ? saved.masked ?? SAVED_KEY_MASK : MASK.repeat(Array.from(value.trim()).length)}
        </span>
        <Tooltip label={t('keyReplace')} side="top" portal>
          <button
            type="button"
            className={styles['iconButton']}
            aria-label={t('keyReplace')}
            autoFocus={mode === 'returned'}
            disabled={props.disabled}
            onClick={() => { setMode('editing') }}
          >
            <IconEditOutlineRegular size={14} />
          </button>
        </Tooltip>
        {clear === undefined ? null : <Tooltip label={t('keyClear')} side="top" portal>
          <button
            type="button"
            className={`${styles['iconButton']} ${styles['iconButtonDanger']}`}
            aria-label={t('keyClear')}
            disabled={props.disabled}
            onClick={() => {
              // The input that replaces this row takes the focus this button held.
              setMode('editing')
              clear()
            }}
          >
            <IconTrashOutlineRegular size={14} />
          </button>
        </Tooltip>}
      </div>
    )
  }
  const canReveal = value.length > 0 && props.disabled !== true
  const revealed = canReveal && revealedValue === value
  const settles = saved !== undefined && !invalid
  // The draft is masked again the next time the input opens.
  const leave = (next: 'readOnly' | 'returned'): void => {
    setRevealedValue(undefined)
    setMode(next)
  }
  return (
    <div
      className={styles['keyInput']}
      onBlur={(event) => {
        // The reveal button belongs to the field. A deactivated window keeps the
        // input, so a key copied in another window can be pasted on return.
        if (!settles || event.currentTarget.contains(event.relatedTarget) || !document.hasFocus()) return
        leave('readOnly')
      }}
    >
      <input
        {...props}
        className={`${styles['input']} ${canReveal ? styles['keyInputFilled'] : ''}`}
        type={revealed ? 'text' : 'password'}
        autoComplete="new-password"
        value={value}
        placeholder={saved === undefined ? props.placeholder : t('keyReplacementPlaceholder')}
        aria-invalid={invalid}
        autoFocus={mode === 'editing' || props.autoFocus === true}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.nativeEvent.isComposing || !settles) return
          // The key's own activation would otherwise reach the replace button that takes focus.
          event.preventDefault()
          leave('returned')
        }}
        onChange={(event) => {
          setRevealedValue(undefined)
          props.onChange?.(event)
        }}
      />
      {!canReveal ? null : <button
        type="button"
        className={styles['keyToggle']}
        aria-label={t(revealed ? 'keyHide' : 'keyReveal')}
        aria-pressed={revealed}
        // Safari gives a clicked button no focus, so the input would report focus leaving the field.
        onMouseDown={(event) => { event.preventDefault() }}
        onClick={() => { setRevealedValue(revealed ? undefined : value) }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" aria-hidden="true">
          <path d={revealed ? EYE_OFF_PATH : EYE_PATH} />
        </svg>
      </button>}
    </div>
  )
}
