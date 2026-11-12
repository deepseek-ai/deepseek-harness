/** Body of a HoverCard that details one row of a summary panel. */

import type { ReactNode } from 'react'
import { StateDot, type StateDotState } from './StateDot.tsx'
import css from './HoverDetails.module.css'

/** What a row's hover card says about it. */
export interface HoverDetailsProps {
  /**
   * The full name of what the row shows; it wraps instead of clipping. Omit it
   * when the name can run long, such as a command, and the row's own view
   * shows it in full.
   */
  readonly title?: ReactNode
  /** Lines in secondary type under the title, such as the owner; each stops after six lines. */
  readonly lines?: readonly ReactNode[]
  /** The state, after its dot. */
  readonly status?: { readonly state: StateDotState; readonly label: string } | undefined
  /** Measures on one line, each after its 14px icon, such as tokens and duration. */
  readonly facts?: readonly { readonly icon: ReactNode; readonly label: string }[]
}

/**
 * Render the details of one summary-panel row for its HoverCard, on the card's
 * dark surface in both themes: the title, secondary lines, the state, and the
 * measures. Absent or empty parts render nothing.
 * @param props - title, lines, state, and measures.
 * @returns the card body.
 */
export function HoverDetails({ title, lines = [], status, facts = [] }: HoverDetailsProps): ReactNode {
  return (
    <div className={css.details} data-hover-details="">
      {title !== undefined && <div className={css.title}>{title}</div>}
      {lines.map((line, index) => <div key={index} className={css.line}>{line}</div>)}
      {status !== undefined && (
        <div className={css.status}>
          <StateDot state={status.state} />
          <span>{status.label}</span>
        </div>
      )}
      {facts.length > 0 && (
        <div className={css.facts}>
          {facts.map(fact => (
            <span key={fact.label} className={css.fact}>
              <span className={css.factIcon} aria-hidden="true">{fact.icon}</span>
              {fact.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
