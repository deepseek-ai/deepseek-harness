/** Scoped tool contributions routed to the selected root registry, which answers lookups and dispatch. @module */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AnonymousEntries, NamedEntries, ScopedLayers, scopeOf, scopeChainOf } from '@deepseek-ai/dsh-scope'
import type { ScopeKey, ScopeLayer } from '@deepseek-ai/dsh-scope'
import type { AssembleContext } from '@deepseek-ai/dsh-system-prompt'
import { ToolRegistryUnavailableError } from './registry.ts'
import type { ToolRegistry, ToolBatchInput, ToolBatchResult } from './registry.ts'
import './events.ts'
import { projectToolSchema } from './schema.ts'
import { RUN_CODE_NAME, ToolCompositionError, ToolNotFoundError } from './contracts.ts'
import type { ToolDefinition, ToolGuidance, ToolRestriction, ToolExecution, ToolGuard, ToolGuardDenial } from './contracts.ts'
import { assertToolDefinition, collectToolCandidates, findToolCandidate, listToolCandidates, mergeToolCandidate, resolveToolCandidate, resolveToolList } from './entries.ts'
import type { ToolCandidate, ToolSource } from './entries.ts'
import type { ToolStep } from './step.ts'
import { ToolExecutionPipeline } from './pipeline.ts'
import { executeToolBatch } from './batch.ts'

declare module '@deepseek-ai/dsh-system-prompt' {
  interface AssembleContext {
    /** Model step whose declared entries the assembly lists; absent when inspecting the root's current entries. */
    toolStep?: ToolStep
  }
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** Tool availability changes supplied by the tool registry. */
    'tool-registry': { kind: 'tool-registry' }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    tools: ToolsService
  }
}

/** One restriction compiled at registration for repeated lookup. */
interface CompiledToolRestriction {
  readonly allow?: ReadonlySet<string>
  readonly deny?: ReadonlySet<string>
}

/** Names one scope's contributions can offer before restrictions. */
interface ToolNames {
  /** Names of the scope's own and inherited contributions; tool order may name them. */
  readonly known: ReadonlySet<string>
  /** Names of inherited contributions; a restriction in this scope may name them. */
  readonly restrictable: ReadonlySet<string>
}

/** One scope's complete tool contribution. */
class ToolLayer implements ScopeLayer {
  readonly tools: NamedEntries<ToolDefinition>
  readonly includes = new AnonymousEntries<ToolSource>()
  readonly restrictions = new AnonymousEntries<CompiledToolRestriction>()

  constructor(scope: ScopeKey | undefined) {
    this.tools = new NamedEntries(name => new Error(scope === undefined
      ? `tool "${name}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)`
      : `tool "${name}" is already registered in this scope`))
  }

  /** Whether every contribution table in this layer is empty. */
  isEmpty(): boolean {
    return this.tools.isEmpty() && this.includes.isEmpty() && this.restrictions.isEmpty()
  }

  /** Whether every compiled restriction in this layer admits an inherited tool name. */
  admits(name: string): boolean {
    for (const filter of this.restrictions.values()) {
      if ((filter.allow !== undefined && !filter.allow.has(name))
        || (filter.deny !== undefined && filter.deny.has(name))) return false
    }
    return true
  }

  /** Registrations, then included entries, as the viewing scope resolves them. */
  candidates(scope: ScopeKey | undefined): Map<string, ToolCandidate> {
    return collectToolCandidates(this.tools.values(), this.includes.values(), scope)
  }

  /** The registration or included entry with one name, as the viewing scope resolves it. */
  candidate(name: string, scope: ScopeKey | undefined): ToolCandidate | undefined {
    return findToolCandidate(this.tools.get(name), this.includes.values(), name, scope)
  }

  /** Every name this layer can offer: registrations plus each inclusion's unscoped entries. */
  names(): string[] {
    return [...this.tools.keys(), ...[...this.includes.values()].flatMap(source => source.getAll().map(tool => tool.name))]
  }
}

/** A root selected in one scope; an unloaded root stays selected as unavailable. */
interface RootSelection {
  registry: ToolRegistry | undefined
}

class GuardLayer {
  readonly guards = new AnonymousEntries<ToolGuard>()
  isEmpty(): boolean { return this.guards.isEmpty() }
}

