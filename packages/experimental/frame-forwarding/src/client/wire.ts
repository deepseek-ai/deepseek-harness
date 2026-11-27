/**
 * Shared-frame routing, channel states, and failure containment over the Client `sharedTexture` service and the
 * `frameForwarding` Remote.
 */
import type { SharedTextureClientExport, SharedTextureLease } from '@deepseek-ai/dsh-shared-texture/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {
  FrameChannelSnapshot, FrameConnectionId, FrameForwardingFrameMetadata, FrameForwardingViewport, FrameRxId,
  FrameViewportResult,
} from '../types.ts'
import type { FrameChannelReceiver, FrameForwardingBridge, FrameRxEvent } from './api.ts'

/** The `frameForwarding` Remote operation the bridge needs. */
export interface FrameForwardingRemote {
  viewport(rx: FrameRxId, viewport: FrameForwardingViewport): Promise<RemoteResult<FrameViewportResult>>
}

function natural(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Metadata crosses two process boundaries before the renderer reads it; a texture without frame metadata is released. */
function frameMetadata(value: unknown): FrameForwardingFrameMetadata | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { rx, connectionId, requestId, frameId, generation, revision, width, height } = value as Record<string, unknown>
  if (typeof rx !== 'string' || rx === '' || !natural(connectionId) || connectionId === 0 || typeof requestId !== 'string'
    || !natural(frameId) || !natural(generation) || !natural(revision) || !natural(width) || !natural(height)) {
    return undefined
  }
  return { rx: rx as FrameRxId, connectionId: connectionId as FrameConnectionId, requestId, frameId, generation, revision, width, height }
}

/**
 * A channel that closed while no subscription was open is absent from the next snapshot, without its cause. The
 * renderer cannot tell whether Desktop lost it, so it is reported `lost`; asking the owner for a replacement is harmless
 * when the owner closed or replaced it.
 */
const vanishedChannel: FrameRxEvent = {
  kind: 'state', channel: { state: 'closed', cause: 'lost', reason: 'Native channel closed while the renderer was not subscribed' },
}

/**
 * Closures kept for channels without a consumer, so that a late consumer still receives them. Between snapshots
 * nothing else forgets them, so the oldest beyond this count are dropped, and a later consumer of a dropped channel
 * receives no state for it.
 */
const maxUnattachedClosures = 64

/**
 * Adapt the shared-texture bridge and the Host Remote once per Client before connecting receive channels. The bridge
 * is the document's texture consumer from creation until `dispose`, also while no channel is open.
 * @param textures - The Client `ctx.sharedTexture` bridge; throws when another consumer holds it.
 * @param remote - The Host's `frameForwarding` Remote namespace.
 * @returns Channel transport; each delivered lease is released once by the receive channel that holds it.
 */
export function adaptFrameForwardingBridge(
  textures: SharedTextureClientExport, remote: FrameForwardingRemote,
): FrameForwardingBridge {
  const routes = new Map<FrameRxId, FrameChannelReceiver>()
  /** Latest state per channel, ordered by its arrival; a closed channel leaves once its consumer detaches. */
  let states = new Map<FrameRxId, FrameChannelSnapshot>()
  /** Drop the oldest closures of channels without a consumer beyond {@link maxUnattachedClosures}. */
  const boundClosures = (): void => {
    const unattached = [...states.values()].filter(({ rx, channel }) => channel.state === 'closed' && !routes.has(rx))
    for (const { rx } of unattached.slice(0, Math.max(0, unattached.length - maxUnattachedClosures))) states.delete(rx)
  }
  /** Set once by `fail`, which ends every channel; disposal ends the bridge without it. */
  let failure: Extract<FrameRxEvent, { kind: 'failure' }> | undefined
  let disposed = false
  const deliver = (lease: SharedTextureLease): void => {
    const metadata = frameMetadata(lease.metadata)
    const route = metadata === undefined ? undefined : routes.get(metadata.rx)
    if (metadata === undefined || route === undefined) { lease.release(); return }
    route.onFrame({ frame: lease.frame, metadata, release: () => { lease.release() } })
  }
  const endRoutes = (event: Extract<FrameRxEvent, { kind: 'failure' }>): void => {
    const active = [...routes.values()]
    routes.clear()
    for (const route of active) route.onEvent(event)
  }
  const unsubscribe = textures.onFrame(deliver)
  const bridge: FrameForwardingBridge = {
    async setViewport(rx, viewport) {
      if (failure !== undefined) throw new Error(failure.error)
      const result = await remote.viewport(rx, viewport)
      if (!result.ok) throw new Error(result.error.message)
      return result.value
    },
    attach(rx, receiver) {
      const onEvent = (event: FrameRxEvent): void => {
        try { receiver.onEvent(event) } catch (error) { console.error('Native channel listener failed', error) }
      }
      if (failure !== undefined) { onEvent(failure); return () => {} }
      if (routes.has(rx)) throw new Error('Native channel already has a frame consumer')
      const detach = (): void => {
        if (routes.get(rx) !== route) return
        routes.delete(rx)
        // A closed channel publishes no further state, so its closure stays only for the consumer that saw it.
        if (states.get(rx)?.channel.state === 'closed') states.delete(rx)
      }
      const route: FrameChannelReceiver = {
        onEvent,
        onFrame(lease) {
          try { receiver.onFrame(lease) } catch (error) {
            lease.release()
            if (routes.get(rx) !== route) return
            detach()
            onEvent({ kind: 'failure', error: error instanceof Error ? error.message : String(error) })
          }
        },
      }
      routes.set(rx, route)
      const known = states.get(rx)
      if (known !== undefined) onEvent({ kind: 'state', channel: known.channel })
      return detach
    },
    apply(event) {
      if (failure !== undefined) return
      switch (event.kind) {
        case 'snapshot': {
          const previous = states
          states = new Map(event.channels.map(channel => [channel.rx, channel]))
          // A channel known before and absent now closed while no subscription was open.
          for (const rx of previous.keys()) if (!states.has(rx)) routes.get(rx)?.onEvent(vanishedChannel)
          for (const { rx, channel } of event.channels) routes.get(rx)?.onEvent({ kind: 'state', channel })
          boundClosures()
          return
        }
        case 'state': {
          const known = states.get(event.rx)
          if (known !== undefined && known.sequence >= event.sequence) return
          const { rx, sequence, channel } = event
          // Reinsertion orders the map by each channel's latest state, so the bound drops the oldest closures first.
          states.delete(rx)
          states.set(rx, { rx, sequence, channel })
          routes.get(rx)?.onEvent({ kind: 'state', channel })
          if (channel.state === 'closed') boundClosures()
          return
        }
        case 'error': {
          const { rx, connectionId, source, requestId, error } = event
          routes.get(rx)?.onEvent({ kind: 'error', connectionId, source, ...requestId === undefined ? {} : { requestId }, error })
          return
        }
        /* v8 ignore next -- The Host stream's closed union is exhausted above. */
        default: return assertNever(event)
      }
    },
    fail(message) {
      if (disposed || failure !== undefined) return
      const event = { kind: 'failure', error: message } as const
      failure = event
      states = new Map()
      // Textures arriving later have no consumer, so `deliver` releases them; delivered leases stay with their holders.
      endRoutes(event)
    },
    dispose() {
      disposed = true
      endRoutes({ kind: 'failure', error: 'Frame-forwarding Client disposed.' })
      unsubscribe()
    },
  }
  return bridge
}
