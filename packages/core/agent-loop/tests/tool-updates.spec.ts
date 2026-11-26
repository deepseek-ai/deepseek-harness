/** The loop logs tool changes, captures each step's tools, and executes only the tools a step declared. */
import * as NativeToolRegistry from '@deepseek-ai/dsh-tool-registry-native'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, type ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { AgentToolRegistry, ToolStep } from '@deepseek-ai/dsh-tools/pipeline'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

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
  await ctx.plugin(NativeToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(brandString<SessionId>('tool-updates'), { provider: 'mock', model: 'model' })
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

/** A tool whose availability a provider changes per Agent or per registration. */
function conditional(description: string, execute = async () => [{ type: 'text' as const, text: 'unused' }]) {
  return defineContentToolFixture({ name: 'conditional', description, parameters: {}, execute })
}

/** One assistant response calling every named tool without arguments. */
function toolCalls(...names: string[]): StreamChunk[] {
  return [
    ...names.flatMap((name, index): StreamChunk[] => [
      { type: 'block-start', index, blockType: 'tool-call' },
      { type: 'block-end', index, block: { type: 'tool-call', id: brandString<ToolCallId>(`call-${name}`), name, arguments: '{}' } },
    ]),
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

const toolResultError = (agent: Agent, callId: string) => agent.session.snapshotEvents()
  .flatMap(event => event.type === 'tool/result' && event.data.message.toolCallId === callId ? [event.data.error] : [])[0]
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

describe('step tool capture', () => {
  it('rejects a call to a tool that its provider withdrew before the step', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('allowed', 'conditional', {}), textResponse('done'),
      toolCallResponse('removed', 'conditional', {}), textResponse('done'),
    ])
    const { ctx, agent } = await harness(adapter)
    let calls = 0
    const offers = new AgentToolRegistry()
    ctx.tools.include(offers)
    offers.register(conditional('Available until withdrawn.', async () => {
      calls++
      return [{ type: 'text', text: 'done' }]
    }))
    offers.set(agent, ['conditional'])
    await send(agent, 'enabled')
    offers.set(agent, [])
    await send(agent, 'try the historical name')
    expect(calls).toBe(1)
    expect(adapter.requests.map(request => request.tools?.map(tool => tool.name) ?? []))
      .toEqual([['conditional'], ['conditional'], [], []])
    expect(developerEvents(agent).at(-1)?.data.message.content)
      .toEqual([{ type: 'tool-removal', toolName: 'conditional' }])
    expect(toolResultError(agent, 'removed')).toMatchObject({ code: 'UNKNOWN_TOOL' })
  })

  it('keeps one model selection, declared tools, and prompt across retries without admitting again', async () => {
    const adapter = new MockAdapter([
      [{ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'retry', status: 503 } } }],
      textResponse('done'),
    ])
    const { ctx, agent } = await harness(adapter)
    let admissions = 0
    const offers = new AgentToolRegistry()
    ctx.tools.include(offers)
    offers.register(conditional('Retry-dependent availability.'))
    ctx.on('agent/pre-step', (_input, next) => { admissions++; return next() })
    agent.model.select({ provider: 'mock', model: 'first' })
    ctx.on('agent/request-error', async (_input, next) => {
      await next()
      // Changes made while the step retries take effect in the next step.
      offers.set(agent, ['conditional'])
      agent.model.select({ provider: 'mock', model: 'second' })
      return { kind: 'retry' }
    })
    ctx.systemPrompt.section({
      name: 'retry:guidance', order: 0, complete: true,
      text: context => `${context.modelSelection?.model}:${context.toolStep?.declarations.map(tool => tool.name).join(',')}`,
    })
    await send(agent, 'retry once')
    expect(adapter.requests.map(request => request.model)).toEqual(['first', 'first'])
    expect(adapter.requests.map(request => request.tools ?? [])).toEqual([[], []])
    expect(adapter.requests.map(request => request.messages.find(message => message.role === 'system')?.content))
      .toEqual([[{ type: 'text', text: 'first:' }], [{ type: 'text', text: 'first:' }]])
    expect(admissions).toBe(1)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
  })

  it('captures a fresh tool step for each proposed step, including a rejected one', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const { ctx, agent } = await harness(adapter)
    const first = conditional('First registration.')
    const disposeFirst = ctx.tools.register(first)
    const steps: ToolStep[] = []
    ctx.systemPrompt.section({
      name: 'capture:tool-step', order: 0,
      text: (context) => {
        if (context.toolStep !== undefined && !steps.includes(context.toolStep)) steps.push(context.toolStep)
        return ''
      },
    })
    let reject = true
    ctx.on('agent/pre-step', async (_input, next) => {
      const decision = await next()
      return reject ? { kind: 'reject' } : decision
    })
    await send(agent, 'rejected')
    disposeFirst()
    const replacement = conditional('Replacement registration.')
    ctx.tools.register(replacement)
    reject = false
    await send(agent, 'accepted')
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.tools?.map(tool => tool.description)).toEqual(['Replacement registration.'])
    expect(steps.map(step => step.agent)).toEqual([agent, agent])
    expect(steps.map(step => [step.declares(first), step.declares(replacement)])).toEqual([[true, false], [false, true]])
  })

  it('shares the step declarations with prompt guidance', async () => {
    const adapter = new MockAdapter([textResponse('done'), textResponse('done')])
    const { ctx, agent } = await harness(adapter)
    const offers = new AgentToolRegistry()
    ctx.tools.include(offers)
    offers.register(conditional('Offered later.'))
    ctx.systemPrompt.section({
      name: 'conditional:guidance', order: 0,
      text: context => context.toolStep?.declarations.some(tool => tool.name === 'conditional') === true ? 'Conditional guidance' : '',
    })
    await send(agent, 'inspect')
    offers.set(agent, ['conditional'])
    await send(agent, 'inspect again')
    expect(adapter.requests.map(request => request.tools?.map(tool => tool.name) ?? [])).toEqual([[], ['conditional']])
    expect(adapter.requests.map(request => JSON.stringify(request.messages).includes('Conditional guidance'))).toEqual([false, true])
  })

  it('fails calls whose registration was removed or replaced while the model responded', async () => {
    const bodies: string[] = []
    const definition = (name: string, label: string) => defineContentToolFixture({
      name, description: `${name} tool`, parameters: {},
      execute: async () => { bodies.push(label); return [{ type: 'text', text: label }] },
    })
    const whileResponding: (() => void)[] = []
    const adapter = new MockAdapter([
      () => { for (const change of whileResponding) change(); return toolCalls('removed', 'replaced', 'kept') },
      textResponse('done'),
    ])
    const { ctx, agent } = await harness(adapter)
    const disposeRemoved = ctx.tools.register(definition('removed', 'removed body'))
    const disposeReplaced = ctx.tools.register(definition('replaced', 'original body'))
    ctx.tools.register(definition('kept', 'kept body'))
    whileResponding.push(() => {
      disposeRemoved()
      disposeReplaced()
      ctx.tools.register(definition('replaced', 'replacement body'))
    })
    await send(agent, 'call while registrations change')
    expect(bodies).toEqual(['kept body'])
    expect(toolResultError(agent, 'call-removed')).toMatchObject({ code: 'UNKNOWN_TOOL' })
    expect(toolResultError(agent, 'call-replaced')).toMatchObject({ code: 'UNKNOWN_TOOL' })
    expect(toolResultError(agent, 'call-kept')).toBeUndefined()
    expect(adapter.requests.map(request => request.tools?.map(tool => tool.name).sort())).toEqual([
      ['kept', 'removed', 'replaced'], ['kept', 'replaced'],
    ])
    expect(ToolStep.capture(ctx.tools, agent).declarations.map(tool => tool.name).sort()).toEqual(['kept', 'replaced'])
  })
})
