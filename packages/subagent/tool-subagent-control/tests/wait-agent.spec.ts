import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { agentCarrier, emitAgentEvent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, HarnessError, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime, { SubagentError } from '@deepseek-ai/dsh-subagent'
import SubagentNames from '@deepseek-ai/dsh-subagent-names'
import { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import * as control from '../src/index.ts'
import { bindSubagentActivation } from '../../subagent/tests/manager-internals.ts'

const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

async function setup() {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { workingDirectory: true, systemPrompt: { includeRuntimeContext: false } })
  const harness = await mountAgentLoopTestHarness(ctx)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentNames)
  const fiber = await ctx.plugin(control)
  const handle = await ctx.agents.create({ sessionId: SessionId('waiting') })
  const other = await harness.create(SessionId('other'))
  return { ctx, harness, fiber, handle, agent: handle.agent, other }
}

function input(text = 'new input') {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** Observe body admission through the real execution waterfall before triggering competing events. */
async function startWait(ctx: Context, agent: Agent, args: unknown = {}, signal = new AbortController().signal) {
  const entered = Promise.withResolvers<undefined>()
  const off = ctx.on('tools/execute', (exec, next) => {
    const result = next()
    if (exec.name === 'wait_agent' && exec.agent === agent) entered.resolve(undefined)
    return result
  })
  const result = executeToolFixture(ctx, {
    name: 'wait_agent', callId: ToolCallId('wait'), arguments: args, agent, signal,
  })
  await entered.promise
  off()
  return { result }
}

describe('wait_agent', () => {
  it('registers without Team policy or root communication context', async () => {
    const { ctx, agent } = await setup()
    const assembled = await ctx.systemPrompt.assemble({ agent, scope: agent })
    expect(assembled.sections.some(section => section.name === 'subagent:policy')).toBe(false)
    expect(assembled.contexts.some(context => context.name === 'subagent:identity' || context.name === 'team:identity')).toBe(false)
    expect(renderContextSnapshot(assembled)).not.toContain('Your parent agent id')
    expect(ctx.tools.get('wait_agent', agent)).toBeDefined()
    expect(JSON.stringify(ctx.tools.schemas(agent))).not.toMatch(/\b(?:Team|teammate|Lead)\b/)
  })

  it('is available without Team mode and leaves pending input for normal admission', async () => {
    const { ctx, agent, harness } = await setup()
    const message = input()
    agent.inject(message)
    const { result } = await startWait(ctx, agent)
    expect(await result).toMatchObject({ isError: false, value: { timedOut: false } })
    expect(agent.inbox.nextStep.map(item => item.id)).toEqual([message.id])
    expect(harness.claim(agent, 'next-step', 1).map(item => item.id)).toEqual([message.id])

    vi.useFakeTimers()
    const later = await startWait(ctx, agent, { timeout_ms: 10_000 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await later.result).toMatchObject({ isError: false, value: { timedOut: true } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('wakes only for the caller next-step input, including while all other agents are idle', async () => {
    const { ctx, agent, other } = await setup()
    vi.useFakeTimers()
    const { result } = await startWait(ctx, agent, { timeout_ms: 10_000 })
    let returned = false
    void result.then(() => { returned = true })
    agent.inbox.splice('next-turn', 0, 0, [input('queued')])
    other.inject(input('someone else'))
    emitAgentEvent(ctx, other, 'agent/status', { status: 'running' })
    ctx.subagents.notifyTreeWaits(other)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(returned).toBe(false)
    agent.inject(input('steering'))
    expect(await result).toMatchObject({ isError: false, value: { timedOut: false } })
    expect(agent.inbox.nextTurn).toHaveLength(1)
    expect(agent.inbox.nextStep).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ends all current waits for an exact tree root without retaining notifications', async () => {
    const { ctx, agent, other } = await setup()
    vi.useFakeTimers()
    ctx.subagents.notifyTreeWaits(agent)
    const first = await startWait(ctx, agent, { timeout_ms: 10_000 })
    const second = await startWait(ctx, agent, { timeout_ms: 10_000 })
    let returned = false
    void first.result.then(() => { returned = true })
    ctx.subagents.notifyTreeWaits(other)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(returned).toBe(false)
    ctx.subagents.notifyTreeWaits(agent)
    for (const result of await Promise.all([first.result, second.result])) {
      expect(result).toMatchObject({ isError: false, value: { timedOut: false } })
    }
    expect(agent.inbox.nextStep).toHaveLength(0)
    expect(agent.inbox.nextTurn).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
    const later = await startWait(ctx, agent, { timeout_ms: 10_000 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await later.result).toMatchObject({ isError: false, value: { timedOut: true } })
  })

  it('wakes root and scoped descendant waits while another tree keeps waiting', async () => {
    const { ctx, agent, other } = await setup()
    const child = (await ctx.agents.create({
      sessionId: SessionId('child'), meta: { origin: 'subagent', parentSession: agent.id },
      setup: (_ctx, child) => { bindSubagentActivation(ctx, child, agent) },
    })).agent
    // The child-owned tool listener must receive the root signal across scopes.
    await child.ctx.plugin(control)
    vi.useFakeTimers()
    const rootWait = await startWait(ctx, agent, { timeout_ms: 10_000 })
    const childWait = await startWait(ctx, child, { timeout_ms: 10_000 })
    const otherWait = await startWait(ctx, other, { timeout_ms: 10_000 })
    ctx.subagents.notifyTreeWaits(agent)
    for (const result of await Promise.all([rootWait.result, childWait.result])) {
      expect(result).toMatchObject({ isError: false, value: { timedOut: false } })
    }
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await otherWait.result).toMatchObject({ isError: false, value: { timedOut: true } })
  })

  it('keeps an unmanaged delegated Agent waiting for its own inbox', async () => {
    const { ctx, agent } = await setup()
    const child = (await ctx.agents.create({
      sessionId: SessionId('unmanaged'), meta: { origin: 'subagent', parentSession: agent.id },
    })).agent
    vi.useFakeTimers()
    const { result } = await startWait(ctx, child, { timeout_ms: 10_000 })
    ctx.subagents.notifyTreeWaits(agent)
    ctx.subagents.notifyTreeWaits(child)
    expect(vi.getTimerCount()).toBe(1)
    child.inject(input())
    expect(await result).toMatchObject({ isError: false, value: { timedOut: false } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores a disposed root and its same-id replacement', async () => {
    const { ctx, agent, handle } = await setup()
    const child = (await ctx.agents.create({
      sessionId: SessionId('surviving-child'), meta: { origin: 'subagent', parentSession: agent.id },
      setup: (_ctx, child) => { bindSubagentActivation(ctx, child, agent) },
    })).agent
    vi.useFakeTimers()
    const { result } = await startWait(ctx, child, { timeout_ms: 10_000 })
    await handle.dispose()
    const replacement = (await ctx.agents.create({ sessionId: agent.id })).agent
    ctx.subagents.notifyTreeWaits(agent)
    ctx.subagents.notifyTreeWaits(replacement)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await result).toMatchObject({ isError: false, value: { timedOut: true } })
  })

  it.each([
    new Error('identity projection unavailable'),
    new SubagentError('runtime unavailable', 'RUNTIME_UNAVAILABLE'),
  ])('reports unexpected root lookup failure before subscribing: %s', async (failure) => {
    const { ctx, agent } = await setup()
    vi.useFakeTimers()
    vi.spyOn(ctx.subagents, 'rootOf').mockImplementation(() => { throw failure })
    const { result } = await startWait(ctx, agent)
    expect(await result).toMatchObject({ isError: true, error: { message: failure.message } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['input', 'notification', 'timeout', 'cancel', 'dispose', 'unload'] as const)(
    'removes its notification subscription after %s',
    async (settlement) => {
      const { ctx, agent, handle, fiber } = await setup()
      vi.useFakeTimers()
      const listeners = () => [
        ...['agent/inbox/inserted', 'agent/disposed'].map(name =>
          ctx.events.dispatch('emit', [agentCarrier(agent), name, { agent }]).length),
        ctx.events.dispatch('emit', ['subagent/tree-wait-notified', agent]).length,
      ]
      const baseline = listeners()
      const controller = new AbortController()
      const { result } = await startWait(ctx, agent, { timeout_ms: 10_000 }, controller.signal)
      expect(listeners()).toEqual(baseline.map(count => count + 1))
      switch (settlement) {
        case 'input': agent.inject(input()); break
        case 'notification': ctx.subagents.notifyTreeWaits(agent); break
        case 'timeout': await vi.advanceTimersByTimeAsync(10_000); break
        case 'cancel': controller.abort(new Error('stop waiting')); break
        case 'dispose': await handle.dispose(); break
        case 'unload': await fiber.dispose(); break
      }
      await result
      expect(listeners()).toEqual(baseline)
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('subscribes before checking pending input', async () => {
    const { ctx, agent } = await setup()
    const message = input('arrived during the pending check')
    vi.spyOn(agent.inbox, 'nextStep', 'get').mockImplementationOnce(() => {
      agent.inject(message)
      return []
    })
    const { result } = await startWait(ctx, agent)
    expect(await result).toMatchObject({ isError: false, value: { timedOut: false } })
    expect(agent.inbox.nextStep.map(item => item.id)).toEqual([message.id])
  })

  it('leaves no timer when plugin disposal rejects listener registration', async () => {
    const { ctx, agent, fiber } = await setup()
    vi.useFakeTimers()
    const definition = ctx.tools.get('wait_agent')!
    const execute = definition.execute.bind(definition)
    let disposal = Promise.resolve()
    vi.spyOn(definition, 'execute').mockImplementation((args, exec) => {
      // Disposal invalidates the context before its deferred cleanup aborts waits.
      disposal = Promise.resolve(fiber.dispose())
      return execute(args, exec)
    })
    const { result } = await startWait(ctx, agent)
    expect(await result).toMatchObject({ isError: true, error: { message: 'cannot create effect on inactive context' } })
    await disposal
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    [{}, 30_000],
    [{ timeout_ms: 10_000 }, 10_000],
    [{ timeout_ms: 3_600_000 }, 3_600_000],
  ])('expires at the resolved timeout %j', async (args, timeoutMs) => {
    const { ctx, agent } = await setup()
    vi.useFakeTimers()
    const { result } = await startWait(ctx, agent, args)
    let returned = false
    void result.then(() => { returned = true })
    await vi.advanceTimersByTimeAsync(timeoutMs - 1)
    expect(returned).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await result).toMatchObject({ isError: false, value: { timedOut: true } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([9_999, 3_600_001])('rejects out-of-range timeout %s before checking pending input', async (timeoutMs) => {
    const { ctx, agent } = await setup()
    agent.inject(input())
    const { result } = await startWait(ctx, agent, { timeout_ms: timeoutMs })
    expect(await result).toMatchObject({ isError: true, error: { info: { code: 'WAIT_INVALID_TIMEOUT' } } })
  })

  it('preserves caller cancellation and removes the timer', async () => {
    const { ctx, agent } = await setup()
    vi.useFakeTimers()
    const controller = new AbortController()
    const { result } = await startWait(ctx, agent, {}, controller.signal)
    controller.abort(new HarnessError('caller stopped waiting', 'CALLER_STOPPED'))
    expect(await result).toMatchObject({ isError: true, error: { info: { code: 'CALLER_STOPPED' }, message: 'caller stopped waiting' } })
    expect(vi.getTimerCount()).toBe(0)
    agent.inject(input('after cancellation'))
  })

  it('preserves cancellation at body entry before inbox subscriptions exist', async () => {
    const { ctx, agent } = await setup()
    vi.useFakeTimers()
    const controller = new AbortController()
    const definition = ctx.tools.get('wait_agent')!
    const execute = definition.execute.bind(definition)
    vi.spyOn(definition, 'execute').mockImplementation((args, exec) => {
      controller.abort(new HarnessError('cancelled at entry', 'CALLER_STOPPED'))
      return execute(args, exec)
    })
    const { result } = await startWait(ctx, agent, {}, controller.signal)
    expect(await result).toMatchObject({
      isError: true, error: { info: { code: 'CALLER_STOPPED' }, message: 'cancelled at entry' },
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports agent disposal without claiming an inbox update', async () => {
    const { ctx, agent, handle } = await setup()
    const unrelated = await ctx.agents.create({ sessionId: SessionId('unrelated') })
    vi.useFakeTimers()
    const { result } = await startWait(ctx, agent)
    await unrelated.dispose()
    expect(vi.getTimerCount()).toBe(1)
    await handle.dispose()
    expect(await result).toMatchObject({ isError: true, error: { info: { code: 'WAIT_UNAVAILABLE' } } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports plugin unload and permits a clean reload', async () => {
    const { ctx, agent, fiber } = await setup()
    vi.useFakeTimers()
    const { result } = await startWait(ctx, agent)
    await fiber.dispose()
    expect(await result).toMatchObject({ isError: true, error: { info: { code: 'WAIT_UNAVAILABLE' } } })
    expect(vi.getTimerCount()).toBe(0)
    expect(ctx.tools.get('wait_agent')).toBeUndefined()
    await ctx.plugin(control)
    agent.inject(input())
    expect(await (await startWait(ctx, agent)).result).toMatchObject({ isError: false, value: { timedOut: false } })
  })

  it('rejects calls without a live calling agent', async () => {
    const { ctx, agent, handle } = await setup()
    const missing = await executeToolFixture(ctx, {
      name: 'wait_agent', callId: ToolCallId('missing'), arguments: {}, signal: new AbortController().signal,
    })
    expect(missing).toMatchObject({ isError: true, error: { info: { code: 'WAIT_UNAVAILABLE' } } })
    await handle.dispose()
    const { result } = await startWait(ctx, agent)
    expect(await result).toMatchObject({ isError: true, error: { info: { code: 'WAIT_UNAVAILABLE' } } })
  })
})