/**
 * `ctx.tools`: routes scoped tool contributions to the root registry each
 * scope selects, answers lookups and dispatch from that root, and applies
 * scoped restrictions and guards. A root receives the registrations its
 * scope sees when it is selected; a native root offers them as model
 * entries, and a PTC root binds them in programs.
 */
export class ToolsService extends Service implements ToolRegistry {
  static inject = ['systemPrompt']
  static Config = z.object({
    mode: z.never().description('Removed. Mount a native or PTC root tool registry instead.'),
    maxParallelSubCalls: z.never().description('Moved to the PTC tool registry configuration.'),
  })

  /** Emit `tools/change` from this service's own context, which outlives a caller that unloads. */
  private readonly notifyChange = (): void => { this.ctx.emit('tools/change') }
  private readonly layers = new ScopedLayers(scope => new ToolLayer(scope), this.notifyChange)
  /** Root selections by scope key; ended scopes release theirs, while an unloaded selection stays recorded. */
  private readonly roots = new WeakMap<object, RootSelection>()
  /** The `roots` key of the unscoped selection, which serves every scope without its own. */
  private readonly unscoped = {}
  private readonly guards = new ScopedLayers(() => new GuardLayer(), () => {})
  private viewing = false
  /** Whether `ctx.tools` is calling into a root, which must not read `ctx.tools`. */
  private callingRoot = false
  /** Roots that already include the registrations, which serve every scope that selects them. */
  private readonly includedRoots = new WeakSet<ToolRegistry>()
  /** Registered tools with guidance by section name; their registrations render the shared section. */
  private readonly guidanceTools = new Map<string, ToolDefinition[]>()
  /** The registrations each scope sees, which every selected root includes. */
  private readonly registrations: ToolSource = {
    get: (name, scope) => this.registered(name, scope),
    getAll: scope => listToolCandidates(this.visible(scope)),
  }

  constructor(ctx: Context) {
    super(ctx, 'tools')
    ctx.systemPrompt.tools(({ scope, toolStep }) => {
      const declared = toolStep !== undefined && toolStep.agent === scope
        ? toolStep.declarations
        : this.getAll(scope)
      return {
        schemas: declared.map(definition => projectToolSchema(definition, false)),
        knownNames: [...new Set([...declared.map(definition => definition.name), ...this.names(scope).known])],
      }
    })
  }

  /**
   * Register in the calling scope. The tool reaches the root the scope
   * selects and the roots its descendant scopes select: a native root offers
   * it as an entry, a PTC root binds it in programs. Nearer scopes shadow
   * farther ones; duplicates within one scope, a name an inclusion in the
   * scope already offers, and the reserved `run_code` name fail. A tool's
   * `guidance` registers its system prompt section in the same effect; the
   * section renders while the viewing scope's registrations resolve the tool.
   * @param tool - tool schema, execution, and optional finalization, presentation, or guidance.
   * @returns the exact disposer that unregisters the tool and its guidance.
   * @throws ToolCompositionError when the scope's inclusions already offer another definition with the name.
   */
  register(tool: ToolDefinition): () => void {
    assertToolDefinition(tool)
    this.read(() => {
      const offered = findToolCandidate(undefined, this.ownLayer()?.includes.values() ?? [], tool.name, undefined)
      // A different definition already offered here makes the name ambiguous, which resolving reports.
      if (offered !== undefined) resolveToolCandidate(tool.name, mergeToolCandidate(offered, tool))
    })
    const guidance = tool.guidance
    if (guidance === undefined) {
      return this.layers.effect(this.ctx, layer => layer.tools.insert(tool.name, tool), { label: 'tools.register()' })
    }
    const section = guidance.section ?? `tool:${tool.name}`
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; preserve the Cordis disposer identity
    return this.ctx.effect(function* (this: ToolsService) {
      yield this.layers.effect(this.ctx, layer => layer.tools.insert(tool.name, tool), { label: 'tools.register()' })
      const tools = this.guidanceTools.get(section) ?? []
      this.guidanceTools.set(section, tools)
      tools.push(tool)
      yield () => {
        tools.splice(tools.indexOf(tool), 1)
        if (tools.length === 0) this.guidanceTools.delete(section)
      }
      yield this.ctx.systemPrompt.section({
        name: section,
        order: this.ctx.systemPrompt.getSectionOrder(guidance.order),
        interpolate: false,
        ...guidance.retirement === undefined ? {} : { retirement: guidance.retirement },
        text: context => this.guidanceText(tools, guidance, context),
      })
    }.bind(this), 'tools.register()')
  }

