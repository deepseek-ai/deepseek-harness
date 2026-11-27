/**
 * Native frame forwarding for Host plugins: channels whose producers present frames in the Desktop renderer through
 * Desktop's shared-texture service. Consumers open channels and hand their credentials to producers through the
 * `frameForwarding` service; the renderer applies viewports and follows channel states through the `frameForwarding`
 * Remote namespace.
 */
import { totalmem } from 'node:os'
import { type Context } from '@deepseek-ai/cordis'
import type { SharedTextureClaim } from '@deepseek-ai/dsh-shared-texture'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { Config, windowBudget } from './config.ts'
import { loadFrameForwardingBindings } from './host/native.ts'
import { FrameForwarder } from './host/forwarder.ts'
import type { FrameChannel, FrameForwardingService } from './host/service.ts'
import type {
  FrameChannelSnapshot, FrameForwardingCapabilities, FrameForwardingEvent, FrameForwardingViewport, FrameRxId,
  FrameViewportResult,
} from './types.ts'

export type * from './types.ts'
export type { Config } from './config.ts'
export type { FrameChannel, FrameForwardingService, FrameTx } from './host/service.ts'

/**
 * Merge the closures the unread events still carry for channels absent from the forwarder's snapshot. Only the newest
 * `maxClosed` of them are kept, so an unread queue never grows the snapshot without bound; the renderer reports an
 * older closure it knew of as vanished.
 * @param unread - Queued events, including earlier snapshots.
 * @param channels - The forwarder's current channels, all of which are kept.
 * @param maxClosed - Maximum closures of forgotten channels to keep.
 * @returns The snapshot entries, one per channel: the current channels, then the kept closures in publication order.
 */
function compact(unread: readonly FrameForwardingEvent[], channels: FrameChannelSnapshot[], maxClosed: number): FrameChannelSnapshot[] {
  const current = new Set(channels.map(entry => entry.rx))
  const closures = new Map<FrameRxId, FrameChannelSnapshot>()
  for (const event of unread) {
    const entries = event.kind === 'snapshot' ? event.channels
      : event.kind === 'state' ? [{ rx: event.rx, sequence: event.sequence, channel: event.channel }] : []
    for (const entry of entries) {
      if (entry.channel.state !== 'closed' || current.has(entry.rx)) continue
      const known = closures.get(entry.rx)
      if (known === undefined || known.sequence < entry.sequence) closures.set(entry.rx, entry)
    }
  }
  const forgotten = [...closures.values()].sort((a, b) => a.sequence - b.sequence)
  return [...channels, ...forgotten.slice(Math.max(0, forgotten.length - maxClosed))]
}

/** Channels for every consumer of this Host, plus the Remote the renderer uses to drive them. */
export default class FrameForwarding extends TypertRemoteService implements FrameForwardingService {
  static Config = Config

  /** The forwarder over the claimed Desktop shared textures; absent while frame forwarding holds no claim. */
  private forwarder: FrameForwarder | undefined
  /** Why no forwarder exists: Desktop provides no shared textures, or another consumer holds their claim. */
  private unavailable: 'desktop-shared-texture-unavailable' | 'desktop-shared-texture-claimed' = 'desktop-shared-texture-unavailable'
  /** Disposers of the effects that bind each open channel to the scope that opened it. */
  private readonly owners = new Map<FrameRxId, () => void | Promise<void>>()
  private subscriber: {
    readonly events: FrameForwardingEvent[]
    wake: (() => void) | undefined
    ended: boolean
  } | undefined

  /**
   * @param ctx - Host scope; Desktop's `sharedTexture` service is claimed whenever it is provided.
   * @param config - Receiver limits.
   */
  constructor(ctx: Context, readonly config: Config) {
    super(ctx, 'frameForwarding')
    // Physical memory is read only when a forwarder opens its first channel, so a Host that never loads the receiver,
    // such as the browser worker deployment, never reads it. A budget above physical memory is reduced with a warning.
    const maxBytes = (): number => {
      const physicalMemory = totalmem()
      const bytes = windowBudget(config.maxBytes, physicalMemory)
      if (config.maxBytes !== 'auto' && bytes < config.maxBytes) {
        ctx.logger.warn(`Frame forwarding maxBytes ${config.maxBytes} exceeds the ${physicalMemory} bytes of physical memory; `
          + `the window budget is ${bytes} bytes.`)
      }
      return bytes
    }
    // The Desktop Host provides shared textures after the profile loads. Frame forwarding holds their only claim while
    // both are loaded and closes every channel before releasing it.
    ctx.inject(['sharedTexture', 'desktopFrameReceiver'], (scope) => {
      scope.effect(() => {
        let claim: SharedTextureClaim
        try {
          claim = scope.sharedTexture.claim()
        } catch (error) {
          ctx.logger.warn(error)
          this.unavailable = 'desktop-shared-texture-claimed'
          return () => { this.unavailable = 'desktop-shared-texture-unavailable' }
        }
        const { maxFrames, requestTimeoutMs, maxPendingRequests } = config
        const forwarder: FrameForwarder = new FrameForwarder(
          claim,
          () => loadFrameForwardingBindings(scope.desktopFrameReceiver.path),
          { maxFrames, maxBytes, requestTimeoutMs, maxPendingRequests },
          {
            event: (event) => {
              this.publish(event, forwarder)
              if (event.kind === 'state' && event.channel.state === 'closed') this.disown(event.rx)
            },
            warn: (message) => { ctx.logger.warn(message) },
          },
        )
        this.forwarder = forwarder
        return async () => {
          this.forwarder = undefined
          // Every channel closes with the claim, so the scopes that opened them stop tracking them.
          for (const dispose of [...this.owners.values()]) void dispose()
          try { await forwarder.closeAll() } catch (error) { ctx.logger.warn(error) } finally { claim.release() }
        }
      })
    })
    ctx.effect(() => () => { this.endSubscriber() })
  }

