import { expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import SubagentRuntime from '../src/index.ts'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'
import { managerState } from './manager-internals.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

it.each([false, true])('settles an activation after factory unload with queue-clear failure=%s', async (rejectQueueClear) => {
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
    const child = ctx.agents.get(started.childId)!
    if (rejectQueueClear) child.inject(createUserMessage({ content: [{ type: 'text', text: 'pending' }], source: { kind: 'user' } }))
    const rejectClear = ctx.on('internal/dispatch', (_mode, name, args) => {
      if (name !== 'session/event') return
      const [session, event] = args as [Session, SessionEvent]
      if (rejectQueueClear && session === child.session && event.type === 'agent/inbox/spliced' && (event.data.removedCount ?? 0) > 0) {
        throw new Error('queue clear rejected')
      }
    })
    await loop.dispose()
    expect(child.inbox.nextStep.length + child.inbox.nextTurn.length > 0).toBe(rejectQueueClear)
    rejectClear()
    expect(ctx.agents.get(started.childId)).toBeUndefined()
    release.resolve(undefined)
    const stopReason = rejectQueueClear ? 'error' : 'completed'
    expect(await started.result).toMatchObject({
      output: [{ type: 'text', text: 'answer' }],
      stopReason,
    })
    expect(state.resident.has(started.childId)).toBe(false)
    expect(released).toHaveBeenCalledTimes(1)
    expect(ended).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ stopReason }))
  } finally {
    release.resolve(undefined)
    await ctx.fiber.dispose()
  }
})
