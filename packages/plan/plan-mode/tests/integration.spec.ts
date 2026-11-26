import * as NativeToolRegistry from '@deepseek-ai/dsh-tool-registry-native'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import LlmRuntime, { createUserMessage, type GenerateOptions, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import PlanModeController from '@deepseek-ai/dsh-plan-mode'
import UserQuestionService, { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { brandString } from '@deepseek-ai/dsh-brand'

const PLAN_CONFIG = { section: 'Test plan mode instructions.' }

/**
 * Full-loop integration: a scripted mock model drives the REAL plan-mode plugin
 * through the agent loop — the pending-intent flush at the step boundary, the
 * assembly the soft layer shapes (the exit tool + mode section), and the
 * `system/message` surface node every prompt transition replaces.
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
  await ctx.plugin(NativeToolRegistry)
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
  const state = ctx.planMode.get(agent)
  return state.active
}

/** Join the text blocks of one message. */
function textOf(message: Message): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/** System instructions and updates in their model-visible order. */
function systemText(agent: Agent): string {
  return agent.session.deriveMessages().filter(message => message.role === 'system').map(textOf).join('\n\n')
}

/** System instructions and updates in one loop-built request. */
function requestSystem(options: GenerateOptions | undefined): string {
  return options?.messages.filter(message => message.role === 'system').map(textOf).join('\n\n') ?? ''
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
    const agent = await ctx.agentLoop.create(brandString<SessionId>('it-plan-seed'), { provider: 'mock', model: 'mock' })
    // Selected while idle: the mode commits immediately, before the first assembly.
    ctx.planMode.set(agent, true)

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'explore the repo' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const log = agent.session.snapshotEvents()
    const planMode = findEvent(log, 'plan/mode')
    const header = findEvent(log, 'request/header')
    const systemNode = findEvent(log, 'system/message')
    expect(planMode.seq).toBeLessThan(header.seq)
    expect(header.data.reason).toBe('initial')
    expect(header.data.header.tools?.map(tool => tool.name)).toEqual(['exit_plan_mode', 'read', 'write'])
    // The first system node already carries the section: appended, never replaced.
    expect(systemNode.surfaceOp).toBe('append')
    expect(log.filter(event => event.type === 'system/message')).toHaveLength(1)
    expect(agent.session.surface.nodes[0]).toBe(systemNode.seq)
    expect(systemText(agent)).toContain('plan mode')

    // No tool gate: the write RUNS — plan restrains by the section's
    // guidance alone (enforcement lives on the independent sandbox/approval
    // axes). The mode itself stays plan throughout.
    const result = findEvent(log, 'tool/result')
    expect(result.data.message.isError).toBe(false)
    expect(planActive(ctx, agent)).toBe(true)
    expect(log.filter(event => event.type === 'user/message').filter(event => event.data.source.kind === 'plan-mode')
      .map(event => event.data.content)).toEqual([
      [{ type: 'text', text: 'The user switched this session to plan mode.' }],
    ])
  })

  it('a user flip between turns appends plan instructions and status with the exit tool', async () => {
    const adapter = new MockAdapter([
      textResponse('First turn, default mode.'),
      textResponse('Second turn, plan mode.'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(brandString<SessionId>('it-plan-flip'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(planActive(ctx, agent)).toBe(false)
    const first = findEvent(agent.session.snapshotEvents(), 'request/header')
    expect(first.data.header.tools?.map(tool => tool.name)).toEqual(['read', 'write'])
    const firstSystem = findEvent(agent.session.snapshotEvents(), 'system/message')
    expect(systemText(agent)).not.toContain(PLAN_CONFIG.section)

    ctx.planMode.set(agent, true)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'now plan' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const log = agent.session.snapshotEvents()
    expect(planActive(ctx, agent)).toBe(true)
    const notices = log.filter(event => event.type === 'user/message' && event.data.source.kind !== 'user')
    expect(notices).toHaveLength(1)
    expect(notices[0]?.type === 'user/message' && notices[0].data.content).toEqual([
      { type: 'text', text: 'The user switched this session to plan mode.' },
    ])
    const systemNodes = log.filter(event => event.type === 'system/message')
    expect(systemNodes).toHaveLength(2)
    const second = systemNodes[1]
    expect(second?.surfaceOp).toBe('append')
    expect(second?.sourceEventSeqs).toBeUndefined()
    expect(agent.session.surface.nodes[0]).toBe(firstSystem.seq)
    expect(systemText(agent)).toContain('plan mode')
    expect(log.filter(event => event.type === 'request/header').map(event => event.data.reason)).toEqual(['initial', 'change'])
    const secondHeader = findEvent(log, 'request/header', 'last')
    expect(secondHeader.data.header.tools?.map(tool => tool.name)).toEqual(['exit_plan_mode', 'read', 'write'])
    expect(secondHeader.data.header.tools).not.toEqual(first.data.header.tools)
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
    const agent = await ctx.agentLoop.create(brandString<SessionId>('it-plan-retry-flip'), { provider: 'mock', model: 'mock' })
    ctx.on('agent/request-error', async ({ agent: subject }, next) => {
      if (subject !== agent) return next()
      ctx.planMode.set(agent, true)
      return { kind: 'retry' }
    })

    const idle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'plan after the transient failure' }], source: { kind: 'user' } }))
    await idle

    expect(adapter.requests).toHaveLength(2)
    expect(requestSystem(adapter.requests[0])).not.toContain(PLAN_CONFIG.section)
    expect(requestSystem(adapter.requests[1])).not.toContain(PLAN_CONFIG.section)
    expect(adapter.requests[1]?.tools).toEqual(adapter.requests[0]?.tools)
    expect(ctx.planMode.get(agent)).toEqual({ active: false, pending: true })
    expect(agent.session.snapshotEvents().some(event => event.type === 'plan/mode')).toBe(false)

    const nextIdle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue with the plan' }], source: { kind: 'user' } }))
    await nextIdle

    expect(adapter.requests).toHaveLength(3)
    expect(requestSystem(adapter.requests[2])).toContain(PLAN_CONFIG.section)
    expect(adapter.requests[2]?.tools?.map(tool => tool.name)).toEqual(['exit_plan_mode', 'read', 'write'])
    const log = agent.session.snapshotEvents()
    const planMode = findEvent(log, 'plan/mode')
    const firstEnd = log.find(event => event.type === 'step/end'
      && event.data.turn === 1 && event.data.step === 1)
    const nextStart = log.find(event => event.type === 'step/start'
      && event.data.turn === 2 && event.data.step === 1)
    expect(firstEnd?.seq).toBeLessThan(planMode.seq)
    expect(planMode.seq).toBeLessThan(nextStart?.seq ?? 0)
    const systemNodes = log.filter(event => event.type === 'system/message')
    expect(systemNodes).toHaveLength(2)
    expect(systemNodes[1]?.surfaceOp).toBe('append')
    expect(nextStart?.seq).toBeLessThan(systemNodes[1]?.seq ?? 0)
    expect(systemText(agent)).toContain(PLAN_CONFIG.section)
    const notice = log.find(event => event.type === 'user/message' && event.data.source.kind !== 'user')
    expect(notice?.type === 'user/message' && notice.data.content).toEqual([
      { type: 'text', text: 'The user switched this session to plan mode.' },
    ])
  })

  it('a rejected pre-step leaves a queued switch pending until the next accepted step', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'select_plan', {}, 'Selecting plan mode.'),
      textResponse('Entered plan mode on the next accepted step.'),
    ])
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(brandString<SessionId>('it-plan-rejected-step'), { provider: 'mock', model: 'mock' })
    // The selection arrives while the first step's tool runs, so it waits for a pre-step.
    ctx.tools.register(defineContentToolFixture({
      name: 'select_plan',
      description: 'select plan mode during the turn',
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: ctx.planMode.set(agent, true) }]),
    }))
    const rejecting = ctx.on('agent/pre-step', async ({ step }, next) => step === 2 ? { kind: 'reject' } : next())

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'select plan mode' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    const blocked = agent.session.snapshotEvents()
    expect(findEvent(blocked, 'tool/result').data.message.content).toEqual([{ type: 'text', text: 'queued' }])
    expect(findEvent(blocked, 'turn/end').data.reason).toEqual({ kind: 'blocked' })
    expect(blocked.some(event => event.type === 'plan/mode')).toBe(false)
    expect(blocked.some(event => event.type === 'user/message' && event.data.source.kind === 'plan-mode')).toBe(false)
    expect(ctx.planMode.get(agent)).toEqual({ active: false, pending: true })

    rejecting()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    expect(ctx.planMode.get(agent)).toEqual({ active: true })
    const log = agent.session.snapshotEvents()
    const nextStart = log.find(event => event.type === 'step/start' && event.data.turn === 2)
    expect(findEvent(log, 'plan/mode').seq).toBeLessThan(nextStart?.seq ?? 0)
    expect(log.filter(event => event.type === 'user/message' && event.data.source.kind === 'plan-mode')
      .map(event => event.type === 'user/message' && event.data.content)).toEqual([
      [{ type: 'text', text: 'The user switched this session to plan mode.' }],
    ])
    expect(requestSystem(adapter.requests[1])).toContain(PLAN_CONFIG.section)
  })

  it('introduces policy once and sends only status on exit and reentry', async () => {
    const adapter = new MockAdapter(Array.from({ length: 3 }, () => textResponse('ok')))
    const ctx = await harness(adapter)
    const agent = await ctx.agentLoop.create(brandString<SessionId>('plan-status-cycle'), { provider: 'mock', model: 'mock' })
    for (const active of [true, false, true]) {
      ctx.planMode.set(agent, active)
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } }))
      await agent.whenIdle()
    }
    const updates = agent.session.snapshotEvents().flatMap(event => event.type === 'system/message' ? [event.data.message] : [])
    expect(updates).toHaveLength(3)
    expect(updates[0]?.content.some(block => block.type === 'text' && block.text.includes(PLAN_CONFIG.section))).toBe(true)
    expect(updates.slice(1).map(message => message.source.sections?.map(section => section.name)))
      .toEqual([['plan:status'], ['plan:status']])
    expect(updates.slice(1).map(textOf)).toEqual([
      'Plan mode is inactive. The plan-mode instructions no longer apply.',
      'Plan mode is active. Follow the plan-mode instructions.',
    ])
  })

  it('a dismissed plan review ends the turn without another model request', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-exit', 'exit_plan_mode', { plan: '# Plan\n\ndo things' }),
      // Consumed only if the dismissal regresses to another model request.
      textResponse('Waiting for your message.'),
    ])
    const ctx = await harness(adapter)
    await ctx.plugin(UserQuestionService)
    ctx.on('user-questions/request', () => Promise.reject(new UserQuestionError('the user cancelled ask_user_question', 'ASK_CANCELLED')))
    const agent = await ctx.agentLoop.create(brandString<SessionId>('it-plan-dismiss'), { provider: 'mock', model: 'mock' })
    ctx.planMode.set(agent, true)

    const idle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'plan it' }], source: { kind: 'user' } }))
    await idle

    expect(adapter.requests).toHaveLength(1)
    const log = agent.session.snapshotEvents()
    const result = findEvent(log, 'tool/result')
    expect(result.data.message.isError).toBe(false)
    expect(result.data.message.content).toEqual([{ type: 'text', text: 'The user dismissed the plan review to reply in their own words; plan mode remains active.' }])
    expect(findEvent(log, 'turn/end').data.reason).toEqual({ kind: 'completed' })
    expect(planActive(ctx, agent)).toBe(true)
  })
})

