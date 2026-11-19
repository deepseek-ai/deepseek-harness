/** Office presents retained conversion results and font notices around the shared PDF view. */
import { useEffect, type ReactNode } from 'react'
import type { PropsLocale, PropsRenderSlots, PropsStore, SlotHookFactory } from '@deepseek-ai/dsh-client-ui-slots'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { Button, FileTypeIcon, classifyFileType } from '@deepseek-ai/dsh-client-ui-primitives'
import { pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { DocumentBodyOwner, DocumentPreviewProps } from '../document/contract.ts'
import { hostFileOf } from '../rpc.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import type { OfficeLoadInjected } from './face.ts'
import type { OfficeStore } from './store.ts'
import common from '../TextPreview.module.css'
import css from './OfficeBody.module.css'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** PDF presentation supplied with Office-owned converted bytes. */
    'sidebar.right.tab.document.office.pdf': {
      kind: 'keyed'
      scope: 'session'
      owner: DocumentBodyOwner
      hookContext: UseSidebarRightTabInfo
      inject: { hooks: { tabInfo: SlotHookFactory<'sidebar.right.tab.document', UseSidebarRightTabInfo> } }
    }
  }
}

/** Office loading callbacks supplied by the registration's services. */
export interface OfficeBodyInjected extends OfficeLoadInjected {
  /** @param tab - owning tab. @param signal - tab lifetime, including hidden bodies. */
  readonly retainTab: (tab: TabId, signal: AbortSignal) => void
}

/** Office body inputs and its private PDF child. */
export type OfficeBodyProps = DocumentPreviewProps & PropsStore<OfficeStore> & OfficeBodyInjected
  & PropsLocale<'sidebarOffice'> & PropsRenderSlots<'sidebar.right.tab.document.office.pdf'>

/**
 * Load one Office revision and preserve its result while its tab remains open.
 * @param props - renderer loading request, tab state, conversion callbacks, and PDF slot.
 * @returns conversion status or the PDF scrollport.
 */
export function OfficeBody(props: OfficeBodyProps): ReactNode {
  const { tab } = props.useTabInfo()
  const { load, retainTab, resourceAddress, t } = props
  const request = props.content.kind === 'renderer' ? props.content : undefined
  const revision = request?.revision
  const held = props.useStore(state => state.byTab[tab.id])
  const view = held?.revision === revision ? held : undefined
  const settled = view?.file !== undefined || view?.failure !== undefined
  useEffect(() => { retainTab(tab.id, tab.signal) }, [retainTab, tab.id, tab.signal])
  // Metadata may replace callbacks without advancing the content revision.
  useEffect(() => {
    if (request === undefined || settled || tab.signal.aborted) return
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, tab.signal])
    load(tab.id, request.revision, hostFileOf(resourceAddress), signal, request.loaded, request.failed)
    return () => { controller.abort() }
  }, [revision, resourceAddress, tab.id, tab.signal, load, settled])
  const file = view?.file
  if (request === undefined) return null
  if (view?.failure !== undefined) {
    const { name } = pathPartsOf(resourceAddress)
    return <div className={common.empty} data-textpreview-failed={view.failure.code}>
      <FileTypeIcon kind={classifyFileType(name)} size={36} />
      <p className={common.emptyLine}>{view.failure.message}</p>
      <Button size="sm" onClick={request.reload}>{t('retry')}</Button>
    </div>
  }
  if (file === undefined) return <LoadingIndicator label={t('loading')} />
  return <div className={css.body}>
    {props.renderSlot('sidebar.right.tab.document.office.pdf', {
      resourceAddress, content: { kind: 'bytes', data: file.data }, wrap: props.wrap, scrollportRef: props.scrollportRef,
      addResource: props.addResource, setResources: props.setResources,
    }, { entryKey: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/office', hookContext: props.useTabInfo })}
  </div>
}
