# Skills

English | [中文](skills.zh.md)

The [skill capability family](../../packages/skill) includes the Service Definition ([dsh-skill](../../packages/skill/skill), `ctx.skills`), the local Service Provider ([dsh-skill-filesystem](../../packages/skill/skill-filesystem)), the optional packaged badge provider ([dsh-skill-badge](../../packages/skill/skill-badge)), and the Consumer ([dsh-tool-skill](../../packages/skill/tool-skill)). The registry merges provider catalogs across its host and per-scope layers; providers contribute local or packaged skills; the Consumer owns the initial and replacement catalogs plus the model-facing `skill` tool. Skills are optional instructions, not session events, so their vocabulary lives here rather than in [core.md](core.md).

Source: [`packages/skill/skill/src/index.ts`](../../packages/skill/skill/src/index.ts), [`packages/skill/skill-filesystem/src/index.ts`](../../packages/skill/skill-filesystem/src/index.ts), [`packages/skill/skill-badge/src/index.ts`](../../packages/skill/skill-badge/src/index.ts), and [`packages/skill/tool-skill/src/index.ts`](../../packages/skill/tool-skill/src/index.ts).

## Provider registry

`ctx.skills` combines local, embedded, remote, or other providers. Registration is synchronous; remote initialization and discovery belong in awaited `list()`. Provider objects, options, and candidates are borrowed readonly, while semantic fields are validated.

The registry is host+per-scope layered, the shape the [tools registry](tools.md) established over [dsh-scope](../../packages/core/scope): a registration files into the layer of its calling context's scope, so host rows and repository plugins land in the global layer while a plugin mounted by an agent preset's standing composition lands in that preset's layer, and provider names are unique per layer rather than process-wide. A read merges the global layer with the viewing scope's chain — the nearest layer's entry wins a duplicate skill name outright, and the rank order below decides duplicates only within one layer. Discovery caches are keyed by the resolved scope chain, so re-parenting a scope (a blank-session recompose) is visible to the next read without a registry mutation.

Within one layer, duplicate names resolve by rank, provider order, then local order; summaries sort by name. A rejected `list()` is logged and omitted from an incomplete observation, while an explicit incomplete observation contributes usable candidates without making the result cacheable; malformed candidates fail fast. Each provider factory receives a registration-scoped control whose `invalidate()` clears completed catalogs only while that exact registration remains active and whose signal aborts on failed registration or disposal. An in-flight discovery retries once when its provider generation changes; a second change returns the latest candidates incomplete and uncached. Provider and runtime mutations emit the unfiltered `skills/change` invalidation event; it carries no diff, so consumers refetch `snapshot()` with their own lookup options.

An array returned by `SkillProvider.list()` is complete-discovery shorthand. `SkillProviderObservation` lets a provider expose candidates that remain directly loadable while reporting that the observation is not authoritative.

```ts type-equiv
/** Provider candidates plus whether the current discovery is authoritative. */
interface SkillProviderObservation {
  /** Candidates available from the current provider discovery. */
  readonly candidates: readonly SkillCandidate[]
  /** Whether discovery completed and these candidates may be cached. */
  readonly complete: boolean
}
```

```ts type-equiv
/** Provider interface for one source of skills, such as local directories or a remote registry. */
interface SkillProvider {
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
```

```ts type-equiv
/** Registration-scoped lifecycle and invalidation capability borrowed by one provider. */
interface SkillProviderControl {
  /** Aborts if registration fails or when the exact provider registration is disposed. */
  readonly signal: AbortSignal
  /** Invalidate completed catalogs and notify consumers only while the exact registration remains active. */
  readonly invalidate: () => void
}
```

## Local discovery priority

The shipped local provider scans roots in rank order:

| Rank | Source | Root |
|---|---|---|
| 100 | `project-dsh` | `<projectRoot>/.dsh/skills` |
| 200 | `project-agents` | `<projectRoot>/.agents/skills` |
| 300 | `custom` | `Config.customSkillDirs` |
| 400 | `user-dsh` | `<dshHome>/skills` |
| 500 | `user-agents` | `<agentsHome>/skills` |
| 600 | `bundled` | `Config.bundledSkillDir` when configured |

The project root is the nearest ancestor containing `.git`; without one, the current cwd is used. When `ctx.fs` is available, the git-root walk probes `.git` through the filesystem service so remote or sandboxed workspaces do not fall back to the host filesystem boundary. The user DSH root skips its `.system` child. The local provider does not synthesize built-in system skills; deployments supply packaged skills through configured bundled roots or dedicated providers.

