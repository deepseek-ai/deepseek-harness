/** The loop logs tool changes as developer messages and carries session tool history to the runtime. */
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ResolvedToolSet } from '@deepseek-ai/dsh-tools'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt, { personaPrefix: '', personaSuffix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('tool-updates'), { provider: 'mock', model: 'model' })
  return { ctx, agent }
}

async function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

function tool(ctx: Context, name: string) {
  return ctx.tools.register(defineContentToolFixture({
    name, description: `${name} tool`, parameters: {}, execute: async () => [{ type: 'text', text: 'done' }],
  }))
}

const developerEvents = (agent: Agent) => agent.session.snapshotEvents().filter(event => event.type === 'developer/message')
const headerEvents = (agent: Agent) => agent.session.snapshotEvents().filter(event => event.type === 'request/header')
const developerContent = (request: GenerateOptions) => request.messages.filter(message => message.role === 'developer').map(message => message.content)

describe('tool update emission', () => {
  it('logs additions bound to the new header and removals without one, after the first header', async () => {
    const adapter = new MockAdapter(Array.from({ length: 4 }, () => textResponse('ok')))
    const { ctx, agent } = await harness(adapter)
    const disposeSearch = tool(ctx, 'search')
    await send(agent, 'first')
    expect(developerEvents(agent)).toEqual([])

    tool(ctx, 'fetch')
    await send(agent, 'second')
    const [addition] = developerEvents(agent)
    expect(addition).toMatchObject({
      surfaceOp: 'append',
      data: { turn: 2, step: 1, headerSeq: headerEvents(agent)[1]?.seq, message: {
        role: 'developer', source: { kind: 'tool-registry' }, content: [{ type: 'tool-addition', toolName: 'fetch' }],
      } },
    })

    disposeSearch()
    await send(agent, 'third')
    const removal = developerEvents(agent)[1]
    expect(removal?.data).not.toHaveProperty('headerSeq')
    expect(removal?.data.message.content).toEqual([{ type: 'tool-removal', toolName: 'search' }])

    await send(agent, 'fourth')
    expect(developerEvents(agent)).toHaveLength(2)
    expect(adapter.requests.at(-1)?.toolHistory).toEqual(agent.session.toolHistory())
    expect(adapter.requests.map(request => request.toolHistory?.updates.length)).toEqual([0, 1, 2, 2])
    for (const request of adapter.requests) {
      expect(Object.isFrozen(request.toolHistory)).toBe(true)
      expect(developerContent(request)).toEqual([])
      expect(request.tools?.some(schema => schema.deferLoading === true)).toBeFalsy()
    }
    expect(adapter.requests.map(request => request.tools?.map(schema => schema.name))).toEqual([
      ['search'], ['fetch', 'search'], ['fetch'], ['fetch'],
    ])
  })

  it('sends deferred declarations and recorded update blocks on an in-history route', async () => {
    const adapter = new MockAdapter(Array.from({ length: 3 }, () => textResponse('ok')))
    adapter.toolUpdate = 'in-history'
    const { ctx, agent } = await harness(adapter)
    tool(ctx, 'search')
    await send(agent, 'first')
    const disposeFetch = tool(ctx, 'fetch')
    await send(agent, 'second')
    disposeFetch()
    await send(agent, 'third')

    expect(headerEvents(agent).map(event => [event.data.reason, event.data.startsSeries])).toEqual([
      ['initial', undefined], ['change', undefined], ['change', undefined],
    ])
    const [first, second, third] = adapter.requests
    expect(first?.tools?.map(schema => schema.name)).toEqual(['search'])
    expect(second?.tools).toEqual([
      { name: 'search', description: 'search tool', parameters: expect.anything() as object },
      { name: 'fetch', description: 'fetch tool', parameters: expect.anything() as object, deferLoading: true },
    ])
    expect(developerContent(second!)).toEqual([[{ type: 'tool-addition', toolName: 'fetch' }]])
    expect(third?.tools).toEqual(second?.tools)
    expect(developerContent(third!)).toEqual([
      [{ type: 'tool-addition', toolName: 'fetch' }], [{ type: 'tool-removal', toolName: 'fetch' }],
    ])
    expect(agent.session.requestHeader()?.tools?.map(schema => schema.name)).toEqual(['search'])
  })
})