  /**
   * Render a guidance section for the viewing scope.
   * @param tools - the tools that share the section.
   * @param guidance - guidance of the registration the system prompt renders.
   * @param context - the assembly context, whose scope views the tools.
   * @returns the section text, or empty text when the scope's registrations resolve none of the tools.
   * @throws ToolCompositionError when the deciding scope offers several definitions under one of the names.
   */
  private guidanceText(tools: readonly ToolDefinition[], guidance: ToolGuidance, context: AssembleContext): string {
    const available = new Set(tools.filter(tool => this.registered(tool.name, context.scope) === tool).map(tool => tool.name))
    if (available.size === 0) return ''
    return typeof guidance.text === 'string' ? guidance.text : guidance.text([...available].sort())
  }

  /**
   * Include another registry's entries in the calling scope; they reach roots
   * as registrations do. Each query reads the source for the viewing scope.
   * Descendant scopes inherit the entries, so their restrictions apply; the
   * including scope's own restrictions do not.
   * @param registry - source that keeps ownership of its definitions.
   * @returns the exact disposer that removes this inclusion.
   * @throws ToolCompositionError when the scope already offers another definition under one of the source's names,
   * when the source itself offers several definitions under one of them, or when the source includes this service.
   */
  include(registry: Pick<ToolRegistry, 'get' | 'getAll'>): () => void {
    this.read(() => {
      const layer = this.ownLayer()
      const sources = [...layer?.includes.values() ?? [], registry]
      for (const name of new Set(registry.getAll().map(definition => definition.name))) {
        resolveToolCandidate(name, findToolCandidate(layer?.tools.get(name), sources, name, undefined))
      }
    })
    return this.layers.effect(this.ctx, layer => layer.includes.append(registry), { label: 'tools.include()' })
  }

  /**
   * The calling scope's existing layer; the global layer for an unscoped context.
   * Conflicts are checked against every name a contribution can offer, before it
   * publishes, so a conflicting plugin fails at load. Later changes inside an
   * included registry fail the queries that reach them.
   */
  private ownLayer(): ToolLayer | undefined {
    const scope = scopeOf(this.ctx)
    return scope === undefined ? this.layers.global : this.layers.peek(scope)
  }

  /**
   * Run one read of contributions, rejecting a read that re-enters through an inclusion.
   * @param read - lookup over this service's layers and their inclusions.
   * @returns the lookup result.
   * @throws ToolCompositionError when an included registry reads this service again.
   */
  private read<T>(read: () => T): T {
    if (this.viewing) throw inclusionCycle()
    this.viewing = true
    try {
      return read()
    } finally {
      this.viewing = false
    }
  }

  /**
   * Restrict inherited tools for the calling scope. Restrictions intersect;
   * the scope's own registrations and inclusions stay visible. `allow` names
   * must be ones an inherited registration or inclusion can offer; an
   * inclusion contributes its unscoped entries, so a tool a provider adds to
   * Agents later can be allowed in advance. `deny` accepts any name, so a
   * scope can deny a tool before anything offers it.
   * @param filter - inherited-tool mask: `allow` (keep only) and/or `deny` (remove).
   * @returns the exact disposer that lifts this restriction.
   * @throws Error when the context is unscoped, the filter is empty, a name is `run_code`, or an `allow` name is not inherited.
   */
  restrict(filter: ToolRestriction): () => void {
    const scope = scopeOf(this.ctx)
    if (scope === undefined) {
      throw new Error('tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead')
    }
    const allow = filter.allow
    const deny = filter.deny
    if (allow === undefined && deny === undefined) {
      throw new Error('tools.restrict({}) is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)')
    }
    const compiled: CompiledToolRestriction = {
      ...allow !== undefined ? { allow: new Set(allow) } : {},
      ...deny !== undefined ? { deny: new Set(deny) } : {},
    }
    if ([...allow ?? [], ...deny ?? []].includes(RUN_CODE_NAME)) {
      throw new Error(`tools.restrict() cannot name reserved PTC program entry "${RUN_CODE_NAME}"; restrict the tools programs call instead`)
    }
    const known = this.names(scope).restrictable
    const unknown = (allow ?? []).filter(name => !known.has(name))
    if (unknown.length > 0) {
      throw new Error(`tools.restrict() names unknown inherited tool${unknown.length > 1 ? 's' : ''} ${unknown.map(n => `"${n}"`).join(', ')}; known inherited tools: ${[...known].sort().join(', ') || '(none)'}`)
    }
    return this.layers.effect(this.ctx, layer => layer.restrictions.append(compiled), { label: 'tools.restrict()' })
  }

