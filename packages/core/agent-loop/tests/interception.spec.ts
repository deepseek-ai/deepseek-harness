import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, ToolCallId  } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  SessionId,
  type SessionEvent,
  type TurnEndReason,
  type UserMessage,
} from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture, type PostToolDecision, type PreToolDecision } from '@deepseek-ai/dsh-tools'
import AgentRegistry, {
  type Agent,
  type PreStepDecision,
  type SessionStartSource,
} from '@deepseek-ai/dsh-agent'

import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

/**
 * The interception points introduced by the hooks taxonomy: `agent/pre-step`,
 * `agent/session-start`, `agent/turn-stopping`, and the
 * `tools/pre-execute` / `tools/post-execute`
 * split with `additionalContexts` buffering. These verify the canonical event
 * API a hook bridge (or a native plugin) programs against, WITHOUT any
 * external protocol — a native plugin uses the typed decisions directly.
 */

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

function events(agent: Agent): readonly SessionEvent[] {
  return agent.session.snapshotEvents()
}

describe('agent/pre-step', () => {
  it('enter (default via next) records the user/message unchanged', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    const seen: string[] = []
    ctx.on('agent/pre-step', async ({ messages }, next) => {
      seen.push(messages[0]!.content.map(b => (b.type === 'text' ? b.text : '')).join(''))
      return next()
    })

    send(agent, 'hello')
    await waitForIdle(ctx, agent)

    expect(seen).toEqual(['hello'])
    const userMsg = events(agent).find(e => e.type === 'user/message')
    expect(userMsg?.type === 'user/message' && userMsg.data.content).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('reports the request coordinates for initial and tool-continuation prompts', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'echo', { text: 'hi' }),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'echo',
      parameters: { text: { type: 'string', required: true } },
      execute: async ({ text }) => [{ type: 'text', text }],
    }))
    const agent = await ctx.agentLoop.create(SessionId('prompt-coordinates'), { provider: 'mock', model: 'mock' })
    const seen: Array<{ turn: number; step: number; messages: number }> = []
    ctx.on('agent/pre-step', async ({ messages, turn, step }, next) => {
      seen.push({ turn, step, messages: messages.length })
      return next()
    })

    send(agent, 'hello')
    await waitForIdle(ctx, agent)

    expect(seen).toEqual([
      { turn: 1, step: 1, messages: 1 },
      { turn: 1, step: 2, messages: 0 },
    ])
  })

  it('publishes frozen input without replacing its identity', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('owned-input'), { provider: 'mock', model: 'mock' })
    const entered = Promise.withResolvers<undefined>()
    const decision = Promise.withResolvers<PreStepDecision>()
    const observed: UserMessage[] = []
    ctx.on('agent/pre-step', async ({ agent: subject, messages }) => {
      if (subject !== agent) return { kind: 'enter', messages }
      const message = messages[0]!
      expect(Object.isFrozen(message)).toBe(true)
      expect(Object.isFrozen(message.content)).toBe(true)
      expect(Object.isFrozen(message.content[0])).toBe(true)
      expect(Object.isFrozen(message.source)).toBe(true)
      expect(() => {
        const block = message.content[0]
        if (block?.type === 'text') block.text = 'listener mutation'
      }).toThrow()
      observed.push(message)
      entered.resolve(undefined)
      return decision.promise
    })
    const input: UserMessage = createUserMessage({
      content: [{ type: 'text', text: 'accepted text' }],
      source: { kind: 'plugin', plugin: 'accepted source' },
    })

    const idle = waitForIdle(ctx, agent)
    agent.followup(input)
    await entered.promise
    const block = input.content[0]
    expect(() => {
      if (block?.type === 'text') block.text = 'caller mutation'
    }).toThrow(TypeError)
    expect(() => {
      if (input.source.kind === 'plugin') input.source.plugin = 'caller mutation'
    }).toThrow(TypeError)
    decision.resolve({ kind: 'enter', messages: [input] })
    await idle

    expect(observed).toHaveLength(1)
    expect(observed[0]).not.toBe(input)
    expect(observed[0]).toMatchObject({
      content: [{ type: 'text', text: 'accepted text' }],
      source: { kind: 'plugin', plugin: 'accepted source' },
    })
    const userMsg = events(agent).find(event => event.type === 'user/message')
    expect(userMsg?.type === 'user/message' && userMsg.data).toEqual(input)
  })

  it('enter with content rewrites the prompt before it is recorded', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    ctx.on('agent/pre-step', async ({ messages }): Promise<PreStepDecision> =>
      ({
        kind: 'enter',
        messages: [{ ...messages[0]!, content: [{ type: 'text', text: 'REWRITTEN' }] }],
      }))

    send(agent, 'original')
    await waitForIdle(ctx, agent)

    const userMsg = events(agent).find(e => e.type === 'user/message')
    expect(userMsg?.type === 'user/message' && userMsg.data.content).toEqual([{ type: 'text', text: 'REWRITTEN' }])
    // the rewritten prompt is what reached the model
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('REWRITTEN')
    expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('original')
  })

  it('enter with additional messages records separately sourced context in the turn', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    ctx.on('agent/pre-step', async ({ messages }): Promise<PreStepDecision> =>
      ({
        kind: 'enter',
        messages: [...messages, createUserMessage({
          content: [{ type: 'text', text: '<system-reminder>extra ctx</system-reminder>' }],
          source: { kind: 'plugin', plugin: 'test' },
        })],
      }))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const log = events(agent)
    const userMsg = log.find(e => e.type === 'user/message' && e.data.source.kind === 'user')
    const ctxMsg = log.find(e => e.type === 'user/message' && e.data.source.kind === 'plugin')
    expect(userMsg).toBeDefined()
    expect(ctxMsg?.type === 'user/message' && ctxMsg.data.content).toEqual([{ type: 'text', text: '<system-reminder>extra ctx</system-reminder>' }])
    expect(ctxMsg?.type === 'user/message' && ctxMsg.data.source).toEqual({ kind: 'plugin', plugin: 'test' })
    const sent = JSON.stringify(adapter.requests[0]!.messages)
    expect(sent).toContain('extra ctx')
  })

  it('does not open another step when a completed turn rewrites pending input to empty', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('empty-completed-continuation'), {
      provider: 'mock',
      model: 'mock',
    })
    ctx.on('agent/turn-stopping', ({ agent: subject }) => {
      subject.inject(createUserMessage({
        content: [{ type: 'text', text: 'pending context' }],
        source: { kind: 'plugin', plugin: 'test' },
      }))
    })
    ctx.on('agent/pre-step', async ({ step }, next) => {
      const decision = await next()
      return step === 1 || decision.kind === 'reject'
        ? decision
        : { kind: 'enter', messages: [] }
    })

    send(agent, 'finish once')
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(events(agent).filter(event => event.type === 'step/start')).toHaveLength(1)
  })

  it('reject closes the claimed prompt turn without a step or model call', async () => {
    const adapter = new MockAdapter([textResponse('should not run')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    ctx.on('agent/pre-step', async (): Promise<PreStepDecision> => ({ kind: 'reject' }))

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event: SessionEvent) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'do something' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    // the model was never called
    expect(adapter.requests).toHaveLength(0)
    const log = events(agent)
    expect(log.filter(e => e.type === 'turn/start' || e.type === 'turn/end').map(e => e.type))
      .toEqual(['turn/start', 'turn/end'])
    expect(log.some(e => e.type === 'user/message')).toBe(false)
    expect(log.some(e => e.type === 'step/start')).toBe(false)
    expect(reasons).toEqual([{ kind: 'blocked' }])
  })

  it('stages inject and steer during pre-step for the entered turn', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('pre-step-outbox'), { provider: 'mock', model: 'mock' })
    const entered = Promise.withResolvers<undefined>()
    const decision = Promise.withResolvers<PreStepDecision>()
    let claimed: UserMessage[] = []
    let firstProposal = true
    ctx.on('agent/pre-step', async ({ messages }) => {
      if (!firstProposal) return { kind: 'enter', messages }
      firstProposal = false
      claimed = messages
      entered.resolve(undefined)
      return decision.promise
    })

    const idle = waitForIdle(ctx, agent)
    send(agent, 'entered prompt')
    await entered.promise
    expect(agent.status).toBe('running')
    expect(events(agent).some(event => event.type === 'turn/start')).toBe(true)

    agent.inject(createUserMessage({
      content: [{ type: 'text', text: 'attached context' }],
      source: { kind: 'plugin', plugin: 'test' },
    }))
    agent.steer(createUserMessage({ content: [{ type: 'text', text: 'pre-step steering' }], source: { kind: 'user' } }))
    expect(events(agent).some(event => event.type === 'user/message')).toBe(false)
    expect(agent.inbox.nextStep.map(message => message.content[0]))
      .toEqual([
        { type: 'text', text: 'attached context' },
        { type: 'text', text: 'pre-step steering' },
      ])

    decision.resolve({ kind: 'enter', messages: claimed })
    await idle
    expect(agent.inbox.hasPending).toBe(false)

    const staged = events(agent).filter(event =>
      event.type === 'turn/start' || event.type === 'user/message')
    expect(staged.map(event => event.type)).toEqual([
      'turn/start',
      'user/message',
      'user/message',
      'user/message',
    ])
    expect(staged[1]?.type === 'user/message' && staged[1].data.content)
      .toEqual([{ type: 'text', text: 'entered prompt' }])
    expect(staged[2]?.type === 'user/message' && staged[2].data.content)
      .toEqual([{ type: 'text', text: 'attached context' }])
    expect(staged[3]?.type === 'user/message' && staged[3].data.content)
      .toEqual([{ type: 'text', text: 'pre-step steering' }])
    const firstRequest = JSON.stringify(adapter.requests[0]?.messages)
    expect(firstRequest).toContain('entered prompt')
    expect(firstRequest).not.toContain('attached context')
    expect(firstRequest).not.toContain('pre-step steering')
    const nextRequest = JSON.stringify(adapter.requests[1]?.messages)
    expect(nextRequest).toContain('attached context')
    expect(nextRequest).toContain('pre-step steering')
  })

  it('preserves input staged after the blocked batch was claimed', async () => {
    const adapter = new MockAdapter([textResponse('retried')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('blocked-pre-step-outbox'), { provider: 'mock', model: 'mock' })
    const entered = Promise.withResolvers<undefined>()
    const decision = Promise.withResolvers<PreStepDecision>()
    const disposeBlock = ctx.on('agent/pre-step', async () => {
      entered.resolve(undefined)
      return decision.promise
    })

    const blockedIdle = waitForIdle(ctx, agent)
    send(agent, 'blocked prompt')
    await entered.promise
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: 'staged context' }],
      source: { kind: 'plugin', plugin: 'test' },
    }))
    agent.steer(createUserMessage({ content: [{ type: 'text', text: 'staged steering' }], source: { kind: 'user' } }))
    decision.resolve({ kind: 'reject' })
    await blockedIdle

    expect(agent.inbox.nextStep.map(message => message.content[0]))
      .toEqual([
        { type: 'text', text: 'staged context' },
        { type: 'text', text: 'staged steering' },
      ])
    expect(events(agent).filter(event => event.type === 'turn/start' || event.type === 'turn/end')
      .map(event => event.type)).toEqual(['turn/start', 'turn/end'])
    expect(adapter.requests).toEqual([])

    disposeBlock()
    send(agent, 'resume')
    await waitForIdle(ctx, agent)

    const staged = events(agent).filter(event =>
      event.type === 'user/message')
    expect(staged.map(event => event.type)).toEqual([
      'user/message',
      'user/message',
      'user/message',
    ])
    expect(JSON.stringify(adapter.requests[0]?.messages)).not.toContain('blocked prompt')
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('staged context')
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('staged steering')
  })

  it('preserves later queued work when a step is rejected', async () => {
    const adapter = new MockAdapter([
      textResponse('continued'),
      textResponse('wake reply'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('rejected-pre-step-order'), {
      provider: 'mock',
      model: 'mock',
    })
    ctx.on('agent/pre-step', async ({ messages }, next) => {
      const decision = await next()
      return messages.some(message =>
        message.content.some(block => block.type === 'text' && block.text === 'blocked prompt'))
        ? { kind: 'reject' as const }
        : decision
    })
    ctx.on('agent/pre-step', async ({ agent: subject, messages }, next) => {
      if (messages.some(message =>
        message.content.some(block => block.type === 'text' && block.text === 'blocked prompt'))) {
        subject.inject(createUserMessage({
          content: [{ type: 'text', text: 'earlier state change' }],
          source: { kind: 'plugin', plugin: 'test' },
        }))
        subject.steer(createUserMessage({
          content: [{ type: 'text', text: 'earlier steering' }],
          source: { kind: 'user' },
        }))
      }
      return next()
    })

    const idle = waitForIdle(ctx, agent)
    send(agent, 'blocked prompt')
    send(agent, 'later prompt')
    await idle

    expect(events(agent).filter(event => event.type === 'turn/start' || event.type === 'turn/end')
      .map(event => event.type)).toEqual(['turn/start', 'turn/end'])
    expect(agent.inbox.nextStep.map(message => message.content[0]))
      .toEqual([
        { type: 'text', text: 'earlier state change' },
        { type: 'text', text: 'earlier steering' },
      ])
    expect(agent.inbox.nextTurn.map(message => message.content[0]))
      .toEqual([{ type: 'text', text: 'later prompt' }])
    expect(adapter.requests).toEqual([])

    const resumed = waitForIdle(ctx, agent)
    send(agent, 'wake')
    await resumed
    const request = JSON.stringify(adapter.requests[0]?.messages)
    expect(request).toContain('earlier state change')
    expect(request).toContain('earlier steering')
    expect(request).toContain('later prompt')
    expect(request).not.toContain('blocked prompt')
  })

  it('preserves context-only injection staged after pre-step began', async () => {
    const adapter = new MockAdapter([textResponse('continued')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('rejected-pre-step-context'), { provider: 'mock', model: 'mock' })
    const entered = Promise.withResolvers<undefined>()
    const decision = Promise.withResolvers<PreStepDecision>()
    const disposeBlock = ctx.on('agent/pre-step', async () => {
      entered.resolve(undefined)
      return decision.promise
    })

    const idle = waitForIdle(ctx, agent)
    send(agent, 'blocked prompt')
    await entered.promise
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: 'independent context' }],
      source: { kind: 'plugin', plugin: 'test' },
    }))
    decision.resolve({ kind: 'reject' })
    await idle

    const log = events(agent)
    expect(log.some(event => event.type === 'user/message')).toBe(false)
    expect(agent.inbox.nextStep.map(message => message.content[0]))
      .toEqual([{ type: 'text', text: 'independent context' }])
    expect(adapter.requests).toEqual([])

    disposeBlock()
    const resumed = waitForIdle(ctx, agent)
    send(agent, 'wake')
    await resumed
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('independent context')
    expect(JSON.stringify(adapter.requests[0]?.messages)).not.toContain('blocked prompt')
  })

  it('leaves inbox state unchanged when its durable append fails', async () => {
    const adapter = new MockAdapter([])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('rejected-pre-step-append-failure'), {
      provider: 'mock',
      model: 'mock',
    })
    vi.spyOn(agent.session, 'append').mockImplementationOnce(() => {
      throw new Error('append unavailable')
    })

    expect(() => {
      send(agent, 'blocked prompt')
    }).toThrow('append unavailable')
    expect(events(agent)).toEqual([])
    expect(agent.inbox.hasPending).toBe(false)
    expect(agent.status).toBe('idle')
  })

  it('a blocked prompt preserves adjacent queued prompts', async () => {
    const adapter = new MockAdapter([
      textResponse('safe reply'),
      textResponse('wake reply'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    ctx.on('agent/pre-step', async ({ messages }, next): Promise<PreStepDecision> => {
      const text = messages.flatMap(message => message.content)
        .map(b => (b.type === 'text' ? b.text : '')).join('')
      return text === 'secret'
        ? { kind: 'reject' }
        : next()
    })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event: SessionEvent) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'secret')
    send(agent, 'safe')
    await waitForIdle(ctx, agent)

    const log = events(agent)
    expect(log.filter(e => e.type === 'user/message')).toHaveLength(0)
    expect(adapter.requests).toHaveLength(0)
    expect(log.filter(e => e.type === 'turn/start')).toHaveLength(1)
    expect(log.filter(e => e.type === 'turn/end')).toHaveLength(1)
    expect(reasons).toEqual([{ kind: 'blocked' }])
    expect(agent.inbox.nextTurn.map(message => message.content[0]))
      .toEqual([{ type: 'text', text: 'safe' }])

    const resumed = waitForIdle(ctx, agent)
    send(agent, 'wake')
    await resumed
    expect(JSON.stringify(adapter.requests[0]?.messages)).toContain('safe')
    expect(JSON.stringify(adapter.requests[0]?.messages)).not.toContain('secret')
  })

  it('a throwing pre-step listener reports the driver error and retains adjacent work', async () => {
    const adapter = new MockAdapter([textResponse('after')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    let threw = false
    ctx.on('agent/pre-step', async ({ messages }) => {
      if (!threw) { threw = true; throw new Error('prompt hook broke') }
      return { kind: 'enter' as const, messages }
    })
    const errors: Error[] = []
    const reasons: TurnEndReason[] = []
    const statuses: string[] = []
    ctx.on('agent/error', ({ error }) => {
      if (error instanceof Error) errors.push(error)
    })
    ctx.on('agent/status', ({ agent: subject, status }) => { if (subject === agent) statuses.push(status) })
    ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'turn/end') reasons.push(event.data.reason)
    })

    const idle = waitForIdle(ctx, agent)
    send(agent, 'first')
    send(agent, 'second')
    await idle
    expect(errors).toEqual([expect.objectContaining({ message: 'prompt hook broke' })])
    const log = events(agent)
    expect(log.filter(e => e.type === 'turn/start')).toHaveLength(1)
    expect(log.filter(e => e.type === 'turn/end')).toHaveLength(1)
    expect(reasons).toEqual([{
      kind: 'error',
      error: { message: 'prompt hook broke', code: 'UNKNOWN' },
    }])
    expect(statuses).toEqual(['running', 'idle'])
    expect(adapter.requests).toHaveLength(0)
    expect(agent.inbox.nextTurn.map(message => message.content[0]))
      .toEqual([{ type: 'text', text: 'second' }])
  })
})

