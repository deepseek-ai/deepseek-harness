/** Optional names for tool-owned subagent creation and discovery. @module */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionHandle, ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-query'
import type {
  SubagentActivation, SubagentActivationSpec, SubagentCatalogEntry, SubagentDescendantListEntry,
} from '@deepseek-ai/dsh-subagent'
import { nameSchema, subagentNamesProjection } from './projection.ts'
import type { SubagentNameBinding, SubagentNamesState } from './projection.ts'

export type { SubagentNameBinding } from './projection.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    subagentNames: SubagentNames
  }
}

/** Named children use parent delivery so the existing catalog retains their identities. */
export type NamedSubagentActivationSpec = Omit<SubagentActivationSpec, 'childId' | 'delivery'> & {
  readonly delivery: 'parent'
  readonly name?: string
}

/** Stable categories for name validation, discovery, and accepted-start binding failures. */
export type SubagentNameErrorCode =
  | 'INVALID_AGENT_NAME'
  | 'DUPLICATE_AGENT_NAME'
  | 'AGENT_NAME_NOT_FOUND'
  | 'CORRUPT_AGENT_NAMES'
  | 'AGENT_NAMES_UNAVAILABLE'
  | 'DUPLICATE_CHILD'
  | 'SUBAGENT_NAME_BIND_FAILED'

/** A name operation failed; an external binding failure identifies the already-started child. */
export class SubagentNameError extends HarnessError {
  constructor(message: string, code: SubagentNameErrorCode, options?: ErrorOptions, readonly childId?: SessionId) {
    super(message, code, options)
    this.name = 'SubagentNameError'
  }
}

interface ParentNames {
  readonly children: readonly SubagentCatalogEntry[]
  readonly bindings: readonly SubagentNameBinding[]
}

interface Startup {
  readonly controller: AbortController
  readonly settled: Promise<void>
}

/** Catalog-backed names that leave subagent execution and authorization with their existing owner. */
export class SubagentNames extends Service {
  static inject = ['agents', 'subagents', 'sessionProjections']

  private projection!: ProjectionHandle<SubagentNamesState>
  private readonly pending = new WeakMap<Agent, Set<string>>()
  private readonly initializing = new Map<SessionId, { readonly root: Agent; readonly name: string }>()
  private readonly startups = new Set<Startup>()
  private closing = false

  constructor(ctx: Context) {
    super(ctx, 'subagentNames')
  }

  protected async [Service.init](): Promise<void> {
    const ctx = this.ctx
    const registration = ctx.sessionProjections.register(subagentNamesProjection)
    const drain = async (): Promise<void> => {
      this.closing = true
      for (const startup of this.startups) startup.controller.abort(new Error('subagent naming is unloading'))
      await Promise.all([...this.startups].map(startup => startup.settled))
    }
    ctx.effect(function* () {
      // The registry's documented callable registration is its exact effect disposer.
      // A synchronous yield adopts it without awaiting its handle or replacing its identity.
      yield registration as typeof registration & (() => Promise<void>)
      yield ctx.effect(() => drain, 'subagentNames.startups()')
    }, 'subagentNames.lifetime()')
    this.projection = await registration
  }

