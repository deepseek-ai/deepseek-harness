/** One HTTP request to the DeepSeek speech recognition API and the classification of its outcome. */
import { z } from 'zod'
import type { SpeechFailureCode } from '@deepseek-ai/dsh-experimental-speech-to-text/types'

/** Classified result of one request; diagnostics carry the status and the service's message, never credentials or audio. */
export type AttemptOutcome =
  | { readonly kind: 'text'; readonly text: string; readonly durationMs: number | undefined }
  | { readonly kind: 'credentials-rejected'; readonly diagnostic: string }
  | { readonly kind: 'revoked' }
  | { readonly kind: 'failed'; readonly code: SpeechFailureCode; readonly diagnostic: string }

/** One request's endpoint, encoded body, and authentication headers. */
export interface AttemptRequest {
  readonly endpoint: string
  readonly body: Uint8Array<ArrayBuffer>
  readonly contentType: string
  readonly headers: Readonly<Record<string, string>>
  readonly timeoutMs: number
  readonly maxResponseBytes: number
}

/** Failure classes of the documented error statuses; any other status is `service-error`. */
const STATUS_FAILURES: ReadonlyMap<number, SpeechFailureCode> = new Map<number, SpeechFailureCode>([
  [400, 'invalid-audio'], [402, 'quota-exceeded'], [404, 'service-unavailable'], [408, 'timeout'], [413, 'invalid-audio'],
  [429, 'rate-limited'], [503, 'rate-limited'], [504, 'timeout'],
])
/** Longest service message kept in a diagnostic. */
const MESSAGE_LIMIT = 200

const recognized = z.object({ text: z.string(), duration_ms: z.number().optional() })
const failure = z.object({ error: z.object({ message: z.string() }) })

class ResponseTooLarge extends Error {}

/**
 * Send one request. The caller's abort propagates; a timeout, a withdrawn credential, and a transport failure become
 * outcomes. HTTP 401 is classified from the status alone, before any body read can fail.
 * @param request - endpoint, encoded body, and authentication headers.
 * @param signal - caller cancellation.
 * @param revoked - aborts when the credential's owner withdraws it, as an account sign-out does.
 * @returns the classified outcome.
 */
export async function attemptTranscription(request: AttemptRequest, signal: AbortSignal, revoked?: AbortSignal): Promise<AttemptOutcome> {
  const timeout = AbortSignal.timeout(request.timeoutMs)
  const combined = AbortSignal.any(revoked === undefined ? [signal, timeout] : [signal, timeout, revoked])
  const interrupted = (error: unknown): AttemptOutcome => {
    signal.throwIfAborted()
    if (revoked?.aborted === true) return { kind: 'revoked' }
    if (timeout.aborted) return { kind: 'failed', code: 'timeout', diagnostic: `no response within ${request.timeoutMs} ms` }
    return { kind: 'failed', code: 'service-unavailable', diagnostic: `request failed: ${describe(error)}` }
  }
  let response: Response
  try {
    response = await fetch(request.endpoint, { method: 'POST', body: request.body, redirect: 'error', signal: combined,
      headers: { ...request.headers, 'content-type': request.contentType } })
  } catch (error) { return interrupted(error) }
  if (response.status === 401) {
    try { await response.body?.cancel() } catch (_cancelFailed) { /* The status already decided the outcome. */ }
    return { kind: 'credentials-rejected', diagnostic: 'HTTP 401' }
  }
  let text: string
  try { text = await readBounded(response, request.maxResponseBytes) } catch (error) {
    if (error instanceof ResponseTooLarge) return { kind: 'failed', code: 'service-error', diagnostic: error.message }
    return interrupted(error)
  }
  return classify(response.status, text)
}

/** Name a transport failure with its underlying cause, which fetch wraps as `fetch failed`. */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause instanceof Error ? error.cause.message : undefined
  return cause === undefined ? error.message : `${error.message} (${cause})`
}

/** Read the body up to `limit` bytes; throwing out of the loop returns the stream iterator, which cancels the body. */
async function readBounded(response: Response, limit: number): Promise<string> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of response.body ?? []) {
    total += chunk.byteLength
    if (total > limit) throw new ResponseTooLarge(`response exceeds ${limit} bytes`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function classify(status: number, text: string): AttemptOutcome {
  let json: unknown
  try { json = JSON.parse(text) } catch (_notJson) {
    // A gateway page or truncated body is no service answer; its content stays out of diagnostics.
    json = undefined
  }
  if (status === 200) {
    const result = recognized.safeParse(json)
    return result.success ? { kind: 'text', text: result.data.text, durationMs: result.data.duration_ms }
      : { kind: 'failed', code: 'service-error', diagnostic: 'recognition result is invalid' }
  }
  const message = failure.safeParse(json)
  const detail = message.success ? `: ${message.data.error.message.slice(0, MESSAGE_LIMIT)}` : ''
  return { kind: 'failed', code: STATUS_FAILURES.get(status) ?? 'service-error', diagnostic: `HTTP ${status}${detail}` }
}
