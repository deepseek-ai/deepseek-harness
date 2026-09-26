/**
 * The controller's admission gate for archived Sessions: an archived
 * Session, or a subagent descendant of one, must not run a model step until
 * it is restored. The work a Session still runs is reported and stopped by
 * its owners — the Agent registry (`turn`), the job registry seam (`job`),
 * the Subagent runtime (`subagent`), and the Schedule plugin (`schedule`) —
 * through the Workspace registry's archive-admission events.
 */

import type { Context, Plugin } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'

/**
 * The gate as a plugin for `ctx.plugin(...)`: it loads once the Agent
 * registry, Session store, and Workspace registry are available and unwinds
 * with the plugin's fiber. A late waking delivery to an archived Session — a
 * subagent settlement, a queued follow-up — proposes a step the gate rejects,
 * which the loop ends as `blocked` without a request; unarchiving lifts the
 * gate for the whole lineage.
 */
export const ArchivedSessionGate: Plugin.Object<void> = {
  name: 'archived-session-gate',
  inject: ['agents', 'sessions', 'workspaceRegistry'],
  apply(ctx: Context): void {
    ctx.on('agent/pre-step', (payload, next) =>
      underArchivedSession(ctx, payload.agent)
        ? Promise.resolve({ kind: 'reject' as const })
        : next())
  },
}

/**
 * Whether the Agent's Session, or a Session above it in its subagent lineage,
 * is archived. Lineage follows the durable header fields through
 * subagent-origin Sessions only: a fork of an archived Session is an
 * independent conversation.
 * @param ctx - Host context.
 * @param agent - the Agent proposing a step.
 * @returns whether an archived Session owns the step.
 */
export function underArchivedSession(ctx: Context, agent: Agent): boolean {
  const archived = ctx.workspaceRegistry.archivedSessionIds
  let header = agent.session.header
  const visited = new Set<SessionId>()
  while (!visited.has(header.id)) {
    if (archived.includes(header.id)) return true
    visited.add(header.id)
    if (header.origin !== 'subagent' || header.parentSession === undefined) return false
    const parent = ctx.sessions.get(header.parentSession)
    if (parent === undefined) return archived.includes(header.parentSession)
    header = parent.header
  }
  return false
}
