/** Root-scoped name reservations reconstructed from parent-owned catalogs.
 * @module @deepseek-ai/dsh-subagent/names
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { liveCatalogEntries } from './catalog.ts'
import { subagentNameSchema } from './descriptor.ts'
import { SubagentError } from './error.ts'
import { listChildren } from './list-children.ts'

interface NameEntry {
  readonly id: SessionId | undefined
  readonly committed: boolean
}

/** Committed identities and unpublished reservations shared by one live root. */
export class SubagentNames {
  private readonly trees = new WeakMap<Agent, Map<string, NameEntry>>()

  /** @param ctx - subagent service context with live Agents and Session projections. */
  constructor(private readonly ctx: Context) {}

  /**
   * Reserve a name and any known local identity before child preparation.
   * @param parent - exact live spawning Agent.
   * @param name - explicit lower-case name; lead and unowned are reserved.
   * @param signal - cancellation while rebuilding historical assignments.
   * @param id - reserved local identity, when the provider does not allocate it.
   * @returns a catalog publication operation and unpublished-reservation release.
   * @throws when the name or identity is taken, invalid, or cannot be checked.
   */
  async reserve(parent: Agent, name: string, signal: AbortSignal, id?: SessionId): Promise<{
    commit(id: SessionId, publish: () => void): void
    [Symbol.dispose](): void
  }> {
    if (!subagentNameSchema.safeParse(name).success) {
      throw new SubagentError('agent name must start with a lower-case letter and contain only lower-case letters, digits, underscores, or hyphens; lead and unowned are reserved', 'INVALID_AGENT_NAME')
    }
    const root = this.rootOf(parent)
    const names = await this.index(root, signal)
    signal.throwIfAborted()
    if (this.rootOf(parent) !== root) throw new SubagentError('agent tree changed during creation', 'AGENT_TREE_UNAVAILABLE')
    if (names.has(name)) {
      throw new SubagentError(`agent name "${name}" is already in use in this tree; choose another name`, 'DUPLICATE_AGENT_NAME')
    }
    const checkId = (candidate: SessionId): void => {
      for (const [other, value] of names) {
        if (other !== name && value.id === candidate) throw new SubagentError(`subagent "${candidate}" already exists`, 'DUPLICATE_CHILD')
      }
    }
    if (id !== undefined) checkId(id)
    names.set(name, { id, committed: false })
    let committed = false
    return {
      commit: (childId, publish) => {
        if (this.rootOf(parent) !== root) throw new SubagentError('agent tree changed during creation', 'AGENT_TREE_UNAVAILABLE')
        checkId(childId)
        publish()
        names.set(name, { id: childId, committed: true })
        committed = true
      },
      [Symbol.dispose]: () => { if (!committed) names.delete(name) },
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
   * @param signal - cancellation while rebuilding historical assignments.
   * @returns the durable identity for the consuming operation to authorize.
   * @throws when the name is absent or historical catalogs cannot be read.
   */
  async resolve(caller: Agent, name: string, signal?: AbortSignal): Promise<SessionId> {
    signal?.throwIfAborted()
    const root = this.rootOf(caller)
    if (name === 'lead') return root.id
    const entry = (await this.index(root, signal)).get(name)
    if (entry?.committed && entry.id !== undefined) return entry.id
    throw new SubagentError(`agent name "${name}" was not found; use list_agents to discover available names`, 'AGENT_NAME_NOT_FOUND')
  }

  /** Cache complete catalog traversals; concurrent readers adopt the first completed index. */
  private async index(root: Agent, signal?: AbortSignal): Promise<Map<string, NameEntry>> {
    signal?.throwIfAborted()
    const existing = this.trees.get(root)
    if (existing !== undefined) return existing
    const names = new Map<string, NameEntry>([['lead', { id: root.id, committed: true }]])
    const ids = new Set<SessionId>([root.id])
    const pending = [...liveCatalogEntries(this.ctx.get('sessionProjections'), root.session)]
    for (const entry of pending) {
      signal?.throwIfAborted()
      const name = entry.name ?? `legacy:${entry.id}`
      if (names.get(name)?.id === entry.id) continue
      if (names.has(name) || ids.has(entry.id)) {
        throw new SubagentError('duplicate cataloged agent name or identity; restore valid subagent catalogs', 'CORRUPT_AGENT_NAMES')
      }
      names.set(name, { id: entry.id, committed: true })
      ids.add(entry.id)
      if (entry.mode !== 'external') {
        const live = this.ctx.get('sessions')?.get(entry.id)
        pending.push(...(live === undefined
          ? await listChildren(this.ctx, entry.id, signal)
          : liveCatalogEntries(this.ctx.get('sessionProjections'), live)))
      }
    }
    signal?.throwIfAborted()
    this.rootOf(root)
    const shared = this.trees.get(root) ?? names
    this.trees.set(root, shared)
    return shared
  }

  /** Resolve only uninterrupted live subagent ancestry, never a fork's inherited parent. */
  private rootOf(caller: Agent): Agent {
    if (this.ctx.agents.get(caller.id) !== caller) {
      throw new SubagentError('agent naming requires the exact live caller', 'UNAUTHORIZED')
    }
    let root = caller
    const seen = new Set<SessionId>()
    while (root.session.header.origin === 'subagent') {
      const parentId = root.session.header.parentSession
      const parent = parentId === undefined ? undefined : this.ctx.agents.get(parentId)
      seen.add(root.id)
      if (parent === undefined || seen.has(parent.id)) {
        throw new SubagentError('agent naming requires the live parent tree', 'AGENT_TREE_UNAVAILABLE')
      }
      root = parent
    }
    return root
  }
}
