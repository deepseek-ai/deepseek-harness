/** A fake renderer-side frame-forwarding service for Office specs, built on the real bridge adapter and receive channel. */
import { vi, type Mock } from 'vitest'
import { brandNumber } from '@deepseek-ai/dsh-brand'
import type { SharedTextureClientExport, SharedTextureLease } from '@deepseek-ai/dsh-shared-texture/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { FrameDiscardedError } from '@deepseek-ai/dsh-frame-forwarding/src/client/errors.ts'
import { FrameRx } from '@deepseek-ai/dsh-frame-forwarding/src/client/rx.ts'
import { adaptFrameForwardingBridge, type FrameForwardingRemote } from '@deepseek-ai/dsh-frame-forwarding/src/client/wire.ts'
import type { FrameForwardingFrameLease } from '@deepseek-ai/dsh-frame-forwarding/src/client/api.ts'
import type { FrameForwardingClient } from '@deepseek-ai/dsh-frame-forwarding/client'
import type {
  FrameChannelState, FrameConnectionId, FrameFailureSource, FrameForwardingViewport, FrameRxId, FrameViewportResult,
} from '@deepseek-ai/dsh-frame-forwarding/types'

/** A borrowed frame whose independently owned clone can be submitted to a video track. */
export function fakeVideoFrame(): VideoFrame {
  return { close: vi.fn(), clone: fakeVideoFrame } as Partial<VideoFrame> as VideoFrame
}

/** Host state of one channel: its current producer connection and the viewport the Host keeps for it. */
interface FakeChannel {
  sequence: number
  connectionId: FrameConnectionId
  connected: boolean
  viewportVersion?: number
}

/** Spies over the Host viewport operation and channel closure, with delivery, producer, and failure injection. */
export interface FakeFrameForwarding {
  readonly client: FrameForwardingClient
  readonly textures: SharedTextureClientExport
  /** End the browser adapter and notify its mounted consumers. */
  dispose(): void
  /**
   * Resolves when the Host kept the viewport; without a result the connected producer acknowledges it. Resolve a
   * result to report another outcome, or reject or delay it to drive viewport barriers.
   */
  readonly setViewport: Mock<(rx: FrameRxId, viewport: FrameForwardingViewport) => Promise<FrameViewportResult | undefined>>
  /** Each receive channel's detachment from the bridge, spied so specs can observe retired receive channels. */
  readonly close: Mock<(rx: FrameRxId) => Promise<void>>
  /** Current producer connection of a channel; a channel the renderer connects to starts with connection 1. */
  connection(rx: FrameRxId): FrameConnectionId
  /** Deliver a frame as Desktop would, releasing it when no consumer is registered. */
  receive(lease: FrameForwardingFrameLease): void
  /**
   * Report a frame failure, by default the producer's own, of the channel's current producer connection or of
   * `connectionId`.
   */
  fail(rx: FrameRxId, message: string, source?: FrameFailureSource, requestId?: string, connectionId?: FrameConnectionId): void
  /** Close the channel as Desktop does after it lost one of the channel's presented frames. */
  lose(rx: FrameRxId): void
  /** Deliver the Host's normal channel closure on document release. */
  released(rx: FrameRxId): void
}

/** jsdom has no Fullscreen API; this document shows one element fullscreen at a time and reports each change. */
export interface FakeFullscreen {
  /** Make `element`, or no element, the fullscreen element and dispatch `fullscreenchange`. */
  change(element: Element | null): void
  /** The document's `exitFullscreen`, which leaves fullscreen. */
  readonly exit: Mock<() => Promise<void>>
  /** Remove the stand-in from the document and its elements. */
  restore(): void
}

/**
 * Install a Fullscreen API on the jsdom document: `requestFullscreen` makes its element fullscreen.
 * @returns The stand-in's controls.
 */
