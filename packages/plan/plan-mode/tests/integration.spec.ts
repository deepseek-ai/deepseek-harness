import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, type StreamChunk  } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const PLAN_CONFIG = { section: 'Test plan mode instructions.' }

/**
 * Full-loop integration: a scripted mock model drives the REAL plan-mode plugin
 * through the agent loop — the pending-intent flush at the step boundary, the
 * assembly the soft layer shapes (the exit tool + mode section), and the
 * `request/header` snapshots every transition leaves.
 * Only the model is mocked; the loop, the session log, and the plugin are
 * real.
 */
async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(PlanModeController, PLAN_CONFIG)
  ctx.llm.registerAdapter(['mock'], adapter)
  for (const name of ['read', 'write']) {
    ctx.tools.register(defineContentToolFixture({
      name,
      description: `test tool ${name}`,
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: `ran ${name}` }]),
    }))
  }
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

/** Read the plan unit that backs the service in this full composition. */
function planActive(ctx: Context, agent: Agent): boolean {
  const state = ctx.sessionProjections.stateOf(agent.session, 'plan')
  if (state === undefined) throw new Error('plan projection is not registered')
  return state.active
}

function findEvent<T extends SessionEvent['type']>(
  log: readonly SessionEvent[],
  type: T,
  position: 'first' | 'last' = 'first',
): Extract<SessionEvent, { type: T }> {
  const found = position === 'first'
    ? log.find(event => event.type === type)
    : log.findLast(event => event.type === type)
  if (!found) throw new Error(`no ${type} event in the session log`)
  return found as Extract<SessionEvent, { type: T }>
}

describe('plan mode through the agent loop', () => {
  it('a pre-turn set() makes the FIRST header plan-shaped, and a non-shell call is guidance-constrained only', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'write', {}, 'Writing during plan.'),
      textResponse('Noted in the plan.'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('it-plan-seed'), { provider: 'mock', model: 'mock' })
    // Selected while idle: the mode commits immediately, before the first assembly.
    ctx.planMode.set(agent, true)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'explore the repo' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const log = agent.session.snapshotEvents()
    const planMode = findEvent(log, 'plan/mode')
    const header = findEvent(log, 'request/header')
    expect(planMode.seq).toBeLessThan(header.seq)
    expect(header.data.reason).toBe('initial')
    expect(header.data.header.tools?.map(tool => tool.name)).toEqual(['exit_plan_mode', 'read', 'write'])
    expect(header.data.header.system).toContain('plan mode')

    // No tool gate: the write RUNS — plan restrains by the section's
    // guidance alone (enforcement lives on the independent sandbox/approval
    // axes). The mode itself stays plan throughout.
    const result = findEvent(log, 'tool/result')
    expect(result.data.message.content[0].isError).toBe(false)
    expect(planActive(ctx, agent)).toBe(true)
    expect(log.some(event => event.type === 'user/message' && event.data.source.kind === 'plugin')).toBe(false)
  })

  it('a user flip between turns lands at the boundary: one notice and a changed header with stable tool schemas', async () => {
    const adapter = new MockAdapter([
      textResponse('First turn, default mode.'),
      textResponse('Second turn, plan mode.'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('it-plan-flip'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(planActive(ctx, agent)).toBe(false)
    const first = findEvent(agent.session.snapshotEvents(), 'request/header')
    expect(first.data.header.tools?.map(tool => tool.name)).toEqual(['exit_plan_mode', 'read', 'write'])

    ctx.planMode.set(agent, true)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'now plan' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const log = agent.session.snapshotEvents()
    expect(planActive(ctx, agent)).toBe(true)
    const notices = log.filter(event => event.type === 'user/message' && event.data.source.kind === 'plugin')
    expect(notices).toHaveLength(1)
    expect(notices[0]?.type === 'user/message' && notices[0].data.content).toEqual([
      { type: 'text', text: 'The user switched this session to plan mode.' },
    ])
    // The changed request is logged as a complete snapshot.
    const second = findEvent(log, 'request/header', 'last')
    expect(second.data.reason).toBe('change')
    expect(second.data.header.tools?.map(tool => tool.name)).toEqual(['exit_plan_mode', 'read', 'write'])
    expect(second.data.header.tools).toEqual(first.data.header.tools)
    expect(second.data.header.system).toContain('plan mode')
  })

  it('a mode flip at error settlement waits until the step after a same-step retry', async () => {
    const failedRequest = [{
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'temporarily unavailable', code: 'SERVER', status: 503 } },
    }] satisfies StreamChunk[]
    const adapter = new MockAdapter([
      failedRequest,
      textResponse('Recovered with the original step assembly.'),
      textResponse('Entered plan mode on the next step.'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(SessionId('it-plan-retry-flip'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/request-error', async ({ agent: subject }, next) => {
      if (subject !== agent) return next()
      ctx.planMode.set(agent, true)
      return { kind: 'retry' }
    })

    const idle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'plan after the transient failure' }], source: { kind: 'user' } }))
    await idle

    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[0]?.system).not.toContain(PLAN_CONFIG.section)
    expect(adapter.requests[1]?.system).not.toContain(PLAN_CONFIG.section)
    expect(adapter.requests[1]?.tools).toEqual(adapter.requests[0]?.tools)
    expect(ctx.planMode.get(agent)).toEqual({ active: false, pending: true })
    expect(agent.session.snapshotEvents().some(event => event.type === 'plan/mode')).toBe(false)

    const nextIdle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue with the plan' }], source: { kind: 'user' } }))
    await nextIdle

    expect(adapter.requests).toHaveLength(3)
    expect(adapter.requests[2]?.system).toContain(PLAN_CONFIG.section)
    expect(adapter.requests[2]?.tools).toEqual(adapter.requests[0]?.tools)
    const log = agent.session.snapshotEvents()
    const planMode = findEvent(log, 'plan/mode')
    const firstEnd = log.find(event => event.type === 'step/end'
      && event.data.turn === 1 && event.data.step === 1)
    const nextStart = log.find(event => event.type === 'step/start'
      && event.data.turn === 2 && event.data.step === 1)
    expect(firstEnd?.seq).toBeLessThan(planMode.seq)
    expect(planMode.seq).toBeLessThan(nextStart?.seq ?? 0)
    expect(findEvent(log, 'request/header', 'last').data.header.system).toContain(PLAN_CONFIG.section)
    const notice = log.find(event => event.type === 'user/message' && event.data.source.kind === 'plugin')
    expect(notice?.type === 'user/message' && notice.data.content).toEqual([
      { type: 'text', text: 'The user switched this session to plan mode.' },
    ])
  })
})
