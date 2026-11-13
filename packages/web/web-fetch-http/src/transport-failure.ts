/**
 * Classification of fetch transport failures: maps the system or undici error code found in a
 * rejection's cause chain to a stable `WebError` code and a short model-visible summary, and keeps
 * a bounded technical detail.
 * @module @deepseek-ai/dsh-web-fetch-http/transport-failure
 */

/** A classified transport failure. */
export interface TransportFailure {
  /** Stable `WebError` code of the failure class. */
  code: string
  /** Model-visible text: the class summary, the system code when known, and the bounded detail. */
  message: string
}

/** One failure class: its `WebError` code, summary, and the system codes it covers. */
interface FailureClass {
  readonly code: string
  readonly summary: string
  readonly systemCodes: readonly string[]
}

/** The class a dual-stack connection attempt yields when its address family has no route. */
const UNREACHABLE: FailureClass = {
  code: 'WEB_FETCH_NETWORK_UNREACHABLE',
  summary: 'the network or host is unreachable',
  systemCodes: ['ENETUNREACH', 'EHOSTUNREACH', 'ENETDOWN', 'EHOSTDOWN'],
}

const FAILURE_CLASSES: readonly FailureClass[] = [
  {
    code: 'WEB_FETCH_DNS_FAILED',
    summary: 'could not resolve the host name',
    systemCodes: ['ENOTFOUND', 'EAI_AGAIN', 'EAI_FAIL', 'EAI_NONAME', 'EAI_NODATA'],
  },
  { code: 'WEB_FETCH_CONNECTION_REFUSED', summary: 'the server refused the connection', systemCodes: ['ECONNREFUSED'] },
  { code: 'WEB_FETCH_CONNECTION_TIMEOUT', summary: 'the connection timed out', systemCodes: ['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'] },
  {
    code: 'WEB_FETCH_CERTIFICATE_INVALID',
    summary: 'the server certificate could not be verified',
    systemCodes: [
      'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'CERT_REVOKED', 'CERT_UNTRUSTED', 'CERT_REJECTED',
      'CERT_SIGNATURE_FAILURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'UNABLE_TO_DECRYPT_CERT_SIGNATURE', 'CERT_CHAIN_TOO_LONG', 'INVALID_CA', 'HOSTNAME_MISMATCH',
      'ERR_TLS_CERT_ALTNAME_INVALID',
    ],
  },
  {
    code: 'WEB_FETCH_CONNECTION_INTERRUPTED',
    summary: 'the connection was interrupted',
    systemCodes: ['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'UND_ERR_SOCKET'],
  },
  UNREACHABLE,
]

/** Code and summary of a failure whose system code is missing, mixed, or unrecognized. */
const UNCLASSIFIED = { code: 'WEB_FETCH_NETWORK_ERROR', summary: 'the network request failed' } as const

/** Cause hops followed below a transport rejection; a deeper or cyclic chain is cut there. */
const MAX_CAUSE_HOPS = 4

/** `AggregateError` members named in a transport failure; the rest are counted. */
const MAX_ATTEMPTS = 4

/** Characters of the technical detail kept in the message; the summary is never cut. */
const MAX_DETAIL_CHARS = 500

/**
 * Classify a transport rejection. Undici rejects with a generic `TypeError: fetch failed` whose
 * `cause` holds the system error, such as `getaddrinfo ENOTFOUND host`; a connection attempt across
 * several resolved addresses nests those errors in an `AggregateError`. A failure is classified only
 * when its code, or every attempt's code, belongs to one class; an unreachable attempt beside attempts
 * of one other class, as an IPv6 attempt on an IPv4-only network, takes that other class.
 * @param error - the rejection of the request or body read.
 * @returns the failure's code and model-visible message.
 */
export function classifyTransportFailure(error: unknown): TransportFailure {
  const innermost = innermostCause(error)
  const aggregate = innermost instanceof AggregateError && innermost.errors.length > 0
  const attempts = aggregate ? innermost.errors.map(innermostCause) : [innermost]
  const systemCodes = attempts.map(systemCodeOf)
  const classes = new Set(systemCodes.map(code => FAILURE_CLASSES.find(entry => code !== undefined && entry.systemCodes.includes(code))))
  if (classes.size === 2) classes.delete(UNREACHABLE)
  const [only] = classes
  const failure = classes.size === 1 && only !== undefined ? only : UNCLASSIFIED
  const systemCode = new Set(systemCodes).size === 1 ? systemCodes[0] : undefined
  const detail = bounded(aggregate ? attemptsDetail(attempts, error) : messageOf(innermost, error))
  return { code: failure.code, message: `${failure.summary}${systemCode === undefined ? '' : ` (${systemCode})`}: ${detail}` }
}

/** Follow `cause` up to the hop cap. */
function innermostCause(error: unknown): unknown {
  let current = error
  for (let hop = 0; hop < MAX_CAUSE_HOPS && current instanceof Error && current.cause !== undefined; hop++) current = current.cause
  return current
}

/** The string `code` property Node and undici attach to system errors. */
function systemCodeOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

/** Name at most `MAX_ATTEMPTS` attempts and count the rest. */
function attemptsDetail(attempts: readonly unknown[], fallback: unknown): string {
  const named = attempts.slice(0, MAX_ATTEMPTS).map(attempt => messageOf(attempt, fallback))
  const rest = attempts.length - named.length
  return named.join('; ') + (rest > 0 ? `; ${rest} more` : '')
}

/** An error's message, or the rejection's text when the message is empty. */
function messageOf(error: unknown, fallback: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message === '' ? String(fallback) : message
}

/** Cut a detail to `MAX_DETAIL_CHARS`. */
function bounded(detail: string): string {
  return detail.length > MAX_DETAIL_CHARS ? `${detail.slice(0, MAX_DETAIL_CHARS)}…` : detail
}
