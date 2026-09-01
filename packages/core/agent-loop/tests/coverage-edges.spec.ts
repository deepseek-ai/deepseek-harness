import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, ToolCallId, LlmError, StreamChunk, errorChain  } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, TurnEndReason } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'

import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

function driverDone(agent: Agent): Promise<void> {
  return (agent as Agent & { done: Promise<void> }).done
}

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

describe('tool JSON parse', () => {
  it('passes through non-JSON arguments string without crashing', async () => {
    const adapter = new MockAdapter([
      // model emits tool-call with malformed arguments (not valid JSON)
      [
        { type: 'block-start' as const, index: 0, blockType: 'tool-call' as const },
        { type: 'block-end' as const, index: 0, block: { type: 'tool-call' as const, id: ToolCallId('c1'), name: 'echo', arguments: 'not json' } },
        { type: 'finish' as const, reason: { kind: 'tool-calls' as const } },
      ] satisfies StreamChunk[],
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'echo',
      description: 'echo tool',
      parameters: { input: { type: 'string' } },
      async execute(args: unknown) {
        return [{ type: 'text', text: typeof args === 'string' ? `raw: ${args}` : JSON.stringify(args) }]
      },
    }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'use tool')
    await waitForIdle(ctx, agent)

    // tool/call event should have recorded the raw arguments string
    const callEvent = agent.session.snapshotEvents().find(e => e.type === 'tool/call')
    expect(callEvent).toBeDefined()
    if (callEvent!.type === 'tool/call') {
      expect(callEvent!.data.arguments).toBe('not json')
    }
    // the loop did not crash — a result was produced
    expect(agent.session.snapshotEvents().some(e => e.type === 'tool/result')).toBe(true)
  })

  it('uses empty object when tool-call arguments are empty string', async () => {
    const adapter = new MockAdapter([
      [
        { type: 'block-start' as const, index: 0, blockType: 'tool-call' as const },
        { type: 'block-end' as const, index: 0, block: { type: 'tool-call' as const, id: ToolCallId('c1'), name: 'noarg', arguments: '' } },
        { type: 'finish' as const, reason: { kind: 'tool-calls' as const } },
      ] satisfies StreamChunk[],
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'noarg',
      description: 'no-arg tool',
      parameters: {},
      async execute() {
        return [{ type: 'text', text: 'ran with empty args' }]
      },
    }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'use tool')
    await waitForIdle(ctx, agent)

    expect(agent.session.snapshotEvents().some(e => e.type === 'tool/result')).toBe(true)
  })
})

