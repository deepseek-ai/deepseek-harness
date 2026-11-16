/**
 * The details of one Session panel row, shown in the row's HoverCard. The
 * plugin offers it as the `conversation.session.panel.details` Component
 * Factory, so the rows of every section describe themselves alike.
 */
import type { ReactNode } from 'react'
import { IconClockOutlineRegular, IconDatabaseOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type { PanelDetailsFact } from './slots.ts'
import css from './PanelDetails.module.css'

const factIcons = {
  tokens: IconDatabaseOutlineRegular,
  duration: IconClockOutlineRegular,
} satisfies Record<PanelDetailsFact['kind'], typeof IconClockOutlineRegular>

/**
 * Render a row's details on the HoverCard's dark surface in both themes: the
 * title, secondary lines, the state after its dot, and the measures on one
 * line, each after the 14px icon of its kind. Absent or empty parts render
 * nothing.
 * @param props - title, lines, state, and measures.
 * @returns the card body.
 */
export function PanelDetails({
  title, lines = [], status, facts = [],
}: FactoryComponentPropsOf<'conversation.session.panel.details'>): ReactNode {
  return (
    <div className={css.details} data-session-panel-details="">
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
          {facts.map((fact) => {
            const Icon = factIcons[fact.kind]
            return (
              <span key={fact.kind} className={css.fact} data-fact={fact.kind}>
                <span className={css.factIcon} aria-hidden="true"><Icon /></span>
                {fact.label}
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
