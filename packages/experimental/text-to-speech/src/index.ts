/** Named speech synthesis providers with disposable registration and explicit routing. */
import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: the `settings` service that persists `configure()` into this plugin's profile entry, and the Loader's
// entry and `loader/volatile-update` merges.
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { SpeechSynthesisError } from './failure.ts'
import type {
  SynthesisProvider, SynthesisProviderId, SynthesisRequest, SynthesisSelectionPatch, SynthesisSnapshot, SynthesisSpec,
} from './types.ts'

export type * from './types.ts'
export { SpeechSynthesisError } from './failure.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Experimental speech synthesis provider registry. */
    textToSpeech: TextToSpeech
  }
}

/** Composition choice and the live voice preference, both read when a synthesis is resolved. */
export interface Config {
  /** Id of the registered provider that speaks every request. */
  defaultProvider: string
  /** Saved voice id, written by `configure()`; absent, or a voice the provider does not offer, selects the provider's default. */
  voice: Volatile<string | undefined>
}

interface Registration {
  readonly provider: SynthesisProvider
  readonly lifetime: AbortController
  /** Provider calls in flight; withdrawal joins them. */
  readonly calls: Set<Promise<unknown>>
  readonly unsubscribe: () => void
}

/** Registry shared by all synthesis consumers in one Host composition. */
export default class TextToSpeech extends Service {
  static Config = z.object({
    defaultProvider: z.string().min(1).required(),
    voice: z.string().min(1).volatile(),
  })

