/**
 * The `subagent` family of the Workspace registry's archive admission: which
 * subagent descendants of a Session are still inside a turn, and how they
 * stop when the Session is archived with its work.
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
 * as their parent would. Both listeners live as long as `ctx`'s fiber.
 * @param ctx - context carrying the Agent registry; the Session query service is optional and only supplies labels.
 */
export function installSubagentArchiveAdmission(ctx: Context): void {
  ctx.on('workspace/session-activity', async ({ sessionId }, next) => {
    const running = runningDescendants(ctx, sessionId)
    const rest = await next()
    if (running.length === 0) return rest
    const own: SessionActivity = { kind: 'subagent', items: await Promise.all(running.map(child => describe(ctx, child))) }
    return [own, ...rest]
  })
  ctx.on('workspace/session-stop', ({ sessionId }) => {
    for (const child of runningDescendants(ctx, sessionId)) {
      try {
        child.cancel({ kind: 'parent' })
      } catch (error: unknown) {
        // One child refusing its cancel must not keep its siblings running for an archived parent.
        ctx.logger.warn(`subagent: cancelling "${child.id}" for an archived Session failed: ${String(error)}`)
      }
    }
  })
}

/**
 * Live subagent descendants inside a turn, by durable lineage: a child whose
 * header names its parent and carries the subagent origin this package
 * records, at any depth. A fork shares the lineage field without the origin
 * and is an independent conversation, so it never holds its source. Lineage
 * is read as data, so a damaged header chain that loops is visited once.
 */
function runningDescendants(ctx: Context, rootId: SessionId): Agent[] {
  const childrenOf = new Map<SessionId, Agent[]>()
  for (const agent of ctx.agents.list()) {
    const { parentSession, origin } = agent.session.header
    if (parentSession === undefined || origin !== 'subagent') continue
    const siblings = childrenOf.get(parentSession) ?? []
    siblings.push(agent)
    childrenOf.set(parentSession, siblings)
  }
  const running: Agent[] = []
  const pending = [rootId]
  const visited = new Set<SessionId>()
  while (pending.length > 0) {
    const parentId = pending.shift() as SessionId
    if (visited.has(parentId)) continue
    visited.add(parentId)
    for (const child of childrenOf.get(parentId) ?? []) {
      if (child.status === 'running') running.push(child)
      pending.push(child.id)
    }
  }
  return running
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
