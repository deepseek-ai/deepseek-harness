/** One HTTP attempt against the One-Shot endpoint and the classification of its outcome. */
import { z } from 'zod'
import type { SpeechFailureCode } from '@deepseek-ai/dsh-experimental-speech-to-text/types'

/** Classified result of one attempt; diagnostics carry status and codes only, never credentials or audio. */
export type AttemptOutcome =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'credentials-rejected'; readonly diagnostic: string }
  | { readonly kind: 'retryable' | 'failed'; readonly code: SpeechFailureCode; readonly diagnostic: string }

/** Request facts shared by the first attempt and its retry, which reuses the same `audio_id`. */
export interface AttemptRequest {
  readonly endpoint: URL
  readonly body: Uint8Array<ArrayBuffer>
  readonly contentType: string
  readonly headers: Readonly<Record<string, string>>
  readonly timeoutMs: number
  readonly maxResponseBytes: number
}

/** Outer response codes for a missing or rejected token. */
const TOKEN_REJECTED = new Set([40002, 40003])
/** `biz_data.code` values of a failed recognition; `empty` means the service heard no speech. */
const RECOGNITION_FAILURES = new Map<number, SpeechFailureCode | 'empty'>([
  [1, 'service-unavailable'], [2, 'rate-limited'], [3, 'service-error'], [4, 'invalid-audio'], [5, 'service-error'],
  [6, 'empty'], [7, 'timeout'], [8, 'timeout'], [10, 'empty'], [11, 'quota-exceeded'],
])
/** `biz_code` of a successful recognition, of a classified failure, and of an earlier failed task to resubmit. */
const BIZ_SUCCESS = 0, BIZ_FAILED = 2, BIZ_RESUBMIT = 3

const envelope = z.object({ code: z.number(), data: z.object({ biz_code: z.number(), biz_data: z.unknown() }).nullish() })
const recognized = z.object({ text: z.string() })
const refused = z.object({ code: z.number() })

class ResponseTooLarge extends Error {}

/**
 * Send one request; the caller's abort propagates, while timeouts and transport failures become outcomes.
 * @param request - endpoint, encoded body, and authentication headers.
 * @param signal - caller cancellation.
 * @returns the classified outcome.
 */
export async function attemptTranscription(request: AttemptRequest, signal: AbortSignal): Promise<AttemptOutcome> {
  const timeout = AbortSignal.timeout(request.timeoutMs)
  const combined = AbortSignal.any([signal, timeout])
  let text: string, status: number
  try {
    const response = await fetch(request.endpoint, { method: 'POST', body: request.body, redirect: 'error', signal: combined,
      headers: { ...request.headers, 'content-type': request.contentType } })
    status = response.status
    text = await readBounded(response, request.maxResponseBytes)
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof ResponseTooLarge) return { kind: 'failed', code: 'service-error', diagnostic: error.message }
    return timeout.aborted ? { kind: 'retryable', code: 'timeout', diagnostic: `no response within ${request.timeoutMs} ms` }
      : { kind: 'retryable', code: 'service-error', diagnostic: `request failed: ${String(error)}` }
  }
  return classify(status, text)
}

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
  if (status === 401) return { kind: 'credentials-rejected', diagnostic: 'HTTP 401' }
  if (status === 429) return { kind: 'failed', code: 'rate-limited', diagnostic: 'HTTP 429' }
  if (status >= 500) return { kind: 'retryable', code: 'service-error', diagnostic: `HTTP ${status}` }
  if (status !== 200) return { kind: 'failed', code: 'service-error', diagnostic: `HTTP ${status}` }
  let json: unknown
  try { json = JSON.parse(text) } catch (_notJson) {
    // A gateway page or truncated body is not a recognition result; its content stays out of diagnostics.
    return { kind: 'failed', code: 'service-error', diagnostic: 'response is not JSON' }
  }
  const outer = envelope.safeParse(json)
  if (!outer.success) return { kind: 'failed', code: 'service-error', diagnostic: 'response envelope is invalid' }
  const { code, data } = outer.data
  if (TOKEN_REJECTED.has(code)) return { kind: 'credentials-rejected', diagnostic: `code ${code}` }
  if (code !== 0 || data == null) return { kind: 'failed', code: 'service-error', diagnostic: `code ${code}` }
  if (data.biz_code === BIZ_SUCCESS) {
    const result = recognized.safeParse(data.biz_data)
    return result.success ? { kind: 'text', text: result.data.text } : { kind: 'failed', code: 'service-error', diagnostic: 'recognition result is invalid' }
  }
  if (data.biz_code === BIZ_RESUBMIT) return { kind: 'retryable', code: 'service-error', diagnostic: `biz_code ${BIZ_RESUBMIT}` }
  const failure = data.biz_code === BIZ_FAILED ? refused.safeParse(data.biz_data) : undefined
  if (failure?.success !== true) return { kind: 'failed', code: 'service-error', diagnostic: `biz_code ${data.biz_code}` }
  const mapped = RECOGNITION_FAILURES.get(failure.data.code) ?? 'service-error'
  return mapped === 'empty' ? { kind: 'text', text: '' }
    : { kind: 'failed', code: mapped, diagnostic: `biz_code ${BIZ_FAILED}, code ${failure.data.code}` }
}
