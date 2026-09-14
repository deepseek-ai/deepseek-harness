/**
 * Agent skill provider registry.
 *
 * This package owns the Service Definition role of the skill capability seam.
 * Concrete
 * providers such as `@deepseek-ai/dsh-skill-filesystem` decide where skills come
 * from; this service only merges provider catalogs, resolves the winning skill
 * for a name, and exposes the winning summaries and definitions to consumers.
 *
 * @module @deepseek-ai/dsh-skill
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { NamedEntries, ScopedLayers, scopeChainOf, scopeOf } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, ScopeLayer } from '@deepseek-ai/dsh-scope'
import z from '@deepseek-ai/schemastery'
import type Schema from '@deepseek-ai/schemastery'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DEFAULT_COLLECT_CACHE_ENTRIES = 128
const MAX_COLLECT_ATTEMPTS = 2
const RUNTIME_PROVIDER = 'runtime'
const RUNTIME_RANK = 250

/** Standard precedence rank for packaged skill providers and local bundled roots. */
export const BUNDLED_SKILL_RANK = 600

/**
 * Return whether a string is a valid kebab-case skill name.
 * @param name - candidate skill name to validate.
 * @returns whether the name matches the public skill-name grammar.
 */
export function isSkillName(name: string): boolean {
  return SKILL_NAME.test(name)
}

/** Origin bucket for a skill contribution. The value is prompt-visible metadata, not precedence by itself. */
export type SkillSource = 'project-dsh' | 'project-agents' | 'runtime' | 'user-dsh' | 'user-agents' | 'custom' | 'bundled' | (string & {})

/** Optional provider-specific base used by loaded skill bodies to resolve relative resources. */
export type SkillResourceBase =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'opaque'; readonly description: string }

/** Invocation controls shared by skill discovery consumers. */
export interface SkillInvocationPolicy {
  /** Whether model-facing catalogs and loaders include this skill. */
  readonly modelInvocable: boolean
  /** Whether human-facing command catalogs and loaders include this skill. */
  readonly userInvocable: boolean
}

/** Invocation-neutral skill metadata returned by `ctx.skills.list()`. */
export interface SkillSummary {
  /** Absolute instruction file path when supplied by the provider; absent for virtual skills. */
  readonly path?: string
  /** Kebab-case identifier used to address the skill. */
  readonly name: string
  /** Short routing description shown by discovery consumers. */
  readonly description: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** Resolved model and user invocation controls. */
  readonly invocation: SkillInvocationPolicy
  /** Discovery source that produced this winning skill. */
  readonly source: SkillSource
  /** Provider that owns this skill body. */
  readonly provider: string
  /** Provider-specific base for relative resources. */
  readonly resourceBase?: SkillResourceBase
}

