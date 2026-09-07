/** Request immutability through the real loop, including adopted restore graphs. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ToolSchema } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionLogOffset, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import * as values from '@deepseek-ai/dsh-util-values'
import { ReactLoopAgent } from '../src/agent.ts'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  try {
    for (const cleanup of cleanups.reverse()) await cleanup()
  } finally {
    cleanups.length = 0
    vi.restoreAllMocks()
  }
})

async function harness(adapter?: MockAdapter): Promise<{ ctx: Context; loopCtx: Context }> {
  const ctx = new Context()
  cleanups.push(() => ctx.fiber.dispose())
  await mountAgentLoopTestDependencies(ctx)
  const loopFiber = await ctx.plugin(AgentLoop, { agents: [] })
  if (adapter) ctx.effect(() => ctx.llm.registerAdapter(['mock'], adapter))
  return { ctx, loopCtx: loopFiber.ctx }
}

async function send(agent: Agent, text: string): Promise<void> {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

function expectFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object' || value instanceof AbortSignal) return
  expect(Object.isFrozen(value)).toBe(true)
  for (const child of Object.values(value)) expectFrozen(child)
}

describe('loop-owned request freezing', () => {
  it('adopts restored identities, freezes nested messages at dispatch, and leaves event wrappers mutable', async () => {
    const { ctx, loopCtx } = await harness(new MockAdapter([textResponse('one'), textResponse('two'), textResponse('three'), textResponse('four')]))
    const id = SessionId('restored-freeze')
    const seed = Session.create(id)
    seed.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'restored user' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    seed.append('assistant/message', {
      turn: 1, step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'restored assistant' }],
        source: { provider: 'mock', model: 'mock', replayState: { nested: ['opaque'] } },
      }),
      stream: [],
    }, { surfaceOp: 'append' })
    const events = structuredClone(seed.snapshotEvents())
    const userEvent = events.find(event => event.type === 'user/message')!
    const assistantEvent = events.find(event => event.type === 'assistant/message')!
    Object.freeze(userEvent.data)
    const freeze = vi.spyOn(values, 'deepFreeze')
    const session = Session.fromRestore(id, events, {
      id, version: SESSION_FORMAT_VERSION, createdAt: 1, cwd: '/test', isSeeded: false,
    }, SessionLogOffset(0), 'detached')
    const before = session.deriveMessages()
    expect(before[0]).toBe(userEvent.data)
    expect(before[1]).toBe(assistantEvent.data.message)
    expect(Object.isFrozen(before)).toBe(false)
    expect(Object.isFrozen(userEvent.data.content)).toBe(false)
    expect(Object.isFrozen(assistantEvent.data.message)).toBe(false)
    ctx.effect(() => ctx.sessions.enter(session))
    const agent = new ReactLoopAgent(loopCtx, id, { provider: 'mock', model: 'mock' }, session)
    cleanups.push(async () => {
      agent.cancel({ kind: 'disposed' })
      await agent.whenIdle()
      await agent.scope.dispose()
    })
    const requests: GenerateOptions[] = []
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    ctx.on('llm/stream', (request, next) => {
      expect(isAgentLoopRequest(request)).toBe(true)
      expectFrozen(request)
      requests.push(request)
      return next()
    })
    await send(agent, 'first')
    expect(errors).toEqual([])
    expect(requests).toHaveLength(1)
    const first = requests[0]!
    expect(first.messages[0]).toBe(before[0])
    expect(first.messages[1]).toBe(before[1])
    expect(Object.isFrozen(userEvent)).toBe(false)
    expect(Object.isFrozen(assistantEvent.data)).toBe(false)
    expect(Object.isFrozen(assistantEvent.data.stream)).toBe(false)
    userEvent.time += 1
    assistantEvent.data.stream.push({ type: 'chunk', time: 2, chunk: { type: 'finish', reason: { kind: 'stop' } } })
    before.pop()
    const held = JSON.stringify(first.messages)
    await send(agent, 'second')
    expect(requests).toHaveLength(2)
    expect(requests[1]!.messages).not.toBe(first.messages)
    expect(requests[1]!.messages[0]).toBe(first.messages[0])
    expect(requests[1]!.messages.length).toBeGreaterThan(first.messages.length)
    const nodes = session.surface.nodes
    const replacement = session.append('user/message', {
      ...userEvent.data, content: [{ type: 'text', text: 'compacted' }],
    }, {
      surfaceOp: { op: 'replace', start: nodes[0]!, end: nodes[1]! },
      sourceEventSeqs: [nodes[0]!, nodes[1]!],
    })
    await send(agent, 'third')
    expect(requests).toHaveLength(3)
    expect(requests[2]!.messages[0]).toBe(replacement.data)
    expect(requests[2]!.messages[0]!.id).toBe(first.messages[0]!.id)
    expect(requests[2]!.messages[0]).not.toBe(first.messages[0])
    expect(JSON.stringify(first.messages)).toBe(held)
    expect(Object.isFrozen(session.deriveMessages())).toBe(false)
    expect(freeze.mock.calls.filter(([value]) => value === userEvent.data)).toHaveLength(1)
    expect(freeze.mock.calls.filter(([value]) => value === replacement.data)).toHaveLength(1)
    const resumed = new ReactLoopAgent(loopCtx, id, { provider: 'mock', model: 'mock' }, session)
    cleanups.push(async () => {
      resumed.cancel({ kind: 'disposed' })
      await resumed.whenIdle()
      await resumed.scope.dispose()
    })
    await send(resumed, 'fresh loop')
    expect(requests).toHaveLength(4)
    expect(freeze.mock.calls.filter(([value]) => value === replacement.data)).toHaveLength(2)
  })

  it('retries freezing an identity whose previous traversal failed', async () => {
    const { ctx } = await harness(new MockAdapter([textResponse('done')]))
    const agent = await ctx.agentLoop.create(SessionId('freeze-failure'), { provider: 'mock', model: 'mock' })
    const message = agent.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'history' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' }).data
    const realFreeze = values.deepFreeze
    let traversals = 0
    vi.spyOn(values, 'deepFreeze').mockImplementation((value) => {
      if (value === message && ++traversals === 1) throw new Error('freeze traversal failed')
      return realFreeze(value)
    })
    const errors: unknown[] = []
    const requests: GenerateOptions[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    ctx.on('llm/stream', (request, next) => { requests.push(request); return next() })
    await send(agent, 'failed turn')
    expect(errors).toEqual([new Error('freeze traversal failed')])
    expect(requests).toHaveLength(0)
    await send(agent, 'retry turn')
    expect(requests).toHaveLength(1)
    expect(traversals).toBe(2)
    expect(requests[0]!.messages[0]).toBe(message)
    expectFrozen(requests[0])
  })

  it.each([true, false])('freezes each local header with an adapter present: %s', async (registered) => {
    const adapter = registered ? new MockAdapter([textResponse('one'), textResponse('two')]) : undefined
    const { ctx } = await harness(adapter)
    const schemas: ToolSchema[][] = []
    const stops: string[][] = []
    ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
      const assembly = await next()
      const tools: ToolSchema[] = [{ name: 'nested', description: 'test', parameters: {
        type: 'object', properties: { value: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } } },
      } }]
      schemas.push(tools)
      return { ...assembly, tools }
    })
    ctx.on('agent/request', async (_payload, next) => {
      const config = await next()
      const stop = ['stop']
      stops.push(stop)
      return { ...config, stop }
    })
    const requests: GenerateOptions[] = []
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    ctx.on('llm/stream', (request, next) => {
      expect(isAgentLoopRequest(request)).toBe(true)
      expectFrozen(request)
      requests.push(request)
      return registered ? next() : (async function* () { yield* textResponse('virtual') })()
    })
    const agent = await ctx.agentLoop.create(SessionId('headers'), { provider: 'mock', model: 'mock' })
    await send(agent, 'first')
    await send(agent, 'second')
    expect(errors).toEqual([])
    expect(requests).toHaveLength(2)
    for (const [index, request] of requests.entries()) {
      expect(request.tools).toBe(schemas[index])
      expectFrozen(schemas[index])
      expect(() => request.stop!.push('mutate')).toThrow(TypeError)
      if (!registered) expect(request.stop).toBe(stops[index])
    }
    expect(agent.session.snapshotEvents().filter(event => event.type === 'request/header')).toHaveLength(1)
    expect(agent.session.requestHeader()!.tools).not.toBe(requests[0]!.tools)
    expect(agent.session.requestHeader()!.config.stop).not.toBe(requests[0]!.stop)
  })

  it('keeps the live request signal mutable and observes cancellation after dispatch', async () => {
    const { ctx } = await harness(new MockAdapter(['hang']))
    const agent = await ctx.agentLoop.create(SessionId('cancel-freeze'), { provider: 'mock', model: 'mock' })
    const started = Promise.withResolvers<GenerateOptions>()
    ctx.on('llm/stream', (request, next) => { started.resolve(request); return next() })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    try {
      const request = await started.promise
      expect(Object.isFrozen(request)).toBe(true)
      expect(Object.isFrozen(request.signal)).toBe(false)
      expect(request.signal!.aborted).toBe(false)
      const aborted = Promise.withResolvers<undefined>()
      request.signal!.addEventListener('abort', () => { aborted.resolve(undefined) }, { once: true })
      agent.cancel({ kind: 'user' })
      await aborted.promise
      await agent.whenIdle()
      expect(request.signal!.aborted).toBe(true)
      expect(request.signal!.reason).toEqual({ kind: 'user' })
      expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
        type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
      })
    } finally {
      agent.cancel({ kind: 'disposed' })
      await agent.whenIdle()
    }
  })
})
