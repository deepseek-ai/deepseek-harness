import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, HarnessError, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime, { SubagentError } from '@deepseek-ai/dsh-subagent'
import { renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import * as control from '../src/index.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

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
  const result = ctx.tools.execute({
    name: 'wait_agent', callId: ToolCallId('wait'), arguments: args, agent, signal,
  })
  await entered.promise
  off()
  return { result }
}

describe('wait_agent', () => {
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
    await vi.advanceTimersByTimeAsync(9_999)
    expect(returned).toBe(false)
    agent.inject(input('steering'))
    expect(await result).toMatchObject({ isError: false, value: { timedOut: false } })
    expect(agent.inbox.nextTurn).toHaveLength(1)
    expect(agent.inbox.nextStep).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

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

  it('reports plugin unload, removes prompts, and permits a clean reload', async () => {
    const { ctx, agent, fiber } = await setup()
    vi.useFakeTimers()
    const { result } = await startWait(ctx, agent)
    await fiber.dispose()
    expect(await result).toMatchObject({ isError: true, error: { info: { code: 'WAIT_UNAVAILABLE' } } })
    expect(vi.getTimerCount()).toBe(0)
    expect(ctx.tools.get('wait_agent')).toBeUndefined()
    const absent = await ctx.systemPrompt.assemble({ agent, scope: agent })
    expect(absent.sections.some(section => section.name === 'subagent:policy')).toBe(false)
    expect(absent.contexts.some(context => context.name === 'subagent:identity')).toBe(false)

    await ctx.plugin(control)
    const restored = await ctx.systemPrompt.assemble({ agent, scope: agent })
    expect(restored.sections.filter(section => section.name === 'subagent:policy')).toHaveLength(1)
    expect(renderContextSnapshot(restored)).toContain('Your agent id is "waiting". Your Team root agent id is "waiting". You are the root agent.')
    agent.inject(input())
    expect(await (await startWait(ctx, agent)).result).toMatchObject({ isError: false, value: { timedOut: false } })
  })

  it('rejects calls without a live calling agent', async () => {
    const { ctx, agent, handle } = await setup()
    const missing = await ctx.tools.execute({
      name: 'wait_agent', callId: ToolCallId('missing'), arguments: {}, signal: new AbortController().signal,
    })
    expect(missing).toMatchObject({ isError: true, error: { info: { code: 'WAIT_UNAVAILABLE' } } })
    await handle.dispose()
    const { result } = await startWait(ctx, agent)
    expect(await result).toMatchObject({ isError: true, error: { info: { code: 'WAIT_UNAVAILABLE' } } })
  })

  it('derives nested identity from runtime ownership while ordinary forks remain roots', async () => {
    const { ctx, agent } = await setup()
    const child = await ctx.agents.create({
      sessionId: SessionId('child'), parentAgent: agent,
      meta: { parentSession: agent.id, origin: 'subagent' },
    })
    const nested = await ctx.agents.create({
      sessionId: SessionId('nested'), parentAgent: agent,
      meta: { parentSession: child.agent.id, origin: 'subagent' },
    })
    const fork = await ctx.agents.create({
      sessionId: SessionId('ordinary-fork'), meta: { parentSession: agent.id },
    })
    const nestedAssembly = await ctx.systemPrompt.assemble({ agent: nested.agent, scope: nested.agent })
    expect(renderContextSnapshot(nestedAssembly)).toContain('Your agent id is "nested". Your Team root agent id is "waiting". Your parent agent id is "child".')
    const forkAssembly = await ctx.systemPrompt.assemble({ agent: fork.agent, scope: fork.agent })
    expect(renderContextSnapshot(forkAssembly)).toContain('Your agent id is "ordinary-fork". Your Team root agent id is "ordinary-fork". You are the root agent.')
    expect(renderContextSnapshot(forkAssembly)).not.toContain('Your parent agent id')
  })

  it('allows an orphaned subagent to continue ordinary work without inventing a root', async () => {
    const { ctx } = await setup()
    const adapter = new MockAdapter([textResponse('independent work done')])
    ctx.llm.registerAdapter(['mock'], adapter)
    const orphan = await ctx.agents.create({
      sessionId: SessionId('orphan'),
      meta: { parentSession: SessionId('unloaded-parent'), origin: 'subagent' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    orphan.agent.followup(input('continue ordinary work'))
    await orphan.agent.whenIdle()
    expect(adapter.requests).toHaveLength(1)
    const assembly = await ctx.systemPrompt.assemble({ agent: orphan.agent, scope: orphan.agent })
    expect(renderContextSnapshot(assembly)).toContain('Your agent id is "orphan". Your Team root agent is unavailable. Your parent agent id is "unloaded-parent".')
    expect(renderContextSnapshot(assembly)).not.toContain('You are the root agent.')
    expect(orphan.agent.session.ownEvents().some(event => event.type === 'assistant/message')).toBe(true)
  })

  it('omits identity without an agent and propagates unexpected root lookup failures', async () => {
    const { ctx, agent } = await setup()
    const agentless = await ctx.systemPrompt.assemble()
    expect(renderContextSnapshot(agentless)).not.toContain('Your agent id')
    const failure = new SubagentError('root lookup failed', 'INTERNAL_FAILURE')
    vi.spyOn(ctx.subagents, 'rootOf').mockImplementation(() => { throw failure })
    await expect(ctx.systemPrompt.assemble({ agent, scope: agent })).rejects.toBe(failure)
  })
})
