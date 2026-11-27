/** Shared ellipsis control for explicit context-menu targets. */
import { Button, IconEllipsisOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots/client'
import { useId } from 'react'
import type { MouseEvent, PointerEvent } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ContextMenus, ContextMenuTarget, MenuPoint } from './types.ts'
import css from './Button.module.css'

/** Menu facts and the per-button toggle, bound by the factory registration. */
export interface ContextMenuButtonInjected {
  hooks: {
    /** Instance id of the element that opened the current popup; null when opened without one and after dismissal. */
    opener: ObservableSnapshot<string | null>
    registeredKinds: ContextMenus['registeredKinds']
  }
  /**
   * Close the popup this button opened, or open a new one for its target.
   * @param button - instance id of the activated button.
   * @param target - captured object.
   * @param point - viewport anchor below the button.
   */
  toggle: (button: string, target: ContextMenuTarget, point: MenuPoint) => void
}

/**
 * Render the menu trigger while its target kind has a registered contribution.
 * @param props - Localized owner data and framework-bound menu facts.
 * @returns An available target's menu trigger.
 */
export function ContextMenuButton({ target, label, size, opener, useOpener, useRegisteredKinds, toggle }: FactoryComponentPropsOf<'contextMenu.button'>) {
  const ownId = useId()
  const id = opener ?? ownId
  const expanded = useOpener(opener => opener === id)
  const available = useRegisteredKinds(kinds => kinds.includes(target.kind))
  if (!available) return null
  const attributes = {
    'data-context-menu-trigger': '',
    'aria-label': label,
    'aria-haspopup': 'menu' as const,
    'aria-expanded': expanded,
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => { event.stopPropagation() },
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      event.currentTarget.focus({ preventScroll: true })
      const rect = event.currentTarget.getBoundingClientRect()
      toggle(id, target, { x: rect.left, y: rect.bottom })
    },
  }
  if (size !== 'sm') {
    return <button {...attributes} className={size === 'row' ? css.row : undefined} type="button"><IconEllipsisOutlineRegular /></button>
  }
  return <Tooltip label={label} side="bottom" align="end" portal>
    <Button {...attributes} size="sm" className={css.toolbar} icon={<IconEllipsisOutlineRegular />} />
  </Tooltip>
}
