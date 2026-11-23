/**
 * Optional DeepSeek cloud recognizer. Each recording goes to `/v1/tools/asr`, authenticated through `ctx.deepseekAuth`
 * with the DeepSeek account sign-in first and the API key second. Activation sends no audio and contacts no service.
 * @module @deepseek-ai/dsh-speech-to-text-deepseek
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import { DeepSeekAuthError } from '@deepseek-ai/dsh-deepseek-auth'
import type {
  DeepSeekAuthCandidate, DeepSeekAuthKind, DeepSeekAuthUnresolved, DeepSeekAuthorization,
} from '@deepseek-ai/dsh-deepseek-auth'
import { SpeechTranscriptionError } from '@deepseek-ai/dsh-experimental-speech-to-text'
import type { SpeechInput, SpeechPreparationState, Transcript } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { multipartBody, recordingSeconds } from './audio.ts'
import { CloudReadiness } from './availability.ts'
import { Config, resolveOptions, type ResolvedOptions } from './config.ts'
import { attemptTranscription } from './request.ts'

export { Config } from './config.ts'
export const name = 'speech-to-text-deepseek'
export const inject = ['speechToText', 'deepseekAuth']

/** Path of the speech recognition API under the origin of the chosen credential's deployment. */
const ASR_PATH = '/v1/tools/asr'
/** Credential kinds the speech recognition API accepts. */
const ACCEPTS: readonly DeepSeekAuthKind[] = ['account', 'api-key']
/**
 * Order in which the kinds are tried: the account sign-in first, because its deployment is the official one unless a
 * deployment overrides it, while an API key often belongs to a custom endpoint.
 */
const ORDER: readonly DeepSeekAuthKind[] = ['account', 'api-key']
const LOG_TAG = '[speech-to-text-deepseek]'

/**
 * Register the cloud recognizer and re-inspect its credentials whenever a credential or the account service changes.
 * @param ctx - Host registry owner with the speech and DeepSeek authentication services.
 * @param config - validated deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const options = resolveOptions(config)
  const readiness = new CloudReadiness(() => inspect(ctx))
  ctx.effect(() => () => { readiness.dispose() }, 'speech-to-text-deepseek: readiness')
  const refresh = (): void => { void readiness.refresh() }
  ctx.on('credentials/record-updated', refresh)
  ctx.on('credentials/reference-updated', refresh)
  ctx.on('internal/service', (service: string) => { if (service === 'deepseekAccount') refresh() })
  ctx.effect(() => ctx.speechToText.register({
    info: { id: options.providerId, name: 'DeepSeek', location: 'cloud', languages: ['auto'] },
    preparation: readiness,
    transcribe: async (input, signal) => await transcribe(ctx, options, input, signal),
  }), 'speech-to-text-deepseek: provider')
  refresh()
}

/** The candidates of every kind in {@link ORDER}, each bound to the speech recognition endpoint of its deployment. */
function candidates(ctx: Context): (DeepSeekAuthCandidate | DeepSeekAuthUnresolved)[] {
  return ORDER.flatMap(billing => ctx.deepseekAuth.candidates({
    consumer: name, accepts: ACCEPTS, billing, destination: { path: ASR_PATH },
  }))
}

/** Ready while a kind has a credential, failed at a kind whose settings do not resolve, else waiting for a credential. */
async function inspect(ctx: Context): Promise<SpeechPreparationState> {
  for (const candidate of candidates(ctx)) {
    if ('unresolved' in candidate) return { phase: 'failed', message: unresolvedMessage(candidate) }
    if (await candidate.configured()) return { phase: 'ready' }
  }
  return { phase: 'unavailable', reason: 'sign-in-required' }
}

function unresolvedMessage(candidate: DeepSeekAuthUnresolved): string {
  const error = candidate.error instanceof Error ? candidate.error.message : String(candidate.error)
  return `The DeepSeek ${candidate.kind} ${candidate.unresolved} does not resolve: ${error}`
}

/** Release the first credential in {@link ORDER}; stops at a kind whose settings do not resolve. */
async function authorize(ctx: Context, signal: AbortSignal): Promise<DeepSeekAuthorization> {
  for (const candidate of candidates(ctx)) {
    if ('unresolved' in candidate) throw new SpeechTranscriptionError('service-error', unresolvedMessage(candidate), { cause: candidate.error })
    let authorization: DeepSeekAuthorization | undefined
    try { authorization = await candidate.resolve(signal) } catch (error) {
      if (error instanceof DeepSeekAuthError && error.code === 'INVALID_CREDENTIAL') {
        throw new SpeechTranscriptionError('api-key-invalid', error.message, { cause: error })
      }
      throw error
    }
    if (authorization !== undefined) return authorization
  }
  throw new SpeechTranscriptionError('sign-in-required', 'Cloud recognition requires a DeepSeek account sign-in or a DeepSeek API key')
}

async function transcribe(ctx: Context, options: ResolvedOptions, input: SpeechInput, signal: AbortSignal): Promise<Transcript> {
  const started = performance.now()
  const seconds = recordingSeconds(input.audio, options.maxDurationSeconds, options.maxRequestBytes)
  const { body, contentType } = multipartBody(input.audio)
  const authorization = await authorize(ctx, signal)
  const outcome = await attemptTranscription({ endpoint: authorization.endpoint, body, contentType, headers: authorization.headers,
    timeoutMs: options.timeoutMs, maxResponseBytes: options.maxResponseBytes }, signal, authorization.revoked)
  const path = new URL(authorization.endpoint).pathname
  switch (outcome.kind) {
    case 'text': {
      const audioSeconds = outcome.durationMs === undefined ? seconds : outcome.durationMs / 1000
      return { text: outcome.text, audioSeconds, inferenceSeconds: (performance.now() - started) / 1000 }
    }
    case 'credentials-rejected':
      console.error(LOG_TAG, `${path} rejected the ${authorization.kind} credential: ${outcome.diagnostic}`)
      if (authorization.kind === 'api-key') {
        throw new SpeechTranscriptionError('api-key-invalid', `The DeepSeek API key was rejected (${outcome.diagnostic})`)
      }
      // The account service contains its own storage failures, so the rejection below is always the reported failure.
      await authorization.reject?.()
      throw new SpeechTranscriptionError('sign-in-required', `The DeepSeek account sign-in was rejected (${outcome.diagnostic})`)
    case 'revoked':
      throw new SpeechTranscriptionError('sign-in-required', 'The DeepSeek account signed out during recognition')
    case 'failed':
      console.error(LOG_TAG, `${path} failed (${outcome.code}): ${outcome.diagnostic}`)
      throw new SpeechTranscriptionError(outcome.code, `Cloud recognition failed: ${outcome.diagnostic}`)
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default: return assertNever(outcome, 'speech attempt outcome')
  }
}