  private readonly providers = new Map<SynthesisProviderId, Registration>()
  private readonly observers = new Set<() => void>()
  private readonly lifetime = new AbortController()
  /** Profile-local entry id used by Settings; absent when the plugin was mounted without Loader. */
  private readonly entryId: string | undefined

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'textToSpeech')
    this.entryId = ctx.fiber.entry?.options.id
    ctx.on('loader/volatile-update', () => { this.notify() })
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Speech synthesis service disposed'))
      await Promise.all([...this.providers.values()].map(registration => this.withdraw(registration)))
      this.observers.clear()
    })
  }

  /**
   * Register one synthesizer; a duplicate id fails without replacing the original.
   * @param provider - synthesizer owned by the contributing fiber.
   * @returns idempotent disposer which rejects later pulls, cancels, and joins provider calls in flight.
   */
  register(provider: SynthesisProvider): () => Promise<void> {
    this.lifetime.signal.throwIfAborted()
    if (this.providers.has(provider.info.id)) throw new Error(`Speech synthesis provider already registered: ${provider.info.id}`)
    if (provider.info.voices.length === 0) throw new Error(`Speech synthesis provider lists no voice: ${provider.info.id}`)
    const registration: Registration = { provider, lifetime: new AbortController(), calls: new Set(),
      unsubscribe: provider.availability?.subscribe(() => { this.notify() }) ?? (() => {}) }
    this.providers.set(provider.info.id, registration)
    this.notify()
    return async () => { await this.withdraw(registration) }
  }

  private async withdraw(registration: Registration): Promise<void> {
    if (this.providers.get(registration.provider.info.id) !== registration) return
    this.providers.delete(registration.provider.info.id)
    registration.unsubscribe()
    this.notify()
    registration.lifetime.abort(new Error('Speech synthesis provider unloaded'))
    await Promise.allSettled(registration.calls)
  }

  private notify(): void { for (const observer of this.observers) observer() }

  /**
   * Read provider availability, the configured selection, and the voice preference together.
   * @returns one detached complete observation.
   */
  snapshot(): SynthesisSnapshot {
    return {
      providers: [...this.providers.values()].map(({ provider }) => ({
        ...provider.info, availability: provider.availability?.snapshot() ?? { phase: 'ready' }, voice: this.voiceOf(provider),
      })),
      selected: this.config.defaultProvider as SynthesisProviderId,
    }
  }

  /** The saved voice while the provider offers it, else the provider's default, as after the provider is replaced. */
  private voiceOf(provider: SynthesisProvider): string {
    const saved = this.config.voice.get()
    // `register()` refused an empty list, so the first voice exists.
    return saved !== undefined && provider.info.voices.includes(saved) ? saved : provider.info.voices[0] as string
  }

  /** The configured provider, or a classified failure while none is registered under that id. */
  private selectedProvider(): SynthesisProvider {
    const registration = this.providers.get(this.config.defaultProvider as SynthesisProviderId)
    if (registration === undefined) {
      throw new SpeechSynthesisError('service-unavailable', `Speech synthesis provider is unavailable: ${this.config.defaultProvider}`)
    }
    return registration.provider
  }

  /** Refuse a voice that the provider does not offer; such a value cannot come from any offered choice. */
  private offered(provider: SynthesisProvider, voice: string): string {
    if (!provider.info.voices.includes(voice)) throw new Error(`Speech synthesis provider ${provider.info.id} offers no voice ${voice}`)
    return voice
  }

  /**
   * Persist the voice preference into this plugin's profile entry. The configured provider must be registered and
   * offer the voice.
   * @param patch - voice that later syntheses use when they name none.
   * @returns after the profile write and the live update it applies.
   */
  async configure(patch: SynthesisSelectionPatch): Promise<void> {
    const settings = this.ctx.get('settings')
    const entry = this.entryId
    if (settings === undefined || entry === undefined) {
      throw new Error('Speech synthesis selection requires the settings service and a profile entry')
    }
    await settings.update(entry, { voice: this.offered(this.selectedProvider(), patch.voice) })
  }

  /**
   * Observe complete snapshots; an observer that falls behind receives only the latest one.
   * @param caller - observer lifetime.
   * @returns an initial snapshot followed by one per change, ending when the observer or the service stops.
   */
  async *follow(caller: AbortSignal): AsyncIterable<SynthesisSnapshot> {
    const signal = AbortSignal.any([caller, this.lifetime.signal])
    signal.throwIfAborted()
    let stale = true
    let wake = (): void => {}
    const observer = (): void => { stale = true; wake() }
    this.observers.add(observer)
    signal.addEventListener('abort', observer, { once: true })
    try {
      for (;;) {
        if (!stale) await new Promise<void>((resolve) => { wake = resolve })
        if (signal.aborted) return
        stale = false
        yield this.snapshot()
      }
    } finally {
      this.observers.delete(observer)
      signal.removeEventListener('abort', observer)
    }
  }

  /**
   * Apply the configured provider and the voice preference, and capture both. A missing provider, a text over the
   * provider's limit, and a named voice the provider does not offer fail explicitly.
   * @param request - complete text to speak and optionally its voice.
   * @returns provider-pinned input for synthesize().
   */
  resolve(request: SynthesisRequest): SynthesisSpec {
    const provider = this.selectedProvider()
    const { id, maxCharacters } = provider.info
    if (request.text.length > maxCharacters) {
      throw new Error(`Speech synthesis provider ${id} accepts at most ${maxCharacters} characters, got ${request.text.length}`)
    }
    const voice = request.voice === undefined ? this.voiceOf(provider) : this.offered(provider, request.voice)
    return { provider, text: request.text, voice }
  }

  /**
   * Speak through exactly the resolved provider; no fallback sends text elsewhere. A stream nobody pulls holds no
   * provider call: withdrawal aborts the provider's signal and joins only calls in flight.
   * @param spec - resolved input; a withdrawn or replaced registration is rejected.
   * @param signal - caller cancellation.
   * @returns the provider's audio; pulls after cancellation or withdrawal reject.
   */
  synthesize(spec: SynthesisSpec, signal: AbortSignal): AsyncIterable<Uint8Array> {
    signal.throwIfAborted()
    const registration = this.providers.get(spec.provider.info.id)
    if (registration?.provider !== spec.provider) throw new Error('Resolved speech synthesis provider is no longer registered')
    const combined = AbortSignal.any([signal, registration.lifetime.signal])
    const source = spec.provider.synthesize({ text: spec.text, voice: spec.voice }, combined)[Symbol.asyncIterator]()
    const joined = <T>(call: Promise<T>): Promise<T> => {
      registration.calls.add(call)
      const settled = (): void => { registration.calls.delete(call) }
      call.then(settled, settled)
      return call
    }
    const stream: AsyncIterableIterator<Uint8Array> = {
      [Symbol.asyncIterator]: () => stream,
      next: () => joined((async () => {
        combined.throwIfAborted()
        const result = await source.next()
        combined.throwIfAborted()
        return result
      })()),
      return: () => joined((async () => {
        await source.return?.()
        return { done: true as const, value: undefined }
      })()),
    }
    return stream
  }
}