/** Provider catalog entry used by the registry to merge and later load skills. */
export interface SkillCandidate extends SkillSummary {
  /** Lower ranks win duplicate skill names before provider registration order is considered. */
  readonly rank: number
  /** Opaque provider-owned handle passed back to `provider.get()`. */
  readonly locator: unknown
  /** Parsed optional metadata object from provider-specific skill frontmatter. */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Complete parsed skill definition, including the body loaded by `ctx.skills.get()`. */
export interface SkillDefinition extends SkillSummary {
  /** Markdown instruction body after any provider-specific metadata removal. */
  readonly content: string
  /** Parsed optional metadata object from frontmatter. */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Runtime skill contribution accepted by `ctx.skills.register()`. */
export type SkillRegistration = Omit<SkillDefinition, 'invocation' | 'provider'> & {
  /** Invocation controls; omission permits both model and user surfaces. */
  readonly invocation?: SkillInvocationPolicy
  /** Provider label; omission uses the registry-owned runtime provider. */
  readonly provider?: string
}

/** Caller context used for cwd-sensitive and abortable provider work. */
export interface SkillLookupOptions {
  /** Workspace selector for the current lookup. */
  readonly cwd?: string | undefined
  /** Abort discovery or loading work for the current caller. */
  readonly signal?: AbortSignal | undefined
}

/**
 * Registry read options: provider lookup context plus the viewing scope.
 * The registry consumes `scope` to select layers; providers receive the same
 * borrowed options object and read only their {@link SkillLookupOptions}
 * contract from it.
 */
export interface SkillViewOptions extends SkillLookupOptions {
  /** Viewing scope (the calling agent); omitted reads the global layer alone. */
  readonly scope?: ScopeKey | undefined
}

/**
 * Return whether a skill may be advertised to and loaded by a model.
 * @param skill - skill metadata carrying resolved invocation controls.
 * @returns whether the policy permits model invocation.
 */
export function isModelInvocable(skill: Pick<SkillSummary, 'invocation'>): boolean {
  return skill.invocation.modelInvocable
}

/**
 * Return whether a skill may be advertised to and loaded by a human-facing command.
 * @param skill - skill metadata carrying resolved invocation controls.
 * @returns whether the policy permits user invocation.
 */
export function isUserInvocable(skill: Pick<SkillSummary, 'invocation'>): boolean {
  return skill.invocation.userInvocable
}

/**
 * Durable source for the context message a user-explicit skill invocation
 * injects: the user's own words ride a plain user message, and the rendered
 * skill body follows as injected `instructions`-form context carrying this
 * source, so transcript consumers present the injection from metadata
 * instead of re-parsing the model-facing text.
 */
export interface SkillInvocationSource {
  readonly kind: 'skill-invocation'
  /** Invoked skill name, validated user-invocable at the injecting boundary. */
  readonly name: string
  /** Injected skill bodies are instructions for the model to follow. */
  readonly form: 'instructions'
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** A user-explicit skill invocation injected by the host. */
    'skill-invocation': SkillInvocationSource
  }
}

/**
 * Render one loaded skill for the model. The output is shared verbatim by the
 * `skill` tool result and the user-explicit invocation injection, so the model
 * sees one canonical `<skill_content>` shape on both paths. The name rides an
 * escaped attribute; the body is embedded verbatim (skills are trusted local
 * content, and user-supplied invocation text stays outside this wrapper).
 * @param skill - name, provider, optional resource base, and body to render.
 * @returns the complete model-facing `<skill_content>` block.
 */
export function renderSkillContent(skill: Pick<SkillDefinition, 'name' | 'provider' | 'resourceBase' | 'content'>): string {
  const resourceHint = renderResourceHint(skill)
  return [
    `<skill_content name="${escapeAttr(skill.name)}">`,
    '<skill_resources>',
    ...resourceHint,
    '</skill_resources>',
    '',
    '<skill_instructions>',
    skill.content,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}

function renderResourceHint(skill: Pick<SkillDefinition, 'provider' | 'resourceBase'>): string[] {
  const base = skill.resourceBase
  if (base === undefined) {
    return [
      `Resources for this skill are managed by provider "${escapeText(skill.provider)}".`,
      'Load referenced resources only as needed.',
    ]
  }
  switch (base.kind) {
    case 'directory':
      return [
        `Base directory for this skill: ${escapeText(base.path)}`,
        'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
      ]
    case 'url':
      return [
        `Base URL for this skill: ${escapeText(base.url)}`,
        'Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.',
      ]
    case 'opaque':
      return [
        `Resources for this skill: ${escapeText(base.description)}`,
        'Load referenced resources only as needed.',
      ]
    /* v8 ignore start -- SkillResourceBase is a closed union; a future kind must fail compilation here. */
    default:
      return assertNever(base, 'SkillResourceBase.kind')
    /* v8 ignore stop */
  }
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

/**
 * Escape model-facing prose embedded inside skill markup so provider-supplied
 * text cannot open or close framing tags.
 * @param value - raw prose to embed.
 * @returns the escaped text.
 */
export function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/** One catalog observation plus whether discovery completed within a stable catalog revision. */
export interface SkillCatalogSnapshot {
  /** Sorted invocation-neutral summaries collected in this observation. */
  readonly skills: SkillSummary[]
  /** Whether every registered provider completed without a concurrent catalog revision. */
  readonly complete: boolean
}

/** Provider candidates plus whether the current discovery is authoritative. */
export interface SkillProviderObservation {
  /** Candidates available from the current provider discovery. */
  readonly candidates: readonly SkillCandidate[]
  /** Whether discovery completed and these candidates may be cached. */
  readonly complete: boolean
}

/** Provider interface for one source of skills, such as local directories or a remote registry. */
export interface SkillProvider {
  /** Unique provider name in the `ctx.skills` registry. */
  readonly name: string
  /**
   * List available skill candidates for the current lookup context. Provider
   * plugins register synchronously during `apply()`; remote initialization,
   * authentication, and discovery are awaited inside this method. Implementations
   * should settle promptly when `options.signal` aborts.
   * @param options - lookup options; `cwd` selects workspace-sensitive skills and `signal` cancels work.
   * @returns provider candidates as a complete-array shorthand, or an explicit
   *   observation when usable candidates came from incomplete discovery.
   */
  readonly list: (options: SkillLookupOptions) => Promise<readonly SkillCandidate[] | SkillProviderObservation>
  /**
   * Load a complete skill body for a previously listed candidate.
   * @param candidate - the winning candidate originally returned by this provider.
   * @param options - lookup options; `cwd` selects workspace-sensitive skills and `signal` cancels work.
   * @returns the full skill body, or `undefined` if it is no longer loadable.
   */
  readonly get: (candidate: SkillCandidate, options: SkillLookupOptions) => Promise<SkillDefinition | undefined>
}

/** Registration-scoped lifecycle and invalidation capability borrowed by one provider. */
export interface SkillProviderControl {
  /** Aborts if registration fails or when the exact provider registration is disposed. */
  readonly signal: AbortSignal
  /** Invalidate completed catalogs and notify consumers only while the exact registration remains active. */
  readonly invalidate: () => void
}

/** Skill registry configuration. */
export interface Config {
  /** Maximum number of completed cwd/provider catalogs kept in memory. */
  readonly collectCacheMaxEntries?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    skills: SkillRegistry
  }

  interface Events {
    /**
     * A skill provider, runtime contribution, or provider-backed catalog may
     * have changed. This is an unfiltered invalidation notification; consumers
     * refetch the catalog for their own lookup options. Listener failures are
     * contained and cannot veto the registry mutation.
     * @mode emit
     */
    'skills/change'(): void
  }
}

interface IndexedCandidate {
  candidate: SkillCandidate
  provider: SkillProvider
  providerOrder: number
  localOrder: number
  /** Owning layer, so a stale-definition invalidation can verify the exact registration is still live. */
  layer: SkillLayer
}

/** One provider registration retained by its layer. */
interface RegisteredProvider {
  provider: SkillProvider
  /** Service-wide monotonic registration order, the within-layer rank tiebreak. */
  order: number
}

interface LayerCollectResult {
  entries: IndexedCandidate[]
  cacheable: boolean
}

interface CollectResult {
  entries: Map<string, IndexedCandidate>
  cacheable: boolean
}

/** One scope's complete skill-registry contribution. */
class SkillLayer implements ScopeLayer {
  /** Providers registered through contexts carrying this scope, insertion-ordered. */
  readonly providers: NamedEntries<RegisteredProvider>
  /** Runtime skills registered through contexts carrying this scope. */
  readonly runtime = new Map<string, SkillDefinition>()

  constructor(scope: ScopeKey | undefined) {
    this.providers = new NamedEntries(name => new Error(scope === undefined
      ? `a skill provider named "${name}" is already registered`
      : `a skill provider named "${name}" is already registered in this scope`))
  }

  /** Whether every contribution table in this aggregate layer is empty. */
  isEmpty(): boolean {
    return this.providers.isEmpty() && this.runtime.size === 0
  }
}

/**
 * Layered registry of skill providers, the host+per-scope shape the tools
 * registry established. A registration files into the layer of its calling
 * context's scope ({@link scopeOf}): host rows and repository plugins land in
 * the global layer, while a plugin mounted by an agent preset's standing
 * composition lands in that preset's layer. A read merges the global layer
 * with the viewing scope's chain — the nearest layer's entry wins a duplicate
 * name outright, and the rank order decides duplicates only within one layer.
 * It exposes sorted invocation-neutral summaries and loads full skill bodies
 * on demand.
 */
export class SkillRegistry extends Service {
  static Config: Schema<Config> = z.object({
    collectCacheMaxEntries: z.number().default(DEFAULT_COLLECT_CACHE_ENTRIES),
  })

  private readonly collectCacheMaxEntries: number
  private readonly layers = new ScopedLayers<SkillLayer>(
    scope => new SkillLayer(scope),
    () => { this.invalidateCache() },
  )
  private readonly collectCache = new Map<string, Map<string, IndexedCandidate>>()
  private revision = 0
  private nextProviderOrder = 0
  /** Stable identities for cache keys; scope keys are opaque identity-compared objects. */
  private readonly scopeIds = new WeakMap<ScopeKey, number>()
  private nextScopeId = 1

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'skills')
    this.collectCacheMaxEntries = config.collectCacheMaxEntries ?? DEFAULT_COLLECT_CACHE_ENTRIES
    assertPositiveInteger('collectCacheMaxEntries', this.collectCacheMaxEntries)
  }

