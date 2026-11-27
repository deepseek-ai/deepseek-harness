/** Ordered Office operations over the `officePreview` Remote namespace and the documents' shared views. */
import { remoteErrorOf, type RemoteResult, type TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-ui-office-frame-forwarding/remote'
import type { FrameForwardingClient } from '@deepseek-ai/dsh-frame-forwarding/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  OfficeDocumentGeometry, OfficeDocumentEvent, OfficeDocumentInfo, OfficeFrameReply, OfficeDocumentId, OfficeDocumentStatus,
  OfficeHeaderQuery, OfficeLoadingStage,
  OfficeOpenedDocument, OfficeOpenRequest, OfficePagePreviewReply, OfficePagePreviewRequest, OfficePaintRequest,
  OfficePresentationControl, OfficeQueryResult, OfficeReconnectResult, OfficeReconnectTrigger, OfficeSelectionCommand,
  OfficeSelectionFormat, OfficeSelectionInput, OfficeSelectionText, OfficeViewport, OfficeRetentionFrame,
} from '../types.ts'
import { FrameForwardingOfficeSession, OfficeFrameTimeoutError, type OfficePlaybackControl } from './frame-forwarding.ts'

/** Generated Client methods of the Host Office preview service. */
export type OfficePreviewRemote = TypertClientRemote['officePreview']

/** Host notifications and local frame-channel recovery notifications delivered to views. */
export interface OfficeViewEvent {
  readonly documentId: OfficeDocumentId
  readonly event: OfficeDocumentEvent['event'] | { readonly kind: 'expired' }
    | { readonly kind: 'lease'; readonly connected: boolean } | { readonly kind: 'channel'; readonly state: OfficeChannelState; readonly message?: string }
}

/** Reconnecting document lease delivered by the Client Gateway. */
export interface OfficeLeaseStream extends AsyncIterable<{ value: OfficeRetentionFrame; accept(): void }> {
  /** End this renderer's lease. @returns Completion of the stream cancellation. */
  dispose(): Promise<void>
}

/** Document operations bound to a view's current identity and input queue. */
export interface OfficeDocumentActions {
  info(): Promise<OfficeDocumentGeometry>
  part(part: number): Promise<OfficeDocumentGeometry & { info: OfficeDocumentInfo }>
  viewport(value: OfficeViewport): Promise<OfficeDocumentStatus>
  values(query: OfficeHeaderQuery): Promise<OfficeQueryResult>
  pagePreview(value: OfficePagePreviewRequest): Promise<OfficePagePreviewReply>
  presentation(control: OfficePresentationControl): Promise<OfficeDocumentStatus>
  playback(
    session: FrameForwardingOfficeSession, control: OfficePlaybackControl, signal?: AbortSignal,
  ): Promise<OfficeDocumentStatus | undefined>
  input(value: OfficeSelectionInput): Promise<OfficeDocumentStatus>
  command(value: OfficeSelectionCommand): Promise<OfficeDocumentStatus>
  selection(mime: OfficeSelectionFormat): Promise<OfficeSelectionText>
}

function geometry(info: OfficeDocumentInfo | undefined): OfficeDocumentInfo {
  if (typeof info?.width !== 'number' || typeof info.height !== 'number' || typeof info.rectangles !== 'string'
    || !Array.isArray(info.parts)) throw new Error('Invalid Office geometry.')
  return info
}

/** The View's open request: the Session supplies the workspace for the view's file path. */
export interface OfficeOpenFields extends OfficeOpenRequest {
  readonly sessionId: SessionId
}

/**
 * Progress of replacing a document's frame-forwarding channel, delivered to mounted views as a `channel` event.
 * `recovering`: a reconnect is in flight. `reconnected`: the document draws through a new channel, and its slideshow
 * stopped. `paused`: rendering waits for the user to reconnect. `unavailable`: Desktop no longer presents native frames.
 */
export type OfficeChannelState = 'recovering' | 'reconnected' | 'paused' | 'unavailable'

