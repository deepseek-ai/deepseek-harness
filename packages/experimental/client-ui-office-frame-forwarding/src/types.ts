/** Browser-safe values of the `officePreview` Remote namespace. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { FrameRxId } from '@deepseek-ai/dsh-frame-forwarding/types'
import type {} from '@deepseek-ai/dsh-typert-protocol'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The native document has been released and its identity cannot be reattached. */
    'office/document-expired': Record<string, never>
    /** Transient native frame rejection; the document stays usable and the Client retries its latest demand. */
    'office/frame-retry': {
      /** `stale` waits for viewport readiness; `credit-timeout` waits for a free frame surface with backoff. */
      readonly reason: 'stale' | 'credit-timeout'
    }
  }
}

/** Host-issued identity of one open native document, invalid after release. */
export type OfficeDocumentId = Branded<'OfficeDocumentId'>

/** Renderer-instance identity; a new identity stops slideshows the previous renderer started. */
export type OfficeClientId = Branded<'OfficeClientId'>

/** Native GPU drawing backend: Skia Ganesh or Skia Graphite through WebGPU. */
export type OfficeRenderBackend = 'ganesh' | 'graphite'

/** Native loading phases reported before an open completes. */
export type OfficeLoadingStage = 'fonts' | 'engine' | 'document'

/**
 * File and view identity for one open. The Host resolves `path` in the Session named by the
 * workspace-file scope and binds the resolved file to `address` and `owner` until release or expiry.
 */
export interface OfficeOpenRequest {
  /** Document address retained as view identity, never interpreted as a Host path. */
  readonly address: string
  /** Stable tab occurrence, independent of its document revision. */
  readonly owner: Branded<'TabId'>
  /** Nonnegative safe integer. A different revision replaces the document at this tab and address. */
  readonly revision: number
  /** Absolute path or path relative to the Session workspace root. */
  readonly path: string
}

/** Axis-aligned rectangle; each use names its coordinate unit. */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Visible document area in twips; the physical-pixel/twip ratio matches the render window, including render DPR. */
export interface OfficeViewport extends Rect {
  /** Physical pixels along one render-window axis, paired with `twipSize` along that axis. */
  readonly pixelSize: number
  /** Twips corresponding to `pixelSize`; the ratio also controls native input and Calc layout. */
  readonly twipSize: number
}

/** Current page, sheet, or slide geometry in twips. */
export interface OfficeDocumentInfo {
  readonly documentType: 'text' | 'spreadsheet' | 'presentation'
  readonly width: number
  readonly height: number
  readonly part: number
  /** Semicolon-separated Writer page rectangles. */
  readonly rectangles: string
  readonly parts: readonly { readonly index: number; readonly name: string }[]
  readonly renderBackend: OfficeRenderBackend
}

/**
 * The document's frame-forwarding channel and the renderer's deadline for each frame it requests from it. The channel
 * serves one engine and closes when that engine fails or the view releases or replaces the channel.
 */
export interface OfficeNativeView {
  readonly rx: FrameRxId
  /** Deadline in milliseconds for a requested frame and for the first slideshow frame of each viewport. */
  readonly frameTimeoutMs: number
}

/** Whether this Host renders native previews for the connected workspace. */
export interface OfficePreviewAvailability {
  /** True when a native Kit runtime, Desktop frame forwarding, and the workspace files share this Host. */
  readonly local: boolean
}

/** Status returned with every operation on an open document. */
export interface OfficeDocumentStatus {
  readonly documentId: OfficeDocumentId
  /** The document's frame-forwarding channel. */
  readonly nativeView?: OfficeNativeView
  /** Engine failure; later operations other than `info` and `release` reject with this message. */
  readonly failed?: string
}

/** Status and current geometry; geometry is absent after a renderer failure. */
export interface OfficeDocumentGeometry extends OfficeDocumentStatus {
  readonly info?: OfficeDocumentInfo
}

/** Who asks to replace a document's frame-forwarding channel; only `automatic` requests count against the reconnect limit. */
export type OfficeReconnectTrigger = 'automatic' | 'user'

/**
 * Outcome of a reconnect request. `reconnected`: the document's engine serves the channel in `status`. `limited`: the
 * document used its automatic reconnects for the current window, so only the user can reconnect it. `unavailable`:
 * Desktop no longer presents native frames, for example after Chromium stopped compositing on the GPU; no reconnect
 * helps until Desktop restarts.
 */
export type OfficeReconnectResult =
  | { readonly outcome: 'reconnected'; readonly status: OfficeDocumentStatus }
  | { readonly outcome: 'limited' }
  | { readonly outcome: 'unavailable'; readonly reason: string }

/** A newly opened or reattached document with the limits its view uses for drawing. */
export interface OfficeOpenedDocument extends OfficeDocumentStatus {
  readonly info: OfficeDocumentInfo
  readonly format: 'docx' | 'xlsx' | 'pptx'
  /** Source version read for this document. */
  readonly version: string
  readonly rendering: {
    /** Client request deadline in milliseconds, from the Host's existing `operationTimeoutMs` setting. */
    readonly operationTimeoutMs: number
    /** Render-window margin on each side, as a fraction of the visible viewport, from 0 to 1. */
    readonly overscanViewports: number
    /** Fraction of the overscan margin reserved before reanchoring, from 0 to 1. */
    readonly reanchorHysteresis: number
    /** Milliseconds without a zoom change before requesting a new render window. */
    readonly zoomSettleMs: number
    /** Consecutive texture-credit timeouts before reclaiming idle surfaces through a visibility reset. */
    readonly creditRetryLimit: number
    /** Maximum RGBA bytes per page preview and total bytes retained in the document's page-preview cache. */
    readonly maxPagePreviewBytes: number
  }
}

