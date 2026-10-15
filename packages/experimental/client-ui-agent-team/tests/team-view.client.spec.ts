import { describe, expect, it } from 'vitest'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { TeamMemberProjection, TeamProjection } from '@deepseek-ai/dsh-experimental-agent-team/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { sameTeamView, teamView } from '../src/client/team-view.ts'

const ROOT = SessionId('root')
const CHILD = SessionId('child')
const GRANDCHILD = SessionId('grandchild')
const row = (id: SessionId): TeamMemberProjection => ({ id, description: 'review', role: 'teammate', phase: 'active' })

function state(views: Record<SessionId, TeamProjection>): SessionListState {
  return {
    ids: [], byId: {}, phase: 'ready',
    projectionsBySession: Object.fromEntries(Object.entries(views).map(([id, agentTeam]) => [
      id, { state: 'ready' as const, error: null, values: { agentTeam } },
    ])),
  }
}

describe('Team display across Session projections', () => {
  it('keeps repeated descriptions, deduplicates ids, and takes tasks only from the Lead', () => {
    const root: TeamProjection = { members: [{ ...row(ROOT), role: 'lead' }, row(CHILD)], tasks: [] }
    const child: TeamProjection = { members: [{ ...row(CHILD), role: 'lead' }, row(GRANDCHILD)], tasks: [] }
    const cycle: TeamProjection = { members: [{ ...row(GRANDCHILD), role: 'lead' }, row(ROOT), row(CHILD)], tasks: [] }
    const combined = teamView(state({ [ROOT]: root, [CHILD]: child, [GRANDCHILD]: cycle }), ROOT)!
    expect(combined.members.map(member => member.id)).toEqual([ROOT, CHILD, GRANDCHILD])
    expect(combined.tasks).toBe(root.tasks)
  })

  it('retains known members when a descendant projection has not arrived', () => {
    const root: TeamProjection = { members: [row(CHILD)], tasks: [] }
    const catalog = state({ [ROOT]: root })
    expect(teamView(catalog, undefined)).toBeUndefined()
    expect(teamView(catalog, CHILD)).toBeUndefined()
    expect(teamView(catalog, ROOT)?.members).toEqual(root.members)
  })

  it('surfaces descendant replay failures and does not traverse failed roster entries', () => {
    const root: TeamProjection = { members: [row(CHILD)], tasks: [] }
    const child: TeamProjection = { members: [row(GRANDCHILD)], tasks: [], failure: 'invalid child log' }
    const catalog = state({ [ROOT]: root, [CHILD]: child })
    expect(teamView(catalog, ROOT)?.failure).toBe('invalid child log')
    const failed = { ...root, members: [{ ...row(CHILD), phase: 'failed' as const }], failure: 'invalid root log' }
    expect(teamView(state({ [ROOT]: failed, [CHILD]: child }), ROOT)).toEqual(failed)
  })

  it('ignores unrelated updates while detecting every displayed Team change', () => {
    const root: TeamProjection = { members: [row(CHILD)], tasks: [] }
    expect(sameTeamView(undefined, undefined)).toBe(true)
    expect(sameTeamView(undefined, root)).toBe(false)
    expect(sameTeamView(root, undefined)).toBe(false)
    expect(sameTeamView(root, { ...root, members: [...root.members] })).toBe(true)
    expect(sameTeamView(root, { ...root, tasks: [] })).toBe(false)
    expect(sameTeamView(root, { ...root, failure: 'failed' })).toBe(false)
    expect(sameTeamView(root, { ...root, members: [] })).toBe(false)
    expect(sameTeamView(root, { ...root, members: [row(GRANDCHILD)] })).toBe(false)
  })
})
