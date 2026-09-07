import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, ToolCallId, LlmError, MessageSource, ProviderRequestId, StreamChunk  } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionEvent, SessionId, TurnEndReason, type UserMessage } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, type PostToolDecision } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

async function mountInvariants(ctx: Context): Promise<void> {
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
}

function driverDone(agent: Agent): Promise<void> {
  return (agent as Agent & { done: Promise<void> }).done
}

/** Regression tests for agent-loop boundary, identity, and lifecycle contracts. */

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
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

function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

function inboxText(message: UserMessage): string {
  return message.content
    .flatMap(block => block.type === 'text' ? [block.text] : [])
    .join('')
}

describe('assistant replay provider and model fields', () => {
  it('records adapter replay state with the assembled assistant content', async () => {
    const response = textResponse('unchanged')
    const replayState = { response: { private: 'state' }, blocks: ['block-meta'] }
    response[response.length - 1] = { type: 'finish', reason: { kind: 'stop' }, replayState }
    const adapter = new MockAdapter([response])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('replay-state'), { provider: 'mock', model: 'next-model' })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const recorded = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
    expect(recorded?.type === 'assistant/message' && recorded.data.message.source).toEqual({
      kind: 'model', provider: 'mock', model: 'next-model', replayState,
    })
    expect(agent.session.deriveMessages().at(-1)?.source).toEqual({
      kind: 'model', provider: 'mock', model: 'next-model', replayState,
    })
  })
})