describe('agent/session-start', () => {
  it('fires once with source "startup" for a fresh create, before the first turn', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)

    const sources: SessionStartSource[] = []
    ctx.on('agent/session-start', ({ source }) => void sources.push(source))

    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    // fires synchronously at create, before any turn
    expect(sources).toEqual(['startup'])
    expect(events(agent).some(e => e.type === 'turn/start')).toBe(false)

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    // still only one session-start
    expect(sources).toEqual(['startup'])
  })

  it('a session-start listener can inject context the first request sees', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)

    ctx.on('agent/session-start', ({ agent }) => {
      agent.inject(createUserMessage({ content: [{ type: 'text', text: 'session preamble' }], source: { kind: 'plugin', plugin: 'test' } }))
    })

    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    send(agent, 'go')
    await waitForIdle(ctx, agent)

    // the injected context reached the model on the first (only) request
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('session preamble')
    // and is recorded with the plugin source, never mislabeled as a user prompt
    const ctxMsg = events(agent).find(e => e.type === 'user/message' && e.data.source.kind === 'plugin')
    expect(ctxMsg?.type === 'user/message' && ctxMsg.data.source).toEqual({ kind: 'plugin', plugin: 'test' })
  })

  it('a throwing session-start listener does not abort agent construction', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)

    ctx.on('agent/session-start', () => { throw new Error('session-start hook broke') })

    // create must not throw — the listener error is contained/logged
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    expect(agent.id).toBe(SessionId('a1'))

    // and the agent still runs
    send(agent, 'go')
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
  })
})

