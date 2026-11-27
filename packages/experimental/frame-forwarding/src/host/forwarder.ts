/**
 * Host-side owner of frame-forwarding channels. Each channel's receiver hands accepted frames in native code to the
 * native sink of Desktop's shared-texture service; this module attaches that sink and keeps each receiver's
 * presentation gate current.
 */
import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  FrameForwardingAdapterId, FrameForwardingBindings, FrameForwardingBudget, FrameForwardingReceiver,
  FrameForwardingReceiverEvent,
} from './native.ts'
import type { SharedTextureNativeSink, SharedTextureService } from '@deepseek-ai/dsh-shared-texture'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {
  FrameChannelCloseCause, FrameChannelSnapshot, FrameChannelState, FrameConnectionId, FrameForwardingCapabilities, FrameForwardingEvent,
  FrameForwardingViewport, FrameRxId, FrameViewportResult,
} from '../types.ts'
import type { FrameChannel, FrameTx } from './service.ts'
import { parseFrameForwardingViewport } from './validation.ts'

/** The longest presentation deadline Desktop's native sink accepts. */
const maxPresentationTimeoutMs = 30_000

/** Native receiver limits for the Desktop window. */
export interface FrameForwardingLimits {
  /** Maximum surfaces per channel held at once by the producer's submissions, the Host, Desktop, and the renderer. */
  maxFrames: number
  /**
   * Window allocation budget including idle pooled surfaces, in bytes. It is read once, when the first channel opens
   * after the receiver loads, so a Host whose receiver never loads never sizes it.
   */
  maxBytes: () => number
  /**
   * Deadline for adapter detection, Desktop's sink, frame delivery, producer handshakes, and producer acknowledgements
   * in milliseconds; each frame's presentation through Desktop's sink waits at most 30000 of them.
   */
  requestTimeoutMs: number
  /** Maximum control requests per connection awaiting producer acknowledgement. */
  maxPendingRequests: number
}

/** Diagnostics and renderer-facing events of the forwarder. */
export interface FrameForwarderListeners {
  /** Receives every channel state and frame error, in publication order. */
  event(event: Exclude<FrameForwardingEvent, { kind: 'snapshot' }>): void
  /** Receives producer refusals, disconnect reasons, and blocked drains; never a credential. */
  warn(message: string): void
}

interface Pending {
  resolve(): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}
