/**
 * Agent presets: each session composes its model-facing plugin set from one
 * preset `cordis.yml`, mounted ONCE per preset under a standing scope and
 * joined by every agent that names it.
 *
 * The standing mount is what makes a preset one composition rather than one
 * per session: its plugin instances, tool registrations, prompt sections, and
 * projection units exist exactly once, keyed per session inside the plugins
 * themselves (they predate presets and were written for a shared world). An
 * agent joins by having its scope key parented to the mount's
 * ({@link bindScopeParent}), which makes the mount's registrations visible to
 * that agent's views and the mount's listeners receive that agent's events —
 * and a host reader with no agent at all (a cold transcript read) resolves
 * the same standing registrations by preset id.
 *
 * This package owns the preset vocabulary, filesystem discovery, and the
 * guarded standing mount. It does not decide when an agent is created — the
 * agent factory's `setup(agentCtx)` hook is the one supported call site,
 * because only there is the join installed while the agent is still
 * unpublished, so a rejected composition rolls the whole creation back.
 * @module @deepseek-ai/dsh-agent-presets
 */

import { stat } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { bindScopeParent, createScope, scopeOf, type Scope, type ScopeKey, type ScopeParentBinding } from '@deepseek-ai/dsh-scope'
// Type-only: resolves the `agent/created` lifecycle event this service watches.
import type {} from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentPresetDocument, AgentPresetRoster } from './types.ts'
import type {} from '@deepseek-ai/dsh-session-projection'
// Type-only: resolves the registry notification emitted after scope reparenting.
import type {} from '@deepseek-ai/dsh-tools'
import type SettingsService from '@deepseek-ai/dsh-settings'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { discoverPresets, SHIPPED_PRESET_ROOT, USER_PRESET_DIR } from './discovery.ts'
import { copyComposition, deleteComposition, presetExists, readComposition } from './authoring.ts'
import { livePresetMounts, mountPreset, serviceForAgent, standingMountFor } from './mount.ts'
import {
  fileComposition, mountedCompositionRows,
  type AgentPresetComposition,
} from './composition-inventory.ts'
import type { AgentPreset, Config, PresetRoot } from './preset.ts'
import { agentPresetProjectionDefinition } from './session.ts'
export type * from './types.ts'
export type {
  AgentPresetComposition, AgentPresetCompositionRow, CompositionRowEnablement,
} from './composition-inventory.ts'

/** Settings namespace carrying the user's preset-picker preference and chosen default. */
export const SETTINGS_NAMESPACE = 'agent-presets'

/** Refuse an empty preset id before invoking a domain operation. */
function validatePresetId(value: string, field: 'agentPreset' | 'from'): void {
  if (value.length === 0) {
    throw new RemoteError('gateway/bad-request', `${field} must be a non-empty string`, {})
  }
}

/** Resolved preset-selection settings; the registration base supplies both fields. */
export interface AgentPresetSettings {
  /** Saved default used when mode selection is enabled. */
  default: string
  /** Whether visible mode selection and the saved user default govern unnamed new sessions. */
  modeSelectionEnabled: boolean
}

/** Runtime schema for the user-writable slice. */
export const AgentPresetSettingsSchema: z<AgentPresetSettings> = z.object({
  default: z.string(),
  modeSelectionEnabled: z.boolean(),
})

export { COMPOSITION_FILE, discoverPresets, scanRoot, SHIPPED_PRESET_ROOT } from './discovery.ts'
export {
  METADATA_FILE, readPresetMetadata, renderPresetMetadata, type PresetMetadata,
} from './metadata.ts'
export {
  inactiveRows, leakedServices, livePresetMounts, mountPreset, serviceForAgent, standingMountFor,
  type JoinedPresetMount, type PresetMount,
} from './mount.ts'
export { copyComposition, deleteComposition, readComposition, writableRoot } from './authoring.ts'
export { agentPresetProjectionDefinition } from './session.ts'
export type { AgentPreset, Config, PresetRoot, PresetTrust } from './preset.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentPresets: AgentPresets
  }
}

/**
 * Registry over the deployment's agent presets.
 *
 * Discovery is unmemoized: `list()` and `resolve()` re-read the roots on every
 * call so a preset authored while the process runs is visible immediately,
 * and a preset deleted underneath a picker disappears from the next read.
 */
