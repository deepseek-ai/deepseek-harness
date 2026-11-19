/** Render caller-supplied text or bytes with the shared document renderer. */
import { useEffect, useMemo } from 'react'
import type { ReactNode, UIEvent } from 'react'
import clsx from 'clsx'
import type {
  FactoryComponentPropsOf, PropsRenderFactories, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import { FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives'
import { useScrollport } from '../scrollport.ts'
import { RendererMenu, WrapToggle } from '../ViewerTools.tsx'
import shared from '../TextPreview.module.css'
import { DocumentBody } from '../DocumentBody.tsx'
import { documentContentOf } from './content.ts'
import { freshView } from './store.ts'
import { iconKindOf } from './title.ts'
import css from './ContentPreview.module.css'

type ContentTabProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsRenderFactories

/** Read the current navigation input of a transient content tab.
 * @param props - enclosing tab and shared viewer.
 * @returns the content viewer, including its expired state after reload.
 */
export function ContentPreview({ useTabInfo, renderFactorySlot }: ContentTabProps): ReactNode {
  const { tab } = useTabInfo()
  const params = tab.navigation.params
  const input = params !== undefined && 'previewContent' in params ? params : undefined
  return renderFactorySlot('sidebar.right.document.body', {
    title: input?.previewTitle ?? tab.title, content: input?.previewContent, useTabInfo,
  })
}

type BodyProps = FactoryComponentPropsOf<'sidebar.right.document.body'>

/** Dispatch file inputs directly and show content controls when available.
 * @param props - selected file renderer or caller-supplied content and title.
 * @returns the document body for this tab.
 */
export function DocumentViewer(props: BodyProps): ReactNode {
  return 'rendererId' in props ? <DocumentBody {...props} /> : <ContentViewer {...props} />
}

/** In-memory content declares no file dependencies, so the renderer's dependency callbacks do nothing. */
function ignoreResources(): void {}

/**
 * Render tab content through the selected document renderer.
 * @param props - title, content, enclosing tab, and viewer controls.
 * @returns the preview body and available controls.
 */
function ContentViewer({
  content, title, useTabInfo, useStore, useDocumentPreviews,
  select, toggleWrap, scroll, mediaTypeCandidates, renderSlot, t,
}: Extract<BodyProps, { title: string }>): ReactNode {
  const { tab } = useTabInfo()
  const address = tab.contentId
  const view = useStore(state => state.byTab[tab.id]) ?? freshView()
  const definitions = useDocumentPreviews(value => value)
  const mediaType = content?.mediaType
  // The registry snapshot is a dependency: the callback ranks its current registrations.
  const candidates = useMemo(
    () => mediaType === undefined ? [] : mediaTypeCandidates(mediaType),
    [definitions, mediaType, mediaTypeCandidates],
  )
  const selected = candidates.find(candidate => candidate.id === view.rendererId) ?? candidates[0]
  const loading = selected?.loading
  const rendered = useMemo(
    () => content === undefined || loading === undefined ? undefined : documentContentOf(content, loading),
    [content, loading],
  )

  const { scrollportRef, bindBody, bindScrollport } = useScrollport(view.scrollTop)
  // Return to the remembered offset once content renders: on a remount, after
  // new content arrived, or after the renderer changed.
  useEffect(() => {
    const scrollport = scrollportRef.current
    if (rendered === undefined || scrollport === null) return
    scrollport.scrollTop = Math.max(scrollport.scrollTop, view.scrollTop)
  }, [rendered, selected?.id])
  const onScroll = (event: UIEvent<HTMLDivElement>): void => {
    if (event.target !== scrollportRef.current) return
    // The target is the scrollport element bound above.
    scroll(tab.id, tab.signal, (event.target as HTMLElement).scrollTop)
  }

  const status = (state: string, children: ReactNode): ReactNode => (
    <div className={css.status} data-contentpreview-status={state}>{children}</div>
  )
  let body: ReactNode
  let state: string
  let rendererId: string | undefined
  if (content === undefined) {
    state = 'expired'
    body = status(state, <p className={shared.emptyLine}>{t('content.expired')}</p>)
  } else if (selected === undefined || rendered === undefined) {
    state = 'unsupported'
    body = status(state, (
      <>
        <FileTypeIcon kind={iconKindOf(content.mediaType)} size={36} className={shared.emptyIcon} />
        <p className={shared.emptyLine}>{t('content.noRenderer', { mediaType: content.mediaType })}</p>
      </>
    ))
  } else {
    state = 'content'
    rendererId = selected.id
    body = (
      <div
        ref={bindBody}
        className={clsx(shared.body, view.wrap && shared.wrap)}
        data-contentpreview-body
        data-contentpreview-wrap={view.wrap ? '' : undefined}
        onScrollCapture={onScroll}
      >
        <DocumentBody rendererId={rendererId} useTabInfo={useTabInfo} resourceAddress={address} content={rendered}
          wrap={view.wrap} scrollportRef={bindScrollport} addResource={ignoreResources} setResources={ignoreResources}
          renderSlot={renderSlot} useDocumentPreviews={useDocumentPreviews} t={t} />
      </div>
    )
  }

  return (
    <div
      className={shared.preview}
      role="region"
      aria-label={title}
      data-contentpreview-state={state}
      data-contentpreview-url={address}
      data-contentpreview-media-type={mediaType}
      data-document-preview={rendererId}
    >
      {selected !== undefined && (candidates.length > 1 || selected.wrap) && (
        <div className={shared.header} data-contentpreview-toolbar>
          {candidates.length > 1 && (
            <RendererMenu candidates={candidates} selected={selected} onSelect={(id) => { select(tab.id, tab.signal, id) }} t={t} />
          )}
          {selected.wrap && (
            <WrapToggle wrap={view.wrap} t={t} data-contentpreview-tool="wrap" onToggle={() => { toggleWrap(tab.id, tab.signal) }} />
          )}
        </div>
      )}
      {body}
    </div>
  )
}
