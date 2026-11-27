import type { FrameForwardingViewport } from '../types.ts'
import type { FrameContentWindow, FrameForwardingFrame, FrameRxEvent } from './api.ts'
import type { ContentState } from './content.ts'
import { FrameDiscardedError, FrameFailureError } from './errors.ts'
import { createMediaPresenter, type MediaPresenter } from './presenters.ts'

interface MountOwner {
  content(): ContentState | undefined
  viewport(value: Omit<FrameForwardingViewport, 'version'>, completion: Promise<FrameForwardingViewport>): Promise<FrameForwardingViewport>
  report(event: FrameRxEvent): void
  failure(error: Error): void
}

/** Mount-owned display resources, observed through FrameRx's stream and explicit visibility. */
export interface ElementMount {
  readonly submittedWindow: FrameContentWindow | undefined
  present(frame: FrameForwardingFrame): void | Promise<void>
  dirty(): void
  /** Update the caller-declared visibility of this mount and schedule a viewport refresh. */
  setVisible(visible: boolean): void
  /** Push the current content snapshot synchronously, before submitting its viewport. */
  pushContent(): void
  /** Queue a window change behind the in-flight viewport.
   * @returns The latest-only acknowledgement shared by unsent requests; rejects when this display ends.
   */
  requestViewport(): Promise<FrameForwardingViewport>
  /**
   * Stop the display's observers and media track.
   * @param reason - Why the display ended; viewport requests not yet acknowledged reject with it, or with
   *   {@link FrameDiscardedError} `cancelled` when it is omitted.
   */
  dispose(reason?: Error): void
}

/** Mount a channel without taking ownership of the channel itself.
 * @param element - Container for the video.
 * @param owner - Channel-owned viewport, state and error callbacks.
 * @param initialVisible - Initial caller-declared visibility; defaults to `true`.
 * @returns A display whose disposal cancels observers and stops the media track.
 */
