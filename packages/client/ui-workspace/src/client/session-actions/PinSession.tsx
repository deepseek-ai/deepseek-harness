/** Session pin hover button over the workspace owner’s shared callbacks. */
import {
  IconPinFillRegular, IconPinOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import clsx from 'clsx'
import type { PinSessionInjected, SessionRowActionProps } from '../contract/slots.ts'
import css from '../rows/Rows.module.css'

type PinState = Pick<SessionRowActionProps<PinSessionInjected>, 'sessionId' | 'usePinned' | 'useArchived' | 'useSessionAccess'>

/** The row's pin and archive membership, one Set lookup each, and whether its access allows the toggle. */
function usePinState({ sessionId, usePinned, useArchived, useSessionAccess }: PinState) {
  const pinned = usePinned(set => set.has(sessionId))
  return {
    pinned,
    archived: useArchived(archived => archived.has(sessionId)),
    allowed: useSessionAccess(sessionId, pinned ? 'workspace/unpinSession' : 'workspace/pinSession'),
  }
}

/**
 * Hover button (order 200), also visible without hover when pinned; absent on
 * archived rows and while the Session's access snapshot excludes that toggle.
 * Tooltip forwards the class to the button. Keep that button directly inside
 * the display-contents slot anchor so hoverless rows can retain the Unpin action.
 * @param props - owner share, the access Hook, and the pin share.
 * @returns the button, or null for an archived or refused Session.
 */
export function PinSessionRowButton(props: SessionRowActionProps<PinSessionInjected>) {
  const { sessionId, pinSession, unpinSession, t } = props
  const { pinned, archived, allowed } = usePinState(props)
  if (archived || !allowed) return null
  return (
    <Tooltip label={t(pinned ? 'actions.unpin' : 'actions.pin')} side="bottom" align="end" delayMs={500} portal>
      <button
        type="button"
        className={clsx(css.iconButton, pinned && css.pinnedAction)}
        aria-label={t(pinned ? 'menu.unpinSession' : 'menu.pinSession')}
        onClick={() => { (pinned ? unpinSession : pinSession)(sessionId) }}
      >
        {pinned ? <IconPinFillRegular size={14} /> : <IconPinOutlineRegular size={14} />}
      </button>
    </Tooltip>
  )
}