`dsh-skill-badge` registers one immutable `bundled` candidate at `BUNDLED_SKILL_RANK` and exposes its packaged asset directory through `resourceBase`. The shipped CLI declares the plugin disabled, so enabling its composition row is an explicit opt-in.

Chokidar watches existing roots for direct bundle/flat-entry additions and removals plus direct skill-entry changes. A missing root is followed one absent path segment at a time from its nearest existing ancestor until Chokidar can attach. Resource files below a bundle are not catalog changes. Model-facing `write` and `edit` observations synchronously invalidate the provider when their target is catalog-relevant, while the host watcher covers IDE, Git, shell, and external-process mutations. Watcher failures make the current observation incomplete without hiding readable candidates from direct loads; project-scoped watchers use a configured bounded LRU.

## Skill identity

Skill names are kebab-case (`^[a-z0-9]+(?:-[a-z0-9]+)*$`). The local provider accepts directory bundles (`<name>/SKILL.md`) and flat Markdown files (`<name>.md`). Nested recursive `**/SKILL.md` discovery is not supported.

```ts type-equiv
/** Origin bucket for a skill contribution. The value is prompt-visible metadata, not precedence by itself. */
type SkillSource = 'project-dsh' | 'project-agents' | 'runtime' | 'user-dsh' | 'user-agents' | 'custom' | 'bundled' | (string & {})
```

## Summaries, candidates, and complete definitions

`SkillSummary` is the registry's invocation-neutral summary shape. Consumers choose which entries and fields to render; the model session catalog uses only model-invocable `name` and `description`, never the body or absolute file path. `SkillInvocationPolicy` normalizes the two independent invocation controls into positive booleans, and every resolved summary, candidate, and definition carries it without turning arbitrary frontmatter into the domain model.

```ts type-equiv
/** Invocation controls shared by skill discovery consumers. */
interface SkillInvocationPolicy {
  /** Whether model-facing catalogs and loaders include this skill. */
  readonly modelInvocable: boolean
  /** Whether human-facing command catalogs and loaders include this skill. */
  readonly userInvocable: boolean
}
```

```ts type-equiv
/** Invocation-neutral skill metadata returned by `ctx.skills.list()`. */
interface SkillSummary {
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
```

`ctx.skills.list()` preserves all four policy combinations. `isModelInvocable(skill)` and `isUserInvocable(skill)` read the corresponding required field. A model-only skill sets `{ modelInvocable: true, userInvocable: false }`, a user-only skill sets `{ modelInvocable: false, userInvocable: true }`, and setting both fields to `false` keeps the skill available only through trusted `ctx.skills.get()` callers. The local provider reads the exact kebab-case frontmatter keys `disable-model-invocation` and `user-invocable`, defaults omitted fields to `true`, and projects every parsed skill into this normalized policy.

`SkillCatalogSnapshot` distinguishes authoritative absence from transient provider failure or a catalog that kept changing during discovery. `skills` contains the sorted invocation-neutral summaries collected in that observation; `complete` is true only when every registered provider completed without a concurrent catalog revision. Incomplete snapshots are not cached, allowing each consumer to retain its last-good filtered catalog and retry.

```ts type-equiv
/** One catalog observation plus whether discovery completed within a stable catalog revision. */
interface SkillCatalogSnapshot {
  /** Sorted invocation-neutral summaries collected in this observation. */
  readonly skills: SkillSummary[]
  /** Whether every registered provider completed without a concurrent catalog revision. */
  readonly complete: boolean
}
```

`SkillCandidate` is the provider-to-registry shape. `locator` is opaque provider state; the registry only stores it and gives it back to the winning provider's `get()`.

```ts type-equiv
/** Provider catalog entry used by the registry to merge and later load skills. */
interface SkillCandidate extends SkillSummary {
  /** Lower ranks win duplicate skill names before provider registration order is considered. */
  readonly rank: number
  /** Opaque provider-owned handle passed back to `provider.get()`. */
  readonly locator: unknown
  /** Parsed optional metadata object from provider-specific skill frontmatter. */
  readonly metadata?: Readonly<Record<string, unknown>>
}
```

`SkillDefinition` is the complete parsed result returned by `ctx.skills.get()` and used by the `skill` tool. `resourceBase` tells the tool how to render relative-resource guidance for local, URL, or provider-managed skills.

```ts type-equiv
/** Optional provider-specific base used by loaded skill bodies to resolve relative resources. */
type SkillResourceBase =
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'opaque'; readonly description: string }
```

```ts type-equiv
/** Complete parsed skill definition, including the body loaded by `ctx.skills.get()`. */
interface SkillDefinition extends SkillSummary {
  /** Markdown instruction body after any provider-specific metadata removal. */
  readonly content: string
  /** Parsed optional metadata object from frontmatter. */
  readonly metadata?: Readonly<Record<string, unknown>>
}
```