  /**
   * Start a named child, reserving its sibling name until startup settles.
   * Parent delivery retains catalog membership. Local names precede catalog publication;
   * external names follow accepted startup.
   * @param spec - ordinary activation options and an optional lower-case sibling name.
   * @returns the existing activation receipt plus its full name.
   * @throws SubagentNameError for invalid or duplicate names. An external binding failure
   * includes childId and awaits disposal without undoing completed work.
   */
  async startActivation(spec: NamedSubagentActivationSpec): Promise<SubagentActivation & { readonly name: string }> {
    this.assertOpen()
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, spec.signal])
    const settled = Promise.withResolvers<void>()
    const startup = { controller, settled: settled.promise }
    this.startups.add(startup)
    try {
      return await this.startNamed(spec, signal)
    } finally {
      this.startups.delete(startup)
      settled.resolve()
    }
  }

  private async startNamed(
    spec: NamedSubagentActivationSpec,
    signal: AbortSignal,
  ): Promise<SubagentActivation & { readonly name: string }> {
    const { name: requested, ...request } = spec
    if (requested !== undefined && !nameSchema.safeParse(requested).success) {
      throw new SubagentNameError('agent name must start with a lower-case letter and contain only lower-case letters, digits, underscores, or hyphens', 'INVALID_AGENT_NAME')
    }
    const parent = spec.parent
    const root = this.ctx.subagents.rootOf(parent)
    const parentName = await this.nameOf(parent, signal)
    this.assertOpen()
    signal.throwIfAborted()
    this.ctx.subagents.rootOf(parent)
    const provider = this.ctx.subagents.getProvider(spec.provider)
    if (provider === undefined) throw new SubagentNameError(`subagent provider "${spec.provider}" is unavailable`, 'AGENT_NAMES_UNAVAILABLE')
    const pending = this.pending.get(parent) ?? new Set<string>()
    this.pending.set(parent, pending)
    const names = this.liveParentNames(parent.session)
    const occupied = new Set([...names.children.map(child => this.segment(names, child.id)), ...pending])
    let segment = requested
    if (segment === undefined) {
      let ordinal = 1
      while (occupied.has(`agent-${ordinal}`)) ordinal++
      segment = `agent-${ordinal}`
    }
    if (occupied.has(segment)) throw new SubagentNameError(`agent name "${segment}" is already in use under ${parentName}; choose another name`, 'DUPLICATE_AGENT_NAME')
    const name = `${parentName}/${segment}`
    pending.add(segment)
    const childId = provider.prepareContinuable === undefined ? undefined : SessionId(randomUUID())
    try {
      if (childId !== undefined) {
        parent.session.append('subagent-name/bound', { version: 1, childId, name: segment })
        this.initializing.set(childId, { root, name })
      }
      const activation = await this.ctx.subagents.startActivation({
        ...request,
        ...childId === undefined ? {} : { childId },
        signal,
        prompt: [
          ...request.prompt,
          { type: 'text', text: `Your name is ${JSON.stringify(name)}. Your parent agent name is ${JSON.stringify(parentName)}.` },
        ],
      })
      if (childId === undefined) {
        try {
          signal.throwIfAborted()
          this.ctx.subagents.rootOf(parent)
          if (this.projection.stateOf(parent.session).bindings.some(binding => binding.childId === activation.childId)) {
            throw new SubagentNameError(`subagent identity ${activation.childId} already has a name candidate`, 'DUPLICATE_CHILD')
          }
          parent.session.append('subagent-name/bound', { version: 1, childId: activation.childId, name: segment })
        } catch (error: unknown) {
          let cause = error
          let disposition = 'Its activation has been disposed; completed work cannot be undone.'
          try {
            await activation.dispose()
          } catch (cleanupError: unknown) {
            cause = new AggregateError([error, cleanupError], 'External subagent name binding and disposal failed', { cause: error })
            disposition = 'Its disposal also failed; execution may still be active.'
          }
          throw new SubagentNameError(
            `Subagent ${activation.childId} started but its name ${name} could not be recorded. ${disposition} Check this child before retrying.`,
            'SUBAGENT_NAME_BIND_FAILED', { cause }, activation.childId,
          )
        }
      }
      return { ...activation, name }
    } finally {
      pending.delete(segment)
      if (childId !== undefined) this.initializing.delete(childId)
    }
  }

  /**
   * Read the full name of an exact live Agent without restoring its ancestors.
   * @param agent - live root or managed child whose name is requested.
   * @param signal - cancellation during parent catalog reads.
   * @returns lead, named path segments, or legacy id segments for unnamed children.
   */
  async nameOf(agent: Agent, signal?: AbortSignal): Promise<string> {
    this.assertOpen()
    signal?.throwIfAborted()
    const pending = this.initializing.get(agent.id)
    if (pending !== undefined && this.ctx.agents.get(agent.id) === agent
      && this.ctx.agents.get(pending.root.id) === pending.root) return pending.name
    const root = this.ctx.subagents.rootOf(agent)
    if (root === agent) return 'lead'
    const segments: string[] = []
    const visited = new Set<SessionId>([agent.id])
    let childId = agent.id
    let parentId = agent.session.header.parentSession
    while (parentId !== undefined) {
      if (visited.has(parentId)) throw new SubagentNameError('agent naming found cyclic creation ancestry', 'CORRUPT_AGENT_NAMES')
      visited.add(parentId)
      using parent = await this.query().observeSession(parentId, signal === undefined ? {} : { signal })
      signal?.throwIfAborted()
      segments.unshift(this.segment(this.observedNames(parent.projections?.values), childId))
      if (parentId === root.id) {
        this.ctx.subagents.rootOf(agent)
        return ['lead', ...segments].join('/')
      }
      childId = parentId
      parentId = parent.header.parentSession
    }
    throw new SubagentNameError('agent is absent from the root creation ancestry', 'AGENT_NAMES_UNAVAILABLE')
  }

  /**
   * Translate a canonical path or a tree member's exact id without granting authority.
   * @param caller - exact live Agent selecting the subagent tree.
   * @param name - lead, a lead-prefixed path, or an existing member's exact Session id.
   * @param signal - cancellation during catalog reads.
   * @returns the identity for the subagent operation to authorize.
   */
  async resolveName(caller: Agent, name: string, signal?: AbortSignal): Promise<SessionId> {
    this.assertOpen()
    signal?.throwIfAborted()
    const root = this.ctx.subagents.rootOf(caller)
    if (name === 'lead' || name === root.id) return root.id
    if (!name.startsWith('lead/')) {
      const entries = await this.ctx.subagents.listDescendants(root.id, signal)
      const entry = entries.find(candidate => candidate.id === name)
      if (entry !== undefined) return entry.id
    } else {
      let parentId = root.id
      const segments = name.slice('lead/'.length).split('/')
      for (const [index, segment] of segments.entries()) {
        const parent = await this.readParentNames(parentId, signal)
        const child = parent.children.find(child => this.segment(parent, child.id) === segment)
        if (child === undefined) break
        if (index === segments.length - 1) return child.id
        if (child.mode === 'external') break
        parentId = child.id
      }
    }
    throw new SubagentNameError(`agent "${name}" was not found; use list_agents to discover names or ids`, 'AGENT_NAME_NOT_FOUND')
  }

  /**
   * Attach relative names to the existing catalog traversal and its branch diagnostics.
   * @param rootId - Session whose catalog starts discovery.
   * @param signal - cancellation while reading descendant and name projections.
   * @returns existing descendant rows with paths relative to rootId.
   */
  async listDescendants(rootId: SessionId, signal?: AbortSignal): Promise<(SubagentDescendantListEntry & { readonly path: string })[]> {
    this.assertOpen()
    const entries = await this.ctx.subagents.listDescendants(rootId, signal)
    const paths = new Map<SessionId, string>([[rootId, '']])
    const parents = new Map<SessionId, ParentNames>()
    const result: (SubagentDescendantListEntry & { readonly path: string })[] = []
    for (const entry of entries) {
      let parent = parents.get(entry.parentId)
      if (parent === undefined) {
        parent = await this.readParentNames(entry.parentId, signal)
        parents.set(entry.parentId, parent)
      }
      // The subagent traversal emits parents before their descendants.
      const prefix = paths.get(entry.parentId) as string
      const segment = this.segment(parent, entry.id)
      const path = prefix.length === 0 ? segment : `${prefix}/${segment}`
      paths.set(entry.id, path)
      result.push({ ...entry, path })
    }
    return result
  }

  private liveParentNames(session: Session): ParentNames {
    // The required subagents service registers this projection before becoming available.
    const children = this.ctx.sessionProjections.snapshot(session, ['subagentCatalog']).values.subagentCatalog as SubagentCatalogEntry[]
    return { children, bindings: this.projection.stateOf(session).bindings }
  }

  private async readParentNames(id: SessionId, signal?: AbortSignal): Promise<ParentNames> {
    signal?.throwIfAborted()
    using parent = await this.query().observeSession(id, signal === undefined ? {} : { signal })
    signal?.throwIfAborted()
    return this.observedNames(parent.projections?.values)
  }

  private observedNames(values: ProjectionSnapshot['values'] | undefined): ParentNames {
    if (values?.subagentCatalog === undefined || values.subagentNames === undefined) {
      throw new SubagentNameError('subagent catalog or name projection is unavailable', 'AGENT_NAMES_UNAVAILABLE')
    }
    return { children: values.subagentCatalog, bindings: values.subagentNames }
  }

  private segment(parent: ParentNames, childId: SessionId): string {
    if (!parent.children.some(child => child.id === childId)) {
      throw new SubagentNameError('agent is absent from its parent catalog', 'AGENT_NAMES_UNAVAILABLE')
    }
    const name = parent.bindings.find(binding => binding.childId === childId)?.name
    if (name !== undefined && parent.bindings.some(binding => binding.name === name && binding.childId !== childId
      && parent.children.some(child => child.id === binding.childId))) {
      throw new SubagentNameError(`agent name "${name}" refers to multiple catalog children`, 'CORRUPT_AGENT_NAMES')
    }
    return name ?? `legacy:${childId}`
  }

  private assertOpen(): void {
    if (this.closing) throw new SubagentNameError('subagent naming is unavailable while its plugin unloads', 'AGENT_NAMES_UNAVAILABLE')
  }

  private query(): Context['sessionQuery'] {
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) throw new SubagentNameError('agent naming requires the sessionQuery service for parent reads', 'AGENT_NAMES_UNAVAILABLE')
    return query
  }
}

export default SubagentNames
