/**
 * Renderer half of one receive channel: viewport ordering, the newest-first stream,
 * readiness, mounted video presentation, and every frame's release.
 */
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { validateView, validateWindow } from './content.ts'
import type { ContentState } from './content.ts'
import { mountElement } from './element-mount.ts'
import type { ElementMount } from './element-mount.ts'
import { FrameDiscardedError, FrameFailureError } from './errors.ts'
import type { FrameChannelCloseCause, FrameChannelState, FrameConnectionId, FrameForwardingViewport, FrameRxId } from '../types.ts'
import type {
  FrameContentView, FrameContentWindow, FrameForwardingBridge, FrameForwardingFrame, FrameForwardingFrameLease,
  FrameMountOptions, FrameRxEvent,
} from './api.ts'

interface FrameStream {
  readonly present: (frame: FrameForwardingFrame) => void | Promise<void>
  readonly failure: (error: Error) => void
}
interface ReadyWaiter {
  resolve(connectionId: FrameConnectionId): void
  reject(error: Error): void
}

function sameWindow(left: FrameContentWindow | undefined, right: FrameContentWindow): boolean {
  return left !== undefined && left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height
}

function errorOf(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Renderer ownership of one Host-opened channel and its single producer connection. Every frame it holds is an
 * unreleased Host delivery, so the Host's per-channel frame limit bounds it; a frame is released once its consumer
 * callback settles or as soon as nothing waits for it.
 */
export class FrameRx {
  private readonly detach: () => void
  private failure: Error | undefined
  private channel: FrameChannelState | undefined
  private readonly readyWaiters = new Set<ReadyWaiter>()
  private closing: Promise<void> | undefined
  private viewportVersion = 0
  private viewportState: FrameForwardingViewport | undefined
  private viewportReady: Promise<void> = Promise.resolve()
  private contentView: FrameContentView | undefined
  private contentWindow: FrameContentWindow | undefined
  private contentWindows: ContentState['windows'] = []
  private contentRequest: Promise<FrameForwardingViewport> | undefined
  private submittedGeneration: number | undefined
  private mountStop: ((error?: Error) => void) | undefined
  private mounted: ElementMount | undefined
  private stream: FrameStream | undefined
  private streamPending: FrameForwardingFrameLease | undefined
  private streamDrain: Promise<void> | undefined
  private readonly eventListeners = new Set<(event: FrameRxEvent) => void>()
  private readonly eventTasks: (() => void)[] = []
  private deliveringEvents = false
  private eventsEnded = false
  private readonly end = Promise.withResolvers<FrameChannelCloseCause>()
  /**
   * Settles once, never rejecting, when this receive channel stops routing frames: with the Host's close cause, with
   * `failed` after a renderer-side failure, including termination of the Client's channel-event stream, or with
   * `closed` after {@link close}. A consumer learns from it that a `lost` channel
   * needs replacing.
   */
  readonly closed: Promise<FrameChannelCloseCause> = this.end.promise

  /**
   * @param rx - Host-issued channel identity.
   * @param bridge - Renderer-scoped frame transport.
   */
  constructor(readonly rx: FrameRxId, private readonly bridge: FrameForwardingBridge) {
    this.detach = bridge.attach(rx, {
      onFrame: (lease) => { this.arrive(lease) },
      onEvent: (event) => { this.channelEvent(event) },
    })
  }

  /** The connected producer connection, or undefined while the channel has none. */
  get connectionId(): FrameConnectionId | undefined {
    return this.channel?.state === 'connected' ? this.channel.connectionId : undefined
  }

  /**
   * Invalidate frames of older versions, then send a new viewport; the Host applies it once the producer connects.
   * @param viewport - Strictly newer viewport version; rejected while mount owns the viewport.
   * @returns Completion once the connected producer acknowledged it or, without one, once the Host kept it. Rejects
   *   with {@link FrameDiscardedError} `closed` when this receive channel closed before sending it; with an Error naming
   *   the version the Host kept when this version does not exceed it, as on a channel connected again after a renderer
   *   reload; or with the Host's error when the producer refuses it or does not acknowledge it in time. Later viewports
   *   are still sent.
   */
  setViewport(viewport: FrameForwardingViewport): Promise<void> {
    this.assertOpen()
    if (this.mountStop !== undefined) throw new Error('Native viewport is managed by mount.')
    return this.updateViewport(viewport).then(() => {})
  }

  /** Content window of the frame last written to the mounted video track, or undefined in fill mode or without a submitted image. */
  get submittedWindow(): FrameContentWindow | undefined { return this.mounted?.submittedWindow }

  /** Latest viewport submitted by mount or setViewport; its version is the generation to request from the producer. */
  get viewport(): FrameForwardingViewport | undefined { return this.viewportState }

  /**
   * Update the explicit visibility of the active mount.
   * @param visible - Whether the mounted view is currently visible to the user.
   * @throws Error outside a mount.
   */
  setVisible(visible: boolean): void {
    if (this.mounted === undefined) throw new Error('Frame visibility requires mount.')
    this.mounted.setVisible(visible)
  }

  /**
   * Set the latest content origin and scale; geometry flushes coalesce changes. Undefined restores fill mode.
   * @param view - Content coordinates within ±2^24 and CSS pixels per unit in (0, 64].
   * @throws TypeError for non-finite or out-of-range values; Error outside a mount. Invalid values send nothing.
   */
  setContentView(view: FrameContentView | undefined): void {
    if (this.mounted === undefined) throw new Error('Frame content requires mount.')
    if (view !== undefined) validateView(view)
    this.contentView = view === undefined ? undefined : { ...view }
    this.mounted.dirty()
  }

  /**
   * Bind a render window to a new viewport generation. Call only after the preceding paint resolves; this method
   * serializes viewport updates, not paints. Unsent requests coalesce to the latest window. An in-flight mount
   * viewport completes first; the returned viewport includes this window (or the latest coalesced request).
   * The window snapshot reaches the mounted presenter before its viewport reaches Host.
   * @param window - Content rectangle; coordinates within ±2^24, extents in (0, 2^24].
   * @returns The acknowledged viewport to use as paint generation, or the current acknowledged viewport for an
   *   unchanged window. Rejections match mount viewport updates; when the mount ends before the Host acknowledges,
   *   the request rejects with the error that ended the mount, such as {@link FrameDiscardedError} `lost` for a lost
   *   channel, or with `cancelled` when the consumer unmounted.
   * @throws TypeError for invalid numeric values, synchronously without messages; Error outside a mount.
   */
  setContentWindow(window: FrameContentWindow): Promise<FrameForwardingViewport> {
    if (this.mounted === undefined) throw new Error('Frame content requires mount.')
    validateWindow(window)
    if (sameWindow(this.contentWindow, window) && this.contentRequest !== undefined) return this.contentRequest
    const desired = this.contentWindow = { ...window }
    const request = this.mounted.requestViewport()
    if (this.contentWindow === desired) this.contentRequest = request
    return request
  }

  private contentSnapshot(): ContentState | undefined {
    return this.contentView === undefined || this.contentWindows.length === 0 ? undefined
      : { view: this.contentView, windows: this.contentWindows }
  }

  private mountViewport(
    value: Omit<FrameForwardingViewport, 'version'>, completion: Promise<FrameForwardingViewport>,
  ): Promise<FrameForwardingViewport> {
    this.contentRequest = completion
    return this.automaticViewport(value, (viewport) => {
      if (this.contentWindow !== undefined) {
        const current = this.contentWindows.at(-1)
        // A viewport-only version replaces current; only a different content rectangle advances previous.
        const previous = sameWindow(current, this.contentWindow) ? this.contentWindows.at(-2) : current
        this.contentWindows = [...previous === undefined ? [] : [previous], { ...this.contentWindow, generation: viewport.version }]
      }
      this.mounted?.pushContent()
    })
  }

  private automaticViewport(
    value: Omit<FrameForwardingViewport, 'version'>, beforeSend?: (viewport: FrameForwardingViewport) => void,
  ): Promise<FrameForwardingViewport> {
    return this.updateViewport({ ...value, version: this.viewportVersion + 1 }, beforeSend ?? (() => {}))
  }

  /** Document frames older than the submitted generation are stale, so the display never moves back. */
  private acceptsGeneration(generation: number): boolean {
    const content = this.contentSnapshot()
    if (content === undefined) return generation === this.viewportVersion
    return (this.submittedGeneration === undefined || generation >= this.submittedGeneration)
      && content.windows.some(window => window.generation === generation)
  }

  private updateViewport(
    initial: FrameForwardingViewport, automatic?: (viewport: FrameForwardingViewport) => void,
  ): Promise<FrameForwardingViewport> {
    if (initial.version <= this.viewportVersion) throw new Error('Native viewport version must increase.')
    const publish = (viewport: FrameForwardingViewport): void => {
      this.viewportVersion = viewport.version
      this.viewportState = viewport
      automatic?.(viewport)
      this.discardPending(true)
      this.deliverEvent({ kind: 'viewport', viewport }, false, false)
    }
    const sent = this.viewportReady.then(async () => {
      // A newer consumer of the same channel may own its viewport once this one closed.
      this.assertOpen()
      let viewport = initial
      let result = await this.bridge.setViewport(this.rx, viewport)
      // A new renderer can mount before its first snapshot, or while the producer still acknowledges an older viewport.
      if (!result.applied && result.reason === 'stale-viewport' && automatic !== undefined && this.viewportState === initial) {
        this.assertOpen()
        viewport = { ...initial, version: result.currentVersion + 1 }
        publish(viewport)
        result = await this.bridge.setViewport(this.rx, viewport)
      }
      if (!result.applied && result.reason === 'stale-viewport') throw new Error(`Native viewport version must increase past ${result.currentVersion}.`)
      return viewport
    })
    // Viewports reach the Host in order; a rejection fails only its own call, and the Host keeps the channel open.
    this.viewportReady = sent.then(() => {}, () => {})
    publish(initial)
    return sent
  }

  /**
   * Wait until the producer is connected and has acknowledged this channel's latest viewport.
   * @param signal - Cancels the wait.
   * @returns The ready connection. Rejects with {@link FrameDiscardedError} on cancellation or close, or with the
   *   channel's failure.
   */
  ready(signal?: AbortSignal): Promise<FrameConnectionId> {
    this.assertOpen()
    const current = this.readyConnection()
    if (current !== undefined) return Promise.resolve(current)
    if (signal?.aborted === true) return Promise.reject(new FrameDiscardedError('cancelled'))
    return new Promise<FrameConnectionId>((resolve, reject) => {
      const abort = (): void => {
        this.readyWaiters.delete(waiter)
        reject(new FrameDiscardedError('cancelled'))
      }
      const waiter: ReadyWaiter = {
        resolve: (connectionId) => { signal?.removeEventListener('abort', abort); resolve(connectionId) },
        reject: (error) => { signal?.removeEventListener('abort', abort); reject(error) },
      }
      this.readyWaiters.add(waiter)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  /**
   * Present the channel's continuous frames newest first: while `present` runs, only the newest arrived frame waits,
   * and a newer arrival releases the waiting one unpresented. Depending on the Host, a continuous frame may be lossily
   * encoded.
   * @param present - Draws one frame; the frame is released after `present` returns or its promise settles.
   * @param failure - Receives frame failures of the connected producer, the channel's failure or closure, or an error
   *   `present` raised; the stream stays subscribed.
   * @returns Unsubscribe; it releases the waiting frame, and a frame being presented stays valid until `present` settles.
   * @throws When a mount or stream already owns consumption.
   */
  consume(present: (frame: FrameForwardingFrame) => void | Promise<void>, failure: (error: Error) => void): () => void {
    this.assertOpen()
    if (this.stream !== undefined) {
      throw new Error('Native channel already has a frame consumer.')
    }
    return this.startStream(present, failure)
  }

  private startStream(present: FrameStream['present'], failure: FrameStream['failure']): () => void {
    const stream: FrameStream = { present, failure }
    this.stream = stream
    return () => {
      if (this.stream !== stream) return
      this.stream = undefined
      this.streamPending?.release()
      this.streamPending = undefined
    }
  }

  /**
   * Display this channel in a video element.
   * Individual frame failures reach onEvent without ending the mount.
   * Mounted display and continuous consumption are mutually exclusive.
   * @param element - The video container.
   * @param failure - Receives a failure after mount resources are stopped, including channel closure or loss.
   * @param options - Optional mount settings; `visible` defaults to `true`.
   * @returns Idempotent unmount. It releases the display and queues an invisible viewport for the open channel.
   */
  mount(element: HTMLElement, failure: (error: Error) => void, options?: FrameMountOptions): () => void {
    this.assertOpen()
    if (this.stream !== undefined) {
      throw new Error('Native channel already has a frame consumer.')
    }
    let display: ElementMount | undefined
    const stopStream = this.startStream(frame => display?.present(frame), (error) => { stop(error) })
    const stop = (error?: Error): boolean => {
      if (this.mountStop !== stop) return false
      this.mountStop = undefined
      this.mounted = undefined
      this.contentView = undefined
      this.contentWindow = undefined
      this.contentWindows = []
      this.contentRequest = undefined
      stopStream()
      try { display?.dispose(error) } catch (cleanupError) { console.error('Frame mount cleanup failed', cleanupError) }
      if (error !== undefined) {
        try { failure(error) } catch (listenerError) { console.error('Native frame failure listener failed', listenerError) }
      }
      return true
    }
    this.mountStop = stop
    try {
      display = mountElement(element, {
        content: () => this.contentSnapshot(),
        viewport: (viewport, completion) => this.mountViewport(viewport, completion),
        report: (event) => { this.channelEvent(event) },
        failure: (error) => { stop(error) },
      }, options?.visible ?? true)
      this.mounted = display
    } catch (error) { stop(); throw error }
    return () => {
      const viewport = this.viewportState
      if (!stop()) return
      // Disposal may notify a consumer that closes the channel or submits a newer viewport.
      if (viewport?.visible && !this.eventsEnded && this.viewportState === viewport) {
        void this.automaticViewport({ ...viewport, visible: false }).catch((error: unknown) => {
          if (!(error instanceof FrameDiscardedError && error.reason === 'closed')) {
            console.error('Frame unmount viewport failed', error)
          }
        })
      }
    }
  }

  /**
   * Observe every channel event in arrival order. Subscription first replays the known channel state, latest viewport,
   * and latest generation submitted to the video track, in that order.
   * Listener exceptions are contained. Local close, Host closure or loss, termination of the Client's channel-event
   * stream, and Client disposal deliver one final closed-state or failure event; subscriptions after termination
   * receive nothing. Reentrant subscriptions replay after the event currently being delivered.
   * @param listener - Receives channel state, frame errors, routing failure, viewport, and content events.
   * @returns Idempotent disposer; removing one subscription does not affect another, even with the same listener.
   */
  onEvent(listener: (event: FrameRxEvent) => void): () => void {
    if (this.eventsEnded) return () => {}
    const subscription = (event: FrameRxEvent): void => { listener(event) }
    this.eventListeners.add(subscription)
    this.queueEvents(() => {
      const snapshot: FrameRxEvent[] = [
        ...this.channel === undefined ? [] : [{ kind: 'state' as const, channel: this.channel }],
        ...this.viewportState === undefined ? [] : [{ kind: 'viewport' as const, viewport: this.viewportState }],
        { kind: 'content', submittedGeneration: this.submittedGeneration },
      ]
      for (const event of snapshot) {
        if (this.eventsEnded) break
        this.notifyEvent(subscription, event)
      }
    })
    return () => { this.eventListeners.delete(subscription) }
  }

  /**
   * Stop this channel's consumers and frame routing; the Host plugin that opened the channel owns its lifetime.
   * @returns Completion after routing stopped and every lent frame's callback settled and its frame was released;
   *   repeated calls share that completion.
   */
  close(): Promise<void> {
    if (this.closing === undefined) {
      const completion = Promise.withResolvers<undefined>()
      this.closing = completion.promise
      void this.closeChannel().then(() => { completion.resolve(undefined) }, completion.reject)
    }
    return this.closing
  }

  private async closeChannel(): Promise<void> {
    const notify = !this.eventsEnded
    this.eventsEnded = true
    this.detach()
    this.mountStop?.(new FrameDiscardedError('closed'))
    this.stream = undefined
    this.discardPending()
    this.rejectReady(new FrameDiscardedError('closed'))
    this.end.resolve('closed')
    if (notify) {
      const channel = { state: 'closed', cause: 'closed', reason: 'Native channel closed.' } as const
      this.channel = channel
      this.deliverEvent({ kind: 'state', channel }, false, true)
    }
    await this.streamDrain
  }

  private async drainStream(): Promise<void> {
    if (this.streamDrain !== undefined) return
    const completion = Promise.withResolvers<void>()
    this.streamDrain = completion.promise
    try {
      while (this.stream !== undefined && this.streamPending !== undefined) {
        const stream = this.stream
        const lease = this.streamPending
        this.streamPending = undefined
        if (!this.acceptsGeneration(lease.metadata.generation)) { lease.release(); continue }
        try {
          try { await stream.present({ image: lease.frame, metadata: lease.metadata }) } finally { lease.release() }
        } catch (error) { this.reportStreamFailure(errorOf(error), stream) }
      }
    } finally {
      this.streamDrain = undefined
      completion.resolve()
    }
  }

  private reportStreamFailure(error: Error, stream = this.stream): void {
    try { stream?.failure(error) } catch (listenerError) { console.error('Native frame failure listener failed', listenerError) }
  }

  private assertOpen(): void {
    if (this.closing !== undefined) throw new FrameDiscardedError('closed')
    if (this.failure !== undefined) throw this.failure
  }

  /** The connected producer once it acknowledged the latest viewport this channel sent. */
  private readyConnection(): FrameConnectionId | undefined {
    const channel = this.channel
    if (channel?.state !== 'connected') return undefined
    return this.viewportVersion === 0 || channel.viewportVersion === this.viewportVersion ? channel.connectionId : undefined
  }

  /** Reentrant callbacks append work rather than overtaking another subscriber's current event. */
  private queueEvents(task: () => void): void {
    this.eventTasks.push(task)
    if (this.deliveringEvents) return
    this.deliveringEvents = true
    try {
      for (let next = this.eventTasks.shift(); next !== undefined; next = this.eventTasks.shift()) next()
    } finally { this.deliveringEvents = false }
  }

  private notifyEvent(listener: (event: FrameRxEvent) => void, event: FrameRxEvent): void {
    if (!this.eventListeners.has(listener)) return
    try { listener(event) } catch (error) { console.error('Native channel event listener failed', error) }
  }

  private deliverEvent(event: FrameRxEvent, apply: boolean, terminal: boolean): void {
    const listeners = [...this.eventListeners]
    this.queueEvents(() => {
      if (event.kind === 'content' && event.submittedGeneration === undefined && this.submittedGeneration === undefined) return
      if (apply) this.applyEvent(event)
      for (const listener of listeners) this.notifyEvent(listener, event)
      if (terminal) this.eventListeners.clear()
    })
  }

  private channelEvent(event: FrameRxEvent): void {
    if (this.eventsEnded) return
    const terminal = event.kind === 'failure' || event.kind === 'state' && event.channel.state === 'closed'
    if (terminal) this.eventsEnded = true
    this.deliverEvent(event, true, terminal)
  }

  private applyEvent(event: FrameRxEvent): void {
    switch (event.kind) {
      case 'state':
        this.applyState(event.channel)
        return
      case 'error': {
        // Only failures of the connected producer reach its stream.
        if (event.connectionId !== this.connectionId) return
        // Individual frame failures remain observable through onEvent without ending a mounted display.
        if (this.mountStop === undefined) this.reportStreamFailure(new FrameFailureError(event.source, event.error))
        return
      }
      case 'failure':
        this.terminate(new Error(event.error), 'failed')
        return
      case 'viewport':
        this.viewportState = event.viewport
        return
      case 'content':
        this.submittedGeneration = event.submittedGeneration
        return
      /* v8 ignore next -- The bridge event union is exhausted above. */
      default: return assertNever(event)
    }
  }

  private applyState(state: FrameChannelState): void {
    if (this.closing !== undefined || this.failure !== undefined) return
    this.channel = state
    if (state.state === 'closed') {
      const { cause } = state
      this.terminate(cause === 'failed' ? new Error(state.reason) : new FrameDiscardedError(cause), cause)
      return
    }
    const ready = this.readyConnection()
    if (ready === undefined) return
    const waiters = [...this.readyWaiters]
    this.readyWaiters.clear()
    for (const waiter of waiters) waiter.resolve(ready)
  }

  /** A Host closure or a renderer-side failure ends routing; the consumer still closes the channel. */
  private terminate(error: Error, cause: FrameChannelCloseCause): void {
    this.end.resolve(cause)
    this.failure = error
    this.discardPending()
    this.rejectReady(error)
    this.reportStreamFailure(error)
  }

  private rejectReady(error: Error): void {
    const waiters = [...this.readyWaiters]
    this.readyWaiters.clear()
    for (const waiter of waiters) waiter.reject(error)
  }

  private arrive(lease: FrameForwardingFrameLease): void {
    const metadata = lease.metadata
    if (this.closing !== undefined || this.failure !== undefined || metadata.rx !== this.rx
      || metadata.connectionId !== this.connectionId || !this.acceptsGeneration(metadata.generation)) {
      lease.release()
      return
    }
    if (this.stream !== undefined) {
      this.streamPending?.release()
      this.streamPending = lease
      void this.drainStream()
    } else lease.release()
  }

  private discardPending(preserveContent = false): void {
    const pending = this.streamPending
    if (pending === undefined) return
    if (preserveContent && this.contentSnapshot() !== undefined && this.acceptsGeneration(pending.metadata.generation)) return
    pending.release()
    this.streamPending = undefined
  }
}