  /**
   * Register a borrowed same-process provider synchronously during plugin
   * apply, into the calling context's layer: a scoped context (an agent
   * preset's standing mount) registers for that scope alone, an unscoped
   * context registers globally. Duplicate names within one layer and reserved
   * names throw; remote initialization belongs in `list()`. Fiber disposal
   * unregisters the provider and invalidates catalog caches.
   * @param create - synchronous factory receiving this registration's lifecycle and invalidation control.
   * @returns the exact Cordis effect disposer that unregisters this provider;
   *   composite effects may yield it directly to preserve teardown ordering.
   */
  registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void {
    const lifecycle = new AbortController()
    let registration: { layer: SkillLayer; name: string } | undefined
    let provider: SkillProvider
    const control: SkillProviderControl = {
      signal: lifecycle.signal,
      invalidate: () => {
        const active = registration
        if (active !== undefined && active.layer.providers.get(active.name)?.provider === provider) {
          this.invalidateCache()
        }
      },
    }
    try {
      provider = create(control)
      const name = provider.name
      if (name === RUNTIME_PROVIDER) {
        throw new Error(`"${RUNTIME_PROVIDER}" is reserved for runtime skill registrations`)
      }
      const order = this.nextProviderOrder
      this.nextProviderOrder += 1
      return this.layers.effect(
        this.ctx,
        (layer) => {
          const undo = layer.providers.insert(name, { provider, order })
          registration = { layer, name }
          return () => {
            registration = undefined
            undo()
            lifecycle.abort(new Error(`skill provider "${name}" disposed`))
          }
        },
        { label: 'skills.registerProvider()' },
      )
    } catch (error) {
      lifecycle.abort(error)
      throw error
    }
  }