describe('plan mode in agent presets', () => {
  /** Boot the loop with two presets that each mount their own plan-mode service, as the Web presets do. */
  async function presetHarness(adapter: MockAdapter): Promise<Context> {
    const ctx = new Context()
    ctx.baseUrl = import.meta.url
    await ctx.plugin(Loader)
    ctx.loader.builtins.planMode = PlanModeController
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(NativeToolRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(AgentPresets, { default: 'first' })
    for (const id of ['first', 'second']) {
      await ctx.plugin({ inject: ['agentPresets'], async* apply(owner: Context) {
        yield await owner.agentPresets.register({ id, plugins: [{ id: 'plan-mode', name: 'cordis:planMode', isolate: { planMode: true }, config: PLAN_CONFIG }] })
      } })
    }
    ctx.llm.registerAdapter(['mock'], adapter)
    return ctx
  }

  const create = (ctx: Context, id: string, preset: string, setup?: (agent: Agent) => void) => ctx.agents.create({
    sessionId: brandString<SessionId>(id),
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async (agentCtx, agent) => {
      await ctx.agentPresets.mount(agentCtx, preset)
      setup?.(agent)
    },
  })

  it('offers the exit tool after a blank Session switches to a preset another Session runs', async () => {
    const adapter = new MockAdapter([textResponse('Planning.')])
    const ctx = await presetHarness(adapter)
    // The second preset's plan-mode service is already running for another Session.
    const other = await create(ctx, 'it-preset-other', 'second')
    expect(ctx.tools.get('exit_plan_mode', other.agent)).toBeUndefined()
    const { agent } = await create(ctx, 'it-preset-blank', 'first')
    expect(ctx.agentPresets.serviceFor(agent, 'planMode')?.set(agent, true)).toBe('committed')
    expect(await ctx.agentPresets.select(agent, 'second')).toBe('second')

    const idle = waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'plan it' }], source: { kind: 'user' } }))
    await idle
    expect(adapter.requests[0]?.tools?.map(tool => tool.name)).toEqual(['exit_plan_mode'])
  })

  it('offers the exit tool when a preset selection is recorded while the Agent is created', async () => {
    const ctx = await presetHarness(new MockAdapter([]))
    const { agent } = await create(ctx, 'it-preset-recorded', 'second', (created) => {
      created.session.append('plan/mode', { active: true })
      created.session.append('agent-preset/selected', { agentPreset: 'second' })
    })
    expect(ctx.tools.get('exit_plan_mode', agent)).toBeDefined()
  })
})
