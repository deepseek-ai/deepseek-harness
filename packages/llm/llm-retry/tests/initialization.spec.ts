/** Provider recovery overlapping retry projection registration. */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import * as retry from '@deepseek-ai/dsh-llm-retry'
import { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

class RetryAdapter extends MockAdapter {
  override providerRetryPolicy(): ResolvedRetryPolicy {
    return resolveRetryPolicy({
      mode: 'normal', maxRetries: 1,
      backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
    }, 'initialization test')
  }
}

describe('retry activation', () => {
  it.each(['ready', 'cancelled', 'disposed', 'failed'] as const)('handles a %s registration before settling the first provider failure', async (outcome) => {
    const ctx = new Context()
    const registered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(async () => {
      release.resolve(undefined)
      await ctx.fiber.dispose()
    })
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new RetryAdapter([
      [{ type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'temporary failure' } } }],
      textResponse('recovered'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = await ctx.agentLoop.create(SessionId('initial-retry'), { provider: 'mock', model: 'mock' })
    const register = ctx.sessionProjections.register.bind(ctx.sessionProjections)
    const spy = vi.spyOn(ctx.sessionProjections, 'register').mockImplementation(async (definition) => {
      const handle = await register(definition)
      if (definition.key === 'llmRetry') {
        registered.resolve(undefined)
        await release.promise
      }
      return handle
    })
    onTestFinished(() => { spy.mockRestore() })
    const fiber = ctx.plugin(retry)
    await registered.promise
    const recovering = Promise.withResolvers<undefined>()
    ctx.on('agent/request-error', (_payload, next) => {
      recovering.resolve(undefined)
      return next()
    }, { prepend: true })
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'recover this request' }], source: { kind: 'user' } }))
    await recovering.promise

    if (outcome === 'cancelled') agent.cancel({ kind: 'user' })
    const disposal = outcome === 'disposed' ? fiber.dispose() : undefined
    if (outcome === 'failed') {
      const rejected = expect(Promise.resolve(fiber)).rejects.toThrow('retry registration failed')
      release.reject(new Error('retry registration failed'))
      await rejected
    } else {
      release.resolve(undefined)
      await (disposal ?? fiber)
    }
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(outcome === 'ready' ? 2 : 1)
    const log = agent.session.snapshotEvents()
    expect(log.filter(event => event.type === 'llm/retry')).toHaveLength(outcome === 'ready' ? 1 : 0)
    expect(log.filter(event => event.type === 'llm/retry-started')).toHaveLength(outcome === 'ready' ? 1 : 0)
    if (outcome === 'ready') {
      expect(adapter.requests[1]?.messages).toEqual(adapter.requests[0]?.messages)
      expect(agent.session.deriveMessages().at(-1)?.content).toEqual([{ type: 'text', text: 'recovered' }])
    }
    if (outcome === 'failed') expect(errors).toContainEqual(new Error('retry registration failed'))
  })
})
