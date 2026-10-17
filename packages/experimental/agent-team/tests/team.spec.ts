import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import TeamService, { TeamError, TeamId, TeamTaskId } from '../src/index.ts'
import { TeamMembers } from '../src/membership.ts'
import { emptyTeamState, teamProjectionDefinition } from '../src/projection.ts'
import type { TeamProjectionState } from '../src/projection.ts'
import { TestSessionQuery } from './test-session-query.ts'

const SIGNAL = new AbortController().signal
const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Detached Team state folded through the same projection definition as the service. */
function durable(agent: Agent): TeamProjectionState {
  let projected = teamProjectionDefinition.init(agent.session.header, agent.session.inheritedEventCount)
  for (const event of agent.session.snapshotEvents()) projected = teamProjectionDefinition.apply(projected, event)
  if (projected.failure !== undefined) throw new Error(projected.failure)
  return projected
}

async function setup(
  script: ConstructorParameters<typeof MockAdapter>[0],
  config: ConstructorParameters<typeof TeamService>[1] = {},
) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  const teamFiber = await ctx.plugin(TeamService, config)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = await ctx.agentLoop.create(SessionId('team-root'), { provider: 'mock', model: 'mock' })
  return { ctx, lead, adapter, storageRoot, teamFiber }
}

function content(text: string) {
  return [{ type: 'text' as const, text }]
}

interface TeamServiceInternals {
  readonly journal: {
    state(root: Agent): unknown
  }
}

/** White-box access follows the runtime owners so coverage does not widen the service API. */
function teamInternals(ctx: Context): TeamServiceInternals {
  return ctx.agentTeams as unknown as TeamServiceInternals
}

/** Start one teammate: a continuable child of the Lead. */
async function spawn(ctx: Context, lead: Agent, description: string | undefined, provider = 'spawn'): Promise<SessionId> {
  const started = await ctx.subagents.startActivation({
    provider,
    label: `${description ?? 'shared'} responsibility`,
    request: { prompt: content(`${description ?? 'shared'} initial`), parent: lead },
    signal: SIGNAL,
    delivery: 'parent',
  })
  return started.childId
}

async function waitNoAgent(ctx: Context, id: SessionId): Promise<void> {
  await vi.waitFor(() => { expect(ctx.agents.get(id)).toBeUndefined() }, { timeout: 5_000 })
}

async function waitRunning(ctx: Context, id: SessionId): Promise<Agent> {
  return vi.waitFor(() => {
    const agent = ctx.agents.get(id)
    expect(agent?.status).toBe('running')
    return agent!
  }, { timeout: 5_000 })
}

