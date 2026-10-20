/** Parent-local name reservations and catalog-based agent paths.
 * @module @deepseek-ai/dsh-subagent/names
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentCatalogEntry } from './projection-types.ts'
import { subagentNameSchema, subagentNameSegment } from './catalog.ts'
import { SubagentError } from './error.ts'
import { listChildren } from './list-children.ts'

/** Service-owned catalogs, published Activations, and names during initialization. */
interface NameSources {
  catalogOf(session: Session): SubagentCatalogEntry[]
  residencyOf(agent: Agent): {
    readonly name: string
    readonly root: Agent
    readonly ancestors: readonly SessionId[]
  } | undefined
  initializingNameOf(agent: Agent): string | undefined
}

/** Pending names belong to their live parent; committed names belong to its catalog. */
export class SubagentNames {
  private readonly pending = new WeakMap<Agent, Set<string>>()

  /**
   * @param ctx - subagent service context with live Agents and Session queries.
   * @param sources - service-owned projection reads and managed residency.
   */
  constructor(private readonly ctx: Context, private readonly sources: NameSources) {}

  /**
   * Reserve a sibling name before preparation or external provider dispatch.
   * @param parent - exact live spawning Agent.
   * @param requestedName - one lower-case segment; omission selects the first unused agent-N.
   * @param signal - cancellation before reservation or publication.
   * @param id - reserved local identity, when the provider does not allocate it.
   * @returns the full path, parent catalog publication, and temporary-reservation release.
   * @throws when the name or identity is taken, invalid, or cannot be checked.
   */
  reserve(parent: Agent, requestedName: string | undefined, signal: AbortSignal, id?: SessionId): {
    readonly segment: string
    readonly name: string
    commit(id: SessionId, publish: () => void): void
    [Symbol.dispose](): void
  } {
    if (requestedName !== undefined && !subagentNameSchema.safeParse(requestedName).success) {
      throw new SubagentError('agent name must start with a lower-case letter and contain only lower-case letters, digits, underscores, or hyphens', 'INVALID_AGENT_NAME')
    }
    const lineage = this.lineage(parent)
    signal.throwIfAborted()
    const children = () => this.sources.catalogOf(parent.session)
    const pending = this.pending.get(parent) ?? new Set<string>()
    this.pending.set(parent, pending)
    const occupied = new Set([...children().map(subagentNameSegment), ...pending])
    let name = requestedName
    if (name === undefined) {
      let ordinal = 1
      while (occupied.has(`agent-${ordinal}`)) ordinal++
      name = `agent-${ordinal}`
    }
    const path = `${this.nameOf(parent)}/${name}`
    if (occupied.has(name)) {
      throw new SubagentError(`agent name "${name}" is already in use under ${this.nameOf(parent)}; choose another name`, 'DUPLICATE_AGENT_NAME')
    }
    const checkId = (candidate: SessionId): void => {
      if (lineage.some(agent => agent.id === candidate)
        || this.sources.residencyOf(parent)?.ancestors.includes(candidate)
        || children().some(child => child.id === candidate)) {
        throw new SubagentError(`subagent "${candidate}" already exists`, 'DUPLICATE_CHILD')
      }
    }
    if (id !== undefined) checkId(id)
    pending.add(name)
    return {
      segment: name,
      name: path,
      commit: (childId, publish) => {
        signal.throwIfAborted()
        if (lineage.some(agent => this.ctx.agents.get(agent.id) !== agent)) {
          throw new SubagentError('agent tree changed during creation', 'AGENT_TREE_UNAVAILABLE')
        }
        checkId(childId)
        publish()
      },
      [Symbol.dispose]: () => { pending.delete(name) },
    }
  }

  /**
   * Derive an Agent's full path from its creation ancestry and parent catalogs.
   * @param agent - exact live Agent.
   * @returns lead followed by named or legacy child segments.
   */
  nameOf(agent: Agent): string {
    const lineage = this.lineage(agent)
    const name = this.sources.residencyOf(agent)?.name ?? this.sources.initializingNameOf(agent)
    if (name !== undefined) return name
    return lineage.map((member, index) => {
      if (index === 0) return 'lead'
      const parent = lineage[index - 1] as Agent
      const entry = this.sources.catalogOf(parent.session).find(child => child.id === member.id)
      if (entry === undefined) throw new SubagentError('subagent is absent from its creator catalog', 'UNAUTHORIZED')
      return subagentNameSegment(entry)
    }).join('/')
  }

  /**
   * Follow a full path through direct-child catalogs without granting operation authority.
   * @param caller - exact live Agent selecting the tree.
   * @param name - full path returned by creation or discovery.
   * @param signal - cancellation during historical catalog reads.
   * @returns the durable identity for the consuming operation to authorize.
   * @throws when a path segment is absent, ambiguous, or its parent cannot be read.
   */
  async resolve(caller: Agent, name: string, signal?: AbortSignal): Promise<SessionId> {
    signal?.throwIfAborted()
    const root = this.lineage(caller)[0]
    if (name === 'lead') return root.id
    const segments = name.split('/')
    if (segments.shift() === 'lead') {
      let children = this.sources.catalogOf(root.session)
      for (const [index, segment] of segments.entries()) {
        signal?.throwIfAborted()
        const matches = children.filter(child => subagentNameSegment(child) === segment)
        const child = matches[0]
        if (child === undefined) break
        if (matches.some(match => match.id !== child.id)) {
          throw new SubagentError(`agent path "${name}" has an ambiguous segment; restore its parent catalog`, 'CORRUPT_AGENT_NAMES')
        }
        if (index === segments.length - 1) return child.id
        if (child.mode === 'external') break
        children = await listChildren(this.ctx, child.id, signal)
      }
    }
    throw new SubagentError(`agent path "${name}" was not found; use list_agents to discover available paths`, 'AGENT_NAME_NOT_FOUND')
  }

  /** Select the live root and caller; unmanaged Agents require their live creation ancestors. */
  private lineage(caller: Agent): [Agent, ...Agent[]] {
    if (this.ctx.agents.get(caller.id) !== caller) {
      throw new SubagentError('agent naming requires the exact live caller', 'UNAUTHORIZED')
    }
    const resident = this.sources.residencyOf(caller)
    if (resident !== undefined || this.sources.initializingNameOf(caller) !== undefined) {
      const root = resident?.root ?? this.ctx.agents.roots().find(owner => this.ctx.agents.isOwnedBy(caller.id, owner))
      if (root === undefined || this.ctx.agents.get(root.id) !== root) {
        throw new SubagentError('agent naming requires the live Team root', 'AGENT_TREE_UNAVAILABLE')
      }
      return [root, caller]
    }
    const lineage: [Agent, ...Agent[]] = [caller]
    let current = caller
    while (current.session.header.origin === 'subagent') {
      const id = current.session.header.parentSession
      const parent = id === undefined ? undefined : this.ctx.agents.get(id)
      if (parent === undefined || lineage.includes(parent)) {
        throw new SubagentError('agent naming requires the live parent tree', 'AGENT_TREE_UNAVAILABLE')
      }
      lineage.unshift(parent)
      current = parent
    }
    return lineage
  }
}