  /**
   * Register a borrowed readonly runtime skill into the calling context's
   * layer. Project entries outrank runtime entries, which outrank user
   * entries, within one layer. Same-name runtime entries in one layer are
   * first-wins; a duplicate logs a warning and receives a no-op disposer so
   * it cannot remove the winner.
   * @param skill - the skill definition input; omitted invocation and provider fields receive defaults.
   * @returns the exact Cordis effect disposer, preserving composite teardown order and invalidating caches.
   */
  register(skill: SkillRegistration): () => void {
    validateRuntimeSkill(skill)
    const scope = scopeOf(this.ctx)
    const existingLayer = scope === undefined ? this.layers.global : this.layers.peek(scope)
    if (existingLayer !== undefined && existingLayer.runtime.has(skill.name)) {
      this.ctx.logger.warn(`runtime skill "${skill.name}" ignored because it is already registered`)
      return () => {}
    }
    const definition: SkillDefinition = {
      ...skill,
      invocation: skill.invocation ?? { modelInvocable: true, userInvocable: true },
      provider: skill.provider ?? RUNTIME_PROVIDER,
    }
    return this.layers.effect(
      this.ctx,
      (layer) => {
        layer.runtime.set(definition.name, definition)
        return () => { layer.runtime.delete(definition.name) }
      },
      { label: 'skills.register()' },
    )
  }