  /**
   * Resolve the deciding candidates a scope sees. Restrictions across the scope
   * chain intersect over inherited tools; the viewing scope's own contributions
   * remain exempt. The nearest place offering a name decides it.
   * @param scope - the viewing scope, or undefined for the unscoped view.
   * @returns visible candidates by name.
   */
  private visible(scope: ScopeKey | undefined): Map<string, ToolCandidate> {
    return this.read(() => {
      const layers = this.layers.chainLayers(scope)
      const own = this.layers.peek(scope)
      const inherited = this.layers.global.candidates(scope)
      for (const layer of layers) {
        if (layer === own) continue
        for (const [name, candidate] of layer.candidates(scope)) inherited.set(name, candidate)
      }
      const visible = new Map<string, ToolCandidate>()
      for (const [name, candidate] of inherited) {
        if (layers.every(layer => layer.admits(name))) visible.set(name, candidate)
      }
      for (const [name, candidate] of own?.candidates(scope) ?? []) visible.set(name, candidate)
      return visible
    })
  }

  /**
   * Collect the names a scope's contributions can offer before restrictions,
   * including every entry its inclusions offer to any Agent.
   * @param scope - the viewing scope, or undefined for the unscoped view.
   * @returns known and restrictable names.
   */
  private names(scope: ScopeKey | undefined): ToolNames {
    return this.read(() => {
      const layers = this.layers.chainLayers(scope)
      const own = this.layers.peek(scope)
      const inheritedLayers = [this.layers.global, ...layers.filter(layer => layer !== own)]
      const restrictable = new Set(inheritedLayers.flatMap(layer => layer.names()))
      return { restrictable, known: new Set([...restrictable, ...own?.names() ?? []]) }
    })
  }

  /**
   * Resolve one registration as a scope sees it: nearer contributions shadow
   * farther ones, and a restricted inherited tool reads as absent.
   * @param name - the tool name as registered or included.
   * @param scope - the viewing scope (the agent); omitted selects the unscoped view.
   * @returns the registration the scope resolves, or undefined when none is visible.
   * @throws ToolCompositionError when the deciding scope offers several definitions.
   */
  private registered(name: string, scope: ScopeKey | undefined): ToolDefinition | undefined {
    return resolveToolCandidate(name, this.read(() => {
      const layers = this.layers.chainLayers(scope)
      const own = this.layers.peek(scope)
      const owned = own?.candidate(name, scope)
      if (owned !== undefined) return owned
      if (!layers.every(layer => layer.admits(name))) return undefined
      for (const layer of layers.toReversed()) {
        if (layer === own) continue
        const inherited = layer.candidate(name, scope)
        if (inherited !== undefined) return inherited
      }
      return this.layers.global.candidate(name, scope)
    }))
  }

  /**
   * Resolve one entry of the root a scope selects: a native root resolves the
   * scope's registrations, a PTC root only its program entry.
   * @param name - entry name.
   * @param scope - the viewing scope (the agent); omitted reads the root the unscoped context selects.
   * @returns the root's entry, or undefined when the root has none with that name.
   * @throws ToolRegistryUnavailableError when the scope's selected root is missing or unloaded.
   * @throws ToolCompositionError when the deciding scope offers several definitions, or when the root
   * or an included registry reads `ctx.tools`.
   */
  get(name: string, scope?: ScopeKey): ToolDefinition | undefined {
    return this.callRoot(() => this.selectRoot(scope).get(name, scope))
  }

