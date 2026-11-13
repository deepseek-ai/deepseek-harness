/**
 * The Session panel's `conversation.session.panel.row` Factory as these
 * suites render it: the row's parts in the row's order, its attributes on the
 * row element, and its action as a button. ui-session-panel's own suite owns
 * the row's geometry and interaction states.
 */
import type { ReactNode } from 'react'
import { vi } from 'vitest'
import type { PanelRowProps } from '@deepseek-ai/dsh-client-ui-session-panel/client'

/**
 * Render one row the way the Factory lays it out.
 * @param props - the row's Factory input.
 * @returns the row element.
 */
function PanelRowDouble({
  icon, children, trailing, menu, onActivate, actionLabel, detail, className, attributes,
}: PanelRowProps): ReactNode {
  const body = (
    <>
      <span aria-hidden="true">{icon}</span>
      <span>{children}</span>
      {detail !== undefined && <span>{detail}</span>}
    </>
  )
  return (
    <div {...attributes} className={className} data-panel-row="">
      {onActivate === undefined ? <span>{body}</span> : <button type="button" aria-label={actionLabel} onClick={onActivate}>{body}</button>}
      {trailing}
      {menu}
    </div>
  )
}

/**
 * A recording `renderFactorySlot` that renders panel rows and hands every other Factory to `other`.
 * @param other - renders the other Factories the component under test uses.
 * @returns the mock.
 */
export function renderPanelRows(other: (name: string, input: never) => ReactNode = () => null) {
  return vi.fn((name: string, input: object): ReactNode => name === 'conversation.session.panel.row'
    ? <PanelRowDouble {...input as PanelRowProps} />
    : other(name, input as never))
}
