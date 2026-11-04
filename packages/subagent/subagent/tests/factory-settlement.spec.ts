import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '../src/index.ts'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import { managerState } from './manager-internals.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

it('settles an activation when its factory unloads during the final flush', async () => {
  const ctx = new Context()
  const release = Promise.withResolvers<undefined>()
  const flushing = Promise.withResolvers<undefined>()
  try {
    await mountAgentLoopTestDependencies(ctx)
    const loop = await ctx.plugin(AgentLoop, { agents: [] })
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('answer')]))
    const parent = await ctx.agentLoop.create(SessionId('factory-unload-parent'), { provider: 'mock', model: 'mock' })
    ctx.on('session/flush', async (session) => {
      if (session.header.origin !== 'subagent') return
      flushing.resolve(undefined)
      await release.promise
    })
    const started = await ctx.subagents.startActivation({
      provider: 'spawn', label: 'child', prompt: [{ type: 'text', text: 'task' }],
      parent, signal: new AbortController().signal, delivery: 'caller',
    })
    await flushing.promise
    const state = managerState(ctx)
    const activation = state.resident.get(started.childId)!
    const released = vi.spyOn(activation, 'releaseSlot')
    const ended = vi.fn()
    ctx.on('subagent/end', ended)
    await loop.dispose()
    expect(ctx.agents.get(started.childId)).toBeUndefined()
    release.resolve(undefined)
    await vi.waitFor(() => { expect(state.resident.has(started.childId)).toBe(false) }, { timeout: 1000 })
    expect(await started.result).toMatchObject({ stopReason: 'completed' })
    expect(released).toHaveBeenCalledTimes(1)
    expect(ended).toHaveBeenCalledTimes(1)
  } finally {
    release.resolve(undefined)
    await ctx.fiber.dispose()
  }
})
