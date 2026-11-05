// PanelRow: one icon-led fact row of a summary panel, shared by every
// contributor so rows from different packages keep one geometry.

import type { HTMLAttributes, ReactNode } from 'react'
import clsx from 'clsx'
import css from './PanelRow.module.css'

/** Props of one summary-panel row. */
export interface PanelRowProps extends Omit<HTMLAttributes<HTMLElement>, 'children' | 'onClick'> {
  /** Leading 16px glyph; decorative, so the row text carries the meaning. */
  readonly icon: ReactNode
  /** Primary single-line content; overflow clips with an ellipsis. */
  readonly children: ReactNode
  /** Optional trailing value or control, laid out after the content without shrinking. */
  readonly trailing?: ReactNode
  /** Make the icon and content one button with this action; the trailing area stays outside it. */
  readonly onActivate?: (() => void) | undefined
  /** Accessible name of the `onActivate` button when its visible content does not describe the action. */
  readonly actionLabel?: string | undefined
}

/**
 * Render one summary-panel row: icon, single-line content, and an optional trailing area.
 * @param props - row content, the optional action, and attributes for the outer element.
 * @returns the row element.
 */
export function PanelRow({ icon, children, trailing, onActivate, actionLabel, className, ...attributes }: PanelRowProps) {
  const body = (
    <>
      <span className={css.icon} aria-hidden="true">{icon}</span>
      <span className={css.content}>{children}</span>
    </>
  )
  return (
    <div {...attributes} className={clsx(css.row, className)} data-panel-row="">
      {onActivate === undefined
        ? <span className={css.body}>{body}</span>
        : <button type="button" className={clsx(css.body, css.action)} aria-label={actionLabel} onClick={onActivate}>{body}</button>}
      {trailing !== undefined && <span className={css.trailing}>{trailing}</span>}
    </div>
  )
}