describe('thrown-value propagation', () => {
  it('preserves non-Error throws from pre-commit dispatch validation', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    let threwOnce = false
    ctx.on('internal/dispatch', (_mode, name, args) => {
      if (name !== 'session/event') return
      const event = args[1] as SessionEvent
      if (event.type === 'turn/start' && !threwOnce) {
        threwOnce = true
        throw 'naked string error'
      }
    })

    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => void errors.push(error))

    send(agent, 'fails before turn start')
    send(agent, 'survives as the next item')
    await waitForIdle(ctx, agent)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBe('naked string error')
    expect(adapter.requests).toHaveLength(0)
    const starts = agent.session.snapshotEvents().filter(event => event.type === 'turn/start')
    const ends = agent.session.snapshotEvents().filter(event => event.type === 'turn/end')
    const messages = agent.session.snapshotEvents().filter(event => event.type === 'user/message')
    expect(starts).toHaveLength(0)
    expect(ends).toHaveLength(0)
    expect(messages).toHaveLength(0)
    expect(agent.inbox.nextTurn).toHaveLength(2)
  })

  it('preserves non-Error throws from the agent/request waterfall', async () => {
    const adapter = new MockAdapter([textResponse('irrelevant')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    let threwOnce = false
    ctx.on('agent/request', async (_payload, next) => {
      if (!threwOnce) {
        threwOnce = true
        throw { code: 500 }
      }
      return next()
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)
    const turnEnd = agent.session.snapshotEvents().find(e => e.type === 'turn/end')
    expect(turnEnd?.type === 'turn/end' && turnEnd.data.reason.kind === 'error'
      ? turnEnd.data.reason.error.message
      : undefined).toBe('[object Object]')
  })
})

describe('durable error rendering', () => {
  it('renders a coded error thrown from a plugin', async () => {
    const adapter = new MockAdapter([textResponse('turn 1')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    let threwOnce = false
    ctx.on('agent/request', async (_payload, next) => {
      if (!threwOnce) {
        threwOnce = true
        throw new LlmError('server overloaded', 'RATE_LIMIT')
      }
      return next()
    })

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const turnEnd = agent.session.snapshotEvents().find(e => e.type === 'turn/end')
    expect(turnEnd).toBeDefined()
    if (turnEnd?.type === 'turn/end' && turnEnd.data.reason.kind === 'error') {
      expect(turnEnd.data.reason.error).toEqual({
        message: 'server overloaded',
        code: 'RATE_LIMIT',
      })
    }
  })
})

describe('disposed vs aborted branching', () => {
  it('handles dispose during model streaming producing reason "disposed"', async () => {
    const adapter = new MockAdapter(['hang'])
    const ctx = await harness(adapter)
    let agent!: Agent
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      agent = inner.agentLoop.create(SessionId('scoped'), { provider: 'mock', model: 'mock' })
    }, { inject: ['agentLoop'] }))

    const reasons: TurnEndReason[] = []
    ctx.on('session/event', (_s, event) => { if (event.type === 'turn/end') reasons.push(event.data.reason) })

    send(agent, 'go')
    await new Promise(r => setTimeout(r, 30))
    await fiber.dispose() // dispose during hang
    await driverDone(agent)

    // Disposal wins abort classification because the error path checks it first.
    expect(reasons).toContainEqual({ kind: 'aborted', reason: { kind: 'disposed' } })
  })
})

describe('structured tool error propagation (the runtime-validation Agent Note, part 2)', () => {
  it('forwards a tool HarnessError onto the tool/result session event', async () => {
    const { HarnessError } = await import('@deepseek-ai/dsh-llm')
    // First model turn calls the tool; second turn (after the tool result is
    // fed back) ends with plain text so the loop settles.
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'boom', {}),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    ctx.tools.register(defineContentToolFixture({
      name: 'boom',
      description: 'always fails',
      parameters: {},
      async execute() {
        throw new HarnessError('exploded', 'BOOM')
      },
    }))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const toolResult = agent.session.snapshotEvents().find(e => e.type === 'tool/result')
    expect(toolResult?.type === 'tool/result' && toolResult.data.message.content[0].isError).toBe(true)
    expect(toolResult?.type === 'tool/result' && toolResult.data.error)
      .toEqual({ name: 'HarnessError', code: 'BOOM' })
  })
})

