/** Mount lifecycle and document geometry; rendering failure never stops content-view synchronization. */
import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import type { FrameContentView } from '@deepseek-ai/dsh-frame-forwarding/client'
import type { FrameConnectionId } from '@deepseek-ai/dsh-frame-forwarding/types'
import type { OfficeConnection, OfficeDocumentActions } from './connection.ts'
import type { DocumentState, Props as ViewProps } from './View.tsx'
import type { OfficePaintRequest, Rect } from '../types.ts'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { MAX_OFFICE_PIXEL_DIMENSION } from '../render-limits.ts'
import { measureContentView } from './content-view.ts'
import { ViewportRenderer, renderWindow } from './viewport-renderer.ts'
import { ProgressivePages, previewPages, visiblePage } from './progressive.ts'
import { SheetHeaders } from './headers.ts'
import { documentViewport } from './zoom.ts'
import { pageClipPath } from './pages.ts'
import css from './Editor.module.css'

/** Imperative operations owned by the mounted document, not by the View's error state. */
export interface DocumentSurfaceControls {
  refresh(): void
  invalidate(area?: Rect): void
  headers(): void
  stop(): Promise<void>
}
interface Props {
  document: DocumentState
  connection: OfficeConnection
  channelEpoch: number
  playing: boolean
  suspended: boolean
  failed: boolean
  visible: boolean
  zoom: number
  viewport: RefObject<HTMLDivElement | null>
  documentElement: RefObject<HTMLDivElement | null>
  previewLayer: RefObject<HTMLDivElement | null>
  rows: RefObject<HTMLDivElement | null>
  columns: RefObject<HTMLDivElement | null>
  contentView: RefObject<FrameContentView | undefined>
  controls: RefObject<DocumentSurfaceControls | undefined>
  send: Pick<OfficeDocumentActions, 'viewport' | 'values' | 'playback' | 'pagePreview'>
  paint(value: Omit<OfficePaintRequest, 'frame'>, generation: number): Promise<void>
  failure(error: unknown): void
  waiting(value: boolean): void
  initial(value: boolean): void
  pageReady(index: number | undefined): void
  size(value: { width: number; height: number }): void
  t: ViewProps['t']
}

/** Mount the video displaying the Office viewport.
 * @param props - Document geometry, mounted refs and owned state callbacks.
 * @returns Image placeholder; DOM input and selections remain separate siblings.
 */