/** A rendering stop on the Desktop side, which reconnecting addresses instead of restarting the engine. */
export class OfficeChannelError extends Error {
  /**
   * @param state - `paused` when the user can reconnect, `unavailable` when no reconnect helps until Desktop restarts.
   * @param message - What stopped rendering.
   */
  constructor(readonly state: 'paused' | 'unavailable', message: string) {
    super(message)
    this.name = 'OfficeChannelError'
  }
}

/** How a mounted view recovers from a rendering failure. */
export type OfficeRenderStop =
  /** Recovery already runs, and its outcome arrives as a `channel` event. */
  | 'recovering'
  /** The user reconnects the document's channel. */
  | 'paused'
  /** Native rendering failed or became unavailable; the view uses its format-specific fallback. */
  | 'fallback'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function channelError(result: Exclude<OfficeReconnectResult, { outcome: 'reconnected' }>): OfficeChannelError {
  return result.outcome === 'limited'
    ? new OfficeChannelError('paused', 'Office rendering channel was lost again; automatic reconnection is paused.')
    : new OfficeChannelError('unavailable', result.reason)
}

/** Fixed safety cap on retained pending exchanges; not a deployment tuning setting. */
const MAX_PENDING_REQUESTS = 128

/** A connection survives tab unmounts; the Host retains documents across renderer failure. */
export class OfficeConnection {
  private readonly leases = new Map<OfficeDocumentId, OfficeLeaseStream>()
  private readonly native = new Map<OfficeDocumentId, FrameForwardingOfficeSession>()
  private readonly recovering = new Map<OfficeDocumentId, Promise<OfficeReconnectResult>>()
  private readonly operationTimeouts = new Map<OfficeDocumentId, number>()
  private failure: Error | undefined
  private pending = 0
  private readonly views = new Set<() => Promise<void>>()
  private disposed = false
  /** Unsolicited document-event listeners. */
  readonly listeners: Set<(event: OfficeViewEvent) => void> = new Set()

  /**
   * @param frames - Renderer-side frame forwarding.
   * @param remote - Generated `officePreview` Remote namespace.
   * @param lease - Open a reconnecting lease for one document.
   */
  constructor(private readonly frames: FrameForwardingClient, private readonly remote: OfficePreviewRemote,
    private readonly lease: (documentId: OfficeDocumentId, disconnected: () => void) => OfficeLeaseStream) {}

  /** Keep a view's final release callable until it settles, including after React unmounts.
   * @param release - Stop this view's producers and release its open document.
   * @returns Shared cleanup for the tab, React and the plugin, or undefined if the plugin is unloading.
   */
  ownView(release: () => Promise<void>): (() => Promise<void>) | undefined {
    if (this.disposed) return undefined
    let closing: Promise<void> | undefined
    const close = (): Promise<void> => closing ??= release().finally(() => { this.views.delete(close) })
    this.views.add(close)
    return close
  }

