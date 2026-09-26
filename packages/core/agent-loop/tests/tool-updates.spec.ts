/** The loop logs tool changes as developer messages and carries session tool history to the runtime. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from './mock-adapter.ts'

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
