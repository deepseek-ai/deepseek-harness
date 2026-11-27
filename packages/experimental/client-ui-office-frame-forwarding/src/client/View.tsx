/** Native preview, zoom, scroll, playback, and document lifetime of one Office tab. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import {
  useCallback, useMemo,
  useEffect,
  useLayoutEffect,
  useRef,
  useId,
  useState,
  type ReactNode,
  type KeyboardEvent,
} from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots/client'
import { createPortal } from 'react-dom'
import { StateDot, ZoomControls, useModalLayer } from '@deepseek-ai/dsh-client-ui-primitives/client'
import { useFloatingToolbar } from './primitives/use-floating-toolbar.ts'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-api-workspace-files/client'
import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import {
  OfficeChannelError, OfficeConnection, type OfficeOpenFields, type OfficeRenderStop,
  type OfficeViewEvent,
} from './connection.ts'
import { exitElementFullscreen, isOccludedByFullscreen, requestElementFullscreen } from './fullscreen.ts'
import { bindPinchZoom, fitZoom, restoreZoomAnchor } from './zoom.ts'
import { bindTouchSelection } from './touch-selection.ts'
import { OfficeInput } from './input.ts'
import { previewPages } from './progressive.ts'
import { DocumentSurface, type DocumentSurfaceControls } from './DocumentSurface.tsx'
import type { FrameContentView } from '@deepseek-ai/dsh-frame-forwarding/client'
import { ToolbarButton, type OfficeAction } from './ToolbarButton.tsx'
import { SheetTabs } from './SheetTabs.tsx'
import { parseCallbackRectangle } from './selection.ts'
import type { PresentationAction } from './presentation-store.ts'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit/client'
import { usePreviewInteraction } from './usePreviewInteraction.tsx'
import type { OfficeDocumentInfo, OfficeLoadingStage, OfficeDocumentId, OfficePaintRequest, OfficeOpenedDocument, Rect } from '../types.ts'
import css from './Editor.module.css'

/** Open document metadata and its validated Host rendering configuration. */
export interface DocumentState {
  rendering: OfficeOpenedDocument['rendering']
  id: OfficeDocumentId
  info: OfficeDocumentInfo
}
/** Opaque gaps cover whole-window pixels without clipping the video or page selections. */
function PageGaps({ pages }: { pages: readonly Rect[] }) {
  let bottom = 0
  return <div className={css.pageGaps} data-office-page-gaps aria-hidden="true">
    {pages.toSorted((a, b) => a.y - b.y).map((page, index) => {
      const top = bottom
      bottom = Math.max(bottom, page.y + page.height)
      if (index === 0 || page.y <= top) return null
      return <div key={page.y} className={css.pageGap} data-office-page-gap style={{
        top: `calc(${top}px * var(--office-content-scale))`,
        height: `calc(${page.y - top}px * var(--office-content-scale))`,
      }} />
    })}
  </div>
}