describe('tool additionalContexts buffering across a step', () => {
  it('appends each call\'s contexts only AFTER all tool/results, preserving adjacency', async () => {
    // One assistant step with TWO tool calls; the second model response stops.
    const twoCalls = [
      { type: 'block-start' as const, index: 0, blockType: 'tool-call' as const },
      { type: 'block-end' as const, index: 0, block: { type: 'tool-call' as const, id: ToolCallId('c1'), name: 'echo', arguments: '{"text":"a"}' } },
      { type: 'block-start' as const, index: 1, blockType: 'tool-call' as const },
      { type: 'block-end' as const, index: 1, block: { type: 'tool-call' as const, id: ToolCallId('c2'), name: 'echo', arguments: '{"text":"b"}' } },
      { type: 'usage' as const, usage: { inputTokens: 5, outputTokens: 5 } },
      { type: 'finish' as const, reason: { kind: 'tool-calls' as const } },
    ]
    const adapter = new MockAdapter([twoCalls, textResponse('done')])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'echo', description: 'echo', parameters: { text: { type: 'string' } },
      async execute(args) { return [{ type: 'text', text: String(args.text) }] },
    }))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    // Each call attaches one context naming itself.
    ctx.on('tools/post-execute', async (exec, _result): Promise<PostToolDecision> =>
      ({
        kind: 'accept',
        additionalContexts: [createUserMessage({
          content: [{ type: 'text', text: `ctx-${exec.callId}` }],
          source: { kind: 'plugin', plugin: 'p' },
        })],
      }))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    // Event order in the log: both tool/results, THEN both injected contexts —
    // never interleaved (which would break tool-call/result adjacency).
    const injected = events(agent).filter(e => e.type === 'user/message' && e.data.source.kind === 'plugin')
    const seqs = events(agent)
    const firstResult = seqs.findIndex(e => e.type === 'tool/result')
    const lastResult = seqs.map(e => e.type).lastIndexOf('tool/result')
    const firstCtx = seqs.findIndex(e => e === injected[0])
    expect(firstResult).toBeGreaterThanOrEqual(0)
    expect(lastResult).toBeGreaterThan(firstResult) // two results
    expect(firstCtx).toBeGreaterThan(lastResult)    // context only after ALL results
    // both contexts present
    const ctxTexts = injected
      .flatMap(e => (e.type === 'user/message' ? e.data.content : []))
      .map(b => (b.type === 'text' ? b.text : ''))
    expect(ctxTexts).toEqual(['ctx-c1', 'ctx-c2'])
  })

  it('appends multiple contexts deferred by one composite tool after its outer result', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'composite', {}), textResponse('done')])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'composite', description: 'composite', parameters: {},
      async execute(_args, exec) {
        exec.deferContext(createUserMessage({
          content: [{ type: 'text', text: 'nested-a' }], source: { kind: 'plugin', plugin: 'a' },
        }))
        exec.deferContext(createUserMessage({
          content: [{ type: 'text', text: 'nested-b' }], source: { kind: 'plugin', plugin: 'b' },
        }))
        return [{ type: 'text', text: 'outer result' }]
      },
    }))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const log = events(agent)
    const resultIndex = log.findIndex(event => event.type === 'tool/result')
    const contextEvents = log.filter(event => event.type === 'user/message' && event.data.source.kind === 'plugin')
    expect(resultIndex).toBeGreaterThanOrEqual(0)
    expect(log.findIndex(event => event === contextEvents[0])).toBeGreaterThan(resultIndex)
    expect(contextEvents.map(event => event.type === 'user/message' && event.data.source)).toEqual([
      { kind: 'plugin', plugin: 'a' },
      { kind: 'plugin', plugin: 'b' },
    ])
  })
})