Runtime skill inputs may omit invocation controls and the provider label. The registry resolves both defaults once, then uses the same complete definition shape and first-wins collection order as providers. The returned disposer removes the contribution and invalidates discovery caches.

```ts type-equiv
/** Runtime skill contribution accepted by `ctx.skills.register()`. */
type SkillRegistration = Omit<SkillDefinition, 'invocation' | 'provider'> & {
  /** Invocation controls; omission permits both model and user surfaces. */
  readonly invocation?: SkillInvocationPolicy
  /** Provider label; omission uses the registry-owned runtime provider. */
  readonly provider?: string
}
```

## Lookup and configuration

Skill lookup is cwd-sensitive because providers may expose workspace-local skills, and its optional signal cancels provider work for the caller. Registry reads additionally take the viewing scope — consumers pass the calling agent, which is its own scope key — through `SkillViewOptions`; the registry consumes `scope` for layer selection, and providers read only their `SkillLookupOptions` contract from the same borrowed options object. Cancellation is checked before and after catalog selection, including cache hits, and races both discovery and full-definition loading. If no git root is found, the local provider treats the supplied cwd itself as the project root.

Full definitions are not cached by the registry. Each `get()` calls the winning provider with the selected candidate, so the local provider rereads the current body. A definition whose name no longer matches that candidate is rejected and invalidates the exact provider for rediscovery.

```ts type-equiv
/** Caller context used for cwd-sensitive and abortable provider work. */
interface SkillLookupOptions {
  /** Workspace selector for the current lookup. */
  readonly cwd?: string | undefined
  /** Abort discovery or loading work for the current caller. */
  readonly signal?: AbortSignal | undefined
}
```

```ts type-equiv
/**
 * Registry read options: provider lookup context plus the viewing scope.
 * The registry consumes `scope` to select layers; providers receive the same
 * borrowed options object and read only their {@link SkillLookupOptions}
 * contract from it.
 */
interface SkillViewOptions extends SkillLookupOptions {
  /** Viewing scope (the calling agent); omitted reads the global layer alone. */
  readonly scope?: ScopeKey | undefined
}
```

The registry owns only its discovery-cache bound. The local provider owns filesystem roots (`dshHome`, `agentsHome`, `customSkillDirs`, and optional `bundledSkillDir`/`DSH_BUNDLED_SKILL_DIR`) plus watcher enablement, polling, stability, symlink, and project-capacity controls. The consumer owns its catalog description bound. Exact defaults and validation are in the generated [config catalog](../config-catalog.md).

```ts type-equiv
/** Skill registry configuration. */
interface Config {
  /** Maximum number of completed cwd/provider catalogs kept in memory. */
  readonly collectCacheMaxEntries?: number
}
```

## Session catalog and tool contract

`dsh-tool-skill` injects the initial durable user-role `<system-reminder>` at the first `agent/pre-step` of a live session that observes a non-empty complete view. The catalog contains sorted skill `name` and normalized, XML-escaped `description` only; it omits bodies, paths, sources, providers, and routing hints. Discovery forwards the step's abort signal through `SkillLookupOptions`. `catalogDescriptionMaxLength` is the consumer config for the description bound, with default `500` and integer minimum `3`.

Before each later model step, the consumer applies exact tool visibility and digests the exact rendered entries between the `<available_skills>` tags from a complete snapshot. It derives the comparison baseline from the same entries in the newest recognizable visible catalog message sourced by the plugin. A changed digest appends a durable full replacement through `agent.inject()`; deleting every skill appends an explicit empty replacement. Incomplete snapshots preserve the last-good model view. If compaction hides every historical catalog message, the next complete snapshot re-establishes the current catalog; an empty view with no prior catalog emits nothing. These catalog messages are session history, not World State.

The model-facing `skill({ name })` tool validates the kebab-case name, finds the summary in the invocation-neutral catalog, rejects it before loading unless `isModelInvocable` permits access, then rereads the complete definition for the calling agent cwd and rechecks the policy before returning content. It reports an unresolved skill as unknown or no longer available and returns a tool result containing `<skill_content name="...">`, `<skill_resources>`, and `<skill_instructions>`. `resourceBase` resolves explicitly referenced scripts, references, and assets only as needed; the loaded result does not enumerate a skill directory. Body-only edits therefore change later tool calls without producing catalog messages or rewriting earlier tool results.

## Browser Session catalog

