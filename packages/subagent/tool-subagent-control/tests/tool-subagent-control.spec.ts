import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { mountWorkingDirectoryFixture } from '../../subagent/tests/working-directory-fixture.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/types'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime, { SubagentError } from '@deepseek-ai/dsh-subagent'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as tool from '../src/index.ts'
import { parkParent } from './park-parent.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { loadStoredSession } from '../../subagent/tests/persistence-helpers.ts'
import { bindSubagentActivation } from '../../subagent/tests/manager-internals.ts'

/** One scripted response that may wait on a caller-released gate before streaming. */
interface GatedEntry {
  chunks: StreamChunk[]
  gate?: Promise<undefined>
}

/** Adapter whose entries can hold a model call open until the test releases it. */
class GatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private script: GatedEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (!entry) throw new Error('GatedAdapter: script exhausted')
    if (entry.gate) await entry.gate
    for (const chunk of entry.chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

const testToolSignal = new AbortController().signal

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

async function setupWith(adapter: MockAdapter | GatedAdapter, park = true) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-tool-subagent-control-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(AgentLoop, { agents: [] })
  await mountWorkingDirectoryFixture(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  const controlFiber = await ctx.plugin(tool)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = await ctx.agentLoop.create(brandString<SessionId>('parent'), { provider: 'mock', model: 'mock' })
  if (park) parkParent(ctx, parent)
  return { ctx, parent, adapter, controlFiber }
}

async function setup(script: ConstructorParameters<typeof MockAdapter>[0]) {
  return setupWith(new MockAdapter(script))
}

function text(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

let calls = 0
function callTool(
  ctx: Context,
  name: string,
  args: unknown,
  agent?: unknown,
  signal: AbortSignal = testToolSignal,
) {
  return executeToolFixture(ctx, {
    signal,
    callId: brandString<ToolCallId>(`call-${++calls}`),
    name,
    arguments: args,
    ...agent !== undefined ? { agent: agent as never } : {},
  })
}

/** Wait until a child's Activation released its handle. */
async function waitNoActivation(ctx: Context, childId: SessionId): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.agents.get(childId)).toBeUndefined()
  }, { timeout: 5_000 })
}