export function fakeFullscreen(): FakeFullscreen {
  let current: Element | null = null
  const change = (element: Element | null): void => {
    current = element
    document.dispatchEvent(new Event('fullscreenchange'))
  }
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => current })
  const exit = vi.fn(async () => { change(null) })
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exit })
  Object.defineProperty(Element.prototype, 'requestFullscreen', {
    configurable: true, value: async function (this: Element) { change(this) },
  })
  return {
    change, exit,
    restore: () => {
      for (const property of ['fullscreenElement', 'exitFullscreen']) Reflect.deleteProperty(document, property)
      Reflect.deleteProperty(Element.prototype, 'requestFullscreen')
    },
  }
}

/**
 * Build the fake service.
 * @returns Spies and injectors around a real bridge adapter.
 */
export function fakeFrameForwarding(): FakeFrameForwarding {
  let consumer: ((lease: SharedTextureLease) => void) | undefined
  const textures: SharedTextureClientExport = {
    onFrame: (listener) => {
      consumer = listener
      return () => { if (consumer === listener) consumer = undefined }
    },
  }
  const channels = new Map<FrameRxId, FakeChannel>()
  const channel = (rx: FrameRxId): FakeChannel => {
    const known = channels.get(rx)
    if (known === undefined) throw new Error(`Unknown fake channel ${rx}.`)
    return known
  }
  const publish = (rx: FrameRxId, state: FrameChannelState): void => {
    bridge.apply({ kind: 'state', rx, sequence: ++channel(rx).sequence, channel: state })
  }
  const connected = (rx: FrameRxId): void => {
    const { connectionId, viewportVersion } = channel(rx)
    publish(rx, { state: 'connected', connectionId, ...viewportVersion === undefined ? {} : { viewportVersion } })
  }
  const setViewport = vi.fn<(rx: FrameRxId, viewport: FrameForwardingViewport) => Promise<FrameViewportResult | undefined>>(
    async () => undefined)
  const remote: FrameForwardingRemote = {
    viewport: async (rx, viewport) => {
      let result: FrameViewportResult | undefined
      try {
        result = await setViewport(rx, viewport)
      } catch (error) {
        return { ok: false, error: new RemoteError('gateway/internal', error instanceof Error ? error.message : String(error), {}) }
      }
      const state = channel(rx)
      state.viewportVersion = viewport.version
      if (result !== undefined) return { ok: true, value: result }
      if (!state.connected) return { ok: true, value: { applied: false, reason: 'no-producer' } }
      connected(rx)
      return { ok: true, value: { applied: true, connectionId: state.connectionId } }
    },
  }
  const bridge = adaptFrameForwardingBridge(textures, remote)
  const attach = bridge.attach.bind(bridge)
  const close = vi.fn<(rx: FrameRxId) => Promise<void>>(async () => {})
  bridge.attach = (rx, receiver) => {
    const detach = attach(rx, receiver)
    return () => { void close(rx); detach() }
  }
  const client: FrameForwardingClient = {
    connect: (rx) => {
      if (!channels.has(rx)) {
        channels.set(rx, { sequence: 0, connectionId: brandNumber<FrameConnectionId>(1), connected: true })
        connected(rx)
      }
      return new FrameRx(rx, bridge)
    },
    discardReason: error => error instanceof FrameDiscardedError ? error.reason : undefined,
  }
  return {
    client, textures, setViewport, close, dispose: () => { bridge.dispose() },
    connection: rx => channel(rx).connectionId,
    receive: (lease) => {
      const texture: SharedTextureLease = { frame: lease.frame, metadata: lease.metadata, release: () => { lease.release() } }
      if (consumer === undefined) texture.release()
      else consumer(texture)
    },
    fail: (rx, message, source = 'producer', requestId, connectionId = channel(rx).connectionId) => {
      bridge.apply({ kind: 'error', rx, connectionId, source, ...requestId === undefined ? {} : { requestId }, error: message })
    },
    lose: (rx) => { publish(rx, { state: 'closed', cause: 'lost', reason: 'Desktop invalidated a presented frame' }) },
    released: (rx) => { publish(rx, { state: 'closed', cause: 'closed', reason: 'Document released' }) },
  }
}
