/** Browser-safe frame-forwarding values: channel identity and state, viewports, frame metadata, and the `frameForwarding` Remote. */
import type { Branded, BrandedNumber } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-typert-protocol'

/** Host-issued identity of one receive channel; it survives producer switches and is invalid after the channel closes. */
export type FrameRxId = Branded<'FrameRxId'>

/** Increasing identity of one producer connection within its channel; a channel never reuses one. */
export type FrameConnectionId = BrandedNumber<'FrameConnectionId'>

/** Physical size and display state of one viewport version; frames of another `version` are discarded. */
export interface FrameForwardingViewport {
  readonly version: number
  readonly width: number
  readonly height: number
  readonly deviceScaleFactor: number
  readonly visible: boolean
}

/**
 * Identity of one delivered frame, carried as the Desktop shared-texture metadata; `generation` is the viewport
 * version the producer rendered for, and `connectionId` the producer connection that rendered it.
 */
export interface FrameForwardingFrameMetadata {
  readonly rx: FrameRxId
  readonly connectionId: FrameConnectionId
  /** Producer-echoed correlation identifier chosen by the requesting feature. */
  readonly requestId: string
  readonly frameId: number
  readonly generation: number
  readonly revision: number
  readonly width: number
  readonly height: number
}

/**
 * Native frame support of the running Host. `reason` explains `supported: false` for diagnostics; its values are not a
 * closed set, so consumers branch only on `supported`.
 */
export interface FrameForwardingCapabilities {
  readonly supported: boolean
  readonly reason?: string
}

/**
 * Why a channel closed. `closed`: its owner closed it. `lost`: Desktop could no longer account for a frame it
 * presented, after a committed navigation, a renderer or GPU process exit, window closure, or the loss of Desktop's
 * channel, so the channel stopped before its producer could write that frame again; the owner opens a new channel to
 * continue. `failed`: its receiver stopped accepting producers.
 */
export type FrameChannelCloseCause = 'closed' | 'lost' | 'failed'

/**
 * Producer state of one channel. `idle`: no producer is connected. `connected`: connection `connectionId` serves the
 * channel, and `viewportVersion` is the newest channel viewport it acknowledged. `draining`: that connection ended and
 * its frames are being released; a successor connects only afterwards, and `blocked` reports GPU work of unknown
 * completion that holds the drain. `closed`: terminal, with its cause.
 */
export type FrameChannelState =
  | { readonly state: 'idle' }
  | { readonly state: 'connected'; readonly connectionId: FrameConnectionId; readonly viewportVersion?: number }
  | { readonly state: 'draining'; readonly connectionId: FrameConnectionId; readonly blocked?: string }
  | { readonly state: 'closed'; readonly cause: FrameChannelCloseCause; readonly reason: string }

/**
 * Where a frame failed. `producer`: the producer reported a rendering failure or sent an invalid message or frame.
 * `presentation`: Desktop could not present a frame the producer delivered.
 */
export type FrameFailureSource = 'producer' | 'presentation'

/** One channel's state with the Host sequence number it was published under. */
export interface FrameChannelSnapshot {
  readonly rx: FrameRxId
  /** Increases with every state the Host publishes; within one subscription a higher number is newer. */
  readonly sequence: number
  readonly channel: FrameChannelState
}

/** Items of the `frameForwarding` event stream. */
export type FrameForwardingEvent =
  /**
   * The state of each channel: the first item of every subscription, and later in place of unread events beyond the
   * Host's queue limit, which keeps the unread closures of channels the Host has since forgotten. A channel known
   * before and absent from it closed while no subscription was open.
   */
  | { readonly kind: 'snapshot'; readonly channels: readonly FrameChannelSnapshot[] }
  | ({ readonly kind: 'state' } & FrameChannelSnapshot)
  /**
   * A frame of connection `connectionId` failed at `source`; `requestId` names the frame's request when the failure
   * concerns one frame.
   */
  | {
    readonly kind: 'error'
    readonly rx: FrameRxId
    readonly connectionId: FrameConnectionId
    readonly source: FrameFailureSource
    readonly requestId?: string
    readonly error: string
  }

/**
 * Outcome of one renderer viewport. A stale submission leaves the Host's retained viewport intact and returns its
 * version. For a newer submission the Host keeps the viewport even if the producer changes before acknowledging it.
 */
export type FrameViewportResult =
  | { readonly applied: true; readonly connectionId: FrameConnectionId }
  | { readonly applied: false; readonly reason: 'no-producer' | 'producer-changed' }
  | { readonly applied: false; readonly reason: 'stale-viewport'; readonly currentVersion: number }
