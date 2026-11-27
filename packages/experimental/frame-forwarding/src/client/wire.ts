/**
 * Shared-frame routing, channel states, failure containment, and the document's fullscreen holder over the Client
 * `sharedTexture` service, the `frameForwarding` Remote, and the document's Fullscreen API.
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
 * A channel's hold on the document's fullscreen, from its first request until fullscreen ends while none of its
 * requests is pending, or until its last request settles while none of its elements has been the fullscreen element.
 * The document reports only its topmost fullscreen element, so the hold lasts until fullscreen ends once the channel
 * has shown an element, also while another element covers it or after the channel left it.
 */
interface FullscreenHolder {
  readonly rx: FrameRxId
  /**
   * Every element the channel requested since it took the document's fullscreen: Chromium keeps an earlier fullscreen
   * element below a later one, so an exit can reveal one of them.
   */
  readonly elements: Set<Element>
  /** The channel's requests that have not settled. */
  pending: number
  /** Settles once every request the channel made so far does, whether or not the document accepted it. */
  entry: Promise<unknown>
  /** One of the channel's elements became the fullscreen element since the document entered fullscreen. */
  shown: boolean
  /** The channel's latest exit; exits run one at a time, because each checks the element on top before leaving it. */
  leaving: Promise<void>
}

/**
 * Adapt the shared-texture bridge and the Host Remote once per Client before connecting receive channels. The bridge
 * is the document's texture consumer from creation until `dispose`, also while no channel is open.
 * @param textures - The Client `ctx.sharedTexture` bridge; throws when another consumer holds it.
 * @param remote - The Host's `frameForwarding` Remote namespace.
 * @param document - The product document, whose fullscreen element channels request and observe.
 * @returns Channel transport; each delivered lease is released once by the receive channel that holds it.
 */
