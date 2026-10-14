/** The existing overlay dispatches the latest Workspace notice to its keyed presentation. */
import type { RowToastProps } from '../contract/slots.ts'
import type {} from '../contract/toast.ts'

/**
 * Dispatch the current notice without interpreting its business payload.
 * @param props - Current notice, dismissal, and the declared keyed renderer.
 * @returns The selected notice presentation, or nothing.
 */
export function RowActionToast({ useToast, dismissToast, renderSlot }: RowToastProps) {
  const notice = useToast(current => current)
  if (notice === null) return null
  return renderSlot('workspace.toast', { ...notice, dismissToast }, { entryKey: notice.kind })
}
