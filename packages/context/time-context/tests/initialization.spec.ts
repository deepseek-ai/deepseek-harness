/** Real Agent requests overlapping time-context projection registration. */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as timeContext from '@deepseek-ai/dsh-time-context'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

describe('time-context activation', () => {
  it.each(['ready', 'cancelled', 'disposed', 'failed'] as const)('handles a %s registration before the first request', async (outcome) => {
    const ctx = new Context()
    const registered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(async () => {
      release.resolve(undefined)
      await ctx.fiber.dispose()
    })
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([textResponse('ready')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('initial-time'), { provider: 'mock', model: 'mock' })
    const register = ctx.sessionProjections.register.bind(ctx.sessionProjections)
    const spy = vi.spyOn(ctx.sessionProjections, 'register').mockImplementation(async (definition) => {
      const handle = await register(definition)
      if (definition.key === 'timeContext') {
        registered.resolve(undefined)
        await release.promise
      }
      return handle
    })
    onTestFinished(() => { spy.mockRestore() })
    const fiber = ctx.plugin(timeContext, { timeZone: 'UTC' })
    await registered.promise
    const preparing = Promise.withResolvers<undefined>()
    ctx.on('agent/pre-step', (_payload, next) => {
      preparing.resolve(undefined)
      return next()
    }, { prepend: true })
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'what time is it?' }], source: { kind: 'user' } }))
    await preparing.promise

    if (outcome === 'cancelled') agent.cancel({ kind: 'user' })
    const disposal = outcome === 'disposed' ? fiber.dispose() : undefined
    if (outcome === 'failed') {
      const rejected = expect(Promise.resolve(fiber)).rejects.toThrow('time registration failed')
      release.reject(new Error('time registration failed'))
      await rejected
    } else {
      release.resolve(undefined)
      await (disposal ?? fiber)
    }
    await agent.whenIdle()

    const readings = agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'time-context')
    expect(readings).toHaveLength(outcome === 'ready' ? 1 : 0)
    expect(adapter.requests).toHaveLength(outcome === 'ready' ? 1 : 0)
    if (outcome === 'ready') {
      expect(adapter.requests[0]?.messages.flatMap(message => message.content)
        .some(block => block.type === 'text' && block.text.startsWith('Time sampled while preparing turn 1, step 1:'))).toBe(true)
    }
    if (outcome === 'failed') expect(errors).toContainEqual(new Error('time registration failed'))
  })
})