describe('step-time tool activation', () => {
  it('uses the step model selection for asynchronous conditions and rejects a historical name after removal', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('allowed', 'conditional', {}), textResponse('done'),
      toolCallResponse('removed', 'conditional', {}), textResponse('done'),
    ])
    const { ctx, agent } = await harness(adapter)
    const selectedModels: string[] = []
    let calls = 0
    agent.model.select({ provider: 'mock', model: 'enabled' })
    ctx.tools.register(defineContentToolFixture({
      name: 'conditional', description: 'Available on one model.', parameters: {},
      async execute(_args, exec) {
        expect(exec.agent?.session.requestHeader()?.config.model).toBe('enabled')
        calls++
        return [{ type: 'text', text: 'done' }]
      },
    }), { when: async ({ modelSelection }) => {
      selectedModels.push(modelSelection.model)
      await Promise.resolve()
      return modelSelection.model === 'enabled'
    } })
    await send(agent, 'enabled')
    agent.model.select({ provider: 'mock', model: 'disabled' })
    await send(agent, 'try the historical name')
    expect(calls).toBe(1)
    expect(selectedModels).toEqual(['enabled', 'enabled', 'disabled', 'disabled'])
    expect(adapter.requests.map(request => request.model)).toEqual(selectedModels)
    expect(developerEvents(agent).at(-1)?.data.message.content)
      .toEqual([{ type: 'tool-removal', toolName: 'conditional' }])
    expect(agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'removed')?.data)
      .toMatchObject({ error: { code: 'UNKNOWN_TOOL' } })
  })

  it('cancels an asynchronous condition without committing the step request', async () => {
    const adapter = new MockAdapter([textResponse('unused')])
    const { ctx, agent } = await harness(adapter)
    const entered = Promise.withResolvers<undefined>()
    const settle = Promise.withResolvers<boolean>()
    ctx.tools.register(defineContentToolFixture({
      name: 'conditional', description: 'A pending condition.', parameters: {},
      execute: async () => [{ type: 'text', text: 'unused' }],
    }), { when: () => { entered.resolve(undefined); return settle.promise } })
    const running = send(agent, 'cancel during activation')
    await entered.promise
    agent.cancel({ kind: 'user' })
    settle.resolve(true)
    await running
    expect(adapter.requests).toEqual([])
    expect(agent.session.snapshotEvents().filter(event => ['request/header', 'system/message', 'user/message'].includes(event.type))).toEqual([])
  })

  it('keeps one model selection, tool set, and prompt across retries without admitting users again', async () => {
    const adapter = new MockAdapter([
      [{ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'retry', status: 503 } } }],
      textResponse('done'),
    ])
    const { ctx, agent } = await harness(adapter)
    let retried = false
    const counts = { conditions: 0, admissions: 0 }
    ctx.on('agent/pre-step', (_input, next) => { counts.admissions++; return next() })
    agent.model.select({ provider: 'mock', model: 'first' })
    ctx.on('agent/request-error', async (_input, next) => {
      await next()
      retried = true
      agent.model.select({ provider: 'mock', model: 'second' })
      return { kind: 'retry' }
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'conditional', description: 'Retry-dependent availability.', parameters: {},
      execute: async () => [{ type: 'text', text: 'unused' }],
    }), { when: () => { counts.conditions++; return retried } })
    ctx.systemPrompt.section({
      name: 'retry:guidance', order: 0, complete: true,
      text: context => `${context.modelSelection?.model}:${ctx.tools.schemas(agent, context.toolSet).map(tool => tool.name).join(',')}`,
    })
    await send(agent, 'retry once')
    expect(adapter.requests.map(request => request.model)).toEqual(['first', 'first'])
    expect(adapter.requests.map(request => request.tools ?? [])).toEqual([[], []])
    expect(adapter.requests.map(request => request.messages.find(message => message.role === 'system')?.content))
      .toEqual([[{ type: 'text', text: 'first:' }], [{ type: 'text', text: 'first:' }]])
    expect(counts).toEqual({ conditions: 1, admissions: 1 })
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
  })

  it('reports condition failures without admitting a partial request', async () => {
    const adapter = new MockAdapter([textResponse('unused')])
    const { ctx, agent } = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'conditional', description: 'An unavailable activation dependency.', parameters: {},
      execute: async () => [{ type: 'text', text: 'unused' }],
    }), { when: async () => { throw new Error('credential storage unavailable') } })
    await send(agent, 'inspect')
    expect(adapter.requests).toEqual([])
    expect(agent.session.snapshotEvents().filter(event => ['request/header', 'system/message', 'user/message'].includes(event.type))).toEqual([])
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data)
      .toMatchObject({ reason: { kind: 'error', error: { code: 'TOOL_ACTIVATION_FAILED' } } })
  })

  it('closes the step tool set after a rejected proposal and after its step', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const { ctx, agent } = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'conditional', description: 'Enabled.', parameters: {},
      execute: async () => [{ type: 'text', text: 'unused' }],
    }), { when: () => true })
    const assembled: { toolSet: ResolvedToolSet; admitted: number }[] = []
    ctx.systemPrompt.section({
      name: 'capture:tool-set', order: 0,
      text: (context) => {
        if (context.toolSet !== undefined) assembled.push({ toolSet: context.toolSet, admitted: context.toolSet.view(agent).size })
        return ''
      },
    })
    let reject = true
    ctx.on('agent/pre-step', async (_input, next) => {
      const decision = await next()
      return reject ? { kind: 'reject' } : decision
    })
    await send(agent, 'rejected')
    reject = false
    await send(agent, 'accepted')
    expect(adapter.requests).toHaveLength(1)
    expect(assembled.map(entry => entry.admitted)).toEqual([1, 1])
    expect(assembled.map(entry => entry.toolSet.view(agent).size)).toEqual([0, 0])
  })

  it('shares the selected set with prompt guidance', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const { ctx, agent } = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'conditional', description: 'Disabled.', parameters: {},
      execute: async () => [{ type: 'text', text: 'unused' }],
    }), { when: () => false })
    ctx.systemPrompt.section({
      name: 'conditional:guidance', order: 0,
      text: context => ctx.tools.get('conditional', context.scope, context.toolSet) === undefined ? '' : 'Conditional guidance',
    })
    await send(agent, 'inspect')
    expect(adapter.requests[0]?.tools ?? []).toEqual([])
    expect(JSON.stringify(adapter.requests[0]?.messages)).not.toContain('Conditional guidance')
  })
})