`SkillListRequest` addresses one Session by `sessionId`; `SkillListValue` returns the user-invocable entries with name, description, optional usage guidance, and model-invocation availability. `SessionSkillCatalog` reads the Session cwd and recorded preset without activating an Agent. A live Agent may supply its scoped registry, while a cold Session uses the preset's standing scope.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsessionskillcatalog--sessionskillcatalog"></a>

### `ctx.sessionSkillCatalog` — `SessionSkillCatalog`

Host service backing `ctx.remote.skills` without activating a cold Agent.

```ts cordis-catalog
/**
 * List the user-invocable skills visible to one Session composition.
 * @param request - Session identity whose cwd and preset select the catalog view.
 * @param signal - caller lifetime carried by the Remote transport; admitted catalog reads retain their existing completion semantics.
 * @returns user-invocable skill metadata without loading skill bodies.
 * @throws RemoteError when the Session cannot be inspected or no registry can serve it.
 */
@Remote async list(request: SkillListRequest, signal: AbortSignal): Promise<SkillListValue>
```

Source: [`packages/api/session-controller/src/skill-catalog.ts`](../../packages/api/session-controller/src/skill-catalog.ts)

<a id="ctxskills--skillregistry"></a>

### `ctx.skills` — `SkillRegistry`

Layered registry of skill providers, the host+per-scope shape the tools registry established. A registration files into the layer of its calling context's scope (scopeOf): host rows and repository plugins land in the global layer, while a plugin mounted by an agent preset's standing composition lands in that preset's layer. A read merges the global layer with the viewing scope's chain — the nearest layer's entry wins a duplicate name outright, and the rank order decides duplicates only within one layer. It exposes sorted invocation-neutral summaries and loads full skill bodies on demand.

```ts cordis-catalog
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
registerProvider(create: (control: SkillProviderControl) => SkillProvider): () => void

/**
 * Register a borrowed readonly runtime skill into the calling context's
 * layer. Project entries outrank runtime entries, which outrank user
 * entries, within one layer. Same-name runtime entries in one layer are
 * first-wins; a duplicate logs a warning and receives a no-op disposer so
 * it cannot remove the winner.
 * @param skill - the skill definition input; omitted invocation and provider fields receive defaults.
 * @returns the exact Cordis effect disposer, preserving composite teardown order and invalidating caches.
 */
register(skill: SkillRegistration): () => void

/**
 * List invocation-neutral skill summaries for a workspace. Consumers apply
 * model or user invocation policy at their operational boundary. Lookup
 * options and provider candidates are readonly same-process values borrowed
 * throughout discovery.
 * @param options - view options; `scope` selects the viewing agent's layers, `cwd` selects project roots, and `signal` cancels discovery.
 * @returns all sorted winning summaries.
 */
async list(options: SkillViewOptions = {}): Promise<SkillSummary[]>

/**
 * Observe the current invocation-neutral catalog and whether discovery completed within a stable revision.
 * Incomplete observations are never cached, allowing consumers to retain last-good state and
 * retry on their next request boundary.
 * @param options - view options; `scope` selects the viewing agent's layers, `cwd` selects project roots, and `signal` cancels discovery.
 * @returns sorted summaries plus discovery-completeness state.
 */
async snapshot(options: SkillViewOptions = {}): Promise<SkillCatalogSnapshot>

/**
 * Load and validate the winning candidate, passing its opaque discovery locator back to the
 * provider. Cancellation is rechecked after selection, including cache hits, and raced against
 * loading so an uncooperative provider cannot hang the caller.
 * @param name - kebab-case skill name.
 * @param options - view options; `scope` selects the viewing agent's layers,
 *   `cwd` selects workspace-sensitive skills, and `signal` cancels work.
 * @returns the full skill, including body content, or `undefined`.
 */
async get(name: string, options: SkillViewOptions = {}): Promise<SkillDefinition | undefined>
```

Source: [`packages/skill/skill/src/index.ts`](../../packages/skill/skill/src/index.ts)

<a id="skills-events"></a>

### `skills/*` events

<a id="skillschange--emit"></a>

#### `skills/change` — emit

A skill provider, runtime contribution, or provider-backed catalog may have changed. This is an unfiltered invalidation notification; consumers refetch the catalog for their own lookup options. Listener failures are contained and cannot veto the registry mutation.

```ts cordis-catalog
/**
 * A skill provider, runtime contribution, or provider-backed catalog may
 * have changed. This is an unfiltered invalidation notification; consumers
 * refetch the catalog for their own lookup options. Listener failures are
 * contained and cannot veto the registry mutation.
 * @mode emit
 */
'skills/change'(): void
```

Source: [`packages/skill/skill/src/index.ts`](../../packages/skill/skill/src/index.ts)
<!-- END GENERATED cordis-surface -->
