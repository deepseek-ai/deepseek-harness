import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus, Inbox } from '@deepseek-ai/dsh-agent'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import GoalService, { GoalId } from '@deepseek-ai/dsh-goal'
import type { GoalRef } from '@deepseek-ai/dsh-goal'
import { createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import SessionStore, {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  SessionLogOffset,
} from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as toolGoal from '@deepseek-ai/dsh-tool-goal'
import { createInboxStub } from '@deepseek-ai/dsh-agent-loop-testkit'

const testToolSignal = new AbortController().signal

interface StubAgent {
  readonly agent: Agent
  readonly session: Session
  readonly inbox: Inbox
  setStatus(status: AgentStatus): void
}

const isolatedInboxCtx = new Context()
await isolatedInboxCtx.plugin(SessionStore)
await isolatedInboxCtx.plugin(SessionProjectionRegistry)
await isolatedInboxCtx.plugin(AgentRegistry)

/** Build one registry-compatible live agent whose injections enter its test Inbox. */
function stubAgent(rawId: string, supplied?: Session, suppliedCtx?: Context): StubAgent {
  const agentCtx = suppliedCtx ?? isolatedInboxCtx
  const session = supplied ?? (suppliedCtx === undefined
    ? agentCtx.sessions.create(SessionId(rawId))
    : suppliedCtx.sessions.create(SessionId(rawId)))
  if (suppliedCtx === undefined) {
    if (agentCtx.sessions.get(session.id) !== session) agentCtx.sessions.enter(session)
  }
  const inbox = createInboxStub()
  let status: AgentStatus = 'running'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    get status() { return status },
    ctx: agentCtx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject(input) {
      this.inbox.append('next-step', input)
    },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session, inbox, setStatus(value) { status = value } }
}

/** Open one message-triggered turn with its accepted model-visible input. */
function openTurn(stub: StubAgent, source: MessageSource, text = 'prompt'): number {
  const turn = stub.session.snapshotEvents()
    .filter(event => event.type === 'turn/start')
    .reduce((max, event) => Math.max(max, event.data.turn), 0) + 1
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source,
  })
  stub.agent.inbox.append('next-turn', message)
  const claimed = stub.inbox.splice('next-turn', 0, 1, [])
  if (claimed.length === 0) throw new Error('expected queued turn input')
  stub.session.append('turn/start', { turn })
  for (const admitted of claimed) {
    stub.session.append('user/message', admitted, { surfaceOp: 'append' })
  }
  return turn
}

