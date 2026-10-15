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
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { renderPrompt, renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import * as ToolSubagentControl from '@deepseek-ai/dsh-tool-subagent-control'
import * as ToolSubagentListAgents from '@deepseek-ai/dsh-tool-subagent-control/list-agents'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { serialize } from '@deepseek-ai/dsh-llm-deepseek/src/serialize.ts'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { mountWorkingDirectoryFixture } from '../../../subagent/subagent/tests/working-directory-fixture.ts'
import TeamService from '../../agent-team/src/index.ts'
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
  'wait_agent',
]
const leadIdentity = (agent: Agent): string => `You are the Team Lead. Your agent id is ${JSON.stringify(agent.id)}.`

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
  for (const ctx of contexts) await ctx.fiber.dispose()
  contexts.clear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup(script: ConstructorParameters<typeof MockAdapter>[0]) {
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
  await ctx.plugin(ToolSubagentListAgents)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  await ctx.plugin(TeamService)
  const fiber = await ctx.plugin(toolTeam)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const lead = await ctx.agentLoop.create(SessionId('tool-team-lead'), { provider: 'mock', model: 'mock' })
  return { ctx, lead, fiber, adapter }
}

function execute(
  ctx: Context,
  agent: Agent | undefined,
  name: string,
  args: unknown,
  signal: AbortSignal = SIGNAL,
) {
  return ctx.tools.execute({
    callId: ToolCallId(`team-call-${++callNumber}`),
    name,
    arguments: args,
    signal,
    ...agent === undefined ? {} : { agent },
  })
}