  /**
   * List invocation-neutral skill summaries for a workspace. Consumers apply
   * model or user invocation policy at their operational boundary. Lookup
   * options and provider candidates are readonly same-process values borrowed
   * throughout discovery.
   * @param options - view options; `scope` selects the viewing agent's layers, `cwd` selects project roots, and `signal` cancels discovery.
   * @returns all sorted winning summaries.
   */
  async list(options: SkillViewOptions = {}): Promise<SkillSummary[]> {
    return (await this.snapshot(options)).skills
  }

  /**
   * Observe the current invocation-neutral catalog and whether discovery completed within a stable revision.
   * Incomplete observations are never cached, allowing consumers to retain last-good state and
   * retry on their next request boundary.
   * @param options - view options; `scope` selects the viewing agent's layers, `cwd` selects project roots, and `signal` cancels discovery.
   * @returns sorted summaries plus discovery-completeness state.
   */
  async snapshot(options: SkillViewOptions = {}): Promise<SkillCatalogSnapshot> {
    const collected = await this.collect(options)
    return {
      skills: [...collected.entries.values()]
        .map(entry => toSummary(entry.candidate))
        .sort(compareSkillSummary),
      complete: collected.cacheable,
    }
  }

  /**
   * Load and validate the winning candidate, passing its opaque discovery locator back to the
   * provider. Cancellation is rechecked after selection, including cache hits, and raced against
   * loading so an uncooperative provider cannot hang the caller.
   * @param name - kebab-case skill name.
   * @param options - view options; `scope` selects the viewing agent's layers,
   *   `cwd` selects workspace-sensitive skills, and `signal` cancels work.
   * @returns the full skill, including body content, or `undefined`.
   */
  async get(name: string, options: SkillViewOptions = {}): Promise<SkillDefinition | undefined> {
    if (!isSkillName(name)) return undefined
    const collected = await this.collect(options)
    throwIfAborted(options.signal)
    const match = collected.entries.get(name)
    if (match === undefined) return undefined
    const definition = await waitWithAbort(
      match.provider.get(match.candidate, options),
      options.signal,
    )
    if (definition === undefined) return undefined
    validateDefinition(definition)
    if (definition.name !== match.candidate.name) {
      this.invalidateEntry(match)
      return undefined
    }
    return definition
  }

  private async collect(options: SkillViewOptions): Promise<CollectResult> {
    throwIfAborted(options.signal)
    let attempt = 1
    while (true) {
      const revision = this.revision
      // The chain is part of the key rather than assumed stable: a blank-session
      // recompose re-parents an existing scope without touching this registry,
      // and only a chain-bearing key makes the next read see the new preset.
      const key = this.collectCacheKey(options.cwd, scopeChainOf(options.scope), revision)
      const cached = this.collectCache.get(key)
      if (cached !== undefined) return { entries: cached, cacheable: true }

      const result = await this.collectFresh(options)
      throwIfAborted(options.signal)
      if (revision !== this.revision) {
        if (attempt < MAX_COLLECT_ATTEMPTS) {
          attempt += 1
          continue
        }
        return { entries: result.entries, cacheable: false }
      }
      if (result.cacheable) {
        this.collectCache.set(key, result.entries)
        if (this.collectCache.size > this.collectCacheMaxEntries) {
          const oldest = this.collectCache.keys().next() as IteratorYieldResult<string>
          this.collectCache.delete(oldest.value)
        }
      }
      return result
    }
  }

