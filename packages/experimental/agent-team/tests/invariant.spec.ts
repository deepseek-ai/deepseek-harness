import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantService, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as TeamInvariant from '../src/invariant.ts'
import { teamProjectionDefinition } from '../src/projection.ts'
import { TeamId, TeamTaskId } from '../src/types.ts'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(teamProjectionDefinition)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(TeamInvariant)
  return ctx
}

describe('Agent Teams stream invariant', () => {
  it('accepts provisioning and rejects a terminal member as the first edge', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('team-invariant'))
    const member = {
      id: SessionId('team-invariant-child'),
      name: 'worker',
      description: 'worker responsibility',
      provider: 'spawn',
      context: 'fresh' as const,
      phase: 'provisioning' as const,
    }
    expect(() => {
      session.append('team/member', { version: 1, teamId: TeamId(session.id), member })
    }).not.toThrow()

    const invalid = ctx.sessions.create(SessionId('team-invariant-invalid'))
    expect(() => {
      invalid.append('team/member', {
        version: 1,
        teamId: TeamId(invalid.id),
        member: { ...member, phase: 'active' },
      })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-experimental-agent-team',
    }))
    expect(invalid.snapshotEvents()).toEqual([])
  })

  it('rejects an invalid task dependency before publication', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('team-task-invariant'))

    expect(() => {
      session.append('team/task', {
        version: 1,
        teamId: TeamId(session.id),
        task: {
          id: TeamTaskId('task-1'),
          revision: 1,
          subject: 'invalid dependency',
          description: 'references a missing blocker',
          status: 'pending',
          blockedBy: [TeamTaskId('missing')],
          writeScopes: [],
        },
      })
    }).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-experimental-agent-team',
    }))
    expect(session.snapshotEvents()).toEqual([])
  })
})
