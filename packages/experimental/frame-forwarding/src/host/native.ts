/** Host binding to the frame-forwarding receiver addon shipped with Desktop. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute } from 'node:path'
import type { FrameConnectionId } from '../types.ts'

/**
 * Wire protocol version the receiver accepts; it equals `DSH_FRAME_FORWARDING_PROTOCOL_VERSION`
 * in the receiver transport header, which the build records beside the addon. Protocol 2 sends each packet as
 * a fixed header followed by only the bytes of its text; protocol 1 sent every packet at its full fixed size.
 */
export const FRAME_FORWARDING_PROTOCOL_VERSION = 2

/**
 * Handshake capabilities the receiver requires of producers, as declared in the addon build record; a
 * protocol 1 addon built before transferable channels records none and does not load.
 */
export const FRAME_FORWARDING_CAPABILITIES: readonly string[] = ['transferable-tx', 'producer-local-handles']

/** Adapter identity valid for the current OS GPU devices. */
export type FrameForwardingAdapterId = string & { readonly __frameForwardingAdapterId: unique symbol }
/** Receiver-owned delivery identity; independent of reusable producer frame IDs. */
export type FrameForwardingDeliveryId = number & { readonly __frameForwardingDeliveryId: unique symbol }

/** Receiver notifications, delivered on the JavaScript thread; each connection event names its connection. */
export type FrameForwardingReceiverEvent =
  /** A producer holding the credential received ready; its frames follow. */
  | { type: 'connected'; connectionId: FrameConnectionId; pid: number }
  | {
    type: 'frame'
    connectionId: FrameConnectionId
    frameId: number
    deliveryId: FrameForwardingDeliveryId
    width: number
    height: number
    stride: number
    metadata: string
    adapterId: FrameForwardingAdapterId
    transport: 'shared-texture'
    /** Host-local `IOSurfaceRef` or NT handle, retained by the receiver until `release`. */
    handle: Buffer
    /** Source descriptor declares key-0 synchronization; false on macOS. */
    sourceKeyedMutex: boolean
    /** Windows adapter owning the output texture; null for macOS IOSurface. */
    presentationAdapterId: FrameForwardingAdapterId | null
  }
  | { type: 'message'; connectionId: FrameConnectionId; text: string }
  /**
   * The receiver could not present a frame through the attached Desktop sink: `producer` for invalid frame metadata,
   * `presentation` when Desktop refused or failed to deliver it. `requestId` names the frame's request when known.
   */
  | {
    type: 'presentation-error'
    connectionId: FrameConnectionId
    source: 'producer' | 'presentation'
    requestId?: string
    text: string
  }
  /** Desktop invalidated a frame presented through the attached sink; the receiver is stopping. */
  | { type: 'presentation-invalidated'; connectionId: FrameConnectionId; text?: string }
  /** The producer left or failed; `text` is absent after its goodbye. Delivered frames stay valid while the connection drains. */
  | { type: 'disconnected'; connectionId: FrameConnectionId; text?: string }
  /** Every frame and resource of the connection was released; a waiting successor connects next. */
  | { type: 'drained'; connectionId: FrameConnectionId }
  /** GPU completion is unknown, so the connection keeps its resources and budget and its drain waits. */
  | { type: 'drain-blocked'; connectionId: FrameConnectionId; text: string }
  /**
   * A candidate was refused: channel-busy, transferable-tx-required, producer-local-handles-required, invalid-credential,
   * channel-closed, or a setup failure.
   */
  | { type: 'rejected'; text: string }
  /** The channel stopped accepting producers. */
  | { type: 'failed'; text: string }

/**
 * One channel's receiver; delivered frames stay retained until `release`. While a Desktop sink is attached, the
 * receiver presents each frame through it in native code and releases it when Desktop settles the texture, so only
 * frames that arrive without an attached sink reach `onEvent`.
 */
export interface FrameForwardingReceiver {
  /** Producer credential; any process holding a copy may connect. */
  readonly tx: string
  /** Send JSON to one connection; throws unless it is the connected one, or when larger than 16383 UTF-8 bytes. */
  send(connectionId: FrameConnectionId, json: string): void
  /** Release after Desktop settled the texture; credit returns only to the frame's own connection. A duplicate release returns false. */
  release(deliveryId: FrameForwardingDeliveryId): boolean
  /**
   * Present later frames through a Desktop shared-texture sink, replacing an attached one. The receiver detaches the
   * sink when it loses its connection, so later frames reach `onEvent` until a sink is attached again; a frame Desktop
   * refuses leaves the sink attached.
   * @param rx - Channel identity of 1 to 128 printable ASCII characters, carried in each frame's metadata.
   * @param sink - The sink external Desktop's `nativeSink` returned; throws for another value or ABI version.
   * @param timeoutMs - Delivery deadline of each presentation, 1 to 30 000 ms.
   */
  attachSink(rx: string, sink: unknown, timeoutMs: number): void
  /**
   * Set which frames the attached sink presents: frames of `connectionId` whose generation is at most
   * `maxGeneration` while `visible`. Other frames, and every frame while the state is null, are released unpresented.
   * @param state - The presentation gate, or null to present nothing.
   */
  setDeliverable(state: { connectionId: FrameConnectionId; visible: boolean; maxGeneration: number } | null): void
  /**
   * Stop accepting producers and end the current connection at once, then await GPU completion or confirmed device
   * removal and worker exit. Delivered frames remain owned until released; a stalled driver can leave this promise pending.
   */
  close(): Promise<void>
}

