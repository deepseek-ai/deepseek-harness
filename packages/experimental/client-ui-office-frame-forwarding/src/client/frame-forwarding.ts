/** Office ownership of a document and slideshow video mounts. */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { FrameContentView, FrameRx } from '@deepseek-ai/dsh-frame-forwarding/client'
import type { FrameForwardingViewport } from '@deepseek-ai/dsh-frame-forwarding/types'
import type { OfficeDocumentStatus, OfficePresentationControl } from '../types.ts'

/** A mounted operation did not complete within the document's frame deadline. */
export class OfficeFrameTimeoutError extends Error {
  /** @param message - Which bounded wait expired. */
  constructor(message: string) { super(message); this.name = 'OfficeFrameTimeoutError' }
}

/** Producer controls scoped to a single slideshow mount and its receive channel. */
export type OfficePlaybackControl = Extract<OfficePresentationControl, { action: 'resize' | 'stream' }>

/** A slideshow stream owns its video mount until stop settles. */
export interface FrameForwardingOfficePlayback {
  /** Resolves after enable is acknowledged or skipped because the mount was retired. */
  ready: Promise<void>
  /** @param width - Physical width. @param height - Physical height. @returns Resize acknowledgement. */
  resize(width: number, height: number): Promise<void>
  /** @returns Idempotent completion of stream shutdown and unmount. */
  stop(): Promise<void>
}

/** One receive channel bound to one producer; FrameRx alone owns viewport versions. */
export class FrameForwardingOfficeSession {
  private unmount: (() => void) | undefined
  private mountFailure: Error | undefined
  private closing: Promise<void> | undefined
  private mountVersion = 0
  private surfaceVisible = true
  private trimming = false
  private detachPlayback: (() => void) | undefined

  /** @param rx - Connected document channel. @param frameTimeoutMs - Readiness and visibility deadline. */
  constructor(readonly rx: FrameRx, readonly frameTimeoutMs: number) {}

  private syncVisible(): void {
    if (this.unmount !== undefined) this.rx.setVisible(this.surfaceVisible && !this.trimming)
  }

  /** Attach the document's single image viewport; callers stop admitted paints before detaching.
   * @param element - Video mount element.
   * @param failure - Reports terminal mount failure.
   * @param visible - Initial explicit visibility of the view.
   * @returns Idempotent unmount.
   */
  mount(element: HTMLElement, failure: (error: Error) => void, visible = true): () => void {
    if (this.unmount !== undefined) throw new Error('Office document already has a mount.')
    this.mountFailure = undefined
    this.surfaceVisible = visible
    this.mountVersion = this.rx.viewport?.version ?? 0
    let detach = (): void => {}
    const stop = (): void => {
      if (this.unmount !== stop) return
      this.unmount = undefined
      detach()
    }
    this.unmount = stop
    try {
      detach = this.rx.mount(element, (error) => {
        this.mountFailure = error
        stop()
        failure(error)
      }, { visible: this.surfaceVisible && !this.trimming })
    } catch (error) { stop(); throw error }
    return stop
  }

  /** Update the mounted view's explicit visibility; calls without a mount have no effect.
   * @param visible - Whether the view is visible to the user (tab visible and not covered by fullscreen).
   */
  setVisible(visible: boolean): void {
    this.surfaceVisible = visible
    this.syncVisible()
  }

  /** Update the mounted document mapping; calls without a mount have no effect.
   * @param view - Latest document mapping, including while the engine has failed.
   */
  setContentView(view: FrameContentView): void { if (this.unmount !== undefined) this.rx.setContentView(view) }

  /** Await the mounted viewport and producer readiness within the frame deadline. Mount failures reject with the original error.
   * @param signal - Cancels the wait when the caller retires the mount.
   * @returns Completion after the producer acknowledges the viewport or the viewport wait is cancelled.
   */
  async ready(signal?: AbortSignal): Promise<void> {
    const viewport = await this.waitViewport(viewport => viewport.version > this.mountVersion, signal)
    if (viewport === undefined) return
    const deadline = AbortSignal.timeout(this.frameTimeoutMs)
    await this.rx.ready(signal === undefined ? deadline : AbortSignal.any([deadline, signal]))
  }

  /** Reclaim producer surfaces through an acknowledged invisible viewport, then restore explicit visibility.
   * @param signal - Cancels the viewport and producer waits when the mount retires.
   * @returns Completion after the visibility change is acknowledged or the wait ends.
   */
  async trim(signal?: AbortSignal): Promise<void> {
    if (this.unmount === undefined) return
    const acknowledged = this.waitViewport(viewport => !viewport.visible, signal)
    this.trimming = true
    this.syncVisible()
    try {
      if (await acknowledged !== undefined) await this.ready(signal)
    } finally {
      this.trimming = false
      this.syncVisible()
    }
  }