export function mountElement(element: HTMLElement, owner: MountOwner, initialVisible = true): ElementMount {
  const document = element.ownerDocument
  const view = document.defaultView
  if (view === null) throw new FrameFailureError('presentation', 'The frame mount needs a live document.')
  if (element.hasAttribute('data-dsh-frame-mount')) throw new Error('Native element already has a frame consumer.')
  let disposed = false
  let explicitVisible = initialVisible
  let raf: number | undefined
  let intersecting = false
  let media: MediaPresenter | undefined
  let viewportKey: string | undefined
  let viewportPending: ReturnType<typeof Promise.withResolvers<FrameForwardingViewport>> | undefined
  let requestedViewport: ReturnType<typeof Promise.withResolvers<FrameForwardingViewport>> | undefined
  let latestViewport: Parameters<MountOwner['viewport']>[0] | undefined
  const position = element.style.getPropertyValue('position')
  const isolation = element.style.getPropertyValue('isolation')
  const positionPriority = element.style.getPropertyPriority('position')
  const isolationPriority = element.style.getPropertyPriority('isolation')
  const computedPosition = getComputedStyle(element).position
  const changePosition = computedPosition === 'static' || computedPosition === ''
  const dirty = (): void => {
    if (!disposed && raf === undefined) raf = view.requestAnimationFrame(flush)
  }
  const setVisible = (visible: boolean): void => {
    if (explicitVisible === visible) return
    explicitVisible = visible
    dirty()
  }
  const resize = new ResizeObserver(dirty)
  const intersection = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.target === element) intersecting = entry.isIntersecting
    dirty()
  })
  const restore = (property: string, value: string, priority: string): void => {
    if (value === '') element.style.removeProperty(property)
    else element.style.setProperty(property, value, priority)
  }
  const dispose = (reason?: Error): void => {
    if (disposed) return
    disposed = true
    const ended = reason ?? new FrameDiscardedError('cancelled')
    requestedViewport?.reject(ended)
    requestedViewport = undefined
    viewportPending?.reject(ended)
    if (raf !== undefined) view.cancelAnimationFrame(raf)
    resize.disconnect()
    intersection.disconnect()
    document.removeEventListener('visibilitychange', visibilityChanged)
    view.removeEventListener('resize', dirty)
    media?.dispose()
    media = undefined
    element.removeAttribute('data-dsh-frame-mount')
    if (changePosition) restore('position', position, positionPriority)
    restore('isolation', isolation, isolationPriority)
    owner.report({ kind: 'content', submittedGeneration: undefined })
  }
  const fail = (error: unknown): void => {
    if (disposed) return
    const failure = error instanceof Error ? error : new FrameFailureError('presentation', String(error))
    try { dispose(failure) } catch (cleanupError) { console.error('Frame mount cleanup failed', cleanupError) }
    owner.failure(failure)
  }
  const sendViewport = (): boolean => {
    if (disposed || viewportPending !== undefined || latestViewport === undefined) return false
    const viewport = latestViewport
    const key = JSON.stringify(viewport)
    if (viewportKey === key && requestedViewport === undefined) return false
    const completion = requestedViewport ?? Promise.withResolvers<FrameForwardingViewport>()
    requestedViewport = undefined
    viewportKey = key
    viewportPending = completion
    void completion.promise.catch((error: unknown) => { fail(error) }).finally(() => {
      viewportPending = undefined
      if (disposed) return
      if (requestedViewport !== undefined || document.visibilityState === 'hidden') sendViewport()
      else if (JSON.stringify(latestViewport) !== viewportKey) dirty()
    })
    try { void owner.viewport(viewport, completion.promise).then(completion.resolve, completion.reject) }
    catch (error) { completion.reject(error) }
    return true
  }
  const pushContent = (): void => { media?.setContent(owner.content()) }
  const requestViewport = (): Promise<FrameForwardingViewport> => {
    if (disposed) return Promise.reject(new FrameDiscardedError('cancelled'))
    const completion = requestedViewport ??= Promise.withResolvers<FrameForwardingViewport>()
    try { synchronize() } catch (error) { completion.reject(error); fail(error) }
    return completion.promise
  }
  const synchronize = (): void => {
    // The display exists before the first viewport goes out, so a frame answering that viewport has somewhere to go.
    media ??= createMediaPresenter(element, fail, (submittedGeneration) => { owner.report({ kind: 'content', submittedGeneration }) })
    const rect = element.getBoundingClientRect()
    const deviceScaleFactor = view.devicePixelRatio
    const visible = explicitVisible && element.isConnected && intersecting && document.visibilityState === 'visible'
      && rect.width > 0 && rect.height > 0
    if (visible) media.resume()
    latestViewport = { width: Math.max(1, Math.round(rect.width * deviceScaleFactor)),
      height: Math.max(1, Math.round(rect.height * deviceScaleFactor)), deviceScaleFactor, visible }
    if (!sendViewport()) pushContent()
  }
  const visibilityChanged = (): void => {
    if (disposed) return
    if (document.visibilityState !== 'hidden') { dirty(); return }
    // Hidden documents may suspend rAF; the final invisible update must still let the producer trim its surfaces.
    try { synchronize() } catch (error) { fail(error) }
  }
  function flush(): void {
    raf = undefined
    if (disposed) return
    try {
      synchronize()
    } catch (error) { fail(error) }
  }
  try {
    element.setAttribute('data-dsh-frame-mount', 'video')
    if (changePosition) element.style.position = 'relative'
    element.style.isolation = 'isolate'
    resize.observe(element)
    intersection.observe(element)
    document.addEventListener('visibilitychange', visibilityChanged)
    view.addEventListener('resize', dirty)
    dirty()
  } catch (error) { dispose(); throw error }
  return {
    get submittedWindow() { return media?.submittedWindow },
    present: frame => media?.present(frame), dirty, setVisible, pushContent, requestViewport, dispose,
  }
}
