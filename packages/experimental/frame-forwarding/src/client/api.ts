/**
 * Public renderer-side frame-forwarding types. This module imports no Desktop module, so the package's published
 * declarations expose frame forwarding only.
 */
import type {
  FrameChannelState, FrameConnectionId, FrameFailureSource, FrameForwardingEvent, FrameForwardingFrameMetadata, FrameForwardingViewport,
  FrameRxId, FrameViewportResult,
} from '../types.ts'
import type { FrameDiscardedError } from './errors.ts'
import type { FrameRx } from './rx.ts'

/**
 * One forwarded frame lent to a consumer callback until the callback returns or its returned promise settles. Frame
 * forwarding then closes `image`, which returns its resources to the Host; a Desktop shared texture returns to the
 * producer only after Desktop reports every Electron reference gone, which follows completion of the GPU work submitted
 * with `image`. Draw, upload, or copy `image` within that period; a retained `image` or clone keeps its resources in use
 * until it is closed. How `image` is backed and its pixel `format` depend on the Host, so read pixels only through
 * `drawImage`, or through `copyTo` with an explicit `format`.
 */
export interface FrameForwardingFrame {
  readonly image: VideoFrame
  readonly metadata: FrameForwardingFrameMetadata
}

/** A delivered texture and its single release, owned by the receive channel that received it. */
export interface FrameForwardingFrameLease {
  readonly frame: VideoFrame
  readonly metadata: FrameForwardingFrameMetadata
  release(): void
}

/** Options for {@link FrameRx.mount}. */
export interface FrameMountOptions {
  /** Initial explicit visibility of the mounted view; defaults to `true`. */
  readonly visible?: boolean
}

/** Content coordinate at the mount's top-left corner and CSS pixels per content unit; scale is in (0, 64]. */
export interface FrameContentView {
  readonly x: number
  readonly y: number
  readonly scale: number
}

/** Immutable content rectangle covered by every frame of one viewport generation; extents are in (0, 2^24]. */
export interface FrameContentWindow {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * What one receive channel learns besides frames: its latest Host state, a frame failure of its connection, a
 * renderer-side failure that ends the channel's frame routing (including termination of the Client's channel-event
 * stream and Client disposal), or mounted presentation state.
 * FrameRx.onEvent replays state, viewport, and submitted generation on subscription.
 */
export type FrameRxEvent =
  | { readonly kind: 'state'; readonly channel: FrameChannelState }
  /** Latest viewport version, published before its Host request is sent. */
  | { readonly kind: 'viewport'; readonly viewport: FrameForwardingViewport }
  | {
    readonly kind: 'error'
    readonly connectionId: FrameConnectionId
    readonly source: FrameFailureSource
    readonly requestId?: string
    readonly error: string
  }
  | { readonly kind: 'failure'; readonly error: string }
  /** Emitted for each video track write, including same-generation repaints, and once when submitted content clears. */
  | { readonly kind: 'content'; readonly submittedGeneration: number | undefined }

/** The frame and event callbacks of one attached receive channel. */
export interface FrameChannelReceiver {
  readonly onFrame: (lease: FrameForwardingFrameLease) => void
  readonly onEvent: (event: FrameRxEvent) => void
}

/** Channel-scoped frame transport over the textures the Host forwards and the Host's `frameForwarding` Remote. */
export interface FrameForwardingBridge {
  /** Send a viewport to the Host, which keeps it for the channel and applies it to the producer connection. */
  setViewport(rx: FrameRxId, viewport: FrameForwardingViewport): Promise<FrameViewportResult>
  /**
   * Attach one receiver and synchronously replay its known channel state.
   * @param rx - Channel receiving frames and events from its producer connection.
   * @param receiver - Owns each delivered lease. A throwing frame callback loses its lease and registration.
   * @returns Detach this registration immediately. Delivered leases stay with their holders.
   */
  attach(rx: FrameRxId, receiver: FrameChannelReceiver): () => void
  /** Apply one item of the Host's event stream; a snapshot replaces every known state. Ignored after `fail`. */
  apply(event: FrameForwardingEvent): void
  /**
   * Report failure to every known channel; later subscriptions receive the failure at once. Afterwards the bridge
   * forgets every channel state, releases arriving textures, ignores Host events, and rejects viewports. Repeated
   * calls and calls after `dispose` do nothing.
   * @param message - Failure text every channel receives.
   */
  fail(message: string): void
  /** Stop texture delivery for every channel. */
  dispose(): void
}

/** Renderer-side frame forwarding; consumers connect to channels their Host plugin opened. */
export interface FrameForwardingClient {
  /**
   * Connect the renderer to a Host-opened channel; the returned receive channel serves that channel's producer
   * connection, and the Host's per-channel frame limit bounds every frame it holds.
   * @param rx - Channel the consumer's Host plugin opened.
   * @returns The receive channel, which the consumer closes.
   */
  connect(rx: FrameRxId): FrameRx
  /**
   * Classify a rejected frame wait. Consumers in other Client bundles cannot import this package's error class.
   * @param error - Rejection of a channel operation such as `ready` or `setViewport`.
   * @returns The lifecycle event that made the frame unnecessary, or undefined for a transport, producer, or consumer failure.
   */
  discardReason(error: unknown): FrameDiscardedError['reason'] | undefined
}