export function adaptFrameForwardingBridge(
  textures: SharedTextureClientExport, remote: FrameForwardingRemote, document: Document,
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
  /** The channel holding the document's fullscreen. */
  let holder: FullscreenHolder | undefined
  const deliver = (lease: SharedTextureLease): void => {
    const metadata = frameMetadata(lease.metadata)
    const route = metadata === undefined ? undefined : routes.get(metadata.rx)
    if (metadata === undefined || route === undefined) { lease.release(); return }
    route.onFrame({ frame: lease.frame, metadata, release: () => { lease.release() } })
  }
  /** The document changes its fullscreen element on its own, for example on Escape, so every check reads it anew. */
  const fullscreenElement = (): Element | null => document.fullscreenElement
  const fullscreenActive = (): boolean => fullscreenElement() !== null
  /** The holder counts only while one of its channel's elements is the fullscreen element. */
  const fullscreenHolder = (): FrameRxId | undefined => {
    const shown = fullscreenElement()
    return holder !== undefined && shown !== null && holder.elements.has(shown) ? holder.rx : undefined
  }
  /** Record that the document shows the holder's element; the document reports an entry before its event. */
  const noteShown = (): void => {
    if (holder !== undefined && fullscreenHolder() === holder.rx) holder.shown = true
  }
  const fullscreenChanged = (): void => {
    const active = fullscreenActive()
    noteShown()
    // Only a channel whose element was fullscreen held a fullscreen that could end; a pending request held nothing yet.
    const owner = active ? fullscreenHolder() : holder?.shown === true ? holder.rx : undefined
    if (holder !== undefined && !active) {
      holder.shown = false
      // A pending request can still enter fullscreen, so its settlement decides whether the hold ends.
      if (holder.pending === 0) holder = undefined
    }
    for (const rx of [...routes.keys()]) routes.get(rx)?.onEvent({ kind: 'fullscreen', active, holder: rx === owner })
  }
  /**
   * Leave the fullscreen `held` entered once its requests settle, while `owns` still reports its hold, and then each
   * element of that channel that the exit reveals. Each exit waits for the hold's previous one and reads the document
   * anew: two exits that both saw the channel's element on top would otherwise also leave the element below it.
   */
  const leave = (held: FullscreenHolder, owns: () => boolean): Promise<void> => {
    const run = async (): Promise<void> => {
      // An exit during a pending entry would otherwise let the entry complete afterwards.
      await held.entry
      for (let remaining = held.elements.size; remaining > 0; remaining--) {
        const shown = fullscreenElement()
        if (!owns() || shown === null || !held.elements.has(shown)) return
        try {
          await document.exitFullscreen()
        } catch (error) {
          // Chromium leaves fullscreen on Escape itself; an exit that lost that race has nothing left to do.
          if (fullscreenActive()) throw error
          return
        }
      }
    }
    // The previous exit's outcome belongs to its caller; this one starts after it either way.
    held.leaving = held.leaving.then(run, run)
    return held.leaving
  }
  const exitFullscreen = async (rx: FrameRxId): Promise<void> => {
    const held = holder
    if (held?.rx === rx) await leave(held, () => holder === held)
  }
  const endRoutes = (event: Extract<FrameRxEvent, { kind: 'failure' }>): void => {
    const active = [...routes.values()]
    routes.clear()
    for (const route of active) route.onEvent(event)
  }
  const unsubscribe = textures.onFrame(deliver)
  document.addEventListener('fullscreenchange', fullscreenChanged)
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
      if (failure !== undefined) { onEvent(failure); return async () => {} }
      if (routes.has(rx)) throw new Error('Native channel already has a frame consumer')
      let leaving: Promise<void> | undefined
      const detach = async (): Promise<void> => {
        if (routes.get(rx) === route) {
          routes.delete(rx)
          // A closed channel publishes no further state, so its closure stays only for the consumer that saw it.
          if (states.get(rx)?.channel.state === 'closed') states.delete(rx)
          leaving = exitFullscreen(rx).catch((error: unknown) => { console.error('Native channel fullscreen exit failed', error) })
        }
        await leaving
      }
      const route: FrameChannelReceiver = {
        onEvent,
        onFrame(lease) {
          try { receiver.onFrame(lease) } catch (error) {
            lease.release()
            if (routes.get(rx) !== route) return
            void detach()
            onEvent({ kind: 'failure', error: error instanceof Error ? error.message : String(error) })
          }
        },
      }
      routes.set(rx, route)
      const known = states.get(rx)
      if (known !== undefined) onEvent({ kind: 'state', channel: known.channel })
      if (fullscreenActive()) onEvent({ kind: 'fullscreen', active: true, holder: rx === fullscreenHolder() })
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
    requestFullscreen(rx, element) {
      if (failure !== undefined) return Promise.reject(new Error(failure.error))
      if (holder !== undefined && holder.rx !== rx) return Promise.reject(new Error('Another native channel holds fullscreen.'))
      // The holder is known before the document reports the change.
      const held = holder ??= {
        rx, elements: new Set<Element>(), pending: 0, entry: Promise.resolve(), shown: false, leaving: Promise.resolve(),
      }
      held.elements.add(element)
      held.pending += 1
      const entry = element.requestFullscreen()
      const settle = (): void => {
        held.pending -= 1
        if (holder !== held) return
        noteShown()
        // A refused request leaves whatever the channel's other requests showed, covered or not; the hold ends once
        // none is pending and none of the channel's elements was fullscreen.
        if (held.pending === 0 && !held.shown) holder = undefined
      }
      const settled = entry.then(settle, settle)
      // Teardown waits for every request to settle; the returned request promise reports the rejection.
      held.entry = held.entry.then(() => settled)
      return entry
    },
    exitFullscreen,
    fail(message) {
      if (disposed || failure !== undefined) return
      const event = { kind: 'failure', error: message } as const
      failure = event
      states = new Map()
      // Textures arriving later have no consumer, so `deliver` releases them; delivered leases stay with their holders.
      endRoutes(event)
      const held = holder
      holder = undefined
      // A failed bridge refuses fullscreen requests, so no later holder replaces the one it leaves.
      if (held !== undefined) void leave(held, () => true).catch((error: unknown) => { console.error('Native channel fullscreen exit failed', error) })
    },
    dispose() {
      disposed = true
      endRoutes({ kind: 'failure', error: 'Frame-forwarding Client disposed.' })
      unsubscribe()
      document.removeEventListener('fullscreenchange', fullscreenChanged)
      if (holder !== undefined) {
        void exitFullscreen(holder.rx).catch((error: unknown) => { console.error('Native channel fullscreen exit failed', error) })
      }
    },
  }
  return bridge
}
