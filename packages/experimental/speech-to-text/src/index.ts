/** Named transcription providers with disposable registration and explicit routing. */
import { Context, Service, type Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// Type-only: the `settings` service that persists `configure()` into this plugin's profile entry, and the Loader's
// entry and `loader/volatile-update` merges.
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {
  SpeechPreparationOptions, SpeechProvider, SpeechProviderId, SpeechProviderInfo, SpeechSelection, SpeechSnapshot, SpeechSelectionPatch,
  SpeechPreparationState, SpeechRequest, SpeechSpec, Transcript,
} from './types.ts'

export type * from './types.ts'
export { SpeechTranscriptionError } from './failure.ts'

/** Preference value that follows `autoOrder`; no provider may register it as an id. */
const AUTO = 'auto'
/** Phases in which a recording starts without preparation. */
const RECORDABLE: ReadonlySet<SpeechPreparationState['phase']> = new Set(['ready', 'standby', 'waking'])
/** Phases that refuse recordings until the user acts or the failure is resolved. */
const REFUSING: ReadonlySet<SpeechPreparationState['phase']> = new Set(['unavailable', 'failed'])

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Experimental speech recognition provider registry. */
    speechToText: SpeechToText
  }
}

/** Live selection read before a transcription starts; `configure()` writes it through the profile. */
export interface Config {
  /** Registered provider selected when the caller omits an id, or `auto` to follow `autoOrder`. */
  defaultProvider: Volatile<string>
  /** Provider ids considered by automatic selection, in preference order; required while `defaultProvider` is `auto`. */
  autoOrder: string[]
  /** Provider language hint selected when the caller omits one. */
  language: Volatile<string>
}

interface Registration {
  readonly provider: SpeechProvider
  readonly lifetime: AbortController
  readonly pending: Set<Promise<Transcript>>
  readonly unsubscribe: () => void
}

/** Registry shared by all transcription consumers in one Host composition. */
export default class SpeechToText extends Service {
  static Config = z.object({
    defaultProvider: z.string().min(1).required().volatile(),
    autoOrder: z.array(z.string().min(1)).default([]),
    language: z.string().min(1).default('auto').volatile(),
  })

