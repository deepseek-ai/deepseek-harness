/**
 * Connection diagnostics retain cause chains. Configurations that resolve
 * secrets replace every known secret value before text leaves the instance.
 */

import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/client'
import { HarnessError } from '@deepseek-ai/dsh-error'

/**
 * Every {@link McpLocalError} code:
 * - `MCP_CONNECTION_CLOSED`: the connection generation closed; outcomes of requests in flight are unknown.
 * - `MCP_TIMEOUT`: a startup, operation, or cleanup budget elapsed.
 * - `MCP_CREDENTIALS_UNAVAILABLE`: credential templates are configured but no credentials provider is mounted.
 * - `MCP_CREDENTIAL_NOT_FOUND`: a referenced credential has no configured value.
 * - `MCP_INSTRUCTIONS_TOO_LARGE`: server instructions exceed `maxInstructionBytes`.
 * - `MCP_TOOL_REGISTRATION_FAILED`: a foreign registration occupies the server's tool namespace.
 */
export const MCP_LOCAL_ERROR_CODES = [
  'MCP_CONNECTION_CLOSED',
  'MCP_TIMEOUT',
  'MCP_CREDENTIALS_UNAVAILABLE',
  'MCP_CREDENTIAL_NOT_FOUND',
  'MCP_INSTRUCTIONS_TOO_LARGE',
  'MCP_TOOL_REGISTRATION_FAILED',
] as const

/** One {@link McpLocalError} code. */
export type McpLocalErrorCode = typeof MCP_LOCAL_ERROR_CODES[number]

/**
 * Local failure whose message contains no expanded configuration or upstream
 * text; `code` is one of {@link MCP_LOCAL_ERROR_CODES}.
 */
export class McpLocalError extends HarnessError {
  override readonly code: McpLocalErrorCode

  constructor(message: string, code: McpLocalErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'McpLocalError'
    this.code = code
  }
}

/**
 * Every {@link McpToolError} code:
 * - `MCP_TOOL_ERROR`: the server answered the tool call with an `isError` result; the model may adjust its input.
 * - `MCP_UNSUPPORTED_TASK_EXECUTION`: the tool requires task-based execution, which the bridge does not support.
 * - `MCP_INVALID_RESULT`: the server's result violates the MCP result schema or the tool's advertised output
 *   schema, or that output schema cannot be compiled.
 * - `MCP_CONNECTION_CLOSED`: the connection closed while the request was in flight; its outcome is unknown.
 * - `MCP_TIMEOUT`: the request exceeded its deadline; its outcome is unknown.
 * - `MCP_SERVER_UNAVAILABLE`: the server was not connected, so the request was not sent.
 * - `MCP_REQUEST_FAILED`: any other protocol or SDK failure; `message` carries the JSON-RPC or SDK code.
 */
export const MCP_TOOL_ERROR_CODES = [
  'MCP_TOOL_ERROR',
  'MCP_UNSUPPORTED_TASK_EXECUTION',
  'MCP_INVALID_RESULT',
  'MCP_CONNECTION_CLOSED',
  'MCP_TIMEOUT',
  'MCP_SERVER_UNAVAILABLE',
  'MCP_REQUEST_FAILED',
] as const

/** One {@link McpToolError} code. */
export type McpToolErrorCode = typeof MCP_TOOL_ERROR_CODES[number]

/**
 * Failure of one MCP tool or resource request; `code` is one of
 * {@link MCP_TOOL_ERROR_CODES}. `message` may contain upstream text, redacted
 * when the instance resolves credential templates.
 */
export class McpToolError extends HarnessError {
  override readonly code: McpToolErrorCode

  constructor(message: string, code: McpToolErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.name = 'McpToolError'
    this.code = code
  }
}

/** Codes for SDK-local failures whose consumer action differs from a generic request failure. */
const SDK_ERROR_CODES: Partial<Record<SdkErrorCode, McpToolErrorCode>> = {
  [SdkErrorCode.ConnectionClosed]: 'MCP_CONNECTION_CLOSED',
  [SdkErrorCode.RequestTimeout]: 'MCP_TIMEOUT',
  [SdkErrorCode.NotConnected]: 'MCP_SERVER_UNAVAILABLE',
  [SdkErrorCode.InvalidResult]: 'MCP_INVALID_RESULT',
}

/**
 * Classify one failed MCP request. An {@link McpLocalError}, such as the
 * generation's closure reason, keeps its identity; any other failure becomes
 * an {@link McpToolError} whose `message` carries the JSON-RPC or SDK code.
 * Without `redact` the original failure is the `cause`; with `redact` no
 * `cause` is attached, because the original text may contain secret values.
 * @param error - the request's rejection.
 * @param operation - names the request, such as `tool "echo"` or `resources/read`.
 * @param redact - removes secret values from the message when templates are enabled.
 * @returns the classified failure to throw.
 */
export function mcpRequestError(
  error: unknown,
  operation: string,
  redact?: (text: string) => string,
): HarnessError {
  if (error instanceof McpLocalError) return error
  let code: McpToolErrorCode = 'MCP_REQUEST_FAILED'
  let detail = describeError(error)
  if (ProtocolError.isInstance(error)) detail = `JSON-RPC error ${error.code}: ${error.message}`
  else if (SdkError.isInstance(error)) {
    code = SDK_ERROR_CODES[error.code] ?? code
    detail = `${error.code}: ${error.message}`
  }
  const message = `MCP ${operation} failed: ${detail}`
  return redact === undefined
    ? new McpToolError(message, code, { cause: error })
    : new McpToolError(redact(message), code)
}

/** Placeholder written in place of a known secret value. */
const REDACTED = '[redacted]'

/**
 * Replace every occurrence of known secret values, longest first so a secret
 * that contains another is replaced whole.
 * @param text - diagnostic or upstream text.
 * @param secrets - non-empty secret values known to the instance.
 * @returns the text with each occurrence replaced by `[redacted]`.
 */
export function redactSecrets(text: string, secrets: Iterable<string>): string {
  let out = text
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) out = out.replaceAll(secret, REDACTED)
  return out
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