function text(result: Awaited<ReturnType<typeof execute>>): string {
  return result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

/** Start a continuable child of the Lead with a task description. */
async function spawn(ctx: Context, lead: Agent, description: string | undefined, prompt: string, provider = 'spawn'): Promise<SessionId> {
  const started = await ctx.subagents.startActivation({
    provider,
    label: `${description ?? 'shared'} task`,
    request: { prompt: [{ type: 'text', text: prompt }], parent: lead },
    signal: SIGNAL,
    delivery: 'parent',
  })
  return started.childId
}

async function assembly(ctx: Context, agent: Agent) {
  const scope = scopeOf(agent.ctx)
  if (scope === undefined) throw new Error('expected Agent scope')
  return ctx.systemPrompt.assemble({ scope })
}

function teamTools(assembled: Awaited<ReturnType<typeof assembly>>): string[] {
  return assembled.tools.map(schema => schema.name).filter(name => TEAM_TOOLS.includes(name)).sort()
}

function teammateIdentity(lead: Agent): string {
  return `You are a teammate in the Team led by agent ${JSON.stringify(lead.id)}.`
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

function interrupt(ctx: Context, lead: Agent, target: SessionId): void {
  ctx.subagents.interrupt(target, { kind: 'ancestor', agent: lead })
}

describe('dsh-tool-team', () => {
  it('installs task and wait tools with the shared policy for the Lead and every subagent below it', async () => {
    const { ctx, lead } = await setup(['hang', 'hang'])
    const leadAssembly = await assembly(ctx, lead)
    expect(teamTools(leadAssembly)).toEqual(TEAM_TOOLS)
    const leadPrompt = renderPrompt(leadAssembly)
    expect(leadPrompt).toContain('Teammates are subagents.')
    expect(leadPrompt).toContain('FS_STALE_VERSION')
    expect(leadPrompt).toContain('Task readiness never starts an owner')
    expect(leadPrompt).toContain('returns noProgress immediately')
    expect(renderContextSnapshot(leadAssembly)).toContain(leadIdentity(lead))
    expect(leadAssembly.tools.map(schema => schema.name)).not.toContain('spawn_teammate')
    // Messaging, listing, and interruption stay the global subagent controls.
    for (const name of ['send_message', 'list_agents', 'interrupt_agent']) {
      expect(ctx.tools.get(name, scopeOf(lead.ctx))).toBe(ctx.tools.get(name))
    }

    const namedId = await spawn(ctx, lead, 'reviewer', 'stay available')
    const unnamedId = await spawn(ctx, lead, undefined, 'stay available too')
    for (const id of [namedId, unnamedId]) {
      const child = await waitRunning(ctx, id)
      const childAssembly = await assembly(ctx, child)
      expect(teamTools(childAssembly)).toEqual(TEAM_TOOLS)
      expect(renderPrompt(childAssembly)).toBe(leadPrompt)
      expect(renderContextSnapshot(childAssembly)).toContain(teammateIdentity(lead))
      expect(ctx.tools.get('send_message', scopeOf(child.ctx))).toBe(ctx.tools.get('send_message'))
    }
    interrupt(ctx, lead, namedId)
    interrupt(ctx, lead, unnamedId)
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
    const childId = await spawn(ctx, lead, 'reviewer', 'Review the work', provider)
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
    expect(runtimeContextText(adapter.requests[1]!)).toContain(teammateIdentity(lead))
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
    await runTurn(handle.agent, 'Continue independently')
    const parentRequest = serializeRequest(adapter.requests[0]!)
    const childRequest = serializeRequest(adapter.requests[1]!)
    expect(childRequest.tools).toEqual(parentRequest.tools)
    expect(childRequest.messages.slice(0, parentRequest.messages.length)).toEqual(parentRequest.messages)
    expect(childRequest.messages.at(-1)?.content).toContainEqual({ type: 'text', text: 'Continue independently' })
    expect(runtimeContextText(adapter.requests[1]!)).toContain(leadIdentity(handle.agent))
    expect(JSON.stringify(childRequest.messages)).not.toContain('system-reminder')
    expect(handle.agent.session.snapshotEvents().slice(0, seed.length)).toEqual(seed)
    expect(ctx.agentTeams.membership(handle.agent)).toMatchObject({ role: 'lead' })
    await handle.dispose()
  })

  it.each([undefined, 'in-history'] as const)('appends current Lead identity to a teammate fork with update mode %s', async (systemPromptUpdate) => {
    const { ctx, lead, adapter } = await setup([textResponse('review done'), textResponse('lead notified'), textResponse('fork answer')])
    if (systemPromptUpdate !== undefined) adapter.systemPromptUpdate = systemPromptUpdate
    const teammateId = await spawn(ctx, lead, 'reviewer', 'Review the work')
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
    const childId = await spawn(ctx, lead, 'reviewer', 'Review the work')
    await waitNoAgent(ctx, childId)
    for (const request of adapter.requests.filter(request => request.sessionId === childId)) {
      const snapshots = request.messages.filter(message => message.source?.kind === 'runtime-context')
      expect(snapshots).toHaveLength(1)
      expect(runtimeContextText(request)).toContain(teammateIdentity(lead))
    }
    await using persisted = await ctx.sessionPersistence.open(childId, 'read')
    const { events } = await persisted.read()
    expect(events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'runtime-context')).toHaveLength(2)
  })

  it('keeps required Team identities when optional runtime context is suppressed', async () => {
    const { ctx, lead, adapter } = await setup([textResponse('worker done')])
    ctx.systemPrompt.suppressRuntimeContext()
    const childId = await spawn(ctx, lead, 'reviewer', 'Review the work')
    await waitNoAgent(ctx, childId)
    expect(renderContextSnapshot(await assembly(ctx, lead))).toContain(leadIdentity(lead))
    expect(runtimeContextText(adapter.requests[0]!)).toContain(teammateIdentity(lead))
  })

  it('returns actionable no-progress output and renders structured wait cancellation', async () => {
    const inactiveSetup = await setup([textResponse('worker done')])
    const inactiveId = await spawn(inactiveSetup.ctx, inactiveSetup.lead, 'inactive-worker', 'finish')
    await waitNoAgent(inactiveSetup.ctx, inactiveId)
    const noProgress = await execute(inactiveSetup.ctx, inactiveSetup.lead, 'wait_agent', { timeout_ms: 3_600_000 })
    expect(noProgress.isError).toBe(false)
    expect(JSON.parse(text(noProgress))).toEqual({
      timedOut: false,
      noProgress: {
        reason: 'no-active-peer',
        message: 'No other Team member is running. wait_agent cannot make progress or wake inactive teammates. Re-list with list_agents and team_task_list, then use send_message to wake a required inactive direct contact before waiting again; coordinate deeper members through their parent.',
      },
    })
    for (const timeout_ms of [9_999, 3_600_001, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = await execute(inactiveSetup.ctx, inactiveSetup.lead, 'wait_agent', { timeout_ms })
      expect(invalid.isError).toBe(true)
      expect(text(invalid)).toContain('timeoutMs must be an integer from 10000 through 3600000')
    }

    const activeSetup = await setup(['hang'])
    const activeId = await spawn(activeSetup.ctx, activeSetup.lead, 'active-worker', 'wait')
    await waitRunning(activeSetup.ctx, activeId)
    const controller = new AbortController()
    const waiting = execute(activeSetup.ctx, activeSetup.lead, 'wait_agent', { timeout_ms: 10_000 }, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 0))
    controller.abort({ kind: 'user' })
    const aborted = await waiting
    expect(aborted.isError).toBe(true)
    expect(text(aborted)).toBe("Error: wait_agent aborted: { kind: 'user' }")
    interrupt(activeSetup.ctx, activeSetup.lead, activeId)
    await waitNoAgent(activeSetup.ctx, activeId)
  })

  it('adapts task CAS operations and waits to canonical JSON', async () => {
    const { ctx, lead } = await setup(['hang'])
    const childId = await spawn(ctx, lead, 'json-worker', 'wait')
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
    expect(JSON.parse(text(claimed))).toMatchObject({ status: 'in_progress', ownerId: childId })
    const stale = await execute(ctx, lead, 'team_task_update', {
      task_id: task.id,
      expected_revision: task.revision,
      action: 'delete',
    })
    expect(stale.isError).toBe(true)
    expect(text(stale)).toContain('stale team task')

    const wait = execute(ctx, lead, 'wait_agent', { timeout_ms: 10_000 })
    const completedCall = new Promise<Awaited<ReturnType<typeof execute>>>((resolve, reject) => {
      setTimeout(() => {
        void execute(ctx, child, 'team_task_update', {
          task_id: task.id,
          expected_revision: 2,
          action: 'complete',
        }).then(resolve, reject)
      }, 0)
    })
    await expect(wait).resolves.toMatchObject({ isError: false })
    expect((await completedCall).isError).toBe(false)

    interrupt(ctx, lead, childId)
    await waitNoAgent(ctx, childId)
  })

  it('adapts optional task filters, mutations, pagination, and default waiting', async () => {
    const { ctx, lead } = await setup(['hang'])
    const childId = await spawn(ctx, lead, 'fork-worker', 'stay active', 'fork')
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
      owner: 'unowned', limit: 1,
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

    const wait = execute(ctx, lead, 'wait_agent', {})
    const wake = new Promise<Awaited<ReturnType<typeof execute>>>((resolve, reject) => {
      setTimeout(() => {
        void execute(ctx, lead, 'team_task_create', {
          subject: 'wake', description: 'wake default wait',
        }).then(resolve, reject)
      }, 0)
    })
    expect((await wait).isError).toBe(false)
    expect((await wake).isError).toBe(false)

    interrupt(ctx, lead, childId)
    await waitNoAgent(ctx, childId)
  })

  it('removes and reinstalls every scoped registration across plugin HMR without stopping the child', async () => {
    const { ctx, lead, fiber } = await setup(['hang'])
    const childId = await spawn(ctx, lead, 'hmr-worker', 'wait')
    const child = await waitRunning(ctx, childId)

    await fiber.dispose()
    for (const agent of [lead, child]) {
      const assembled = await assembly(ctx, agent)
      expect(teamTools(assembled)).toEqual([])
      expect(assembled.contexts.some(context => context.name === 'team:identity')).toBe(false)
    }
    expect(ctx.agents.get(childId)).toBe(child)

    const replacement = await ctx.plugin(toolTeam)
    for (const agent of [lead, child]) expect(teamTools(await assembly(ctx, agent))).toEqual(TEAM_TOOLS)
    expect(child.status).toBe('running')
    interrupt(ctx, lead, childId)
    await waitNoAgent(ctx, childId)
    await replacement.dispose()
  })

  it('rolls back partial scoped installation after a same-scope collision', async () => {
    const { ctx, lead, fiber } = await setup([])
    await fiber.dispose()
    lead.ctx.tools.register(defineContentToolFixture({
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

  it('installs Team scope before a cold-resumed teammate request', async () => {
    const { ctx, lead, adapter } = await setup([textResponse('first'), textResponse('lead received settlement'), 'hang'])
    const childId = await spawn(ctx, lead, 'cold-worker', 'finish once')
    await waitNoAgent(ctx, childId)
    await vi.waitFor(() => {
      expect(adapter.requests.filter(request => request.sessionId === lead.id)).toHaveLength(1)
    })
    await lead.whenIdle()

    await ctx.subagents.sendMessage(lead, childId, [{ type: 'text', text: 'resume with Team scope' }], { signal: SIGNAL })
    const resumed = await waitRunning(ctx, childId)
    expect(teamTools(await assembly(ctx, resumed))).toEqual(TEAM_TOOLS)
    expect(renderContextSnapshot(await assembly(ctx, resumed))).toContain(teammateIdentity(lead))
    const childRequests = () => adapter.requests.filter(request => request.sessionId === childId)
    await vi.waitFor(() => { expect(childRequests()).toHaveLength(2) })
    const firstMessages = childRequests()[0]!.messages
    expect(childRequests()[1]!.messages.slice(0, firstMessages.length)).toEqual(firstMessages)
    interrupt(ctx, lead, childId)
    await waitNoAgent(ctx, childId)
  })

  it('installs nothing for a subagent whose parent left the registry', async () => {
    const { ctx } = await setup([textResponse('child done')])
    const parent = await ctx.agents.create({
      sessionId: SessionId('temporary-parent'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const childId = await spawn(ctx, parent.agent, 'orphan', 'finish')
    await waitNoAgent(ctx, childId)
    await parent.dispose()
    const orphan = await ctx.agents.resume({
      resumeSessionId: childId,
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    expect(teamTools(await assembly(ctx, orphan.agent))).toEqual([])
    await orphan.dispose()
  })

  it('fails safely without a calling Agent and has the function-plugin export shape', async () => {
    const { ctx } = await setup([])
    const result = await execute(ctx, undefined, 'wait_agent', {})
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('unknown tool "wait_agent"')
    expect('default' in toolTeam).toBe(false)
    expect(toolTeam.name).toBe('tool-agent-team')
    expect(toolTeam.inject).toEqual(['agents', 'agentTeams', 'tools', 'systemPrompt'])
  })
})