/** Close the currently open test turn. */
function closeTurn(stub: StubAgent, turn: number): void {
  stub.session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

async function harness(config: toolGoal.Config = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  await ctx.plugin(GoalService)
  const fiber = await ctx.plugin(toolGoal, config)
  const root = stubAgent(`goal-tool-root-${Math.random()}`, undefined, ctx)
  ctx.agents.register(root.agent)
  return { ctx, fiber, root }
}

/** Execute one registered tool under an optional driver initiator. */
async function execute(
  ctx: Context,
  name: string,
  args: unknown,
  agent?: Agent,
  initiator: Agent | undefined = agent,
): Promise<ToolExecutionResult> {
  const run = () => ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${Math.random()}`),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
  return initiator === undefined ? run() : ctx.agents.withInitiator(initiator, run)
}

/** Parse the compact JSON returned by a successful goal tool. */
function resultJson(result: ToolExecutionResult): Record<string, unknown> {
  expect(result.isError).toBe(false)
  if (result.isError) throw new Error('expected goal tool success')
  const block = result.content[0]
  if (block?.type !== 'text') throw new Error('expected text tool result')
  const parsed = JSON.parse(block.text) as Record<string, unknown>
  expect(result.value).toEqual(parsed)
  return parsed
}

/** Read the returned goal sub-object. */
function resultGoal(result: ToolExecutionResult): Record<string, unknown> {
  const goal = resultJson(result)['goal']
  if (typeof goal !== 'object' || goal === null) throw new Error('expected returned goal')
  return goal as Record<string, unknown>
}

describe('goal tool registration and presentation', () => {
  it('registers three exclusive tools plus configured guidance and disposes all contributions', async () => {
    const { ctx, fiber } = await harness({ blockedAfterConsecutiveRounds: 5 })
    expect(['create_goal', 'get_goal', 'update_goal'].map(name => ctx.tools.get(name)?.name))
      .toEqual(['create_goal', 'get_goal', 'update_goal'])
    for (const name of ['create_goal', 'get_goal', 'update_goal']) {
      expect(ctx.tools.executionMode({ signal: testToolSignal, callId: ToolCallId(name), name, arguments: {} }))
        .toEqual({ kind: 'exclusive' })
    }
    const section = (await ctx.systemPrompt.assemble()).sections.find(item => item.name === 'tool:goal')
    expect(section?.text).toContain('infer goal intent')
    expect(section?.text).toContain('at least 5 consecutive goal rounds')

    await fiber.dispose()
    expect(ctx.tools.get('get_goal')).toBeUndefined()
    expect((await ctx.systemPrompt.assemble()).sections.some(item => item.name === 'tool:goal')).toBe(false)
  })

  it('uses args-only generic render intent and soft-fails malformed replay args', async () => {
    const { ctx } = await harness()
    expect(ctx.tools.get('get_goal')?.presentCall?.({})).toEqual({
      card: 'generic', title: 'Read current goal', kind: 'read',
    })
    expect(ctx.tools.get('create_goal')?.presentCall?.({ objective: 'ship' })).toEqual({
      card: 'generic', title: 'Create goal', kind: 'other', rawInput: 'ship',
    })
    expect(ctx.tools.get('update_goal')?.presentCall?.({
      goal_id: 'goal-1', revision: 2, action: 'blocked', blocked_reason: 'Waiting for a human choice.',
    })).toEqual({ card: 'generic', title: 'Mark goal', kind: 'other', rawInput: 'Waiting for a human choice.' })
    expect(ctx.tools.get('update_goal')?.presentCall?.({
      goal_id: 'goal-1', revision: 2, action: 'edit',
      objective: 'ship', max_goal_rounds: 0, blocked_reason: '',
    })).toEqual({ card: 'generic', title: 'Edit goal', kind: 'other', rawInput: 'ship' })
    expect(ctx.tools.get('update_goal')?.presentCall?.({
      goal_id: 'goal-1', revision: 2, action: 'edit',
      objective: '', max_goal_rounds: 8, blocked_reason: '',
    })).toEqual({ card: 'generic', title: 'Edit goal', kind: 'other', rawInput: 8 })
    expect(ctx.tools.get('update_goal')?.presentCall?.({
      goal_id: 'goal-1', revision: 2, action: 'resume',
      objective: '', max_goal_rounds: 0, blocked_reason: '',
    })).toEqual({ card: 'generic', title: 'Resume goal', kind: 'other', rawInput: 'goal-1' })
    expect(ctx.tools.get('update_goal')?.presentCall?.({ wrong: true })).toBeUndefined()
  })

  it('has the Loader-safe namespace export shape', () => {
    expect('default' in toolGoal).toBe(false)
    expect(toolGoal.name).toBe('tool-goal')
    expect(toolGoal.inject).toEqual(['agents', 'goals', 'tools', 'systemPrompt', 'sessionProjections'])
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(toolGoal)).toBe(toolGoal)
  })

  it('fails invalid direct config before registering anything', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(GoalService)
    expect(() => {
      toolGoal.apply(ctx, { blockedAfterConsecutiveRounds: 1.5 })
    }).toThrow(
      'blockedAfterConsecutiveRounds must be a positive safe integer',
    )
    expect(ctx.tools.get('get_goal')).toBeUndefined()
  })

  it('resolves the direct-apply default before registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(GoalService)
    toolGoal.apply(ctx, {})
    const section = (await ctx.systemPrompt.assemble()).sections.find(item => item.name === 'tool:goal')
    expect(section?.text).toContain('at least 3 consecutive goal rounds')
  })
})

describe('goal tool execution authority', () => {
  it('lets a root model infer create intent from its accepted human turn', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' }, '请持续工作直到这个功能完成')
    const result = await execute(ctx, 'create_goal', {
      objective: 'Finish the feature', max_goal_rounds: 9,
    }, root.agent)
    expect(resultGoal(result)).toMatchObject({
      objective: 'Finish the feature', revision: 1, phase: 'active', maxGoalRounds: 9,
    })
    expect(resultJson(result)['activation']).toBe('armed')
    expect(ctx.goals.get(root.agent)?.objective).toBe('Finish the feature')
  })

  it('rejects agentless, driverless, non-human, and live-child creation', async () => {
    const { ctx, root } = await harness()
    const agentless = await execute(ctx, 'get_goal', {})
    expect(agentless.error?.info?.code).toBe('GOAL_TOOL_AGENT_REQUIRED')

    openTurn(root, { kind: 'user' })
    const driverless = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('call-driverless'),
      name: 'get_goal',
      arguments: {},
      agent: root.agent,
    })
    expect(driverless.error?.info?.code).toBe('GOAL_TOOL_DRIVER_REQUIRED')
    closeTurn(root, 1)

    openTurn(root, { kind: 'plugin', plugin: 'test' })
    const nonHuman = await execute(ctx, 'create_goal', { objective: 'forged' }, root.agent)
    expect(nonHuman.error?.info?.code).toBe('GOAL_TOOL_AUTHORITY_REQUIRED')
    closeTurn(root, 2)

    const child = stubAgent('goal-tool-child')
    ctx.agents.enter(child.agent, root.agent)
    ctx.agents.announce(child.agent)
    openTurn(child, { kind: 'user' })
    const childResult = await execute(ctx, 'create_goal', { objective: 'child goal' }, child.agent)
    expect(childResult.error?.info?.code).toBe('GOAL_TOOL_AUTHORITY_REQUIRED')
  })

  it('rejects stale agent objects and agents outside running status through the executor', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' })
    // A distinct agent object over root's exact session: same id, not the live
    // registered instance, so the executor must reject it.
    const stale = stubAgent('goal-tool-stale', root.agent.session, ctx).agent
    const staleResult = await execute(ctx, 'get_goal', {}, stale, stale)
    expect(staleResult.error?.info?.code).toBe('GOAL_TOOL_DRIVER_REQUIRED')

    root.setStatus('idle')
    const idleResult = await execute(ctx, 'get_goal', {}, root.agent)
    expect(idleResult.error?.info?.code).toBe('GOAL_TOOL_DRIVER_REQUIRED')
  })

  it('treats a fork resumed as a runtime root as direct-human authority', async () => {
    const { ctx, root } = await harness()
    const originalTurn = openTurn(root, { kind: 'user' })
    const created = ctx.goals.create(root.agent, { objective: 'resume the fork' })
    closeTurn(root, originalTurn)
    const forkId = SessionId('goal-tool-resumed-fork')
    const forkSession = Session.create(forkId, root.session.snapshotEvents(), {
      version: SESSION_FORMAT_VERSION,
      id: forkId,
      createdAt: Date.now(),
      parentSession: root.session.id,
      isSeeded: true,
    }, SessionLogOffset(root.session.seq))
    const fork = stubAgent(forkId, forkSession)
    ctx.agents.register(fork.agent)
    expect(ctx.goals.get(fork.agent)).toMatchObject({ id: created.id, activation: 'disarmed' })

    openTurn(fork, { kind: 'user' }, '继续这个目标')
    const resumed = await execute(ctx, 'update_goal', {
      goal_id: created.id, revision: created.revision, action: 'resume',
    }, fork.agent)
    expect(resultGoal(resumed)).toMatchObject({ id: created.id, revision: 2, phase: 'active' })
  })

  it('rejects calls before a turn and after its end boundary', async () => {
    const { ctx, root } = await harness()
    const before = await execute(ctx, 'get_goal', {}, root.agent)
    expect(before.error?.info?.code).toBe('GOAL_TOOL_DRIVER_REQUIRED')

    const turn = openTurn(root, { kind: 'user' })
    closeTurn(root, turn)
    const after = await execute(ctx, 'get_goal', {}, root.agent)
    expect(after.error?.info?.code).toBe('GOAL_TOOL_DRIVER_REQUIRED')
  })

  it('rejects terminal reporting without human input or a current goal round', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'plugin', plugin: 'test' })
    const result = await execute(ctx, 'update_goal', {
      goal_id: 'goal-missing', revision: 1, action: 'complete',
    }, root.agent)
    expect(result.error?.info?.code).toBe('GOAL_TOOL_AUTHORITY_REQUIRED')
    const malformed = await execute(ctx, 'update_goal', {
      goal_id: 'goal-missing', revision: 1, action: 'pause', objective: 'probe',
    }, root.agent)
    expect(malformed.error?.info?.code).toBe('GOAL_TOOL_AUTHORITY_REQUIRED')
  })

  it('accepts direct human steering in a goal-sourced root turn', async () => {
    const { ctx, root } = await harness()
    const humanTurn = openTurn(root, { kind: 'user' })
    const created = ctx.goals.create(root.agent, { objective: 'steer me' })
    closeTurn(root, humanTurn)
    openTurn(root, {
      kind: 'goal', goalId: created.id, revision: created.revision, round: 1,
    })
    root.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'pause now' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const paused = await execute(ctx, 'update_goal', {
      goal_id: created.id, revision: created.revision, action: 'pause',
    }, root.agent)
    expect(resultGoal(paused)).toMatchObject({ phase: 'paused', revision: 2 })
  })

  it('rejects an initiator different from exec.agent', async () => {
    const { ctx, root } = await harness()
    const other = stubAgent('goal-tool-other')
    ctx.agents.register(other.agent)
    openTurn(other, { kind: 'user' })
    const result = await execute(ctx, 'get_goal', {}, other.agent, root.agent)
    expect(result.error?.info?.code).toBe('GOAL_TOOL_DRIVER_REQUIRED')
  })
})

describe('goal tool state transitions', () => {
  it('reads null, then edits, pauses, and resumes by exact revision in one human turn', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' })
    expect(resultJson(await execute(ctx, 'get_goal', {}, root.agent))).toEqual({ goal: null })
    let goal = resultGoal(await execute(ctx, 'create_goal', { objective: 'old' }, root.agent))
    goal = resultGoal(await execute(ctx, 'update_goal', {
      goal_id: goal['id'], revision: goal['revision'], action: 'edit',
      objective: 'new', max_goal_rounds: 8,
    }, root.agent))
    expect(goal).toMatchObject({ objective: 'new', revision: 2, maxGoalRounds: 8 })
    goal = resultGoal(await execute(ctx, 'update_goal', {
      goal_id: goal['id'], revision: goal['revision'], action: 'pause',
    }, root.agent))
    expect(goal).toMatchObject({ phase: 'paused', revision: 3 })
    goal = resultGoal(await execute(ctx, 'update_goal', {
      goal_id: goal['id'], revision: goal['revision'], action: 'resume',
    }, root.agent))
    expect(goal).toMatchObject({ phase: 'active', revision: 4 })
  })

  it('injects one wrap-up instruction for an autonomous completion but leaves a human pause interactive', async () => {
    const { ctx, root } = await harness()
    const humanTurn = openTurn(root, { kind: 'user' })
    const created = ctx.goals.create(root.agent, { objective: 'pause cleanly' })
    const paused = await execute(ctx, 'update_goal', {
      goal_id: created.id, revision: created.revision, action: 'pause',
    }, root.agent)
    expect(resultGoal(paused)).toMatchObject({ phase: 'paused' })
    expect(paused.concludesTurn).toBeUndefined()
    expect(paused.additionalContexts).toBeUndefined()
    const resumed = resultGoal(await execute(ctx, 'update_goal', {
      goal_id: created.id, revision: 2, action: 'resume',
    }, root.agent))
    closeTurn(root, humanTurn)

    openTurn(root, {
      kind: 'goal', goalId: created.id, revision: resumed['revision'] as number, round: 1,
    })
    const complete = await execute(ctx, 'update_goal', {
      goal_id: created.id, revision: resumed['revision'], action: 'complete',
    }, root.agent)
    expect(resultGoal(complete)).toMatchObject({ phase: 'complete' })
    expect(complete.concludesTurn).toBeUndefined()
    const contexts = complete.additionalContexts ?? []
    expect(contexts).toHaveLength(1)
    expect(contexts[0]?.source).toEqual({
      kind: 'plugin',
      plugin: 'tool-goal',
      form: 'notice',
      summary: 'complete: pause cleanly',
    })
    const block = contexts[0]?.content[0]
    if (block?.type !== 'text') throw new Error('expected one text wrap-up block')
    expect(block.text).toContain('<goal_complete>')
    expect(block.text).toContain('"pause cleanly"')
    expect(block.text).toContain("Do not call any more tools in this run; further work waits for the user's next instruction.")
  })

  it('completes without a wrap-up instruction under direct human authority', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' })
    const created = ctx.goals.create(root.agent, { objective: 'finish now' })
    const complete = await execute(ctx, 'update_goal', {
      goal_id: created.id, revision: created.revision, action: 'complete',
    }, root.agent)
    expect(resultGoal(complete)).toMatchObject({ phase: 'complete' })
    expect(complete.concludesTurn).toBeUndefined()
    expect(complete.additionalContexts).toBeUndefined()
  })

  it('rearms a restored active goal only after a new direct human prompt', async () => {
    const { ctx, root } = await harness()
    let turn = openTurn(root, { kind: 'user' })
    const created = ctx.goals.create(root.agent, { objective: 'continue later' })
    closeTurn(root, turn)
    agentEvents(ctx, root.agent).emit('agent/session-start', { source: 'resume' })
    expect(ctx.goals.get(root.agent)?.activation).toBe('disarmed')
    turn = openTurn(root, { kind: 'user' }, '继续')
    const resumed = await execute(ctx, 'update_goal', {
      goal_id: created.id, revision: created.revision, action: 'resume',
    }, root.agent)
    expect(resultGoal(resumed)).toMatchObject({ phase: 'active', revision: 2 })
    expect(resultJson(resumed)['activation']).toBe('armed')
    closeTurn(root, turn)
  })

  it('returns structured domain and conditional-argument failures', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' })
    const invalidCreate = await execute(ctx, 'create_goal', { objective: ' ' }, root.agent)
    expect(invalidCreate.error?.info?.code).toBe('GOAL_INVALID_OBJECTIVE')
    const created = ctx.goals.create(root.agent, { objective: 'valid' })
    const replacement = await execute(ctx, 'update_goal', {
      goal_id: created.id,
      revision: created.revision,
      action: 'pause',
      objective: 'not valid for pause',
    }, root.agent)
    expect(replacement.error?.info?.code).toBe('GOAL_TOOL_INVALID_UPDATE')
    const terminalUpdate = await execute(ctx, 'update_goal', {
      goal_id: created.id,
      revision: created.revision,
      action: 'complete',
      max_goal_rounds: 2,
    }, root.agent)
    expect(terminalUpdate.error?.info?.code).toBe('GOAL_TOOL_INVALID_UPDATE')
    const blockedWithoutReason = await execute(ctx, 'update_goal', {
      goal_id: created.id, revision: created.revision, action: 'blocked',
    }, root.agent)
    expect(blockedWithoutReason.error?.info?.code).toBe('GOAL_TOOL_INVALID_UPDATE')
    const blockedWithEmptyReason = await execute(ctx, 'update_goal', {
      goal_id: created.id, revision: created.revision, action: 'blocked', blocked_reason: ' ',
    }, root.agent)
    expect(blockedWithEmptyReason.error?.info?.code).toBe('GOAL_TOOL_INVALID_UPDATE')
    const completeWithReason = await execute(ctx, 'update_goal', {
      goal_id: created.id, revision: created.revision, action: 'complete', blocked_reason: 'Not a blocker.',
    }, root.agent)
    expect(completeWithReason.error?.info?.code).toBe('GOAL_TOOL_INVALID_UPDATE')
    const editWithReason = await execute(ctx, 'update_goal', {
      goal_id: created.id,
      revision: created.revision,
      action: 'edit',
      objective: 'still valid',
      blocked_reason: 'Not valid for edit.',
    }, root.agent)
    expect(editWithReason.error?.info?.code).toBe('GOAL_TOOL_INVALID_UPDATE')
    const malformedRef = await execute(ctx, 'update_goal', {
      goal_id: '', revision: 0, action: 'edit', objective: 'x',
    }, root.agent)
    expect(malformedRef.error?.info?.code).toBe('GOAL_TOOL_INVALID_UPDATE')
  })

  it('accepts only empty fillers in fields unused by the selected action', async () => {
    const { ctx, root } = await harness()
    openTurn(root, { kind: 'user' })
    let goal = ctx.goals.create(root.agent, { objective: 'valid' })

    const edited = await execute(ctx, 'update_goal', {
      goal_id: goal.id,
      revision: goal.revision,
      action: 'edit',
      objective: 'edited',
      max_goal_rounds: 0,
      blocked_reason: '',
    }, root.agent)
    expect(resultGoal(edited)).toMatchObject({ objective: 'edited' })
    goal = ctx.goals.get(root.agent)!

    const capped = await execute(ctx, 'update_goal', {
      goal_id: goal.id,
      revision: goal.revision,
      action: 'edit',
      objective: '',
      max_goal_rounds: 8,
      blocked_reason: '',
    }, root.agent)
    expect(resultGoal(capped)).toMatchObject({ objective: 'edited', maxGoalRounds: 8 })
    goal = ctx.goals.get(root.agent)!

    const paused = await execute(ctx, 'update_goal', {
      goal_id: goal.id,
      revision: goal.revision,
      action: 'pause',
      objective: '',
      max_goal_rounds: 0,
      blocked_reason: '',
    }, root.agent)
    expect(resultGoal(paused)).toMatchObject({ phase: 'paused', objective: 'edited' })
    goal = ctx.goals.get(root.agent)!

    const resumed = await execute(ctx, 'update_goal', {
      goal_id: goal.id,
      revision: goal.revision,
      action: 'resume',
      objective: '',
      max_goal_rounds: 0,
      blocked_reason: '',
    }, root.agent)
    expect(resultGoal(resumed)).toMatchObject({ phase: 'active', objective: 'edited' })
    goal = ctx.goals.get(root.agent)!

    const blocked = await execute(ctx, 'update_goal', {
      goal_id: goal.id,
      revision: goal.revision,
      action: 'blocked',
      objective: '',
      max_goal_rounds: 0,
      blocked_reason: 'actual blocker',
    }, root.agent)
    expect(resultGoal(blocked)).toMatchObject({ phase: 'blocked' })
    goal = ctx.goals.resume(root.agent, { id: goal.id, revision: goal.revision + 1 })

    const complete = await execute(ctx, 'update_goal', {
      goal_id: goal.id,
      revision: goal.revision,
      action: 'complete',
      objective: '',
      max_goal_rounds: 0,
      blocked_reason: '',
    }, root.agent)
    expect(resultGoal(complete)).toMatchObject({ phase: 'complete', objective: 'edited' })
  })

  it('allows exact goal rounds to complete but not edit or pause', async () => {
    const { ctx, root } = await harness()
    const humanTurn = openTurn(root, { kind: 'user' })
    const created = ctx.goals.create(root.agent, { objective: 'round-owned' })
    closeTurn(root, humanTurn)
    openTurn(root, { kind: 'goal', goalId: created.id, revision: created.revision, round: 1 })
    const edit = await execute(ctx, 'update_goal', {
      goal_id: created.id, revision: created.revision, action: 'edit', objective: 'forbidden',
    }, root.agent)
    expect(edit.error?.info?.code).toBe('GOAL_TOOL_AUTHORITY_REQUIRED')
    const complete = await execute(ctx, 'update_goal', {
      goal_id: created.id, revision: created.revision, action: 'complete',
    }, root.agent)
    expect(resultGoal(complete)).toMatchObject({ phase: 'complete', revision: 2, roundsStarted: 1 })
  })

  it('enforces the configured model self-block lower bound across admitted rounds', async () => {
    const { ctx, root } = await harness({ blockedAfterConsecutiveRounds: 3 })
    let turn = openTurn(root, { kind: 'user' })
    const created = ctx.goals.create(root.agent, { objective: 'blocked eventually' })
    closeTurn(root, turn)
    const ref: GoalRef = { id: GoalId(created.id), revision: created.revision }

    for (let round = 1; round <= 2; round += 1) {
      turn = openTurn(root, { kind: 'goal', goalId: ref.id, revision: ref.revision, round })
      const result = await execute(ctx, 'update_goal', {
        goal_id: ref.id,
        revision: ref.revision,
        action: 'blocked',
        blocked_reason: 'The required credential is still unavailable.',
      }, root.agent)
      expect(result.error?.info?.code).toBe('GOAL_TOOL_BLOCK_THRESHOLD')
      closeTurn(root, turn)
    }
    openTurn(root, { kind: 'goal', goalId: ref.id, revision: ref.revision, round: 3 })
    const blocked = await execute(ctx, 'update_goal', {
      goal_id: ref.id,
      revision: ref.revision,
      action: 'blocked',
      blocked_reason: 'The required credential is still unavailable.',
    }, root.agent)
    expect(resultGoal(blocked)).toMatchObject({
      phase: 'blocked',
      blockedReason: { code: 'model-reported', message: 'The required credential is still unavailable.' },
      roundsStarted: 3,
    })
    expect(blocked.concludesTurn).toBeUndefined()
    const contexts = blocked.additionalContexts ?? []
    expect(contexts).toHaveLength(1)
    const block = contexts[0]?.content[0]
    if (block?.type !== 'text') throw new Error('expected one text wrap-up block')
    expect(block.text).toContain('<goal_blocked>')
    expect(block.text).toContain('The required credential is still unavailable.')
    expect(block.text).toContain("Do not call any more tools in this run; further work waits for the user's next instruction.")
  })

  it('lets direct human authority block before the model threshold', async () => {
    const { ctx, root } = await harness({ blockedAfterConsecutiveRounds: 9 })
    openTurn(root, { kind: 'user' })
    const created = ctx.goals.create(root.agent, { objective: 'human stop' })
    const blocked = await execute(ctx, 'update_goal', {
      goal_id: created.id,
      revision: created.revision,
      action: 'blocked',
      blocked_reason: 'The user asked to stop until a prerequisite is available.',
    }, root.agent)
    expect(resultGoal(blocked)).toMatchObject({
      phase: 'blocked',
      blockedReason: {
        code: 'model-reported',
        message: 'The user asked to stop until a prerequisite is available.',
      },
      roundsStarted: 0,
    })
    expect(blocked.concludesTurn).toBeUndefined()
    expect(blocked.additionalContexts).toBeUndefined()
  })
})
