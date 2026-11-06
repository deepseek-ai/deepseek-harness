/** Optional DeepSeek One-Shot cloud recognizer; activation sends no audio and reads no token. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { SpeechTranscriptionError } from '@deepseek-ai/dsh-experimental-speech-to-text'
import type { SpeechInput, SpeechPreparationState, Transcript } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { randomUUID } from 'node:crypto'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { clientLocale, multipartBody, pcmPayload } from './audio.ts'
import { CloudReadiness } from './availability.ts'
import { Config, resolveOptions, type ResolvedOptions } from './config.ts'
import { attemptTranscription, type AttemptOutcome } from './request.ts'

export { Config } from './config.ts'
export const name = 'speech-to-text-deepseek'
export const inject = ['speechToText']

/** Header carrying the account token. */
const TOKEN_HEADER = 'x-dsh-auth-token'
const LOG_TAG = '[speech-to-text-deepseek]'

/**
 * Register the cloud recognizer and follow the account state without contacting the recognition service.
 * @param ctx - Host registry owner; the account service is read when present.
 * @param config - validated deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const options = resolveOptions(config)
  const readiness = new CloudReadiness(signedIn => inspect(ctx, options, signedIn))
  ctx.effect(() => () => { readiness.dispose() })
  ctx.inject(['deepseekAccount'], (scope) => {
    scope.effect(() => {
      const lifetime = new AbortController()
      const watching = (async () => {
        for await (const view of scope.deepseekAccount.watch(lifetime.signal)) await readiness.account(view.status === 'credential-stored')
      })().catch(async (error: unknown) => {
        if (lifetime.signal.aborted) return
        console.error(LOG_TAG, 'account observation failed:', error instanceof Error ? error.message : String(error))
        await readiness.account(false)
      })
      return async () => {
        lifetime.abort()
        await watching
        await readiness.account(false)
      }
    })
  })
  ctx.effect(() => ctx.speechToText.register({
    info: { id: options.providerId, name: 'DeepSeek', location: 'cloud', languages: options.languages },
    preparation: readiness,
    transcribe: async (input, signal) => await transcribe(ctx, options, input, signal),
  }))
  void readiness.refresh()
}

async function inspect(ctx: Context, options: ResolvedOptions, signedIn: boolean): Promise<SpeechPreparationState> {
  if (!signedIn) return { phase: 'unavailable', reason: 'sign-in-required' }
  const token = await ctx.get('deepseekAccount')?.resolveToken(options.endpoint.href)
  return token !== undefined ? { phase: 'ready' }
    : { phase: 'failed', message: `The DeepSeek account does not release a token for ${options.endpoint.origin}` }
}

async function transcribe(ctx: Context, options: ResolvedOptions, input: SpeechInput, signal: AbortSignal): Promise<Transcript> {
  const started = performance.now()
  const { pcm, seconds } = pcmPayload(input.audio, options.maxDurationSeconds)
  // `auto` sends no preference, so the service matches the client locale instead.
  const fields: [string, string][] = [['format', 'pcm'], ['audio_id', randomUUID()]]
  if (input.language !== 'auto') fields.push(['preferred_language', input.language])
  const { body, contentType } = multipartBody(fields,
    { name: 'file', filename: 'recording.pcm', bytes: pcm })
  if (body.byteLength > options.maxRequestBytes) {
    throw new SpeechTranscriptionError('invalid-audio', `Request is ${body.byteLength} bytes; the service accepts ${options.maxRequestBytes}`)
  }
  const account = ctx.get('deepseekAccount')
  const token = await account?.resolveToken(options.endpoint.href)
  if (token === undefined) throw new SpeechTranscriptionError('sign-in-required', 'Cloud recognition requires a signed-in DeepSeek account')
  const headers: Record<string, string> = { [TOKEN_HEADER]: token }
  if (input.locale !== undefined) headers['x-client-locale'] = clientLocale(input.locale)
  const request = { endpoint: options.endpoint, body, contentType, headers,
    timeoutMs: options.timeoutMs, maxResponseBytes: options.maxResponseBytes }
  let outcome: AttemptOutcome = await attemptTranscription(request, signal)
  // The service deduplicates by audio_id, so resubmitting the identical body cannot recognize the recording twice.
  if (outcome.kind === 'retryable') outcome = await attemptTranscription(request, signal)
  switch (outcome.kind) {
    case 'text': return { text: outcome.text, audioSeconds: seconds, inferenceSeconds: (performance.now() - started) / 1000 }
    case 'credentials-rejected':
      console.error(LOG_TAG, `${options.endpoint.pathname} rejected the account token: ${outcome.diagnostic}`)
      try { await account?.rejectToken(token) } catch (_removalFailed) {
        // A credential-store failure cannot replace the service's rejection, which the user must still see.
      }
      throw new SpeechTranscriptionError('sign-in-required', `The DeepSeek account token was rejected (${outcome.diagnostic})`)
    case 'retryable':
    case 'failed':
      console.error(LOG_TAG, `${options.endpoint.pathname} failed (${outcome.code}): ${outcome.diagnostic}`)
      throw new SpeechTranscriptionError(outcome.code, `Cloud recognition failed: ${outcome.diagnostic}`)
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default: return assertNever(outcome, 'speech attempt outcome')
  }
}
