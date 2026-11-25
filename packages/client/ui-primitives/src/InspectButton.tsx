import clsx from 'clsx'
import { IconInspectOutlineRegular } from './icons/index.tsx'
import css from './InspectButton.module.css'

/** Props of {@link InspectButton}. */
export interface InspectButtonProps {
  /** Localized action label. */
  label: string
  /** Open the owning row's inspector record. */
  onClick: () => void
  /** Placement class from the owning row. */
  className?: string | undefined
}

/**
 * Render the in-flow pill that opens a process row's inspector record. It
 * stays hidden until a `[data-inspect-scope]` ancestor is hovered or
 * the button has keyboard focus; touch-only devices always show it.
 * @param props - Label, action and placement class.
 * @returns the inspect button.
 */
export function InspectButton({ label, onClick, className }: InspectButtonProps) {
  return (
    <button type="button" className={clsx(css.button, className)} onClick={onClick}>
      <IconInspectOutlineRegular />
      {label}
    </button>
  )
}
