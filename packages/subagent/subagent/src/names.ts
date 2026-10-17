/** Root-scoped temporary reservations over committed catalog names.
 * @module @deepseek-ai/dsh-subagent/names
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { catalogNames, liveCatalogEntries, liveCatalogState } from './catalog.ts'
import { subagentNameSchema } from './descriptor.ts'
import { SubagentError } from './error.ts'
import { listChildren } from './list-children.ts'

/** Pending names share the exact live root's lifetime; committed names belong to its catalog. */
export class SubagentNames {
  private readonly pending = new WeakMap<Agent, Set<string>>()

  /** @param ctx - subagent service context with live Agents and Session projections. */
  constructor(private readonly ctx: Context) {}

  /**
   * Reserve synchronously before child preparation. Publication writes the parent fact,
   * then the root registration without awaiting; only the latter commits a nested child.
   * A failed second append can leave a parent fact but releases the pending name.
   * @param parent - exact live spawning Agent.
   * @param name - explicit lower-case name; lead and unowned are reserved.
   * @param signal - cancellation before reservation or publication.
   * @param id - reserved local identity, when the provider does not allocate it.
   * @returns a catalog publication operation and unpublished-reservation release.
   * @throws when the name or identity is taken, invalid, or cannot be checked.
   */
  reserve(parent: Agent, name: string, signal: AbortSignal, id?: SessionId): {
    commit(id: SessionId, publish: () => void): void
    [Symbol.dispose](): void
  } {
    if (!subagentNameSchema.safeParse(name).success) {
      throw new SubagentError('agent name must start with a lower-case letter and contain only lower-case letters, digits, underscores, or hyphens; lead and unowned are reserved', 'INVALID_AGENT_NAME')
    }
    const root = this.ctx.subagents.rootOf(parent)
    signal.throwIfAborted()
    const names = this.committed(root)
    const pending = this.pending.get(root) ?? new Set<string>()
    this.pending.set(root, pending)
    if (names.has(name) || pending.has(name)) {
      throw new SubagentError(`agent name "${name}" is already in use in this tree; choose another name`, 'DUPLICATE_AGENT_NAME')
    }
    const checkId = (candidate: SessionId): void => {
      for (const value of this.committed(root).values()) {
        if (value === candidate) throw new SubagentError(`subagent "${candidate}" already exists`, 'DUPLICATE_CHILD')
      }
    }
    if (id !== undefined) checkId(id)
    pending.add(name)
    return {
      commit: (childId, publish) => {
        signal.throwIfAborted()
        if (this.ctx.subagents.rootOf(parent) !== root) throw new SubagentError('agent tree changed during creation', 'AGENT_TREE_UNAVAILABLE')
        checkId(childId)
        publish()
        if (parent !== root) {
          root.session.append('subagent/catalog', { version: 3, kind: 'name', childId, name })
        }
      },
      [Symbol.dispose]: () => { pending.delete(name) },
    }
  }

  /**
   * Read an Agent's name from its own descriptor projection.
   * @param agent - exact live Agent.
   * @returns lead for roots, the descriptor name, or an older child's legacy address.
   */
  nameOf(agent: Agent): string {
    if (this.ctx.agents.get(agent.id) !== agent) {
      throw new SubagentError('agent naming requires the exact live caller', 'UNAUTHORIZED')
    }
    if (agent.session.header.origin !== 'subagent') return 'lead'
    const state = this.ctx.get('sessionProjections')?.stateOf(agent.session, 'subagent')
    if (state === undefined) throw new SubagentError('agent names require the subagent identity projection', 'CONTINUATION_UNAVAILABLE')
    const identity = state.identity
    return identity !== undefined && agent.session.isOwnSeq(identity.seq) && identity.name !== undefined
      ? identity.name : `legacy:${agent.id}`
  }

  /**
   * Resolve a name without granting messaging, interruption, or assignment authority.
   * @param caller - exact live Agent selecting the tree.
   * @param name - assigned name or an older child's legacy address.
   * @param signal - cancellation during lookup, including historical legacy traversal.
   * @returns the durable identity for the consuming operation to authorize.
   * @throws when the name is absent, the root catalog is invalid, or legacy traversal fails.
   */
  async resolve(caller: Agent, name: string, signal?: AbortSignal): Promise<SessionId> {
    signal?.throwIfAborted()
    const root = this.ctx.subagents.rootOf(caller)
    if (name === 'lead') return root.id
    const id = this.committed(root).get(name)
    if (id !== undefined) return id
    if (name.startsWith('legacy:')) {
      const pending = [...liveCatalogEntries(this.ctx.get('sessionProjections'), root.session)]
      const visited = new Set<SessionId>([root.id])
      for (const entry of pending) {
        signal?.throwIfAborted()
        if (visited.has(entry.id)) continue
        visited.add(entry.id)
        if (entry.name === undefined && name === `legacy:${entry.id}`) return entry.id
        if (entry.mode !== 'external') pending.push(...await listChildren(this.ctx, entry.id, signal))
      }
    }
    throw new SubagentError(`agent name "${name}" was not found; use list_agents to discover available names`, 'AGENT_NAME_NOT_FOUND')
  }

  /**
   * Check whether a named child reached creation commit, without changing lineage authority.
   * @param caller - exact live Agent selecting the tree.
   * @param name - name copied from the child's descriptor or parent catalog.
   * @param id - child identity paired with that name.
   * @returns whether the root catalog records that assignment.
   */
  isRegistered(caller: Agent, name: string, id: SessionId): boolean {
    return this.committed(this.ctx.subagents.rootOf(caller)).get(name) === id
  }

  private committed(root: Agent): ReadonlyMap<string, SessionId> {
    return new Map([['lead', root.id], ...catalogNames(liveCatalogState(this.ctx.get('sessionProjections'), root.session), root.id)])
  }

}