export class AgentPresets extends TypertRemoteService {
  static inject = ['loader', 'sessionProjections']

  /** Runtime schema for the preset roster. */
  static Config = z.object({
    default: z.string().required(),
    roots: z.array(z.object({
      path: z.string().required(),
      trust: z.union(['system', 'user'] as const).default('user'),
    })).default([]),
    includeShippedRoot: z.boolean().default(true),
    includeUserRoot: z.boolean().default(true),
  }) as z<Config>

  /**
   * The roots discovery and authoring actually scan: the package's shipped
   * root unless `includeShippedRoot` is false, then every configured root in
   * order, then the harness-home user root unless `includeUserRoot` is false.
   *
   * Derived once, because a root set that changed between `list()` and the
   * `copy()` acting on its answer would author into a directory the caller
   * never saw. The shipped root comes FIRST and the user root LAST because an
   * earlier root wins a duplicate id: a shipped preset shadows any directory
   * that claimed its name, and a configured root still shadows a locally
   * authored one.
   */
  private readonly resolvedRoots: readonly PresetRoot[]

  /**
   * Where a row's package name resolves from: the base URL of the composition
   * this roster was loaded by, which is inside the installed harness.
   *
   * Discovery needs it because a preset's own directory is the wrong base for
   * a package name — a locally authored preset lives under the user's home,
   * where Node's upward `node_modules` walk never reaches the harness's
   * dependencies. The mount already resolves rows this way; holding the same
   * base here is what lets health answer the question before a session does.
   */
  private readonly harnessBase: string

  /**
   * The user layer over `config.default`, present only while a settings
   * provider is composed. Held rather than snapshotted so a hot-reloaded
   * document takes effect without a restart.
   */
  private settings: SettingsScope<AgentPresetSettings> | undefined

  /**
   * The settings service behind {@link settings}, held for the one write this
   * service makes: clearing a user default it has just deleted.
   */
  private settingsService: SettingsService | undefined

