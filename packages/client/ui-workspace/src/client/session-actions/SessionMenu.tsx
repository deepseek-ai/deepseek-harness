/** Legacy external Session contributions shared by the row, header, and More trigger. */
import { useMemo } from 'react'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

type Props = Pick<PropsRuntime<'contextMenu.content'>, 'target' | 'dismiss'> & PropsRenderSlots<'sidebar.workspaces.session.menu.item'>
/** @param props - captured Session and the existing extension position. @returns legacy component contributions. */
export function SessionMenu({ target, dismiss, renderSlot }: Props) {
  const hookContext = useMemo<readonly [boolean, (open: boolean) => void]>(() => [true, (open) => { if (!open) dismiss() }], [dismiss])
  if (target.kind !== 'session') return null
  return renderSlot('sidebar.workspaces.session.menu.item', target.value, {
    hookContext,
  })
}
