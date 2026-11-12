/** One settings navigation entry owning the replaceable Remote connection panel. */
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from './slots.ts'

type Props = PropsRuntime<'settings.section'> & PropsRenderSlots<'settings.remoteConnection.content'>

/**
 * Render the selected panel while retaining the settings navigation identity.
 * @param props - Settings close action and the owned content renderer.
 * @returns The active Remote connection panel.
 */
export function RemoteConnectionSettings({ close, renderSlot }: Props) {
  return renderSlot('settings.remoteConnection.content', { close })
}