  /**
   * The service's own untraced context. Methods invoked through the traceable
   * proxy see `this.ctx` rebound to the CALLER's context, which carries a
   * shadow; a subtree minted from it resolves every service through that
   * shadow's fiber instead of each entry's own inject store, so preset rows
   * would fail on the very services they declare. Standing mounts must hang
   * off the untraced original (the `jobs-local` selfCtx precedent).
   */
  private readonly selfCtx: Context

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'agentPresets')
    this.selfCtx = ctx
    const { baseUrl } = ctx
    if (baseUrl === undefined) {
      // Self-contained misconfiguration, so it fails at load: without a base
      // the roster can neither resolve a row nor tell a healthy preset from
      // one naming a package that is gone, and the silent alternative is the
      // exact failure this check exists to report.
      throw new Error(
        'agent-presets: the roster needs `ctx.baseUrl` to resolve the plugins a composition names; '
        + 'compose it under a Loader, or set the base on the context this plugin is applied to',
      )
    }
    this.harnessBase = baseUrl
    this.resolvedRoots = [
      ...config.includeShippedRoot ? [{ path: SHIPPED_PRESET_ROOT, trust: 'system' } satisfies PresetRoot] : [],
      ...config.roots,
      ...config.includeUserRoot ? [{ path: dshHomePath(USER_PRESET_DIR), trust: 'user' } satisfies PresetRoot] : [],
    ]
    // Deliberately not `settings.installSection`: that method exists to re-judge
    // what a consumer DERIVED from the source — memoized resolutions,
    // registration-level facts — across attach, detach, and change. Nothing
    // here is derived. `defaultId` reads through on every call, so both of its
    // hooks would be no-ops and the source thunk would restate this field.
    ctx.inject(['settings'], (settingsCtx) => {
      this.settings = settingsCtx.settings.register(
        SETTINGS_NAMESPACE,
        AgentPresetSettingsSchema,
        { base: { default: config.default, modeSelectionEnabled: true } },
      )
      this.settingsService = settingsCtx.settings
      settingsCtx.effect(() => () => {
        this.settings = undefined
        this.settingsService = undefined
      }, 'agentPresets.settings()')
    })

    ctx.sessionProjections.register(agentPresetProjectionDefinition)

    // Advisory, not fatal: a synchronous `agent/created` listener that throws
    // VETOES publication, and this service must not, because composing an agent
    // outside the roster is legal — `recompose` binds exactly such a bare agent
    // below, and the ACP, SDK-server, and headless entry points all create one.
    // The invariant companion is the check that fails loud, at assembly. Why an
    // unjoined agent matters at all has one home: the [Agent
    // Note](../../../../.agents/notes/implemented/architecture/2026-08-10-host-plane-ownership-after-presets.md).
    //
    // Known false positive: a session created bare and bound later by
    // `recompose` is warned about once, before its first bind. Shipped Web
    // sessions mount in `setup`, and children join through `composeFrom`
    // before publication.
    ctx.on('agent/created', ({ agent }) => {
      if (this.resolvedRoots.length === 0) return
      if (this.composedPreset(agent.ctx) !== undefined) return
      ctx.logger.warn(
        `agent "${agent.id}" was published without joining an agent preset; `
        + 'its tools, prompt sections, and skill catalog resolve against the empty global layer '
        + '(join through AgentPresets.mount() or composeFrom() in the agent factory setup)',
      )
    })

    // The durable record is the commit point. Its public notification carries
    // only the stable identity needed by clients, never the live Session.
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'agent-preset/selected') return
      ctx.emit('agent-preset/selected', session.id, event.data.agentPreset)
    })
  }

  /**
   * The preset id mounted when a caller names none.
   *
   * Read per call rather than cached: the settings document is hot-reloaded, so
   * changing the default takes effect on the next session created and leaves
   * every running session on the preset it was composed from.
   */
  get defaultId(): string {
    // Hiding the picker is also the product's safe-default boundary: a stale
    // user choice from an older build must not silently compose a non-standard
    // new session while there is no control that reports that choice.
    return this.selectionPolicy().defaultId
  }

  /** Read one internally consistent snapshot of the selection policy. */
  private selectionPolicy(): { enabled: boolean; defaultId: string } {
    const settings = this.settings?.get()
    if (settings === undefined) return { enabled: true, defaultId: this.config.default }
    const enabled = settings.modeSelectionEnabled
    return {
      enabled,
      defaultId: enabled ? settings.default : this.config.default,
    }
  }

  /**
   * Every preset the configured roots currently supply.
   * @returns the presets, first-root-wins per id.
   */
  async list(): Promise<AgentPreset[]> {
    return await discoverPresets(this.resolvedRoots, this.harnessBase)
  }

  /**
   * The roster off the Host: {@link list} projected to path-free rows, with
   * the policy-effective default marked, this deployment's authoring
   * capability, and its mode-selection policy beside it.
   *
   * Whether a client can open a preset's directory is the Host's own opener
   * capability, not a roster property — a caller needing both joins them.
   * @returns the rows, authoring capability, and effective selection policy.
   */
  @Remote('list')
  async remoteExportList(): Promise<AgentPresetRoster> {
    // Keep the visible policy and marked default from the same settings
    // snapshot even when discovery yields while settings are hot-reloaded.
    const policy = this.selectionPolicy()
    const presets = await this.list()
    return {
      presets: presets.map(preset => ({
        id: preset.id,
        trust: preset.trust,
        isDefault: preset.id === policy.defaultId,
        ...preset.name === undefined ? {} : { name: preset.name },
        ...preset.description === undefined ? {} : { description: preset.description },
        ...preset.broken === undefined ? {} : { broken: preset.broken },
      })),
      authorable: this.authorable,
      modeSelectionEnabled: policy.enabled,
    }
  }

  /**
   * Every preset's composition as flattened plugin rows, for plugin-listing
   * surfaces beside the roster's own picker.
   *
   * A preset with a live standing mount answers from its newest generation's
   * Loader entries — the composition new sessions join — even when the file
   * behind it has since been edited into an unreadable state: the mount is
   * what sessions actually run, so the broken verdict only applies to a
   * preset nothing composed. One never composed since boot answers from its
   * file, with `!!js` disabled gates evaluated against the Loader context so
   * both answers reflect the same host. Reading never mounts: an unmounted
   * preset is parsed, not composed, so listing a preset's plugins cannot
   * activate them early. A composition that stopped reading between
   * discovery's health verdict and this read is reported broken with the
   * raced reason rather than dropped.
   * @returns one composition per roster preset, in roster order.
   */
  async compositionInventory(): Promise<AgentPresetComposition[]> {
    const defaultId = this.defaultId
    // The Loader's own expression scope: what a mount decision would consult.
    // An identifier this scope cannot resolve throws under `with`, and the
    // row stays `'conditional'`; only a gate whose identifiers resolve BOTH
    // here and under a mounted row's entry chain, with different values,
    // could report a wrong verdict — the shipped gates read `process` alone.
    const evaluateExpression = (expression: string): unknown => evaluate(this.ctx.loader.ctx, expression)
    // Mount records span every Cordis runtime in the process; only this
    // runtime's mounts describe this roster's presets.
    const rootFiber = this.ctx.root.fiber
    const found: AgentPresetComposition[] = []
    for (const preset of await this.list()) {
      const identity = {
        id: preset.id,
        trust: preset.trust,
        ...preset.name === undefined ? {} : { name: preset.name },
        isDefault: preset.id === defaultId,
      }
      // Before the broken verdict: a mounted preset whose file was since
      // deleted or corrupted still runs its standing composition. Newest
      // generation last: mount records keep insertion order, and a
      // superseded generation's record precedes its replacement's.
      const mount = livePresetMounts(rootFiber).findLast(candidate => candidate.presetId === preset.id)
      if (mount !== undefined) {
        found.push({ ...identity, rows: mountedCompositionRows(mount.tree) })
        continue
      }
      if (preset.broken !== undefined) {
        found.push({ ...identity, broken: preset.broken, rows: [] })
        continue
      }
      const read = await fileComposition(preset.path, evaluateExpression)
      found.push('broken' in read
        ? { ...identity, broken: read.broken, rows: [] }
        : { ...identity, rows: read.rows })
    }
    return found
  }

  /**
   * Resolve one preset by id.
   *
   * A broken preset resolves — deleting one, reading one, and reporting one
   * all need the row — and the mounting paths refuse it AFTER resolution
   * through {@link resolveMountable}.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @returns the resolved preset.
   * @throws when no configured root supplies that id.
   */
  async resolve(id?: string): Promise<AgentPreset> {
    const wanted = id ?? this.defaultId
    const presets = await this.list()
    const found = presets.find(preset => preset.id === wanted)
    if (found === undefined) {
      const available = presets.map(preset => preset.id)
      throw new RemoteError(
        'agent-preset/not-found',
        `agent-presets: preset "${wanted}" not found (available: ${available.join(', ') || 'none'})`,
        { agentPreset: wanted, available },
      )
    }
    return found
  }

  /**
   * Resolve one preset that is about to compose an agent, refusing a broken
   * one with its discovery-reported reason. Failing here rather than inside
   * the loader keeps the answer the same for every unloadable shape — ghost
   * directory, unparsable YAML, rowless list — and spends no mount attempt
   * on a composition discovery already read as unusable.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @returns the resolved, mountable preset.
   * @throws when the preset is unknown or discovery reports it broken.
   */
  private async resolveMountable(id?: string): Promise<AgentPreset> {
    const preset = await this.resolve(id)
    if (preset.broken !== undefined) {
      throw new RemoteError(
        'agent-preset/invalid',
        `agent-presets: preset "${preset.id}" failed to mount: ${preset.broken}`,
        { agentPreset: preset.id, reason: preset.broken },
      )
    }
    return preset
  }

  /**
   * Standing mounts by preset id, single-flight so two agents racing the
   * first use of one preset share one composition. A settled failure is
   * removed so a later session retries a preset whose file has been fixed; a
   * settled success serves until the composition FILE visibly changes — each
   * generation records its file stamp, and a stale stamp starts the next
   * generation for sessions created afterwards. Sessions already joined keep
   * the generation they run on; a superseded one is never disposed while the
   * process lives (reclaimed only by whole-tree teardown), so editing files
   * is bounded by how often compositions change, not by session count.
   */
  private readonly standing = new Map<string, Promise<StandingMount>>()

  /**
   * Parent bindings of the agents this roster composed, keyed by the agent's
   * scope key. The binding is dsh-scope's only re-link capability; holding it
   * here makes this service the sole authority that can move an agent between
   * standing compositions. WeakMap: entries die with their agents.
   */
  private readonly bindings = new WeakMap<ScopeKey, ScopeParentBinding>()

  /**
   * Compose one agent from a preset: ensure the preset's standing mount, then
   * parent the agent's scope key to it so the mount's registrations and
   * listeners cover this agent.
   *
   * Call from the agent factory's `setup(agentCtx)`; a rejection there rolls
   * the agent creation back, so a broken preset never yields a half-composed
   * session.
   * @param agentCtx - the agent's scope context.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @returns the preset that was composed, for the caller to record.
   * @throws when the preset is unknown or its composition is unusable.
   */
  async mount(agentCtx: Context, id?: string): Promise<AgentPreset> {
    const agentKey = scopeOf(agentCtx)
    if (agentKey === undefined) {
      throw new Error('agent-presets: refusing to compose an unscoped context; the scope key is what joins an agent to its preset')
    }
    const preset = await this.resolveMountable(id)
    const standing = await this.ensureStanding(preset)
    // The one bind of this agent's ancestry. The binding is the only re-link
    // authority, held privately so nothing outside this roster can move a
    // composed agent to another preset; a later recompose layer re-links
    // through it under the caller-owned blank-session contract.
    this.bindings.set(agentKey, bindScopeParent(agentKey, standing.key))
    return preset
  }

  /**
   * Join one agent to the SAME standing composition another already runs on.
   *
   * This is how a child agent inherits its parent's capabilities. It is a bind,
   * not a mount: the parent's generation is already composed, so the child gets
   * that exact instance — the same plugin objects, the same tool registrations,
   * the same prompt sections. Re-resolving the parent's preset by id instead
   * would re-read the roster, and a composition file edited since the parent
   * started would hand the child a DIFFERENT generation than the one its
   * parent's history was produced under (and a preset deleted since would fail
   * the child outright while its parent keeps running).
   *
   * Synchronous, and with no composition failure mode of its own — it reads no
   * roster, mounts nothing, and touches no file — which is what lets a child
   * creation window use it: the two in-process subagent drivers compose their
   * children inside a synchronous `setup`. It still rejects a caller error, as
   * the `@throws` below record.
   *
   * A parent that joined no preset — a rosterless deployment — yields no join
   * and no error: there, the model-facing rows sit in the host composition and
   * the child already sees them through the global layer.
   * @param agentCtx - the joining agent's scope context.
   * @param parentCtx - the scope context of the agent whose composition to join.
   * @returns the preset id joined, or undefined when the parent joined none.
   * @throws when `agentCtx` carries no scope, or has already joined a preset.
   */
  composeFrom(agentCtx: Context, parentCtx: Context): string | undefined {
    const agentKey = scopeOf(agentCtx)
    if (agentKey === undefined) {
      throw new Error('agent-presets: refusing to compose an unscoped context; the scope key is what joins an agent to its preset')
    }
    const standing = standingMountFor(parentCtx)
    if (standing === undefined) return undefined
    this.bindings.set(agentKey, bindScopeParent(agentKey, standing.key))
    return standing.presetId
  }

  /**
   * The preset one live agent runs on.
   *
   * Read from the live scope chain rather than from the session, so it answers
   * for an agent whose session has not recorded a preset yet — a child agent
   * whose durable header is being built from its parent's composition.
   * @param agentCtx - the agent's scope context.
   * @returns the preset id, or undefined when the agent joined none.
   */
  composedPreset(agentCtx: Context): string | undefined {
    return standingMountFor(agentCtx)?.presetId
  }

  /**
   * The roots this roster scans, which is not `config.roots`: the package's
   * shipped root unless `includeShippedRoot` is false, every configured root
   * in order, then the harness-home user root unless `includeUserRoot` is
   * false. Read this — not the config field — to answer whether a roster is
   * composed at all, so one derivation decides it.
   */
  get roots(): readonly PresetRoot[] {
    return this.resolvedRoots
  }

  /** Whether this deployment has a root locally authored presets go to. */
  get authorable(): boolean {
    return this.resolvedRoots.some(root => root.trust === 'user')
  }

  /**
   * Read one preset's composition text.
   * @param id - the preset id.
   * @returns the composition exactly as stored.
   * @throws when no configured root supplies that id.
   */
  async read(id: string): Promise<string> {
    return await readComposition(await this.resolve(id))
  }

  /**
   * One preset's composition text with the roster row it belongs to.
   * @param agentPreset - the preset id.
   * @returns the composition beside its trust and published metadata.
   * @throws {RemoteError} `gateway/bad-request` for an empty id, or
   * `agent-preset/not-found` when no configured root supplies it.
   */
  @Remote('read')
  async readDocument(agentPreset: string): Promise<AgentPresetDocument> {
    validatePresetId(agentPreset, 'agentPreset')
    const preset = await this.resolve(agentPreset)
    return {
      agentPreset: preset.id,
      trust: preset.trust,
      content: await this.read(preset.id),
      ...preset.name === undefined ? {} : { name: preset.name },
      ...preset.description === undefined ? {} : { description: preset.description },
    }
  }

  /**
   * Create a locally authored preset by copying an existing one whole.
   *
   * Copy is the only authoring write. Composition text never crosses this
   * seam: the source is named by id and its directory is copied as it stands,
   * so the copy is exactly as loadable as its source and authoring grants no
   * capability the roster did not already carry. The copy is NOT mounted to
   * validate — a source that mounts today yields a copy that mounts today.
   * @param from - the preset the copy starts from; shipped presets are the
   * primary source, so any trust is accepted.
   * @param id - the new preset's id, which becomes its directory name.
   * @param name - display name for the copy; absent falls back to the id.
   * @throws when the source is unknown, the id is unusable or already taken,
   * or the deployment configures no writable root.
   */
  async copy(from: string, id: string, name?: string): Promise<void> {
    const source = await this.resolve(from)
    // The roster check refuses ids any root supplies — shipped ones included,
    // since a user directory named like a shipped preset is shadowed by it.
    // The disk check inside copyComposition only sees the writable root.
    if ((await this.list()).some(preset => preset.id === id)) {
      throw presetExists(id)
    }
    await copyComposition(this.resolvedRoots, source, id, name)
    // A settled mount under this id can only be stale (its preset was deleted
    // from disk outside `remove`); the new preset must not inherit it. Every
    // session already joined keeps the generation it runs on regardless.
    this.standing.delete(id)
  }

  /**
   * Copy one preset through the Remote API.
   * @param from - the source preset id.
   * @param id - the new preset id.
   * @param name - the copy's optional display name.
   * @returns once the copy is stored.
   * @throws {RemoteError} with the corresponding stable preset code and
   * details when the copy is refused.
   */
  @Remote('copy')
  async remoteExportCopy(from: string, id: string, name?: string): Promise<void> {
    validatePresetId(from, 'from')
    validatePresetId(id, 'agentPreset')
    await this.copy(from, id, name)
  }

  /**
   * Delete a locally authored preset.
   *
   * @param id - the preset id.
   * @throws when the preset is unknown or ships with the deployment.
   */
  async remove(id: string): Promise<void> {
    await deleteComposition(this.resolvedRoots, await this.resolve(id))
    // Sessions on the deleted preset keep their standing mount; only new
    // sessions see the roster without it.
    this.standing.delete(id)
    // Storing a default that does not exist YET is deliberate — the roster is a
    // live directory, so a name absent now may exist by the time a session asks
    // for it, and `resolve` reports it then. A default this call just deleted is
    // not that case: nothing will ever supply it again, and left in place every
    // session created without an explicit pick would fail to start. Clearing it
    // exposes the deployment's own default underneath, which is the layering.
    if (this.settings?.get().default !== id) return
    await this.settingsService?.mutate(
      SETTINGS_NAMESPACE,
      [{ op: 'unset', path: ['default'] }],
    )
  }

  /**
   * Delete one preset through the Remote API.
   * @param id - the preset id.
   * @returns once the preset is deleted.
   * @throws {RemoteError} with the corresponding stable preset code and
   * details when deletion is refused.
   */
  @Remote('deletePreset')
  async remoteExportDelete(id: string): Promise<void> {
    validatePresetId(id, 'agentPreset')
    await this.remove(id)
  }

  /**
   * One agent's instance of a service its preset mounted.
   *
   * A preset publishes services behind `isolate` realms, which are invisible
   * outside the group that declares them — including to the host. This is how a
   * caller holding the agent reads one anyway: a request that is ABOUT a
   * session but arrives from outside it, which is every browser RPC.
   *
   * Read addressing only. A host row that `inject`s a service cannot use this,
   * because injection resolves before any session exists and has no agent to
   * key by; such a service belongs on the host plane instead.
   * @param agent - the agent whose composition to look inside.
   * @param name - the service name as the preset's rows resolve it.
   * @returns the agent's instance, or undefined when its preset mounts none.
   */
  serviceFor<K extends string & keyof Context>(agent: { ctx: Context }, name: K): Context[K] | undefined {
    return serviceForAgent(this.ctx, agent, name)
  }

  /**
   * Re-link one agent to a different preset's standing composition.
   *
   * Only valid while the agent has produced nothing: swapping tools mid
   * conversation would leave logged tool calls the new composition cannot
   * make. The CALLER owns that check — this method does not read session
   * history.
   *
   * The swap is a parent re-link, not an unmount: standing mounts are shared
   * and permanent, so the old composition stays for its other agents and the
   * new one is ensured BEFORE the link moves. An unknown or unusable preset
   * therefore throws with the agent exactly as it was — there is no torn-down
   * state to restore. The re-link runs through the binding this roster kept
   * from the agent's mount — dsh-scope's only re-link authority. An agent
   * that never composed one has nothing to re-link: the switch is then the
   * agent's first bind, exactly a mount. A committed re-link emits
   * `tools/change` because changing the parent scope changes the Agent's
   * resolved tool set without adding or removing registry entries.
   * @param agentCtx - the agent's scope context.
   * @param id - the preset to compose the agent from instead.
   * @returns the preset now installed.
   * @throws when the preset is unknown or its composition is unusable.
   */
  async recompose(agentCtx: Context, id: string): Promise<AgentPreset> {
    const agentKey = scopeOf(agentCtx)
    if (agentKey === undefined) {
      throw new Error('agent-presets: refusing to recompose an unscoped context')
    }
    const preset = await this.resolveMountable(id)
    const standing = await this.ensureStanding(preset)
    const binding = this.bindings.get(agentKey)
    if (binding === undefined) {
      this.bindings.set(agentKey, bindScopeParent(agentKey, standing.key))
    } else {
      binding.rebind(standing.key)
    }
    // Reparenting changes every scope-layered tool view without adding or
    // removing a registration. Publish the registry's normal invalidation so
    // Agent-owned overlays can reconcile with the new ancestry.
    try {
      this.ctx.emit('tools/change')
    } catch (error: unknown) {
      this.ctx.logger.warn(`agent-presets: tools/change listener failed after recomposing an Agent: ${String(error)}`)
    }
    return preset
  }

  /**
   * Serializes {@link select} per session. Two concurrent selects would both
   * pass the blank check, and the second re-link would then find the record
   * the first already replaced — leaving two compositions registered into one
   * agent layer. A client's `busy` flag is not enforcement: the wire is
   * reachable directly.
   *
   * Entries hold a failure-swallowing guard rather than the turn itself, so a
   * refused switch does not reject the next caller's chain.
   */
  private readonly switches = new Map<string, Promise<unknown>>()

  /**
   * Compose a blank session's agent from a different preset and record it.
   * @param agent - the session's live agent, resolved from the wire identity.
   * @param agentPreset - the preset to compose the agent from instead.
   * @returns the preset id that was recorded.
   * @throws {RemoteError} with `gateway/bad-request`, `agent-preset/locked`,
   * `agent-preset/not-found`, or `agent-preset/invalid` when refused.
   */
  @Remote('select')
  async select(agent: Agent, agentPreset: string): Promise<string> {
    validatePresetId(agentPreset, 'agentPreset')
    const queued = this.switches.get(agent.id) ?? Promise.resolve()
    const turn = queued.then(() => this.swap(agent, agentPreset))
    const guard = turn.catch(() => undefined)
    this.switches.set(agent.id, guard)
    try {
      return await turn
    } finally {
      if (this.switches.get(agent.id) === guard) this.switches.delete(agent.id)
    }
  }

  /** One queued switch: re-check, recompose, then record what the agent runs. */
  private async swap(agent: Agent, agentPreset: string): Promise<string> {
    // Re-read inside the queue: an earlier switch may have run, and a
    // conversation may have started, since this call was queued. A turn is one
    // model-loop execution; standalone plugin events never open one, so a
    // session that has only run commands is still blank.
    const boundary = this.selfCtx.sessionProjections.stateOf(agent.session, 'turnBoundary')
    if (boundary !== undefined
      && (boundary.openTurnStartSeq !== null || boundary.lastTurn > 0)) {
      throw new RemoteError(
        'agent-preset/locked',
        `session "${agent.id}" has already started; its agent preset is fixed`,
        { sessionId: agent.id, agentPreset },
      )
    }
    const preset = await this.recompose(agent.ctx, agentPreset)
    // Recorded only after the swap committed: the log states what the agent
    // runs, and a rejected mount leaves the previous composition.
    agent.session.append('agent-preset/selected', { agentPreset: preset.id })
    return preset.id
  }

  /**
   * The standing scope key of one preset, for a host reader with no agent.
   *
   * A cold transcript read resolves tool presenters against the composition
   * the session recorded, and the standing mount makes that possible without
   * resuming anything: ensuring the mount composes plugins but starts no
   * agent, no session, and no turn.
   * @param id - the preset id, or `undefined` for {@link defaultId}.
   * @returns the standing scope key readers pass as a registry view scope.
   * @throws when the preset is unknown or its composition is unusable.
   */
  async standingKeyFor(id?: string): Promise<ScopeKey> {
    const preset = await this.resolveMountable(id)
    return (await this.ensureStanding(preset)).key
  }

  /** Resolve (or create, single-flight) the standing mount of one preset. */
  private async ensureStanding(preset: AgentPreset): Promise<StandingMount> {
    const pending = this.standing.get(preset.id)
    if (pending !== undefined) {
      const mounted = await pending
      // Files are the only composition editor (authoring is copy/delete), so
      // the stamp is what notices an edit: a changed file starts the next
      // generation here, for this and later sessions. An unreadable stamp
      // serves the current generation — a mount must survive its file
      // disappearing, and failing the session over a stat would not.
      const current = await compositionStamp(preset.path)
      if (current === undefined || sameStamp(mounted.stamp, current)) return mounted
      // TODO: reclaim the superseded generation once the last agent joined to
      // it is gone. The subtree is not inert — `dsh-skill-filesystem` watches its
      // roots — and the settings-page authoring flow turns "a composition
      // changed" into a per-save event. This needs a joined-agent count on
      // StandingMount, incremented in `mount`/`composeFrom`/`recompose` and
      // decremented when the agent's scope key dies.
      // Guarded delete: a caller that raced this one may have already started
      // the next generation, and dropping THAT pointer would fork a third.
      if (this.standing.get(preset.id) === pending) this.standing.delete(preset.id)
      return this.ensureStanding(preset)
    }
    const created = (async (): Promise<StandingMount> => {
      const key: ScopeKey = { agentPreset: preset.id }
      const scope = createScope(this.selfCtx, key)
      try {
        // Stamped before the file is read: an edit racing the mount makes the
        // stamp stale rather than silently current, so the next session
        // refreshes instead of trusting a composition older than its stamp.
        const stamp = await compositionStamp(preset.path)
        if (stamp === undefined) {
          const reason = `composition file is unreadable: ${preset.path}`
          throw new RemoteError(
            'agent-preset/invalid',
            `agent-presets: preset "${preset.id}" failed to mount: ${reason}`,
            { agentPreset: preset.id, reason },
          )
        }
        await mountPreset(scope.ctx, preset)
        return { key, scope, stamp }
      } catch (error) {
        this.standing.delete(preset.id)
        await scope.dispose()
        throw error
      }
    })()
    this.standing.set(preset.id, created)
    return created
  }
}

/** The composition file identity one standing generation was mounted from. */
interface CompositionStamp {
  /** Modification time in milliseconds, as `stat` reports it. */
  readonly mtimeMs: number
  /** File size in bytes, the tiebreak for edits within one mtime tick. */
  readonly size: number
}

/** Read one composition file's stamp, or undefined when it cannot be statted. */
async function compositionStamp(path: string): Promise<CompositionStamp | undefined> {
  try {
    const { mtimeMs, size } = await stat(path)
    return { mtimeMs, size }
  } catch {
    // Deleted, replaced by an unreadable entry, or otherwise unstattable all
    // mean the same to the caller: the file offers no identity to compare.
    return undefined
  }
}

/** Whether two stamps name the same file state. */
function sameStamp(a: CompositionStamp, b: CompositionStamp): boolean {
  return a.mtimeMs === b.mtimeMs && a.size === b.size
}

/** One preset's standing composition. */
interface StandingMount {
  /** Scope key agents are parented to; also the mount's registration scope. */
  readonly key: ScopeKey
  /** Disposal boundary; held for whole-tree teardown, never per-session. */
  readonly scope: Scope
  /** Stamp of the composition file this generation was mounted from. */
  readonly stamp: CompositionStamp
}

export default AgentPresets