describe('dsh-tool-subagent-control', () => {
  it('registers send_message once, globally, with the two required parameters', async () => {
    const { ctx } = await setup([])
    const schemas = ctx.tools.schemas().filter(schema => schema.name === 'send_message')
    expect(schemas).toHaveLength(1)
    const props = (schemas[0]!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['agent', 'message'])
    // The continuable path has no Task, so the schema must not promise one.
    expect(schemas[0]!.description).not.toContain('job_output')
    expect(schemas[0]!.description).not.toContain('job id')
    expect(schemas[0]!.description).toContain('receives it at its next step')
    expect(props.agent).toMatchObject({
      description: 'The name of another agent in your subagent tree, as shown by list_agents.',
    })
  })

  it('keeps the send_message definition and ordering byte-identical in a fork child', async () => {
    const release = Promise.withResolvers<undefined>()
    const { ctx, parent, adapter } = await setupWith(new GatedAdapter([
      { chunks: textResponse('parent done') },
      { chunks: textResponse('child done'), gate: release.promise },
    ]), false)
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: 'parent work' }],
      source: { kind: 'user' },
    }))
    await parent.whenIdle()
    parkParent(ctx, parent)
    const started = await ctx.subagents.startActivation({
      delivery: 'parent',
      provider: 'fork',
      label: 'fork child',
      prompt: [{ type: 'text', text: 'fork task' }], parent,
      signal: testToolSignal,
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const child = ctx.agents.get(started.childId)
    if (child === undefined) throw new Error('expected a live fork child')

    const parentSchemas = ctx.tools.schemas(parent)
    const childSchemas = ctx.tools.schemas(child)
    expect(JSON.stringify(childSchemas)).toBe(JSON.stringify(parentSchemas))
    expect(childSchemas.map(schema => schema.name)).not.toContain('report')

    release.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    const promptIndex = loaded.events.findIndex(event => event.type === 'user/message'
      && event.data.content.some(block => block.type === 'text' && block.text === 'fork task'))
    expect(loaded.meta.isSeeded).toBe(true)
    expect(promptIndex).toBeGreaterThanOrEqual(loaded.inheritedEventCount)
    const prompt = loaded.events[promptIndex]
    if (prompt?.type !== 'user/message') throw new Error('expected the initial fork task')
    const texts = prompt.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
    expect(texts[0]).toBe('fork task')
    expect(texts[1]).toContain('Your final answer is delivered automatically')
    expect(texts[1]).not.toContain('send_message')
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('You are a subagent delegated by agent')
    expect(loaded.events.some(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context'
      && JSON.stringify(event.data.content).includes('You are a subagent delegated by agent'))).toBe(true)
    expect(adapter.requests[1]!.messages[0]).toEqual(adapter.requests[0]!.messages[0])
  })

  it('JSON-encodes identity ids in logged runtime context', async () => {
    const { ctx } = await setup([textResponse('child done')])
    const parent = await ctx.agentLoop.create(brandString<SessionId>('parent"\nagent'), { provider: 'mock', model: 'mock' })
    parkParent(ctx, parent)
    const started = await ctx.subagents.startActivation({
      delivery: 'parent',
      provider: 'spawn',
      label: 'encoded parent',
      prompt: [{ type: 'text', text: 'encoded task' }], parent,
      signal: testToolSignal,
    })
    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    const prompt = loaded.events.find(event => event.type === 'user/message' && event.data.source.kind === 'runtime-context'
      && event.data.content.some(block => block.type === 'text' && block.text.includes('You are a subagent delegated by agent')))
    if (prompt?.type !== 'user/message') throw new Error('expected logged communication context')
    const guidance = text(prompt.data)

    expect(started.name).toBe('agent-1')
    expect(guidance).toContain('You are a subagent delegated by agent "lead".\nYour name is "agent-1".\n'
      + 'The root agent of your collaboration tree is "lead".')
    expect(guidance).not.toContain(parent.id)
    expect(guidance).not.toContain(started.childId)
  })

  it.each([
    { name: 'send_message', instruction: 'To message other agents', other: 'Use list_agents' },
    { name: 'list_agents', instruction: 'Use list_agents', other: 'To message other agents' },
  ])('gates $name guidance independently in an agent scope', async ({ name, instruction, other }) => {
    const { ctx, parent } = await setup([])
    const { agent: child } = await ctx.agents.create({
      sessionId: brandString<SessionId>('communication-child'),
      meta: { origin: 'subagent', parentSession: parent.id },
      setup: (_ctx, agent) => { bindSubagentActivation(ctx, agent, parent) },
    })
    const communication = async () => renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: child, scope: child }))
    expect(await communication()).toContain(instruction)
    expect(await communication()).toContain(other)
    const off = child.ctx.tools.register(defineTool({
      name, description: 'A different tool.', parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: {} }, render: () => [] },
      execute: () => Promise.resolve({}),
    }))
    expect(await communication()).not.toContain(instruction)
    expect(await communication()).toContain(other)
    expect(await communication()).toContain('You are a subagent delegated by agent "lead".\nYour name is "communication-child".')
    off()
    expect(await communication()).toContain(instruction)
    child.ctx.tools.restrict({ deny: [name] })
    const toolSet = await ctx.tools.resolve({ agent: child, modelSelection: { provider: 'mock', model: 'mock' }, signal: testToolSignal })
    const filtered = renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: child, scope: child, toolSet }))
    expect(filtered).not.toContain(instruction)
    expect(filtered).toContain(other)
    toolSet.dispose()
  })

  it('keeps collaboration instructions when controls are mounted in an agent scope', async () => {
    const { ctx, parent, controlFiber } = await setup([])
    await controlFiber.dispose()
    await parent.ctx.plugin(tool)
    const context = renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: parent, scope: parent }))
    expect(context).toContain('To message other agents')
    expect(context).toContain('Use list_agents')
  })

  it('identifies independent roots and forks before their collaboration instructions', async () => {
    const { ctx, parent } = await setup([])
    const { agent: fork } = await ctx.agents.create({
      sessionId: brandString<SessionId>('ordinary-fork'), meta: { parentSession: parent.id },
    })
    for (const agent of [parent, fork]) {
      const built = await ctx.systemPrompt.assemble({ agent, scope: agent })
      expect(built.contexts.find(context => context.name === 'subagent:identity')?.text).toBe(
        'You are the root agent. Your name is "lead".\n\n'
        + 'To message other agents, use send_message({ agent: "<agent-name>", message: "..." }).\n'
        + 'Use list_agents({}) to find your collaborator agents and their names.',
      )
    }
    expect(renderContextSnapshot(await ctx.systemPrompt.assemble({}))).not.toContain('To message other agents')
  })

  it.each([
    new Error('root lookup failed'),
    new SubagentError('root data is unreadable', 'PERSISTENCE_UNAVAILABLE'),
  ])('propagates identity lookup errors other than an unavailable root: $message', async (error) => {
    const { ctx, parent } = await setup([])
    const lookup = vi.spyOn(ctx.subagents, 'namesOf').mockImplementation(() => { throw error })
    try {
      await expect(ctx.systemPrompt.assemble({ agent: parent, scope: parent })).rejects.toBe(error)
    } finally {
      lookup.mockRestore()
    }
  })

  it('retains the caller id when its subagent tree root is unavailable', async () => {
    const { ctx, parent } = await setup([])
    const lookup = vi.spyOn(ctx.subagents, 'namesOf').mockImplementation(() => {
      throw new SubagentError('root is unavailable', 'UNAUTHORIZED')
    })
    try {
      const context = renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: parent, scope: parent }))
      expect(context).toContain(`Your agent id is ${JSON.stringify(parent.id)}.`)
      expect(context).toContain('Your subagent tree root is unavailable. Continue independent work;')
      expect(context).not.toContain('To message other agents')
      expect(context).not.toContain('Use list_agents')
    } finally {
      lookup.mockRestore()
    }
  })

  it('keeps required identity while both discovery and messaging are filtered', async () => {
    const { ctx, parent } = await setup([])
    ctx.systemPrompt.suppressRuntimeContext()
    const available = await ctx.systemPrompt.assemble({ agent: parent, scope: parent })
    expect(available.tools.find(tool => tool.name === 'list_agents')?.description)
      .toContain('List your entire subagent tree')
    expect(renderContextSnapshot(available)).toContain('Use list_agents')
    expect(renderContextSnapshot(available)).toContain('To message other agents')
    parent.ctx.tools.restrict({ deny: ['send_message', 'list_agents'] })
    const toolSet = await ctx.tools.resolve({ agent: parent, modelSelection: { provider: 'mock', model: 'mock' }, signal: testToolSignal })
    const filtered = await ctx.systemPrompt.assemble({ agent: parent, scope: parent, toolSet })
    expect(filtered.tools.some(tool => tool.name === 'list_agents')).toBe(false)
    const context = renderContextSnapshot(filtered)
    expect(context).toContain('You are the root agent. Your name is "lead".')
    expect(context).not.toContain('Use list_agents')
    expect(context).not.toContain('To message other agents')
    toolSet.dispose()
  })

  it.each(['parent', 'caller'] as const)('keeps %s result delivery independent of messaging tools', async (delivery) => {
    const { ctx, parent, adapter, controlFiber } = await setup([textResponse('child result')])
    await controlFiber.dispose()
    const followup = vi.spyOn(parent, 'followup')
    const started = await ctx.subagents.startActivation({
      delivery, provider: 'spawn', label: 'child task',
      prompt: [{ type: 'text', text: 'child task' }], parent, signal: testToolSignal,
    })
    expect(await started.result).toMatchObject({ output: [{ type: 'text', text: 'child result' }] })
    const childRequest = JSON.stringify(adapter.requests[0]!.messages)
    expect(childRequest.includes('Your final answer is delivered automatically')).toBe(delivery === 'parent')
    expect(childRequest).not.toContain('send_message')
    expect(childRequest).not.toContain('You are a subagent delegated by agent')
    expect(followup.mock.calls.some(([message]) => message.source.kind === 'subagent-settled')).toBe(delivery === 'parent')
  })

  it('lets a continuable child steer its direct parent with send_message', async () => {
    const release = Promise.withResolvers<undefined>()
    const { ctx, parent, adapter } = await setupWith(new GatedAdapter([
      { chunks: textResponse('child done'), gate: release.promise },
    ]))
    const started = await ctx.subagents.startActivation({
      delivery: 'parent',
      provider: 'spawn',
      label: 'child task',
      prompt: [{ type: 'text', text: 'child task' }], parent,
      signal: testToolSignal,
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)
    if (child === undefined) throw new Error('expected a live child')
    const delivered: Array<{ agent: Agent; message: ReturnType<typeof createUserMessage> }> = []
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      if (agent === parent && message.source.kind === 'agent-message') delivered.push({ agent, message })
    })

    const result = await callTool(ctx, 'send_message', {
      agent: 'lead',
      message: 'CHILD_FINDING',
    }, child)

    expect(result.isError).toBe(false)
    expect(text(result)).toBe('message delivered to agent lead')
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.message.source).toEqual({
      kind: 'agent-message',
      form: 'relay',
      senderSessionId: started.childId,
    })
    expect(delivered[0]?.message.content).toEqual([
      { type: 'text', text: `Agent ${started.name} sent a message: ` },
      { type: 'text', text: 'CHILD_FINDING' },
    ])

    release.resolve(undefined)
    await waitNoActivation(ctx, started.childId)
  })

  it('cold-resumes a settled child and reports delivery', async () => {
    const { ctx, parent } = await setup([textResponse('first answer'), textResponse('second answer')])
    const started = await ctx.subagents.startActivation({
      delivery: 'parent',
      provider: 'spawn',
      label: 'child task',
      prompt: [{ type: 'text', text: 'child task' }], parent,
      signal: testToolSignal,
    })
    await waitNoActivation(ctx, started.childId)

    const result = await callTool(ctx, 'send_message', {
      agent: started.name,
      message: 'and then?',
    }, parent)

    expect(result.isError).toBe(false)
    expect(text(result)).toBe('message delivered to agent agent-1')
    await waitNoActivation(ctx, started.childId)

    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    const followUp = loaded.events.findLast(event => event.type === 'user/message')
    // The durable message source records the calling agent without granting authority.
    expect(followUp?.type === 'user/message' && followUp.data.source).toEqual({
      kind: 'agent-message',
      form: 'relay',
      senderSessionId: parent.id,
    })
    expect(followUp?.type === 'user/message' && followUp.data.content).toEqual([
      { type: 'text', text: 'Agent lead sent a message: ' },
      { type: 'text', text: 'and then?' },
    ])
  })

  it('steers the nearest step of an open turn', async () => {
    const { ctx, parent, adapter } = await setup([textResponse('first'), textResponse('second')])
    const started = await ctx.subagents.startActivation({
      delivery: 'parent',
      provider: 'spawn',
      label: 'long work',
      prompt: [{ type: 'text', text: 'long work' }], parent,
      signal: testToolSignal,
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })

    const result = await callTool(ctx, 'send_message', {
      agent: started.childId,
      message: 'also consider Y',
    }, parent)
    expect(result.isError).toBe(false)

    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    const prompts = loaded.events.flatMap(event => event.type === 'user/message' && event.data.source.kind !== 'runtime-context'
      ? event.data.content.flatMap(block => block.type === 'text'
        && !block.text.startsWith('Your final answer is delivered automatically ')
        ? [block.text]
        : [])
      : [])
    expect(prompts).toEqual([
      'long work',
      'Agent lead sent a message: ',
      'also consider Y',
    ])
  })

  it('reports a delivery failure as an errored, not-delivered result', async () => {
    const { ctx, parent } = await setup([])
    const result = await callTool(ctx, 'send_message', {
      agent: 'no-such-child',
      message: 'hello?',
    }, parent)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('unavailable')
  })

  it('rejects a caller outside the child\'s subagent tree', async () => {
    const { ctx, parent } = await setup([textResponse('first')])
    const started = await ctx.subagents.startActivation({
      delivery: 'parent',
      provider: 'spawn',
      label: 'child task',
      prompt: [{ type: 'text', text: 'child task' }], parent,
      signal: testToolSignal,
    })
    await waitNoActivation(ctx, started.childId)
    const stranger = await ctx.agentLoop.create(brandString<SessionId>('stranger'), { provider: 'mock', model: 'mock' })

    const result = await callTool(ctx, 'send_message', {
      agent: started.childId,
      message: 'mine now',
    }, stranger)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('not a member of this subagent tree')
  })

  it('fails loud when invoked without a calling agent', async () => {
    const { ctx } = await setup([])
    const result = await callTool(ctx, 'send_message', { agent: 'x', message: 'y' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires a calling agent')
    expect(result.error?.info).toEqual({ name: 'ToolContextUnavailableError', code: 'TOOL_CONTEXT_UNAVAILABLE' })
  })

  it.each([{}, { interrupt: true }, { interrupt: false }])('unregisters and reloads with config %j (HMR safety)', async (config) => {
    const ctx = new Context()
    contexts.push(ctx)
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    const fiber = await ctx.plugin(tool, config)
    const parent = await ctx.agentLoop.create(brandString<SessionId>('hmr-parent'), { provider: 'mock', model: 'mock' })
    const { agent: child } = await ctx.agents.create({
      sessionId: brandString<SessionId>('hmr-child'),
      meta: { origin: 'subagent', parentSession: parent.id },
      setup: (_ctx, agent) => { bindSubagentActivation(ctx, agent, parent) },
    })
    const communication = async () => renderContextSnapshot(await ctx.systemPrompt.assemble({ agent: child, scope: child }))
    expect(await communication()).toContain('You are a subagent delegated by agent')
    const names = ['send_message', 'list_agents', 'wait_agent']
    if (config.interrupt !== false) names.push('interrupt_agent')
    for (const name of names) expect(ctx.tools.schemas().filter(schema => schema.name === name)).toHaveLength(1)
    expect(ctx.tools.get('list_agents')?.description).not.toContain('interrupt')
    if (config.interrupt === false) {
      expect(ctx.tools.get('interrupt_agent')).toBeUndefined()
      expect(typeof ctx.subagents.interrupt).toBe('function')
    }
    expect(ctx.tools.get('list_subagent_models')).toBeUndefined()
    await fiber.dispose()
    for (const name of names) expect(ctx.tools.get(name)).toBeUndefined()
    expect(await communication()).not.toContain('You are a subagent delegated by agent')
    const reloaded = await ctx.plugin(tool)
    expect(await communication()).toContain('You are a subagent delegated by agent')
    for (const name of ['send_message', 'interrupt_agent', 'list_agents', 'wait_agent']) {
      expect(ctx.tools.schemas().filter(schema => schema.name === name)).toHaveLength(1)
    }
    await reloaded.dispose()
  })

  it('defaults interruption on and rejects non-boolean configuration', () => {
    expect(tool.Config({})).toEqual({ interrupt: true })
    expect(tool.Config({ interrupt: false })).toEqual({ interrupt: false })
    expect(() => tool.Config({ interrupt: 'false' } as never)).toThrow()
  })

  it('has the namespace-plugin export shape (no stray default)', () => {
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-subagent-control')
    expect(tool.inject).toEqual(['tools', 'subagents', 'agents', 'systemPrompt'])
    expect(typeof tool.apply).toBe('function')
  })
})

