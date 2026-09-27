/**
 * Connection diagnostics retain cause chains for literal configuration.
 * Template-expanded configuration exposes only local reasons and known error
 * codes because upstream messages can contain resolved credentials.
 */

import { SdkErrorCode } from '@modelcontextprotocol/client'

/** Local failure whose message contains no expanded configuration or upstream text. */
export class McpLocalError extends Error {}

const SAFE_ERROR_CODES = new Set<string>([
  ...Object.values(SdkErrorCode),
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT',
  'ENOENT', 'EACCES', 'EPERM', 'EPIPE', 'ERR_INVALID_URL',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
])

/**
 * Describe a failure without copying expanded configuration from upstream errors.
 * @param error - caught failure, including nested transport causes.
 * @returns a local reason, known error code, or a generic failure message.
 */
export function describeTemplateError(error: unknown): string {
  const seen = new Set<Error>()
  while (error instanceof Error && !seen.has(error)) {
    if (error instanceof McpLocalError) return error.message
    seen.add(error)
    const code = 'code' in error ? error.code : undefined
    if (typeof code === 'string' && SAFE_ERROR_CODES.has(code)) return code
    error = error.cause
  }
  return 'operation failed (upstream details omitted to protect credentials)'
}

/** One readable segment of the chain; generic `Error` names are noise and dropped. */
function segmentOf(value: unknown): string {
  if (!(value instanceof Error)) return String(value)
  const base = value.name === 'Error' || value.message === ''
    ? (value.message === '' ? value.name : value.message)
    : `${value.name}: ${value.message}`
  if (base !== '' && base !== 'Error') return base
  // Some aggregate connect failures carry an empty message but a syscall code.
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' ? code : value.name
}

/**
 * Flatten an error and its `cause` chain into `outer, cause: inner, …`.
 * @param error - the caught value; non-Errors stringify as-is.
 * @returns the joined diagnostic line.
 */
export function describeError(error: unknown): string {
  const seen = new Set<unknown>()
  const segments: string[] = []
  let current: unknown = error
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current)
    // The outer segment keeps its error name (`TypeError: fetch failed`).
    segments.push(segments.length === 0 && current instanceof Error ? String(current) : segmentOf(current))
    current = current instanceof Error ? current.cause : undefined
  }
  const head = segments[0]
  if (head === undefined) return String(error)
  return head + segments.slice(1).map(segment => `, cause: ${segment}`).join('')
}