  private async collectFresh(options: SkillViewOptions): Promise<CollectResult> {
    // Global first, then existing chain overlays farthest ancestor first and
    // the exact scope last, so the nearest layer's same-name entry replaces
    // the farther ones — the tools registry's shadowing rule. Rank decides
    // duplicates only within one layer.
    const layers = [this.layers.global, ...this.layers.chainLayers(options.scope)]
    const merged = new Map<string, IndexedCandidate>()
    let cacheable = true
    for (const layer of layers) {
      const collected = await this.collectLayer(layer, options)
      if (!collected.cacheable) cacheable = false
      for (const entry of collected.entries) merged.set(entry.candidate.name, entry)
    }
    return { entries: merged, cacheable }
  }

  private async collectLayer(layer: SkillLayer, options: SkillLookupOptions): Promise<LayerCollectResult> {
    const collected = await this.listLayerCandidates(layer, options)
    collected.entries.sort(compareIndexedCandidates)
    const seen = new Set<string>()
    const result: IndexedCandidate[] = []
    for (const entry of collected.entries) {
      const skill = entry.candidate
      if (seen.has(skill.name)) {
        this.ctx.logger.warn(`skill "${skill.name}" from ${skill.source} ignored because a higher-priority skill already exists`)
        continue
      }
      seen.add(skill.name)
      result.push(entry)
    }
    return { entries: result, cacheable: collected.cacheable }
  }

  private async listLayerCandidates(layer: SkillLayer, options: SkillLookupOptions): Promise<LayerCollectResult> {
    throwIfAborted(options.signal)
    const candidates: IndexedCandidate[] = []
    let cacheable = true
    let runtimeOrder = 0
    for (const skill of [...layer.runtime.values()].sort((a, b) => compareCodePoints(a.name, b.name))) {
      candidates.push({
        candidate: runtimeCandidate(skill),
        provider: RUNTIME_SKILL_PROVIDER,
        providerOrder: -1,
        localOrder: runtimeOrder,
        layer,
      })
      runtimeOrder += 1
    }
    for (const { provider, order } of [...layer.providers.values()]) {
      let localOrder = 0
      let output: unknown
      try {
        output = await waitWithAbort(provider.list(options), options.signal)
      } catch (error) {
        if (options.signal?.aborted === true) throw toError(options.signal.reason)
        cacheable = false
        this.ctx.logger.warn(`skill provider "${provider.name}" skipped: ${errorMessage(error)}`)
      }
      if (output === undefined) continue
      const observation = normalizeProviderObservation(output, provider.name)
      if (!observation.complete) cacheable = false
      for (const candidate of observation.candidates) {
        validateCandidate(candidate, provider.name)
        candidates.push({ candidate, provider, providerOrder: order, localOrder, layer })
        localOrder += 1
      }
    }
    return { entries: candidates, cacheable }
  }

  private invalidateCache(): void {
    this.revision += 1
    this.collectCache.clear()
    this.notifyChange()
  }

  /** Invalidate after a stale definition load, only while the exact registration that produced the entry is still live. */
  private invalidateEntry(entry: IndexedCandidate): void {
    /* v8 ignore else -- A definition load can outlive the exact provider registration it selected. */
    if (entry.layer.providers.get(entry.provider.name)?.provider === entry.provider) this.invalidateCache()
  }

  private scopeId(key: ScopeKey): number {
    let id = this.scopeIds.get(key)
    if (id === undefined) {
      id = this.nextScopeId
      this.nextScopeId += 1
      this.scopeIds.set(key, id)
    }
    return id
  }

  private collectCacheKey(cwd: string | undefined, chain: ScopeKey[], revision: number): string {
    return JSON.stringify({ cwd, scopes: chain.map(key => this.scopeId(key)), revision })
  }