export function DocumentSurface(props: Props) {
  const element = useRef<HTMLDivElement>(null), latest = useRef(props)
  latest.current = props
  const sync = useRef<() => void>(() => {})
  // Each start waits for the preceding stop to finish.
  const tail = useRef(Promise.resolve())
  // Static pages belong to the document, while each selected part mounts a fresh native frame generation.
  const pageCache = useRef<ProgressivePages>(undefined)
  useEffect(() => () => {
    void pageCache.current?.dispose()
    pageCache.current = undefined
  }, [props.document.id, props.connection])
  useEffect(() => {
    const mount = element.current as HTMLDivElement, scroll = props.viewport.current as HTMLDivElement,
      documentElement = props.documentElement.current as HTMLDivElement
    const session = props.connection.frameForwardingSession(props.document.id)
    if (session === undefined || props.suspended) return
    const mountLifetime = new AbortController()
    let disposed = false, removeEvents = (): void => {}, detach = (): void => {}, renderer: ViewportRenderer | undefined
    let creditWaiting = false
    let pages: ProgressivePages | undefined, headers: SheetHeaders | undefined
    let playback: ReturnType<typeof session.startPlayback> | undefined
    let stopping: Promise<void> | undefined, syncing: Promise<void> | undefined, key = '', headerVersion = 0, syncedHeaders = -1
    let view: FrameContentView | undefined, connection: FrameConnectionId | undefined, playbackSize = ''
    let paintRatio: { pixelSize: number; twipSize: number } | undefined
    let contentScale: string | undefined
    let previewClip: { layer: HTMLDivElement; rectangles: string; zoom: number; value: string } | undefined
    const playbackStyles: Partial<Record<'width' | 'height' | 'left' | 'top', string>> = {}
    const setPlaybackStyle = (property: keyof typeof playbackStyles, value: string): void => {
      if (playbackStyles[property] === value) return
      mount.style[property] = value
      playbackStyles[property] = value
    }
    const report = (error: unknown): void => { if (!disposed) latest.current.failure(error) }
    const dimensions = (): { pixelWidth: number; pixelHeight: number } => {
      const size = latest.current.document.info
      const ratio = Math.min(scroll.clientWidth / size.width, scroll.clientHeight / size.height)
      const width = Math.max(1, size.width * ratio), height = Math.max(1, size.height * ratio)
      setPlaybackStyle('width', `${width}px`); setPlaybackStyle('height', `${height}px`)
      setPlaybackStyle('left', `${(scroll.clientWidth - width) / 2}px`); setPlaybackStyle('top', `${(scroll.clientHeight - height) / 2}px`)
      const density = Math.min(devicePixelRatio, MAX_OFFICE_PIXEL_DIMENSION / width, MAX_OFFICE_PIXEL_DIMENSION / height)
      return { pixelWidth: Math.max(1, Math.round(width * density)), pixelHeight: Math.max(1, Math.round(height * density)) }
    }
    const demand = (view: FrameContentView) => ({ view, width: mount.clientWidth || mount.getBoundingClientRect().width,
      height: mount.clientHeight || mount.getBoundingClientRect().height, deviceScale: devicePixelRatio,
      document: latest.current.document.info, part: latest.current.document.info.part,
      visible: latest.current.visible && globalThis.document.visibilityState === 'visible' })
    const visible = (view: FrameContentView): Rect => ({ x: view.x, y: view.y,
      width: demand(view).width / view.scale, height: demand(view).height / view.scale })
    const syncViewport = (): Promise<void> => syncing ??= (async () => {
      while (view !== undefined && !disposed && !latest.current.failed && demand(view).visible) {
        const current = demand(view), plan = renderWindow(current, latest.current.document.rendering.overscanViewports)
        const ratio = paintRatio ?? { pixelSize: plan.pixelWidth, twipSize: plan.window.width }
        const viewport = documentViewport({ scrollLeft: Math.max(0, view.x) * view.scale, scrollTop: Math.max(0, view.y) * view.scale,
          clientWidth: current.width, clientHeight: current.height }, view.scale * 15, ratio)
        const nextKey = JSON.stringify(viewport), version = headerVersion, changed = nextKey !== key
        if (!changed && (headers === undefined || version === syncedHeaders)) return
        if (changed) { await latest.current.send.viewport(viewport); key = nextKey }
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- stop() can run while the viewport acknowledgement is pending.
        if (disposed) return
        if (headers !== undefined) {
          const reply = await latest.current.send.values({ command: 'ViewRowColumnHeaders', area: viewport })
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- stop() can run while header values are pending.
          if (!disposed && version === headerVersion) {
            headers.update(JSON.parse(reply.value), ratio.pixelSize / (ratio.twipSize * view.scale))
            syncedHeaders = version
          }
        }
      }
    })().finally(() => { syncing = undefined })
    const updatePages = (): void => {
      if (view === undefined || pages === undefined) return
      const current = latest.current, part = current.document.info.part, window = session.rx.submittedWindow
      pages.content(window, visible(view))
      if (demand(view).visible && !current.failed) {
        const info = current.document.info
        const partial = window !== undefined && (window.width < info.width || window.height < info.height)
        pages.viewport(visiblePage(pages.pages, view.y, part), current.zoom, part, creditWaiting || partial)
      } else void pages.pause()
    }
    const refresh = (): void => {
      if (disposed) return
      const current = latest.current
      if (!current.playing && current.document.info.part !== props.document.info.part) return
      session.setVisible(current.visible)
      if (current.playing) {
        const size = dimensions(), key = JSON.stringify(size)
        if (playback !== undefined && key !== playbackSize) {
          playbackSize = key
          void playback.resize(size.pixelWidth, size.pixelHeight).catch(report)
        }
        return
      }
      view = measureContentView(mount, documentElement, current.zoom)
      current.contentView.current = view
      const scale = String(view.scale)
      if (contentScale !== scale) {
        documentElement.style.setProperty('--office-content-scale', scale)
        contentScale = scale
      }
      renderer?.enable(!current.failed && !current.suspended)
      renderer?.update(demand(view))
      headers?.scroll(view.x * view.scale, view.y * view.scale)
      if (pages !== undefined) {
        if (current.document.info.documentType === 'text') {
          const layer = props.previewLayer.current
          if (layer === null) return
          const rectangles = current.document.info.rectangles, zoom = current.zoom
          if (previewClip?.layer !== layer || previewClip.rectangles !== rectangles || previewClip.zoom !== zoom) {
            const value = pageClipPath(rectangles, zoom)
            if (previewClip?.layer !== layer || previewClip.value !== value) layer.style.clipPath = value
            previewClip = { layer, rectangles, zoom, value }
          }
        }
        updatePages()
      }
      void syncViewport().catch(report)
    }
    const resize = (): void => {
      if (disposed) return
      latest.current.size({ width: scroll.clientWidth, height: scroll.clientHeight })
      refresh()
    }
    const starting = tail.current.then(() => {
      if (disposed) return
      latest.current.initial(true)
      if (props.playing) {
        dimensions()
        removeEvents = session.rx.onEvent((event) => {
          if (event.kind === 'failure' || (event.kind === 'error' && event.connectionId === session.rx.connectionId))
            report(new Error(event.error))
        })
        playback = session.startPlayback(mount, (control, signal) => props.send.playback(session, control, signal), report,
          (value) => { latest.current.waiting(value) }, latest.current.visible)
        void playback.ready.catch(report)
      } else {
        for (const property of ['left', 'top', 'width', 'height']) mount.style.removeProperty(property)
        detach = session.mount(mount, report, latest.current.visible)
        if (props.rows.current !== null && props.columns.current !== null)
          headers = new SheetHeaders(props.rows.current, props.columns.current,
            (row, label) => latest.current.t(row ? 'selectRow' : 'selectColumn', { label }))
        renderer = new ViewportRenderer(props.document.rendering, session.frameTimeoutMs, {
          setView: (value) => { session.setContentView(value) }, setWindow: value => session.rx.setContentWindow(value),
          viewport: () => session.rx.viewport, ready: () => session.ready(mountLifetime.signal),
          paint: async (value, generation) => {
            paintRatio = { pixelSize: value.pixelWidth, twipSize: value.width }
            await syncViewport()
            // Kit's paint part targets a background slide. Writer/Calc paint the active view; setPart selects Calc sheets.
            const { part, ...area } = value
            if (!disposed) await latest.current.paint(props.document.info.documentType === 'presentation' && part !== undefined ? { ...area, part } : area, generation)
          },
          retry: error => props.connection.engineViewportStale(error) ? 'stale' : props.connection.frameWaitExpired(error) ? 'credit' : undefined,
          rebuild: () => session.trim(mountLifetime.signal), waiting: (value) => {
            if (disposed) return
            latest.current.waiting(value)
            if (creditWaiting !== value) {
              creditWaiting = value
              updatePages()
            }
          }, failure: report,
        })
        if (pageCache.current === undefined && props.previewLayer.current !== null) {
          latest.current.pageReady(undefined)
          const pagination = previewPages(props.document.info)
          if (pagination.length !== 0) pageCache.current = new ProgressivePages(
            props.previewLayer.current, pagination, props.document.rendering.maxPagePreviewBytes,
            async (page, pixelWidth, pixelHeight) => {
              const reply = await props.send.pagePreview({ ...page, pixelWidth, pixelHeight })
              if (typeof reply.width !== 'number' || typeof reply.height !== 'number' || !(reply.rgba instanceof Uint8Array))
                throw new Error('Invalid Office page response.')
              return { width: reply.width, height: reply.height, rgba: reply.rgba }
            }, (index) => { latest.current.pageReady(index) }, (error) => { latest.current.failure(error) })
        }
        pages = pageCache.current
        removeEvents = session.rx.onEvent((event) => {
          switch (event.kind) {
            case 'viewport': renderer?.viewportChanged(); break
            case 'state':
              if (event.channel.state === 'connected' && connection !== event.channel.connectionId) {
                connection = event.channel.connectionId; renderer?.invalidate()
              }
              break
            case 'content':
              renderer?.content(session.rx.submittedWindow)
              latest.current.initial(event.submittedGeneration === undefined)
              if (event.submittedGeneration !== undefined) {
                renderer?.presented()
                latest.current.waiting(false)
              }
              if (props.document.info.documentType === 'presentation') updatePages()
              else if (view !== undefined) pages?.content(session.rx.submittedWindow, visible(view))
              break
            case 'error':
              if (event.source !== 'presentation') report(new Error(event.error))
              else if (event.connectionId === session.rx.connectionId) renderer?.presentationFailed(new Error(event.error))
              break
            case 'failure': report(new Error(event.error)); break
            /* v8 ignore next -- FrameRxEvent is a closed union; every event kind is handled above. */
            default: assertNever(event, 'Office frame event')
          }
        })
      }
      resize()
    }).catch(report)
    sync.current = refresh
    const observer = new ResizeObserver(resize)
    observer.observe(scroll); observer.observe(documentElement); observer.observe(mount)
    scroll.addEventListener('scroll', refresh, { passive: true })
    globalThis.document.addEventListener('visibilitychange', refresh)
    const controls: DocumentSurfaceControls = {
      refresh,
      invalidate: area => renderer?.invalidate(area),
      headers: () => { headerVersion++; void syncViewport().catch(report) },
      stop: () => {
        if (stopping !== undefined) return stopping
        disposed = true
        const rendererStopped = renderer?.stop()
        mountLifetime.abort()
        observer.disconnect(); scroll.removeEventListener('scroll', refresh)
        globalThis.document.removeEventListener('visibilitychange', refresh)
        removeEvents()
        detach()
        stopping = Promise.all([starting, rendererStopped, pages?.pause(), syncing, playback?.stop()]).then(() => {})
        tail.current = stopping.catch((_error: unknown) => { /* The caller reports cleanup failure. */ })
        return stopping
      },
    }
    props.controls.current = controls
    return () => {
      sync.current = () => {}
      props.controls.current = undefined
      void controls.stop().catch((error: unknown) => { console.warn('Office display cleanup failed.', error) })
    }
  }, [props.document.id, props.channelEpoch, props.playing ? undefined : props.document.info.part,
    props.playing, props.suspended, props.connection])
  // Prop changes update FF and input coordinates; only ResizeObserver reports
  // viewport size, so a fit commit cannot synchronously measure and refit itself.
  useLayoutEffect(() => { sync.current() }, [props.zoom, props.document.info, props.visible, props.failed])
  return <div ref={element} className={css.frameMount} data-office-surface />
}
