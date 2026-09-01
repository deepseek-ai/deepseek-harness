/**
 * The `goal` projection unit: mounting GoalService beside the registry
 * serves the current whole goal on the history tail page with a consistent
 * asOfSeq; before the first create the value is null; a clear tombstone
 * returns it to null; a composition without the goal service has no `goal`
 * key; unmounting drops it (HMR safety). The host state retains strict replay
 * failures without throwing from the registry drive, and GoalService rejects
 * access after such a failure.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import GoalService, { GoalId, applyGoalProjection, foldGoal, goalProjectionDefinition } from '@deepseek-ai/dsh-goal'
import type { GoalProjection, GoalProjectionState, GoalRef } from '@deepseek-ai/dsh-goal'

interface Bench {
  ctx: Context
  session: Session
  agent: Agent
  tailValues(): Record<string, unknown>
  tailAsOfSeq(): number
}

/** Register a minimal registry-compatible live agent over a store session. */
function liveAgent(ctx: Context, session: Session): Agent {
  const status: AgentStatus = 'idle'
  const inbox = new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} })
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox,
    ctx,
    get status() { return status },
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject(input: UserMessage) {
      inbox.append('next-step', input)
    },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  ctx.agents.register(agent)
  return agent
}

async function harness(withGoal: boolean): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  if (withGoal) await ctx.plugin(GoalService)
  const session = ctx.sessions.create()
  const agent = liveAgent(ctx, session)
  return {
    ctx,
    session,
    agent,
    tailValues: () => ctx.sessionProjections.snapshot(session).values,
    tailAsOfSeq: () => ctx.sessionProjections.snapshot(session).asOfSeq,
  }
}

/** One paginable message so the tail is non-degenerate. */
function seedMessage(session: Session): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

