/** Download failures retain their cause locally and expose only safe, structured diagnostics to clients. */
import type { SpeechDownloadFailure } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { TimeoutReason } from '@deepseek-ai/dsh-timeout'

type FailureKind = Pick<SpeechDownloadFailure, 'reason' | 'code'>

const codes: readonly [SpeechDownloadFailure['reason'], RegExp][] = [
  ['dns', /^(ENOTFOUND|EAI_AGAIN)$/],
  ['timeout', /^(ETIMEDOUT|ERR_SOCKET_CONNECTION_TIMEOUT|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT)$/],
  ['certificate', /^(CERT_[A-Z_]+|ERR_TLS_CERT_ALTNAME_INVALID|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)$/],
  ['storage', /^(ENOSPC|EDQUOT|EACCES|EPERM|EROFS)$/],
  ['network', /^(ECONNREFUSED|ECONNRESET|ENETUNREACH|EHOSTUNREACH|EPIPE|UND_ERR_SOCKET)$/],
]

/**
 * Inspect native fetch causes, including aggregate connection attempts, without publishing their messages.
 * @param failure - error received from the network or filesystem.
 * @returns an actionable category and recognized diagnostic code, or a generic failure.
 */
export function classifyDownloadFailure(failure: unknown): FailureKind {
  const pending: unknown[] = [failure], visited = new Set<Error>()
  let reason: SpeechDownloadFailure['reason'] = 'unknown'
  while (pending.length > 0) {
    const error = pending.shift()
    if (!(error instanceof Error) || visited.has(error)) continue
    visited.add(error)
    if (error instanceof TimeoutReason || error.name === 'TimeoutError') return { reason: 'timeout' }
    if ('code' in error && typeof error.code === 'string') {
      for (const [kind, pattern] of codes) if (pattern.test(error.code)) return { reason: kind, code: error.code }
    }
    if (error instanceof TypeError && error.message === 'fetch failed') reason = 'network'
    pending.push(error.cause)
    if (error instanceof AggregateError) {
      const causes: readonly unknown[] = error.errors
      pending.push(...causes)
    }
  }
  return { reason }
}

/** A preparation error whose public details exclude raw causes, credentials, signed URLs and local paths. */
export class SpeechDownloadError extends Error {
  constructor(readonly download: SpeechDownloadFailure, options?: ErrorOptions) {
    super(`Unable to prepare ${download.resource} from ${download.source}: ${download.reason}${download.code ? ` (${download.code})` : ''}${download.status === undefined ? '' : ` (HTTP ${download.status})`}`, options)
  }
}
