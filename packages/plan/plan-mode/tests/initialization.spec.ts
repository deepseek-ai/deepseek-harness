/** Prompt assembly must not omit plan guidance during activation. */
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

describe('plan-mode activation', () => {
  it.each([false, true])('rejects premature requests with restored active=%s, then includes the complete plan contribution', async (active) => {
    const ctx = new Context()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(async () => {
      release.resolve(undefined)
      await ctx.fiber.dispose()
    })
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([textResponse('ready')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const seed = Session.create(SessionId('plan-seed'))
    seed.append('plan/mode', { active })
    const { agent } = await ctx.agents.create({
      sessionId: SessionId('initial-plan'), seed: seed.snapshotEvents(),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const register = ctx.sessionProjections.register.bind(ctx.sessionProjections)
    const spy = vi.spyOn(ctx.sessionProjections, 'register').mockImplementation(async (definition) => {
      const handle = await register(definition)
      if (definition.key === 'plan') {
        entered.resolve(undefined)
        await release.promise
      }
      return handle
    })
    onTestFinished(() => { spy.mockRestore() })
    const fiber = ctx.plugin(PlanModeController, { section: 'Plan the work before executing it.' })
    await entered.promise
    const errors: unknown[] = []
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    const prompt = createUserMessage({ content: [{ type: 'text', text: 'continue the task' }], source: { kind: 'user' } })
    agent.followup(prompt)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(0)
    expect(errors.some(error => error instanceof Error && /plan.*not ready/.test(error.message))).toBe(true)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'request/header')).toHaveLength(0)

    release.resolve(undefined)
    await fiber
    agent.followup(prompt)
    await agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    expect((adapter.requests[0]?.tools ?? []).some(tool => tool.name === 'exit_plan_mode')).toBe(active)
    const text = adapter.requests[0]?.messages.flatMap(message => message.content)
      .filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(text?.includes('Plan the work before executing it.')).toBe(active)
    expect(ctx.planMode.get(agent)).toEqual({ active })
  })
})