  /** Stop admitting views and wait for every document release, including those already in progress.
   * @returns Completion of all view cleanups.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    const results = await Promise.allSettled([...this.views].map(close => close()))
    const errors: unknown[] = []
    for (const result of results) if (result.status === 'rejected') errors.push(result.reason)
    if (errors.length) throw new AggregateError(errors, 'Office document cleanup failed.')
  }

  /** Deliver one engine event to every mounted view.
   * @param event - Host engine notification with its document status.
   */
  dispatch(event: OfficeViewEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error(error)
      }
    }
  }

  /**
   * Fail every open document so its view switches to the format fallback. Afterward every operation except `release`
   * rejects with `error`, including replies that arrive later, so a document opened meanwhile is released and its
   * view falls back too. Explicit release also reaches the Host after failure.
   * Repeated calls have no effect.
   * @param error - Why the documents can no longer be served, for example the end of the Host's event stream.
   */
  failAll(error: Error): void {
    if (this.failure !== undefined) return
    this.failure = error
    for (const documentId of new Set([...this.operationTimeouts.keys(), ...this.native.keys()]))
      this.dispatch({ documentId, event: { kind: 'failure', error: error.message } })
  }

  private throwIfFailed(): void {
    if (this.failure !== undefined) throw this.failure
  }

  /** Open a document and attach its channel before returning it to the view.
   * @param fields - Session, file and tab identity.
   * @param progress - Loading observer for this open.
   * @returns The attached native document.
   */
  async open(fields: OfficeOpenFields, progress?: (stage: OfficeLoadingStage) => void): Promise<OfficeOpenedDocument> {
    this.throwIfFailed()
    const { sessionId, address, owner, revision, path } = fields
    const opened = await this.bounded(async (signal) => {
      for await (const item of this.remote.open(sessionId, { address, owner, revision, path }, signal)) {
        if (item.kind === 'opened') return item.document
        try { progress?.(item.stage) } catch (error) { console.error(error) }
      }
      throw new Error('Office open ended without a document.')
    }, undefined)
    this.operationTimeouts.set(opened.documentId, opened.rendering.operationTimeoutMs)
    try {
      this.throwIfFailed()
      geometry(opened.info)
      await this.bounded(() => this.retain(opened.documentId), opened.rendering.operationTimeoutMs)
      await this.attachReply(opened)
      this.throwIfFailed()
      return opened
    } catch (error) { await this.releaseFailedOpen(opened.documentId); throw error }
  }

  private async retain(documentId: OfficeDocumentId): Promise<void> {
    const previous = this.leases.get(documentId)
    const carrier = { disconnected: false }
    const stream = this.lease(documentId, () => {
      carrier.disconnected = true
      this.dispatch({ documentId, event: { kind: 'lease', connected: false } })
    })
    this.leases.set(documentId, stream)
    await previous?.dispose()
    const ready = Promise.withResolvers<void>()
    void (async () => {
      try {
        for await (const frame of stream) {
          frame.accept()
          ready.resolve()
          if (carrier.disconnected) {
            carrier.disconnected = false
            this.dispatch({ documentId, event: { kind: 'lease', connected: true } })
          }
          if (frame.value.presentation !== undefined) this.dispatch({ documentId, event: frame.value.presentation })
        }
      } catch (error) {
        ready.reject(error)
        if (this.leases.get(documentId) === stream) {
          const event = remoteErrorOf(error)?.code === 'office/document-expired'
            ? { kind: 'expired' } as const : { kind: 'failure', error: errorMessage(error) } as const
          this.dispatch({ documentId, event })
        }
      }
    })()
    return ready.promise
  }

  /** Bind typed operations to a document, resolving its id when queued work is admitted.
   * @param identify - Current document id.
   * @param schedule - Input ordering for the caller.
   * @param update - Receives geometry changes after attachment.
   * @returns Document-specific operations.
   */
  document(identify: () => OfficeDocumentId, schedule: <T>(work: () => Promise<T>) => Promise<T> = work => work(),
    update?: (info: OfficeDocumentInfo) => void): OfficeDocumentActions {
    const run = <T extends OfficeDocumentStatus | OfficeQueryResult>(call: (id: OfficeDocumentId) => Promise<RemoteResult<T>>) =>
      schedule(async () => {
        const id = identify(), recovery = this.recovering.get(id)
        if (recovery !== undefined) await recovery.catch(() => {}) // Channel listeners receive the recovery outcome.
        this.throwIfFailed()
        const result = unwrap(await this.bounded(() => call(id), this.operationTimeouts.get(id)))
        this.throwIfFailed()
        if ('documentId' in result) await this.attachReply(result)
        this.throwIfFailed()
        return result
      })
    const updated = (reply: OfficeDocumentGeometry) => {
      const info = geometry(reply.info)
      update?.(info)
      return { ...reply, info }
    }
    return {
      info: () => run(id => this.remote.info(id)).then(reply => reply.info === undefined ? reply : updated(reply)),
      part: (part: number) => run(id => this.remote.part(id, part)).then(updated),
      viewport: (value: OfficeViewport) => run(id => this.remote.viewport(id, value)),
      values: (query: OfficeHeaderQuery) => run(id => this.remote.values(id, query)),
      pagePreview: (value: OfficePagePreviewRequest) => run(id => this.remote.pagePreview(id, value)),
      presentation: (control: OfficePresentationControl) => run(id => this.remote.presentation(id, control)),
      playback: (session, control, signal) => {
        const id = identify()
        return schedule(() => this.onSession(id, session, () => this.remote.presentation(id, control), signal))
      },
      input: (value: OfficeSelectionInput) => run(id => this.remote.input(id, value)),
      command: (value: OfficeSelectionCommand) => run(id => this.remote.command(id, value)),
      selection: (mime: OfficeSelectionFormat) => run(id => this.remote.selection(id, mime)),
    }
  }

  /** Release a Host document even if its connection failed, then retire its local frame receiver.
   * @param documentId - Open document identity.
   * @param state - An expired Host identity only has renderer resources left to close.
   * @returns Completion of both releases.
   */
  async release(documentId: OfficeDocumentId, state: 'open' | 'expired' = 'open'): Promise<void> {
    const stream = this.leases.get(documentId)
    this.leases.delete(documentId)
    await stream?.dispose()
    const recovery = this.recovering.get(documentId)
    if (recovery !== undefined) await recovery.catch(() => {})
    const session = this.native.get(documentId)
    try {
      if (state === 'open') unwrap(await this.bounded(() => this.remote.release(documentId), this.operationTimeouts.get(documentId)))
    }
    finally {
      this.operationTimeouts.delete(documentId)
      this.native.delete(documentId)
      await session?.close()
    }
  }

  private async releaseFailedOpen(documentId: OfficeDocumentId): Promise<void> {
    try { await this.release(documentId) }
    catch (error) { console.warn('Office failed open cleanup failed.', error) }
  }

  /** Send a whole-window paint and wait only for its Host acknowledgement.
   * @param documentId - Open document with a mounted channel.
   * @param value - Twip window and physical image dimensions.
   * @param generation - Version returned by the mount's acknowledged window update.
   * @returns Host status, or undefined when channel replacement cancels this queued paint; the successor mount repaints.
   */
  async requestFrame(
    documentId: OfficeDocumentId, value: Omit<OfficePaintRequest, 'frame'>, generation: number,
  ): Promise<OfficeFrameReply | undefined> {
    const session = this.native.get(documentId)
    if (session === undefined) throw new Error('Office shared rendering is unavailable.')
    return this.onSession(documentId, session, () => this.remote.paint(documentId, { ...value, frame: { generation } }))
  }

  private async onSession<T>(documentId: OfficeDocumentId, session: FrameForwardingOfficeSession,
    send: () => Promise<RemoteResult<T>>, signal?: AbortSignal): Promise<T | undefined> {
    const recovery = this.recovering.get(documentId)
    if (recovery !== undefined) await recovery.catch(() => {})
    // Viewport versions and slideshow streams belong to the mount and channel that issued them.
    if (this.native.get(documentId) !== session || signal?.aborted) return undefined
    this.throwIfFailed()
    const result = unwrap(await this.bounded(send, this.operationTimeouts.get(documentId)))
    this.throwIfFailed()
    return result
  }

  /** Read the channel owner for a mounted document.
   * @param documentId - Open document.
   * @returns Current session, or undefined before attachment and after release.
   */
  frameForwardingSession(documentId: OfficeDocumentId): FrameForwardingOfficeSession | undefined {
    return this.native.get(documentId)
  }

  /** Classify a mount version race without reporting an engine failure.
   * @param error - Rejected paint or viewport operation.
   * @returns Whether latest demand should retry after readiness.
   */
  engineViewportStale(error: unknown): boolean {
    const remote = remoteErrorOf(error)
    return remote?.code === 'office/frame-retry' && remote.details.reason === 'stale'
  }

  /**
   * Classify a rendering failure by the recovery a view offers.
   * @param error - Failure of a rendering request, a slideshow stream, or a page preview.
   * @returns The recovery that applies.
   */
  renderStop(error: unknown): OfficeRenderStop {
    if (error instanceof OfficeChannelError) return error.state === 'paused' ? 'paused' : 'fallback'
    // A mount, canvas, or video failure is terminal for the browser backend; reconnecting the channel cannot repair it.
    return this.frames.discardReason(error) === 'lost' ? 'recovering' : 'fallback'
  }

  /**
   * Classify a rendering failure that only means its frame came late, for example while other views hold the window's
   * frame surfaces; the view keeps what it shows and asks again.
   * @param error - Failure of a window paint.
   * @returns Whether the frame deadline or the Kit engine's own wait for a free frame surface expired.
   */
  frameWaitExpired(error: unknown): boolean {
    const remote = remoteErrorOf(error)
    return error instanceof OfficeFrameTimeoutError || (remote?.code === 'office/frame-retry' && remote.details.reason === 'credit-timeout')
  }

  /**
   * Ask the Host to connect a document to a new frame-forwarding channel and draw through it. One recovery runs per
   * document at a time; other requests of the document wait for it. Mounted views follow it through `channel` events.
   * @param documentId - Mounted document.
   * @param trigger - `automatic` after the channel was lost, limited by the Host; `user` when the user asked.
   * @returns The Host's outcome; rejects when the Host refused the request, for example after an engine failure.
   */
  recover(documentId: OfficeDocumentId, trigger: OfficeReconnectTrigger): Promise<OfficeReconnectResult> {
    const pending = this.recovering.get(documentId)
    if (pending !== undefined) return pending
    if (this.failure !== undefined) return Promise.reject(this.failure)
    const recovery = (async (): Promise<OfficeReconnectResult> => {
      const result = unwrap(await this.bounded(() => this.remote.reconnect(documentId, trigger),
        this.operationTimeouts.get(documentId)))
      this.throwIfFailed()
      if (result.outcome === 'reconnected') await this.attachReply(result.status)
      return result
    })().finally(() => { this.recovering.delete(documentId) })
    this.recovering.set(documentId, recovery)
    this.dispatchChannel(documentId, 'recovering')
    void recovery.then((result) => {
      if (result.outcome === 'reconnected') this.dispatchChannel(documentId, 'reconnected')
      else {
        const { state, message } = channelError(result)
        this.dispatchChannel(documentId, state, message)
      }
    }, (error: unknown) => { this.dispatchChannel(documentId, 'paused', errorMessage(error)) })
    return recovery
  }

  private dispatchChannel(documentId: OfficeDocumentId, state: OfficeChannelState, message?: string): void {
    this.dispatch({ documentId, event: { kind: 'channel', state, ...message === undefined ? {} : { message } } })
  }

  private async attachReply(reply: OfficeDocumentStatus): Promise<void> {
    if (typeof reply.documentId === 'string' && reply.nativeView !== undefined) {
      const documentId = reply.documentId
      const descriptor = reply.nativeView
      const old = this.native.get(documentId)
      if (old?.rx.rx !== descriptor.rx) {
        const rx = this.frames.connect(descriptor.rx)
        const session = new FrameForwardingOfficeSession(rx, descriptor.frameTimeoutMs)
        this.native.set(documentId, session)
        // A lost channel is replaced even when no request is waiting for a frame; a failed channel fails its document
        // even while no view mounts it, for example in a hidden tab.
        void rx.closed.then((cause) => {
          if (this.native.get(documentId) !== session) return
          if (cause === 'lost')
            void this.recover(documentId, 'automatic').catch((_error: unknown) => { /* recover reported it to mounted views */ })
          else if (cause === 'failed') this.dispatch({ documentId, event: { kind: 'failure', error: 'Office frame channel failed.' } })
        })
        try { await old?.close() } catch (error) { console.warn('Office retired view cleanup failed.', error) }
      }
    }
  }
  /** Cap retained exchanges; the Host owns open deadlines before a document supplies its operation budget. */
  private async bounded<T>(exchange: (signal: AbortSignal) => Promise<T>, timeoutMs: number | undefined): Promise<T> {
    if (this.pending >= MAX_PENDING_REQUESTS) throw new Error('Office input is busy.')
    this.pending++
    const lifetime = new AbortController()
    const expired = timeoutMs === undefined ? undefined : new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('Office operation timed out.'))
        lifetime.abort()
      }, timeoutMs)
      lifetime.signal.addEventListener('abort', () => { clearTimeout(timer) }, { once: true })
    })
    try {
      const request = exchange(lifetime.signal)
      return await (expired === undefined ? request : Promise.race([request, expired]))
    } finally {
      lifetime.abort()
      this.pending--
    }
  }
}

function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw result.error
  return result.value
}
