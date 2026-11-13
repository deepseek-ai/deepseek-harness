/** Session header entry that shows or hides the Session panel. */
import type { ReactNode } from 'react'
import { Button, IconFlatListOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { panelElementId, toggleElementId } from './element-ids.ts'
import type { SessionPanelToggleProps } from './slots.ts'
import { presentationOf } from './visibility.ts'
import css from './SessionPanelToggle.module.css'

/**
 * Render the toggle. Its accessible name is the panel name followed by the
 * text of any indicator; the expanded state says whether the panel shows.
 * While no Chat View shows the Session, as in the trajectory View, the panel
 * has no place to show: the toggle is unavailable and its tooltip says so.
 * @param props - Session values, the room to dock, shared visibility, the toggle action, and copy.
 * @returns the header entry.
 */
export function SessionPanelToggle({
  sessionId, useDockable, useVisibility, toggle, renderSlot, t,
}: SessionPanelToggleProps): ReactNode {
  const dockable = useDockable(entries => entries.get(sessionId))
  const shown = useVisibility(visibility => presentationOf(dockable === true, visibility, sessionId) !== 'hidden')
  const available = dockable !== undefined
  const open = available && shown
  const label = available ? t(open ? 'toggle.hide' : 'toggle.show') : t('toggle.unavailable')
  return (
    <Tooltip label={label} side="bottom" delayMs={500}>
      <Button
        size="sm"
        id={toggleElementId(sessionId)}
        className={css.trigger}
        aria-expanded={open}
        aria-controls={open ? panelElementId(sessionId) : undefined}
        aria-disabled={available ? undefined : true}
        data-session-panel-toggle=""
        onClick={() => { toggle(sessionId) }}
      >
        <IconFlatListOutlineRegular size={16} />
        <span className={css.name}>{t('panel.name')}</span>
        {/* Separates the name from indicator text in the accessible name. */}
        {' '}
        {renderSlot('conversation.session.panel.indicator', { panelShown: open })}
      </Button>
    </Tooltip>
  )
}
