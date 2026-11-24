/**
 * Optional DeepSeek cloud synthesizer. Each text goes to `/v1/tools/tts`, authenticated through `ctx.deepseekAuth`
 * with the DeepSeek account sign-in first and the API key second, and comes back as streamed 24 kHz PCM. Activation
 * sends no text and contacts no service.
 * @module @deepseek-ai/dsh-text-to-speech-deepseek
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import { DeepSeekAuthError } from '@deepseek-ai/dsh-deepseek-auth'
import type {
  DeepSeekAuthCandidate, DeepSeekAuthKind, DeepSeekAuthUnresolved, DeepSeekAuthorization,
} from '@deepseek-ai/dsh-deepseek-auth'
import { SpeechSynthesisError } from '@deepseek-ai/dsh-text-to-speech'
import type { SynthesisAvailability, SynthesisInput } from '@deepseek-ai/dsh-text-to-speech/types'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { CredentialAvailability } from './availability.ts'
import { Config, resolveOptions, type ResolvedOptions } from './config.ts'
import { describeTransport, openSynthesis } from './request.ts'

export { Config } from './config.ts'
export const name = 'text-to-speech-deepseek'
export const inject = ['textToSpeech', 'deepseekAuth']

/** Path of the speech synthesis API under the origin of the chosen credential's deployment. */
const TTS_PATH = '/v1/tools/tts'
/** Credential kinds the speech synthesis API accepts. */
const ACCEPTS: readonly DeepSeekAuthKind[] = ['account', 'api-key']
/**
 * Order in which the kinds are tried: the account sign-in first, because its deployment is the official one unless a
 * deployment overrides it, while an API key often belongs to a custom endpoint.
 */
const ORDER: readonly DeepSeekAuthKind[] = ['account', 'api-key']
/** The API bills and limits a request by 10,000 units where a Chinese character counts two, so 5,000 code units always fit. */
const MAX_CHARACTERS = 5_000
/** Sample rate of the API's `pcm` format. */
const SAMPLE_RATE = 24_000
/** `voice_id` values of the API: `stella` is its female default, `tide` its male voice. */
const VOICES: readonly string[] = ['stella', 'tide']
const IDLE = 'TTS_AUDIO_IDLE'
const LOG_TAG = '[text-to-speech-deepseek]'

/**
 * Register the cloud synthesizer and re-inspect its credentials whenever a credential or the account service changes.
 * @param ctx - Host registry owner with the synthesis and DeepSeek authentication services.
 * @param config - validated deployment configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const options = resolveOptions(config)
  const availability = new CredentialAvailability(() => inspect(ctx))
  ctx.effect(() => () => { availability.stop() }, 'text-to-speech-deepseek: availability')
  const refresh = (): void => { void availability.refresh() }
  ctx.on('credentials/record-updated', refresh)
  ctx.on('credentials/reference-updated', refresh)
  ctx.on('internal/service', (service: string) => { if (service === 'deepseekAccount') refresh() })
  ctx.effect(() => ctx.textToSpeech.register({
    info: {
      id: options.providerId, name: 'DeepSeek', location: 'cloud',
      audio: { encoding: 'pcm-s16le', sampleRate: SAMPLE_RATE }, maxCharacters: MAX_CHARACTERS, voices: VOICES,
    },
    availability,
    synthesize: (input, signal) => synthesize(ctx, options, input, signal),
  }), 'text-to-speech-deepseek: provider')
  refresh()
}

/** The candidates of every kind in {@link ORDER}, each bound to the speech synthesis endpoint of its deployment. */
function candidates(ctx: Context): (DeepSeekAuthCandidate | DeepSeekAuthUnresolved)[] {
  return ORDER.flatMap(billing => ctx.deepseekAuth.candidates({
    consumer: name, accepts: ACCEPTS, billing, destination: { path: TTS_PATH },
  }))
}

function unresolvedMessage(candidate: DeepSeekAuthUnresolved): string {
  const error = candidate.error instanceof Error ? candidate.error.message : String(candidate.error)
  return `The DeepSeek ${candidate.kind} ${candidate.unresolved} does not resolve: ${error}`
}

/** Ready while a kind has a credential, failed at a kind whose settings do not resolve, else waiting for a credential. */
async function inspect(ctx: Context): Promise<SynthesisAvailability> {
  for (const candidate of candidates(ctx)) {
    if ('unresolved' in candidate) return { phase: 'failed', message: unresolvedMessage(candidate) }
    if (await candidate.configured()) return { phase: 'ready' }
  }
  return { phase: 'unavailable', reason: 'sign-in-required' }
}

