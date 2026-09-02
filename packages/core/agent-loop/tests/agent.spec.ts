import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter): Promise<Context> {
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

function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

describe('Agent', () => {
  it('idle inject() durably stages context without opening a turn', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    agent.inject(createUserMessage({ content: [{ type: 'text', text: 'context' }], source: { kind: 'plugin', plugin: 'p' } }))

    expect(agent.session.snapshotEvents().map(event => event.type)).toEqual(['agent/inbox/spliced'])
    expect(agent.status).toBe('idle')
    expect(adapter.requests).toHaveLength(0)
    await agent.whenIdle()
  })

  it('inject() preserves an explicitly empty plugin source', async () => {
    const ctx = await harness(new MockAdapter([textResponse('ok')]))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    agent.inject(createUserMessage({ content: [{ type: 'text', text: 'empty plugin source' }], source: { kind: 'plugin', plugin: '' } }))

    const injected = agent.session.snapshotEvents().at(-1)
    expect(injected?.type === 'agent/inbox/spliced' && injected.data.inserted[0]?.source)
      .toEqual({ kind: 'plugin', plugin: '' })
  })

  it('emits exact inserted, claimed, and discarded inbox messages', async () => {
    const ctx = await harness(new MockAdapter([textResponse('ok')]))
    const agent = await ctx.agentLoop.create(SessionId('inbox-events'), { provider: 'mock', model: 'mock' })
    const inserted: unknown[] = []
    const claimed: unknown[] = []
    const discarded: unknown[] = []
    const lifecycle: string[] = []
    ctx.on('session/event', (session, event) => {
      if (session === agent.session && event.type === 'turn/start') lifecycle.push('turn/start')
    })
    ctx.on('agent/inbox/inserted', ({ agent: subject, message }) => {
      if (subject === agent) inserted.push({ message })
    })
    ctx.on('agent/inbox/claimed', ({ agent: subject, message, turn }) => {
      if (subject === agent) {
        lifecycle.push('agent/inbox/claimed')
        claimed.push({ message, turn })
      }
    })
    ctx.on('agent/inbox/discarded', ({ agent: subject, message }) => {
      if (subject === agent) discarded.push({ message })
    })
    const context = createUserMessage({
      content: [{ type: 'text', text: 'discard me' }],
      source: { kind: 'plugin', plugin: 'test' },
    })
    agent.inject(context)
    agent.inbox.remove(context.id)
    const prompt = createUserMessage({ content: [{ type: 'text', text: 'run' }], source: { kind: 'user' } })
    agent.followup(prompt)
    await agent.whenIdle()

    expect(inserted).toEqual([{ message: context }, { message: prompt }])
    expect(discarded).toEqual([{ message: context }])
    expect(claimed).toEqual([{ message: prompt, turn: 1 }])
    expect(lifecycle).toEqual(['turn/start', 'agent/inbox/claimed'])
  })

  it('idle inject() rejects invalid input before enqueue', async () => {
    const ctx = await harness(new MockAdapter([textResponse('ok')]))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    expect(() => {
      agent.inject(createUserMessage({ content: [{ type: 'text', text: 'x', bad: 1n } as never], source: { kind: 'plugin', plugin: 'p' } }))
    }).toThrow(/non-JSON-serializable/)
    expect(agent.session.snapshotEvents()).toHaveLength(0)
  })

  it('steer() while idle becomes a woken prompt turn', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    agent.steer(createUserMessage({ content: [{ type: 'text', text: 'steer idle' }], source: { kind: 'plugin', plugin: 'test' } }))
    await agent.whenIdle()

    expect(agent.session.snapshotEvents().some(event => event.type === 'user/message')).toBe(true)
    expect(adapter.requests).toHaveLength(1)
  })

  it('emits one running and idle transition for one completed turn', async () => {
    const ctx = await harness(new MockAdapter([textResponse('ok')]))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    const statuses: string[] = []
    ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent) statuses.push(status)
    })

    send(agent, 'hi')
    await agent.whenIdle()

    expect(statuses).toEqual(['running', 'idle'])
  })

  it('whenIdle() resolves immediately without active work', async () => {
    const ctx = await harness(new MockAdapter([textResponse('ok')]))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    await agent.whenIdle()

    expect(agent.status).toBe('idle')
  })

  it('whenIdle() waits for active work until explicit cancellation', async () => {
    const ctx = await harness(new MockAdapter(['hang']))
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'queued')
    let settled = false
    const idle = agent.whenIdle().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    agent.cancel({ kind: 'user' })
    await idle
    expect(agent.status).toBe('idle')
  })

  it('contains a throwing status listener on both transitions', async () => {
    const ctx = await harness(new MockAdapter([textResponse('ok')]))
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const agent = await ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/status', ({ status }) => {
      throw new Error(`bad ${status} listener`)
    })

    send(agent, 'go')
    await agent.whenIdle()

    expect(agent.status).toBe('idle')
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('agent event "agent/status" listener threw'),
    )
  })
})