  /** Notify catalog observers without making their refresh work load-bearing. */
  private notifyChange(): void {
    for (const callback of this.ctx.events.dispatch('emit', ['skills/change'])) {
      try {
        const returned: unknown = callback()
        void Promise.resolve(returned).catch((error: unknown) => {
          this.ctx.logger.warn(`skills/change listener rejected: ${errorMessage(error)}`)
        })
      } catch (error: unknown) {
        this.ctx.logger.warn(`skills/change listener threw: ${errorMessage(error)}`)
      }
    }
  }
}

function normalizeProviderObservation(output: unknown, providerName: string): SkillProviderObservation {
  if (Array.isArray(output)) {
    return { candidates: output as readonly SkillCandidate[], complete: true }
  }
  if (output === null || typeof output !== 'object') {
    throw invalidProviderObservation(providerName)
  }
  const observation = output as Partial<SkillProviderObservation>
  if (!Array.isArray(observation.candidates) || typeof observation.complete !== 'boolean') {
    throw invalidProviderObservation(providerName)
  }
  return observation as SkillProviderObservation
}

function invalidProviderObservation(providerName: string): TypeError {
  return new TypeError(`skill provider "${providerName}" list() must return an array or { candidates, complete } observation`)
}

const RUNTIME_SKILL_PROVIDER: SkillProvider = {
  name: RUNTIME_PROVIDER,
  /* v8 ignore next -- Runtime skills are injected directly by the registry; this provider only owns `get()`. */
  list() {
    return Promise.resolve([])
  },
  get(candidate) {
    return Promise.resolve(candidate.locator as SkillDefinition)
  },
}

function runtimeCandidate(skill: SkillDefinition): SkillCandidate {
  return {
    name: skill.name,
    description: skill.description,
    ...skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {},
    invocation: skill.invocation,
    source: skill.source,
    provider: skill.provider,
    ...skill.resourceBase !== undefined ? { resourceBase: skill.resourceBase } : {},
    rank: RUNTIME_RANK,
    locator: skill,
    ...skill.path !== undefined ? { path: skill.path } : {},
    ...skill.metadata !== undefined ? { metadata: skill.metadata } : {},
  }
}

function validateCandidate(candidate: SkillCandidate, providerName: string): void {
  if (typeof candidate.name !== 'string') {
    throw new TypeError(`skill provider "${providerName}" returned a non-string skill name`)
  }
  if (!SKILL_NAME.test(candidate.name)) {
    throw new Error(`skill provider "${providerName}" returned invalid skill name "${candidate.name}"`)
  }
  if (typeof candidate.description !== 'string') {
    throw new TypeError(`skill provider "${providerName}" returned skill "${candidate.name}" with a non-string description`)
  }
  if (candidate.description.length === 0) {
    throw new Error(`skill provider "${providerName}" returned skill "${candidate.name}" without a description`)
  }
  validateInvocation(candidate.invocation, `skill provider "${providerName}" returned skill "${candidate.name}"`)
  if (candidate.whenToUse !== undefined && typeof candidate.whenToUse !== 'string') {
    throw new TypeError(`skill provider "${providerName}" returned skill "${candidate.name}" with a non-string whenToUse`)
  }
  if (typeof candidate.source !== 'string') {
    throw new TypeError(`skill provider "${providerName}" returned skill "${candidate.name}" with a non-string source`)
  }
  if (typeof candidate.rank !== 'number' || !Number.isFinite(candidate.rank)) {
    throw new Error(`skill provider "${providerName}" returned skill "${candidate.name}" with an invalid rank`)
  }
  if (typeof candidate.provider !== 'string') {
    throw new TypeError(`skill provider "${providerName}" returned skill "${candidate.name}" with a non-string provider`)
  }
  if (candidate.provider !== providerName) {
    throw new Error(`skill provider "${providerName}" returned skill "${candidate.name}" for provider "${candidate.provider}"`)
  }
  if (candidate.path !== undefined && typeof candidate.path !== 'string') {
    throw new TypeError(`skill provider "${providerName}" returned skill "${candidate.name}" with a non-string path`)
  }
}

