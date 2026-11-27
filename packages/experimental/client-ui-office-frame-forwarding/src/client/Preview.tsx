/** Default native Office body; the document preview renders the format-specific fallback after a reported failure. */
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type { PresentationStore, PresentationAction } from './presentation-store.ts'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit/client'
import { OfficeView } from './View.tsx'
import type { OfficePreviewClient } from './service.ts'

/** Default preview consumes the native child slot and its owning connection. */
export type PreviewProps = PropsRuntime<'sidebar.right.tab.document.office.native'> & PropsLocale<'desktopOffice'>
  & PropsStore<PresentationStore> & { readonly office: OfficePreviewClient }

/** Mount one native attempt per source revision; an opening or rendering failure is reported once to the document preview.
 * @param props - Document revision, unavailability report, locale and shared connection.
 * @returns Native Office view, or nothing after the attempt failed.
 */
export function FrameForwardingAttempt(props: PreviewProps): ReactNode {
  const { office, content, onNativeUnavailable } = props
  const [failed, setFailed] = useState(false)
  const reported = useRef(false)
  // An in-flight open keeps the callback it started with; the owner's callback is fixed for one tab occurrence and revision.
  const reportFailure = useCallback((error: unknown) => {
    if (reported.current) return
    reported.current = true
    console.warn('Office FrameForwarding preview failed; using format-specific fallback.', error)
    setFailed(true)
    onNativeUnavailable()
  }, [onNativeUnavailable])
  const loaded = useCallback((version: string) => {
    if (content.kind === 'renderer') content.loaded(version)
  }, [content])
  const registerPresentation = useCallback((tab: TabId, action: PresentationAction) => {
    props.actions.present(tab, action)
    return () => { props.actions.retire(tab, action.play) }
  }, [props.actions])
  if (failed) return null
  return <OfficeView {...props} revision={content.kind === 'renderer' ? content.revision : 0} connection={office.connection} registerPresentation={registerPresentation}
    onFailure={reportFailure} onLoaded={loaded} />
}

/** Mount the tab's retained native body; the document preview renders this slot only for DOCX, XLSX, and PPTX sources.
 * @param props - Document resource, revision, and unavailability report.
 * @returns Mount point for the revision-owned native preview.
 */
export function Preview(props: PreviewProps): ReactNode {
  const { tab } = props.useTabInfo()
  const mount = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    return props.office.views.attach(tab.signal, mount.current as HTMLDivElement, props)
  }, [props.office, tab.signal])
  useLayoutEffect(() => { props.office.views.update(tab.signal, props) })
  return <div ref={mount} style={{ height: '100%', minHeight: 0 }} />
}
