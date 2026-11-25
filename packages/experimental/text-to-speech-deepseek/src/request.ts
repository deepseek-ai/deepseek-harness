/** One HTTP request to the DeepSeek speech synthesis API and the classification of its response head. */
import { z } from 'zod'
import type { SynthesisFailureCode } from '@deepseek-ai/dsh-text-to-speech/types'

/** Text, voice, endpoint, and authentication headers of one request. */
export interface SynthesisCall {
  readonly endpoint: string
  readonly headers: Readonly<Record<string, string>>
  readonly text: string
  readonly voice: string
}

/** Classified response head; diagnostics carry the status and the service's message, never credentials or text. */
export type Opened =
  | { readonly kind: 'audio'; readonly body: AsyncIterable<Uint8Array> }
  | { readonly kind: 'credentials-rejected'; readonly diagnostic: string }
  | { readonly kind: 'failed'; readonly code: SynthesisFailureCode; readonly diagnostic: string }

/** Failure classes of the documented error statuses; any other status is `service-error`. */
const STATUS_FAILURES: ReadonlyMap<number, SynthesisFailureCode> = new Map<number, SynthesisFailureCode>([
  [400, 'text-rejected'], [402, 'quota-exceeded'], [404, 'service-unavailable'], [408, 'timeout'], [413, 'text-rejected'],
  [429, 'rate-limited'], [503, 'rate-limited'], [504, 'timeout'],
])
/** Most bytes of an error body that are read; a larger body is reported by its status alone. */
const ERROR_BODY_LIMIT = 16 * 1024
/** Longest service message kept in a diagnostic. */
const MESSAGE_LIMIT = 200

const failure = z.object({ error: z.object({ message: z.string() }) })

/**
 * Send the request and classify the response head. Raw PCM is requested, and Markdown filtering is off because the
 * caller sends text that is already plain. Transport failures and aborts reject; the caller classifies them.
 * @param call - endpoint, credential headers, text, and voice.
 * @param signal - cancellation of the request and of the audio body returned for a success.
 * @returns the audio body, a credential rejection, or a classified failure.
 */
export async function openSynthesis(call: SynthesisCall, signal: AbortSignal): Promise<Opened> {
  const response = await fetch(call.endpoint, {
    method: 'POST', redirect: 'error', signal,
    headers: { ...call.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ text: call.text, voice_id: call.voice, format: 'pcm', filter_markdown: false }),
  })
  if (response.status === 401) {
    try { await response.body?.cancel() } catch (_cancelFailed) { /* The status already decided the outcome. */ }
    return { kind: 'credentials-rejected', diagnostic: 'HTTP 401' }
  }
  // A JSON body under status 200 is an error report, not audio.
  const described = response.headers.get('content-type')?.startsWith('application/json') === true
  if (response.status === 200 && !described && response.body !== null) return { kind: 'audio', body: response.body }
  const detail = await serviceMessage(response)
  return {
    kind: 'failed', code: STATUS_FAILURES.get(response.status) ?? 'service-error',
    diagnostic: `HTTP ${response.status}${detail === undefined ? '' : `: ${detail}`}`,
  }
}

/** Read the service's error message from a bounded body; a gateway page or an oversized body yields none. */
async function serviceMessage(response: Response): Promise<string | undefined> {
  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of response.body ?? []) {
    total += chunk.byteLength
    // Leaving the loop returns the stream iterator, which cancels the body.
    if (total > ERROR_BODY_LIMIT) return undefined
    chunks.push(chunk)
  }
  let json: unknown
  try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (_notJson) {
    // The content of a body that is not the service's JSON stays out of diagnostics.
    return undefined
  }
  const parsed = failure.safeParse(json)
  return parsed.success ? parsed.data.error.message.slice(0, MESSAGE_LIMIT) : undefined
}

/**
 * Name a transport failure with its underlying cause, which fetch wraps as `fetch failed`.
 * @param error - rejection of a request or of a body read.
 * @returns the message with its cause appended.
 */
export function describeTransport(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message
}