describe('request-error action edges', () => {
  it('ignores a retry action returned after the turn was aborted', async () => {
    const { LlmError } = await import('@deepseek-ai/dsh-llm')
    const adapter = new MockAdapter([
      () => { throw new LlmError('busy', 'RATE_LIMIT') },
      textResponse('never used'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('retry-after-cancel'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/request-error', async ({ agent: subject }) => {
      subject.cancel({ kind: 'user' })
      return { kind: 'retry' }
    })

    send(agent, 'go')
    await agent.whenIdle()

    // One failed request, no retry turn.
    expect(adapter.requests).toHaveLength(1)
    const ends = agent.session.snapshotEvents().filter(e => e.type === 'turn/end')
    expect(ends).toHaveLength(1)
  })

  it('completed recovery does not retry when cancellation raced the waterfall', async () => {
    const { LlmError } = await import('@deepseek-ai/dsh-llm')
    const adapter = new MockAdapter([
      () => { throw new LlmError('busy', 'RATE_LIMIT') },
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('retry-raced'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/request-error', async ({ agent: subject, signal }, next) => {
      await next()
      subject.cancel({ kind: 'user' })
      expect(signal.aborted).toBe(true)
      return { kind: 'retry' }
    })

    send(agent, 'go')
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    const end = agent.session.snapshotEvents().findLast(e => e.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.data.reason.kind).toBe('aborted')
  })
})

describe('stream failure edges', () => {
  it('rethrows a mid-stream throw that carries no adapter failure facts', async () => {
    const adapter = new MockAdapter([textResponse('will be vetoed')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('stream-no-facts'), { provider: 'mock', model: 'mock' })
    let recoveries = 0
    ctx.on('agent/request-error', async () => { recoveries += 1 })
    // A pre-commit chunk veto throws INSIDE the stream-consumption try, but it
    // is not an adapter-boundary failure, so llmFailureOf yields no facts.
    let vetoed = false
    ctx.on('internal/dispatch', (_mode, name, args) => {
      if (name !== 'session/event') return
      const event = args[1] as SessionEvent
      if (event.type === 'assistant/chunk' && !vetoed) {
        vetoed = true
        throw new Error('reject the first chunk')
      }
    })

    send(agent, 'go')
    await agent.whenIdle()

    // No facts -> not offered to recovery; the turn fails through settle().
    expect(recoveries).toBe(0)
    const end = agent.session.snapshotEvents().findLast(e => e.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.data.reason.kind).toBe('error')
  })
})

describe('post-turn continuation edges', () => {
  it('whenIdle resolves for a waiter whose awaited run fails', async () => {
    const adapter = new MockAdapter([textResponse('unused')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('whenidle-reject'), { provider: 'mock', model: 'mock' })
    let rejected = false
    ctx.on('internal/dispatch', (_mode, name, args) => {
      if (name !== 'session/event') return
      const event = args[1] as SessionEvent
      if (event.type === 'turn/start' && !rejected) {
        rejected = true
        throw new Error('veto turn start while a waiter is pending')
      }
    })

    send(agent, 'go')
    await expect(agent.whenIdle()).resolves.toBeUndefined()
    expect(agent.status).toBe('idle')
  })
})

describe('persistent step-close rejection', () => {
  it('still publishes the terminal status when both step-close attempts are vetoed', async () => {
    const adapter = new MockAdapter([textResponse('will not close')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('stepend-double-veto'), { provider: 'mock', model: 'mock' })
    // Persistently reject step/end: the catch's own close attempt fails too,
    // and the contained failure must not strand status at running.
    ctx.on('internal/dispatch', (_mode, name, args) => {
      if (name !== 'session/event') return
      const event = args[1] as SessionEvent
      if (event.type === 'step/end') throw new Error('step close permanently rejected')
    })
    const statuses: string[] = []
    ctx.on('agent/status', ({ agent: subject, status }) => { if (subject === agent) statuses.push(status) })

    send(agent, 'go')
    await agent.whenIdle()

    expect(agent.status).toBe('idle')
    expect(statuses).toEqual(['running', 'idle'])
  })
})

describe('tool result meta persistence', () => {
  it('records a presentationMeta payload on the tool/result event', async () => {
    const { defineTool } = await import('@deepseek-ai/dsh-tools')
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'meta-tool', {}),
      textResponse('done'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('tool-meta'), { provider: 'mock', model: 'mock' })
    ctx.tools.register(defineTool({
      name: 'meta-tool',
      description: 'carries presentation meta',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
        presentationMeta: () => ({ presentation: 'diff-card' }),
      },
      async execute() {
        return 'ran'
      },
    }))

    send(agent, 'go')
    await waitForIdle(ctx, agent)

    const result = agent.session.snapshotEvents().find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.meta).toEqual({ presentation: 'diff-card' })
  })
})

describe('turn close failure containment', () => {
  it('a rejected turn/end append is contained: warn + agent/error, no retry', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('turnend-veto'), { provider: 'mock', model: 'mock' })
    let vetoed = false
    ctx.on('internal/dispatch', (_mode, name, args) => {
      if (name !== 'session/event') return
      const event = args[1] as SessionEvent
      if (event.type === 'turn/end' && !vetoed) {
        vetoed = true
        throw new Error('reject turn end')
      }
    })
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })

    send(agent, 'go')
    await agent.whenIdle()

    // The close failure is reported live; the machine still reaches idle.
    expect(errors.map(e => e instanceof Error && e.message)).toContain('reject turn end')
    expect(agent.status).toBe('idle')
    expect(adapter.requests).toHaveLength(1)
  })
})

