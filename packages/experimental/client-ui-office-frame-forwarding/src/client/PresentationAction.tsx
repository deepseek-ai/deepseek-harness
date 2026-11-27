/** Playback contribution inside the existing document toolbar. */
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { PresentationStore } from './presentation-store.ts'
import { IconPlayOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives/client'
import { FileToolbarButton } from './primitives/FileToolbar.tsx'

/** Document header props and its native view's shared controls. */
export type PresentationActionProps = PropsRuntime<'sidebar.right.tab.document.office.native.action'>
  & PropsStore<PresentationStore> & PropsLocale<'desktopOffice'>

/** Show playback only while this tab owns a mounted presentation.
 * @param props - Header tab reader, shared controls, and localized label.
 * @returns the presentation play button, or nothing for other document views.
 */
export function PresentationAction({ useTabInfo, useStore, t }: PresentationActionProps): ReactNode {
  const { tab } = useTabInfo()
  const action = useStore(state => state.byTab[tab.id])
  if (action === undefined) return null
  return <FileToolbarButton icon={<IconPlayOutlineRegular />} label={t('play')}
    disabled={action.disabled} onClick={action.play} />
}
