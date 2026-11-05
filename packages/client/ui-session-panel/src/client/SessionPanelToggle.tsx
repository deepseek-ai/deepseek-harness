/** Session header entry that shows or hides the Session panel. */
import type { ReactNode } from 'react'
import { Button, IconFlatListOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { panelElementId, toggleElementId } from './element-ids.ts'
import type { SessionPanelToggleProps } from './slots.ts'
import { fitsLayout, presentationOf } from './visibility.ts'
import css from './SessionPanelToggle.module.css'

/**
 * Render the toggle. Its accessible name is the panel name followed by the
 * text of any indicator; the expanded state says whether the panel shows.
 * @param props - Session values, the main body layout, shared visibility, the toggle action, and copy.
 * @returns the header entry.
 */
export function SessionPanelToggle({
  sessionId, useLayout, useVisibility, toggle, renderSlot, t,
}: SessionPanelToggleProps): ReactNode {
  const fits = useLayout(fitsLayout)
  const open = useVisibility(visibility => presentationOf(fits, visibility, sessionId) !== 'hidden')
  return (
    <Tooltip label={t(open ? 'toggle.hide' : 'toggle.show')} side="bottom">
      <Button
        size="sm"
        id={toggleElementId(sessionId)}
        className={css.trigger}
        aria-expanded={open}
        aria-controls={open ? panelElementId(sessionId) : undefined}
        data-session-panel-toggle=""
        onClick={() => { toggle(sessionId, fits) }}
      >
        <IconFlatListOutlineRegular size={16} />
        <span className={css.name}>{t('panel.name')}</span>
        {/* Separates the name from indicator text in the accessible name. */}
        {' '}
        {renderSlot('conversation.session.panel.indicator', {})}
      </Button>
    </Tooltip>
  )
}
