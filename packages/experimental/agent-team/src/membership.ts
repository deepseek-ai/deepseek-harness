/** Team membership derived from live subagent lineage and durable Session ids. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-subagent'
import { TeamError } from './error.ts'
import type { TeamState } from './projection.ts'
import { TeamId } from './types.ts'

/** Caller identity inside one implicit Team. */
export interface TeamMembership {
  /** Exact live Lead: the root of the caller's live subagent lineage. */
  readonly root: Agent
  readonly id: TeamId
  readonly role: 'lead' | 'teammate'
}

/** Resolves Team membership from the live Agent registry. */
export class TeamMembers {
  /**
   * @param ctx - Team service context with Agent and projection services.
   */
  constructor(
    private readonly ctx: Context,
  ) {}

  /**
   * Resolve a task assignee from direct catalog facts or a durable descendant chain.
   * Every descendant edge requires a continuable child descriptor and its parent's
   * own catalog entry; ordinary forks and unrelated Teams are excluded.
   * @param root - exact live Team Lead.
   * @param state - current Lead-owned Team state.
   * @param target - member Session id, including an inactive descendant.
   * @returns the member's durable id.
   */
  async resolveMember(root: Agent, state: TeamState, target: SessionId): Promise<SessionId> {
    if (target === root.id || state.children.some(child => child.id === target)
      || state.members.some(member => member.phase === 'active' && member.id === target)) return target
    const missing = (): TeamError => new TeamError(`teammate "${target}" not found`, 'TEAM_MEMBER_NOT_FOUND')
    const observe = async (id: SessionId) => {
      try {
        return await this.ctx.sessionQuery.observeSession(id)
      } catch (error) {
        if (error instanceof SessionQueryError && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') throw missing()
        throw error
      }
    }
    const seen = new Set<SessionId>()
    let current = target
    while (!seen.has(current)) {
      seen.add(current)
      using child = await observe(current)
      const identity = child.projections?.values.subagent
      const parentId = child.header.parentSession
      if (identity?.mode !== 'continuable' || identity.seq < child.inheritedEventCount || parentId === undefined) throw missing()
      using parent = await observe(parentId)
      if (!parent.projections?.values.subagentCatalog?.some(entry => entry.id === current && entry.mode === 'continuable')) throw missing()
      if (parentId === root.id) return target
      current = parentId
    }
    throw missing()
  }

  /**
   * Resolve one exact live Agent's Team role.
   * @param agent - exact live Agent used as the authority credential.
   * @returns its Lead, Team identity, and role.
   */
  membership(agent: Agent): TeamMembership {
    const membership = this.tryMembership(agent)
    if (membership === undefined) {
      throw new TeamError(`agent "${agent.id}" is not a member of an active Agent Team`, 'TEAM_NOT_MEMBER')
    }
    return membership
  }

  /**
   * Resolve a caller without throwing for scoped installation and lifecycle observers.
   * Every root Agent leads its own Team; every subagent below it, at any
   * depth, is a teammate of that root while its lineage remains live.
   * @param agent - candidate exact live Agent.
   * @returns Team membership, or undefined for stale identities and children whose parent left the registry.
   */
  tryMembership(agent: Agent): TeamMembership | undefined {
    if (this.ctx.agents.get(agent.id) !== agent) return undefined
    let root = agent
    const seen = new Set<SessionId>()
    while (this.isSubagent(root)) {
      seen.add(root.id)
      const parentId = root.session.header.parentSession
      const parent = parentId === undefined ? undefined : this.ctx.agents.get(parentId)
      // A continuation can briefly outlive its parent during child-first teardown;
      // do not reinterpret that durable child as a new implicit root Team.
      if (parent === undefined || seen.has(parent.id)) return undefined
      root = parent
    }
    if (root === agent) return { root, id: TeamId(root.id), role: 'lead' }
    return { root, id: TeamId(root.id), role: 'teammate' }
  }

  /**
   * Whether another live member of the caller's Team is currently running a turn.
   * @param caller - exact live Team member.
   * @returns whether a peer can still produce a Team change.
   */
  hasActivePeer(caller: Agent): boolean {
    const { id } = this.membership(caller)
    return this.ctx.agents.list().some(agent => agent !== caller
      && agent.status === 'running'
      && this.tryMembership(agent)?.id === id)
  }

  /** Whether a Session's own log identifies it as a subagent child. */
  private isSubagent(agent: Agent): boolean {
    const identity = this.ctx.sessionProjections.stateOf(agent.session, 'subagent')?.identity
    return identity !== undefined && agent.session.isOwnSeq(identity.seq)
  }
}