  /**
   * List the entries of the root a scope selects, which its model steps
   * declare: a native root lists the scope's registrations after shadowing and
   * restrictions, a PTC root only its program entry.
   * @param scope - the viewing scope (the agent); omitted reads the root the unscoped context selects.
   * @returns the root's entries.
   * @throws ToolRegistryUnavailableError when the scope's selected root is missing or unloaded.
   * @throws ToolCompositionError when a visible name has several definitions in its deciding scope, or
   * when the root or an included registry reads `ctx.tools`.
   */
  getAll(scope?: ScopeKey): readonly ToolDefinition[] {
    return this.callRoot(() => resolveToolList(this.selectRoot(scope).getAll(scope)))
  }

  /**
   * Run one call into a root registry. A root receives the registrations from
   * `setRoot()`, so a root that reads `ctx.tools` during the call would read
   * itself; that read fails instead of recursing. A read that arrives while the
   * registrations are being read comes from an included registry and fails as
   * an inclusion cycle.
   * @param call - lookup or inclusion on a root registry.
   * @returns the call's result.
   * @throws ToolCompositionError when the root or an included registry reads `ctx.tools` during the call.
   */
  private callRoot<T>(call: () => T): T {
    if (this.viewing) throw inclusionCycle()
    if (this.callingRoot) {
      throw new ToolCompositionError('a root tool registry must not include or read ctx.tools; ctx.tools.setRoot() gives the root the registrations each scope sees')
    }
    this.callingRoot = true
    try {
      return call()
    } finally {
      this.callingRoot = false
    }
  }

  /**
   * Select the root registry for the calling scope; an unscoped call selects
   * the root for every scope without its own. Agents use the nearest selected root. The
   * root includes the registrations each viewing scope sees, and keeps them
   * after unloading so accepted batches settle their calls; selecting the
   * same registry again does not include them twice. A root must not include
   * or read `ctx.tools`: such a read fails with `ToolCompositionError` when
   * the root is selected or, for a root that reads it later, in the lookup or
   * batch that reaches it. Register tools through `ctx.tools`: a tool
   * registered directly in a root skips the scope's conflict check, so another
   * definition registered under its name through `ctx.tools` is accepted and
   * the next `ctx.tools.getAll()` throws. Selecting or unloading a root emits
   * `tools/change`; an observer that throws fails the selection, which
   * restores the scope's earlier selection, or none, and emits `tools/change`
   * again.
   * @param registry - initialized root owned by the contributing plugin.
   * @returns the effect disposer. Unloading leaves the selection unavailable until it is replaced.
   * @throws Error when the calling scope already has a live root.
   * @throws ToolCompositionError when the root's own entries conflict with the registrations, or when the root reads `ctx.tools`.
   * @throws the error a `tools/change` observer throws for the selection.
   */
  setRoot(registry: ToolRegistry): () => void {
    const scope = scopeOf(this.ctx)
    const key = scope ?? this.unscoped
    const existing = this.roots.get(key)
    if (existing?.registry !== undefined) throw new Error('Only one root tool registry may be installed in each scope')
    const record: RootSelection = { registry }
    const select = (selection: RootSelection | undefined): void => {
      if (selection === undefined) this.roots.delete(key)
      else this.roots.set(key, selection)
    }
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous cleanup; preserve the Cordis disposer identity
    return this.ctx.effect(function* (this: ToolsService) {
      // A root that reads ctx.tools fails this probe instead of later queries.
      const undo = this.callRoot(() => {
        const removeInclusion = this.includedRoots.has(registry) ? undefined : registry.include(this.registrations)
        try {
          resolveToolList(registry.getAll(scope))
        } catch (error: unknown) {
          removeInclusion?.()
          throw error
        }
        return removeInclusion
      })
      select(record)
      let committed = false
      yield () => {
        // Keep an unloaded selection so calls cannot fall through to a different root.
        if (committed) record.registry = undefined
        else {
          // A throwing observer failed the selection: restore the earlier state before notifying again.
          select(existing)
          undo?.()
        }
        this.notifyChange()
      }
      this.notifyChange()
      committed = true
      this.includedRoots.add(registry)
    }.bind(this), 'tools.setRoot()')
  }

