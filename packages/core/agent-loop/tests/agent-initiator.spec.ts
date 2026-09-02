import { describe, expect, it } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime, { createUserMessage, ToolCallId, LlmAdapter  } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

const testToolSignal = new AbortController().signal

interface Harness {
  ctx: Context
  agentsFiber: Fiber
  loopFiber: Fiber
}

async function harness(adapter: LlmAdapter): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const agentsFiber = await ctx.plugin(AgentRegistry)
  const loopFiber = await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, agentsFiber, loopFiber }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

/** Adapter that holds both drivers at the same awaited continuation. */
class OverlapAdapter extends LlmAdapter {
  private readonly bothStarted = Promise.withResolvers<boolean>()
  private starts = 0
  readonly observations: { sessionId: SessionId | undefined; before: Agent; after: Agent }[] = []

  constructor(private readonly ctx: Context) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const before = this.ctx.agents.requireInitiator()
    this.starts += 1
    if (this.starts === 2) this.bothStarted.resolve(true)
    await this.bothStarted.promise
    await Promise.resolve()
    const after = this.ctx.agents.requireInitiator()
    this.observations.push({ sessionId: options.sessionId, before, after })
    yield* textResponse('done')
  }
}

/** Test-only transport that materializes ambient identity at its request boundary. */
class TestCapabilityTransport {
  readonly requests: { path: string; headers: Record<string, string> }[] = []

  constructor(private readonly agents: AgentRegistry) {}

  async request(path: string): Promise<Record<string, string>> {
    await Promise.resolve()
    const headers = {
      'X-Harness-Session-Id': this.agents.requireInitiator().session.id,
    }
    this.requests.push({ path, headers })
    return headers
  }
}

/** Adapter whose first call waits for cancellation and whose later calls complete. */
class ReloadAdapter extends LlmAdapter {
  readonly firstStarted = Promise.withResolvers<boolean>()
  firstAgentDuringAbort: Agent | undefined
  laterAgent: Agent | undefined
  calls = 0
  agents: AgentRegistry | undefined

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const agents = this.agents
    if (agents === undefined) throw new Error('agent service missing')
    this.calls += 1
    if (this.calls === 1) {
      this.firstStarted.resolve(true)
      try {
        await new Promise<void>((_resolve, reject) => {
          const abort = (): void => { reject(new Error('aborted')) }
          if (options.signal?.aborted === true) abort()
          else options.signal?.addEventListener('abort', abort, { once: true })
        })
      } catch (error: unknown) {
        await Promise.resolve()
        this.firstAgentDuringAbort = agents.requireInitiator()
        throw error
      }
      return
    }
    await Promise.resolve()
    this.laterAgent = agents.requireInitiator()
    yield* textResponse('reloaded')
  }
}