/** Loading progress followed by the opened document. */
export type OfficeOpenProgress =
  | { readonly kind: 'stage'; readonly stage: OfficeLoadingStage }
  | { readonly kind: 'opened'; readonly document: OfficeOpenedDocument }

/** Acknowledged frame-forwarding viewport version; Kit correlation stays inside the Host adapter. */
export interface OfficeFrameRequest {
  /** For document painting, the version resolved by `setContentWindow`, after the preceding paint completes. */
  readonly generation: number
}

/** One document region in twips rendered into the document's shared view. */
export interface OfficePaintRequest extends Rect {
  /** Zero-based slide; omitted for the active view or Writer page coordinates. */
  readonly part?: number
  readonly pixelWidth: number
  readonly pixelHeight: number
  readonly frame: OfficeFrameRequest
}

/** Dimensions of a shared frame delivered through the document's view. */
export interface OfficeFrameReply extends OfficeDocumentStatus {
  readonly width: number
  readonly height: number
}

/** Static document region in twips, returned as bytes without a frame-forwarding request or generation. */
export interface OfficePagePreviewRequest extends Rect {
  /** Zero-based slide; omitted for the active view or Writer page coordinates. */
  readonly part?: number
  /** Physical pixel width, from 1 to 4096; RGBA bytes must fit `maxPagePreviewBytes`. */
  readonly pixelWidth: number
  /** Physical pixel height, from 1 to 4096. */
  readonly pixelHeight: number
}

/** Static page pixels and document status; each result owns tightly packed, straight-alpha RGBA bytes. */
export interface OfficePagePreviewReply extends OfficeDocumentStatus {
  readonly width: number
  readonly height: number
  /** Exactly `width * height * 4` bytes, transported as a binary field of the unary Remote result. */
  readonly rgba: Uint8Array
}

/** Calc row and column boundaries for one visible area in twips. */
export interface OfficeHeaderQuery {
  readonly command: 'ViewRowColumnHeaders'
  readonly area: Rect
}

/** LibreOfficeKit's JSON answer to a document query. */
export interface OfficeQueryResult {
  readonly value: string
}

/**
 * Slideshow control; `stream` delivers frames directly through the shared view, each carrying `streamId` as its
 * frame correlation identifier for the given viewport generation.
 */
export type OfficePresentationControl =
  | { readonly action: 'start'; readonly pixelWidth: number; readonly pixelHeight: number; readonly part: number }
  | { readonly action: 'resize'; readonly pixelWidth: number; readonly pixelHeight: number }
  | { readonly action: 'next' | 'previous' | 'stop' }
  | { readonly action: 'pause'; readonly paused: boolean }
  | { readonly action: 'stream'; readonly enabled: boolean; readonly streamId: string; readonly generation: number }

/** Clipboard formats the native selection can produce. */
export type OfficeSelectionFormat = 'text/plain;charset=utf-8' | 'text/html'

/** Copied selection text and document status. */
export interface OfficeSelectionText extends OfficeDocumentStatus {
  readonly text: string
}

/** Selection and navigation commands available to a read-only document. */
export interface OfficeSelectionCommand {
  readonly command: 'SelectAll' | 'GoToStartOfDoc' | 'GoToEndOfDoc' | 'GoToCell' | 'Copy'
  /** UNO arguments by documented name. */
  readonly arguments: Readonly<Record<string, {
    readonly type: 'string' | 'boolean' | 'long' | 'short' | 'float'
    readonly value: string | number | boolean
  }>>
}

/** Pointer input in twips, or a navigation key using LibreOfficeKit's VCL key constants. */
export type OfficeSelectionInput =
  | {
    readonly op: 'mouse'
    /** 0 press, 1 release, 2 move. */
    readonly type: 0 | 1 | 2
    readonly x: number
    readonly y: number
    readonly count: number
    readonly buttons: number
    readonly modifiers: number
  }
  | { readonly op: 'key'; readonly type: 0 | 1; readonly character: number; readonly key: number }

/** Transient native engine notification; never document content or a Session event. */
export type OfficeEngineEvent =
  | { readonly kind: 'callback'; readonly type: number; readonly payload: string }
  | { readonly kind: 'presentation'; readonly part: number; readonly ended: boolean }
  | { readonly kind: 'failure'; readonly error: string }

/** One engine notification with the current status of its document. */
export interface OfficeDocumentEvent extends OfficeDocumentStatus {
  readonly event: OfficeEngineEvent
}

/** Acknowledgement of a document lease, followed by slide changes on the same ordered stream. */
export interface OfficeRetentionFrame {
  /** Current slideshow state, including a natural end missed during disconnection. */
  readonly presentation?: Extract<OfficeEngineEvent, { kind: 'presentation' }>
}
