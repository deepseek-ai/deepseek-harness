import { getEventListeners } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { WorkflowRunId } from '@deepseek-ai/dsh-workflow'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { MockAdapter, textResponse } from '../packages/core/agent-loop/tests/mock-adapter.ts'
import type {} from '@deepseek-ai/dsh-tool-workflow'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error Scenario plugins are runtime JavaScript without declaration artifacts.
import * as fixtureModule from './fixtures/python-snapshot-workflow-order.mjs'

const config = { parentSessionId: 'advanced-parent', prompt: 'workflow child prompt' }
const fixture = fixtureModule as unknown as {
  name: string
  apply(ctx: Context, config: { parentSessionId: string; prompt: string }): void
}
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function harness() {
  const ctx = new Context()
  const store = ctx.plugin(SessionStore)
  await store
  cleanups.push(() => store.dispose())
  const fiber = ctx.plugin(fixture, config)
  await fiber
  cleanups.push(() => fiber.dispose())
  const parent = ctx.sessions.create(SessionId(config.parentSessionId))
  const other = ctx.sessions.create(SessionId('other-parent'))
  const session = ctx.sessions.create(SessionId('workflow-child'), { meta: { parentSession: parent.id } })
  // The dispatcher needs only the subject identity; the fixture reads its Session.
  const agent = { id: session.id, session } as Agent
  const controller = new AbortController()
  const messages = [createUserMessage({ content: [{ type: 'text', text: config.prompt }], source: { kind: 'user' } })]
  const decision: PreStepDecision = { kind: 'enter', messages }
  const next = vi.fn(async () => decision)
  const start = (owner = parent, childId = agent.id) => owner.append('tool-workflow/agent-start', {
    runId: WorkflowRunId('run'), seq: 1, label: 'workflow-child', childId,
  })
  const step = (overrides = {}) => agentEvents(ctx, agent).waterfall('agent/pre-step', {
    turn: 1, step: 1, messages, signal: controller.signal, ...overrides,
  }, next)
  return { ctx, fiber, parent, other, session, agent, controller, decision, next, start, step }
}

describe('advanced Python snapshot workflow ordering', () => {
  it('blocks a real spawned child before its descriptor and first model request', async () => {
    const ctx = new Context()
    const entered = Promise.withResolvers<Agent>()
    const order: string[] = []
    const adapter = new MockAdapter([textResponse('child complete')])
    const assembly = ctx.plugin({
      name: 'workflow-order-driver-test',
      async apply(inner: Context) {
        await mountAgentLoopTestDependencies(inner)
        await inner.plugin(AgentLoop, { agents: [] })
        await inner.plugin(SubagentRuntime)
        await inner.plugin(spawn, { providerName: 'spawn' })
        inner.on('agent/pre-step', ({ agent }, next) => {
          if (agent.session.header.parentSession === config.parentSessionId) entered.resolve(agent)
          return next()
        })
        inner.on('session/event', (_session, event) => {
          if (event.type === 'tool-workflow/agent-start' || event.type === 'subagent/descriptor') order.push(event.type)
        })
        await inner.plugin(fixture, config)
      },
    })
    cleanups.push(() => assembly.dispose())
    await assembly
    ctx.llm.registerAdapter(['mock'], adapter)
    const parent = await ctx.agentLoop.create(SessionId(config.parentSessionId), { provider: 'mock', model: 'mock' })
    const run = await ctx.subagents.start('spawn', {
      parent, prompt: [{ type: 'text', text: config.prompt }], signal: new AbortController().signal,
    })
    cleanups.push(() => run.dispose())
    const child = await entered.promise
    expect(child.id).toBe(run.id)
    expect(adapter.requests).toHaveLength(0)
    expect(child.session.snapshotEvents().some(event => event.type === 'subagent/descriptor')).toBe(false)
    parent.session.append('tool-workflow/agent-start', {
      runId: WorkflowRunId('run'), seq: 1, label: 'workflow-child', childId: child.id,
    })
    expect((await run.result).output).toEqual([{ type: 'text', text: 'child complete' }])
    expect(adapter.requests).toHaveLength(1)
    expect(order).toEqual(['tool-workflow/agent-start', 'subagent/descriptor'])
  })

  it('holds the child until the exact parent records the exact member', async () => {
    const h = await harness()
    const pending = h.step()
    expect(h.next).not.toHaveBeenCalled()
    expect(getEventListeners(h.controller.signal, 'abort')).toHaveLength(1)
    h.start(h.other)
    h.start(h.parent, SessionId('other-child'))
    h.parent.append('tool-workflow/run-start', { runId: WorkflowRunId('run'), name: 'workflow' })
    await Promise.resolve()
    expect(h.next).not.toHaveBeenCalled()
    h.start()
    expect(await pending).toBe(h.decision)
    expect(h.next).toHaveBeenCalledOnce()
    expect(getEventListeners(h.controller.signal, 'abort')).toHaveLength(0)
  })

  it('retains a start recorded before the child reaches its first step', async () => {
    const h = await harness()
    h.start()
    expect(await h.step()).toBe(h.decision)
    expect(h.next).toHaveBeenCalledOnce()
    expect(getEventListeners(h.controller.signal, 'abort')).toHaveLength(0)
  })

  it.each(['prompt', 'parent', 'turn', 'step'])('does not hold an unrelated %s', async (difference) => {
    const h = await harness()
    const overrides = difference === 'prompt' ? { messages: [] }
      : difference === 'turn' ? { turn: 2 }
        : difference === 'step' ? { step: 2 } : {}
    if (difference === 'parent') {
      const session = h.ctx.sessions.create(SessionId('unrelated-child'), { meta: { parentSession: h.other.id } })
      Object.assign(h.agent, { session })
    }
    expect(await h.step(overrides)).toBe(h.decision)
    expect(h.next).toHaveBeenCalledOnce()
  })

  it.each([false, true])('rejects cancellation and detaches the waiter (already aborted: %s)', async (alreadyAborted) => {
    const h = await harness()
    const reason = new Error('cancelled child')
    if (alreadyAborted) h.controller.abort(reason)
    const pending = h.step()
    const rejected = expect(pending).rejects.toBe(reason)
    h.controller.abort(reason)
    await rejected
    h.start()
    expect(h.next).not.toHaveBeenCalled()
    expect(getEventListeners(h.controller.signal, 'abort')).toHaveLength(0)
  })

  it('does not admit a cancelled child when start and cancellation share a tick', async () => {
    const h = await harness()
    const reason = new Error('cancelled after membership')
    const pending = h.step()
    const rejected = expect(pending).rejects.toBe(reason)
    h.start()
    h.controller.abort(reason)
    await rejected
    expect(h.next).not.toHaveBeenCalled()
    expect(getEventListeners(h.controller.signal, 'abort')).toHaveLength(0)
  })

  it('settles pending waits before disposal completes and removes both listeners', async () => {
    const h = await harness()
    const pending = h.step()
    const rejected = expect(pending).rejects.toThrow('workflow snapshot barrier disposed')
    await h.fiber.dispose()
    await rejected
    h.start()
    expect(h.next).not.toHaveBeenCalled()
    expect(getEventListeners(h.controller.signal, 'abort')).toHaveLength(0)
    expect(await h.step()).toBe(h.decision)
  })
})
