/**
 * One icon-led fact row of the Session panel. The plugin offers it as the
 * `conversation.session.panel.row` Component Factory, so rows that other
 * packages contribute keep one geometry.
 */

import type { HTMLAttributes, ReactNode } from 'react'
import clsx from 'clsx'
import css from './PanelRow.module.css'

/** Attributes of the row element, such as `role`, `data-*` markers, and a context-menu trigger's handlers. */
export type PanelRowAttributes =
  Omit<HTMLAttributes<HTMLElement>, 'children' | 'className' | 'onClick'>
  & { readonly [marker: `data-${string}`]: string | undefined }

/** Props of one Session panel row. */
export interface PanelRowProps {
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
  /**
   * Accessible name of the `onActivate` button when its visible content does not describe the action; it starts with
   * the visible text, so speech input that names what the row shows reaches the button.
   */
  readonly actionLabel?: string | undefined
  /**
   * Second line under the content, in smaller tertiary type that clips with an ellipsis, such as the consequence of a
   * status or a command to run; the row grows to two lines with the icon beside the first, and the trailing area and
   * the menu centered on the row.
   */
  readonly detail?: ReactNode
  /** Class of the row element, added to the row's own. */
  readonly className?: string | undefined
  /** Attributes of the row element; the row keeps its own class and `data-panel-row`. */
  readonly attributes?: PanelRowAttributes | undefined
}

/**
 * Render one Session panel row: icon, single-line content, an optional
 * trailing area, and optional row actions. A row with an action or row
 * actions highlights as a whole on hover and while one of its menus is open.
 * Props outside {@link PanelRowProps}, such as the ones a Factory occurrence
 * adds, are ignored.
 * @param props - row content, the optional action and row actions, and attributes for the row element.
 * @returns the row element.
 */
export function PanelRow({
  icon, children, trailing, menu, onActivate, actionLabel, detail, className, attributes,
}: PanelRowProps): ReactNode {
  const body = (
    <>
      <span className={css.icon} aria-hidden="true">{icon}</span>
      {detail === undefined
        ? <span className={css.content}>{children}</span>
        : (
          <span className={css.lines}>
            <span className={css.content}>{children}</span>
            <span className={css.detail}>{detail}</span>
          </span>
        )}
    </>
  )
  const interactive = onActivate !== undefined || menu !== undefined
  return (
    <div {...attributes} className={clsx(css.row, interactive && css.interactive, detail !== undefined && css.tall, className)} data-panel-row="">
      {onActivate === undefined
        ? <span className={css.body}>{body}</span>
        : <button type="button" className={clsx(css.body, css.action)} aria-label={actionLabel} onClick={onActivate}>{body}</button>}
      {trailing !== undefined && <span className={css.trailing}>{trailing}</span>}
      {menu !== undefined && <span className={css.menu}>{menu}</span>}
    </div>
  )
}