describe('goal projection unit', () => {
  it('serves null before the first create', async () => {
    const bench = await harness(true)
    seedMessage(bench.session)
    expect(bench.tailValues()).toEqual({ goal: null })
    expect(bench.tailAsOfSeq()).toBe(bench.session.seq - 1)
  })

  it('serves the whole current goal after create and tracks mutations last-wins', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    try {
      const bench = await harness(true)
      seedMessage(bench.session)
      const created = bench.ctx.goals.create(bench.agent, { objective: 'ship the goal bar' })
      const afterCreate = bench.tailValues().goal
      expect(afterCreate).toMatchObject({
        goal: { id: created.id, revision: 1, objective: 'ship the goal bar', phase: 'active' },
        roundsStarted: 0,
      })

      const ref: GoalRef = { id: created.id, revision: created.revision }
      const paused = bench.ctx.goals.pause(bench.agent, ref)
      expect(bench.tailValues().goal).toMatchObject({
        goal: { revision: paused.revision, phase: 'paused' },
      })
      expect(bench.tailAsOfSeq()).toBe(bench.session.seq - 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns to null after a clear tombstone', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_700_000_000_000)
    try {
      const bench = await harness(true)
      seedMessage(bench.session)
      const created = bench.ctx.goals.create(bench.agent, { objective: 'temporary' })
      expect(bench.tailValues().goal).not.toBeNull()
      bench.ctx.goals.clear(bench.agent, { id: created.id, revision: created.revision })
      expect(bench.tailValues().goal).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not let inbox changes revive a cleared goal', async () => {
    const bench = await harness(true)
    const created = bench.ctx.goals.create(bench.agent, { objective: 'stay cleared' })
    bench.ctx.goals.clear(bench.agent, created)

    bench.agent.inbox.prepend('next-step', createUserMessage({
      content: [{ type: 'text', text: 'unrelated pending context' }],
      source: { kind: 'plugin', plugin: 'test' },
    }))

    expect(bench.tailValues().goal).toBeNull()
    expect(foldGoal(bench.session.snapshotEvents()).goal).toBeUndefined()
  })

  it('retains strict replay failures without throwing from the projection drive', () => {
    const plainUser = createUserMessage({
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'user' },
    })
    const user = { type: 'user/message', seq: 0, time: 1, data: plainUser } as never
    const current: GoalProjection = {
      goal: { id: GoalId('g1'), revision: 1, objective: 'x', phase: 'active', maxGoalRounds: 4 },
      roundsStarted: 0,
      createdAt: 1,
      updatedAt: 1,
    }
    const state: GoalProjectionState = {
      current,
      seenGoalIds: [current.goal.id],
      failure: null,
    }
    expect(goalProjectionDefinition.stateSchema.parse(state)).toEqual(state)
    expect(goalProjectionDefinition.stateSchema.safeParse({ ...state, seenGoalIds: [] }).success).toBe(false)
    expect(goalProjectionDefinition.stateSchema.safeParse({
      ...state,
      current: { ...current, createdAt: 2, updatedAt: 1 },
    }).success).toBe(false)
    expect(goalProjectionDefinition.stateSchema.safeParse({
      ...state,
      current: { ...current, roundsStarted: current.goal.maxGoalRounds + 1 },
    }).success).toBe(false)
    const empty = goalProjectionDefinition.init()
    expect(goalProjectionDefinition.stateSchema.parse(empty)).toEqual(empty)
    expect(applyGoalProjection(empty, user)).toBe(empty)
    const admittedRound = {
      type: 'user/message', seq: 1, time: 2,
      data: createUserMessage({
        content: [{ type: 'text', text: 'continue' }],
        source: { kind: 'goal', goalId: 'g1', revision: 1, round: 1 } as never,
      }),
    } as never
    expect(applyGoalProjection(state, admittedRound)).toEqual({
      ...state,
      current: { ...current, roundsStarted: 1 },
    })
    const queuedUser = {
      type: 'agent/inbox/spliced', seq: 1, time: 2,
      data: { target: 'next-step', start: 0, inserted: [plainUser] },
    } as never
    expect(applyGoalProjection(state, queuedUser)).toBe(state)

    const malformed = {
      type: 'goal/change', seq: 1, time: 2,
      data: { kind: 'goal/change', version: 1, operation: 'create' },
    } as never
    expect(applyGoalProjection(state, malformed).failure).toMatch(/goal snapshot change must have exactly/)
    expect(applyGoalProjection(empty, malformed).failure).toMatch(/goal snapshot change must have exactly/)

    const queuedRound = {
      type: 'agent/inbox/spliced', seq: 3, time: 4,
      data: { target: 'next-step', start: 0, inserted: [createUserMessage({
        content: [{ type: 'text', text: 'later round' }],
        source: { kind: 'goal', goalId: 'g1', revision: 1, round: 1 } as never,
      })] },
    } as never
    expect(applyGoalProjection(state, queuedRound)).toBe(state)

    // A non-message event (the registry drives EVERY committed event through
    // apply): early same-reference return.
    const turnStart = { type: 'turn/start', seq: 3, time: 4, data: { turn: 1 } } as never
    expect(applyGoalProjection(state, turnStart)).toBe(state)

    // A declared goal/change record with a foreign payload kind is an owned-stream failure.
    const foreignKind = { type: 'goal/change', seq: 4, time: 5, data: { kind: 'not-a-goal-change' } } as never
    expect(applyGoalProjection(state, foreignKind).failure).toMatch(/invalid kind/)

    const missingTimestamps = {
      ...state,
      current: { ...current, createdAt: undefined, updatedAt: undefined },
    } as never
    expect(applyGoalProjection(missingTimestamps, admittedRound).failure)
      .toMatch(/current goal fold lacks timestamps/)
  })

  it('fails host goal access when the projection retained a replay failure', async () => {
    const bench = await harness(true)
    const failure = 'goal replay failed at session event 0: invalid restored goal stream'
    const state = bench.ctx.sessionProjections.stateOf(bench.session, 'goal')
    expect(state).toBeDefined()
    Object.assign(state!, { failure })

    expect(() => bench.ctx.goals.get(bench.agent)).toThrow(failure)
    expect(bench.tailValues().goal).toBeNull()
  })

  it('has no goal key when the goal service is not composed', async () => {
    const bench = await harness(false)
    seedMessage(bench.session)
    expect('goal' in (bench.tailValues() ?? {})).toBe(false)
  })

  it('drops the key when the goal fiber unloads (HMR safety)', async () => {
    const bench = await harness(false)
    seedMessage(bench.session)
    const fiber = await bench.ctx.plugin(GoalService)
    expect(bench.tailValues()).toEqual({ goal: null })
    await fiber.dispose()
    expect('goal' in (bench.tailValues() ?? {})).toBe(false)
  })
})
