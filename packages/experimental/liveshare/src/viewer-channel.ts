/**
 * Viewer read channel: one request the Relay forwards unread and the owner's answer to it.
 *
 * The viewer page speaks this channel instead of the owner's HTTP API, so the Relay stays
 * ignorant of DSH endpoints and payloads. Both halves of the package import these types; the
 * Relay only moves the encoded values.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/viewer-channel
 */

/**
 * Page global the Relay's carrier installs on a viewer page. The carrier writes the same name in
 * `@deepseek-ai/dsh-experimental-liveshare-protocol`; it is restated here because a client bundle may
 * not import that package's values.
 */
export const LIVESHARE_VIEWER_GLOBAL = '__DSH_LIVESHARE_VIEWER__'

/** One unary Host RPC the viewer asks the owner to perform. */
export interface ViewerCallRequest {
  readonly op: 'call'
  /** Absolute Connection channel path the client posted to, such as `/api/session/page`. */
  readonly path: string
  /** Client request envelope the owner's gateway dispatch reads. */
  readonly body: unknown
}

/** Open one Host stream the viewer consumes through repeated polls. */
export interface ViewerStreamOpenRequest {
  readonly op: 'stream-open'
  /** Viewer-minted stream identity, unique within one share. */
  readonly id: number
  /** Canonical Remote endpoint or gateway-owned stream name. */
  readonly endpoint: string
  /** Decoded carrier payload for that stream. */
  readonly payload: unknown
}

/** One poll for the next value of an open stream. */
export interface ViewerStreamNextRequest {
  readonly op: 'stream-next'
  readonly id: number
}

/** Release one open stream when its consumer stops. */
export interface ViewerStreamCancelRequest {
  readonly op: 'stream-cancel'
  readonly id: number
}

/**
 * Read one resource of the owner's served page: the rendered index, a shell asset, or a client
 * plugin bundle. The Relay serves the decoded answer as that path's response.
 */
export interface ViewerAssetRequest {
  readonly op: 'asset'
  /** Page-relative path and query without a leading slash: `''`, `index.html`, `assets/...`, or `plugins/...`. */
  readonly path: string
}

/** Owner answer body for one {@link ViewerAssetRequest} with status 200. */
export interface ViewerAssetBody {
  readonly contentType: string
  /** Resource bytes, base64-encoded so the answer stays JSON on every hop. */
  readonly base64: string
}

/** Every request the viewer sends through the Relay to its owner. */
export type ViewerRequest =
  | ViewerCallRequest
  | ViewerStreamOpenRequest
  | ViewerStreamNextRequest
  | ViewerStreamCancelRequest
  | ViewerAssetRequest

/** One value of an open stream, or its end. */
export interface ViewerStreamValue {
  /** Values one answer carries, in stream order; a Host that answers one at a time sends `value`. */
  readonly values?: readonly unknown[]
  readonly value?: unknown
  readonly end?: true
  /** Largest wait the owner honoured, so the viewer can poll again instead of failing. */
  readonly pending?: true
  readonly failure?: { readonly code: string; readonly message: string; readonly details: object }
}

/** Owner answer for one viewer request; the Relay writes status and body back unchanged. */
export interface ViewerAnswer {
  readonly status: number
  readonly body: unknown
}

/**
 * Refusal code for an endpoint a share reader may not call: the reason the `share-viewer` remote access
 * policy gives, and the code of the reader's own refusal of a stream another identity opened.
 */
export const VIEWER_READ_ONLY_CODE = 'liveshare/read-only'

/**
 * Build the owner's refusal answer for one request the reader handler refuses itself.
 * @param endpoint - Refused endpoint, stream name, or stream operation.
 * @returns A 403 answer carrying an ordinary Connection failure result.
 */
export function viewerReadOnlyAnswer(endpoint: string): ViewerAnswer {
  return {
    status: 403,
    body: {
      ok: false,
      error: {
        code: VIEWER_READ_ONLY_CODE,
        message: `liveshare: ${endpoint} is not readable through a share`,
        details: {},
      },
    },
  }
}

/**
 * Validate one decoded viewer request.
 * @param value Decoded JSON body the Relay forwarded.
 * @returns The request, or undefined when the body is not one.
 */
export function parseViewerRequest(value: unknown): ViewerRequest | undefined {
  if (!isRecord(value)) return undefined
  switch (value.op) {
    case 'call':
      return typeof value.path === 'string' && value.path.startsWith('/') && value.body !== undefined
        ? { op: 'call', path: value.path, body: value.body }
        : undefined
    case 'stream-open': {
      const id = streamId(value.id)
      if (id === undefined || typeof value.endpoint !== 'string' || value.endpoint === '') return undefined
      if (value.payload === undefined) return undefined
      return { op: 'stream-open', id, endpoint: value.endpoint, payload: value.payload }
    }
    case 'stream-next': {
      const id = streamId(value.id)
      return id === undefined ? undefined : { op: 'stream-next', id }
    }
    case 'stream-cancel': {
      const id = streamId(value.id)
      return id === undefined ? undefined : { op: 'stream-cancel', id }
    }
    case 'asset':
      return typeof value.path === 'string' ? { op: 'asset', path: value.path } : undefined
    default:
      return undefined
  }
}

function streamId(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined
}

/**
 * Read the request object one envelope addresses.
 *
 * The client writes the same request in two shapes — a unary envelope carrying `payload`, or a
 * stream payload whose `args.request` holds it — and both faces of the channel have to find the
 * Session it names. The unwrapping lives beside the request types so the two faces cannot drift.
 * @param envelope - Client request envelope, or one stream payload carrying `args.request`.
 * @returns The innermost request record, or undefined when the value carries none.
 */
export function viewerRequestTarget(envelope: unknown): Record<string, unknown> | undefined {
  if (!isRecord(envelope)) return undefined
  const payload = isRecord(envelope.payload) ? envelope.payload : envelope
  const args = isRecord(payload.args) ? payload.args : undefined
  return args !== undefined && isRecord(args.request) ? args.request : payload
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