  private waitViewport(
    accept: (viewport: FrameForwardingViewport) => boolean, signal?: AbortSignal,
  ): Promise<FrameForwardingViewport | undefined> {
    if (this.mountFailure !== undefined) return Promise.reject(this.mountFailure)
    if (signal?.aborted) return Promise.resolve(undefined)
    const current = this.rx.viewport
    if (current !== undefined && accept(current)) return Promise.resolve(current)
    const wait = Promise.withResolvers<FrameForwardingViewport | undefined>()
    const onAbort = (): void => {
      if (this.mountFailure !== undefined) wait.reject(this.mountFailure)
      else wait.resolve(undefined)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    const remove = this.rx.onEvent((event) => {
      if (event.kind === 'viewport' && accept(event.viewport)) wait.resolve(event.viewport)
      else if (event.kind === 'failure' || (event.kind === 'state' && event.channel.state === 'closed'))
        wait.reject(this.mountFailure ?? new Error('Office mount closed.'))
    })
    const timer = setTimeout(() => { wait.reject(new OfficeFrameTimeoutError('Office viewport timed out.')) }, this.frameTimeoutMs)
    return wait.promise.finally(() => {
      clearTimeout(timer)
      remove()
      signal?.removeEventListener('abort', onAbort)
    })
  }

  /** Mount video in a pre-sized, aspect-ratio-preserving slideshow element.
   * @param element - Letterboxed slideshow rectangle.
   * @param send - Queues controls for this channel. Aborting the mount skips a queued enable or resize.
   * @param failure - Terminal mount/stream failure.
   * @param waiting - First video image deadline state.
   * @param visible - Initial explicit visibility of the slideshow view.
   * @returns Stream whose stop releases the video mount before document rendering resumes.
   */
  startPlayback(element: HTMLElement,
    send: (control: OfficePlaybackControl, signal?: AbortSignal) => Promise<OfficeDocumentStatus | undefined>,
    failure: (error: Error) => void, waiting: (value: boolean) => void, visible = true): FrameForwardingOfficePlayback {
    const detach = this.mount(element, failure, visible), streamId = randomUUID()
    const lifetime = new AbortController()
    let needsDisable = false, received = false, stopping: Promise<void> | undefined, generation = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    const loaded = (): void => { received = true; clearTimeout(timer); waiting(false) }
    element.addEventListener('loadeddata', loaded, true)
    const ready = (async () => {
      try { await this.ready(lifetime.signal) }
      catch (error) {
        if (lifetime.signal.aborted && this.mountFailure === undefined) return
        throw error
      }
      if (lifetime.signal.aborted) return
      const viewport = this.rx.viewport as FrameForwardingViewport
      generation = viewport.version
      // A rejected enable may already have reached the producer. A skipped enable needs no matching disable.
      needsDisable = true
      needsDisable = await send({ action: 'stream', enabled: true, streamId, generation }, lifetime.signal) !== undefined
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- stop() and loadeddata can run during the stream await.
      if (!lifetime.signal.aborted && !received) timer = setTimeout(() => { waiting(true) }, this.frameTimeoutMs)
    })()
    const retire = (): void => {
      if (this.detachPlayback === retire) this.detachPlayback = undefined
      lifetime.abort()
      clearTimeout(timer)
      element.removeEventListener('loadeddata', loaded, true)
      detach()
    }
    this.detachPlayback = retire
    return {
      ready,
      resize: async (pixelWidth, pixelHeight) => {
        await ready
        if (!lifetime.signal.aborted) await send({ action: 'resize', pixelWidth, pixelHeight }, lifetime.signal)
      },
      stop: () => {
        retire()
        return stopping ??= ready.catch((_error: unknown) => { /* Start failure is reported by its caller. */ }).then(async () => {
          if (needsDisable && this.closing === undefined) await send({ action: 'stream', enabled: false, streamId, generation })
        })
      },
    }
  }

  /** Detach the mount and close its stream and receive channel once; repeated calls share completion.
   * @returns Receive-channel closure. Queued playback controls may themselves be waiting for channel replacement.
   */
  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    const completion = Promise.withResolvers<void>()
    this.closing = completion.promise
    this.detachPlayback?.()
    this.unmount?.()
    void this.rx.close().then(completion.resolve, completion.reject)
    return this.closing
  }
}