/** Allocation budget shared by every receiver of one window, including producer idle surface pools. */
export interface FrameForwardingBudget { readonly __frameForwardingBudget: unique symbol }

/** Receiver options for one channel. */
export interface FrameForwardingReceiverOptions {
  maxFrames: number
  maxBytes: number
  budget: FrameForwardingBudget
  /** Electron's display adapter for Windows shared textures; null on macOS. */
  displayAdapter: FrameForwardingAdapterId | null
  /** Queued GPU readback and upload deadline, also bounding a connecting producer's handshake; expiry ends the connection. */
  readbackTimeoutMs: number
}

/** Receiver operations of the loaded addon. */
export interface FrameForwardingBindings {
  createBudget(maxBytes: number): FrameForwardingBudget
  createReceiver(options: FrameForwardingReceiverOptions, onEvent: (event: FrameForwardingReceiverEvent) => void): FrameForwardingReceiver
}

/** Events as the addon dispatches them: `presentation-error` carries its fields as JSON `text`. */
type AddonEvent =
  | Exclude<FrameForwardingReceiverEvent, { type: 'presentation-error' }>
  | { type: 'presentation-error'; connectionId: FrameConnectionId; text: string }

interface Addon {
  createBudget(maxBytes: number): object
  create(maxFrames: number, maxBytes: number, onEvent: (event: AddonEvent) => void, budget: object,
    displayAdapter: string, readbackTimeoutMs: number): { native: object; tx: string }
  send(native: object, connectionId: number, json: string): void
  release(native: object, deliveryId: number): boolean
  attachSink(native: object, rx: string, sink: unknown, timeoutMs: number): void
  setDeliverable(native: object, state: { connectionId: number; visible: boolean; maxGeneration: number } | null): void
  close(native: object): Promise<void>
}

/** Read `{ source, requestId?, error }` from the addon's event text; other text is a presentation failure. */
function presentationError(
  { connectionId, text }: Extract<AddonEvent, { type: 'presentation-error' }>,
): Extract<FrameForwardingReceiverEvent, { type: 'presentation-error' }> {
  let fields: unknown
  try {
    fields = JSON.parse(text)
  } catch {
    return { type: 'presentation-error', connectionId, source: 'presentation', text }
  }
  if (typeof fields !== 'object' || fields === null || !('source' in fields) || !('error' in fields)
    || (fields.source !== 'producer' && fields.source !== 'presentation') || typeof fields.error !== 'string') {
    return { type: 'presentation-error', connectionId, source: 'presentation', text }
  }
  const requestId = 'requestId' in fields && typeof fields.requestId === 'string' ? { requestId: fields.requestId } : {}
  return { type: 'presentation-error', connectionId, source: fields.source, ...requestId, text: fields.error }
}

function recordCapabilities(record: object): readonly unknown[] | undefined {
  return 'capabilities' in record && Array.isArray(record.capabilities) ? record.capabilities : undefined
}

/**
 * Load the receiver addon after checking the build record beside it.
 * @param path - Desktop-owned addon file; its record has the same name with a `.json` extension.
 * @returns Receiver operations; throws when the addon or its record is absent, or the record names another platform,
 *   protocol version, or set of handshake capabilities.
 */
export function loadFrameForwardingBindings(path: string): FrameForwardingBindings {
  if (!isAbsolute(path)) throw new Error('Desktop frame receiver path must be absolute')
  const record: unknown = JSON.parse(readFileSync(path.replace(/\.[^./\\]+$/u, '.json'), 'utf8'))
  const platform = `${process.platform}-${process.arch}`
  const capabilities = typeof record === 'object' && record !== null ? recordCapabilities(record) : undefined
  if (typeof record !== 'object' || record === null || !('platform' in record) || record.platform !== platform
    || !('protocolVersion' in record) || record.protocolVersion !== FRAME_FORWARDING_PROTOCOL_VERSION
    || capabilities === undefined || JSON.stringify(capabilities) !== JSON.stringify(FRAME_FORWARDING_CAPABILITIES)) {
    throw new Error(`Frame-forwarding receiver at ${path} was not built for ${platform} at protocol version ${String(FRAME_FORWARDING_PROTOCOL_VERSION)} with ${FRAME_FORWARDING_CAPABILITIES.join(', ')}; install a compatible Desktop build`)
  }
  const addon = createRequire(import.meta.url)(path) as Addon
  const budgets = new WeakMap<FrameForwardingBudget, object>()
  return {
    createBudget(maxBytes) {
      const budget = Object.freeze({}) as FrameForwardingBudget
      budgets.set(budget, addon.createBudget(maxBytes))
      return budget
    },
    createReceiver({ maxFrames, maxBytes, budget, displayAdapter, readbackTimeoutMs }, onEvent) {
      const allocation = budgets.get(budget)
      if (allocation === undefined) throw new TypeError('Receiver requires a budget from createBudget()')
      const { native, tx } = addon.create(maxFrames, maxBytes, (event) => {
        onEvent(event.type === 'presentation-error' ? presentationError(event) : event)
      }, allocation, displayAdapter ?? '', readbackTimeoutMs)
      let closed: Promise<void> | undefined
      return {
        tx,
        send(connectionId, json) { addon.send(native, connectionId, json) },
        release(deliveryId) { return addon.release(native, deliveryId) },
        attachSink(rx, sink, timeoutMs) { addon.attachSink(native, rx, sink, timeoutMs) },
        setDeliverable(state) { addon.setDeliverable(native, state) },
        close() { return closed ??= addon.close(native) },
      }
    },
  }
}
