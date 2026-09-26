/**
 * The pin action: a `sidebar.workspaces.session.menu.item` row and a
 * `sidebar.workspaces.session.row.action` button over one injected behavior.
 * Pin and archive are mutually exclusive on the Host, so the action reads both
 * sets and does not offer itself on an archived row; what a pin does beyond
 * the Host call (fronting the Session in its saved orders, the failure
 * notice) lives in the injected callbacks, not here.
 */
import {
  IconPinFillRegular, IconPinOutlineRegular, MenuItemButton, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PinSessionInjected, SessionMenuItemProps, SessionRowActionProps } from '../contract/slots.ts'
import css from '../rows/Rows.module.css'

type PinState = Pick<SessionMenuItemProps<PinSessionInjected>, 'sessionId' | 'usePinned' | 'useArchived'>

/** The row's pin and archive membership, one Set lookup each. */
function usePinState({ sessionId, usePinned, useArchived }: PinState) {
  return {
    pinned: usePinned(pinned => pinned.has(sessionId)),
    archived: useArchived(archived => archived.has(sessionId)),
  }
}

/**
 * Menu row (order 100): pin or unpin by the row's current state; absent on archived rows.
 * @param props - owner share, the pin share, and the menu open state.
 * @returns the row, or null for an archived Session.
 */
export function PinSessionMenuItem(props: SessionMenuItemProps<PinSessionInjected>) {
  const { sessionId, useMenuOpenState, pinSession, unpinSession, t } = props
  const [, setMenuOpen] = useMenuOpenState()
  const { pinned, archived } = usePinState(props)
  if (archived) return null
  return (
    <MenuItemButton
      icon={pinned ? <IconPinFillRegular /> : <IconPinOutlineRegular />}
      onSelect={() => {
        setMenuOpen(false)
        ;(pinned ? unpinSession : pinSession)(sessionId)
      }}
    >
      {t(pinned ? 'menu.unpinSession' : 'menu.pinSession')}
    </MenuItemButton>
  )
}

/**
 * Hover button (order 200, rightmost: it lands where the rest-state pin marker sits); absent on archived rows.
 * @param props - owner share and the pin share.
 * @returns the button, or null for an archived Session.
 */
export function PinSessionRowButton(props: SessionRowActionProps<PinSessionInjected>) {
  const { sessionId, pinSession, unpinSession, t } = props
  const { pinned, archived } = usePinState(props)
  if (archived) return null
  return (
    <Tooltip label={t(pinned ? 'actions.unpin' : 'actions.pin')} side="bottom" align="end" delayMs={500}>
      <button
        type="button"
        className={css.iconButton}
        aria-label={t(pinned ? 'menu.unpinSession' : 'menu.pinSession')}
        onClick={() => { (pinned ? unpinSession : pinSession)(sessionId) }}
      >
        {pinned ? <IconPinFillRegular size={14} /> : <IconPinOutlineRegular size={14} />}
      </button>
    </Tooltip>
  )
}