  private readonly providers = new Map<SpeechProviderId, Registration>()
  private readonly listeners = new Set<() => void>()
  private readonly lifetime = new AbortController()
  /** Profile-local entry id used by Settings; absent when the plugin was mounted without Loader. */
  private readonly entryId: string | undefined

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'speechToText')
    if (config.autoOrder.includes(AUTO)) throw new Error('Speech autoOrder lists provider ids; `auto` is reserved')
    if (config.defaultProvider.get() === AUTO && config.autoOrder.length === 0) {
      throw new Error('Automatic speech provider selection requires a non-empty autoOrder')
    }
    this.entryId = ctx.fiber.entry?.options.id
    ctx.on('loader/volatile-update', () => { this.changed() })
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('Speech service disposed'))
      await Promise.all([...this.providers.values()].map(registration => this.remove(registration)))
      this.listeners.clear()
    })
  }

  /**
   * Register one recognizer; duplicate ids fail without replacing the original.
   * @param provider - recognizer owned by the contributing fiber.
   * @returns idempotent disposer which rejects admission, cancels, and joins accepted work.
   */
  register(provider: SpeechProvider): () => Promise<void> {
    this.lifetime.signal.throwIfAborted()
    if (provider.info.id === AUTO) throw new Error('Speech provider id `auto` is reserved for automatic selection')
    if (!provider.info.languages.includes(AUTO)) throw new Error(`Speech provider ${provider.info.id} must accept the language hint \`auto\``)
    if (this.providers.has(provider.info.id)) throw new Error(`Speech provider already registered: ${provider.info.id}`)
    const registration: Registration = { provider, lifetime: new AbortController(), pending: new Set(),
      unsubscribe: provider.preparation?.subscribe(() => { this.changed() }) ?? (() => {}) }
    this.providers.set(provider.info.id, registration)
    this.changed()
    return async () => { await this.remove(registration) }
  }

  private async remove(registration: Registration): Promise<void> {
    if (this.providers.get(registration.provider.info.id) !== registration) return
    this.providers.delete(registration.provider.info.id)
    registration.unsubscribe()
    this.changed()
    registration.lifetime.abort(new Error('Speech provider unloaded'))
    await Promise.allSettled(registration.pending)
  }

  /**
   * Read the current recognizer roster.
   * @returns available provider facts in registration order.
   */
  listProviders(): readonly SpeechProviderInfo[] {
    return [...this.providers.values()].map(({ provider }) => provider.info)
  }

  private changed(): void { for (const listener of this.listeners) listener() }

  /**
   * Observe complete readiness snapshots; a slow reader coalesces intermediate progress.
   * @param caller - observer lifetime, independent of any preparation task.
   * @returns an initial snapshot followed by the latest provider states.
   */
  async *follow(caller: AbortSignal): AsyncIterable<SpeechSnapshot> {
    const signal = AbortSignal.any([caller, this.lifetime.signal])
    signal.throwIfAborted()
    let wake = Promise.withResolvers<undefined>()
    let changed = true
    const aborted = (): boolean => signal.aborted
    const notify = (): void => { changed = true; wake.resolve(undefined) }
    this.listeners.add(notify)
    signal.addEventListener('abort', notify, { once: true })
    try {
      while (!aborted()) {
        if (!changed) await wake.promise
        if (aborted()) break
        wake = Promise.withResolvers<undefined>(); changed = false
        yield this.snapshot()
      }
    } finally {
      this.listeners.delete(notify)
      signal.removeEventListener('abort', notify)
    }
  }

  /**
   * Read provider readiness and current user preferences together.
   * @returns one detached complete observation.
   */
  snapshot(): SpeechSnapshot {
    return { providers: [...this.providers.values()].map(({ provider }) => ({ ...provider.info,
      preparation: provider.preparation?.snapshot() ?? { phase: 'ready' },
    })), selection: this.selection() }
  }

  /**
   * Apply the saved preference: an explicit id is kept even while unregistered; `auto` takes the first registered
   * `autoOrder` provider that records without preparation, else the first one that is neither unavailable nor failed,
   * else the first registered one so its state explains the refusal. A saved language no registered provider lists is
   * reported as `auto`.
   */
  private selection(): SpeechSelection {
    const language = this.savedLanguage(), choice = this.config.defaultProvider.get()
    if (choice !== AUTO) return { mode: 'explicit', providerId: choice as SpeechProviderId, language }
    const registered = this.config.autoOrder.flatMap(id => this.providers.get(id as SpeechProviderId)?.provider ?? [])
    const phase = (provider: SpeechProvider) => provider.preparation?.snapshot().phase ?? 'ready'
    const chosen = registered.find(provider => RECORDABLE.has(phase(provider)))
      ?? registered.find(provider => !REFUSING.has(phase(provider))) ?? registered[0]
    return { mode: 'auto', providerId: chosen?.info.id ?? this.config.autoOrder[0] as SpeechProviderId, language }
  }

  /** The saved language hint, or `auto` when no registered provider lists it, as after its provider is removed. */
  private savedLanguage(): string {
    const language = this.config.language.get()
    for (const { provider } of this.providers.values()) if (provider.info.languages.includes(language)) return language
    return AUTO
  }

  /**
   * Persist changed selection fields into this plugin's profile entry. The language must be listed by at least one
   * registered provider; a provider that does not list it receives `auto` when it transcribes.
   * @param patch - explicit provider, `auto`, or language changes.
   * @returns after the profile write and the live update it applies.
   */
  async configure(patch: SpeechSelectionPatch): Promise<void> {
    const settings = this.ctx.get('settings')
    const entry = this.entryId
    if (settings === undefined || entry === undefined) throw new Error('Speech selection requires the settings service and a profile entry')
    const choice = patch.providerId ?? this.config.defaultProvider.get()
    if (choice === AUTO) {
      if (this.config.autoOrder.length === 0) throw new Error('Automatic speech provider selection requires a non-empty autoOrder')
    } else {
      this.registered(choice as SpeechProviderId)
    }
    this.knownLanguage(patch.language ?? this.config.language.get())
    await settings.update(entry, { ...patch.providerId === undefined ? {} : { defaultProvider: patch.providerId },
      ...patch.language === undefined ? {} : { language: patch.language } })
  }

  private registered(id: SpeechProviderId): SpeechProvider {
    const registration = this.providers.get(id)
    if (!registration) throw new Error(`Speech provider is unavailable: ${id}`)
    return registration.provider
  }

  /** Reject a hint that no registered provider lists; such a value cannot come from any offered choice. */
  private knownLanguage(language: string): string {
    for (const { provider } of this.providers.values()) if (provider.info.languages.includes(language)) return language
    throw new Error(`No registered speech provider supports language: ${language}`)
  }

  /**
   * Start or join provider-owned preparation.
   * @param id - exact registered provider identity.
   * @param options - task-local source selection validated by the provider.
   */
  prepare(id: SpeechProviderId, options?: SpeechPreparationOptions): void {
    const registration = this.providers.get(id)
    if (!registration) throw new Error(`Speech provider is unavailable: ${id}`)
    registration.provider.preparation?.prepare(options)
  }

  /**
   * Explicitly cancel provider preparation without tying it to a browser connection.
   * @param id - exact registered provider identity.
   * @returns after the preparation task settles.
   */
  async cancelPreparation(id: SpeechProviderId): Promise<void> {
    const registration = this.providers.get(id)
    if (!registration) throw new Error(`Speech provider is unavailable: ${id}`)
    await registration.provider.preparation?.cancel()
  }

  /**
   * Apply the saved selection and capture the provider. Missing providers and requested hints no registered provider
   * lists fail explicitly; a saved hint no registered provider lists becomes `auto`. The captured provider receives the
   * hint when it lists it and `auto` otherwise.
   * @param request - complete recording and optional selection.
   * @returns provider-pinned input for transcribe().
   */
  resolve(request: SpeechRequest): SpeechSpec {
    if (request.providerId === undefined && this.config.defaultProvider.get() === AUTO && this.config.autoOrder.length === 0) {
      throw new Error('Automatic speech provider selection requires a non-empty autoOrder')
    }
    const provider = this.registered(request.providerId ?? this.selection().providerId)
    const language = request.language === undefined ? this.savedLanguage() : this.knownLanguage(request.language)
    return { provider, audio: request.audio, language: provider.info.languages.includes(language) ? language : AUTO }
  }

  /**
   * Execute exactly the resolved provider; no fallback sends audio elsewhere.
   * @param spec - resolved input; a withdrawn or replaced registration is rejected.
   * @param signal - caller cancellation.
   * @returns final transcript after provider settlement.
   */
  async transcribe(spec: SpeechSpec, signal: AbortSignal): Promise<Transcript> {
    signal.throwIfAborted()
    const registration = this.providers.get(spec.provider.info.id)
    if (registration?.provider !== spec.provider) throw new Error('Resolved speech provider is no longer registered')
    const combined = AbortSignal.any([signal, registration.lifetime.signal])
    const pending = Promise.resolve().then(() => {
      combined.throwIfAborted()
      return spec.provider.transcribe({ audio: spec.audio, language: spec.language }, combined)
    })
    registration.pending.add(pending)
    try {
      const result = await pending
      combined.throwIfAborted()
      return result
    } finally {
      registration.pending.delete(pending)
    }
  }
}