/** Release the first credential in {@link ORDER}; stops at a kind whose settings do not resolve. */
async function authorize(ctx: Context, signal: AbortSignal): Promise<DeepSeekAuthorization> {
  for (const candidate of candidates(ctx)) {
    if ('unresolved' in candidate) throw new SpeechSynthesisError('service-error', unresolvedMessage(candidate), { cause: candidate.error })
    const authorization = await candidate.resolve(signal).catch((error: unknown) => {
      if (error instanceof DeepSeekAuthError && error.code === 'INVALID_CREDENTIAL') {
        throw new SpeechSynthesisError('api-key-invalid', error.message, { cause: error })
      }
      throw error
    })
    if (authorization !== undefined) return authorization
  }
  throw new SpeechSynthesisError('sign-in-required', 'Cloud synthesis requires a DeepSeek account sign-in or a DeepSeek API key')
}

/**
 * Bound each wait for audio and name the outcome: the idle deadline is `timeout`, the caller's abort propagates, and
 * an unclassified rejection is a transport failure.
 */
async function* synthesize(ctx: Context, options: ResolvedOptions, input: SynthesisInput, caller: AbortSignal): AsyncGenerator<Uint8Array> {
  const consumer = new AbortController()
  using watchdog = idleWatchdog(AbortSignal.any([consumer.signal, caller]), options.idleTimeoutMs, IDLE)
  const audio = request(ctx, input, watchdog.signal)
  try {
    for (;;) {
      const next = await watchdog.next(audio)
      if (next.done === true) return
      yield next.value
    }
  } catch (error) {
    if (timeoutOf(watchdog.signal, IDLE) !== undefined) {
      throw new SpeechSynthesisError('timeout', `No audio arrived within ${options.idleTimeoutMs} ms`, { cause: error })
    }
    caller.throwIfAborted()
    if (error instanceof SpeechSynthesisError) throw error
    throw new SpeechSynthesisError('service-unavailable', `Cloud synthesis request failed: ${describeTransport(error)}`, { cause: error })
  } finally {
    consumer.abort()
    // The abort above ends the request. A wait the deadline abandoned can stay pending, and the generator queues its
    // return behind that wait, so the return is not awaited.
    /* v8 ignore next -- the detached return only rejects while unwinding an abandoned request. */
    void audio.return(undefined).catch(() => {})
  }
}

/** One authorized request: its classified head, then the audio body. The request ends with its credential. */
async function* request(ctx: Context, input: SynthesisInput, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const authorization = await authorize(ctx, signal)
  const live = authorization.revoked === undefined ? signal : AbortSignal.any([signal, authorization.revoked])
  const signedOut = (error: unknown): never => {
    if (!signal.aborted && authorization.revoked?.aborted === true) {
      throw new SpeechSynthesisError('sign-in-required', 'The DeepSeek account signed out during synthesis', { cause: error })
    }
    throw error
  }
  const { endpoint, headers } = authorization
  const opened = await openSynthesis({ endpoint, headers, text: input.text, voice: input.voice }, live).catch(signedOut)
  const path = new URL(endpoint).pathname
  switch (opened.kind) {
    case 'audio': {
      let received = 0
      try {
        for await (const chunk of opened.body) {
          received += chunk.byteLength
          yield chunk
        }
      } catch (error) {
        if (signal.aborted) throw error
        if (authorization.revoked?.aborted === true) signedOut(error)
        console.error(LOG_TAG, `${path} audio ended early after ${received} bytes: ${describeTransport(error)}`)
        throw new SpeechSynthesisError('service-error', `Cloud synthesis audio ended early after ${received} bytes`, { cause: error })
      }
      if (received === 0) throw new SpeechSynthesisError('service-error', 'Cloud synthesis returned no audio')
      return
    }
    case 'credentials-rejected':
      console.error(LOG_TAG, `${path} rejected the ${authorization.kind} credential: ${opened.diagnostic}`)
      if (authorization.kind === 'api-key') {
        throw new SpeechSynthesisError('api-key-invalid', `The DeepSeek API key was rejected (${opened.diagnostic})`)
      }
      // The account service contains its own storage failures, so the rejection below is always the reported failure.
      await authorization.reject?.()
      throw new SpeechSynthesisError('sign-in-required', `The DeepSeek account sign-in was rejected (${opened.diagnostic})`)
    case 'failed':
      console.error(LOG_TAG, `${path} failed (${opened.code}): ${opened.diagnostic}`)
      throw new SpeechSynthesisError(opened.code, `Cloud synthesis failed: ${opened.diagnostic}`)
    /* v8 ignore next -- closed-union exhaustiveness guard */
    default: return assertNever(opened, 'speech synthesis response')
  }
}