describe('dsh-tool-subagent-control interrupt_agent', () => {
  it('registers interrupt_agent with the single agent parameter and current-turn wording', async () => {
    const { ctx } = await setup([])
    const schemas = ctx.tools.schemas().filter(schema => schema.name === 'interrupt_agent')
    expect(schemas).toHaveLength(1)
    const props = (schemas[0]!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props)).toEqual(['agent'])
    expect(schemas[0]!.description).toContain('stop its current work')
    expect(schemas[0]!.description).toContain('send_message')
  })

  it('interrupts a running direct child with the parent cause, parking its queue', async () => {
    const releaseFirst = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('held'), gate: releaseFirst.promise },
      { chunks: textResponse('parked answer') },
      { chunks: textResponse('waking answer') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startActivation({
      delivery: 'parent',
      provider: 'spawn',
      label: 'long work',
      prompt: [{ type: 'text', text: 'long work' }], parent,
      signal: testToolSignal,
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const queued = await callTool(ctx, 'send_message', {
      agent: started.childId,
      message: 'parked follow-up',
    }, parent)
    expect(queued.isError).toBe(false)
    const cancelSpy = vi.spyOn(child, 'cancel')

    const result = await callTool(ctx, 'interrupt_agent', { agent: started.name }, parent)

    expect(result.isError).toBe(false)
    expect(text(result)).toBe('interrupt requested for agent agent-1')
    expect(cancelSpy).toHaveBeenCalledExactlyOnceWith({ kind: 'parent' }, { keepInbox: true })
    releaseFirst.resolve(undefined)
    await child.whenIdle()
    // Parked, not resumed: the steering waits for another waking send.
    expect(adapter.requests).toHaveLength(1)
    expect(child.inbox.nextStep).toHaveLength(1)

    const waking = await callTool(ctx, 'send_message', {
      agent: started.childId,
      message: 'wake up',
    }, parent)
    expect(waking.isError).toBe(false)
    await waitNoActivation(ctx, started.childId)
    const loaded = await loadStoredSession(ctx.sessionPersistence, started.childId)
    const prompts = loaded.events.flatMap(event => event.type === 'user/message' && event.data.source.kind !== 'runtime-context'
      ? event.data.content.flatMap(block => block.type === 'text'
        && !block.text.startsWith('Your final answer is delivered automatically ')
        ? [block.text]
        : [])
      : [])
    expect(prompts).toEqual([
      'long work',
      'Agent lead sent a message: ',
      'parked follow-up',
      'Agent lead sent a message: ',
      'wake up',
    ])
  })

  it('lets a deep live ancestor interrupt a descendant it did not directly create', async () => {
    const releaseChild = Promise.withResolvers<undefined>()
    const releaseGrandchild = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child'), gate: releaseChild.promise },
      { chunks: textResponse('grandchild'), gate: releaseGrandchild.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startActivation({
      delivery: 'parent',
      provider: 'spawn',
      label: 'child',
      prompt: [{ type: 'text', text: 'child work' }], parent,
      signal: testToolSignal,
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)!
    const grandchild = await ctx.subagents.startActivation({
      delivery: 'parent',
      provider: 'spawn',
      label: 'grandchild',
      prompt: [{ type: 'text', text: 'grandchild work' }], parent: child,
      signal: testToolSignal,
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const grandchildAgent = ctx.agents.get(grandchild.childId)!
    const cancelSpy = vi.spyOn(grandchildAgent, 'cancel')

    const result = await callTool(ctx, 'interrupt_agent', { agent: grandchild.childId }, parent)

    expect(result.isError).toBe(false)
    expect(cancelSpy).toHaveBeenCalledExactlyOnceWith({ kind: 'parent' }, { keepInbox: true })
    releaseChild.resolve(undefined)
    releaseGrandchild.resolve(undefined)
    await waitNoActivation(ctx, grandchild.childId)
    await waitNoActivation(ctx, started.childId)
  })

  it('rejects self, sibling, and unrelated callers without touching the target', async () => {
    const releaseA = Promise.withResolvers<undefined>()
    const releaseB = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('a'), gate: releaseA.promise },
      { chunks: textResponse('b'), gate: releaseB.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const target = await ctx.subagents.startActivation({
      delivery: 'parent',
      provider: 'spawn',
      label: 'target',
      prompt: [{ type: 'text', text: 'a' }], parent,
      signal: testToolSignal,
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const sibling = await ctx.subagents.startActivation({
      delivery: 'parent',
      provider: 'spawn',
      label: 'sibling',
      prompt: [{ type: 'text', text: 'b' }], parent,
      signal: testToolSignal,
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(2) })
    const targetAgent = ctx.agents.get(target.childId)!
    const siblingAgent = ctx.agents.get(sibling.childId)!
    const stranger = await ctx.agentLoop.create(brandString<SessionId>('stranger'), { provider: 'mock', model: 'mock' })
    const cancelSpy = vi.spyOn(targetAgent, 'cancel')

    const self = await callTool(ctx, 'interrupt_agent', { agent: target.childId }, targetAgent)
    expect(self.isError).toBe(true)
    expect(text(self)).toContain('cannot interrupt itself')
    const fromSibling = await callTool(ctx, 'interrupt_agent', { agent: target.childId }, siblingAgent)
    expect(fromSibling.isError).toBe(true)
    expect(text(fromSibling)).toContain('not a live descendant')
    const fromStranger = await callTool(ctx, 'interrupt_agent', { agent: target.childId }, stranger)
    expect(fromStranger.isError).toBe(true)
    expect(text(fromStranger)).toContain('not a live descendant')
    expect(cancelSpy).not.toHaveBeenCalled()

    releaseA.resolve(undefined)
    releaseB.resolve(undefined)
    await waitNoActivation(ctx, target.childId)
    await waitNoActivation(ctx, sibling.childId)
  })

  it('accepts an absent target as a no-op without cold-resuming it', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const started = await ctx.subagents.startActivation({
      delivery: 'parent',
      provider: 'spawn',
      label: 'settled child',
      prompt: [{ type: 'text', text: 'child work' }], parent,
      signal: testToolSignal,
    })
    await waitNoActivation(ctx, started.childId)

    const settled = await callTool(ctx, 'interrupt_agent', { agent: started.childId }, parent)
    expect(settled.isError).toBe(false)
    expect(text(settled)).toBe(`interrupt requested for agent ${started.childId}`)
    const unknown = await callTool(ctx, 'interrupt_agent', { agent: 'no-such-agent' }, parent)
    expect(unknown.isError).toBe(false)
    // No cold resume: the settled target never rematerialized.
    expect(ctx.agents.get(started.childId)).toBeUndefined()
  })

  it('fails loud when invoked without a calling agent', async () => {
    const { ctx } = await setup([])
    const result = await callTool(ctx, 'interrupt_agent', { agent: 'x' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires a calling agent')
    expect(result.error?.info).toEqual({ name: 'ToolContextUnavailableError', code: 'TOOL_CONTEXT_UNAVAILABLE' })
  })
})
