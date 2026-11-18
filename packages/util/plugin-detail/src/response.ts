/** HTTP responses of Host routes that serve images beside detail documents. */
import type { DetailFailureReason } from './types.ts'

/** An image read beside a detail document. */
export interface DetailImage {
  readonly bytes: Uint8Array
  readonly mediaType: string
}

/** HTTP status of each detail failure. */
const FAILURE_STATUS = {
  'too-large': 413, 'network': 502, 'denied': 403, 'git-unavailable': 503, 'invalid': 400,
} as const satisfies Record<DetailFailureReason, number>

/**
 * The response of an image route: the image, 404 when there is none, or the failure's status with its reason as the
 * body. Every response carries `X-Content-Type-Options: nosniff` and a sandbox content security policy, because an SVG
 * opened directly would otherwise run scripts on the authenticated API origin; only an image gets `cacheControl`.
 * @param outcome - the image, undefined when none exists, or why it cannot be read; `invalid` also answers a malformed request.
 * @param cacheControl - the `Cache-Control` value of an image.
 * @returns the response.
 */
export function detailImageResponse(outcome: DetailImage | DetailFailureReason | undefined, cacheControl: string): Response {
  const [status, body, type] = typeof outcome === 'object'
    // A copy into a fresh buffer is a body `Response` accepts whatever buffer the bytes view.
    ? [200, new Uint8Array(outcome.bytes), outcome.mediaType]
    : outcome === undefined ? [404, 'not found', undefined] : [FAILURE_STATUS[outcome], outcome, undefined]
  return new Response(body, {
    status,
    headers: {
      'Content-Type': type ?? 'text/plain; charset=utf-8',
      'Cache-Control': status === 200 ? cacheControl : 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    },
  })
}
