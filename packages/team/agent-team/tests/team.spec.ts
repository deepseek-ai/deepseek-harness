import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionLogOffset, type SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Commands from '@deepseek-ai/dsh-commands'
import SubagentService, { type SubagentActivation } from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { bindSubagentActivation } from '../../../subagent/subagent/tests/manager-internals.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import TeamService from '../src/index.ts'
import type { TeamId, TeamTaskId } from '../src/types.ts'
import { teamProjectionDefinition } from '../src/projection.ts'
import type { TeamProjectionState } from '../src/projection.ts'
import { TestSessionQuery } from './test-session-query.ts'

const SIGNAL = new AbortController().signal
const roots: string[] = []
const contexts: Context[] = []

/** Resident idle recipients exercise delivery without scheduling model work. */
async function resident(ctx: Context, root: Agent, id: string): Promise<Agent> {
  return (await ctx.agents.create({
    sessionId: brandString<SessionId>(id), agentOptions: { provider: 'mock', model: 'mock' },
    meta: { origin: 'subagent', parentSession: root.id },
    setup: (_ctx, agent) => { bindSubagentActivation(ctx, agent, root) },
  })).agent
}

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
  enabled = true,
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
  const lead = await ctx.agentLoop.create(brandString<SessionId>('team-root'), { provider: 'mock', model: 'mock' })
  if (enabled) await ctx.agentTeams.setEnabled(lead, true)
  return { ctx, lead, adapter, storageRoot, teamFiber }
}

function content(text: string) {
  return [{ type: 'text' as const, text }]
}

