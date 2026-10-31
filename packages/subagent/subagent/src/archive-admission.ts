/**
 * The `subagent` family of the Workspace registry's archive admission: which
 * subagent descendants of a Session are still inside a turn, and how they
 * stop when the Session is archived with its work. Archived ancestors also
 * block later model steps, including when their Sessions have been released.
 *
 * @module @deepseek-ai/dsh-subagent
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionActivity, SessionActivityItem } from '@deepseek-ai/dsh-workspace'
import type { SubagentIdentityProjection } from './projection-types.ts'

/**
 * Answer `workspace/session-activity` with the running subagent descendants of
 * the asked Session, and `workspace/session-stop` by cancelling each of them
 * as their parent would. Reject subsequent steps beneath archived ancestors.
 * All listeners live as long as `ctx`'s fiber.
 * @param ctx - context carrying the Agent registry.
 * @param residentAncestors - verified creation ancestors for an exact managed Agent, absent before publication or for unmanaged Agents.
 * @param identityOf - ready service-owned descriptor identity reader; absent or invalid descriptors yield no identity.
 */
export function installSubagentArchiveAdmission(
  ctx: Context,
  residentAncestors: (agent: Agent) => readonly SessionId[] | undefined,
  identityOf: (session: Session) => SubagentIdentityProjection | undefined,
): void {
  const ancestorsOf = (agent: Agent): readonly SessionId[] => residentAncestors(agent) ?? headerAncestors(ctx, agent)
  const runningDescendants = (sessionId: SessionId): Agent[] => ctx.agents.list()
    .filter(agent => agent.status === 'running' && ancestorsOf(agent).includes(sessionId))
  ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
    const running = runningDescendants(sessionId)
    const rest = await next()
    if (running.length === 0) return rest
    const own: SessionActivity = { kind: 'subagent', items: running.map(child => describe(child, identityOf(child.session))) }
    return [own, ...rest]
  })
  ctx.on('workspace/session-stop', ({ sessionId }) => {
    for (const child of runningDescendants(sessionId)) {
      try {
        child.cancel({ kind: 'parent' })
      } catch (error: unknown) {
        // One child refusing its cancel must not keep its siblings running for an archived parent.
        ctx.logger.warn(`subagent: cancelling "${child.id}" for an archived Session failed: ${String(error)}`)
      }
    }
  })
  ctx.on('agent/pre-step', ({ agent }, next) => {
    const archived = ctx.get('workspaceRegistry')?.archivedSessionIds
    return archived !== undefined && ancestorsOf(agent).some(id => archived.includes(id))
      ? Promise.resolve({ kind: 'reject' as const })
      : next()
  })
}

/**
 * Header-only ancestry for Agents without a published Activation. Include an
 * offline direct creator; ordinary forks stop the chain and cycles terminate.
 */
function headerAncestors(ctx: Context, agent: Agent): readonly SessionId[] {
  const ancestors: SessionId[] = []
  const visited = new Set<SessionId>([agent.id])
  let header = agent.session.header
  while (header.origin === 'subagent' && header.parentSession !== undefined && !visited.has(header.parentSession)) {
    const parentId = header.parentSession
    ancestors.push(parentId)
    visited.add(parentId)
    const parent = ctx.agents.get(parentId)?.session
    if (parent === undefined) break
    header = parent.header
  }
  return ancestors
}

/**
 * Report the child's current projected label only when its descriptor belongs
 * to the child's own log; inherited, absent, or invalid identities yield the id alone.
 */
function describe(child: Agent, identity: SubagentIdentityProjection | undefined): SessionActivityItem {
  const label = identity !== undefined && child.session.isOwnSeq(identity.seq) ? identity.label : undefined
  return label === undefined ? { id: child.id } : { id: child.id, label }
}
