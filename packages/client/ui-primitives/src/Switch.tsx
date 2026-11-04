// Switch: two-state toggle. `label` is required and has no default, so a render
// site cannot ship the control without an accessible name.

import clsx from 'clsx'
import css from './Switch.module.css'

/**
 * Render a toggle switch.
 * @param props.checked - the current state; the control is fully controlled.
 * @param props.onChange - called with the state the click asks for.
 * @param props.label - localized accessible name, owned by the render site.
 * @param props.disabled - whether the control is unavailable and excluded from keyboard focus.
 * @param props.pending - a write is in flight; refuse further changes while preserving focus.
 * @param props.title - localized hover text, typically why the toggle is locked.
 * @param props.className - extra class for layout placement.
 * @returns the switch element.
 */
export function Switch({ checked, onChange, label, disabled = false, pending = false, title, className }: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
  pending?: boolean
  title?: string | undefined
  // `| undefined` so a caller can forward an optional class straight through
  // under exactOptionalPropertyTypes (a CSS-module lookup is string|undefined).
  className?: string | undefined
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      aria-disabled={disabled || pending || undefined}
      aria-busy={pending || undefined}
      className={clsx(css.switch, className)}
      onClick={() => { if (!pending) onChange(!checked) }}
    >
      <span className={css.thumb} />
    </button>
  )
}
