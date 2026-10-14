/** Copy the row's Session ID without opening its history. */
import { IconCopyOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionIdInjected, SessionMenuItemProps } from '../contract/slots.ts'

/**
 * Copy the complete ID after dismissing the row menu.
 * @param props - Row identity, menu dismissal, clipboard action, and locale.
 * @returns The final built-in menu item.
 */
export function SessionIdMenuItem({ sessionId, useMenuOpenState, copySessionId, t }: SessionMenuItemProps<SessionIdInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton icon={<IconCopyOutlineRegular />} onSelect={() => {
      setMenuOpen(false)
      void copySessionId(sessionId)
    }}>
      {t('menu.sessionId')}
    </MenuItemButton>
  )
}