  /**
   * Resolve the nearest root selected along the scope chain, ending with the unscoped selection.
   * @param scope - Agent or preset scope; omitted reads only the unscoped selection.
   * @returns the selected root; throws when it is missing or unloaded.
   */
  private selectRoot(scope?: ScopeKey): ToolRegistry {
    const record = [...scopeChainOf(scope), this.unscoped].map(key => this.roots.get(key)).find(found => found !== undefined)
    const registry = record?.registry
    if (registry === undefined) throw new ToolRegistryUnavailableError()
    return registry
  }

  /**
   * Execute a complete batch of calls to the entries of the root the Agent
   * selects, or the unscoped context's root for a standalone call. Each call runs the entry the root
   * resolves for the Agent; with a model step, only the exact entry the step
   * declared, and any other call fails as `UNKNOWN_TOOL`. A call naming a
   * tool the Agent can reach only from the root's entries, such as a program
   * binding, fails as `UNKNOWN_TOOL` before `tools/pre-execute`, approval,
   * guards, and execution wrappers, and its message names the entries the
   * Agent can call directly. An accepted batch settles through the root it
   * started with even if that root unloads. With log, root call/result events are committed to
   * the Agent's Session; without log, they are omitted. One outcome is
   * returned per input call in input order, including skipped calls on abort,
   * and the batch never settles while started work is still running.
   * Internal failures reject with ToolBatchExecutionError after draining,
   * preserving committed outcomes and context; callers must stop dependent
   * work and repair missing log results.
   * @param input - original calls, cancellation, optional concurrency override, Agent, model step, and logging step.
   * @returns settled results, deferred context, and whether a success concludes the turn.
   * @throws ToolRegistryUnavailableError when the Agent's selected root is missing or unloaded.
   */
  async execute(input: ToolBatchInput): Promise<ToolBatchResult> {
    const root = this.selectRoot(input.agent)
    const pipeline = new ToolExecutionPipeline(this.ctx, {
      get: (name, scope, toolStep) => {
        const entry = this.callRoot(() => root.get(name, scope))
        return entry !== undefined && (toolStep?.declares(entry) ?? true) ? entry : undefined
      },
      reject: (exec) => {
        // Only a registered tool the root does not offer directly, such as a program binding, is refused.
        if (this.callRoot(() => root.get(exec.name, exec.agent)) !== undefined) return undefined
        if (this.registered(exec.name, exec.agent) === undefined) return undefined
        // A step's declarations count only while the batch's root still offers them,
        // so a root replaced during the step cannot name the refused tool.
        const callable = exec.toolStep === undefined
          ? this.callRoot(() => root.getAll(exec.agent))
          : exec.toolStep.declarations.filter(entry => this.callRoot(() => root.get(entry.name, exec.agent)) === entry)
        return new ToolNotFoundError(exec.name, [...new Set(callable.map(entry => entry.name))])
      },
    })
    return executeToolBatch(input, pipeline)
  }

  /**
   * Register a monotonic denial in the calling scope.
   * @param guard - evaluated after extensible pre-execute policy by the shared pipeline.
   * @returns the effect disposer that removes this guard.
   */
  guard(guard: ToolGuard): () => void {
    return this.guards.effect(this.ctx, layer => layer.guards.append(guard), { label: 'tools.guard()' })
  }

  /**
   * Check global and inherited guards after pre-execute policy and approval resolve.
   * @param exec - invocation whose guards are checked before dispatch.
   * @returns the first denial with its optional structured identity, or undefined when no guard denies.
   */
  checkGuards(exec: ToolExecution): ToolGuardDenial | undefined {
    for (const layer of [this.guards.global, ...this.guards.chainLayers(exec.agent)]) {
      for (const guard of layer.guards.values()) {
        const denial = guard(exec)
        if (denial !== undefined) return typeof denial === 'string' ? { reason: denial } : denial
      }
    }
    return undefined
  }
}

export default ToolsService

/** The failure of a read that re-enters `ctx.tools` through an included registry. */
function inclusionCycle(): ToolCompositionError {
  return new ToolCompositionError('tool registry inclusion cycle reaches ctx.tools')
}

export * from './contracts.ts'
export * from './registry.ts'
export * from './schema.ts'
export * from './json-schema.ts'
export * from './presentation.ts'
export type { ToolStep } from './step.ts'
export type { AgentToolRegistry } from './agent-tools.ts'
export type { NativeToolRegistry } from './native-registry.ts'
export { ToolsService as ToolRuntime }
