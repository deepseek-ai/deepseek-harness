/** Team membership derived from live subagent lineage and durable Session ids. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
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

/**
 * Resolve one member Session id for task assignment.
 * @param root - exact live Team Lead.
 * @param state - current Team state.
 * @param target - member Session id.
 * @returns the member's durable id.
 */
export function resolveMember(root: Agent, state: TeamState, target: SessionId): SessionId {
  if (target === root.id) return root.id
  const child = state.children.find(candidate => candidate.id === target)
  if (child !== undefined) return child.id
  const member = state.members.find(candidate => candidate.phase === 'active'
    && candidate.id === target)
  if (member === undefined) throw new TeamError(`teammate "${target}" not found`, 'TEAM_MEMBER_NOT_FOUND')
  return member.id
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
