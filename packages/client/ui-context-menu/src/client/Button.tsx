/** Shared ellipsis control for explicit context-menu targets. */
import { Button, IconEllipsisOutlineRegular, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type { MouseEvent, PointerEvent } from 'react'
import type { ContextMenus, ContextMenuTarget, MenuPoint } from './types.ts'
import { buttonTargetKey } from './target-key.ts'

/** Menu facts and the identity-based button action, bound by the factory registration. */
export interface ContextMenuButtonInjected {
  hooks: { active: ContextMenus['active']; registeredKinds: ContextMenus['registeredKinds'] }
  toggle: (target: ContextMenuTarget, point: MenuPoint) => void
}

/**
 * Render the menu trigger while its target kind has a registered contribution.
 * @param props - Localized owner data and framework-bound menu facts.
 * @returns An available target's menu trigger.
 */
export function ContextMenuButton({ target, label, className, size, useActive, useRegisteredKinds, toggle }: FactoryComponentPropsOf<'contextMenu.button'>) {
  const expanded = useActive(active => active !== null && buttonTargetKey(active) === buttonTargetKey(target))
  const available = useRegisteredKinds(kinds => kinds.includes(target.kind))
  if (!available) return null
  const attributes = {
    className,
    'data-context-menu-trigger': '',
    'aria-label': label,
    'aria-haspopup': 'menu' as const,
    'aria-expanded': expanded,
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => { event.stopPropagation() },
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation()
      event.currentTarget.focus({ preventScroll: true })
      const rect = event.currentTarget.getBoundingClientRect()
      toggle(target, { x: rect.left, y: rect.bottom })
    },
  }
  return <Tooltip label={label} side="bottom" align="end" portal>
    {size === 'sm'
      ? <Button {...attributes} size="sm" icon={<IconEllipsisOutlineRegular />} />
      : <button {...attributes} type="button"><IconEllipsisOutlineRegular /></button>}
  </Tooltip>
}
