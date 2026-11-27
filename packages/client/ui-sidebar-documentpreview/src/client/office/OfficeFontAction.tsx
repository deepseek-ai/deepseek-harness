/** Native controls and font warnings in the owning document toolbar. */
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { OfficeStore } from './store.ts'
import { FontNotice } from './FontNotice.tsx'

/** Office toolbar inputs share the body’s conversion result. */
export type OfficeFontActionProps = PropsRuntime<'sidebar.right.tab.document.action'>
  & PropsStore<OfficeStore> & PropsLocale<'sidebarOffice'> & PropsRenderSlots<'sidebar.right.tab.document.office.native.action'>

/**
 * Show native actions and font details for the currently loaded Office revision.
 * @param props - toolbar revision, tab reader, Office store, document portal, and localized copy.
 * @returns native header controls and any settled conversion font warning.
 */
export function OfficeFontAction({ content, useTabInfo, useStore, useDocumentPortal, t, renderSlot }: OfficeFontActionProps): ReactNode {
  const { tab } = useTabInfo()
  const held = useStore(state => state.byTab[tab.id])
  const Portal = useDocumentPortal()
  return <>
    {renderSlot('sidebar.right.tab.document.office.native.action', { content }, {
      hookContext: useTabInfo,
    })}
    {content.kind === 'renderer' && held?.revision === content.revision && held.file !== undefined && 'missingFonts' in held.file
      && <FontNotice key={content.revision} fonts={held.file.missingFonts} t={t} Portal={Portal} />}
  </>
}