  private missingReceiver(): boolean {
    return Boolean(this.ctx.get('sharedTexture')) && !this.ctx.get('desktopFrameReceiver')
  }

  private frames(): FrameForwarder {
    if (this.forwarder !== undefined) return this.forwarder
    if (this.missingReceiver()) throw new Error('Desktop frame receiver is unavailable.')
    throw new Error(this.unavailable === 'desktop-shared-texture-claimed'
      ? 'Desktop shared textures are claimed by another consumer.' : 'Desktop shared textures are unavailable.')
  }

  /**
   * A queued state is superseded by a newer state of its channel, so the queue keeps the latest state per channel.
   * Beyond the limit the unread events become one snapshot of every channel, which keeps each channel's latest state
   * and drops unread frame errors. The forwarder forgets a channel once its closure completes, so an unread closure of
   * a forgotten channel moves into the snapshot; at most the newest `maxQueuedEvents` such closures do, so the
   * snapshot stays bounded by the open channels however many channels close unread. The first snapshot never waits
   * here: the stream takes it on its first read.
   */
  private publish(event: FrameForwardingEvent, forwarder: FrameForwarder): void {
    const subscriber = this.subscriber
    if (subscriber === undefined || subscriber.ended) return
    const { events } = subscriber
    if (event.kind === 'state') {
      const index = events.findIndex(queued => queued.kind === 'state' && queued.rx === event.rx)
      if (index >= 0) events.splice(index, 1)
    }
    const { maxQueuedEvents } = this.config
    if (events.length >= maxQueuedEvents) events.splice(0, events.length, { kind: 'snapshot', channels: compact(events, forwarder.snapshot(), maxQueuedEvents) })
    else events.push(event)
    subscriber.wake?.()
  }

  /** A channel the forwarder closed itself, after a lost frame or a failed receiver, no longer binds its opening scope. */
  private disown(rx: FrameRxId): void {
    const owner = this.owners.get(rx)
    if (owner === undefined) return
    void Promise.resolve(owner()).catch(() => {
      // The forwarder reports the teardown failure of a channel it closed itself.
    })
  }

  private endSubscriber(): void {
    const subscriber = this.subscriber
    this.subscriber = undefined
    if (subscriber === undefined) return
    subscriber.ended = true
    subscriber.wake?.()
  }

  async capabilities(): Promise<FrameForwardingCapabilities> {
    if (this.forwarder === undefined) return { supported: false, reason: this.missingReceiver() ? 'receiver-unavailable' : this.unavailable }
    return this.forwarder.capabilities()
  }

  async channel(): Promise<FrameChannel> {
    const forwarder = this.frames()
    const channel = await forwarder.channel()
    const { rx } = channel
    try {
      // `this.ctx` is the scope that read this service, so disposing that scope closes the channel.
      const dispose = this.ctx.effect(() => () => {
        this.owners.delete(rx)
        return this.forwarder?.close(rx)
      }, 'frameForwarding.channel()')
      this.owners.set(rx, dispose)
    } catch (error) {
      await forwarder.close(rx)
      throw error
    }
    return channel
  }

  isOpen(rx: FrameRxId): boolean { return this.forwarder?.isOpen(rx) ?? false }

  async close(rx: FrameRxId): Promise<void> {
    const owner = this.owners.get(rx)
    if (owner !== undefined) await owner()
    else await this.forwarder?.close(rx)
  }

  /**
   * Keep the renderer's physical viewport for a channel and apply it to the channel's producer connection; if submitted
   * before the producer connects, it is applied on connection before its frames are delivered.
   * @param rx - A channel the renderer consumes.
   * @param viewport - Physical pixel size, scale, and visibility with a strictly increasing version.
   * @returns The acknowledging connection, the Host's retained version for a stale submission, or why no producer acknowledged it.
   */
  @Remote
  async viewport(rx: FrameRxId, viewport: FrameForwardingViewport): Promise<FrameViewportResult> {
    return this.frames().setViewport(rx, viewport)
  }

  /**
   * Deliver channel states and frame errors to the current renderer, starting with a snapshot of every channel.
   * Each subscription replaces the previous one.
   * @param signal - Subscriber lifetime.
   * @returns The snapshot, then states and errors until replacement, cancellation, or disposal.
   */
  @Remote({ mode: 'stream' })
  async *events(signal: AbortSignal): AsyncIterable<FrameForwardingEvent> {
    this.endSubscriber()
    const subscriber = {
      events: [{ kind: 'snapshot', channels: this.forwarder?.snapshot() ?? [] }] as FrameForwardingEvent[],
      wake: undefined as (() => void) | undefined,
      ended: false,
    }
    this.subscriber = subscriber
    const abort = (): void => { subscriber.wake?.() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (!signal.aborted && !subscriber.ended) {
        const next = subscriber.events.shift()
        if (next !== undefined) { yield next; continue }
        await new Promise<void>((resolve) => { subscriber.wake = resolve })
        subscriber.wake = undefined
      }
    } finally {
      signal.removeEventListener('abort', abort)
      if (this.subscriber === subscriber) this.subscriber = undefined
    }
  }
}
