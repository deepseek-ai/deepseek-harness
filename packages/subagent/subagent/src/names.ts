/** Durable tree-wide agent names and unpublished creation reservations.
 * @module @deepseek-ai/dsh-subagent/names
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { SubagentError } from './error.ts'
import { listDescendants } from './list-children.ts'

/** One immutable name assigned in the root Session before child publication. */
export interface SubagentNameData {
  readonly name: string
  readonly id: SessionId
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A tree-wide agent name, retained after its execution ends.
     * @param data - the name and durable child identity.
     */
    'subagent/named': SubagentNameData
  }
}

/** Root-owned name assignments, excluding fork-inherited events. */
export interface SubagentNamesState {
  readonly inheritedEventCount: SessionLogOffset
  readonly entries: readonly SubagentNameData[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    subagentNames: SubagentNamesState
  }
}

const nameSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/).refine(value => value !== 'lead' && value !== 'unowned')
const entrySchema = z.object({ name: nameSchema, id: z.string().transform(SessionId) }).strict()

const stateSchema: z.ZodType<SubagentNamesState> = z.object({
  inheritedEventCount: z.number().int().nonnegative().transform(SessionLogOffset),
  entries: z.array(entrySchema),
}).strict().refine(state => new Set(state.entries.map(entry => entry.name)).size === state.entries.length
  && new Set(state.entries.map(entry => entry.id)).size === state.entries.length, 'duplicate persisted agent name or identity')

/** Host-only name projection; corrupt duplicate assignments reject restoration. */
export const subagentNamesProjectionDefinition = {
  key: 'subagentNames',
  stateVersion: 0,
  stateSchema,
  init: (_header: SessionHeader, inheritedEventCount: SessionLogOffset): SubagentNamesState => ({ inheritedEventCount, entries: [] }),
  apply: (state, event: SessionEvent) => {
    if (event.type !== 'subagent/named' || event.seq < state.inheritedEventCount) return state
    const entry = entrySchema.parse(event.data)
    if (state.entries.some(existing => existing.name === entry.name || existing.id === entry.id)) {
      throw new SubagentError('duplicate persisted agent name or identity; restore a valid Session log', 'CORRUPT_AGENT_NAMES')
    }
    return { ...state, entries: [...state.entries, entry] }
  },
} satisfies ProjectionDefinition<'subagentNames', SubagentNamesState>

/** Owns creation reservations; committed assignments come only from the root projection. */
export class SubagentNames {
  private readonly pending = new WeakMap<Session, Set<string>>()

  /** @param ctx - subagent service context with live Agents and Session projections. */
  constructor(private readonly ctx: Context) {}

  /**
   * Reserve a unique name before asynchronous child preparation.
   * @param parent - exact live spawning Agent.
   * @param name - explicit lower-case name; lead and unowned are reserved.
   * @returns a publication operation and an idempotent unpublished-reservation release.
   * @throws when the name is invalid, taken, or the live tree is unavailable.
   */
  reserve(parent: Agent, name: string): { commit(id: SessionId): void; [Symbol.dispose](): void } {
    if (!nameSchema.safeParse(name).success) {
      throw new SubagentError('agent name must start with a lower-case letter and contain only lower-case letters, digits, underscores, or hyphens; lead and unowned are reserved', 'INVALID_AGENT_NAME')
    }
    const root = this.rootOf(parent)
    let pending = this.pending.get(root.session)
    if (pending === undefined) {
      pending = new Set()
      this.pending.set(root.session, pending)
    }
    if (pending.has(name) || this.entries(root.session).some(entry => entry.name === name)) {
      throw new SubagentError(`agent name "${name}" is already in use in this tree; choose another name`, 'DUPLICATE_AGENT_NAME')
    }
    pending.add(name)
    return {
      commit: (id) => {
        if (this.rootOf(parent) !== root) throw new SubagentError('agent tree changed during creation', 'AGENT_TREE_UNAVAILABLE')
        root.session.append('subagent/named', { name, id })
      },
      [Symbol.dispose]: () => { pending.delete(name) },
    }
  }

  /**
   * Read an agent's model-facing name in the caller's tree.
   * @param caller - exact live Agent selecting the tree.
   * @param id - target identity; defaults to the caller.
   * @returns lead, an assigned name, or a stable legacy address for an older unnamed identity.
   */
  nameOf(caller: Agent, id: SessionId = caller.id): string {
    const root = this.rootOf(caller)
    if (id === root.id) return 'lead'
    return this.entries(root.session).find(entry => entry.id === id)?.name ?? `legacy:${id}`
  }

  /**
   * Resolve a name without granting message, interrupt, or assignment authority.
   * @param caller - exact live Agent selecting the tree.
   * @param name - assigned name or a legacy address returned by discovery.
   * @param signal - cancellation during legacy catalog discovery.
   * @returns the durable identity; the consuming operation still authorizes access.
   * @throws when the name is absent from the caller's tree.
   */
  async resolve(caller: Agent, name: string, signal?: AbortSignal): Promise<SessionId> {
    signal?.throwIfAborted()
    const root = this.rootOf(caller)
    if (name === 'lead') return root.id
    const entries = this.entries(root.session)
    const entry = entries.find(candidate => candidate.name === name)
    if (entry !== undefined) return entry.id
    if (name.startsWith('legacy:')) {
      const id = SessionId(name.slice('legacy:'.length))
      if (!entries.some(candidate => candidate.id === id)
        && (await listDescendants(this.ctx, root.id, signal)).some(candidate => candidate.id === id)) return id
    }
    throw new SubagentError(`agent name "${name}" was not found; use list_agents to discover available names`, 'AGENT_NAME_NOT_FOUND')
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

  /** Read the authoritative root projection without keeping a second name index. */
  private entries(root: Session): readonly SubagentNameData[] {
    const state = this.ctx.get('sessionProjections')?.stateOf(root, 'subagentNames')
    if (state === undefined) throw new SubagentError('agent names require the subagentNames projection', 'CONTINUATION_UNAVAILABLE')
    return state.entries
  }
}
