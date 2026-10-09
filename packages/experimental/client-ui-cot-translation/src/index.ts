/** Host access to machine translation of displayed reasoning. */
import { addAbortListener } from 'node:events'
import { Context, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { TranslationError } from '@deepseek-ai/dsh-experimental-translator'
import type { TranslationRequest, TranslationSpec } from '@deepseek-ai/dsh-experimental-translator/types'
import { LANGUAGE_PREFERENCE_PATTERN, PROVIDER_PREFERENCES } from './preferences.ts'
import type { CotTranslationPreferences, CotTranslationSnapshot } from './types.ts'

/** Live preferences presented on the bundle's Plugins page. */
export interface Config {
  /** Explicit translation provider, defaulting to Bing. */
  provider: Volatile<CotTranslationPreferences['provider']>
  /** Target language code; auto follows the browser UI locale. */
  targetLanguage: Volatile<string>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Remote consumer of the experimental translation service. */
    cotTranslation: CotTranslationController
  }
}

/** Optional reasoning translation delegates Session-bound storage to the translator. */
export default class CotTranslationController extends TypertRemoteService {
  static inject = ['translator', 'typert', 'sessionController']
  static Config = z.object({
    provider: z.union(PROVIDER_PREFERENCES).default('bing').volatile(),
    targetLanguage: z.string().pattern(LANGUAGE_PREFERENCE_PATTERN).default('auto').volatile(),
  })

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'cotTranslation', { namespace: 'cotTranslation' })
    ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  }

  /**
   * Read accepted translation preferences and the current request limit without sending text.
   * @param signal - browser query cancellation or Remote contribution withdrawal.
   * @returns authoritative preferences, eligible routes, and maximum UTF-16 text length per request.
   */
  @Remote
  async limits(signal: AbortSignal): Promise<CotTranslationSnapshot> {
    signal.throwIfAborted()
    const availableProviders = await this.ctx.translator.availableProviders(signal)
    signal.throwIfAborted()
    return { maxTextChars: this.ctx.translator.maxTextChars,
      preferences: { provider: this.config.provider.get(), targetLanguage: this.config.targetLanguage.get() }, availableProviders }
  }

  /**
   * Translate one displayed fragment through the reader's selected provider.
   * @param request - original text and Session identity supplied by the Client; provider and explicit
   * target language match accepted preferences, while auto uses the browser locale.
   * @param signal - browser cancellation or Remote contribution withdrawal.
   * @returns translated text; an uncached inactive Session joins ordinary GUI activation before retry.
   * Failures omit the source and provider response. Cancellation stops this caller's wait, not shared activation.
   */
  @Remote
  async translate(request: TranslationRequest, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    try {
      const spec = this.resolveSelected(request)
      try {
        return await this.ctx.translator.translate(spec, signal)
      } catch (error) {
        if (!(error instanceof TranslationError) || error.code !== 'TRANSLATION_SESSION_INACTIVE' || spec.sessionId === undefined) throw error
      }
      signal.throwIfAborted()
      const activation = this.ctx.sessionController.resolveAgent(spec.sessionId).then((result) => {
        if ('error' in result) throw result.error
      }).catch((error: unknown) => {
        if (signal.aborted) this.ctx.logger.warn('Reasoning translation Session activation failed after cancellation')
        throw error
      })
      const cancelled = Promise.withResolvers<never>()
      using _listener = addAbortListener(signal, () => {
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve the caller's arbitrary cancellation reason.
        cancelled.reject(signal.reason)
      })
      await Promise.race([activation, cancelled.promise])
      signal.throwIfAborted()
      return await this.ctx.translator.translate(this.resolveSelected(spec), signal)
    } catch (_error) {
      signal.throwIfAborted()
      throw new RemoteError('cotTranslation/failed', 'Translation failed', {})
    }
  }

  private resolveSelected(request: TranslationRequest): TranslationSpec {
    const accepted = this.config.provider.get()
    const provider = request.provider ?? accepted
    if (provider !== accepted) throw new Error('Translation provider is not selected')
    const targetLanguage = this.config.targetLanguage.get()
    if (targetLanguage !== 'auto' && request.targetLanguage !== targetLanguage) throw new Error('Translation language is not selected')
    return this.ctx.translator.resolve({ ...request, provider })
  }
}