/** Native editor slot props and its plugin-owned connection. */
export type Props = Pick<PropsRuntime<'sidebar.right.pane.tab'>, 'useTabInfo' | 'useResource'> & PropsLocale<'desktopOffice'> & { revision: number; connection: OfficeConnection; registerPresentation?: ((tab: TabId, action: PresentationAction) => () => void) | undefined; onFailure?: ((error: unknown) => void) | undefined; onLoaded?: ((version: string) => void) | undefined }
/** Display the current file without placing transient content in Session state. */
export function OfficeView({ useTabInfo, t, revision, connection, registerPresentation, onFailure, onLoaded }: Props): ReactNode {
  const { tab } = useTabInfo()
  const [viewTarget] = useState(() => globalThis.document.createElement('div'))
  /** Whether another element of the document is fullscreen, covering this view. */
  const [occluded, setOccluded] = useState(() => isOccludedByFullscreen(viewTarget))
  const holdingFullscreenRef = useRef(false)
  const visibleRef = useRef(tab.visible)
  visibleRef.current = tab.visible && !occluded
  const partPanelId = useId()
  const [document, setDocument] = useState<DocumentState>()
  const current = useRef(document)
  const [failure, setFailure] = useState<string>()
  /** Why rendering stopped and the recovery offered for it. */
  const [renderStop, setRenderStop] = useState<{ kind: Exclude<OfficeRenderStop, 'recovering'>; message: string }>()
  const renderFailure = renderStop?.message
  const fallbackReported = useRef(false)
  const onExpiry = useRef<() => void>(undefined)
  const failureCallback = useRef(onFailure)
  failureCallback.current = onFailure
  /** Whether a lost frame-forwarding channel is being replaced. */
  const [leaseOffline, setLeaseOffline] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  /** Whether a frame came late, typically because other views hold the window's frame surfaces; the next drawn frame clears it. */
  const [waitingForFrames, setWaitingForFrames] = useState(false)
  /** Advances when a lost channel is replaced, so the document remounts. */
  const [channelEpoch, setChannelEpoch] = useState(0)
  const renderFailureRef = useRef(renderFailure)
  renderFailureRef.current = renderFailure
  const retryScroll = useRef<{ left: number; top: number }>(undefined)
  const [zoom, setZoom] = useState(1)
  const [fit, setFit] = useState<'width' | 'page'>()
  const reloadPosition = useRef<{ type: OfficeDocumentInfo['documentType']; left: number; top: number; part: number; zoom: number; fit: 'width' | 'page' | undefined }>(undefined)
  const previewLayer = useRef<HTMLDivElement>(null)
  const [readyPages, setReadyPages] = useState<ReadonlySet<number>>(new Set())
  const pagination = document === undefined ? [] : previewPages(document.info)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const zoomAnchor = useRef<{ x: number; y: number; left: number; top: number }>(undefined)
  const contentView = useRef<FrameContentView>(undefined)
  const documentElement = useRef<HTMLDivElement>(null)
  const surface = useRef<DocumentSurfaceControls>(undefined)
  const [viewportSize, setViewportSize] = useState({ width: 1, height: 1 })
  const [fitSize, setFitSize] = useState({ width: 1, height: 1 })
  const viewportMeasurement = useRef<{
    element: HTMLDivElement
    bounds: { width: number; height: number }
    size: { width: number; height: number }
    fit: { width: number; height: number }
  }>(undefined)
  const floating = useFloatingToolbar()
  const playbackControls = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const viewMount = useRef<HTMLDivElement>(null)
  const editor = useRef<HTMLDivElement>(null)
  const presenting = playing && tab.visible
  // The slideshow shows `viewTarget` fullscreen in place: moving a fullscreen element out of the document ends its fullscreen.
  useLayoutEffect(() => {
    (viewMount.current as HTMLDivElement).append(viewTarget)
    return () => { viewTarget.remove() }
  }, [viewTarget])
  useLayoutEffect(() => {
    viewTarget.className = `${presenting ? css.presentationLayer : css.viewMount}`
  }, [viewTarget, presenting])
  const playingRef = useRef(playing)
  const [transitioningPlayback, setTransitioningPlayback] = useState(false)
  const playbackTransition = useRef<'starting' | 'stopping'>(undefined)
  const playbackTask = useRef<Promise<void>>(undefined)
  const playbackStopRequested = useRef(false)
  const stopPresentation = useRef<() => Promise<void>>(undefined)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; playbackStopRequested.current = true }
  }, [])
  const [paused, setPaused] = useState(false)
  const [operationBusy, setBusy] = useState(false)
  const busy = operationBusy || transitioningPlayback
  const viewport = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const rowHeaders = useRef<HTMLDivElement>(null)
  const columnHeaders = useRef<HTMLDivElement>(null)
  const inputQueue = useRef(new OfficeInput())
  const settling = useRef(false)
  const opening = useRef<Promise<OfficeOpenedDocument | undefined>>(undefined)
  const openingGeneration = useRef(0)
  const [loadingStage, setLoadingStage] = useState<OfficeLoadingStage>()
  const [initialPaint, setInitialPaint] = useState(true)
  const update = useCallback((info: OfficeDocumentInfo): void => {
    const previous = current.current
    if (previous === undefined || previous.info === info) return
    const next = { ...previous, info }
    current.current = next
    setDocument(next)
  }, [])
  const openDocumentId = useCallback((): OfficeDocumentId => {
    const doc = current.current
    if (doc === undefined) throw new Error('Office is loading.')
    return doc.id
  }, [])
  const request = useMemo(() => connection.document(openDocumentId, undefined, update), [connection, openDocumentId, update])
  const send = useMemo(() => connection.document(openDocumentId, work => inputQueue.current.send(work), update),
    [connection, openDocumentId, update])
  const paint = useCallback((value: Omit<OfficePaintRequest, 'frame'>, generation: number) =>
    inputQueue.current.send(async () => {
      if (renderFailureRef.current !== undefined || (value.part !== undefined && value.part !== current.current?.info.part)) return
      await connection.requestFrame(openDocumentId(), value, generation)
    }), [connection, openDocumentId])
  const pageReady = useCallback((index: number | undefined): void => {
    setReadyPages(previous => index === undefined ? new Set() : new Set([...previous, index]))
  }, [])
  const measureSize = useCallback((value: { width: number; height: number }): void => {
    const scroll = viewport.current
    if (scroll === null) return
    const bounds = scroll.getBoundingClientRect(), previous = viewportMeasurement.current
    const sameBox = previous?.element === scroll && previous.bounds.width === bounds.width && previous.bounds.height === bounds.height
    // Within one outer box, keep the space occupied by either scrollbar reserved
    // for fit. client sizes may grow again when fitting removes those scrollbars.
    // A real container resize starts a fresh fit, including when it grows back.
    const fitted = sameBox
      ? { width: Math.min(previous.fit.width, value.width), height: Math.min(previous.fit.height, value.height) } : value
    if (previous?.size.width !== value.width || previous.size.height !== value.height) setViewportSize(value)
    if (previous?.fit.width !== fitted.width || previous.fit.height !== fitted.height) setFitSize(fitted)
    viewportMeasurement.current = { element: scroll, bounds, size: value, fit: fitted }
  }, [])
  /** Leave a slideshow the Host no longer plays, exiting the fullscreen this view holds. */
  const leavePlayback = useCallback((): void => {
    const exitFullscreen = playingRef.current
    playingRef.current = false
    setPlaying(false)
    setPaused(false)
    if (exitFullscreen) void exitElementFullscreen(viewTarget).catch((failure: unknown) => {
      console.error('Office fullscreen exit failed.', failure)
    })
  }, [viewTarget])
  const failRendering = useCallback((error: unknown): void => {
    if (remoteErrorOf(error)?.code === 'office/document-expired' && current.current !== undefined) {
      onExpiry.current?.()
      return
    }
    const kind = connection.renderStop(error)
    // A lost channel is being replaced; the recovery's outcome arrives as a channel event.
    if (kind === 'recovering' || fallbackReported.current || !mounted.current) return
    playbackStopRequested.current = true
    const message = error instanceof Error ? error.message : String(error)
    renderFailureRef.current = message
    setRenderStop({ kind, message })
    leavePlayback()
    if (kind === 'fallback') {
      fallbackReported.current = true
      failureCallback.current?.(error)
    }
  }, [connection, leavePlayback])
  const failAction = useCallback((error: unknown): void => {
    setFailure(error instanceof Error ? error.message : String(error))
  }, [])
  const action = useCallback((operation: () => Promise<unknown>): void => {
    void operation().then(
      () => {
        setFailure(undefined)
      },
      failAction,
    )
  }, [failAction])
  const partTarget = useRef<number>(undefined)
  const selectPart = useCallback((part: number): void => {
    if (settling.current || playbackTransition.current !== undefined || renderFailureRef.current !== undefined) return
    partTarget.current = part
    action(async () => {
      try { await send.part(part) }
      finally { if (partTarget.current === part) partTarget.current = undefined }
    })
  }, [action, send])
  const stepPart = useCallback((direction: -1 | 1): void => {
    const doc = (current.current as DocumentState)
    const parts = doc.info.parts
    const position = parts.findIndex(part => part.index === (partTarget.current ?? doc.info.part))
    const next = parts[position + direction]
    if (next !== undefined) selectPart(next.index)
  }, [selectPart])
  const open = useCallback(
    async (retryExpired = true): Promise<void> => {
      const active = (): boolean => mounted.current && !tab.signal.aborted
      if (!active()) return
      setFailure(undefined)
      setLeaseOffline(false)
      setRenderStop(undefined)
      setLoadingStage(undefined)
      setInitialPaint(true)
      const generation = ++openingGeneration.current
      const file = parseFileAddress(tab.contentId)
      if (file?.scope !== 'session') throw new Error('Office requires a session file address.')
      const request: OfficeOpenFields = { address: tab.contentId, owner: tab.id, revision,
        sessionId: file.sessionId as SessionId, path: file.path }
      const progress = (stage: OfficeLoadingStage): void => {
        if (active() && openingGeneration.current === generation) setLoadingStage(stage)
      }
      const attempt = connection.open(request, progress).catch((error: unknown) => {
        if (remoteErrorOf(error)?.code !== 'office/document-expired' || !retryExpired || !active()) throw error
        return connection.open(request, progress)
      })
      // Failed opens have no document to settle or release; the action still presents their error.
      opening.current = attempt.catch((_error: unknown) => undefined)
      const reply = await attempt
      if (!active() || openingGeneration.current !== generation) {
        return
      }
      const state: DocumentState = {
        rendering: reply.rendering, id: reply.documentId, info: reply.info,
      }
      const position = reloadPosition.current
      if (position?.type === state.info.documentType) {
        if (state.info.documentType === 'presentation') {
          const part = Math.min(position.part, state.info.parts.length - 1)
          state.info = (await connection.document(() => state.id).part(part)).info
        }
        setZoom(position.zoom)
        setFit(position.fit)
        retryScroll.current = { left: position.left * position.zoom / 15, top: position.top * position.zoom / 15 }
      } else setFit(state.info.documentType === 'text' ? 'width' : state.info.documentType === 'presentation' ? 'page' : undefined)
      partTarget.current = undefined
      current.current = state
      setDocument(state)
      onLoaded?.(reply.version)
    },
    [connection, tab.contentId, tab.id, tab.signal, revision],
  )
  const interaction = usePreviewInteraction({ documentType: document?.info.documentType, t, request, send, inputQueue, busy, action,
    failAction, renderFailure, playing, settling, playbackTransition, contentView: () => contentView.current })
  const interactionRef = useRef(interaction)
  interactionRef.current = interaction
  useEffect(() => {
    const close = connection.ownView(async () => {
      mounted.current = false
      const opened = opening.current
      ++openingGeneration.current
      playbackStopRequested.current = true
      try { await surface.current?.stop() }
      catch (error) { console.warn('Office display cleanup failed.', error) }
      try { await playbackTask.current }
      catch (_error) { /* The playback action already reports its failure. */ }
      try { await exitElementFullscreen(viewTarget) }
      catch (error) { console.error('Office fullscreen exit failed.', error) }
      await inputQueue.current.send(async () => {
        const reply = await opened
        if (typeof reply?.documentId === 'string') await connection.release(reply.documentId)
      }).catch((error: unknown) => { console.error('Office checkpoint release failed', error) })
    })
    if (close === undefined) return
    mounted.current = true
    action(() => open().catch(failRendering))
    const release = (): void => { void close() }
    tab.signal.addEventListener('abort', release, { once: true })
    return () => {
      tab.signal.removeEventListener('abort', release)
      release()
    }
  }, [connection, tab.signal, open, action, failRendering])
  useEffect(() => {
    const listener = (reply: OfficeViewEvent): void => {
      if (reply.documentId !== current.current?.id) return
      const event = reply.event
      if (event.kind === 'lease') {
        setLeaseOffline(!event.connected)
        return
      }
      if (event.kind === 'expired') {
        onExpiry.current?.()
        return
      }
      if (event.kind === 'channel') {
        switch (event.state) {
          case 'recovering':
            setReconnecting(true)
            return
          case 'reconnected':
            setReconnecting(false)
            // The Host stopped the slideshow when it replaced the channel.
            leavePlayback()
            setRenderStop(undefined)
            setChannelEpoch(epoch => epoch + 1)
            return
          case 'paused':
          case 'unavailable':
            setReconnecting(false)
            failRendering(new OfficeChannelError(event.state, event.message ?? ''))
            return
          /* v8 ignore next -- The connection dispatches only the channel states above. */
          default:
            assertNever(event.state)
        }
      }
      if (event.kind === 'failure') {
        failRendering(event.error)
        return
      }
      if (event.kind === 'presentation') {
        const active = current.current
        if (event.part !== active.info.part)
          update({ ...active.info, part: event.part })
        if (event.ended) action(async () => { await stopPresentation.current?.() })
        return
      }

      const payload = event.payload
      if (event.type === 0) surface.current?.invalidate(parseCallbackRectangle(payload))
      if (event.type === 33 || event.type === 50) surface.current?.headers()
      if (event.type === 13 || event.type === 14) {
        surface.current?.invalidate()
        action(() => send.info())
      }
      interactionRef.current.callback(event)
    }
    connection.listeners.add(listener)
    return () => {
      connection.listeners.delete(listener)
    }
  }, [connection, update, action, send, failRendering, leavePlayback])
  useEffect(() => {
    const doc = viewTarget.ownerDocument
    const onFullscreenChange = (): void => {
      const isHolder = doc.fullscreenElement === viewTarget
      setOccluded(isOccludedByFullscreen(viewTarget))
      if (holdingFullscreenRef.current && !isHolder) {
        action(async () => { await stopPresentation.current?.() })
      }
      holdingFullscreenRef.current = isHolder
    }
    onFullscreenChange()
    doc.addEventListener('fullscreenchange', onFullscreenChange)
    return () => { doc.removeEventListener('fullscreenchange', onFullscreenChange) }
  }, [viewTarget, action])
  useEffect(() => {
    // A hidden tab cannot show its fullscreen element; the slideshow shows in the window when the tab returns.
    if (document === undefined || tab.visible || !playingRef.current) return
    void exitElementFullscreen(viewTarget).catch((failure: unknown) => { console.error('Office fullscreen exit failed.', failure) })
  }, [document?.id, tab.visible, viewTarget])
  useEffect(() => {
    if (canvas.current !== null && playing) canvas.current.focus({ preventScroll: true })
  }, [document?.id, playing])
  useLayoutEffect(() => {
    const retained = retryScroll.current
    if (retained !== undefined && viewport.current !== null) {
      viewport.current.scrollLeft = retained.left
      viewport.current.scrollTop = retained.top
      retryScroll.current = undefined
    }
  }, [document?.id])
  useLayoutEffect(() => {
    const scroll = viewport.current
    if (!scroll || !document || !fit || playing || fitSize.width <= 1 || fitSize.height <= 1) return
    const style = getComputedStyle(scroll)
    setZoom(
      fitZoom(
        document.info,
        {
          width: fitSize.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
          height: fitSize.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom),
        },
        fit,
      ),
    )
  }, [fit, playing, fitSize.width, fitSize.height, document?.info.width, document?.info.height])
  useLayoutEffect(() => {
    const scroll = viewport.current,
      anchor = zoomAnchor.current
    if (scroll && anchor) {
      restoreZoomAnchor(scroll, zoom, anchor)
      zoomAnchor.current = undefined
    }
    surface.current?.refresh()
  }, [zoom])
  useEffect(() => {
    const scroll = viewport.current
    if (!scroll || !document || playing || !tab.visible) return
    return bindPinchZoom(
      scroll,
      () => ({ zoom: zoomRef.current, enabled: !settling.current && playbackTransition.current === undefined }),
      (next, anchor) => {
        floating.show()
        floating.scheduleHide()
        zoomAnchor.current = anchor
        setFit(undefined)
        setZoom(next)
      },
    )
  }, [document?.id, playing, tab.visible, floating.show, floating.scheduleHide])
  useEffect(() => {
    const scroll = viewport.current, target = canvas.current
    if (!scroll || !target || !document || playing || !tab.visible
      || renderFailure !== undefined) return
    return bindTouchSelection(scroll, {
      target,
      enabled: () => !tab.signal.aborted && !settling.current && playbackTransition.current === undefined,
      pointer: (touch, type) => {
        interactionRef.current.pointer({ currentTarget: target, clientX: touch.clientX, clientY: touch.clientY,
          detail: 1, buttons: 1, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, preventDefault: () => {} }, type)
      },
      release: () => {
        // Document release owns held input after unmount or tab abort.
        if (mounted.current && !tab.signal.aborted) interactionRef.current.cancelPointer()
      },
    }, { holdMs: 450, movementTolerance: 8 })
  }, [document?.id, playing, tab.visible, tab.signal, renderFailure])
  useEffect(() => {
    const scroll = viewport.current
    if (scroll === null || document?.info.documentType !== 'presentation' || playing || !tab.visible) return
    let lastWheel = -Infinity
    const navigate = (event: WheelEvent): void => {
      if (event.ctrlKey || event.metaKey || event.deltaY === 0 || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
      event.preventDefault()
      if (settling.current) return
      const now = performance.now()
      if (now - lastWheel > 300) stepPart(event.deltaY > 0 ? 1 : -1)
      lastWheel = now
    }
    scroll.addEventListener('wheel', navigate, { passive: false })
    return () => { scroll.removeEventListener('wheel', navigate) }
  }, [document?.id, document?.info.documentType, playing, tab.visible, stepPart])
  useEffect(() => {
    surface.current?.refresh()
  }, [document?.info.width, document?.info.height])
  const reload = useCallback((expired = false): void => {
    if (settling.current) return
    settling.current = true
    setBusy(true)
    action(async () => {
      try {
        if (current.current === undefined) await opening.current
        const scroll = viewport.current, state = current.current
        if (scroll !== null && state !== undefined) reloadPosition.current = {
          type: state.info.documentType, left: scroll.scrollLeft * 15 / zoom, top: scroll.scrollTop * 15 / zoom,
          part: state.info.part, zoom, fit,
        }
        if (state !== undefined) {
          let retired = expired
          if (!retired) {
            try { await stopPresentation.current?.() }
            catch (error) {
              if (remoteErrorOf(error)?.code !== 'office/document-expired') throw error
              retired = true
            }
          }
          if (retired) {
            playbackStopRequested.current = true
            leavePlayback()
          }
          const stopped = surface.current?.stop()
          current.current = undefined
          setDocument(undefined)
          interactionRef.current.reset()
          if (retired) {
            // The retired engine may reject its last paint or slideshow command.
            await Promise.allSettled([playbackTask.current, stopped])
            await inputQueue.current.send(() => connection.release(state.id, 'expired'))
              .catch((error: unknown) => { console.warn('Office expired receiver cleanup failed.', error) })
          } else {
            await stopped
            await inputQueue.current.send(() => connection.release(state.id))
          }
        }
        await open(!expired)
      } catch (error) {
        failRendering(error)
      } finally {
        settling.current = false
        setBusy(false)
        surface.current?.refresh()
      }
    })
  }, [action, connection, failRendering, leavePlayback, open, zoom, fit])
  onExpiry.current = () => { if (mounted.current && !tab.signal.aborted) reload(true) }
  useEffect(() => tab.actions.bindCommands({ refresh: reload }), [tab.actions, reload])
  const play = (): Promise<void> => {
    if (playbackTransition.current !== undefined) return playbackTask.current as Promise<void>
    if (playingRef.current || settling.current || viewport.current === null || current.current === undefined) return Promise.resolve()
    // Chromium grants fullscreen only while the click is handled, so the request precedes the slideshow start.
    const fullscreen = requestElementFullscreen(viewTarget)
    void fullscreen.catch(() => { /* awaited below */ })
    playbackTransition.current = 'starting'
    playbackStopRequested.current = false
    setTransitioningPlayback(true)
    const stopped = surface.current?.stop()
    const operation = (async () => {
      let started = false, entered = false, committed = false
      // Document visibility does not cancel: macOS hides the page while it moves the window into its fullscreen Space.
      const cancelled = (): boolean => !mounted.current || tab.signal.aborted || !visibleRef.current
        || playbackStopRequested.current
      try {
        await fullscreen
        entered = true
        await stopped
        if (cancelled()) return
        started = await inputQueue.current.send(async () => {
          const size = current.current?.info
          if (cancelled() || size === undefined) return false
          const scale = Math.min(
            (screen.width * devicePixelRatio) / size.width,
            (screen.height * devicePixelRatio) / size.height,
            4096 / size.width,
            4096 / size.height,
          )
          await request.presentation({
            action: 'start', pixelWidth: Math.min(4096, Math.round(size.width * scale)),
            pixelHeight: Math.min(4096, Math.round(size.height * scale)), part: size.part,
          })
          return true
        })
        if (!started || cancelled()) return
        playingRef.current = true
        setPlaying(true)
        setPaused(false)
        committed = true
      } finally {
        if (!committed) {
          if (started && !tab.signal.aborted) {
            try { await send.presentation({ action: 'stop' }) } catch (error) { failRendering(error) }
          }
          if (entered) {
            try { await exitElementFullscreen(viewTarget) } catch (error) { failRendering(error) }
          }
        }
        playbackTransition.current = undefined
        if (mounted.current) {
          if (!committed) setChannelEpoch(epoch => epoch + 1)
          setTransitioningPlayback(false)
        }
      }
    })()
    playbackTask.current = operation
    return operation
  }
  const playCommand = useRef<() => void>(undefined)
  playCommand.current = () => { action(play) }
  const presentation = document?.info.documentType === 'presentation'
  const playDisabled = busy || renderFailure !== undefined || transitioningPlayback
  useEffect(() => {
    if (!presentation || playing) return
    return registerPresentation?.(tab.id, { disabled: playDisabled, play: () => { (playCommand.current as () => void)() } })
  }, [registerPresentation, tab.id, presentation, playing, playDisabled])
  const stop = (): Promise<void> => {
    if (playbackTransition.current !== undefined) {
      playbackStopRequested.current = true
      return playbackTask.current as Promise<void>
    }
    if (!playingRef.current) return Promise.resolve()
    playbackTransition.current = 'stopping'
    setTransitioningPlayback(true)
    const stopped = surface.current?.stop()
    const operation = (async () => {
      let nativeStopped = false
      try {
        try { await stopped } finally {
          try {
            const part = (current.current as DocumentState).info.part
            await send.presentation({ action: 'stop' })
            nativeStopped = true
            playingRef.current = false
            // Slideshow navigation does not select the native preview's current slide.
            try { await send.part(part) }
            catch (error) { failRendering(error); throw error }
          }
          finally { await exitElementFullscreen(viewTarget) }
        }
      } finally {
        if (nativeStopped) {
          playingRef.current = false
          setPlaying(false)
          setPaused(false)
          interactionRef.current.focus()
        }
        playbackTransition.current = undefined
        if (mounted.current) setTransitioningPlayback(false)
      }
    })()
    playbackTask.current = operation
    return operation
  }
  stopPresentation.current = stop
  const reconnect = async (): Promise<void> => {
    if (settling.current) return
    const id = openDocumentId()
    settling.current = true
    setBusy(true)
    try {
      // The outcome, including a refusal, reaches this view as a channel event.
      await inputQueue.current.send(() => connection.recover(id, 'user')).catch((_error: unknown) => { /* reported as a channel event */ })
    } finally {
      settling.current = false
      setBusy(false)
    }
  }
  const onKey = (event: KeyboardEvent): void => {
    if (presenting && (event.key === 'Tab' || event.key === 'Escape')) return
    event.stopPropagation()
    if (!interaction.isInputTarget(event.target) && event.target !== canvas.current && event.target !== viewport.current) return
    if (playbackTransition.current !== undefined) {
      event.preventDefault()
      if (event.key === 'Escape') action(stop)
      return
    }
    if (settling.current || renderFailure !== undefined) {
      event.preventDefault()
      return
    }
    if (playing) {
      event.preventDefault()
      if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(event.key)) action(() => send.presentation({ action: 'previous' }))
      else if ([' ', 'ArrowRight', 'ArrowDown', 'Enter', 'PageDown'].includes(event.key))
        action(() => send.presentation({ action: 'next' }))
      return
    }
    if (event.nativeEvent.isComposing) return
    if (document?.info.documentType === 'presentation' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
      && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault()
      stepPart(event.key === 'ArrowLeft' ? -1 : 1)
      return
    }
    interaction.key(event)
  }
  const button = (key: OfficeAction, onClick: () => Promise<unknown>, disabled = false, active?: boolean): ReactNode => (
    <ToolbarButton
      key={key === 'resume' ? 'pause' : key}
      action={key}
      label={t(key)}
      disabled={disabled || busy}
      active={active}
      onClick={() => {
        action(onClick)
      }}
    />
  )
  const hasPartTabs = !playing && (document?.info.documentType === 'spreadsheet' || document?.info.documentType === 'presentation')
  const displayedFailure = renderFailure ?? failure
  useModalLayer(editor, presenting, () => { action(stop) })
  return (
    <>
      <div ref={viewMount} className={css.viewMount} />
      {createPortal(<div ref={editor} className={`${css.editor} ${playing ? css.playing : ''}`} onKeyDown={onKey}
        role={presenting ? 'dialog' : undefined} aria-modal={presenting ? true : undefined}
        aria-label={presenting ? t('playbackControls') : undefined}>
        {displayedFailure !== undefined && (
          <div className={css.error} role="alert">
            {t(renderStop?.kind === 'paused' ? 'channelPaused' : 'failure', { message: displayedFailure })}
            {document === undefined && button('retry', () => open())}
            {document !== undefined && renderStop?.kind === 'paused' && button('reconnect', reconnect)}
            {renderFailure !== undefined && failure !== undefined && <span>{t('failure', { message: failure })}</span>}
          </div>
        )}
        {(reconnecting || leaseOffline) && displayedFailure === undefined && <div className={css.notice} role="status">{t('reconnecting')}</div>}
        {waitingForFrames && displayedFailure === undefined && <div className={css.notice} role="status">{t('waitingForFrames')}</div>}
        {document === undefined ? (
          displayedFailure === undefined && <div className={css.opening} role="status" data-document-loading>
            <StateDot state="ongoing" size={28} />
            <span>{t(loadingStage === undefined ? 'loading' : loadingStage === 'fonts' ? 'loadingFonts' : loadingStage === 'engine' ? 'loadingEngine' : 'loadingDocument')}</span>
          </div>
        ) : (
          <div className={`${css.documentArea} ${document.info.documentType === 'spreadsheet' && !playing ? css.sheet : ''}`}
            id={hasPartTabs ? partPanelId : undefined}
            role={hasPartTabs ? 'tabpanel' : undefined}
            aria-labelledby={hasPartTabs ? `${partPanelId}-sheet-${document.info.part}` : undefined}
            data-office-document-area onPointerMove={(event) => {
              const controls = playbackControls.current
              // Replaced playback icons can detach before their pointer-leave event reaches React.
              if (controls !== null) floating.onActiveChange(
                (event.target instanceof Node && controls.contains(event.target)) || controls.contains(globalThis.document.activeElement),
              )
              floating.onPointerMove(event)
            }} onPointerLeave={floating.onPointerLeave}>
            {pagination.length === 0 && initialPaint && displayedFailure === undefined && !waitingForFrames && <div className={css.painting} role="status">
              <StateDot state="ongoing" size={28} />
              <span>{t('loadingPaint')}</span>
            </div>}
            {document.info.documentType === 'spreadsheet' && !playing && (
              <>
                <button type="button" className={css.headerCorner} aria-label={t('selectSheet')} onClick={() => { interaction.selectHeader() }} />
                <div className={css.columnHeaders} onClick={interaction.headerClick}>
                  <div ref={columnHeaders} />
                </div>
                <div className={css.rowHeaders} onClick={interaction.headerClick}>
                  <div ref={rowHeaders} />
                </div>
              </>
            )}
            <div
              className={`${css.viewport} ${document.info.documentType === 'presentation' && !playing ? css.slideViewport : ''}`}
              ref={viewport}
              data-office-viewport
              tabIndex={document.info.documentType === 'presentation' && !playing ? 0 : undefined}
              onPointerDown={(event) => {
                if (document.info.documentType === 'presentation' && !playing) event.currentTarget.focus({ preventScroll: true })
              }}
            >
              <div
                className={css.document}
                ref={documentElement}
                style={{
                  width: playing ? '100%' : Math.max(1, (document.info.width * zoom) / 15),
                  height: playing ? '100%' : Math.max(1, (document.info.height * zoom) / 15),
                }}
              >
                <div ref={previewLayer} className={css.pagePreviews} hidden={playing} />
                {!playing && displayedFailure === undefined && !waitingForFrames
                  && pagination.filter(page => initialPaint && !readyPages.has(page.index)
                    && (page.part === undefined || page.part === document.info.part)).map(page => (
                    <div key={page.index} className={css.pageLoading} role="status"
                      data-office-page-loading={page.index} style={{ left: page.x * zoom / 15, top: page.y * zoom / 15,
                        width: page.width * zoom / 15, height: page.height * zoom / 15 }}>
                      <StateDot state="ongoing" size={28} />
                      <span>{t('loadingPaint')}</span>
                    </div>
                  ))}
                <div
                  className={css.surface}
                  hidden={!tab.visible || occluded}
                  style={{
                    width: playing ? '100%' : Math.min(viewportSize.width, (document.info.width * zoom) / 15),
                    height: playing ? '100%' : Math.min(viewportSize.height, (document.info.height * zoom) / 15),
                  }}
                >
                  <DocumentSurface document={document} connection={connection} channelEpoch={channelEpoch}
                    playing={playing} suspended={transitioningPlayback || leaseOffline} failed={renderFailure !== undefined}
                    visible={tab.visible && !occluded} zoom={zoom} viewport={viewport} documentElement={documentElement}
                    previewLayer={previewLayer} rows={rowHeaders} columns={columnHeaders} contentView={contentView}
                    controls={surface} send={send} paint={paint} failure={failRendering} waiting={setWaitingForFrames}
                    initial={setInitialPaint} pageReady={pageReady} size={measureSize} t={t} />
                  <canvas
                    key={playing ? 'presentation' : 'input'}
                    className={css.canvas}
                    data-waiting={(playing && waitingForFrames) || undefined}
                    style={{ cursor: interaction.cursor }}
                    ref={canvas}
                    tabIndex={0}
                    aria-label={t('editor')}
                    onPointerDown={(event) => {
                      if (event.pointerType !== 'touch') event.currentTarget.setPointerCapture(event.pointerId)
                    }}
                    onPointerCancel={(event) => { if (event.pointerType !== 'touch') interaction.cancelPointer() }}
                    onLostPointerCapture={(event) => { if (event.pointerType !== 'touch') interaction.cancelPointer() }}
                    onMouseDown={(event) => {
                      interaction.pointer(event, 0)
                    }}
                    onMouseUp={(event) => {
                      if (playing) action(() => send.presentation({ action: 'next' }))
                      else interaction.pointer(event, 1)
                    }}
                    onMouseMove={(event) => {
                      interaction.pointer(event, 2)
                    }}
                  />
                </div>
                {!playing && document.info.documentType === 'text' && <PageGaps pages={pagination} />}
                <div data-office-interaction-overlay style={{ opacity: initialPaint && !playing ? 0 : 1 }}>
                  {interaction.overlay}
                </div>
              </div>
            </div>
            {!playing && <ZoomControls
              className={css.viewControls} zoom={zoom} visible={floating.visible}
              labels={{ controls: t('viewControls'), menu: t('zoom'), out: t('zoomOut'), into: t('zoomIn'),
                value: percent => t('zoomValue', { percent }) }}
              fit={document.info.documentType === 'spreadsheet' ? undefined : {
                label: t(document.info.documentType === 'text' ? 'fitWidth' : 'fitPage'), selected: fit !== undefined,
                onSelect: () => {
                  if (!settling.current) setFit(document.info.documentType === 'text' ? 'width' : 'page')
                },
              }}
              onZoom={(value) => {
                if (!settling.current) { setFit(undefined); setZoom(value) }
              }} onActiveChange={floating.onActiveChange} />}
            {playing && <div ref={playbackControls} className={css.playbackControls} role="toolbar" aria-label={t('playbackControls')}
              data-visible={floating.visible}
              onPointerEnter={() => { floating.onActiveChange(true) }}
              onPointerLeave={(event) => {
                if (!event.currentTarget.contains(globalThis.document.activeElement)) floating.onActiveChange(false)
              }}
              onFocusCapture={() => { floating.onActiveChange(true) }}
              onBlurCapture={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(':hover')) floating.onActiveChange(false)
              }}>
              {button('previous', () => send.presentation({ action: 'previous' }))}
              {button('next', () => send.presentation({ action: 'next' }))}
              {button(paused ? 'resume' : 'pause', async () => {
                await send.presentation({ action: 'pause', paused: !paused })
                setPaused(!paused)
              })}
              {button('stop', stop)}
            </div>}
          </div>
        )}
        {hasPartTabs && (
          <SheetTabs
            parts={document.info.parts}
            selected={document.info.part}
            panelId={partPanelId}
            label={t(document.info.documentType === 'spreadsheet' ? 'sheet' : 'slide')}
            listLabel={t(document.info.documentType === 'spreadsheet' ? 'sheetList' : 'slideList')}
            onSelect={selectPart}
          />
        )}
      </div>, viewTarget)}
    </>
  )
}
