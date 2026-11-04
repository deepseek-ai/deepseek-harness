import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentService, { NO_START_CAPABILITIES, SubagentError, type SubagentActivation } from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { renderPrompt, renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import * as ToolSubagentControl from '@deepseek-ai/dsh-tool-subagent-control'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { serialize } from '@deepseek-ai/dsh-llm-deepseek/src/serialize.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import { bindSubagentActivation } from '../../../subagent/subagent/tests/manager-internals.ts'
import TeamService, { TeamId } from '../../agent-team/src/index.ts'
import * as toolTeam from '../src/index.ts'

function serializeRequest(request: GenerateOptions) {
  const connection = resolveAdapterOptions({ models: [{ id: request.model, systemPromptUpdate: 'in-history' }] })
  return serialize(request, connection, request.messages, new Map(), () => undefined)
}

function runtimeContextText(request: GenerateOptions) {
  const context = request.messages.findLast(message => message.source?.kind === 'runtime-context')
  return context?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

const SIGNAL = new AbortController().signal
const TEAM_TOOLS = [
  'team_task_create',
  'team_task_get',
  'team_task_list',
  'team_task_update',
]
const leadIdentity = (_agent: Agent): string => 'You are the root agent. Your name is "lead".'

const roots: string[] = []
const contexts = new Set<Context>()
let callNumber = 0

/** Session query implementation whose search faces are outside these tests. */
class TestSessionQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('session search is not configured in this test'))
  }

  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('event search is not configured in this test'))
  }
}

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup(script: ConstructorParameters<typeof MockAdapter>[0], enabled = true) {
  const ctx = new Context()
  contexts.add(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await mountWorkingDirectoryFixture(ctx)
  const storageRoot = mkdtempSync(join(tmpdir(), 'dsh-tool-team-'))
  roots.push(storageRoot)
  await ctx.plugin(JsonlSessionPersistence, { root: storageRoot })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(ToolSubagentControl)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  await ctx.plugin(TeamService)
  const fiber = await ctx.plugin(toolTeam)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = await ctx.agentLoop.create(SessionId('tool-team-lead'), { provider: 'mock', model: 'mock' })
  if (enabled) await ctx.agentTeams.setEnabled(lead, true)
  return { ctx, lead, fiber, adapter }
}

async function execute(
  ctx: Context,
  agent: Agent | undefined,
  name: string,
  args: unknown,
  signal: AbortSignal = SIGNAL,
) {
  const toolSet = agent === undefined ? undefined : await ctx.tools.resolve({
    agent, modelSelection: { provider: 'mock', model: 'mock' }, signal,
  })
  try {
    return await executeToolFixture(ctx, {
      callId: ToolCallId(`team-call-${++callNumber}`),
      name,
      arguments: args,
      signal,
      ...toolSet === undefined ? {} : { toolSet },
      ...agent === undefined ? {} : { agent },
    })
  } finally {
    toolSet?.dispose()
  }
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/** Observe wait subscription before committing a competing task change. */
async function startWait(ctx: Context, agent: Agent) {
  const entered = Promise.withResolvers<undefined>()
  const off = ctx.on('tools/execute', (exec, next) => {
    const result = next()
    if (exec.name === 'wait_agent' && exec.agent === agent) entered.resolve(undefined)
    return result
  })
  const result = execute(ctx, agent, 'wait_agent', { timeout_ms: 10_000 })
  await entered.promise
  off()
  return { result }
}

/** Start a continuable child of the Lead with a task description. */
async function spawn(ctx: Context, lead: Agent, description: string | undefined, prompt: string, provider = 'spawn'): Promise<SubagentActivation> {
  const started = await ctx.subagents.startActivation({
    provider,
    label: `${description ?? 'shared'} task`,
    prompt: [{ type: 'text', text: prompt }], parent: lead,
    signal: SIGNAL,
    delivery: 'parent',
  })
  return started
}

async function assembly(ctx: Context, agent: Agent) {
  const scope = scopeOf(agent.ctx)
  if (scope === undefined) throw new Error('expected Agent scope')
  const toolSet = await ctx.tools.resolve({ agent, modelSelection: { provider: 'mock', model: 'mock' }, signal: SIGNAL })
  try {
    return await ctx.systemPrompt.assemble({ scope, agent, toolSet })
  } finally {
    toolSet.dispose()
  }
}

function teamTools(assembled: Awaited<ReturnType<typeof assembly>>): string[] {
  return assembled.tools.map(schema => schema.name).filter(name => TEAM_TOOLS.includes(name)).sort()
}

function agentIdentity(name: string, parentName = 'lead'): string {
  return `You are a subagent delegated by agent ${JSON.stringify(parentName)}.\nYour name is ${JSON.stringify(name)}.\nThe root agent of your collaboration tree is "lead".`
}

async function runTurn(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

async function waitRunning(ctx: Context, id: SessionId): Promise<Agent> {
  return vi.waitFor(() => {
    const child = ctx.agents.get(id)
    expect(child?.status).toBe('running')
    return child!
  }, { timeout: 5_000 })
}

async function waitNoAgent(ctx: Context, id: SessionId): Promise<void> {
  await vi.waitFor(() => { expect(ctx.agents.get(id)).toBeUndefined() }, { timeout: 5_000 })
}

describe('dsh-tool-team', () => {
  it.each([true, false])('cancels reassignment without appending when discovery observes cancellation: %s', async (observesCancellation) => {
    const { ctx, lead } = await setup(['hang'])
    const childActivation = await spawn(ctx, lead, 'worker', 'stay running')
    const childId = childActivation.childId
    await waitRunning(ctx, childId)
    const task = await ctx.agentTeams.createTask(lead, { subject: 'work', description: 'assign work' })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const discover = ctx.subagents.listDescendants.bind(ctx.subagents)
    const lookup = vi.spyOn(ctx.subagents, 'listDescendants').mockImplementationOnce(async (...args) => {
      entered.resolve(undefined)
      await release.promise
      return discover(args[0], observesCancellation ? args[1] : undefined)
    })
    const controller = new AbortController()
    const result = execute(ctx, lead, 'team_task_update', {
      task_id: task.id, expected_revision: task.revision, action: 'reassign', owner: childId,
    }, controller.signal)
    try {
      await entered.promise
      expect(lookup.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal)
      controller.abort(new Error('stop assignment'))
    } finally {
      release.resolve(undefined)
    }
    expect(await result).toMatchObject({ isError: true })
    expect(ctx.agentTeams.getTask(lead, task.id)).toEqual(task)
    await using stored = await ctx.sessionPersistence.open(lead.id, 'read')
    expect((await stored.read()).events.filter(event => event.type === 'team/task')).toHaveLength(1)
  })

  it('accepts and reports task owners by agent name', async () => {
    const { ctx, lead } = await setup(['hang'])
    const childActivation = await spawn(ctx, lead, 'worker', 'stay running')
    await waitRunning(ctx, childActivation.childId)
    const task = await ctx.agentTeams.createTask(lead, { subject: 'work', description: 'assign by name' })
    const reassigned = await execute(ctx, lead, 'team_task_update', {
      task_id: task.id, expected_revision: task.revision, action: 'reassign', owner: childActivation.name,
    })
    expect(JSON.parse(text(reassigned))).toMatchObject({ owner: 'agent-1' })
    expect(JSON.parse(text(reassigned))).not.toHaveProperty('ownerId')
    expect(ctx.agentTeams.getTask(lead, task.id)).toMatchObject({ ownerId: childActivation.childId, ownerName: 'agent-1' })
    expect(JSON.parse(text(reassigned))).not.toHaveProperty('ownerName')
    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', { owner: 'agent-1' }))))
      .toMatchObject({ tasks: [{ id: task.id, owner: 'agent-1' }] })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', { owner: 'lead' })))).toEqual({ tasks: [] })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_get', { task_id: task.id })))).toMatchObject({ owner: 'agent-1' })
    await childActivation.dispose()
    await waitNoAgent(ctx, childActivation.childId)
  })

  it('keeps Team tools local when an external activation starts and settles', async () => {
    const { ctx, lead } = await setup([])
    const externalId = SessionId('team-external-result')
    ctx.effect(() => ctx.subagents.registerProvider({
      name: 'external-team-fixture', inheritsParentContext: false, capabilities: NO_START_CAPABILITIES,
      start: async () => ({
        id: externalId,
        result: Promise.resolve({ output: [{ type: 'text', text: 'External result' }], stopReason: 'completed' }),
        dispose: async () => {},
      }),
    }))
    const activation = await ctx.subagents.startActivation({
      parent: lead, provider: 'external-team-fixture', label: 'Remote inspection',
      prompt: [{ type: 'text', text: 'Inspect remotely' }],
      delivery: 'caller', signal: SIGNAL,
    })
    try {
      expect(await activation.result).toMatchObject({ stopReason: 'completed' })
      expect(ctx.agents.get(externalId)).toBeUndefined()
      expect(await execute(ctx, lead, 'team_task_list', {})).toMatchObject({ isError: false })
    } finally {
      await activation.dispose()
    }
  })

  it('adds task tools and policy alongside shared subagent identity', async () => {
    const { ctx, lead } = await setup(['hang', 'hang'])
    const leadAssembly = await assembly(ctx, lead)
    expect(teamTools(leadAssembly)).toEqual(TEAM_TOOLS)
    const leadPrompt = renderPrompt(leadAssembly)
    expect(leadPrompt).toContain('A shared task board is available in this session')
    expect(leadPrompt).toContain('Task readiness never starts an owner')
    expect(leadPrompt).toContain('Task changes do not end wait_agent calls')
    expect(renderContextSnapshot(leadAssembly)).toContain(leadIdentity(lead))
    expect((await ctx.systemPrompt.assemble()).contexts.some(context => context.name === 'team:identity')).toBe(false)
    expect(leadAssembly.tools.map(schema => schema.name)).not.toContain('spawn_teammate')
    // Messaging, listing, and interruption stay the global subagent controls.
    for (const name of ['send_message', 'list_agents', 'interrupt_agent', 'wait_agent']) {
      expect(ctx.tools.get(name, scopeOf(lead.ctx))).toBe(ctx.tools.get(name))
    }

    const namedActivation = await spawn(ctx, lead, 'reviewer', 'stay available')
    const namedId = namedActivation.childId
    const unnamedActivation = await spawn(ctx, lead, undefined, 'stay available too')
    const unnamedId = unnamedActivation.childId
    for (const activation of [namedActivation, unnamedActivation]) {
      const child = await waitRunning(ctx, activation.childId)
      const childAssembly = await assembly(ctx, child)
      expect(teamTools(childAssembly)).toEqual(TEAM_TOOLS)
      expect(renderPrompt(childAssembly)).toBe(leadPrompt)
      expect(renderContextSnapshot(childAssembly)).toContain(agentIdentity(activation.name))
      expect(ctx.tools.get('send_message', scopeOf(child.ctx))).toBe(ctx.tools.get('send_message'))
    }
    await namedActivation.dispose()
    await unnamedActivation.dispose()
    await Promise.all([waitNoAgent(ctx, namedId), waitNoAgent(ctx, unnamedId)])
  })

  it.each([
    ['spawn', undefined], ['fork', undefined], ['fork', 'in-history'],
  ] as const)('records %s teammate identity with update mode %s and keeps the wire prefix', async (provider, systemPromptUpdate) => {
    const { ctx, lead, adapter } = await setup([textResponse('parent answer'), textResponse('child answer')])
    if (systemPromptUpdate !== undefined) adapter.systemPromptUpdate = systemPromptUpdate
    await runTurn(lead, 'Parent task')
    const parentRequest = serializeRequest(adapter.requests[0]!)
    const parentHistory = structuredClone(lead.session.deriveMessages())
    const childActivation = await spawn(ctx, lead, 'reviewer', 'Review the work', provider)
    const childId = childActivation.childId
    await waitNoAgent(ctx, childId)
    const childRequest = serializeRequest(adapter.requests[1]!)
    expect(childRequest.tools).toEqual(parentRequest.tools)
    expect(childRequest.system).toEqual(parentRequest.system)
    if (provider === 'fork') {
      expect(childRequest.messages.slice(0, parentRequest.messages.length)).toEqual(parentRequest.messages)
      expect(adapter.requests[1]!.messages.slice(0, parentHistory.length)).toEqual(parentHistory)
    } else {
      expect(JSON.stringify(childRequest.messages)).not.toContain('Parent task')
    }
    expect(runtimeContextText(adapter.requests[1]!)).toContain(agentIdentity('agent-1'))
  })

  it('appends the new Lead id after inherited history in an ordinary fork', async () => {
    const { ctx, lead, adapter } = await setup([textResponse('parent answer'), textResponse('fork answer')])
    await runTurn(lead, 'Parent task')
    const seed = lead.session.snapshotEvents()
    const handle = await ctx.agents.create({
      sessionId: SessionId('ordinary-team-fork'),
      seed,
      inheritedEventCount: SessionLogOffset(seed.length),
      meta: { parentSession: lead.id, isSeeded: true },
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: SIGNAL,
    })
    expect(ctx.agentTeams.isEnabled(handle.agent)).toBe(false)
    await ctx.agentTeams.setEnabled(handle.agent, true)
    await runTurn(handle.agent, 'Continue independently')
    const parentRequest = serializeRequest(adapter.requests[0]!)
    const childRequest = serializeRequest(adapter.requests[1]!)
    expect(childRequest.tools).toEqual(parentRequest.tools)
    expect(childRequest.messages.slice(0, parentRequest.messages.length)).toEqual(parentRequest.messages)
    expect(childRequest.messages.at(-1)?.content).toContainEqual({ type: 'text', text: 'Continue independently' })
    expect(runtimeContextText(adapter.requests[1]!)).toContain(leadIdentity(handle.agent))
    expect(JSON.stringify(childRequest.messages)).not.toContain('system-reminder')
    expect(handle.agent.session.snapshotEvents().slice(0, seed.length)).toEqual(seed)
    expect(ctx.subagents.rootOf(handle.agent)).toBe(handle.agent)
    await handle.dispose()
  })

  it('identifies nested descendants with the tree root rather than their direct parent', async () => {
    const { ctx, lead } = await setup([])
    const child = await ctx.agents.create({
      sessionId: SessionId('identity-child'),
      meta: { parentSession: lead.id, origin: 'subagent' },
      setup: (_ctx, agent) => { bindSubagentActivation(ctx, agent, lead) },
    })
    const nested = await ctx.agents.create({
      sessionId: SessionId('identity-nested'),
      meta: { parentSession: child.agent.id, origin: 'subagent' },
      setup: (_ctx, agent) => { bindSubagentActivation(ctx, agent, lead, [lead.id, child.agent.id]) },
    })
    expect(renderContextSnapshot(await assembly(ctx, nested.agent))).toContain(agentIdentity(nested.agent.id, child.agent.id))
    expect(renderContextSnapshot(await assembly(ctx, nested.agent))).not.toContain(`The root agent of your collaboration tree is ${JSON.stringify(child.agent.id)}.`)
  })

  it.each([undefined, 'in-history'] as const)('appends current Lead identity to a teammate fork with update mode %s', async (systemPromptUpdate) => {
    const { ctx, lead, adapter } = await setup([textResponse('review done'), textResponse('lead notified'), textResponse('fork answer')])
    if (systemPromptUpdate !== undefined) adapter.systemPromptUpdate = systemPromptUpdate
    const teammateActivation = await spawn(ctx, lead, 'reviewer', 'Review the work')
    const teammateId = teammateActivation.childId
    await waitNoAgent(ctx, teammateId)
    await using persisted = await ctx.sessionPersistence.open(teammateId, 'read')
    const { events: seed } = await persisted.read()
    const handle = await ctx.agents.create({
      sessionId: SessionId('fork-from-teammate'),
      seed,
      inheritedEventCount: SessionLogOffset(seed.length),
      meta: { parentSession: teammateId, isSeeded: true },
      agentOptions: { provider: 'mock', model: 'mock' },
      signal: SIGNAL,
    })
    try {
      await ctx.agentTeams.setEnabled(handle.agent, true)
      const inheritedHistory = structuredClone(handle.agent.session.deriveMessages())
      await runTurn(handle.agent, 'Continue independently')
      const original = serializeRequest(adapter.requests.find(request => request.sessionId === teammateId)!)
      const forkRequest = adapter.requests.find(request => request.sessionId === handle.agent.id)!
      const fork = serializeRequest(forkRequest)
      expect(fork.tools).toEqual(original.tools)
      expect(fork.messages.slice(0, original.messages.length)).toEqual(original.messages)
      expect(forkRequest.messages.slice(0, inheritedHistory.length)).toEqual(inheritedHistory)
      expect(runtimeContextText(forkRequest)).toContain(leadIdentity(handle.agent))
      expect(handle.agent.session.snapshotEvents().slice(0, seed.length)).toEqual(seed)
    } finally {
      await handle.dispose()
    }
  })

  it('restores compacted identity and does not repeat an unchanged retained snapshot', async () => {
    const { ctx, lead, adapter } = await setup([
      toolCallResponse('first-list', 'team_task_list', {}),
      toolCallResponse('second-list', 'team_task_list', {}),
      textResponse('done'),
    ])
    ctx.on('agent/pre-step', async ({ agent, step }, next) => {
      if (step === 3) {
        const identity = agent.session.snapshotEvents().find(event => event.type === 'user/message'
          && event.data.source.kind === 'runtime-context')
        if (identity === undefined) throw new Error('expected teammate runtime context')
        agent.session.append('user/message', createUserMessage({
          content: [{ type: 'text', text: 'Compacted earlier context.' }],
          source: { kind: 'test-compaction' },
        }), {
          surfaceOp: { op: 'replace', startSeq: identity.seq, endSeq: identity.seq },
          sourceEventSeqs: [identity.seq],
        })
      }
      return next()
    })
    const childActivation = await spawn(ctx, lead, 'reviewer', 'Review the work')
    const childId = childActivation.childId
    await waitNoAgent(ctx, childId)
    for (const request of adapter.requests.filter(request => request.sessionId === childId)) {
      const snapshots = request.messages.filter(message => message.source?.kind === 'runtime-context')
      expect(snapshots).toHaveLength(1)
      expect(runtimeContextText(request)).toContain(agentIdentity('agent-1'))
    }
    await using persisted = await ctx.sessionPersistence.open(childId, 'read')
    const { events } = await persisted.read()
    expect(events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'runtime-context')).toHaveLength(2)
  })

  it('keeps required agent identities when optional runtime context is suppressed', async () => {
    const { ctx, lead, adapter } = await setup([textResponse('worker done')])
    ctx.systemPrompt.suppressRuntimeContext()
    const childActivation = await spawn(ctx, lead, 'reviewer', 'Review the work')
    const childId = childActivation.childId
    await waitNoAgent(ctx, childId)
    expect(renderContextSnapshot(await assembly(ctx, lead))).toContain(leadIdentity(lead))
    expect(runtimeContextText(adapter.requests[0]!)).toContain(agentIdentity('agent-1'))
  })

  it('keeps ordinary inbox waiting when the task plugin unloads', async () => {
    const { ctx, lead, fiber } = await setup([])
    await fiber.dispose()
    lead.inject(createUserMessage({ content: [{ type: 'text', text: 'pending input' }], source: { kind: 'user' } }))
    const result = await execute(ctx, lead, 'wait_agent', {})
    expect(result.isError).toBe(false)
    expect(JSON.parse(text(result))).toEqual({ timedOut: false })
    expect(lead.inbox.nextStep).toHaveLength(1)
  })

  it('adapts task CAS operations and waits to canonical JSON', async () => {
    const { ctx, lead } = await setup(['hang'])
    const childActivation = await spawn(ctx, lead, 'json-worker', 'wait')
    const childId = childActivation.childId
    const child = await waitRunning(ctx, childId)

    const created = await execute(ctx, lead, 'team_task_create', {
      subject: 'tool task',
      description: 'created through tool',
      blocked_by: [],
      write_scopes: ['src/team'],
    })
    // Every Team result reaches the model as compact JSON: indentation would
    // spend tokens on every task and wait result without adding meaning.
    expect(text(created)).toBe(JSON.stringify(JSON.parse(text(created))))
    const task = JSON.parse(text(created)) as { id: string; revision: number }
    const listed = await execute(ctx, child, 'team_task_list', { ready: true, limit: 1 })
    expect(JSON.parse(text(listed))).toMatchObject({ tasks: [{ id: task.id, ready: true }] })
    const read = await execute(ctx, child, 'team_task_get', { task_id: task.id })
    expect(JSON.parse(text(read))).toMatchObject({ id: task.id, revision: 1 })
    const claimed = await execute(ctx, child, 'team_task_update', {
      task_id: task.id,
      expected_revision: task.revision,
      action: 'claim',
    })
    expect(JSON.parse(text(claimed))).toMatchObject({ status: 'in_progress', owner: 'agent-1' })
    const stale = await execute(ctx, lead, 'team_task_update', {
      task_id: task.id,
      expected_revision: task.revision,
      action: 'delete',
    })
    expect(stale.isError).toBe(true)
    expect(text(stale)).toContain('stale team task')

    lead.inbox.clear()
    const { result: wait } = await startWait(ctx, lead)
    let returned = false
    void wait.then(() => { returned = true })
    const completed = await execute(ctx, child, 'team_task_update', {
      task_id: task.id, expected_revision: 2, action: 'complete',
    })
    expect(completed.isError).toBe(false)
    expect(returned).toBe(false)
    expect(lead.inbox.nextStep).toHaveLength(0)
    lead.inject(createUserMessage({ content: [{ type: 'text', text: 'task is ready' }], source: { kind: 'user' } }))
    expect(JSON.parse(text(await wait))).toEqual({ timedOut: false })

    await childActivation.dispose()
    await waitNoAgent(ctx, childId)
  })

  it('adapts optional task filters, mutations, pagination, and default waiting', async () => {
    const { ctx, lead } = await setup(['hang'])
    const childActivation = await spawn(ctx, lead, 'fork-worker', 'stay active', 'fork')
    const childId = childActivation.childId
    await waitRunning(ctx, childId)

    const firstResult = await execute(ctx, lead, 'team_task_create', {
      subject: 'first', description: 'first task',
    })
    const secondResult = await execute(ctx, lead, 'team_task_create', {
      subject: 'second', description: 'second task',
    })
    const first = JSON.parse(text(firstResult)) as { id: string; revision: number }
    const second = JSON.parse(text(secondResult)) as { id: string; revision: number }
    const claimed = await execute(ctx, lead, 'team_task_update', {
      task_id: first.id, expected_revision: first.revision, action: 'claim',
    })
    const claim = JSON.parse(text(claimed)) as { revision: number }

    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', {
      status: 'in_progress', owner: lead.id, cursor: 0, limit: 1,
    })))).toMatchObject({ tasks: [{ id: first.id }] })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', {
      unowned: true, limit: 1,
    })))).toMatchObject({ tasks: [{ id: second.id }] })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', {
      cursor: 0, limit: 1,
    })))).toMatchObject({ nextCursor: 1 })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', {
      cursor: 1,
    })))).not.toHaveProperty('nextCursor')
    expect((await execute(ctx, lead, 'team_task_list', { cursor: -1 })).isError).toBe(true)
    expect((await execute(ctx, lead, 'team_task_list', { limit: 101 })).isError).toBe(true)

    const edited = await execute(ctx, lead, 'team_task_update', {
      task_id: first.id,
      expected_revision: claim.revision,
      action: 'edit',
      subject: 'edited',
      description: 'edited description',
      write_scopes: ['src/team'],
    })
    const edit = JSON.parse(text(edited)) as { revision: number }
    const dependencies = await execute(ctx, lead, 'team_task_update', {
      task_id: first.id,
      expected_revision: edit.revision,
      action: 'set_dependencies',
      blocked_by: [second.id],
    })
    expect(dependencies.isError).toBe(false)
    const dependency = JSON.parse(text(dependencies)) as { revision: number }
    expect((await execute(ctx, lead, 'team_task_update', {
      task_id: first.id,
      expected_revision: dependency.revision,
      action: 'reassign',
      owner: childId,
    })).isError).toBe(true)

    const child = ctx.agents.get(childId)!
    child.inbox.clear()
    const { result: wait } = await startWait(ctx, child)
    let returned = false
    void wait.then(() => { returned = true })
    const created = await execute(ctx, lead, 'team_task_create', { subject: 'queued work', description: 'await explicit assignment' })
    expect(created.isError).toBe(false)
    expect(returned).toBe(false)
    expect(child.inbox.nextStep).toHaveLength(0)
    child.inject(createUserMessage({ content: [{ type: 'text', text: 'read the task board' }], source: { kind: 'user' } }))
    expect(JSON.parse(text(await wait))).toEqual({ timedOut: false })

    await childActivation.dispose()
    await waitNoAgent(ctx, childId)
  })

  it('distinguishes an agent named unowned from tasks without an owner', async () => {
    const { ctx, lead } = await setup(['hang'])
    const child = await ctx.subagents.startActivation({
      provider: 'spawn', name: 'unowned', label: 'Worker', parent: lead,
      prompt: [{ type: 'text', text: 'wait' }], signal: SIGNAL, delivery: 'caller',
    })
    await waitRunning(ctx, child.childId)
    const assigned = await ctx.agentTeams.createTask(lead, { subject: 'Assigned', description: 'Owned work' })
    const pending = await ctx.agentTeams.createTask(lead, { subject: 'Pending', description: 'Unowned work' })
    const result = await execute(ctx, lead, 'team_task_update', {
      task_id: assigned.id, expected_revision: assigned.revision, action: 'reassign', owner: 'unowned',
    })
    expect(result.isError, text(result)).toBe(false)
    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', { owner: 'unowned' })))).toMatchObject({ tasks: [{ id: assigned.id }] })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', { unowned: true })))).toMatchObject({ tasks: [{ id: pending.id }] })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', { unowned: false })))).toMatchObject({ tasks: [{ id: assigned.id }] })
    expect((await execute(ctx, lead, 'team_task_list', { owner: 'unowned', unowned: true })).isError).toBe(true)
    await child.dispose()
  })

  it('reads and edits saved owner names without traversing descendant Sessions', async () => {
    const { ctx, lead } = await setup([])
    const created = await ctx.agentTeams.createTask(lead, { subject: 'Review', description: 'Saved ownership' })
    const { ready: _ready, writeScopeWarnings: _warnings, ...saved } = created
    lead.session.append('team/task', {
      version: 2, teamId: TeamId(lead.id),
      task: { ...saved, revision: 2, ownerId: SessionId('cold-worker'), ownerName: 'reviewer/checker' },
    })
    const lookup = vi.spyOn(ctx.subagents, 'listDescendants').mockRejectedValue(new Error('catalog unavailable'))
    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_get', { task_id: created.id })))).toMatchObject({ owner: 'reviewer/checker' })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_list', {})))).toMatchObject({ tasks: [{ owner: 'reviewer/checker' }] })
    const edited = await execute(ctx, lead, 'team_task_update', {
      task_id: created.id, expected_revision: 2, action: 'edit', subject: 'Edited',
    })
    expect(edited.isError, text(edited)).toBe(false)
    expect(JSON.parse(text(edited))).toMatchObject({ subject: 'Edited', owner: 'reviewer/checker' })
    expect(lookup).not.toHaveBeenCalled()
  })

  it('names a historical task owner by its Session id', async () => {
    const { ctx, lead } = await setup([])
    const task = await ctx.agentTeams.createTask(lead, { subject: 'Review', description: 'Read old ownership' })
    const { ready: _ready, writeScopeWarnings: _warnings, ...saved } = task
    lead.session.append('team/task', {
      version: 2, teamId: TeamId(lead.id),
      task: { ...saved, revision: 2, ownerId: SessionId('missing-worker') },
    })
    expect(JSON.parse(text(await execute(ctx, lead, 'team_task_get', { task_id: task.id }))))
      .toMatchObject({ owner: 'missing-worker' })
  })

  it('edits a task whose historical owner is outside the readable catalogs', async () => {
    const { ctx, lead } = await setup([])
    const created = await ctx.agentTeams.createTask(lead, { subject: 'Review', description: 'Read old ownership' })
    const { ready: _ready, writeScopeWarnings: _warnings, ...saved } = created
    lead.session.append('team/task', {
      version: 2, teamId: TeamId(lead.id),
      task: { ...saved, revision: 2, ownerId: SessionId('unobserved-worker') },
    })
    lead.session.append('subagent/catalog', {
      version: 0, childId: SessionId('unreadable-branch'), childCreatedAt: 1,
      mode: 'continuable', label: 'Historical branch',
    })
    const task = ctx.agentTeams.getTask(lead, created.id)
    const result = await execute(ctx, lead, 'team_task_update', {
      task_id: task.id, expected_revision: task.revision, action: 'edit', subject: 'Edited',
    })
    expect(result.isError).toBe(false)
    expect(JSON.parse(text(result))).toMatchObject({ subject: 'Edited', owner: 'unobserved-worker' })
    expect(ctx.agentTeams.getTask(lead, task.id)).toMatchObject({ subject: 'Edited', revision: task.revision + 1 })
    expect(lead.session.ownEvents().filter(event => event.type === 'team/task')).toHaveLength(3)
  })

  it.each([false, true])('rejects historical roster assignments without a readable continuable target (cataloged: %s)', async (cataloged) => {
    const { ctx, lead } = await setup([])
    const id = SessionId('historical-worker')
    for (const phase of ['provisioning', 'active'] as const) lead.session.append('team/member', {
      version: 2, teamId: TeamId(lead.id),
      member: { id, name: 'old-name', description: 'historical member', provider: 'spawn', context: 'fresh', phase },
    })
    if (cataloged) lead.session.append('subagent/catalog', { version: 0, childId: id, childCreatedAt: 1, mode: 'continuable', label: 'Old child' })
    const created = await ctx.agentTeams.createTask(lead, { subject: 'Review', description: 'Review history' })
    expect((await execute(ctx, lead, 'team_task_update', {
      task_id: created.id, expected_revision: created.revision, action: 'reassign',
      owner: id,
    })).isError).toBe(true)
    expect((await execute(ctx, lead, 'send_message', { agent: id, message: 'hello' })).isError).toBe(true)
    expect((await execute(ctx, lead, 'team_task_update', {
      task_id: created.id, expected_revision: 2, action: 'reassign', owner: 'missing',
    })).isError).toBe(true)
  })

  it('removes and reinstalls every Team registration across plugin HMR without stopping the child', async () => {
    const { ctx, lead, fiber } = await setup(['hang'])
    const childActivation = await spawn(ctx, lead, 'hmr-worker', 'wait')
    const childId = childActivation.childId
    const child = await waitRunning(ctx, childId)

    await fiber.dispose()
    for (const agent of [lead, child]) {
      const assembled = await assembly(ctx, agent)
      expect(teamTools(assembled)).toEqual([])
      expect(assembled.contexts.some(context => context.name === 'team:identity')).toBe(false)
    }
    expect(ctx.agents.get(childId)).toBe(child)

    const replacement = await ctx.plugin(toolTeam)
    for (const agent of [lead, child]) {
      const assembled = await assembly(ctx, agent)
      expect(teamTools(assembled)).toEqual(TEAM_TOOLS)
      expect(assembled.contexts.filter(context => context.name === 'subagent:identity')).toHaveLength(1)
      expect(renderContextSnapshot(assembled)).toContain(agent === lead ? leadIdentity(lead) : agentIdentity('agent-1'))
    }
    expect(child.status).toBe('running')
    await childActivation.dispose()
    await waitNoAgent(ctx, childId)
    await replacement.dispose()
  })

  it('installs tools once when the plugin activates as Agent creation dispatch begins', async () => {
    const { ctx, lead, fiber } = await setup([])
    await fiber.dispose()
    const id = SessionId('install-during-publication')
    const stop = ctx.on('internal/dispatch', (_type, name) => {
      if (name === 'agent/created' && ctx.agents.get(id) !== undefined) toolTeam.apply(ctx)
    })
    try {
      const child = await ctx.agents.create({
        sessionId: id, agentOptions: { provider: 'mock', model: 'mock' },
        meta: { origin: 'subagent', parentSession: lead.id },
        setup: (_ctx, agent) => { bindSubagentActivation(ctx, agent, lead) },
      })
      expect(teamTools(await assembly(ctx, child.agent))).toEqual(TEAM_TOOLS)
      const created = await execute(ctx, child.agent, 'team_task_create', {
        subject: 'installed once', description: 'created during the publication overlap',
      })
      expect(created.isError).toBe(false)
      expect(JSON.parse(text(created))).toMatchObject({ id: 'task-1', revision: 1 })
      await child.dispose()
    } finally {
      stop()
    }
  })

  it('leaves all current waits pending when tasks change', async () => {
    const { ctx, lead, adapter } = await setup([])
    const child = await ctx.agents.create({
      sessionId: SessionId('waiting-child'), agentOptions: { provider: 'mock', model: 'mock' },
      meta: { origin: 'subagent', parentSession: lead.id },
      setup: (_ctx, agent) => { bindSubagentActivation(ctx, agent, lead) },
    })
    const unrelated = await ctx.agents.create({
      sessionId: SessionId('unrelated-root'), agentOptions: { provider: 'mock', model: 'mock' },
    })
    vi.useFakeTimers()
    const first = await startWait(ctx, lead)
    const second = await startWait(ctx, lead)
    const descendant = await startWait(ctx, child.agent)
    const separate = await startWait(ctx, unrelated.agent)
    const committed = await execute(ctx, lead, 'team_task_create', { subject: 'committed', description: 'persist shared work' })
    expect(committed.isError).toBe(false)
    expect(vi.getTimerCount()).toBe(4)
    for (const agent of [lead, child.agent, unrelated.agent]) {
      expect(agent.inbox.nextStep).toHaveLength(0)
      expect(agent.inbox.nextTurn).toHaveLength(0)
      expect(agent.status).toBe('idle')
    }
    expect(adapter.requests).toHaveLength(0)
    const later = await startWait(ctx, lead)
    await vi.advanceTimersByTimeAsync(10_000)
    for (const result of await Promise.all([first.result, second.result, descendant.result, separate.result, later.result])) {
      expect(result).toMatchObject({ isError: false, value: { timedOut: true } })
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps waiting across Team mode changes until its own inbox receives input', async () => {
    const { ctx, lead, adapter } = await setup([])
    vi.useFakeTimers()
    const waiting = await startWait(ctx, lead)
    let returned = false
    void waiting.result.then(() => { returned = true })
    for (const enabled of [false, true]) {
      await ctx.agentTeams.setEnabled(lead, enabled)
      expect(lead.inbox.nextStep).toHaveLength(0)
      expect(lead.inbox.nextTurn).toHaveLength(0)
      expect(lead.status).toBe('idle')
      expect(returned).toBe(false)
    }
    expect(adapter.requests).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(returned).toBe(false)
    lead.inject(createUserMessage({ content: [{ type: 'text', text: 'read the task board' }], source: { kind: 'user' } }))
    expect(await waiting.result).toMatchObject({ isError: false, value: { timedOut: false } })
  })

  it('keeps waiting across successful and failed task flushes', async () => {
    const { ctx, lead } = await setup([])
    vi.useFakeTimers()
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      entered.resolve(undefined)
      await release.promise
      return await flush(session)
    })
    const waiting = await startWait(ctx, lead)
    let returned = false
    void waiting.result.then(() => { returned = true })
    const creating = execute(ctx, lead, 'team_task_create', { subject: 'committed', description: 'wait for flush' })
    try {
      await entered.promise
      await vi.advanceTimersByTimeAsync(9_999)
      expect(returned).toBe(false)
    } finally {
      release.resolve(undefined)
      expect((await creating).isError).toBe(false)
    }
    await vi.advanceTimersByTimeAsync(1)
    expect(await waiting.result).toMatchObject({ isError: false, value: { timedOut: true } })
    const afterCommit = await startWait(ctx, lead)
    vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('storage unavailable'))
    const failed = await execute(ctx, lead, 'team_task_create', { subject: 'failed', description: 'flush fails' })
    expect(failed.isError).toBe(true)
    expect(text(failed)).toContain('task "task-2" revision 1 is visible, but persistence was not confirmed')
    expect(text(failed)).toContain('read the task before retrying')
    expect(ctx.agentTeams.listTasks(lead).map(task => task.subject)).toEqual(['committed', 'failed'])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await afterCommit.result).toMatchObject({ isError: false, value: { timedOut: true } })
  })

  it('rolls back plugin registrations after a global tool collision', async () => {
    const { ctx, lead, fiber } = await setup([])
    await fiber.dispose()
    ctx.tools.register(defineContentToolFixture({
      name: 'team_task_create',
      description: 'intentional collision',
      parameters: {},
      async execute() { return [{ type: 'text', text: 'collision' }] },
    }))

    await expect(ctx.plugin(toolTeam)).rejects.toThrow(/already registered/u)
    const assembled = await assembly(ctx, lead)
    expect(teamTools(assembled)).toEqual(['team_task_create'])
    expect(assembled.contexts.some(context => context.name === 'team:identity')).toBe(false)
  })

  it('applies directly without configuration and rejects removed configuration keys', async () => {
    const { ctx, lead, fiber } = await setup([])
    await fiber.dispose()
    for (const key of ['interrupt', 'freshProvider', 'forkProvider']) {
      expect(() => { toolTeam.apply(ctx, { [key]: 'x' }) }).toThrow(`${key} is no longer supported`)
    }
    toolTeam.apply(ctx)
    expect(teamTools(await assembly(ctx, lead))).toEqual(TEAM_TOOLS)
  })

  it('switches tools and guidance for one tree while preserving tasks and ordinary subagents', async () => {
    const { ctx, lead } = await setup(['hang'], false)
    const other = await ctx.agents.create({ sessionId: SessionId('other-root'), agentOptions: { provider: 'mock', model: 'mock' } })
    const child = await waitRunning(ctx, (await spawn(ctx, lead, 'ordinary-child', 'work')).childId)
    for (const agent of [lead, child, other.agent]) expect(teamTools(await assembly(ctx, agent))).toEqual([])
    await ctx.agentTeams.setEnabled(lead, true)
    for (const agent of [lead, child]) expect(teamTools(await assembly(ctx, agent))).toEqual(TEAM_TOOLS)
    expect(teamTools(await assembly(ctx, other.agent))).toEqual([])
    const task = await ctx.agentTeams.createTask(child, { subject: 'shared', description: 'retained' })
    await ctx.agentTeams.setEnabled(lead, false)
    for (const agent of [lead, child]) {
      const built = await assembly(ctx, agent)
      expect(teamTools(built)).toEqual([])
      expect(renderPrompt(built)).not.toContain('A shared task board is available')
    }
    expect(ctx.agents.get(child.id)).toBe(child)
    expect(() => ctx.agentTeams.listTasks(child)).toThrow('enable Agent Teams')
    await ctx.agentTeams.setEnabled(lead, true)
    expect(ctx.agentTeams.listTasks(lead)).toEqual([task])
    ctx.subagents.interruptByUser(child.id)
    await waitNoAgent(ctx, child.id)
    await other.dispose()
  })

  it('updates model requests when Team is switched on and off within a turn', async () => {
    const { ctx, lead, adapter } = await setup([
      toolCallResponse('before-team', 'list_agents', {}),
      toolCallResponse('with-team', 'list_agents', {}),
      textResponse('ordinary work continues'),
    ], false)
    ctx.on('tools/execute', async (exec, next) => {
      const result = await next()
      await ctx.agentTeams.setEnabled(lead, exec.callId === 'before-team')
      return result
    })

    await runTurn(lead, 'Inspect agents while switching Team on and off.')

    expect(adapter.requests).toHaveLength(3)
    const ordinaryTools = adapter.requests[0]!.tools
    for (const [index, request] of adapter.requests.entries()) {
      const enabled = index === 1
      const tools = request.tools ?? []
      expect(tools.filter(tool => TEAM_TOOLS.includes(tool.name)).map(tool => tool.name).sort())
        .toEqual(enabled ? TEAM_TOOLS : [])
      expect(tools.filter(tool => !TEAM_TOOLS.includes(tool.name))).toEqual(ordinaryTools)
      const system = request.messages.find(message => message.role === 'system')
      const prompt = system?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
      expect(prompt?.includes('A shared task board is available')).toBe(enabled)
      expect(prompt?.includes('record expected write scopes on shared tasks')).toBe(enabled)
      expect(runtimeContextText(request)).toContain(leadIdentity(lead))
      const contexts = request.messages.findLast(message => message.source?.kind === 'runtime-context')?.source
      const initial = adapter.requests[0]!.messages.findLast(message => message.source?.kind === 'runtime-context')?.source
      expect(contexts).toEqual(initial)
    }
  })

  it('keeps tools consistent with an appended selection if flushing fails, and permits retry', async () => {
    const { ctx, lead } = await setup([], false)
    const failure = new Error('storage unavailable')
    vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(failure)
    await expect(ctx.agentTeams.setEnabled(lead, true)).rejects.toBe(failure)
    expect(teamTools(await assembly(ctx, lead))).toEqual(TEAM_TOOLS)
    await ctx.agentTeams.setEnabled(lead, true)
    expect(lead.session.ownEvents().filter(event => event.type === 'team/mode')).toHaveLength(1)
  })

  it('finishes an admitted task mutation after Team is disabled', async () => {
    const { ctx, lead } = await setup([])
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const flush = ctx.sessions.flush.bind(ctx.sessions)
    vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      entered.resolve(undefined)
      await release.promise
      return await flush(session)
    })
    const creating = execute(ctx, lead, 'team_task_create', { subject: 'started', description: 'finishes after off' })
    await entered.promise
    const disabling = ctx.agentTeams.setEnabled(lead, false)
    try {
      expect(ctx.agentTeams.isEnabled(lead)).toBe(false)
      await disabling
      const built = await assembly(ctx, lead)
      expect(teamTools(built)).toEqual([])
      expect(renderPrompt(built)).not.toContain('A shared task board is available')
      expect(renderContextSnapshot(built)).toContain(leadIdentity(lead))
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([creating, disabling])
    }
    const result = await creating
    expect(result.isError).toBe(false)
    expect(JSON.parse(text(result))).toMatchObject({ subject: 'started' })
    await ctx.agentTeams.setEnabled(lead, true)
    expect(ctx.agentTeams.listTasks(lead)).toEqual([expect.objectContaining({ subject: 'started' })])
  })

  it('reads Team mode for prompts independently of tool restrictions', async () => {
    const { ctx, lead } = await setup([])
    lead.ctx.tools.restrict({ deny: TEAM_TOOLS })
    const built = await assembly(ctx, lead)
    expect(teamTools(built)).toEqual([])
    expect(renderPrompt(built)).toContain('A shared task board is available')
    expect(renderContextSnapshot(built)).toContain(leadIdentity(lead))
    await ctx.agentTeams.setEnabled(lead, false)
    const disabled = await assembly(ctx, lead)
    expect(renderPrompt(disabled)).not.toContain('A shared task board is available')
    expect(renderContextSnapshot(disabled)).toContain(leadIdentity(lead))
  })

  it('keeps step admission stable while task operations enforce the current mode', async () => {
    const { ctx, lead } = await setup([], false)
    const resolve = () => ctx.tools.resolve({ agent: lead, modelSelection: { provider: 'mock', model: 'mock' }, signal: SIGNAL })
    const disabled = await resolve()
    await ctx.agentTeams.setEnabled(lead, true)
    const enabled = await resolve()
    const input = {
      agent: lead, name: 'team_task_list', arguments: {}, signal: SIGNAL,
      callId: ToolCallId('admitted-before-mode-change'),
    }
    try {
      expect((await executeToolFixture(ctx, { ...input, toolSet: disabled })).error?.info?.code).toBe('UNKNOWN_TOOL')
      expect((await executeToolFixture(ctx, { ...input, toolSet: enabled })).isError).toBe(false)
      await ctx.agentTeams.setEnabled(lead, false)
      expect(ctx.tools.schemas(lead, enabled).map(tool => tool.name)).toEqual(expect.arrayContaining(TEAM_TOOLS))
      expect((await executeToolFixture(ctx, { ...input, toolSet: enabled })).error?.info?.code).toBe('TEAM_DISABLED')
      expect((await execute(ctx, lead, 'team_task_list', {})).error?.info?.code).toBe('UNKNOWN_TOOL')
    } finally {
      disabled.dispose()
      enabled.dispose()
    }
  })

  it('installs Team scope before a cold-resumed teammate request', async () => {
    const { ctx, lead, adapter } = await setup([textResponse('first'), textResponse('lead received settlement'), 'hang'])
    const childActivation = await spawn(ctx, lead, 'cold-worker', 'finish once')
    const childId = childActivation.childId
    await waitNoAgent(ctx, childId)
    await vi.waitFor(() => {
      expect(adapter.requests.filter(request => request.sessionId === lead.id)).toHaveLength(1)
    })
    await lead.whenIdle()

    await ctx.subagents.sendMessage(lead, childId, [{ type: 'text', text: 'resume with Team scope' }], { signal: SIGNAL })
    const resumed = await waitRunning(ctx, childId)
    expect(teamTools(await assembly(ctx, resumed))).toEqual(TEAM_TOOLS)
    expect(renderContextSnapshot(await assembly(ctx, resumed))).toContain(agentIdentity('agent-1'))
    const childRequests = () => adapter.requests.filter(request => request.sessionId === childId)
    await vi.waitFor(() => { expect(childRequests()).toHaveLength(2) })
    const firstMessages = childRequests()[0]!.messages
    expect(childRequests()[1]!.messages.slice(0, firstMessages.length)).toEqual(firstMessages)
    await ctx.subagents.drainDescendants([lead])
    await waitNoAgent(ctx, childId)
  })

  it('keeps Team tools absent while an orphaned subagent continues ordinary work', async () => {
    const { ctx, lead, adapter } = await setup([
      textResponse('child done'), textResponse('parent received settlement'), textResponse('independent work done'),
    ])
    const parent = await ctx.agents.create({
      sessionId: SessionId('temporary-parent'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const childActivation = await spawn(ctx, parent.agent, 'orphan', 'finish')
    const childId = childActivation.childId
    await waitNoAgent(ctx, childId)
    await vi.waitFor(() => { expect(adapter.requests.filter(request => request.sessionId === parent.agent.id)).toHaveLength(1) })
    await parent.agent.whenIdle()
    await parent.dispose()
    const orphan = await ctx.agents.resume({
      resumeSessionId: childId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const result = await execute(ctx, orphan.agent, 'team_task_list', {})
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('unknown tool')
    await runTurn(orphan.agent, 'continue ordinary work')
    const request = adapter.requests.findLast(request => request.sessionId === childId)!
    expect(teamTools(await assembly(ctx, orphan.agent))).toEqual([])
    expect(runtimeContextText(request)).not.toContain('You are a teammate in the Team')
    const source = request.messages.findLast(message => message.source?.kind === 'runtime-context')?.source
    if (source?.kind !== 'runtime-context' || source.form !== 'snapshot') throw new Error('expected runtime context snapshot')
    const identity = source.sections.find(section => section.name === 'subagent:identity')?.text
    expect(identity).toContain(`Your agent id is ${JSON.stringify(childId)}.`)
    expect(identity).toContain('Your subagent tree root is unavailable. Continue independent work;')
    expect(runtimeContextText(request)).not.toContain('To message other agents')
    expect(orphan.agent.session.ownEvents().some(event => event.type === 'assistant/message'
      && event.data.message.content.some(block => block.type === 'text' && block.text === 'independent work done'))).toBe(true)
    await ctx.agentTeams.setEnabled(lead, false)
    expect(teamTools(await assembly(ctx, orphan.agent))).toEqual([])
    await orphan.dispose()
  })

  it.each([
    new Error('root lookup failed'),
    new SubagentError('root lookup failed', 'INTERNAL_FAILURE'),
  ])('propagates unexpected identity lookup failures: %s', async (failure) => {
    const { ctx, lead } = await setup([])
    vi.spyOn(ctx.subagents, 'rootOf').mockImplementation(() => { throw failure })
    await expect(assembly(ctx, lead)).rejects.toMatchObject({ code: 'TOOL_ACTIVATION_FAILED', cause: failure })
    await expect(ctx.systemPrompt.assemble({ scope: lead, agent: lead })).rejects.toBe(failure)
  })

  it('omits Team guidance when its root is unavailable', async () => {
    const { ctx, lead } = await setup([])
    const unavailable = (): never => { throw new SubagentError('Team root is unavailable', 'UNAUTHORIZED') }
    vi.spyOn(ctx.subagents, 'rootOf').mockImplementation(unavailable)
    vi.spyOn(ctx.subagents, 'namesOf').mockImplementation(unavailable)
    const context = renderContextSnapshot(await assembly(ctx, lead))
    expect(context).toContain('Your subagent tree root is unavailable. Continue independent work;')
    expect(context).not.toContain('You are a teammate in the Team')
  })

  it('fails safely without a calling Agent and has the function-plugin export shape', async () => {
    const { ctx } = await setup([])
    const result = await execute(ctx, undefined, 'team_task_list', {})
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('unknown tool "team_task_list"')
    expect('default' in toolTeam).toBe(false)
    expect(toolTeam.name).toBe('tool-agent-team')
    expect(toolTeam.inject).toEqual(['agentTeams', 'subagents', 'tools', 'systemPrompt'])
  })
})
