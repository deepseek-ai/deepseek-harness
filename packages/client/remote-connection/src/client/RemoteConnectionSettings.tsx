/** One settings navigation entry owning the Remote connection panel and appended options. */
import { useEffect } from 'react'
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots/client'
import type {} from './slots.ts'
import css from './RemoteConnectionSection.module.css'

type Props = PropsRuntime<'settings.section'> & PropsRenderSlots<'settings.remoteConnection.content' | 'settings.remoteConnection.extensions'> & {
  onLeave: () => void
}

/**
 * Render the selected panel followed by independently registered options.
 * @param props - Settings close action, page-leave cleanup, and the owned slot renderer.
 * @returns The active Remote connection panel and its extensions.
 */
export function RemoteConnectionSettings({ close, renderSlot, onLeave }: Props) {
  useEffect(() => onLeave, [onLeave])
  return <div className={css.settings}>
    {renderSlot('settings.remoteConnection.content', { close })}
    {renderSlot('settings.remoteConnection.extensions', { close })}
  </div>
}
