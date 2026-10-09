/** Anonymous text translation with optional durable provider-independent Session results. */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { TranslationProvider, TranslationRequest, TranslationSpec } from './types.ts'
import { TranslationError } from './error.ts'
import { anonymousRecipe, translateText } from './provider.ts'
import { TranslationStorage } from './storage.ts'
import { addAbortListener } from 'node:events'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { availablePaidProviders, deepseekRecipe, translateWithDeepSeek } from './deepseek.ts'
import type { TranslationIdentity } from './types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

export type * from './types.ts'
export { TranslationError } from './error.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Experimental text translator with optional durable Session reuse. */
    translator: Translator
  }
}

/** Routing and bounds for anonymous requests and independent native model translation. */
export interface Config {
  /** Provider selected when a consumer omits it. */
  provider: TranslationProvider
  /** Google-compatible anonymous translation endpoint. */
  googleEndpoint: string
  /** Bing-compatible Microsoft Edge browser translation endpoint. */
  bingEndpoint: string
  /** Deadline covering the request and complete response body, in milliseconds. */
  timeoutMs: number
  /** Maximum UTF-16 code units per request; at least two to admit one supplementary-plane character. */
  maxTextChars: number
  /** Maximum anonymous JSON-body bytes or paid assembled UTF-8 translation bytes. */
  maxResponseBytes: number
  /** Deadline for native admission and complete translation output, in milliseconds. */
  deepseekTimeoutMs: number
  /** Requested output-token cap for independent native Flash translation. */
  deepseekMaxOutputTokens: number
}

function endpoint(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error('Translation endpoint must be an HTTP(S) URL without credentials or a fragment')
  }
  return url.href
}