function validateRuntimeSkill(skill: SkillRegistration): void {
  if (!SKILL_NAME.test(skill.name)) throw new Error(`invalid skill name "${skill.name}"`)
  if (skill.description.length === 0) throw new Error(`skill "${skill.name}" requires a description`)
  validateInvocation(skill.invocation, `runtime skill "${skill.name}"`)
}

/** Validate a definition loaded from a provider-controlled parser or remote source. */
function validateDefinition(skill: SkillDefinition): void {
  const name = skill.name
  const description = skill.description
  const whenToUse = skill.whenToUse
  const invocation = skill.invocation
  const source = skill.source
  const provider = skill.provider
  const content = skill.content
  const path = skill.path
  if (typeof name !== 'string') throw new TypeError('loaded skill name must be a string')
  if (!SKILL_NAME.test(name)) throw new Error(`loaded skill has invalid name "${name}"`)
  if (typeof description !== 'string') throw new TypeError(`loaded skill "${name}" description must be a string`)
  if (description.length === 0) throw new Error(`loaded skill "${name}" requires a description`)
  validateInvocation(invocation, `loaded skill "${name}"`)
  if (whenToUse !== undefined && typeof whenToUse !== 'string') throw new TypeError(`loaded skill "${name}" whenToUse must be a string`)
  if (typeof source !== 'string') throw new TypeError(`loaded skill "${name}" source must be a string`)
  if (typeof provider !== 'string') throw new TypeError(`loaded skill "${name}" provider must be a string`)
  if (typeof content !== 'string') throw new TypeError(`loaded skill "${name}" content must be a string`)
  if (path !== undefined && typeof path !== 'string') throw new TypeError(`loaded skill "${name}" path must be a string`)
}

function toSummary(skill: SkillDefinition | SkillCandidate): SkillSummary {
  const { name, description, whenToUse, invocation, source, provider, resourceBase } = skill
  return {
    name,
    ...skill.path === undefined ? {} : { path: skill.path },
    description,
    ...whenToUse !== undefined ? { whenToUse } : {},
    invocation,
    source,
    provider,
    ...resourceBase !== undefined ? { resourceBase } : {},
  }
}

function validateInvocation(invocation: unknown, subject: string): void {
  if (invocation === undefined) return
  if (typeof invocation !== 'object' || invocation === null || Array.isArray(invocation)) {
    throw new TypeError(`${subject} with a non-object invocation policy`)
  }
  const policy = invocation as Record<string, unknown>
  if (typeof policy.modelInvocable !== 'boolean') {
    throw new TypeError(`${subject} with a non-boolean invocation.modelInvocable`)
  }
  if (typeof policy.userInvocable !== 'boolean') {
    throw new TypeError(`${subject} with a non-boolean invocation.userInvocable`)
  }
}

function compareSkillSummary(left: SkillSummary, right: SkillSummary): number {
  return compareCodePoints(left.name, right.name)
}

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function compareIndexedCandidates(left: IndexedCandidate, right: IndexedCandidate): number {
  return left.candidate.rank - right.candidate.rank
    || left.providerOrder - right.providerOrder
    || left.localOrder - right.localOrder
}

function assertPositiveInteger(name: string, value: number, minimum = 1): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`skill: ${name} must be an integer greater than or equal to ${minimum}`)
  }
}

function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  throwIfAborted(signal)
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      cleanup()
      reject(toError(signal.reason))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(toError(error))
      },
    )
  })
}

/** Throw a total Error for an already-aborted lookup. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw toError(signal.reason)
}

/** Normalize an arbitrary abort or provider failure without trusting coercion. */
function toError(error: unknown): Error {
  try {
    if (error instanceof Error) return error
  } catch {
    // A hostile proxy may throw during instanceof; fall through to the total renderer.
  }
  return new Error(errorMessage(error))
}

/** Render an arbitrary provider failure without letting coercion escape containment. */
function errorMessage(error: unknown): string {
  try {
    return String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

export default SkillRegistry
