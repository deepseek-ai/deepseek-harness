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
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type { SessionActivity, SessionActivityItem } from '@deepseek-ai/dsh-workspace'
import { foldSubagentDescriptor } from './descriptor.ts'

/**
 * Answer `workspace/session-activity` with the running subagent descendants of
 * the asked Session, and `workspace/session-stop` by cancelling each of them
 * as their parent would. Reject subsequent steps beneath archived ancestors.
 * All listeners live as long as `ctx`'s fiber.
 * @param ctx - context carrying the Agent registry; the Session query service is optional and only supplies labels.
 * @param residentAncestors - verified creation ancestors for an exact managed Agent, absent before publication or for unmanaged Agents.
 */
export function installSubagentArchiveAdmission(
  ctx: Context,
  residentAncestors: (agent: Agent) => readonly SessionId[] | undefined,
): void {
  const ancestorsOf = (agent: Agent): readonly SessionId[] => residentAncestors(agent) ?? headerAncestors(ctx, agent)
  const runningDescendants = (sessionId: SessionId): Agent[] => ctx.agents.list()
    .filter(agent => agent.status === 'running' && ancestorsOf(agent).includes(sessionId))
  ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
    const running = runningDescendants(sessionId)
    const rest = await next()
    if (running.length === 0) return rest
    const own: SessionActivity = { kind: 'subagent', items: await Promise.all(running.map(child => describe(ctx, child))) }
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
 * The child's activity item: its id, plus the durable creation label its
 * descriptor carries, read through a live Session observation. Without the
 * Session query service, or with a descriptor that is absent or unreadable,
 * the item names the child by id alone.
 */
async function describe(ctx: Context, child: Agent): Promise<SessionActivityItem> {
  const query = ctx.get('sessionQuery')
  if (query === undefined) return { id: child.id }
  try {
    using observation = await query.observeSession(child.id, { projectionMode: 'none' })
    const label = foldSubagentDescriptor(observation.events.slice(observation.inheritedEventCount))?.label
    return label === undefined ? { id: child.id } : { id: child.id, label }
  } catch {
    // A damaged descriptor is data damage in the child; the report still names the child.
    return { id: child.id }
  }
}
