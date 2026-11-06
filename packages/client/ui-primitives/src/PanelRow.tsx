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
  /**
   * Row actions after the trailing area, such as a More button. They show
   * while the pointer is over the row, focus is inside it, or one of them has
   * its menu open, and always on devices without hover.
   */
  readonly menu?: ReactNode
  /** Make the whole row one button with this action; the trailing area and the menu stay separate controls above it. */
  readonly onActivate?: (() => void) | undefined
}

/**
 * Render one summary-panel row: icon, single-line content, an optional
 * trailing area, and optional row actions. A row with an action or row
 * actions highlights as a whole on hover and while one of its menus is open.
 * @param props - row content, the optional action and row actions, and attributes for the outer element.
 * @returns the row element.
 */
export function PanelRow({ icon, children, trailing, menu, onActivate, className, ...attributes }: PanelRowProps) {
  const body = (
    <>
      <span className={css.icon} aria-hidden="true">{icon}</span>
      <span className={css.content}>{children}</span>
    </>
  )
  const interactive = onActivate !== undefined || menu !== undefined
  return (
    <div {...attributes} className={clsx(css.row, interactive && css.interactive, className)} data-panel-row="">
      {onActivate === undefined
        ? <span className={css.body}>{body}</span>
        : <button type="button" className={clsx(css.body, css.action)} onClick={onActivate}>{body}</button>}
      {trailing !== undefined && <span className={css.trailing}>{trailing}</span>}
      {menu !== undefined && <span className={css.menu}>{menu}</span>}
    </div>
  )
}