describe('recovery without a retry action', () => {
  it('a completed recovery that returns no action leaves the failed turn terminal', async () => {
    const { LlmError } = await import('@deepseek-ai/dsh-llm')
    const adapter = new MockAdapter([
      () => { throw new LlmError('down', 'SERVICE_UNAVAILABLE') },
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('recovery-no-retry'), { provider: 'mock', model: 'mock' })
    let recoveries = 0
    ctx.on('agent/request-error', async () => { recoveries += 1 })

    send(agent, 'go')
    await agent.whenIdle()

    expect(recoveries).toBe(1)
    expect(adapter.requests).toHaveLength(1)
    const end = agent.session.snapshotEvents().findLast(e => e.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.data.reason.kind).toBe('error')
  })
})

describe('unrenderable failure settlement', () => {
  it('drops the rendered message when the error chain cannot be rendered', async () => {
    const { LlmError } = await import('@deepseek-ai/dsh-llm')
    const adapter = new MockAdapter([
      () => {
        const error = new LlmError('will become hostile', 'SERVER')
        // A hostile message getter makes errorChain collapse to its sentinel;
        // settle() must then fall back to the failure facts alone.
        Object.defineProperty(error, 'message', {
          get() { throw new Error('hostile accessor') },
        })
        throw error
      },
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('unrenderable'), { provider: 'mock', model: 'mock' })

    send(agent, 'go')
    await agent.whenIdle()

    const end = agent.session.snapshotEvents().findLast(e => e.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.data.reason.kind).toBe('error')
    if (end?.type === 'turn/end' && end.data.reason.kind === 'error') {
      // The durable failure keeps the adapter facts' message, not the
      // unrenderable chain.
      expect(errorChain(end.data.reason.error.message)).not.toBe('<unrenderable value>')
    }
  })
})

describe('driver bookkeeping edges', () => {
  it('rejects a direct turn invocation without a driver reservation', async () => {
    const ctx = await harness(new MockAdapter([]))
    const agent = ctx.agentLoop.create(SessionId('turn-without-reservation'), { provider: 'mock', model: 'mock' })

    await expect((agent as unknown as { turn(): Promise<boolean> }).turn())
      .rejects.toThrow('turn without driver reservation')
    expect(agent.status).toBe('idle')
  })

  it('closes an entered turn as blocked when its next step is rejected', async () => {
    const adapter = new MockAdapter([textResponse('first step')])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('reject-next-step'), { provider: 'mock', model: 'mock' })
    let proposals = 0
    ctx.on('agent/pre-step', async (_payload, next) => {
      proposals += 1
      return proposals === 2 ? { kind: 'reject' } : next()
    })
    ctx.on('agent/turn-stopping', ({ agent: subject }) => {
      subject.inject(createUserMessage({
        content: [{ type: 'text', text: 'do not enter the next step' }],
        source: { kind: 'plugin', plugin: 'test' },
      }))
    })

    send(agent, 'go')
    await agent.whenIdle()

    expect(proposals).toBe(2)
    expect(adapter.requests).toHaveLength(1)
    const end = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.data.reason).toEqual({ kind: 'blocked' })
  })

  it('a request failure that concludes recovery after step/end closed keeps the boundary balanced', async () => {
    const { LlmError } = await import('@deepseek-ai/dsh-llm')
    // The failure finish-chunk path returns request-failed AFTER step() has
    // already appended step/end, so the request-failed branch's own
    // step-close guard must see stepOpen === false and skip the append.
    const adapter = new MockAdapter([
      [
        { type: 'usage' as const, usage: { inputTokens: 1, outputTokens: 0 } },
        { type: 'finish' as const, reason: { kind: 'error' as const, failure: { message: 'empty', code: 'EMPTY_RESPONSE' } } },
      ] satisfies StreamChunk[],
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('finish-after-close'), { provider: 'mock', model: 'mock' })
    void LlmError

    send(agent, 'go')
    await agent.whenIdle()

    const types = agent.session.snapshotEvents().map(e => e.type)
    expect(types.filter(t => t === 'step/end')).toHaveLength(1)
    const end = agent.session.snapshotEvents().findLast(e => e.type === 'turn/end')
    expect(end?.type === 'turn/end' && end.data.reason.kind).toBe('error')
  })
})