interface Connection {
  readonly id: FrameConnectionId
  /** Newest viewport version this connection acknowledged. */
  confirmed: number | undefined
  /** Viewport requests sent to this connection and awaiting acknowledgement, by request identifier. */
  readonly pending: Map<string, Pending>
}
interface Channel {
  readonly rx: FrameRxId
  readonly receiver: FrameForwardingReceiver
  state: FrameChannelState
  sequence: number
  /** The channel's single producer connection, once connected. */
  connection: Connection | undefined
  /** Latest renderer viewport; applied on initial connection if submitted while idle. */
  viewport: FrameForwardingViewport | undefined
  closing: Promise<void> | undefined
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid frame-forwarding message')
  return value as Record<string, unknown>
}
function errorOf(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
function text(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

/** Channels, their producer connections, viewports, and the Desktop sink their receivers present frames through. */
export class FrameForwarder {
  private readonly channels = new Map<FrameRxId, Channel>()
  /** The window budget and its size, created when the first channel opens. */
  private budget: { readonly native: FrameForwardingBudget; readonly bytes: number } | undefined
  private bindings: { native: FrameForwardingBindings } | { error: Error } | undefined
  /** The one outstanding `nativeSink` request. */
  private sinkRequest: Promise<SharedTextureNativeSink> | undefined
  private generation = 0
  private sequence = 0
  private readonly operations = new Set<Promise<unknown>>()
  private resetting: Promise<void> | undefined

  /**
   * @param sharedTexture - Desktop's shared-texture service; its native sink receives every frame from the receiver
   *   addon, and its `adapterLuid` identifies Chromium's adapter on Windows.
   * @param loadBindings - Load the receiver addon; called at most once, on the first native operation.
   * @param limits - Receiver limits.
   * @param listeners - Channel events for the renderer and diagnostics for the Host log.
   */
  constructor(
    private readonly sharedTexture: SharedTextureService,
    private readonly loadBindings: () => FrameForwardingBindings,
    private readonly limits: FrameForwardingLimits,
    private readonly listeners: FrameForwarderListeners,
  ) {}

  private async track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation)
    try {
      return await operation
    } finally {
      this.operations.delete(operation)
    }
  }

  /** A packaged build verifies the addon; a development build without a C++ toolchain reports the receiver unavailable. */
  private loaded(): { native: FrameForwardingBindings } | { error: Error } {
    if (this.bindings === undefined) {
      try { this.bindings = { native: this.loadBindings() } } catch (error) { this.bindings = { error: errorOf(error) } }
    }
    return this.bindings
  }

  /**
   * Probe native frame support.
   * @returns Whether Desktop presents textures on this platform and the receiver addon loads.
   */
  async capabilities(): Promise<FrameForwardingCapabilities> {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return { supported: false, reason: 'unsupported-platform' }
    const bindings = this.loaded()
    if ('error' in bindings) return { supported: false, reason: `receiver-unavailable: ${bindings.error.message}` }
    const desktop = await this.sharedTexture.capabilities(this.limits.requestTimeoutMs)
    if (!desktop.supported) return { supported: false, reason: desktop.reason ?? 'desktop-shared-texture-unavailable' }
    return { supported: true }
  }

  /**
   * Open a channel with its own receiver under the window budget, attached to Desktop's native sink.
   * @returns The producer credential and the receive identity; rejects when Desktop provides no native sink.
   */
  channel(): Promise<FrameChannel> {
    if (this.resetting !== undefined) return Promise.reject(new Error('Native channels are closing'))
    return this.track(this.openChannel())
  }

  private async openChannel(): Promise<FrameChannel> {
    const generation = this.generation
    const { maxFrames, requestTimeoutMs } = this.limits
    const bindings = this.loaded()
    if ('error' in bindings) throw new Error(`Frame-forwarding receiver is unavailable: ${bindings.error.message}`)
    const addon = bindings.native
    // Software compositing can begin at any time, so every channel asks Desktop before relying on cached state.
    const desktop = await this.sharedTexture.capabilities(this.limits.requestTimeoutMs)
    if (!desktop.supported) throw new Error(`Desktop shared textures are unavailable: ${desktop.reason ?? 'unsupported'}`)
    const unavailable = (error: unknown): Error =>
      new Error(`Desktop native frame submission is unavailable: ${errorOf(error).message}`, { cause: error })
    // The sink and the Windows adapter both precede the receiver, so their failures leave nothing to discard.
    let sink: SharedTextureNativeSink
    try {
      sink = await this.nativeSink()
    } catch (error) {
      throw unavailable(error)
    }
    const displayAdapter = await this.displayAdapter()
    if (generation !== this.generation) throw new Error('Native channel creation cancelled')
    if (this.budget === undefined) {
      const bytes = this.limits.maxBytes()
      this.budget = { native: addon.createBudget(bytes), bytes }
    }
    const rx = brandString<FrameRxId>(randomUUID())
    const receiver = addon.createReceiver({
      maxFrames, maxBytes: this.budget.bytes, budget: this.budget.native, displayAdapter, readbackTimeoutMs: requestTimeoutMs,
    }, (event) => {
      const channel = this.channels.get(rx)
      if (channel !== undefined) this.receive(channel, event)
      else if (event.type === 'frame') receiver.release(event.deliveryId)
    })
    try {
      receiver.attachSink(rx, sink, this.presentationTimeoutMs())
    } catch (error) {
      // No producer holds the credential before it is returned, so the discarded receiver has no frames to drain.
      try {
        await receiver.close()
      } catch (closeError) {
        console.error('Native receiver teardown failed', closeError)
      }
      throw unavailable(error)
    }
    const channel: Channel = {
      rx, receiver, state: { state: 'idle' }, sequence: 0, connection: undefined, viewport: undefined, closing: undefined,
    }
    this.channels.set(rx, channel)
    this.publish(channel, { state: 'idle' })
    return { tx: brandString<FrameTx>(receiver.tx), rx }
  }

  /**
   * Desktop's native sink of its current connection. Desktop's service keeps that connection and replaces it after a
   * disconnect, so every channel asks it; requests made while one is outstanding share that one.
   */
  private nativeSink(): Promise<SharedTextureNativeSink> {
    return this.sinkRequest ??= this.sharedTexture.nativeSink(this.limits.requestTimeoutMs)
      .finally(() => { this.sinkRequest = undefined })
  }

  /** Deadline of each presentation through Desktop's sink: the request deadline, up to the sink's limit. */
  private presentationTimeoutMs(): number {
    return Math.min(this.limits.requestTimeoutMs, maxPresentationTimeoutMs)
  }

  /**
   * A receiver delivered a frame to JavaScript, so it has no usable sink: request Desktop's current one unless a
   * request is outstanding, and attach it to every open channel. A failure is reported; the next such frame requests
   * again.
   */
  private refreshSink(): void {
    if (this.sinkRequest !== undefined || this.resetting !== undefined) return
    void this.track(this.nativeSink().then((sink) => {
      for (const channel of this.channels.values()) {
        if (channel.closing !== undefined) continue
        try {
          channel.receiver.attachSink(channel.rx, sink, this.presentationTimeoutMs())
        } catch (error) {
          this.warn(`Native channel could not attach Desktop's sink: ${errorOf(error).message}`)
        }
      }
    }, (error: unknown) => {
      this.warn(`Desktop native frame submission is unavailable: ${errorOf(error).message}`)
    }))
  }

  /**
   * Chromium's compositor adapter, null on macOS. Every Windows channel asks Desktop, whose answer follows the GPU
   * process across restarts; the LUID is spelled as the receiver names adapters.
   */
  private async displayAdapter(): Promise<FrameForwardingAdapterId | null> {
    if (process.platform !== 'win32') return null
    const luid = await this.sharedTexture.adapterLuid(this.limits.requestTimeoutMs)
    if (luid === null) throw new Error('Desktop shared textures are unavailable: Electron graphics adapter could not be identified')
    return luid as FrameForwardingAdapterId
  }

  /**
   * Report whether a channel still serves producers and its renderer.
   * @param rx - Channel identity.
   * @returns Whether the channel exists and is not closing.
   */
  isOpen(rx: FrameRxId): boolean {
    const channel = this.channels.get(rx)
    return channel !== undefined && channel.closing === undefined
  }

  /**
   * Read every channel's latest published state, including channels still closing.
   * @returns One entry per channel, for a new renderer subscription.
   */
  snapshot(): FrameChannelSnapshot[] {
    return [...this.channels.values()].map(({ rx, sequence, state }) => ({ rx, sequence, channel: state }))
  }

  /**
   * Keep a renderer viewport for the channel and apply it to the channel's producer connection.
   * @param rx - Open channel.
   * @param value - Untrusted viewport from the renderer, validated here.
   * @returns The retained version for a stale submission, or the outcome of delivering a newer one. Producer refusal
   *   and acknowledgement timeout reject the request and leave the channel open.
   */
  async setViewport(rx: FrameRxId, value: unknown): Promise<FrameViewportResult> {
    const channel = this.open(rx)
    const viewport = parseFrameForwardingViewport(value)
    if (channel.viewport !== undefined && viewport.version <= channel.viewport.version)
      return { applied: false, reason: 'stale-viewport', currentVersion: channel.viewport.version }
    channel.viewport = viewport
    this.updateDeliverable(channel)
    const connection = channel.connection
    if (connection === undefined) return { applied: false, reason: 'no-producer' }
    await this.track(this.applyViewport(channel, connection, viewport))
    return { applied: true, connectionId: connection.id }
  }

  private open(rx: FrameRxId): Channel {
    const channel = this.channels.get(rx)
    if (channel === undefined || channel.closing !== undefined) throw new Error('Native channel is closed')
    return channel
  }

  private publish(channel: Channel, state: FrameChannelState): void {
    channel.state = state
    channel.sequence = ++this.sequence
    this.notify({ kind: 'state', rx: channel.rx, sequence: channel.sequence, channel: state })
  }

  private notify(event: Exclude<FrameForwardingEvent, { kind: 'snapshot' }>): void {
    try { this.listeners.event(event) } catch (error) { console.error('Native channel event listener failed', error) }
  }

  private warn(message: string): void {
    try { this.listeners.warn(message) } catch (error) { console.error('Native channel warning listener failed', error) }
  }

  /** Publish the current connection's state; a closing channel has already ended its connection. */
  private publishConnected(channel: Channel, connection: Connection): void {
    const { id, confirmed } = connection
    this.publish(channel, { state: 'connected', connectionId: id, ...confirmed === undefined ? {} : { viewportVersion: confirmed } })
  }

  /** Send one viewport to a connection; the request is bound to that connection and fails when it ends. */
  private applyViewport(channel: Channel, connection: Connection, viewport: FrameForwardingViewport): Promise<void> {
    if (connection.pending.size >= this.limits.maxPendingRequests) return Promise.reject(new Error('Native control queue is full'))
    const requestId = randomUUID()
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(requestId)
        reject(new Error('Native producer acknowledgement timed out'))
      }, this.limits.requestTimeoutMs)
      connection.pending.set(requestId, { resolve, reject, timer })
      try {
        channel.receiver.send(connection.id, JSON.stringify({ type: 'viewport', viewport, requestId }))
      } catch {
        // The addon refuses sends once the connection ended, before its disconnect event reaches this thread.
        clearTimeout(timer)
        connection.pending.delete(requestId)
        reject(new Error('Native channel is closed'))
      }
    })
  }

  private settle(connection: Connection, requestId: unknown, error?: Error): void {
    if (typeof requestId !== 'string') return
    const pending = connection.pending.get(requestId)
    if (pending === undefined) return
    connection.pending.delete(requestId)
    clearTimeout(pending.timer)
    if (error === undefined) pending.resolve()
    else pending.reject(error)
  }

  private end(connection: Connection, error: () => Error): void {
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error())
    }
    connection.pending.clear()
  }

  private closeOnEvent(channel: Channel, cause: FrameChannelCloseCause, reason: string): void {
    void this.closeChannel(channel, cause, reason).catch((error: unknown) => {
      console.error('Native receiver teardown failed', error)
    })
  }

  private receive(channel: Channel, event: FrameForwardingReceiverEvent): void {
    switch (event.type) {
      case 'connected': {
        if (channel.closing !== undefined) return
        if (channel.connection !== undefined) {
          this.closeOnEvent(channel, 'failed', 'Native channel received an unexpected second producer')
          return
        }
        const connection: Connection = { id: event.connectionId, confirmed: undefined, pending: new Map() }
        channel.connection = connection
        this.updateDeliverable(channel)
        this.publishConnected(channel, connection)
        const viewport = channel.viewport
        if (viewport !== undefined) {
          void this.track(this.applyViewport(channel, connection, viewport)).catch((error: unknown) => {
            if (channel.closing === undefined) this.warn(`Native initial viewport apply failed: ${errorOf(error).message}`)
          })
        }
        return
      }
      case 'message':
        this.message(channel, event.connectionId, event.text)
        return
      case 'frame':
        // A frame reaches JavaScript only while its receiver has no usable Desktop sink.
        channel.receiver.release(event.deliveryId)
        this.refreshSink()
        return
      case 'presentation-error':
        this.notify({
          kind: 'error', rx: channel.rx, connectionId: event.connectionId, source: event.source,
          ...event.requestId === undefined ? {} : { requestId: event.requestId }, error: event.text,
        })
        return
      case 'presentation-invalidated':
        this.closeOnEvent(channel, 'lost', 'Desktop invalidated a presented frame')
        return
      case 'disconnected': {
        if (channel.closing !== undefined || channel.connection?.id !== event.connectionId) return
        if (event.text !== undefined) this.warn(`Native producer ${String(event.connectionId)} disconnected: ${event.text}`)
        const cause: FrameChannelCloseCause = event.text === undefined ? 'closed' : 'failed'
        const reason = event.text === undefined ? 'Native producer disconnected' : `Native producer disconnected: ${event.text}`
        this.closeOnEvent(channel, cause, reason)
        return
      }
      case 'drained':
        return
      case 'drain-blocked':
        this.warn(`Native producer ${String(event.connectionId)} drain is blocked: ${event.text}`)
        return
      case 'rejected':
        this.warn(`Native producer refused: ${event.text}`)
        return
      case 'failed':
        this.closeOnEvent(channel, 'failed', `Native channel failed: ${event.text}`)
        return
      /* v8 ignore next -- The addon event union is exhausted above. */
      default: return assertNever(event)
    }
  }

  /** Control messages only affect the channel's single connection while open. */
  private message(channel: Channel, connectionId: FrameConnectionId, json: string): void {
    const connection = channel.connection
    if (channel.closing !== undefined || connection?.id !== connectionId) return
    let message: Record<string, unknown>
    try {
      message = object(JSON.parse(json))
    } catch {
      this.notify({ kind: 'error', rx: channel.rx, connectionId, source: 'producer', error: 'Native producer sent an invalid control message' })
      return
    }
    switch (message.type) {
      case 'viewport-applied': {
        const version = message.version
        if (typeof version === 'number' && Number.isSafeInteger(version) && version > (connection.confirmed ?? -1)) {
          connection.confirmed = version
          this.publishConnected(channel, connection)
        }
        this.settle(connection, message.requestId)
        return
      }
      case 'viewport-rejected':
        this.settle(connection, message.requestId, new Error(text(message.error, 'Native producer rejected viewport')))
        return
      case 'error':
        this.notify({ kind: 'error', rx: channel.rx, connectionId, source: 'producer', error: text(message.message, 'Native producer failed') })
        return
      default:
        // Input acknowledgements and other application messages carry no channel state.
    }
  }

  /**
   * Push the receiver's presentation gate: frames of the channel's connection while the latest viewport is
   * visible, up to that viewport's version. The gate moves before the viewport is sent, so it admits a frame of the
   * new generation even when that frame reaches the receiver before JavaScript handles the acknowledgement. Earlier
   * generations pass because frames still in flight can follow a newer viewport; Desktop Main and the receive channel
   * release generations outside their render windows.
   */
  private updateDeliverable(channel: Channel): void {
    const { connection, viewport } = channel
    channel.receiver.setDeliverable(channel.closing === undefined && connection !== undefined && viewport !== undefined
      ? { connectionId: connection.id, visible: viewport.visible, maxGeneration: viewport.version }
      : null)
  }

  /** The receiver stops before the first await, so a frame released after this call returns no credit. */
  private async closeChannel(channel: Channel, cause: FrameChannelCloseCause, reason: string): Promise<void> {
    if (channel.closing !== undefined) return channel.closing
    channel.receiver.setDeliverable(null)
    const closing = channel.receiver.close()
    channel.closing = closing
    if (channel.connection !== undefined) this.end(channel.connection, () => new Error('Native channel closed'))
    this.publish(channel, { state: 'closed', cause, reason })
    try {
      await closing
    } finally {
      this.channels.delete(channel.rx)
    }
  }

  /**
   * Close a channel permanently.
   * @param rx - Owned channel; an unknown channel is already closed.
   * @returns Completion of native resource and connection teardown.
   */
  close(rx: FrameRxId): Promise<void> {
    const channel = this.channels.get(rx)
    return channel === undefined ? Promise.resolve() : this.closeChannel(channel, 'closed', 'Native channel closed')
  }

  /** Close every channel; presented textures stay owned by the renderer until Desktop settles them.
   * @returns Completion of native I/O teardown.
   */
  closeAll(): Promise<void> {
    return this.resetting ??= (async () => {
      this.generation++
      const closures = await Promise.allSettled([...this.channels.keys()].map(rx => this.close(rx)))
      await Promise.allSettled([...this.operations])
      const failures = closures.filter(result => result.status === 'rejected').map((result): unknown => result.reason)
      if (failures.length > 0) throw new AggregateError(failures, 'Native receiver cleanup failed')
    })().finally(() => { this.resetting = undefined })
  }
}