/** One Host service with explicit routing, cancellation and quiescent unload. */
export default class Translator extends Service {
  static Config = z.object({
    provider: z.union(['google', 'bing', 'deepseek-account', 'deepseek-official'] as const).default('bing'),
    googleEndpoint: z.transform(z.string(), endpoint).default('https://translate.googleapis.com/translate_a/single'),
    bingEndpoint: z.transform(z.string(), endpoint).default('https://edge.microsoft.com/translate/translatetext'),
    timeoutMs: z.natural().min(1).max(2_147_483_647).default(10_000),
    maxTextChars: z.natural().min(2).default(4_000),
    maxResponseBytes: z.natural().min(1).default(1024 * 1024),
    deepseekTimeoutMs: z.natural().min(1).max(2_147_483_647).default(60_000),
    deepseekMaxOutputTokens: z.natural().min(1).default(8192),
  })

  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<void>>()
  private readonly storage: TranslationStorage

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'translator')
    this.storage = new TranslationStorage(ctx)
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Translator service disposed'))
      await Promise.allSettled(this.pending)
    })
  }

  /** Maximum UTF-16 code units accepted by one provider request. */
  get maxTextChars(): number { return this.config.maxTextChars }

  /**
   * Inspect eligible native routes without inference; saved results remain readable for unavailable routes.
   * @param signal - optional caller cancellation, combined with service disposal.
   * @returns anonymous choices followed by eligible explicitly selected paid routes.
   */
  async availableProviders(signal?: AbortSignal): Promise<readonly TranslationProvider[]> {
    const combined = this.signal(signal)
    const task = Promise.resolve().then(() => availablePaidProviders(this.ctx, this.config, combined, (work) => { this.track(work) }))
    this.track(task)
    return task
  }

  /**
   * Resolve provider and source-language defaults without sending text.
   * @param request - consumer text, destination and optional routing choices.
   * @returns a complete specification; exceeding `maxTextChars` throws `TRANSLATION_TEXT_LIMIT`.
   */
  resolve(request: TranslationRequest): TranslationSpec {
    this.lifetime.signal.throwIfAborted()
    this.assertTextLimit(request.text)
    const provider = request.provider ?? this.config.provider
    const base = { text: request.text, targetLanguage: request.targetLanguage, sourceLanguage: request.sourceLanguage ?? 'auto' }
    switch (provider) {
      case 'google':
      case 'bing': return { ...base, provider, ...request.sessionId === undefined ? {} : { sessionId: request.sessionId } }
      case 'deepseek-account':
      case 'deepseek-official': {
        if (request.sessionId === undefined) throw new TranslationError('TRANSLATION_SESSION_REQUIRED', 'Paid translation requires a durable Session')
        return { ...base, provider, sessionId: request.sessionId }
      }
      /* v8 ignore next -- TranslationProvider is a closed union validated by Config or Remote request admission. */
      default: return assertNever(provider)
    }
  }

  /**
   * Translate one resolved specification; the selected provider receives its text.
   * @param spec - complete routing and language choices from `resolve()`.
   * @param signal - optional caller cancellation, combined with service disposal.
   * @returns translated plain text, durably retained before return when a Session is supplied.
   * An uncached supplied Session must be active; otherwise rejects with `TRANSLATION_SESSION_INACTIVE` before dispatch.
   * Rejects provider/storage/limit failures and preserves cancellation reasons.
   */
  async translate(spec: TranslationSpec, signal?: AbortSignal): Promise<string> {
    this.assertTextLimit(spec.text)
    const combined = this.signal(signal)
    const identity: TranslationIdentity = { provider: spec.provider, text: spec.text, sourceLanguage: spec.sourceLanguage,
      targetLanguage: spec.targetLanguage, recipe: spec.provider === 'google' || spec.provider === 'bing'
        ? anonymousRecipe(spec.provider, this.config) : deepseekRecipe(this.config) }
    const inSession = (id: SessionId) => this.storage.run(id, identity, combined, async (log) => {
      switch (spec.provider) {
        case 'deepseek-account':
        case 'deepseek-official':
          return translateWithDeepSeek(this.ctx, spec, this.config, combined, (work) => { this.track(work) }, log, identity)
        case 'google':
        case 'bing': {
          const requestSeq = await log.request(identity)
          combined.throwIfAborted()
          const text = await translateText(spec, this.config, combined)
          combined.throwIfAborted()
          await log.result(requestSeq, text)
          return text
        }
        /* v8 ignore next -- TranslationSpec has a closed provider union resolved before same-process dispatch. */
        default: return assertNever(spec)
      }
    })
    const task = Promise.resolve().then(() => {
      switch (spec.provider) {
        case 'google':
        case 'bing': return spec.sessionId === undefined ? translateText(spec, this.config, combined) : inSession(spec.sessionId)
        case 'deepseek-account':
        case 'deepseek-official': return inSession(spec.sessionId)
        /* v8 ignore next -- TranslationSpec has a closed provider union resolved before same-process dispatch. */
        default: return assertNever(spec)
      }
    })
    this.track(task)
    return await new Promise<string>((resolve, reject) => {
      const listener = addAbortListener(combined, () => {
        // Preserve the caller's arbitrary abort reason while accepted work remains owned until settlement.
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors
        reject(combined.reason)
      })
      void task.then(resolve, reject).finally(() => { listener[Symbol.dispose]() })
    })
  }

  private signal(caller?: AbortSignal): AbortSignal {
    this.lifetime.signal.throwIfAborted()
    const signal = caller === undefined ? this.lifetime.signal : AbortSignal.any([caller, this.lifetime.signal])
    signal.throwIfAborted()
    return signal
  }

  private track(work: Promise<unknown>): void {
    const settled = work.then(() => {}, () => {})
    this.pending.add(settled)
    void settled.then(() => { this.pending.delete(settled) })
  }

  private assertTextLimit(text: string): void {
    if (text.length > this.config.maxTextChars) {
      throw new TranslationError('TRANSLATION_TEXT_LIMIT', `Translation text exceeds ${this.config.maxTextChars} UTF-16 code units`)
    }
  }
}
