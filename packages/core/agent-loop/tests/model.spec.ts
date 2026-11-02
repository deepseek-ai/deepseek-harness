/** Per-Agent model instances share the loop's projection registration and teardown. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { AgentModel, modelSelectionProjectionDefinition } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished, vi } from 'vitest'

async function dependencies() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  return ctx
}

const INITIAL = { provider: 'mock', model: 'initial' }
const SELECTED = { provider: 'mock', model: 'selected' }

describe('Agent model ownership', () => {
  it('waits for model projection registration before publishing the factory', async () => {
    const ctx = await dependencies()
    const ready = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    onTestFinished(() => { ready.resolve(undefined) })
    const register = ctx.sessionProjections.register.bind(ctx.sessionProjections)
    vi.spyOn(ctx.sessionProjections, 'register').mockImplementation(async (definition) => {
      if (definition.key === modelSelectionProjectionDefinition.key) {
        entered.resolve(undefined)
        await ready.promise
      }
      return register(definition)
    })
    const loading = ctx.plugin(AgentLoop, { agents: [] })
    await entered.promise
    await expect(ctx.agents.create({ sessionId: SessionId('too-early') })).rejects.toThrow('no agent factory registered')
    ready.resolve(undefined)
    await loading
    const handle = await ctx.agents.create({ sessionId: SessionId('ready'), agentOptions: INITIAL })
    expect(handle.agent.model.current()).toEqual(INITIAL)
  })

  it('binds each model instance to its Agent and makes it available during setup', async () => {
    const ctx = await dependencies()
    await ctx.plugin(AgentLoop, { agents: [] })
    const first = await ctx.agents.create({
      sessionId: SessionId('first'),
      agentOptions: INITIAL,
      setup: (_ctx, agent) => {
        expect(agent.model).toBeInstanceOf(AgentModel)
        agent.model.select(SELECTED)
      },
    })
    const second = await ctx.agents.create({ sessionId: SessionId('second'), agentOptions: INITIAL })
    expect(first.agent.model).not.toBe(second.agent.model)
    expect(first.agent.model.current()).toEqual(SELECTED)
    expect(second.agent.model.current()).toEqual(INITIAL)
    expect(second.agent.session.snapshotEvents()).toEqual([])
    expect(ctx.sessionProjections.snapshot(first.agent.session).values.modelSelection)
      .toEqual({ lastUsed: null, next: SELECTED })
  })

  it.each(['loop', 'root'] as const)('retains model selection until Agent cleanup finishes on %s disposal', async (owner) => {
    const ctx = await dependencies()
    const loop = await ctx.plugin(AgentLoop, { agents: [] })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    const handle = await ctx.agents.create({
      sessionId: SessionId('cleanup'),
      agentOptions: INITIAL,
      setup: (agentCtx, agent) => {
        agentCtx.effect(() => async () => {
          entered.resolve(undefined)
          await release.promise
          agent.model.select(SELECTED)
          expect(agent.model.current()).toEqual(SELECTED)
        })
      },
    })
    const disposal = owner === 'loop' ? loop.dispose() : ctx.fiber.dispose()
    await entered.promise
    expect(handle.agent.model.current()).toEqual(INITIAL)
    release.resolve(undefined)
    await disposal
    expect(handle.agent.session.snapshotEvents().at(-1)).toMatchObject({ type: 'model/selection', data: SELECTED })
    if (owner === 'loop') {
      expect(ctx.sessionProjections.snapshot(handle.agent.session).values.modelSelection).toBeUndefined()
      await ctx.plugin(AgentLoop, { agents: [] })
      expect(ctx.sessionProjections.snapshot(handle.agent.session).values.modelSelection)
        .toEqual({ lastUsed: null, next: SELECTED })
    }
  })
})
