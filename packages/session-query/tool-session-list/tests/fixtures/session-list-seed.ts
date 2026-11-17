/** Deterministic Session and Workspace inputs for the shipped headless list tools. */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry, { WorkspaceId, workspaceDomainSpec } from '@deepseek-ai/dsh-workspace'

/** Loader fixture identity. */
export const name = 'session-list-seed'
/** Real services used to prepare the scenario's durable registry and attached Sessions. */
export const inject = ['sessions', 'sessionPersistence', 'storageDomain']

/**
 * Seed stable list inputs before the Workspace registry becomes available.
 * These attached Sessions have no Agent, so the agent-loop persistence owner never publishes them.
 * @param ctx - fixture lifetime and the shipped storage and Session services.
 * @returns when the actual Workspace registry has opened the seeded domain.
 */
export async function apply(ctx: Context): Promise<void> {
  const cwd = process.cwd()
  const emptyPath = join(cwd, '.dsh', 'empty-workspace')
  await mkdir(emptyPath, { recursive: true })
  const alpha = ctx.sessions.create(SessionId('list-alpha'), { meta: { cwd, createdAt: 1_000 } })
  alpha.append('session/title', { title: 'Alpha', messageSeqs: [], source: { kind: 'user' } })
  ctx.sessions.create(SessionId('list-beta'), { meta: { cwd, createdAt: 2_000 } })
  ctx.sessions.create(SessionId('list-archived'), { meta: { cwd, createdAt: 3_000 } })
  ctx.sessions.create(SessionId('list-child'), {
    meta: { cwd, createdAt: 4_000, parentSession: alpha.id, origin: 'subagent', delegationDepth: 1 },
  })
  // Matching cwd alone does not make this Session a member of the stored Workspace.
  ctx.sessions.create(SessionId('list-unaffiliated'), { meta: { cwd, createdAt: 5_000 } })

  const workspaceId = WorkspaceId('list-workspace')
  const emptyId = WorkspaceId('list-empty')
  const domain = await ctx.storageDomain.open(workspaceDomainSpec)
  try {
    const table = domain.table('workspaces')
    await table.put(workspaceId, {
      path: cwd,
      title: 'List fixture',
      sessionIds: [alpha.id, SessionId('list-beta'), SessionId('list-archived')],
      createdAt: '2000-01-01T00:00:00.000Z',
      updatedAt: '2000-01-02T00:00:00.000Z',
    })
    await table.put(emptyId, {
      path: emptyPath,
      title: 'Empty workspace',
      sessionIds: [],
      createdAt: '2000-01-03T00:00:00.000Z',
      updatedAt: '2000-01-04T00:00:00.000Z',
    })
    await domain.global.set({
      initialized: true,
      workspaceIds: [workspaceId, emptyId],
      archivedSessionIds: [SessionId('list-archived')],
      pinnedSessionIds: [],
    })
  } finally {
    await domain.close()
  }
  await ctx.plugin(WorkspaceRegistry)
}
