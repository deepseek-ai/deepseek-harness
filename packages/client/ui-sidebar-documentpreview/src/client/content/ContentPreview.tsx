/** Render caller-supplied text or bytes with the shared document renderer. */
import { useEffect, useMemo } from 'react'
import type { ReactNode, UIEvent } from 'react'
import clsx from 'clsx'
import type {
  InjectFace, PropsLocale, PropsRenderFactories, PropsRenderSlots, PropsRuntime, PropsStore,
} from '@deepseek-ai/dsh-client-ui-slots'
import { FileTypeIcon, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { useScrollport } from '../scrollport.ts'
import { RendererMenu, WrapToggle } from '../ViewerTools.tsx'
import shared from '../TextPreview.module.css'
import { documentContentOf } from './content.ts'
import type { ContentPreviewInjected } from './face.ts'
import { freshView } from './store.ts'
import type { ContentPreviewStore } from './store.ts'
import { iconKindOf } from './title.ts'
import css from './ContentPreview.module.css'

/** The body's composed props: the tab, its resource, the view store, the face, and copy. */
export type ContentPreviewProps =
  & PropsRuntime<'sidebar.right.pane.tab'>
  & PropsRenderSlots<'sidebar.right.tab.content.actions'>
  & PropsRenderFactories
  & PropsStore<ContentPreviewStore>
  & InjectFace<ContentPreviewInjected>
  & PropsLocale<'sidebarDocumentPreview'>

/** In-memory content declares no file dependencies, so the renderer's dependency callbacks do nothing. */
function ignoreResources(): void {}

/**
 * The content type's body, registered under `sidebar.right.pane.tab`.
 * @param props - composed slot props.
 * @returns the rendered content with its header, or a status line.
 */
export function ContentPreview({
  useTabInfo, useStore, useDocumentPreviews,
  select, toggleWrap, scroll, mediaTypeCandidates, renderSlot, renderFactorySlot, t,
}: ContentPreviewProps): ReactNode {
  const { tab } = useTabInfo()
  const address = tab.contentId
  const params = tab.navigation.params
  const input = params !== undefined && 'previewContent' in params ? params : undefined
  const content = input?.previewContent
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
  const title = input?.previewTitle ?? tab.title

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
        {renderFactorySlot('sidebar.right.document.body', {
          rendererId, useTabInfo, resourceAddress: address, content: rendered,
          wrap: view.wrap, scrollportRef: bindScrollport, addResource: ignoreResources, setResources: ignoreResources,
        })}
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
      <div className={shared.header}>
        <Tooltip label={title} side="bottom" delayMs={500} onlyWhenClipped>
          <span className={css.title} data-contentpreview-title>{title}</span>
        </Tooltip>
        {selected !== undefined && candidates.length > 1 && (
          <RendererMenu candidates={candidates} selected={selected} onSelect={(id) => { select(tab.id, tab.signal, id) }} t={t} />
        )}
        {selected?.wrap === true && (
          <WrapToggle wrap={view.wrap} t={t} data-contentpreview-tool="wrap" onToggle={() => { toggleWrap(tab.id, tab.signal) }} />
        )}
        {content !== undefined && renderSlot('sidebar.right.tab.content.actions', { address, content })}
      </div>
      {body}
    </div>
  )
}
