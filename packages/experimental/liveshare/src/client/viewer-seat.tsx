/**
 * One composer seat a viewer page states but does not choose.
 *
 * A viewer page renders the owner's Session, so the seats a DSH user picks from — the model the
 * Session runs on, the permission the share carries — are facts about that Session rather than
 * choices for the reader. This component is the one place that states such a fact, and the one
 * switch that decides whether the reader may change it: `readOnly` renders a label, and the
 * interactive form is the other branch of the same component rather than a second control kept in
 * step by hand.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/viewer-seat
 */

import type { ReactNode } from 'react'
import css from './viewer-seat.module.css'

/**
 * Rank at which the viewer's seats register into the composer's single slots.
 *
 * A single slot renders its lowest-ranked live entry and throws when a second registration repeats an
 * occupied rank, so a served page — which mounts the owner's own plugins — must register below their
 * default rank 0 rather than beside it. This is the shadow rank the shipped seats are replaced
 * through; it sits below the default rank every shipped registration of these seats uses.
 */
export const VIEWER_SEAT_PRIORITY = -10

/** Which fact one seat states; also the seat's own data attribute. */
export type ViewerSeatKind = 'model' | 'permission'

/** One read-only or selectable statement about the Session this page presents. */
export interface ViewerSeatProps {
  /** Fact this seat states. */
  readonly kind: ViewerSeatKind
  /** What this seat states, already localized. */
  readonly value: string
  /** Longer statement of the same fact, used as the seat's tooltip. */
  readonly title: string
  /**
   * Visible statement of the restriction, so a reader who never hovers still learns why the seat is
   * not theirs to change.
   */
  readonly note: string
  /**
   * Whether this seat is a label.
   *
   * Every viewer seat states `true` today: the share's grants let a viewer drive the Session, never
   * reconfigure it. A `false` value renders the same component as a control that calls
   * {@link ViewerSeatProps.select}, which is the wiring point for a future grant.
   */
  readonly readOnly: boolean
  /** What the selectable form does. Read only when {@link ViewerSeatProps.readOnly} is false. */
  readonly select?: () => void
}

/**
 * Render one statement about the shared Session.
 * @param props - the fact to state, its explanation, and whether it is selectable.
 * @returns The seat as a label, or as the control the same fact would be chosen with.
 */
export function ViewerSeat({ kind, value, title, note, readOnly, select }: ViewerSeatProps): ReactNode {
  const attribute = { 'data-liveshare-viewer-seat': kind }
  const body = (
    <>
      <span className={css.value}>{value}</span>
      <span className={css.note}>{note}</span>
    </>
  )
  if (readOnly) {
    return (
      <span className={css.seat} aria-disabled="true" title={title} {...attribute}>{body}</span>
    )
  }
  return (
    <button type="button" className={css.seat} title={title} onClick={select} {...attribute}>{body}</button>
  )
}