/** Start one teammate: a continuable child of the Lead. */
async function spawn(ctx: Context, lead: Agent, description: string | undefined, provider = 'spawn'): Promise<SubagentActivation> {
  const started = await ctx.subagents.startActivation({
    provider,
    label: `${description ?? 'shared'} responsibility`,
    prompt: content(`${description ?? 'shared'} initial`), parent: lead,
    signal: SIGNAL,
    delivery: 'parent',
  })
  return started
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

describe('Tree-owned task boards', () => {
  it.each(['spawn', 'fork'])('shares the configured root mode with real %s children', async (provider) => {
    const { ctx, lead } = await setup(['hang', 'hang'], { defaultEnabled: true }, false)
    expect(durable(lead).enabled).toBe(true)
    const task = await ctx.agentTeams.createTask(lead, { subject: 'configured', description: 'shared board' })
    const started = await spawn(ctx, lead, 'configured child', provider)
    const child = await waitRunning(ctx, started.childId)
    expect(ctx.agentTeams.isEnabled(child)).toBe(true)
    expect(ctx.agentTeams.listTasks(child)).toEqual([task])
    expect(child.session.ownEvents().filter(event => event.type === 'team/mode')).toEqual([])
    await ctx.agentTeams.setEnabled(lead, false)
    expect(ctx.agentTeams.isEnabled(child)).toBe(false)
    const later = await spawn(ctx, lead, 'disabled child', provider)
    const laterChild = await waitRunning(ctx, later.childId)
    expect(ctx.agentTeams.isEnabled(laterChild)).toBe(false)
    await later.dispose()
    await started.dispose()
  })

  it.each([undefined, false])('leaves new roots off with defaultEnabled=%s', async (defaultEnabled) => {
    const { lead } = await setup([], defaultEnabled === undefined ? {} : { defaultEnabled }, false)
    expect(durable(lead).enabled).toBeUndefined()
    expect(lead.session.ownEvents().filter(event => event.type === 'team/mode')).toEqual([])
  })

  it.each([false, true])('preserves a selection saved during setup: %s', async (enabled) => {
    const { ctx } = await setup([], { defaultEnabled: true }, false)
    const handle = await ctx.agents.create({
      sessionId: brandString<SessionId>('selected-root'),
      setup: (_ctx, agent) => { agent.session.append('team/mode', { enabled }) },
    })
    expect(durable(handle.agent).enabled).toBe(enabled)
    expect(handle.agent.session.ownEvents().filter(event => event.type === 'team/mode')).toHaveLength(1)
    await handle.dispose()
  })

  it('initializes an ordinary fork independently of its inherited mode and tasks', async () => {
    const { ctx, lead } = await setup([], { defaultEnabled: true }, false)
    await ctx.agentTeams.createTask(lead, { subject: 'source', description: 'belongs to source' })
    await ctx.agentTeams.setEnabled(lead, false)
    const handle = await ctx.agents.create({
      sessionId: brandString<SessionId>('configured-fork'),
      seed: lead.session.snapshotEvents(),
      meta: { parentSession: lead.id, isSeeded: true },
      inheritedEventCount: SessionLogOffset(lead.session.seq),
    })
    expect(ctx.agentTeams.isEnabled(handle.agent)).toBe(true)
    expect(ctx.agentTeams.listTasks(handle.agent)).toEqual([])
    expect(handle.agent.session.ownEvents().filter(event => event.type === 'team/mode')).toHaveLength(1)
    await handle.dispose()
  })

  it('unregisters default initialization when the Team service unloads', async () => {
    const { ctx, teamFiber } = await setup([], { defaultEnabled: true }, false)
    await teamFiber.dispose()
    const handle = await ctx.agents.create({ sessionId: brandString<SessionId>('without-team') })
    expect(handle.agent.session.ownEvents().filter(event => event.type === 'team/mode')).toEqual([])
    await handle.dispose()
  })

  it('rejects Agent creation if saving the configured mode fails', async () => {
    const { ctx } = await setup([], { defaultEnabled: true }, false)
    const failure = new Error('mode save failed')
    const id = brandString<SessionId>('failed-mode-save')
    vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(failure)
    await expect(ctx.agents.create({ sessionId: id })).rejects.toBe(failure)
    expect(ctx.agents.get(id)).toBeUndefined()
    expect(ctx.sessions.get(id)).toBeUndefined()
  })

  it('does not register a Team slash command', async () => {
    const { ctx, lead } = await setup([], {}, false)
    await ctx.plugin(Commands)
    expect(ctx.commands.list(lead).some(command => command.name === 'team')).toBe(false)
  })

  it('rejects disabled task access and descendant mode changes without appending', async () => {
    const { ctx, lead } = await setup([], {}, false)
    const child = await resident(ctx, lead, 'mode-child')
    expect(ctx.agentTeams.isEnabled(lead)).toBe(false)
    expect(() => ctx.agentTeams.listTasks(lead)).toThrow('enable Agent Teams')
    await expect(ctx.agentTeams.createTask(lead, { subject: 'off', description: 'off' })).rejects.toThrow('enable Agent Teams')
    await expect(ctx.agentTeams.setEnabled(child, true)).rejects.toThrow('root Session')
    const cancel = new AbortController()
    cancel.abort(new Error('cancelled selection'))
    await expect(ctx.agentTeams.setEnabled(lead, true, cancel.signal)).rejects.toThrow('cancelled selection')
    expect(lead.session.ownEvents().filter(event => event.type === 'team/mode')).toEqual([])
  })

  it.each(['create', 'claim'] as const)('disables queued %s while an admitted reassignment finishes', async (action) => {
    const { ctx, lead } = await setup(['hang'])
    const { childId } = await spawn(ctx, lead, 'worker')
    const child = await waitRunning(ctx, childId)
    const task = await ctx.agentTeams.createTask(lead, { subject: 'work', description: 'retained assignment' })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const discover = ctx.subagents.listDescendants.bind(ctx.subagents)
    vi.spyOn(ctx.subagents, 'listDescendants').mockImplementationOnce(async (...args) => {
      entered.resolve(undefined)
      await release.promise
      return discover(...args)
    })
    const admitted = ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'reassign', owner: childId,
    })
    await entered.promise
    const queued = action === 'create'
      ? ctx.agentTeams.createTask(child, { subject: 'queued', description: 'must not start' })
      : ctx.agentTeams.updateTask(child, { taskId: task.id, expectedRevision: 2, action: 'claim' })
    const rejected = expect(queued).rejects.toMatchObject({ code: 'TEAM_DISABLED' })
    const disabling = ctx.agentTeams.setEnabled(lead, false)
    try {
      expect(ctx.agentTeams.isEnabled(child)).toBe(false)
      await disabling
      expect(ctx.agents.get(childId)).toBe(child)
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([admitted, rejected, disabling])
    }
    await expect(admitted).resolves.toMatchObject({ revision: 2, ownerId: childId })
    await rejected
    await ctx.agentTeams.setEnabled(lead, true)
    expect(ctx.agentTeams.listTasks(lead)).toEqual([expect.objectContaining({ id: task.id, revision: 2, ownerId: childId })])
  })

  it('admits queued work using the latest selection after off then on', async () => {
    const { ctx, lead } = await setup([])
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      entered.resolve(undefined)
      await release.promise
      return await flush(session)
    })
    const admitted = ctx.agentTeams.createTask(lead, { subject: 'first', description: 'awaiting persistence' })
    await entered.promise
    const queued = ctx.agentTeams.createTask(lead, { subject: 'second', description: 'uses latest mode' })
    const disabling = ctx.agentTeams.setEnabled(lead, false)
    const enabling = ctx.agentTeams.setEnabled(lead, true)
    try {
      expect(ctx.agentTeams.isEnabled(lead)).toBe(true)
      expect(lead.session.ownEvents().filter(event => event.type === 'team/mode').map(event => event.data.enabled))
        .toEqual([true, false, true])
      await Promise.all([disabling, enabling])
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([admitted, queued, disabling, enabling])
    }
    await expect(queued).resolves.toMatchObject({ subject: 'second' })
    expect(ctx.agentTeams.listTasks(lead).map(task => task.subject)).toEqual(['first', 'second'])
  })

  it.each([false, true])('keeps Team unavailable without storage (flush observer: %s)', async (hasFlushObserver) => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(SubagentService)
    if (hasFlushObserver) ctx.on('session/flush', () => undefined)
    const session = ctx.sessions.create()
    expect(await ctx.sessions.flush(session)).toBe(hasFlushObserver)

    await ctx.plugin(TeamService)

    expect(ctx.get('sessionPersistence')).toBeUndefined()
    expect(ctx.get('agentTeams') === undefined).toBe(true)
  })

  it('rejects reads and mutations after a Team projection fails', async () => {
    const { ctx, lead } = await setup([])
    lead.session.append('team/task', {
      version: 2,
      teamId: brandString<TeamId>(lead.id),
      task: {
        id: brandString<TeamTaskId>('task-1'), revision: 2, subject: 'invalid', description: 'missing initial revision',
        status: 'pending', blockedBy: [], writeScopes: [],
      },
    })
    const corrupt = { name: 'TeamError', code: 'TEAM_STATE_CORRUPT', message: expect.stringContaining('must begin at revision 1') as string }
    expect(() => ctx.agentTeams.listTasks(lead)).toThrow(expect.objectContaining(corrupt))
    const eventCount = lead.session.snapshotEvents().length
    await expect(ctx.agentTeams.createTask(lead, { subject: 'blocked', description: 'blocked' }))
      .rejects.toMatchObject(corrupt)
    expect(lead.session.snapshotEvents()).toHaveLength(eventCount)
  })

  it('propagates unavailable subagent runtime errors', async () => {
    const { ctx, lead } = await setup([])
    const failure = new Error('runtime unavailable')
    vi.spyOn(ctx.subagents, 'rootOf').mockImplementation(() => { throw failure })
    expect(() => ctx.agentTeams.listTasks(lead)).toThrow(failure)
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
    const namedActivation = await spawn(ctx, lead, 'alpha')
    const named = await waitRunning(ctx, namedActivation.childId)
    const unnamed = await waitRunning(ctx, (await spawn(ctx, lead, undefined)).childId)
    const grandchildId = (await ctx.subagents.startActivation({
      provider: 'spawn', label: 'nested', delivery: 'caller', signal: SIGNAL,
      prompt: content('nested'), parent: named,
    })).childId
    const grandchild = await waitRunning(ctx, grandchildId)

    const shared = await ctx.agentTeams.createTask(lead, { subject: 'shared', description: 'visible at every depth' })
    for (const agent of [lead, named, unnamed, grandchild]) {
      expect(ctx.agentTeams.getTask(agent, shared.id).id).toBe(shared.id)
    }

    await namedActivation.dispose()
    await waitNoAgent(ctx, named.id)
    const task = await ctx.agentTeams.createTask(grandchild, { subject: 'still active', description: 'creator offline' })
    expect(ctx.agentTeams.listTasks(lead).map(row => row.id)).toContain(task.id)

    const impostor = { ...lead } as Agent
    expect(() => ctx.agentTeams.listTasks(impostor)).toThrow(expect.objectContaining({ code: 'UNAUTHORIZED' }))

    await ctx.subagents.drainDescendants([lead])
    await Promise.all([waitNoAgent(ctx, grandchild.id), waitNoAgent(ctx, named.id), waitNoAgent(ctx, unnamed.id)])
  })

  it('treats an ordinary fork as a new Root Team and filters inherited Team state', async () => {
    const { ctx, lead } = await setup([textResponse('alpha done')])
    const alpha = (await spawn(ctx, lead, 'alpha')).childId
    await waitNoAgent(ctx, alpha)
    await ctx.agentTeams.createTask(lead, { subject: 'parent task', description: 'belongs to parent' })
    const handle = await ctx.agents.create({
      sessionId: brandString<SessionId>('ordinary-fork'),
      seed: lead.session.snapshotEvents(),
      meta: { parentSession: lead.id, isSeeded: true },
      inheritedEventCount: SessionLogOffset(lead.session.seq),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    expect(durable(handle.agent)).toMatchObject({ tasks: [] })
    expect(ctx.agentTeams.isEnabled(handle.agent)).toBe(false)
    await ctx.agentTeams.setEnabled(handle.agent, true)
    const task = await ctx.agentTeams.createTask(handle.agent, { subject: 'fork task', description: 'independent' })
    await expect(ctx.agentTeams.updateTask(handle.agent, {
      taskId: task.id, expectedRevision: 1, action: 'reassign', owner: alpha,
    })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
    await handle.dispose()
  })

  it('clears a prior owner name when reassigning to an unnamed historical member', async () => {
    const { ctx, lead } = await setup([])
    const legacy = await resident(ctx, lead, 'legacy-worker')
    lead.session.append('subagent/catalog', {
      version: 0, childId: legacy.id, childCreatedAt: legacy.session.header.createdAt,
      mode: 'continuable', label: 'Historical worker',
    })
    const created = await ctx.agentTeams.createTask(lead, { subject: 'Review', description: 'Historical assignment' })
    const claimed = await ctx.agentTeams.updateTask(lead, {
      taskId: created.id, expectedRevision: created.revision, action: 'claim',
    })
    expect(claimed.ownerName).toBe('lead')
    const reassigned = await ctx.agentTeams.updateTask(lead, {
      taskId: created.id, expectedRevision: claimed.revision, action: 'reassign', owner: legacy.id,
    })
    expect(reassigned.ownerId).toBe(legacy.id)
    expect(reassigned).not.toHaveProperty('ownerName')
  })

  it('assigns deep descendants by id and rejects historical roster authority', async () => {
    const { ctx, lead } = await setup(['hang', 'hang'])
    const child = await waitRunning(ctx, (await spawn(ctx, lead, 'parent')).childId)
    const grandchild = await waitRunning(ctx, (await spawn(ctx, child, 'nested')).childId)
    const task = await ctx.agentTeams.createTask(lead, { subject: 'nested work', description: 'deep assignment' })
    const assigned = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'reassign', owner: grandchild.id,
    })
    expect(assigned).toMatchObject({ ownerId: grandchild.id, ownerName: 'agent-1/agent-1' })
    for (const phase of ['provisioning', 'active'] as const) {
      lead.session.append('team/member', {
        version: 2, teamId: brandString<TeamId>(lead.id),
        member: { id: brandString<SessionId>('old-child'), name: 'legacy', description: 'old', provider: 'spawn', context: 'fresh', phase },
      })
    }
    for (const owner of [brandString<SessionId>('old-child'), brandString<SessionId>('nested'), brandString<SessionId>('unrelated-root')]) {
      await expect(ctx.agentTeams.updateTask(lead, {
        taskId: task.id, expectedRevision: assigned.revision, action: 'reassign', owner,
      })).rejects.toMatchObject({ code: 'TEAM_MEMBER_NOT_FOUND' })
    }
  })

  it('constructs with the default task limit and serializes concurrent task commits', async () => {
    const { ctx, lead, teamFiber } = await setup([], {}, false)
    await teamFiber.dispose()
    class DirectTeamService extends TeamService {
      initialize(): Promise<void> { return this[Service.init]() }
    }
    const direct = new DirectTeamService(ctx)
    await direct.initialize()
    expect(direct.isEnabled(lead)).toBe(false)
    await direct.setEnabled(lead, true)
    const [first, second] = await Promise.all([
      direct.createTask(lead, { subject: 'one', description: 'one' }),
      direct.createTask(lead, { subject: 'two', description: 'two' }),
    ])
    expect([first.id, second.id]).toEqual([brandString<TeamTaskId>('task-1'), brandString<TeamTaskId>('task-2')])
  })

  it.each([
    ['create', 'disposed'], ['claim', 'disposed'], ['create', 'cancelled'], ['claim', 'cancelled'],
  ] as const)('rejects a queued %s after its caller is %s', async (action, stopped) => {
    const { ctx, lead } = await setup([])
    const child = await ctx.agents.create({
      sessionId: brandString<SessionId>('queued-caller'), agentOptions: { provider: 'mock', model: 'mock' },
      meta: { origin: 'subagent', parentSession: lead.id },
      setup: (_ctx, agent) => { bindSubagentActivation(ctx, agent, lead) },
    })
    const task = await ctx.agentTeams.createTask(lead, { subject: 'existing', description: 'remains unclaimed' })
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      entered.resolve(undefined)
      await release.promise
      return await flush(session)
    })
    const creating = ctx.agentTeams.createTask(lead, { subject: 'blocking', description: 'holds the transaction queue' })
    try {
      await entered.promise
      const controller = new AbortController()
      const queued = action === 'create'
        ? ctx.agentTeams.createTask(child.agent, { subject: 'stopped', description: 'must not be committed' }, controller.signal)
        : ctx.agentTeams.updateTask(child.agent, { taskId: task.id, expectedRevision: task.revision, action: 'claim' }, controller.signal)
      const rejected = expect(queued).rejects.toMatchObject(stopped === 'disposed' ? { code: 'UNAUTHORIZED' } : { name: 'AbortError' })
      if (stopped === 'disposed') await child.dispose()
      else controller.abort()
      release.resolve(undefined)
      await creating
      await rejected
      expect(ctx.agentTeams.listTasks(lead).map(item => item.subject)).toEqual(['existing', 'blocking'])
      expect(ctx.agentTeams.getTask(lead, task.id)).toMatchObject({ revision: 1, status: 'pending' })
      expect(lead.inbox.nextStep).toHaveLength(0)
    } finally {
      release.resolve(undefined)
      await creating
    }
  })

  it('does not treat a descriptor-backed Session without a parent as a Team member', async () => {
    const { ctx, lead } = await setup([])
    lead.session.append('subagent/descriptor', { version: 3, mode: 'continuable', provider: 'spawn', label: 'forged' })
    expect(() => ctx.agentTeams.listTasks(lead)).toThrow(expect.objectContaining({ code: 'UNAUTHORIZED' }))
  })

  it('does not reinterpret an orphaned subagent child as a Team root', async () => {
    const { ctx } = await setup([textResponse('ordinary child done'), textResponse('orphan turn')])
    const parent = await ctx.agents.create({
      sessionId: brandString<SessionId>('temporary-parent'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const child = (await spawn(ctx, parent.agent, 'orphan')).childId
    await waitNoAgent(ctx, child)
    await parent.dispose()
    const orphan = await ctx.agents.resume({
      resumeSessionId: child,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(() => ctx.agentTeams.listTasks(orphan.agent)).toThrow(expect.objectContaining({ code: 'UNAUTHORIZED' }))
    orphan.agent.followup(createUserMessage({ content: content('run without a Team'), source: { kind: 'user' } }))
    await orphan.agent.whenIdle()
    await orphan.dispose()

    const rootWithOfflineSource = await ctx.agents.create({
      sessionId: brandString<SessionId>('orphan-ordinary-root'),
      meta: { parentSession: brandString<SessionId>('absent-parent') },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await ctx.agentTeams.setEnabled(rootWithOfflineSource.agent, true)
    expect(ctx.agentTeams.listTasks(rootWithOfflineSource.agent)).toEqual([])
    await rootWithOfflineSource.dispose()
  })
})

describe('Team shared task DAG', () => {
  it('fails loudly when the durable numeric task id space is exhausted', async () => {
    const { ctx, lead } = await setup([])
    const id = brandString<TeamTaskId>(`task-${Number.MAX_SAFE_INTEGER}`)
    lead.session.append('team/task', {
      version: 2,
      teamId: brandString<TeamId>(lead.id),
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
    expect(second.id).toBe(brandString<TeamTaskId>('task-2'))
    expect(ctx.agentTeams.getTask(lead, first.id).status).toBe('deleted')
    expect(ctx.agentTeams.listTasks(lead).map(task => task.id)).toEqual([second.id])
  })

  it('enforces CAS, ownership, dependencies, transitions, and write-scope warnings', async () => {
    const { ctx, lead } = await setup(['hang', 'hang', textResponse('beta integrated update')])
    const firstMember = await spawn(ctx, lead, 'alpha')
    const alpha = await waitRunning(ctx, firstMember.childId)
    const secondMember = await spawn(ctx, lead, 'beta')
    const beta = await waitRunning(ctx, secondMember.childId)

    const first = await ctx.agentTeams.createTask(alpha, {
      subject: 'first',
      description: 'first task',
      writeScopes: ['src', './src', 'src'],
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
    expect('ownerName' in released).toBe(false)

    await Promise.all([firstMember.dispose(), secondMember.dispose()])
    await Promise.all([waitNoAgent(ctx, alpha.id), waitNoAgent(ctx, beta.id)])
  })

  it('rejects malformed scopes and every invalid dependency relation', async () => {
    const { ctx, lead } = await setup([])
    const first = await ctx.agentTeams.createTask(lead, { subject: 'one', description: 'one' })
    const second = await ctx.agentTeams.createTask(lead, {
      subject: 'two', description: 'two', blockedBy: [first.id],
    })
    await expect(ctx.agentTeams.createTask(lead, {
      subject: 'bad', description: 'bad', blockedBy: [brandString<TeamTaskId>('missing')],
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
    expect(() => ctx.agentTeams.getTask(lead, brandString<TeamTaskId>('missing')))
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
    const owner = await waitRunning(ctx, started.childId)
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
    expect(reopened).not.toHaveProperty('ownerId')
    expect(reopened).not.toHaveProperty('ownerName')
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
    await started.dispose()
    await waitNoAgent(ctx, owner.id)
  })

  it('covers partial edits, Lead ownership, unassignment, and blocked reassignment', async () => {
    const { ctx, lead } = await setup(['hang'])
    const started = await spawn(ctx, lead, 'editor')
    const editor = await waitRunning(ctx, started.childId)
    const blocker = await ctx.agentTeams.createTask(lead, { subject: 'blocker', description: 'blocker' })
    const task = await ctx.agentTeams.createTask(lead, {
      subject: 'draft',
      description: 'draft description',
      blockedBy: [blocker.id],
    })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: brandString<TeamTaskId>('missing-update'), expectedRevision: 1, action: 'delete',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_NOT_FOUND' })
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: task.revision, action: 'reassign', owner: editor.id,
    })).rejects.toMatchObject({ code: 'TEAM_TASK_BLOCKED' })

    const leadClaim = await ctx.agentTeams.updateTask(lead, {
      taskId: blocker.id, expectedRevision: blocker.revision, action: 'claim',
    })
    expect(leadClaim).toMatchObject({ ownerId: lead.id, ownerName: 'lead' })
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
    expect('ownerName' in unassigned).toBe(false)

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

    const rootAssigned = await ctx.agentTeams.updateTask(lead, {
      taskId: task.id, expectedRevision: unassigned.revision, action: 'reassign', owner: lead.id,
    })
    expect(rootAssigned).toMatchObject({ status: 'in_progress', ownerId: lead.id, ownerName: 'lead' })

    await started.dispose()
    await waitNoAgent(ctx, editor.id)
  })
})

describe('Task-board persistence', () => {
  it('commits tasks without writing inboxes or starting idle agents', async () => {
    const { ctx, lead, adapter } = await setup([])
    const alpha = await resident(ctx, lead, 'notify-alpha')
    const beta = (await ctx.agents.create({
      sessionId: brandString<SessionId>('notify-beta'), meta: { origin: 'subagent', parentSession: alpha.id },
      agentOptions: { provider: 'mock', model: 'mock' },
      setup: (_ctx, agent) => { bindSubagentActivation(ctx, agent, lead, [lead.id, alpha.id]) },
    })).agent
    const unrelated = await ctx.agentLoop.create(brandString<SessionId>('unrelated'), { provider: 'mock', model: 'mock' })
    const unbound = (await ctx.agents.create({
      sessionId: brandString<SessionId>('unbound-subagent'),
      meta: { origin: 'subagent', parentSession: lead.id },
      agentOptions: { provider: 'mock', model: 'mock' },
    })).agent
    const first = await ctx.agentTeams.createTask(lead, { subject: 'one', description: 'first change' })
    await ctx.agentTeams.updateTask(beta, {
      taskId: first.id, expectedRevision: first.revision, action: 'claim',
    })
    for (const agent of [lead, alpha, beta, unrelated, unbound]) {
      expect(agent.inbox.nextStep).toHaveLength(0)
      expect(agent.inbox.nextTurn).toHaveLength(0)
      expect(agent.status).toBe('idle')
      expect(agent.session.snapshotEvents().filter(event => event.type === 'agent/inbox/spliced')).toHaveLength(0)
    }
    expect(adapter.requests).toHaveLength(0)
  })

  it('resolves task commits only after persistence succeeds', async () => {
    const { ctx, lead } = await setup([])
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      entered.resolve(undefined)
      await release.promise
      return await flush(session)
    })
    let committed = false
    const creating = ctx.agentTeams.createTask(lead, { subject: 'one', description: 'wait for flush' }).then((task) => {
      committed = true
      return task
    })
    try {
      await entered.promise
      expect(committed).toBe(false)
    } finally {
      release.resolve(undefined)
      await creating
    }
    expect(committed).toBe(true)
    vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(ctx.agentTeams.createTask(lead, { subject: 'two', description: 'failed flush' })).rejects.toMatchObject({
      code: 'TEAM_TASK_PERSISTENCE_UNCONFIRMED',
      message: 'task "task-2" revision 1 is visible, but persistence was not confirmed; read the task before retrying',
      cause: new Error('storage unavailable'),
    })
    expect(ctx.agentTeams.getTask(lead, brandString<TeamTaskId>('task-2'))).toMatchObject({ subject: 'two', revision: 1 })
    expect(ctx.agentTeams.listTasks(lead)).toHaveLength(2)
    await expect(ctx.agentTeams.updateTask(lead, {
      taskId: brandString<TeamTaskId>('task-1'), expectedRevision: 99, action: 'claim',
    })).rejects.toMatchObject({ code: 'TEAM_TASK_STALE_REVISION' })
  })

  it('reports unconfirmed task revisions when no flush listener participates', async () => {
    const { ctx, lead } = await setup([])
    vi.spyOn(ctx.sessions, 'flush').mockResolvedValue(false)

    await expect(ctx.agentTeams.createTask(lead, { subject: 'unconfirmed', description: 'read before retrying' }))
      .rejects.toMatchObject({ code: 'TEAM_TASK_PERSISTENCE_UNCONFIRMED' })
    const taskId = brandString<TeamTaskId>('task-1')
    expect(ctx.agentTeams.getTask(lead, taskId)).toMatchObject({ subject: 'unconfirmed', revision: 1 })

    await expect(ctx.agentTeams.updateTask(lead, { taskId, expectedRevision: 1, action: 'claim' }))
      .rejects.toMatchObject({ code: 'TEAM_TASK_PERSISTENCE_UNCONFIRMED' })
    expect(ctx.agentTeams.getTask(lead, taskId)).toMatchObject({ revision: 2, ownerId: lead.id })
  })

})