describe('Team identity and membership', () => {
  it('rejects missing and failed authoritative Team projections', async () => {
    const first = await setup([])
    const journal = teamInternals(first.ctx).journal
    const stateOf = first.ctx.sessionProjections.stateOf.bind(first.ctx.sessionProjections)
    const stateOfSpy = vi.spyOn(first.ctx.sessionProjections, 'stateOf').mockImplementation((session, key) => (
      key === 'agentTeam' ? undefined : stateOf(session, key)
    ))
    expect(() => journal.state(first.lead)).toThrow('Agent Teams projection is not registered')
    stateOfSpy.mockImplementation((session, key) => key === 'agentTeam'
      ? { ...teamProjectionDefinition.init(session.header, SessionLogOffset(0)), failure: 'failed Team projection' }
      : stateOf(session, key))
    expect(() => journal.state(first.lead)).toThrow('failed Team projection')
    stateOfSpy.mockRestore()
  })

  it('propagates unavailable runtime errors while resolving membership', async () => {
    const { ctx, lead } = await setup([])
    const failure = new Error('runtime unavailable')
    vi.spyOn(ctx.subagents, 'rootOf').mockImplementation(() => { throw failure })
    expect(() => ctx.agentTeams.tryMembership(lead)).toThrow(failure)
  })

  it('rejects task limits that are not positive safe integers and removed configuration keys', async () => {
    for (const value of [0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(setup([], { maxTasks: value })).rejects.toThrow()
    }
    for (const key of ['maxMembers', 'maxMessageBytes', 'disposalTimeoutMs']) {
      await expect(setup([], { [key]: 1 })).rejects.toThrow(`${key} is no longer supported`)
    }
  })

  it('makes every root a Lead and every live subagent below it a teammate', async () => {
    const { ctx, lead } = await setup(['hang', 'hang', 'hang'])
    const named = await waitRunning(ctx, await spawn(ctx, lead, 'alpha'))
    const unnamed = await waitRunning(ctx, await spawn(ctx, lead, undefined))
    const grandchildId = (await ctx.subagents.startActivation({
      provider: 'spawn', label: 'nested', delivery: 'caller', signal: SIGNAL,
      request: { prompt: content('nested'), parent: named },
    })).childId
    const grandchild = await waitRunning(ctx, grandchildId)

    const describe = (agent: Agent) => {
      const { root, id, role } = ctx.agentTeams.membership(agent)
      return { root: root.id, id, role }
    }
    expect(describe(lead)).toEqual({ root: lead.id, id: TeamId(lead.id), role: 'lead' })
    expect(describe(named)).toEqual({ root: lead.id, id: TeamId(lead.id), role: 'teammate' })
    expect(describe(unnamed)).toEqual({ root: lead.id, id: TeamId(lead.id), role: 'teammate' })
    expect(describe(grandchild)).toEqual({ root: lead.id, id: TeamId(lead.id), role: 'teammate' })

    ctx.subagents.interrupt(named.id, { kind: 'ancestor', agent: lead })
    await waitNoAgent(ctx, named.id)
    expect(describe(grandchild)).toEqual({ root: lead.id, id: TeamId(lead.id), role: 'teammate' })
    const task = await ctx.agentTeams.createTask(grandchild, { subject: 'still active', description: 'creator offline' })
    expect(ctx.agentTeams.listTasks(lead).map(row => row.id)).toContain(task.id)

    const impostor = { ...lead } as Agent
    expect(ctx.agentTeams.tryMembership(impostor)).toBeUndefined()
    expect(() => ctx.agentTeams.membership(impostor)).toThrow(expect.objectContaining({ code: 'TEAM_NOT_MEMBER' }))

    for (const id of [grandchild.id, named.id, unnamed.id]) ctx.subagents.interrupt(id, { kind: 'ancestor', agent: lead })
    await Promise.all([waitNoAgent(ctx, grandchild.id), waitNoAgent(ctx, named.id), waitNoAgent(ctx, unnamed.id)])
  })

  it('treats an ordinary fork as a new Root Team and filters inherited Team state', async () => {
    const { ctx, lead } = await setup([textResponse('alpha done')])
    const alpha = await spawn(ctx, lead, 'alpha')
    await waitNoAgent(ctx, alpha)
    await ctx.agentTeams.createTask(lead, { subject: 'parent task', description: 'belongs to parent' })
    const handle = await ctx.agents.create({
      sessionId: SessionId('ordinary-fork'),
      seed: lead.session.snapshotEvents(),
      meta: { parentSession: lead.id, isSeeded: true },
      inheritedEventCount: SessionLogOffset(lead.session.seq),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    expect(ctx.agentTeams.membership(handle.agent)).toMatchObject({
      id: TeamId(handle.agent.id),
      role: 'lead',
    })
    expect(durable(handle.agent)).toMatchObject({ members: [], tasks: [] })
    const task = await ctx.agentTeams.createTask(handle.agent, { subject: 'fork task', description: 'independent' })
    await expect(ctx.agentTeams.updateTask(handle.agent, {
      taskId: task.id, expectedRevision: 1, action: 'reassign', owner: alpha,
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
    await handle.dispose()
  })

  it('resolves task assignees only by id, including historical members', async () => {
    const { ctx, lead } = await setup([])
    const members = new TeamMembers(ctx)
    lead.session.append('subagent/catalog', {
      version: 0, childId: SessionId('named-child'), childCreatedAt: 0, mode: 'continuable', label: 'reviewer',
    })
    lead.session.append('subagent/catalog', {
      version: 0, childId: SessionId('one-shot-child'), childCreatedAt: 0, mode: 'one-shot',
    })
    const state = {
      ...emptyTeamState(lead.id),
      members: [
        { id: SessionId('old-child'), name: 'legacy', description: 'd', provider: 'spawn', context: 'fresh' as const, phase: 'active' as const },
        { id: SessionId('failed-child'), name: 'broken', description: 'd', provider: 'spawn', context: 'fresh' as const, phase: 'failed' as const },
      ],
    }
    for (const id of [lead.id, SessionId('named-child'), SessionId('old-child')]) {
      expect(members.resolveMember(lead, state, id)).toBe(id)
    }
    for (const alias of ['lead', 'reviewer', 'legacy', 'broken', 'failed-child', 'one-shot-child']) {
      expect(() => members.resolveMember(lead, state, SessionId(alias))).toThrow(expect.objectContaining({ code: 'TEAM_MEMBER_NOT_FOUND' }))
    }
    vi.spyOn(ctx.sessionProjections, 'snapshot').mockReturnValue({ asOfSeq: -1, values: {} })
    expect(() => members.resolveMember(lead, state, SessionId('named-child')))
      .toThrow('Subagent catalog projection is not registered')
  })

  it('constructs with the default task limit and serializes concurrent task commits', async () => {
    const { ctx, lead, teamFiber } = await setup([])
    await teamFiber.dispose()
    const direct = new TeamService(ctx)
    const [first, second] = await Promise.all([
      direct.createTask(lead, { subject: 'one', description: 'one' }),
      direct.createTask(lead, { subject: 'two', description: 'two' }),
    ])
    expect([first.id, second.id]).toEqual([TeamTaskId('task-1'), TeamTaskId('task-2')])
  })

  it('does not treat a descriptor-backed Session without a parent as a Team member', async () => {
    const { ctx, lead } = await setup([])
    lead.session.append('subagent/descriptor', { version: 3, mode: 'continuable', provider: 'spawn', label: 'forged' })
    expect(ctx.agentTeams.tryMembership(lead)).toBeUndefined()
  })

  it('does not reinterpret an orphaned subagent child as a Team root', async () => {
    const { ctx } = await setup([textResponse('ordinary child done'), textResponse('orphan turn')])
    const parent = await ctx.agents.create({
      sessionId: SessionId('temporary-parent'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const child = await spawn(ctx, parent.agent, 'orphan')
    await waitNoAgent(ctx, child)
    await parent.dispose()
    const orphan = await ctx.agents.resume({
      resumeSessionId: child,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(ctx.agentTeams.tryMembership(orphan.agent)).toBeUndefined()
    orphan.agent.followup(createUserMessage({ content: content('run without a Team'), source: { kind: 'user' } }))
    await orphan.agent.whenIdle()
    await orphan.dispose()

    const rootWithOfflineSource = await ctx.agents.create({
      sessionId: SessionId('orphan-ordinary-root'),
      meta: { parentSession: SessionId('absent-parent') },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(ctx.agentTeams.membership(rootWithOfflineSource.agent)).toMatchObject({ role: 'lead' })
    await rootWithOfflineSource.dispose()
  })
})

describe('Team shared task DAG', () => {
  it('fails loudly when the durable numeric task id space is exhausted', async () => {
    const { ctx, lead } = await setup([])
    const id = TeamTaskId(`task-${Number.MAX_SAFE_INTEGER}`)
    lead.session.append('team/task', {
      version: 2,
      teamId: TeamId(lead.id),
      task: {
        id,
        revision: 1,
        subject: 'last numeric task',
        description: 'occupies the final safe numeric task id',
        status: 'pending',
        blockedBy: [],
        writeScopes: [],
      },
    })
    await ctx.sessions.flush(lead.session)

    await expect(ctx.agentTeams.createTask(lead, {
      subject: 'cannot allocate',
      description: 'no safe numeric task id remains',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_LIMIT' })
  })

  it('bounds non-deleted tasks while retaining deleted task ids as tombstones', async () => {
    const { ctx, lead } = await setup([], { maxTasks: 1 })
    const first = await ctx.agentTeams.createTask(lead, { subject: 'first', description: 'first task' })
    await expect(ctx.agentTeams.createTask(lead, { subject: 'overflow', description: 'overflow task' }))
      .rejects.toMatchObject({ code: 'TEAM_TASK_LIMIT' })

    const deleted = await ctx.agentTeams.updateTask(lead, {
      taskId: first.id,
      expectedRevision: first.revision,
      action: 'delete',
    })
    const second = await ctx.agentTeams.createTask(lead, { subject: 'second', description: 'second task' })
    expect(deleted.status).toBe('deleted')
    expect(second.id).toBe(TeamTaskId('task-2'))
    expect(ctx.agentTeams.getTask(lead, first.id).status).toBe('deleted')
    expect(ctx.agentTeams.listTasks(lead).map(task => task.id)).toEqual([second.id])
  })

  it('enforces CAS, ownership, dependencies, transitions, and write-scope warnings', async () => {
    const { ctx, lead } = await setup(['hang', 'hang', textResponse('beta integrated update')])
    const firstMember = await spawn(ctx, lead, 'alpha')
    const alpha = await waitRunning(ctx, firstMember)
    const secondMember = await spawn(ctx, lead, 'beta')
    const beta = await waitRunning(ctx, secondMember)

    const first = await ctx.agentTeams.createTask(alpha, {
      subject: 'first',
      description: 'first task',
      writeScopes: ['src', './src/', 'src'],
    })
    const second = await ctx.agentTeams.createTask(beta, {
      subject: 'second',
      description: 'second task',
      blockedBy: [first.id],
      writeScopes: ['src/feature'],
    })
    expect(first.writeScopes).toEqual(['src'])
    await expect(ctx.agentTeams.updateTask(beta, {
      taskId: second.id,
      expectedRevision: second.revision,
      action: 'claim',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_BLOCKED' })

    const claimed = await ctx.agentTeams.updateTask(alpha, {
      taskId: first.id,
      expectedRevision: first.revision,
      action: 'claim',
    })
    await expect(ctx.agentTeams.updateTask(beta, {
      taskId: first.id,
      expectedRevision: claimed.revision,
      action: 'claim',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_ALREADY_CLAIMED' })
    expect(ctx.agentTeams.getTask(beta, second.id)).toMatchObject({
      ready: false,
      writeScopeWarnings: [`write scopes overlap with ${first.id}`],
    })
    await expect(ctx.agentTeams.updateTask(beta, {
      taskId: first.id,
      expectedRevision: claimed.revision,
      action: 'edit',
      subject: 'stolen',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_UNAUTHORIZED' })
    await expect(ctx.agentTeams.updateTask(alpha, {
      taskId: first.id,
      expectedRevision: first.revision,
      action: 'complete',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_STALE_REVISION' })

    const completed = await ctx.agentTeams.updateTask(alpha, {
      taskId: first.id,
      expectedRevision: claimed.revision,
      action: 'complete',
    })
    expect(completed.status).toBe('completed')
    expect(ctx.agentTeams.getTask(beta, second.id).ready).toBe(true)
    const secondClaim = await ctx.agentTeams.updateTask(beta, {
      taskId: second.id,
      expectedRevision: second.revision,
      action: 'claim',
    })
    const released = await ctx.agentTeams.updateTask(beta, {
      taskId: second.id,
      expectedRevision: secondClaim.revision,
      action: 'release',
    })
    expect(released).toMatchObject({ status: 'pending', ready: true })
    expect('ownerId' in released).toBe(false)

    ctx.subagents.interrupt(alpha.id, { kind: 'ancestor', agent: lead })
    ctx.subagents.interrupt(beta.id, { kind: 'ancestor', agent: lead })
    await Promise.all([waitNoAgent(ctx, alpha.id), waitNoAgent(ctx, beta.id)])
  })

  it('rejects malformed scopes and every invalid dependency relation', async () => {
    const { ctx, lead } = await setup([])
    const first = await ctx.agentTeams.createTask(lead, { subject: 'one', description: 'one' })
    const second = await ctx.agentTeams.createTask(lead, {
      subject: 'two', description: 'two', blockedBy: [first.id],
    })
    await expect(ctx.agentTeams.createTask(lead, {
      subject: 'bad', description: 'bad', blockedBy: [TeamTaskId('missing')],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_NOT_FOUND' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: first.id,
      expectedRevision: first.revision,
      action: 'set_dependencies',
      blockedBy: [second.id],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_DEPENDENCY_CYCLE' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: first.id,
      expectedRevision: first.revision,
      action: 'set_dependencies',
      blockedBy: [first.id],
    })).rejects.toMatchObject({ code: 'TEAM_TASK_DEPENDENCY_CYCLE' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: first.id,
      expectedRevision: first.revision,
      action: 'set_dependencies',
      blockedBy: [second.id, second.id],
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    for (const scope of ['', '.', '..', '/root', 'C:\\root', 'C:root', 'a//b', 'a/../b']) {
      await expect(ctx.agentTeams.createTask(lead, {
        subject: 'scope', description: 'scope', writeScopes: [scope],
      })).rejects.toMatchObject({ code: 'TEAM_INVALID_WRITE_SCOPE' })
    }
  })

  it('rejects incomplete mutations, invalid transitions, and deletion of a live blocker', async () => {
    const { ctx, lead } = await setup([])
    await expect(ctx.agentTeams.createTask(lead, { subject: ' ', description: 'invalid' }))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(ctx.agentTeams.createTask(lead, { subject: 'invalid', description: '' }))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(ctx.agentTeams.createTask(lead, { subject: 'x'.repeat(201), description: 'too long' }))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    const blocker = await ctx.agentTeams.createTask(lead, { subject: 'blocker', description: 'blocker' })
    await ctx.agentTeams.createTask(lead, {
      subject: 'dependent', description: 'dependent', blockedBy: [blocker.id],
    })
    expect(() => ctx.agentTeams.getTask(lead, TeamTaskId('missing')))
      .toThrow(expect.objectContaining({ code: 'TEAM_TASK_NOT_FOUND' }))
    for (const action of ['release', 'complete', 'reopen'] as const) {
      await expect(ctx.agentTeams.updateTask(lead, {
        taskId: blocker.id,
        expectedRevision: blocker.revision,
        action,
      })).rejects.toMatchObject({ code: 'TEAM_TASK_INVALID_TRANSITION' })
    }
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: blocker.id,
      expectedRevision: blocker.revision,
      action: 'edit',
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: blocker.id,
      expectedRevision: blocker.revision,
      action: 'set_dependencies',
    })).rejects.toMatchObject({ code: 'TEAM_INVALID_ARGUMENT' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: blocker.id,
      expectedRevision: blocker.revision,
      action: 'delete',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_HAS_DEPENDENTS' })
  })

  it('supports Lead reassignment, completion, reopen, and deletion permissions', async () => {
    const { ctx, lead } = await setup(['hang'])
    const started = await spawn(ctx, lead, 'owner')
    const owner = await waitRunning(ctx, started)
    const task = await ctx.agentTeams.createTask(owner, { subject: 'lifecycle', description: 'lifecycle' })
    const assigned = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id,
      expectedRevision: task.revision,
      action: 'reassign',
      owner: owner.id,
    })
    await expect(ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: assigned.revision,
      action: 'reassign',
      owner: lead.id,
    })).rejects.toMatchObject({ code: 'TEAM_LEAD_REQUIRED' })
    const complete = await ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: assigned.revision,
      action: 'complete',
    })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: task.id,
      expectedRevision: complete.revision,
      action: 'reassign',
      owner: lead.id,
    })).rejects.toMatchObject({ code: 'TEAM_TASK_INVALID_TRANSITION' })
    const reopened = await ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: complete.revision,
      action: 'reopen',
    })
    const claimed = await ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: reopened.revision,
      action: 'claim',
    })
    const deleted = await ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: claimed.revision,
      action: 'delete',
    })
    expect(deleted.status).toBe('deleted')
    expect(ctx.agentTeams.listTasks(lead)).toEqual([])
    await expect(ctx.agentTeams.updateTask(owner, {
      taskId: task.id,
      expectedRevision: deleted.revision,
      action: 'edit',
      subject: 'late',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_DELETED' })
    ctx.subagents.interrupt(owner.id, { kind: 'ancestor', agent: lead })
    await waitNoAgent(ctx, owner.id)
  })

  it('covers partial edits, Lead ownership, unassignment, and blocked reassignment', async () => {
    const { ctx, lead } = await setup(['hang'])
    const started = await spawn(ctx, lead, 'editor')
    const editor = await waitRunning(ctx, started)
    const blocker = await ctx.agentTeams.createTask(lead, { subject: 'blocker', description: 'blocker' })
    const task = await ctx.agentTeams.createTask(lead, {
      subject: 'draft',
      description: 'draft description',
      blockedBy: [blocker.id],
    })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: TeamTaskId('missing-update'), expectedRevision: 1, action: 'delete',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_NOT_FOUND' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'reassign', owner: editor.id,
    })).rejects.toMatchObject({ code: 'TEAM_TASK_BLOCKED' })

    const leadClaim = await ctx.agentTeams.updateTask(lead, {
      taskId: blocker.id, expectedRevision: blocker.revision, action: 'claim',
    })
    expect(leadClaim.ownerId).toBe(lead.id)
    const completedBlocker = await ctx.agentTeams.updateTask(lead, {
      taskId: blocker.id, expectedRevision: leadClaim.revision, action: 'complete',
    })
    expect(completedBlocker.status).toBe('completed')
    const assigned = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'reassign', owner: editor.id,
    })
    const subject = await ctx.agentTeams.updateTask(editor, {
      taskId: task.id, expectedRevision: assigned.revision, action: 'edit', subject: 'edited subject',
    })
    const description = await ctx.agentTeams.updateTask(editor, {
      taskId: task.id,
      expectedRevision: subject.revision,
      action: 'edit',
      description: 'edited description',
    })
    const scopes = await ctx.agentTeams.updateTask(editor, {
      taskId: task.id,
      expectedRevision: description.revision,
      action: 'edit',
      writeScopes: ['src/nested'],
    })
    expect(scopes).toMatchObject({
      subject: 'edited subject',
      description: 'edited description',
      writeScopes: ['src/nested'],
    })
    const unassigned = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: scopes.revision, action: 'reassign',
    })
    expect(unassigned).toMatchObject({ status: 'pending' })
    expect('ownerId' in unassigned).toBe(false)

    const broad = await ctx.agentTeams.createTask(lead, {
      subject: 'broad scope', description: 'broad scope', writeScopes: ['src'],
    })
    const narrow = await ctx.agentTeams.createTask(lead, {
      subject: 'narrow scope', description: 'narrow scope', writeScopes: ['src/nested'],
    })
    const disjoint = await ctx.agentTeams.createTask(lead, {
      subject: 'disjoint scope', description: 'disjoint scope', writeScopes: ['docs'],
    })
    await ctx.agentTeams.updateTask(lead, {
      taskId: broad.id, expectedRevision: broad.revision, action: 'claim',
    })
    await ctx.agentTeams.updateTask(lead, {
      taskId: narrow.id, expectedRevision: narrow.revision, action: 'claim',
    })
    await ctx.agentTeams.updateTask(lead, {
      taskId: disjoint.id, expectedRevision: disjoint.revision, action: 'claim',
    })
    expect(ctx.agentTeams.getTask(lead, broad.id).writeScopeWarnings)
      .toEqual([`write scopes overlap with ${narrow.id}`])

    ctx.subagents.interrupt(editor.id, { kind: 'ancestor', agent: lead })
    await waitNoAgent(ctx, editor.id)
  })
})


describe('Team waiting', () => {
  it('waits for one change, supports cancellation, times out, and releases waiters on HMR disposal', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await mountWorkingDirectoryFixture(ctx)
    const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-team-wait-'))
    roots.push(storageRoot)
    await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentService)
    const fiber = await ctx.plugin(TeamService)
    const service = ctx.agentTeams
    const lead = await ctx.agentLoop.create(SessionId('wait-lead'), {})

    await expect(service.waitForChange(lead, 9_999, SIGNAL))
      .rejects.toMatchObject({ code: 'TEAM_INVALID_TIMEOUT' })
    const alreadyAborted = new AbortController()
    alreadyAborted.abort(new TeamError('cancelled before wait', 'TEST_CANCELLED'))
    await expect(service.waitForChange(lead, 10_000, alreadyAborted.signal))
      .rejects.toMatchObject({ code: 'TEST_CANCELLED' })

    const changed = service.waitForChange(lead, 10_000, SIGNAL)
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    const flushEntered = Promise.withResolvers<undefined>()
    const releaseFlush = Promise.withResolvers<undefined>()
    vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      flushEntered.resolve(undefined)
      await releaseFlush.promise
      return await flush(session)
    })
    let waitSettled = false
    void changed.finally(() => { waitSettled = true })
    const creating = service.createTask(lead, { subject: 'wake', description: 'wake waiter' })
    await flushEntered.promise
    expect(waitSettled).toBe(false)
    releaseFlush.resolve(undefined)
    await creating
    await expect(changed).resolves.toEqual({ timedOut: false })

    const controller = new AbortController()
    const cancelled = service.waitForChange(lead, 10_000, controller.signal)
    controller.abort(new TeamError('cancelled', 'TEST_CANCELLED'))
    await expect(cancelled).rejects.toMatchObject({ code: 'TEST_CANCELLED' })

    const stringAbort = new AbortController()
    const firstWaiter = service.waitForChange(lead, 10_000, stringAbort.signal)
    const secondWaiter = service.waitForChange(lead, 10_000, SIGNAL)
    stringAbort.abort('string cancellation')
    await expect(firstWaiter).rejects.toMatchObject({
      code: 'TEAM_WAIT_ABORTED',
      message: 'wait_agent aborted: string cancellation',
    })
    await service.createTask(lead, { subject: 'second waiter', description: 'second waiter remains registered' })
    await expect(secondWaiter).resolves.toEqual({ timedOut: false })

    const objectAbort = new AbortController()
    const objectCancelled = service.waitForChange(lead, 10_000, objectAbort.signal)
    objectAbort.abort({ kind: 'user' })
    await expect(objectCancelled).rejects.toMatchObject({
      code: 'TEAM_WAIT_ABORTED',
      message: "wait_agent aborted: { kind: 'user' }",
    })

    await service.createTask(lead, { subject: 'already changed', description: 'edge-triggered wait' })
    vi.useFakeTimers()
    const timeout = service.waitForChange(lead, 10_000, SIGNAL)
    await vi.advanceTimersByTimeAsync(10_000)
    await expect(timeout).resolves.toEqual({ timedOut: true })
    vi.useRealTimers()

    const disposed = service.waitForChange(lead, 10_000, SIGNAL)
    await fiber.dispose()
    await expect(disposed).resolves.toEqual({ timedOut: false })
    expect(ctx.get('agentTeams')).toBeUndefined()
  })

  it('wakes waiters on member status changes and accepted messages, and reports active peers', async () => {
    const { ctx, lead } = await setup(['hang'])
    expect(ctx.agentTeams.hasActivePeer(lead)).toBe(false)
    const alphaId = await spawn(ctx, lead, 'alpha')
    const alpha = await waitRunning(ctx, alphaId)
    expect(ctx.agentTeams.hasActivePeer(lead)).toBe(true)
    expect(ctx.agentTeams.hasActivePeer(alpha)).toBe(false)

    const messaged = ctx.agentTeams.waitForChange(lead, 10_000, SIGNAL)
    alpha.steer(createUserMessage({ content: content('extra context'), source: { kind: 'user' } }))
    await expect(messaged).resolves.toEqual({ timedOut: false })

    const statusChanged = ctx.agentTeams.waitForChange(lead, 10_000, SIGNAL)
    ctx.subagents.interrupt(alpha.id, { kind: 'ancestor', agent: lead })
    await expect(statusChanged).resolves.toEqual({ timedOut: false })
  })

  it('releases waits on unload and leaves teammate Activations to the subagent runtime', async () => {
    const { ctx, lead, teamFiber } = await setup(['hang'])
    const alpha = await waitRunning(ctx, await spawn(ctx, lead, 'alpha'))
    const waiting = ctx.agentTeams.waitForChange(lead, 10_000, SIGNAL)

    await teamFiber.dispose()

    await expect(waiting).resolves.toEqual({ timedOut: false })
    expect(ctx.agents.get(alpha.id)).toBe(alpha)
    expect(ctx.get('agentTeams')).toBeUndefined()
    ctx.subagents.interrupt(alpha.id, { kind: 'ancestor', agent: lead })
    await waitNoAgent(ctx, alpha.id)
  })
})