describe('tools/pre-execute gate (native-plugin permission pattern, end-to-end through the loop)', () => {
  it('deny short-circuits dispatch into an isError result the model sees', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'danger', {}), textResponse('ok')])
    const ctx = await harness(adapter)
    let ran = false
    ctx.tools.register(defineContentToolFixture({
      name: 'danger', description: 'danger', parameters: {},
      async execute() { ran = true; return [{ type: 'text', text: 'should not run' }] },
    }))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
      if (exec.name === 'danger') return { kind: 'deny', reason: 'blocked dangerous tool' }
      return next()
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    expect(ran).toBe(false)
    const result = events(agent).find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.content[0].isError).toBe(true)
    expect(result?.type === 'tool/result'
      && result.data.message.content[0].content.some(b => b.type === 'text' && b.text.includes('blocked dangerous tool'))).toBe(true)
  })
})

describe('worked example: a native hook plugin is just a cordis plugin on the seams', () => {
  // The whole point of the interception taxonomy: a "native hook" needs no dsh-hook-protocol,
  // no external command, no hook/* log — it is an ordinary cordis plugin subscribing to the
  // canonical events and returning typed decisions.
  const NativeGuard = {
    name: 'native-guard',
    apply(ctx: Context) {
      // 1. SessionStart: seed a standing instruction.
      ctx.on('agent/session-start', ({ agent, source }) => {
        agent.inject(createUserMessage({ content: [{ type: 'text', text: `policy active (started: ${source})` }], source: { kind: 'plugin', plugin: 'native-guard' } }))
      })
      // 2. PreStep: reject a forbidden prompt, annotate the rest.
      ctx.on('agent/pre-step', async ({ messages }, next): Promise<PreStepDecision> => {
        const text = messages.flatMap(message => message.content)
          .map(b => (b.type === 'text' ? b.text : '')).join('')
        if (text.includes('rm -rf')) {
          return { kind: 'reject' }
        }
        return next()
      })
      // 3. PreToolUse: deny a dangerous tool by name.
      ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
        if (exec.name === 'danger') return { kind: 'deny', reason: 'danger tool denied' }
        return next()
      })
      // 4. PostToolUse: attach context after a tool runs.
      ctx.on('tools/post-execute', async (_exec, _result, next): Promise<PostToolDecision> => {
        const decision = await next()
        if (decision.kind === 'accept') {
          return { kind: 'accept', additionalContexts: [createUserMessage({
            content: [{ type: 'text', text: 'audited' }], source: { kind: 'plugin', plugin: 'native-guard' },
          })] }
        }
        return decision
      })
    },
  }

  it('all four seams fire for a real allowed turn with a tool call', async () => {
    const adapter = new MockAdapter([toolCallResponse('c1', 'echo', { text: 'hi' }), textResponse('done')])
    const ctx = await harness(adapter)
    await ctx.plugin(NativeGuard)
    ctx.tools.register(defineContentToolFixture({
      name: 'echo', description: 'echo', parameters: { text: { type: 'string' } },
      async execute(args) { return [{ type: 'text', text: String(args.text) }] },
    }))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'please echo hi')
    await waitForIdle(ctx, agent)

    const log = events(agent)
    // session-start preamble injected
    expect(log.some(e => e.type === 'user/message' && e.data.source.kind === 'plugin'
      && e.data.content.some(b => b.type === 'text' && b.text.includes('policy active (started: startup)')))).toBe(true)
    // prompt allowed → user-sourced user/message recorded
    expect(log.some(e => e.type === 'user/message' && e.data.source.kind === 'user')).toBe(true)
    // tool ran (echo allowed) and post-execute attached "audited" context
    expect(log.some(e => e.type === 'tool/result' && !e.data.message.content[0].isError)).toBe(true)
    expect(log.some(e => e.type === 'user/message' && e.data.source.kind === 'plugin'
      && e.data.content.some(b => b.type === 'text' && b.text === 'audited'))).toBe(true)
    // NO hook/* events — a native plugin needs none
    expect(log.some(e => e.type.startsWith('hook/'))).toBe(false)
  })

  it('the same plugin blocks a destructive prompt inside a no-step turn', async () => {
    const adapter = new MockAdapter([textResponse('should not run')])
    const ctx = await harness(adapter)
    await ctx.plugin(NativeGuard)
    const agent = await ctx.agentLoop.create(SessionId('a2'), { provider: 'mock', model: 'mock' })

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event: SessionEvent) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'run rm -rf /')
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(0)
    expect(reasons).toEqual([{ kind: 'blocked' }])
  })

  it('HMR-safety: disposing the plugin fiber removes all four listeners', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const fiber = await ctx.plugin(NativeGuard)
    await fiber.dispose()

    // After disposal, a destructive prompt is NOT blocked (the listener is gone).
    const agent = await ctx.agentLoop.create(SessionId('a3'), { provider: 'mock', model: 'mock' })
    send(agent, 'run rm -rf /')
    await waitForIdle(ctx, agent)
    // the prompt ran (not rejected) — proving the pre-step listener was disposed
    expect(adapter.requests).toHaveLength(1)
    expect(events(agent).some(e => e.type === 'user/message')).toBe(true)
  })
})
