/** Shared rendering of plugin-owned panel icons in navigation rows and menus. */
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './contract/slots.ts'

/**
 * Render the icon registered for one panel at the caller's size and selection state.
 * @param props - Panel identity, icon presentation, and the authorized child renderer.
 * @returns The matching panel icon.
 */
export function PanelIcon({ id, size, active, renderSlot }: FactoryComponentPropsOf<'sidebar.panel.icon'>) {
  return renderSlot('sidebar.panellist', { size, active }, { only: id })
}
