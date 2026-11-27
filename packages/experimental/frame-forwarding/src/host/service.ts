/** The `frameForwarding` Host service operations, its Host-only channel values, and their Cordis Context declaration. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { FrameForwardingCapabilities, FrameRxId } from '../types.ts'

/**
 * Opaque, serializable credential that lets any process holding a copy connect a producer to one channel. It stays
 * in the Host and its producers: never send it to a renderer, log it, or put it in diagnostics.
 */
export type FrameTx = Branded<'FrameTx'>

/** One channel: the producer credential and the receive identity the renderer connects to. */
export interface FrameChannel {
  readonly tx: FrameTx
  readonly rx: FrameRxId
}

/**
 * Operations a Host plugin uses to render through channels; present while frame forwarding is loaded, so read it with
 * `ctx.get('frameForwarding')` and probe {@link FrameForwardingService.capabilities} before opening a channel.
 */
export interface FrameForwardingService {
  /**
   * Probe native frame support. Support ends when Desktop stops compositing on the GPU, for example after repeated GPU
   * process crashes, so probe again before opening a channel that replaces a `lost` one.
   * @returns Whether this Host can present native frames now; a diagnostic reason accompanies `false`.
   */
  capabilities(): Promise<FrameForwardingCapabilities>
  /**
   * Open a channel. It serves at most one producer connection: a producer started with `tx` connects, any second
   * candidate is refused while connected, and once the producer disconnects the channel closes permanently. A viewport
   * submitted before the producer connects is applied once it connects.
   * @returns The producer credential and the receive identity for the renderer.
   */
  channel(): Promise<FrameChannel>
  /**
   * Report whether a channel still serves producers and its renderer.
   * @param rx - Owned channel.
   * @returns False once {@link close}, a listener failure, or Desktop losing one of its presented frames closed it.
   */
  isOpen(rx: FrameRxId): boolean
  /**
   * Close a channel permanently: its credential stops connecting, the current connection ends, and the renderer sees
   * the channel closed. An unknown channel is already closed.
   * @param rx - Owned channel.
   * @returns Completion of native resource and connection teardown; presented frames stay owned until Desktop settles them.
   */
  close(rx: FrameRxId): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Native frame forwarding; absent unless it is loaded, and unsupported in a Host that cannot present frames. */
    frameForwarding: FrameForwardingService
  }
}
