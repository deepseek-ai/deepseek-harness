/** Office presents retained conversion results and font notices around the shared PDF view. */
import { useCallback, useEffect, type ReactNode } from 'react'
import type { PropsLocale, PropsRenderSlots, PropsStore, SlotHookFactory } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit/client'
import { Button, FileTypeIcon, classifyFileType } from '@deepseek-ai/dsh-client-ui-primitives/client'
import { pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { DocumentBodyOwner, DocumentPreviewProps, DocumentContent } from '../document/contract.ts'
import { officeFallback } from './fallback.ts'
import { hostFileOf } from '../rpc.ts'
import { LoadingIndicator } from '../LoadingIndicator.tsx'
import type { OfficeLoadInjected } from './face.ts'
import type { OfficeStore } from './store.ts'
import common from '../TextPreview.module.css'
import css from './OfficeBody.module.css'

/** Inputs of the optional native Office renderer; the document preview keeps the format-specific fallback. */
export interface OfficeNativeOwner extends Pick<DocumentBodyOwner, 'resourceAddress' | 'content'> {
  /**
   * Report that native rendering of this owner's content revision cannot open or stopped rendering after opening; call
   * it from an event or failure callback, never during render. The owner replaces this slot with the format-specific
   * fallback until the content revision changes, including through reload. Calls for a superseded revision or a closed
   * tab are ignored. The reference stays stable for one tab occurrence and revision.
   */
  readonly onNativeUnavailable: () => void
}

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface SlotMap {
    /** Native controls alongside the shared document reload action. */
    'sidebar.right.tab.document.office.native.action': {
      kind: 'single'
      scope: 'session'
      owner: { readonly content: DocumentContent }
      hookContext: UseSidebarRightTabInfo
      inject: { hooks: { tabInfo: SlotHookFactory<'sidebar.right.tab.document', UseSidebarRightTabInfo> } }
    }
    /**
     * Optional Desktop renderer for DOCX, XLSX, and PPTX sources. The owner renders the format-specific fallback itself:
     * without a registration, for other formats, and after the renderer reports that native rendering cannot open
     * or stopped rendering after opening.
     */
    'sidebar.right.tab.document.office.native': {
      kind: 'single'
      scope: 'session'
      owner: OfficeNativeOwner
      hookContext: UseSidebarRightTabInfo
      inject: { hooks: { tabInfo: SlotHookFactory<'sidebar.right.tab.document', UseSidebarRightTabInfo> } }
    }
    /** Browser workbook presentation used after native rendering fails. */
    'sidebar.right.tab.document.office.spreadsheet': {
      kind: 'keyed'
      scope: 'session'
      owner: DocumentBodyOwner
      hookContext: UseSidebarRightTabInfo
      inject: { hooks: { tabInfo: SlotHookFactory<'sidebar.right.tab.document', UseSidebarRightTabInfo> } }
    }
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

/** Office body inputs and its private fallback views. */
export type OfficeBodyProps = DocumentPreviewProps & PropsStore<OfficeStore> & OfficeBodyInjected
  & PropsLocale<'sidebarOffice'> & PropsRenderSlots<'sidebar.right.tab.document.office.pdf' | 'sidebar.right.tab.document.office.native'
    | 'sidebar.right.tab.document.office.spreadsheet'>

/**
 * Load one Office revision and preserve its result while its tab remains open.
 * @param props - renderer loading request, tab state, fallback callbacks and presentation slots.
 * @returns conversion status or the fallback scrollport.
 */
function OfficeFallbackBody(props: OfficeBodyProps): ReactNode {
  const { tab } = props.useTabInfo()
  const { load, resourceAddress, t } = props
  const request = props.content.kind === 'renderer' ? props.content : undefined
  const revision = request?.revision
  const held = props.useStore(state => state.byTab[tab.id])
  const view = held?.revision === revision ? held : undefined
  const settled = view?.file !== undefined || view?.failure !== undefined
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
    {props.renderSlot(officeFallback(hostFileOf(resourceAddress).path) === 'spreadsheet'
      ? 'sidebar.right.tab.document.office.spreadsheet' : 'sidebar.right.tab.document.office.pdf', {
      resourceAddress, content: { kind: 'bytes', data: file.data }, wrap: props.wrap, scrollportRef: props.scrollportRef,
      addResource: props.addResource, setResources: props.setResources,
    }, { entryKey: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/office', hookContext: props.useTabInfo })}
  </div>
}

/** Offer Desktop native rendering while retaining the existing PDF and spreadsheet implementations.
 * @param props - Versioned document request and renderer-owned fallback state.
 * @returns Native body when registered and available for this revision, otherwise the format-specific fallback.
 */
export function OfficeBody(props: OfficeBodyProps): ReactNode {
  const { tab } = props.useTabInfo()
  const { actions, retainTab } = props
  const revision = props.content.kind === 'renderer' ? props.content.revision : undefined
  const unavailable = props.useStore(state => state.nativeUnavailable[tab.id])
  useEffect(() => { retainTab(tab.id, tab.signal) }, [retainTab, tab.id, tab.signal])
  const onNativeUnavailable = useCallback(() => {
    if (revision !== undefined && !tab.signal.aborted) actions.nativeUnavailable(tab.id, revision)
  }, [actions, revision, tab.id, tab.signal])
  const fallback = <OfficeFallbackBody {...props} />
  if (!/\.(?:docx|xlsx|pptx)$/i.test(hostFileOf(props.resourceAddress).path)) return fallback
  if (revision !== undefined && unavailable === revision) return fallback
  return props.renderSlot('sidebar.right.tab.document.office.native', {
    resourceAddress: props.resourceAddress, content: props.content, onNativeUnavailable,
  }, { hookContext: props.useTabInfo, fallback })
}