describe('abort during tool execution ends the turn', () => {
  it('parks context finalized after a tool-step abort until another wakeup', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'aborter', {}),
      textResponse('after wake'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a-abort-injection'), { provider: 'mock', model: 'mock' })
    ctx.tools.register(defineContentToolFixture({
      name: 'aborter',
      description: '',
      parameters: {},
      async execute() {
        agent.inject(createUserMessage({ content: [{ type: 'text', text: 'accepted before abort' }], source: { kind: 'plugin', plugin: 'test' } }))
        agent.cancel({ kind: 'user' })
        return [{ type: 'text', text: 'done' }]
      },
    }))
    ctx.on('tools/post-execute', async (): Promise<PostToolDecision> => ({
      kind: 'accept',
      additionalContexts: [createUserMessage({
        content: [{ type: 'text', text: 'accepted result context after abort' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(agent.session.snapshotEvents()
      .filter(event => event.type === 'tool/result'
        || (event.type === 'user/message' && event.data.source.kind === 'plugin')
        || event.type === 'step/end' || event.type === 'turn/end')
      .map(event => event.type))
      .toEqual(['tool/result', 'step/end', 'turn/end'])
    expect(agent.inbox.nextStep.map(inboxText))
      .toEqual(['accepted result context after abort'])

    const idle = waitForIdle(ctx, agent)
    send(agent, 'wake')
    await idle

    expect(agent.session.snapshotEvents()
      .flatMap(event => event.type === 'user/message' && event.data.source.kind === 'plugin'
        ? [event.data.content]
        : []))
      .toEqual([
        [{ type: 'text', text: 'accepted result context after abort' }],
      ])
  })

  it('records post-tool context when a later call aborts the batch', async () => {
    const adapter = new MockAdapter([[
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('c1'), name: 'first', arguments: '{}' } },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('c2'), name: 'aborter', arguments: '{}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] satisfies StreamChunk[]])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a-later-abort-context'), { provider: 'mock', model: 'mock' })
    ctx.tools.register(defineContentToolFixture({
      name: 'first',
      description: '',
      parameters: {},
      async execute() {
        return [{ type: 'text', text: 'first done' }]
      },
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'aborter',
      description: '',
      parameters: {},
      async execute() {
        agent.cancel({ kind: 'user' })
        return [{ type: 'text', text: 'aborted' }]
      },
    }))
    ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
      if (exec.callId !== ToolCallId('c1')) return next()
      return {
        kind: 'accept',
        additionalContexts: [createUserMessage({
          content: [{ type: 'text', text: 'accepted after first result' }],
          source: { kind: 'plugin', plugin: 'test' },
        })],
      }
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const events = agent.session.snapshotEvents()
    expect(events
      .filter(event => event.type === 'tool/result'
        || (event.type === 'user/message' && event.data.source.kind === 'plugin')
        || event.type === 'step/end' || event.type === 'turn/end')
      .map(event => event.type))
      .toEqual(['tool/result', 'tool/result', 'step/end', 'turn/end'])
    expect(events.flatMap(event =>
      event.type === 'user/message' && event.data.source.kind === 'plugin'
        ? [event.data.content]
        : [])[0])
      .toBeUndefined()
  })

  it('closes an empty admitted batch as a turn without a step', async () => {
    const adapter = new MockAdapter([textResponse('must not run')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a-empty-batch'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/pre-step', ({ agent: subject }, next) => {
      if (subject !== agent) return next()
      return Promise.resolve({ kind: 'enter', messages: [] })
    })
    send(agent, 'go')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start'
      || event.type === 'step/start' || event.type === 'turn/end').map(event => event.type))
      .toEqual(['turn/start', 'turn/end'])
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data)
      .toEqual({ turn: 1, reason: { kind: 'completed' } })
    expect(agent.inbox.nextTurn).toHaveLength(0)
  })

  it('parks result context finalized after disposal cancellation without opening another turn', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'waiter', {})])
    const ctx = await harness(adapter)
    const started = Promise.withResolvers<undefined>()
    let agent!: Agent
    const fiber = await ctx.plugin(Object.assign(async (inner: Context) => {
      agent = await inner.agentLoop.create(SessionId('a-dispose-injection'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))
    ctx.tools.register(defineContentToolFixture({
      name: 'waiter',
      description: '',
      parameters: {},
      async execute(_args, exec) {
        agent.inject(createUserMessage({ content: [{ type: 'text', text: 'accepted before disposal' }], source: { kind: 'plugin', plugin: 'test' } }))
        started.resolve(undefined)
        const signal = exec.signal
        if (!signal) throw new Error('tool execution signal is missing')
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        return [{ type: 'text', text: 'done' }]
      },
    }))
    ctx.on('tools/post-execute', async (): Promise<PostToolDecision> => ({
      kind: 'accept',
      additionalContexts: [createUserMessage({
        content: [{ type: 'text', text: 'accepted result context during disposal' }],
        source: { kind: 'plugin', plugin: 'test' },
      })],
    }))

    send(agent, 'go')
    await started.promise
    await fiber.dispose()

    expect(agent.session.snapshotEvents()
      .flatMap(event => event.type === 'user/message' && event.data.source.kind === 'plugin'
        ? [event.data.content]
        : []))
      .toEqual([])
    expect(agent.session.snapshotEvents()
      .flatMap(event => event.type === 'agent/inbox/spliced' && event.data.target === 'next-step'
        ? [event.data.inserted.map(inboxText)]
        : [])
      .at(-1))
      .toEqual(['accepted result context during disposal'])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start'))
      .toHaveLength(1)
    expect(agent.session.snapshotEvents().find(event => event.type === 'turn/end')?.data.reason)
      .toEqual({ kind: 'aborted', reason: { kind: 'disposed' } })
  })

  it('limits injection deferral to the current tool batch', async () => {
    const adapter = new MockAdapter([
      [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('c1'), name: 'aborter', arguments: '{}' } },
        { type: 'block-start', index: 1, blockType: 'tool-call' },
        { type: 'block-end', index: 1, block: { type: 'tool-call', id: ToolCallId('c2'), name: 'second', arguments: '{}' } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ] satisfies StreamChunk[],
      textResponse('later turn'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a-historical-tool-pair'), { provider: 'mock', model: 'mock' })
    ctx.tools.register(defineContentToolFixture({
      name: 'aborter',
      description: '',
      parameters: {},
      async execute() {
        agent.cancel({ kind: 'user' })
        return [{ type: 'text', text: 'done' }]
      },
    }))
    ctx.tools.register(defineContentToolFixture({
      name: 'second',
      description: '',
      parameters: {},
      async execute() {
        return [{ type: 'text', text: 'must not run' }]
      },
    }))

    send(agent, 'leave an unmatched historical call')
    await waitForIdle(ctx, agent)
    const disposeInjection = ctx.on('agent/pre-step', async ({ agent: subject, turn }, next) => {
      const decision = await next()
      if (subject === agent && turn === 2 && decision.kind === 'enter') {
        disposeInjection()
        return {
          kind: 'enter' as const,
          messages: [...decision.messages, createUserMessage({
            content: [{ type: 'text', text: 'new turn context' }],
            source: { kind: 'plugin', plugin: 'test' },
          })],
        }
      }
      return decision
    })
    send(agent, 'start a text-only turn')
    await waitForIdle(ctx, agent)

    expect(agent.session.snapshotEvents().flatMap(event =>
      event.type === 'user/message' && event.data.source.kind === 'plugin'
        ? [event.data.content]
        : [])[0])
      .toEqual([{ type: 'text', text: 'new turn context' }])
    expect(JSON.stringify(adapter.requests[1]?.messages)).toContain('new turn context')
  })
})

describe('steering from late extension points is never stranded', () => {
  it('steer() from an agent/turn-stopping listener continues the same turn', async () => {
    const adapter = new MockAdapter([
      textResponse('no tools, would stop here'),
      textResponse('continued because of steering'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    let steeredOnce = false
    ctx.on('agent/turn-stopping', () => {
      if (!steeredOnce) {
        steeredOnce = true
        agent.steer(createUserMessage({ content: [{ type: 'text', text: 'one more thing' }], source: { kind: 'user' } }))
      }
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    // the default decision was false (no tools), but steering forced step 2
    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('one more thing')
  })

})

describe('plugin exceptions are contained', () => {
  it('a throwing agent/turn-stopping listener ends the turn with an error, loop survives', async () => {
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    let threwOnce = false
    ctx.on('agent/turn-stopping', async () => {
      if (!threwOnce) {
        threwOnce = true
        throw new Error('broken continuation plugin')
      }
    })

    send(agent, 'first')
    await waitForIdle(ctx, agent)
    expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'error', error: { message: 'broken continuation plugin', code: 'UNKNOWN' } } },
    })

    // the loop is still alive: a second send works normally
    send(agent, 'second')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(2)
    expect(agent.status).toBe('idle')
  })

})

describe('disposal leaves the two-state status contract balanced', () => {
  it('disposing the fiber ends the active turn and never starts its queued tail', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)

    let agent!: Agent
    const fiber = await ctx.plugin(Object.assign(async (inner: Context) => {
      agent = await inner.agentLoop.create(SessionId('scoped'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))

    const statuses: string[] = []
    const reasons: TurnEndReason[] = []
    ctx.on('agent/status', ({ status }) => void statuses.push(status))
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    send(agent, 'queued tail')
    await fiber.dispose()
    await driverDone(agent)

    expect(statuses).toEqual(['running', 'idle'])
    expect(reasons).toEqual([{ kind: 'aborted', reason: { kind: 'disposed' } }])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(1)
    const messages = agent.session.snapshotEvents()
      .filter(event => event.type === 'user/message')
      .flatMap(event => event.data.content)
      .flatMap(block => block.type === 'text' ? [block.text] : [])
    expect(messages).toEqual(['go'])
    expect(adapter.requests).toHaveLength(1)
  })

  it('a throwing agent/status listener cannot break disposal or leak the registry entry', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)

    let agent!: Agent
    const fiber = await ctx.plugin(Object.assign(async (inner: Context) => {
      agent = await inner.agentLoop.create(SessionId('scoped'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))

    ctx.on('agent/status', ({ status }) => {
      if (status === 'idle') throw new Error('broken status listener')
    })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    await fiber.dispose()
    await driverDone(agent) // must not hang

    expect(ctx.agents.get(SessionId('scoped'))).toBeUndefined()
  })
})

describe('adapter registration, routing, and accepted-input ownership', () => {
  it('duplicate adapter registration is rejected', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    const adapter = new MockAdapter([])
    ctx.llm.registerAdapter(['m1'], adapter)
    expect(() => ctx.llm.registerAdapter(['m1'], new MockAdapter([])))
      .toThrow('already registered')
    // the original registration survives the failed attempt
    expect(ctx.llm.listProviders()).toEqual([{ id: 'm1', name: 'm1' }])
  })

  it('an agent without a model fails the step with a clear error (not NO_ADAPTER for "default")', async () => {
    const adapter = new MockAdapter([textResponse('never')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), {}) // no model

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    const turnEnd = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason.kind === 'error'
      ? turnEnd.data.reason.error.message
      : undefined).toContain('has no provider/model')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason.kind === 'error'
      ? turnEnd.data.reason.error.message
      : undefined).toContain('agent/request')
  })

  it('the agent/request waterfall can supply the model for a model-less agent', async () => {
    const adapter = new MockAdapter([textResponse('routed')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), {}) // no model — router plugin decides

    ctx.on('agent/request', async (_payload, next) => {
      return { ...await next(), provider: 'mock', model: 'mock' }
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
    expect(agent.session.deriveMessages().at(-1)?.content).toEqual([{ type: 'text', text: 'routed' }])
  })

  it('durable inbox splices carry exact messages and the claimed steer preserves its source', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'noop', {}), textResponse('done')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    ctx.tools.register(defineContentToolFixture({
      name: 'noop',
      description: '',
      parameters: {},
      async execute() {
        agent.steer(createUserMessage({ content: [{ type: 'text', text: 's' }], source: { kind: 'plugin', plugin: 'goal' } }))
        return []
      },
    }))

    const insertedSources: MessageSource[] = []
    const insertedShapes: string[][] = []
    const targets: string[] = []
    ctx.on('session/event', (session, event) => {
      if (session !== agent.session || event.type !== 'agent/inbox/spliced') return
      for (const message of event.data.inserted) {
        insertedSources.push(message.source)
        insertedShapes.push(Object.keys(message).sort())
        targets.push(event.data.target)
      }
    })

    send(agent, 'go') // no explicit source → default {kind:'user'} must be visible
    await waitForIdle(ctx, agent)

    expect(insertedSources).toEqual([
      { kind: 'user' },
      { kind: 'plugin', plugin: 'goal' },
    ])
    expect(insertedShapes).toEqual([
      ['content', 'id', 'role', 'source'],
      ['content', 'id', 'role', 'source'],
    ])
    expect(targets).toEqual(['next-turn', 'next-step'])
    const steeringSources = agent.session.snapshotEvents().flatMap(e =>
      e.type === 'user/message' && e.data.source.kind === 'plugin' ? [e.data.source] : [])
    expect(steeringSources).toEqual([{ kind: 'plugin', plugin: 'goal' }])
  })

  it('records each admitted next-step batch before the following claim', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'steer_next', {}),
      toolCallResponse('c2', 'steer_next', {}),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    const steering = [
      createUserMessage({ content: [{ type: 'text', text: 'first steer' }], source: { kind: 'user' } }),
      createUserMessage({ content: [{ type: 'text', text: 'second steer' }], source: { kind: 'user' } }),
    ]
    const agent = await ctx.agentLoop.create(SessionId('claim-order'), { provider: 'mock', model: 'mock' })
    let execution = 0
    ctx.tools.register(defineContentToolFixture({
      name: 'steer_next',
      description: '',
      parameters: {},
      async execute() {
        const message = steering[execution]
        execution += 1
        if (message !== undefined) agent.steer(message)
        return []
      },
    }))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const events = agent.session.snapshotEvents()
    const claims = events.flatMap(event => event.type === 'agent/inbox/spliced'
      && event.data.target === 'next-step'
      && event.data.outcome !== 'canceled'
      && (event.data.removedCount ?? 0) > 0
      ? [event]
      : [])
    expect(claims).toHaveLength(2)
    for (const [index, message] of steering.entries()) {
      const claim = claims[index]
      const admitted = events.find(event =>
        event.type === 'user/message' && event.data.id === message.id)
      expect(claim).toBeDefined()
      expect(admitted).toBeDefined()
      if (claim === undefined || admitted === undefined) continue
      expect(admitted.seq).toBeGreaterThan(claim.seq)
      const nextClaim = claims[index + 1]
      if (nextClaim !== undefined) expect(admitted.seq).toBeLessThan(nextClaim.seq)
    }
  })

})

describe('turn numbering continues across seeded sessions', () => {
  it('a forked agent continues turn numbers after the seed log', async () => {
    const first = new MockAdapter([textResponse('turn one')])
    const ctx = await harness(first)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    send(agent, 'first')
    await waitForIdle(ctx, agent)

    // fork: seed a second context's agent with the first session's log
    const second = new MockAdapter([textResponse('turn two')])
    const ctx2 = new Context()
    await ctx2.plugin(LlmRuntime)
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SessionProjectionRegistry)
    await ctx2.plugin(SystemPrompt)
    await ctx2.plugin(ToolRuntime)
    await ctx2.plugin(AgentRegistry)
    await ctx2.plugin(AgentLoop, { agents: [] })
    ctx2.llm.registerAdapter(['mock'], second)

    const { agent: forked } = await ctx2.agents.create({
      sessionId: SessionId('forked'),
      seed: agent.session.snapshotEvents(),
      agentOptions: { provider: 'mock', model: 'mock' },
    })

    const turns: number[] = []
    ctx2.on('session/event', (_s, event) => { if (event.type === 'turn/start') turns.push(event.data.turn) })
    forked.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await new Promise<void>((resolve) => {
      ctx2.on('agent/status', ({ agent: subject, status }) => {
        if (subject === forked && status === 'idle') resolve()
      })
    })

    expect(turns).toEqual([2])
  })
})

describe('discriminated SessionEvent narrows without casts', () => {
  it('narrows event.data from event.type', () => {
    const session = Session.create(SessionId('s'))
    const appended: SessionEvent = session.append('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('c1'), name: 'echo', arguments: '{}',
    })
    // compile-time: this switch narrows; runtime: values flow through
    switch (appended.type) {
      case 'tool/call': {
        expect(appended.data.callId).toBe('c1')
        expect(appended.data.name).toBe('echo')
        break
      }
      default: throw new Error('wrong narrow')
    }
  })
})

describe('a finish-error stream chunk ends the turn as error, not completed', () => {
  it('translates finish {kind:error} into a turn error with a logged error event', async () => {
    // A finish-error chunk must not produce a completed assistant turn.
    const failure = {
      message: 'provider 401',
      code: 'AUTH',
      status: 401,
      providerRetryAfterMs: 2_000,
      requestId: ProviderRequestId('finish-request-1'),
    }
    const errorStream: StreamChunk[] = [
      { type: 'finish', reason: { kind: 'error', failure } },
    ]
    const adapter = new MockAdapter([errorStream])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a-finish-error'), { provider: 'mock', model: 'mock' })

    const reasons: TurnEndReason[] = []
    const errors: unknown[] = []
    ctx.on('agent/error', ({ turn, step, error }) => {
      expect({ turn, step }).toEqual({ turn: 1, step: 1 })
      errors.push(error)
    })
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(reasons).toEqual([{ kind: 'error', error: failure }])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(LlmError)
    expect((errors[0] as LlmError).failure).toEqual(failure)

    const events = agent.session.snapshotEvents()
    const turnEnd = events.find(event => event.type === 'turn/end')
    expect(turnEnd).toMatchObject({ data: { reason: { kind: 'error', error: failure } } })
    // A failed step must not synthesize an assistant message.
    expect(events.some(event => event.type === 'assistant/message')).toBe(false)
  })

  it('translates finish {kind:aborted} into a turn error coded ABORTED', async () => {
    const abortedStream: StreamChunk[] = [
      { type: 'finish', reason: { kind: 'aborted', failure: { message: 'model stream aborted', code: 'ABORTED' } } },
    ]
    const adapter = new MockAdapter([abortedStream])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a-finish-aborted'), { provider: 'mock', model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(reasons).toEqual([{ kind: 'error', error: { message: 'model stream aborted', code: 'ABORTED' } }])
    expect(agent.session.snapshotEvents().some(event => event.type === 'assistant/message')).toBe(false)
  })

  it('handles a finish error without a code (code key omitted)', async () => {
    const errorStream: StreamChunk[] = [
      { type: 'finish', reason: { kind: 'error', failure: { message: 'codeless failure', code: 'UNKNOWN' } } },
    ]
    const adapter = new MockAdapter([errorStream])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a-finish-error-nocode'), { provider: 'mock', model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(reasons).toEqual([{ kind: 'error', error: { message: 'codeless failure', code: 'UNKNOWN' } }])
  })
})

describe('step boundary publication order', () => {
  it('the step/start event is in session.snapshotEvents() when its session/event listener fires', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a-step-order'), { provider: 'mock', model: 'mock' })

    const observed: { turn: number; step: number; lastEventType: string | undefined; sawStepStart: boolean }[] = []
    ctx.on('session/event', (subject, event) => {
      if (subject !== agent.session || event.type !== 'step/start') return
      const events = subject.snapshotEvents()
      const last = events.at(-1)
      observed.push({
        turn: event.data.turn,
        step: event.data.step,
        lastEventType: last?.type,
        sawStepStart: events.some(e => e.type === 'step/start' && e.data.turn === event.data.turn && e.data.step === event.data.step),
      })
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(observed).toHaveLength(1)
    expect(observed[0]).toMatchObject({ turn: 1, step: 1, lastEventType: 'step/start', sawStepStart: true })
  })
})

describe('turn and step boundary recovery', () => {
  // The session invariant companion makes an unbalanced log fail the test.
  async function balancedHarness(adapter: MockAdapter) {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountInvariants(ctx)
    ctx.llm.registerAdapter(['mock'], adapter)
    return ctx
  }

  /** Count turn/step boundary events for balance assertions. */
  function boundaryCounts(agent: Agent) {
    const e = agent.session.snapshotEvents()
    return {
      turnStart: e.filter(x => x.type === 'turn/start').length,
      turnEnd: e.filter(x => x.type === 'turn/end').length,
      stepStart: e.filter(x => x.type === 'step/start').length,
      stepEnd: e.filter(x => x.type === 'step/end').length,
      errors: e.filter(x => x.type === 'turn/end' && x.data.reason.kind === 'error').length,
      lastTurnEnd: e.findLast(x => x.type === 'turn/end'),
    }
  }

  it('a throwing step/start observer cannot change a successful turn', async () => {
    const adapter = new MockAdapter([textResponse('request completed')])
    const ctx = await balancedHarness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a-stepstart'), { provider: 'mock', model: 'mock' })

    // Session owns post-commit containment. The loop sees a successful append,
    // runs the request, and balances the ordinary step and turn boundaries.
    let threw = false
    ctx.on('session/event', (_s, event) => {
      if (event.type === 'step/start' && !threw) { threw = true; throw new Error('boom step-start') }
    })
    const errors: Error[] = []
    ctx.on('agent/error', ({ error }) => {
      if (error instanceof Error) errors.push(error)
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const e = agent.session.snapshotEvents()
    const c = boundaryCounts(agent)
    expect(c).toMatchObject({ turnStart: 1, turnEnd: 1, stepStart: 1, stepEnd: 1, errors: 0 })
    expect(errors).toEqual([])
    // step/end precedes turn/end (the invariants oracle would reject
    // turn/end-while-step-open, but assert the order explicitly too).
    const stepEndIdx = e.findIndex(x => x.type === 'step/end')
    const turnEndIdx = e.findIndex(x => x.type === 'turn/end')
    expect(stepEndIdx).toBeGreaterThanOrEqual(0)
    expect(stepEndIdx).toBeLessThan(turnEndIdx)
  })

  it('a pre-commit turn/start rejection leaves no durable turn state', async () => {
    const adapter = new MockAdapter([])
    const ctx = await balancedHarness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a-turnstart-veto'), { provider: 'mock', model: 'mock' })
    let rejected = false
    ctx.on('internal/dispatch', (_mode, name, args) => {
      if (name !== 'session/event') return
      const event = args[1] as SessionEvent
      if (event.type === 'turn/start' && !rejected) {
        rejected = true
        throw new Error('reject turn-start before commit')
      }
    })
    const errors: Error[] = []
    ctx.on('agent/error', ({ error }) => {
      if (error instanceof Error) errors.push(error)
    })

    send(agent, 'rejected')
    await waitForIdle(ctx, agent)

    expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start'
      || event.type === 'user/message')).toBe(false)
    expect(agent.inbox.nextTurn).toHaveLength(1)
    expect(errors.map(error => error.message)).toEqual(['reject turn-start before commit'])
    expect(adapter.requests).toHaveLength(0)
  })

  it('a pre-commit step/start validation failure does not invent a step boundary', async () => {
    const adapter = new MockAdapter([textResponse('never reached')])
    const ctx = await balancedHarness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a-stepstart-veto'), { provider: 'mock', model: 'mock' })
    let rejected = false
    ctx.on('internal/dispatch', (_mode, name, args) => {
      if (name !== 'session/event') return
      const event = args[1] as SessionEvent
      if (event.type === 'step/start' && !rejected) {
        rejected = true
        throw new Error('reject step-start before commit')
      }
    })
    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toEqual([])
    expect(boundaryCounts(agent)).toMatchObject({
      turnStart: 1,
      turnEnd: 1,
      stepStart: 0,
      stepEnd: 0,
      errors: 1,
    })
    expect(agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'error', error: { message: 'reject step-start before commit', code: 'UNKNOWN' } } },
    })
  })

  it('a step/end validation failure surfaces the resulting open-step invariant', async () => {
    const adapter = new MockAdapter([textResponse('completed before close validation')])
    const ctx = await balancedHarness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a-stepend-veto'), { provider: 'mock', model: 'mock' })
    let rejected = false
    ctx.on('internal/dispatch', (_mode, name, args) => {
      if (name !== 'session/event') return
      const event = args[1] as SessionEvent
      if (event.type === 'step/end' && !rejected) {
        rejected = true
        throw new Error('reject first step-end')
      }
    })
    const errors: Error[] = []
    ctx.on('agent/error', ({ error }) => {
      if (error instanceof Error) errors.push(error)
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
    expect(errors.map(error => error.message)).toEqual([
      'reject first step-end',
      'invariant violated by "@deepseek-ai/dsh-session": turn/end 1 while step 1 is still open',
    ])
    expect(boundaryCounts(agent)).toMatchObject({
      turnStart: 1,
      turnEnd: 0,
      stepStart: 1,
      stepEnd: 0,
      errors: 0,
    })
  })

  it('a throwing agent/error listener during a step-error path still balances the turn, loop survives', async () => {
    // Listener failure cannot interrupt error finalization or the next turn.
    const errorStream: StreamChunk[] = [{ type: 'finish', reason: { kind: 'error', failure: { message: 'provider 500', code: 'SERVER' } } }]
    const adapter = new MockAdapter([errorStream, textResponse('turn 2 ok')])
    const ctx = await balancedHarness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a-errorlistener'), { provider: 'mock', model: 'mock' })

    let threw = false
    ctx.on('agent/error', () => { if (!threw) { threw = true; throw new Error('boom error-listener') } })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const c = boundaryCounts(agent)
    // turn 1 balanced despite the throwing agent/error listener.
    expect(c.turnStart).toBe(1)
    expect(c.turnEnd).toBe(1)
    expect(c.stepStart).toBe(c.stepEnd)
    expect(c.lastTurnEnd?.type === 'turn/end' && c.lastTurnEnd.data.reason).toMatchObject({
      kind: 'error',
      error: { message: 'provider 500', code: 'SERVER' },
    })
    expect(threw).toBe(true)

    // loop survives: a second turn runs to completion (invariants oracle would
    // throw on its turn/start if turn 1 had been left open).
    send(agent, 'again')
    await waitForIdle(ctx, agent)
    const c2 = boundaryCounts(agent)
    expect(c2.turnStart).toBe(2)
    expect(c2.turnEnd).toBe(2)
    expect(c2.stepStart).toBe(c2.stepEnd)
  })

  it('disposal during a running turn ends the turn with reason disposed (balanced)', async () => {
    // The 'hang' adapter blocks in stream() until the signal aborts; disposing
    // the agent's fiber mid-turn aborts the in-flight step. The turn must close
    // balanced with reason disposed (no error event for a disposal).
    const adapter = new MockAdapter(['hang'])
    const ctx = await balancedHarness(adapter)
    let agent!: Agent
    const fiber = await ctx.plugin(Object.assign(async (inner: Context) => {
      agent = await inner.agentLoop.create(SessionId('a-dispose'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    await fiber.dispose() // dispose during the hanging step
    await driverDone(agent)

    const e = agent.session.snapshotEvents()
    const turnStarts = e.filter(x => x.type === 'turn/start').length
    const turnEnds = e.filter(x => x.type === 'turn/end').length
    expect(turnStarts).toBe(1)
    expect(turnEnds).toBe(1) // balanced — the turn was closed despite disposal
    expect(reasons).toEqual([{ kind: 'aborted', reason: { kind: 'disposed' } }])
    // no error reason: disposal is not a failure.
    expect(e.some(x => x.type === 'turn/end' && x.data.reason.kind === 'error')).toBe(false)
  })

  it('contains a pre-step throw after disposal inside a balanced no-step turn', async () => {
    const adapter = new MockAdapter([textResponse('never reached')])
    const ctx = await balancedHarness(adapter)
    let agent!: Agent
    const fiber = await ctx.plugin(Object.assign(async (inner: Context) => {
      agent = await inner.agentLoop.create(SessionId('a-prestep-dispose-throw'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))

    let threw = false
    ctx.on('agent/pre-step', (_payload, next) => {
      if (threw) return next()
      threw = true
      void fiber.dispose()
      throw new Error('boom pre-step during disposal')
    })
    const errorEmits: Error[] = []
    ctx.on('agent/error', ({ error }) => {
      if (error instanceof Error) errorEmits.push(error)
    })

    send(agent, 'go')
    await agent.whenIdle()

    const e = agent.session.snapshotEvents()
    expect(e.filter(x => x.type === 'turn/start' || x.type === 'turn/end').map(x => x.type))
      .toEqual(['turn/start', 'turn/end'])
    expect(e.find(x => x.type === 'turn/end')?.data.reason)
      .toEqual({ kind: 'aborted', reason: { kind: 'disposed' } })
    expect(e.some(x => x.type === 'step/start')).toBe(false)
    expect(errorEmits).toHaveLength(0)
  })

  it('a throwing turn/start observer cannot starve the loop or later turns', async () => {
    const adapter = new MockAdapter([textResponse('turn 1'), textResponse('turn 2')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a-preturn'), { provider: 'mock', model: 'mock' })

    let threw = false
    ctx.on('session/event', (_session, event) => {
      if (!threw && event.type === 'turn/start') { threw = true; throw new Error('boom turn/start append') }
    })
    const errors: Error[] = []
    ctx.on('agent/error', ({ error }) => {
      if (error instanceof Error) errors.push(error)
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(errors).toEqual([])
    // Session contains the observer failure per listener, so the committed turn
    // remains visible to later observers and executes normally.
    const types = agent.session.snapshotEvents().map(e => e.type)
    expect(types.filter(t => t === 'turn/start')).toHaveLength(1)
    expect(types.filter(t => t === 'turn/end')).toHaveLength(1)
    const lastBoundary = agent.session.snapshotEvents().findLast(e => e.type === 'turn/start' || e.type === 'turn/end')
    expect(lastBoundary?.type).toBe('turn/end')
    expect(agent.session.snapshotEvents().at(-1)?.type).toBe('turn/end')

    // loop survives: a second turn runs normally.
    send(agent, 'second')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(2)
  })

  it('a throwing step/end observer cannot rewrite the turn outcome', async () => {
    const adapter = new MockAdapter([textResponse('all good'), textResponse('turn 2 ok')])
    const ctx = await balancedHarness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a-stepend-throw'), { provider: 'mock', model: 'mock' })

    let threw = false
    ctx.on('session/event', (_s, event) => {
      if (event.type === 'step/end' && !threw) { threw = true; throw new Error('boom step-end') }
    })
    const errors: Error[] = []
    ctx.on('agent/error', ({ error }) => {
      if (error instanceof Error) errors.push(error)
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const c = boundaryCounts(agent)
    expect(c).toMatchObject({ turnStart: 1, turnEnd: 1, stepStart: 1, stepEnd: 1, errors: 0 })
    expect(errors).toEqual([])
    expect(c.lastTurnEnd?.type === 'turn/end' && c.lastTurnEnd.data.reason)
      .toEqual({ kind: 'completed' })

    // step/end precedes turn/end (ordering contract)
    const e = agent.session.snapshotEvents()
    const stepEndIdx = e.findIndex(x => x.type === 'step/end')
    const turnEndIdx = e.findIndex(x => x.type === 'turn/end')
    expect(stepEndIdx).toBeGreaterThanOrEqual(0)
    expect(stepEndIdx).toBeLessThan(turnEndIdx)

    // loop survives: a subsequent turn runs to completion
    send(agent, 'again')
    await waitForIdle(ctx, agent)
    const c2 = boundaryCounts(agent)
    expect(c2.turnStart).toBe(2)
    expect(c2.turnEnd).toBe(2)
    expect(c2.stepStart).toBe(c2.stepEnd)
  })

  it('a throwing step/end observer cannot interrupt error finalization', async () => {
    // Observer failure after step/end commit cannot interrupt turn finalization.
    const errorStream: StreamChunk[] = [{ type: 'finish', reason: { kind: 'error', failure: { message: 'provider 500', code: 'SERVER' } } }]
    const adapter = new MockAdapter([errorStream, textResponse('turn 2 ok')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a-stependthrow'), { provider: 'mock', model: 'mock' })

    let threw = false
    ctx.on('session/event', (_s, event) => {
      if (!threw && event.type === 'step/end') { threw = true; throw new Error('boom step/end listener') }
    })
    const errors: Error[] = []
    ctx.on('agent/error', ({ error }) => {
      if (error instanceof Error) errors.push(error)
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const e = agent.session.snapshotEvents()
    // Both step/end and turn/end are present — finalization ran to completion.
    expect(e.some(x => x.type === 'step/end')).toBe(true)
    expect(e.some(x => x.type === 'turn/end')).toBe(true)
    expect(e.at(-1)?.type).toBe('turn/end')
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(LlmError)
    expect((errors[0] as LlmError).failure).toEqual({ message: 'provider 500', code: 'SERVER' })

    // loop survives.
    send(agent, 'again')
    await waitForIdle(ctx, agent)
    expect(e.filter(x => x.type === 'turn/start').length).toBeGreaterThanOrEqual(1)
  })

  it('a throwing session/event listener on turn/end is contained (turn still balanced, loop survives)', async () => {
    // Session contains the observer failure after committing turn/end, so the
    // boundary stays authoritative and the loop continues normally.
    const adapter = new MockAdapter([textResponse('turn 1'), textResponse('turn 2')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a-turnendappend'), { provider: 'mock', model: 'mock' })

    let threw = false
    ctx.on('session/event', (_s, event) => {
      if (!threw && event.type === 'turn/end') { threw = true; throw new Error('boom turn/end listener') }
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    // turn 1 is balanced despite the throwing turn/end listener.
    const e1 = agent.session.snapshotEvents()
    expect(e1.filter(x => x.type === 'turn/start')).toHaveLength(1)
    expect(e1.filter(x => x.type === 'turn/end')).toHaveLength(1)
    expect(e1.at(-1)?.type).toBe('turn/end')

    // loop survives: a second turn runs to completion.
    send(agent, 'again')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(2)
    expect(agent.session.snapshotEvents().filter(x => x.type === 'turn/end')).toHaveLength(2)
  })
})

describe('tool result call identity', () => {
  it('the loop records tool/result under the model call.id even when a post-execute listener replaces content', async () => {
    // Model emits a tool-call with id "c1", then a final text turn.
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { x: 1 }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'echo',
      parameters: { x: { type: 'number' } },
      async execute() { return [{ type: 'text', text: 'ok' }] },
    }))

    // A post-execute listener transforms the result (accept-with-replacement).
    // The loop must still record the tool/result under the model's authoritative
    // call.id, which is the immutable identity carried by the execution input.
    ctx.on('tools/post-execute', (exec, _result) => {
      expect(exec.callId).toBe(ToolCallId('c1')) // the loop passed the real id in
      return Promise.resolve({ kind: 'accept', content: [{ type: 'text', text: 'ok' }] })
    }, { prepend: true })

    const agent = await ctx.agentLoop.create(SessionId('a-callid'), { provider: 'mock', model: 'mock' })
    send(agent, 'use tool')
    await waitForIdle(ctx, agent)

    // The logged tool/result.callId is the originating call.id.
    const resultEvent = agent.session.snapshotEvents().find(e => e.type === 'tool/result')
    expect(resultEvent?.type).toBe('tool/result')
    if (resultEvent?.type === 'tool/result') {
      expect(resultEvent.data.message.source.callId).toBe(ToolCallId('c1'))
    }

    // And deriveMessages pairs the tool-result with the assistant tool-call:
    // the derived tool-result block's toolCallId equals the original call.id.
    const messages = agent.session.deriveMessages()
    const toolResultBlock = messages
      .flatMap(m => m.content)
      .find(b => b.type === 'tool-result')
    expect(toolResultBlock?.type).toBe('tool-result')
    if (toolResultBlock?.type === 'tool-result') {
      expect(toolResultBlock.toolCallId).toBe(ToolCallId('c1'))
    }
  })
})

describe('disposal and cancellation during pre-step assembly', () => {
  it('disposal during system-prompt assembly closes a no-step turn', { timeout: 30000 }, async () => {
    // Start disposal, then release assembly. Do not await disposal first: it
    // waits for the blocked driver to exit.
    const adapter = new MockAdapter(['hang'])
    let releaseAssemble!: () => void
    const blocked = new Promise<void>(r => void (releaseAssemble = r))

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountInvariants(ctx)
    ctx.llm.registerAdapter(['mock'], adapter)

    // Parent-owned listener survives agent-fiber disposal.
    const unlisten = ctx.on('system-prompt/assemble', async function (_assembly, _context, next) {
      await blocked
      return next()
    })

    let agent!: Agent
    const fiber = await ctx.plugin(Object.assign(async (inner: Context) => {
      agent = await inner.agentLoop.create(SessionId('a-dispose-assemble'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    // Give the loop time to reach pre-step assembly.
    await new Promise(r => setTimeout(r, 50))

    // Release assembly before awaiting disposal because disposal joins the blocked driver.
    const disposalDone = fiber.dispose()

    releaseAssemble()
    await disposalDone
    await driverDone(agent)
    unlisten()

    const e = agent.session.snapshotEvents()
    expect(e.filter(x => x.type === 'turn/start' || x.type === 'turn/end').map(x => x.type))
      .toEqual(['turn/start', 'turn/end'])
    expect(e.some(x => x.type === 'step/start')).toBe(false)
    expect(e.some(x => x.type === 'step/end')).toBe(false)
    expect(e.some(x => x.type === 'assistant/attempt')).toBe(false)
    expect(reasons).toEqual([{ kind: 'aborted', reason: { kind: 'disposed' } }])
  })

  it('cancel during system-prompt assembly closes a no-step turn', { timeout: 30000 }, async () => {
    const adapter = new MockAdapter([textResponse('should not appear')])
    let releaseAssemble!: () => void
    const blocker = new Promise<void>(r => void (releaseAssemble = r))

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountInvariants(ctx)
    ctx.llm.registerAdapter(['mock'], adapter)

    const unlisten = ctx.on('system-prompt/assemble', async function (_assembly, _context, next) {
      await blocker
      return next()
    })

    let agent!: Agent
    const fiber = await ctx.plugin(Object.assign(async (inner: Context) => {
      agent = await inner.agentLoop.create(SessionId('a-cancel-assemble'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 50))
    agent.cancel({ kind: 'user' })

    releaseAssemble()
    await waitForIdle(ctx, agent)
    await fiber.dispose()
    await driverDone(agent)
    unlisten()

    const e = agent.session.snapshotEvents()
    expect(e.filter(x => x.type === 'turn/start' || x.type === 'turn/end').map(x => x.type))
      .toEqual(['turn/start', 'turn/end'])
    expect(e.some(x => x.type === 'step/start')).toBe(false)
    expect(e.some(x => x.type === 'step/end')).toBe(false)
    expect(e.some(x => x.type === 'assistant/attempt')).toBe(false)
    expect(e.some(x => x.type === 'assistant/message')).toBe(false)
    expect(adapter.requests).toHaveLength(0)
    expect(reasons).toEqual([{ kind: 'aborted', reason: { kind: 'user' } }])
  })

  it('disposal during pre-step closes a no-step turn', { timeout: 15000 }, async () => {
    // Start disposal, then release pre-step; awaiting disposal first would deadlock on the blocked driver.
    const adapter = new MockAdapter(['hang'])
    let releasePreStep!: () => void
    const blocker = new Promise<void>(r => void (releasePreStep = r))

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountInvariants(ctx)
    ctx.llm.registerAdapter(['mock'], adapter)

    ctx.on('agent/pre-step', async (_payload, next) => {
      await blocker
      return next()
    })

    let agent!: Agent
    const fiber = await ctx.plugin(Object.assign(async (inner: Context) => {
      agent = await inner.agentLoop.create(SessionId('a-dispose-prestep'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 50))

    const disposalDone = fiber.dispose()
    releasePreStep()
    await disposalDone
    await driverDone(agent)

    // The post-listener cancellation check catches disposal before any step or LLM call.
    const e = agent.session.snapshotEvents()
    expect(e.filter(x => x.type === 'turn/start' || x.type === 'turn/end').map(x => x.type))
      .toEqual(['turn/start', 'turn/end'])
    expect(e.some(x => x.type === 'step/start')).toBe(false)
    expect(e.some(x => x.type === 'assistant/attempt')).toBe(false)
    expect(reasons).toEqual([{ kind: 'aborted', reason: { kind: 'disposed' } }])
  })

  it('cancel during pre-step closes a no-step turn', { timeout: 15000 }, async () => {
    // Release pre-step after cancellation to exercise the post-listener check.
    const adapter = new MockAdapter(['hang'])
    let releasePreStep!: () => void
    const blocker = new Promise<void>(r => void (releasePreStep = r))

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountInvariants(ctx)
    ctx.llm.registerAdapter(['mock'], adapter)

    ctx.on('agent/pre-step', async (_payload, next) => {
      await blocker
      return next()
    })

    let agent!: Agent
    const fiber = await ctx.plugin(Object.assign(async (inner: Context) => {
      agent = await inner.agentLoop.create(SessionId('a-cancel-prestep'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    agent.cancel({ kind: 'user' })

    releasePreStep()
    await waitForIdle(ctx, agent)
    await fiber.dispose()
    await driverDone(agent)

    const e = agent.session.snapshotEvents()
    expect(e.filter(x => x.type === 'turn/start' || x.type === 'turn/end').map(x => x.type))
      .toEqual(['turn/start', 'turn/end'])
    expect(e.some(x => x.type === 'step/start')).toBe(false)
    expect(e.some(x => x.type === 'assistant/attempt')).toBe(false)
    expect(reasons).toEqual([{ kind: 'aborted', reason: { kind: 'user' } }])
  })

  it('disposal during assembly does not leak an LLM call or append an Assistant settlement', { timeout: 15000 }, async () => {
    // The key assertion from the original bug report: after disposal, no
    // assistant/attempt or assistant/message appears — the turn ends disposed
    // before any model interaction.
    const adapter = new MockAdapter([textResponse('should not appear')])
    let releaseAssemble!: () => void
    const blocker = new Promise<void>(r => void (releaseAssemble = r))

    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await mountInvariants(ctx)
    ctx.llm.registerAdapter(['mock'], adapter)

    ctx.on('system-prompt/assemble', async function (_assembly, _context, next) {
      await blocker
      return next()
    })

    let agent!: Agent
    const fiber = await ctx.plugin(Object.assign(async (inner: Context) => {
      agent = await inner.agentLoop.create(SessionId('a-dispose-no-leak'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 50))

    const disposalDone = fiber.dispose()
    releaseAssemble()
    await disposalDone
    await driverDone(agent)

    const e = agent.session.snapshotEvents()
    expect(e.filter(x => x.type === 'turn/start' || x.type === 'turn/end').map(x => x.type))
      .toEqual(['turn/start', 'turn/end'])
    expect(e.find(x => x.type === 'turn/end')?.data.reason)
      .toEqual({ kind: 'aborted', reason: { kind: 'disposed' } })
    expect(e.some(x => x.type === 'assistant/attempt')).toBe(false)
    expect(e.some(x => x.type === 'assistant/message')).toBe(false)
    expect(adapter.requests).toHaveLength(0)
  })
})