describe('AgentLoop initiator scope', () => {
  it('keeps overlapping driver continuations bound to their exact Agents', async () => {
    const ctx = new Context()
    const adapter = new OverlapAdapter(ctx)
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)

    const a = await ctx.agentLoop.create(SessionId('a'), { provider: 'mock', model: 'mock' })
    const b = await ctx.agentLoop.create(SessionId('b'), { provider: 'mock', model: 'mock' })
    const idleA = waitForIdle(ctx, a)
    const idleB = waitForIdle(ctx, b)
    send(a, 'a')
    send(b, 'b')
    await Promise.all([idleA, idleB])

    expect(adapter.observations).toHaveLength(2)
    expect(adapter.observations).toEqual(expect.arrayContaining([
      { sessionId: a.session.id, before: a, after: a },
      { sessionId: b.session.id, before: b, after: b },
    ]))
    expect(ctx.agents.currentInitiator()).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('keeps initiator identity minimal while one explicit signal spans each turn seam', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('observe-call', 'observe', {}),
      textResponse('first done'),
      textResponse('second done'),
    ])
    const { ctx } = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('signal-owner'), { provider: 'mock', model: 'mock' })
    let signals: AbortSignal[] = []
    let preStepSignals: AbortSignal[] = []
    const capture = (signal: AbortSignal | undefined): void => {
      if (signal === undefined) throw new Error('turn seam omitted its explicit signal')
      expect(ctx.agents.requireInitiator()).toBe(agent)
      signals.push(signal)
    }

    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      if (context.agent === agent) capture(context.signal)
      return next()
    })
    ctx.on('agent/pre-step', async ({ agent: subject, signal }, next) => {
      if (subject === agent) {
        expect(ctx.agents.requireInitiator()).toBe(agent)
        preStepSignals.push(signal)
      }
      return next()
    })
    ctx.on('agent/request', async ({ agent: subject, signal }, next) => {
      if (subject === agent) capture(signal)
      return next()
    })
    ctx.on('agent/turn-stopping', ({ agent: subject, signal }) => {
      if (subject === agent) capture(signal)
    })
    ctx.tools.register(defineContentToolFixture({
      name: 'observe',
      description: 'observe explicit turn state',
      parameters: {},
      execute: async (_args, exec) => {
        capture(exec.signal)
        return [{ type: 'text', text: 'observed' }]
      },
    }))

    const firstIdle = waitForIdle(ctx, agent)
    send(agent, 'first')
    await firstIdle
    const firstSignal = signals[0]
    expect(firstSignal).toBeDefined()
    expect(new Set([...signals, ...adapter.requests.slice(0, 2).map(request => request.signal!)])).toEqual(new Set([firstSignal]))
    expect(preStepSignals).toHaveLength(2)
    expect(new Set(preStepSignals)).toEqual(new Set([firstSignal]))

    signals = []
    preStepSignals = []
    const secondIdle = waitForIdle(ctx, agent)
    send(agent, 'second')
    await secondIdle
    const secondSignal = signals[0]
    expect(secondSignal).toBeDefined()
    expect(new Set([...signals, adapter.requests[2]!.signal!])).toEqual(new Set([secondSignal]))
    expect(preStepSignals).toHaveLength(1)
    expect(preStepSignals[0]).toBe(secondSignal)
    expect(secondSignal).not.toBe(firstSignal)
    expect(ctx.agents.currentInitiator()).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('keeps child setup under the parent boundary and restores the parent while the child driver remains active', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('spawn', 'spawn-child', {}),
      toolCallResponse('observe', 'observe-child', {}),
      textResponse('child done'),
      textResponse('parent done'),
    ])
    const { ctx } = await harness(adapter)
    let parentDuringSetup: Agent | undefined
    let explicitChild: Agent | undefined
    let childDuringDriver: Agent | undefined
    let parentWhileChildDriverActive: Agent | undefined
    let child: Agent | undefined

    ctx.tools.register(defineContentToolFixture({
      name: 'spawn-child',
      description: 'create one child agent',
      parameters: {},
      execute: async (_args, exec) => {
        if (exec.agent === undefined) throw new Error('parent agent missing')
        const handle = await exec.agent.ctx.agents.create({
          sessionId: SessionId('child-session'),
          agentOptions: { provider: 'mock', model: 'mock' },
          setup: (agentCtx) => {
            parentDuringSetup = ctx.agents.requireInitiator()
            explicitChild = agentCtx.agent
            agentCtx.tools.register(defineContentToolFixture({
              name: 'observe-child',
              description: 'observe child execution identity',
              parameters: {},
              execute: async () => {
                await Promise.resolve()
                childDuringDriver = ctx.agents.requireInitiator()
                return [{ type: 'text', text: 'observed' }]
              },
            }))
          },
        })
        child = handle.agent
        parentWhileChildDriverActive = ctx.agents.requireInitiator()
        send(handle.agent, 'run child')
        await handle.agent.whenIdle()
        await handle.dispose()
        return [{ type: 'text', text: 'child completed' }]
      },
    }))

    const parentHandle = await ctx.agents.create({
      sessionId: SessionId('parent-session'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const idle = waitForIdle(ctx, parentHandle.agent)
    send(parentHandle.agent, 'spawn')
    await idle

    expect(parentDuringSetup).toBe(parentHandle.agent)
    expect(explicitChild).toBe(child)
    expect(childDuringDriver).toBe(child)
    expect(parentWhileChildDriverActive).toBe(parentHandle.agent)
    expect(ctx.agents.currentInitiator()).toBeUndefined()
    await parentHandle.dispose()
    await ctx.fiber.dispose()
  })

  it('keeps agentless direct tools ambient-free and builds trusted transport headers internally', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('capability', 'capability-request', { path: '/v1/capability' }),
      textResponse('done'),
    ])
    const { ctx } = await harness(adapter)
    const transport = new TestCapabilityTransport(ctx.agents)
    let directAmbient: Agent | undefined
    let captured: Agent | undefined

    ctx.tools.register(defineContentToolFixture({
      name: 'agentless-probe',
      description: 'observe an agentless call',
      parameters: {},
      execute: async () => {
        await Promise.resolve()
        directAmbient = ctx.agents.currentInitiator()
        return [{ type: 'text', text: 'ok' }]
      },
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'capability-request',
      description: 'call the test capability transport',
      parameters: { path: { type: 'string' } },
      execute: async (args) => {
        captured = ctx.agents.requireInitiator()
        const path = (args as { path: string }).path
        const headers = await transport.request(path)
        return [{ type: 'text', text: JSON.stringify(headers) }]
      },
    }))

    const direct = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('direct'),
      name: 'agentless-probe',
      arguments: {},
    })
    expect(direct.isError).toBe(false)
    expect(directAmbient).toBeUndefined()

    const handle = await ctx.agents.create({
      sessionId: SessionId('transport-session'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const idle = waitForIdle(ctx, handle.agent)
    send(handle.agent, 'call transport')
    await idle

    expect(transport.requests).toEqual([{
      path: '/v1/capability',
      headers: { 'X-Harness-Session-Id': 'transport-session' },
    }])
    const schema = adapter.requests[0]?.tools?.find(tool => tool.name === 'capability-request')
    expect(JSON.stringify(schema?.parameters)).not.toMatch(/session|harness/i)
    const call = handle.agent.session.snapshotEvents().find(event => event.type === 'tool/call')
    expect(call?.type === 'tool/call' ? call.data.arguments : undefined)
      .toBe(JSON.stringify({ path: '/v1/capability' }))
    expect(captured).toBe(handle.agent)

    await handle.dispose()
    expect(ctx.agents.currentInitiator()).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('drains the old driver before disabling ALS during agent-service restart', async () => {
    const adapter = new ReloadAdapter()
    const { ctx, agentsFiber, loopFiber } = await harness(adapter)
    const oldService = ctx.agents
    adapter.agents = oldService
    const oldHandle = await ctx.agents.create({
      sessionId: SessionId('before-restart-session'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const oldAgent = oldHandle.agent
    send(oldAgent, 'block')
    await adapter.firstStarted.promise

    await agentsFiber.restart()
    await loopFiber.await()
    expect(adapter.firstAgentDuringAbort?.id).toBe(oldAgent.id)
    expect(adapter.firstAgentDuringAbort?.session).toBe(oldAgent.session)
    expect(() => oldService.currentInitiator()).toThrow('agent initiator scope is disposed')
    expect(ctx.agents).not.toBe(oldService)
    adapter.agents = ctx.agents

    const newHandle = await ctx.agents.create({
      sessionId: SessionId('after-restart-session'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const newAgent = newHandle.agent
    const idle = waitForIdle(ctx, newAgent)
    send(newAgent, 'continue')
    await idle
    expect(adapter.laterAgent?.id).toBe(newAgent.id)
    expect(adapter.laterAgent?.session).toBe(newAgent.session)
    await ctx.fiber.dispose()
  })

  it('keeps ALS readable while root disposal drains sibling AgentLoop fibers', async () => {
    const ctx = new Context()
    const adapter = new ReloadAdapter()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.llm.registerAdapter(['mock'], adapter)
    const service = ctx.agents
    adapter.agents = service
    const handle = await ctx.agents.create({
      sessionId: SessionId('root-dispose-session'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const agent = handle.agent
    send(agent, 'block')
    await adapter.firstStarted.promise

    await ctx.fiber.dispose()
    expect(adapter.firstAgentDuringAbort?.id).toBe(agent.id)
    expect(adapter.firstAgentDuringAbort?.session).toBe(agent.session)
    expect(() => service.currentInitiator()).toThrow('agent initiator scope is disposed')
  })
})
