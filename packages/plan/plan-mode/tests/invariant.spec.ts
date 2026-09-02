import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as PlanModeInvariant from '@deepseek-ai/dsh-plan-mode/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(PlanModeInvariant)
  return ctx
}

function event(active: unknown): SessionEvent {
  return { type: 'plan/mode', seq: SessionSeq(0), time: 0, data: { active } } as SessionEvent
}

function emitTurnStart(ctx: Context, session: Session): void {
  ctx.emit('session/event', session, {
    type: 'turn/start', seq: SessionSeq(0), time: 0,
    data: { turn: 1 },
  })
}

describe('plan-mode stream invariants', () => {
  it('accepts either boolean state', async () => {
    const ctx = await setup()
    const session = Session.create(SessionId('plan-state'))
    emitTurnStart(ctx, session)
    expect(() => { ctx.emit('session/event', session, event(true)) }).not.toThrow()
    expect(() => { ctx.emit('session/event', session, event(false)) }).not.toThrow()
    ctx.emit('session/event', session, {
      type: 'turn/end', seq: SessionSeq(3), time: 3, data: { turn: 1, reason: { kind: 'completed' } },
    })
  })

  it.each([42, 'plan', undefined])('rejects invalid durable plan state %j', async (active) => {
    const ctx = await setup()
    const session = Session.create(SessionId(`invalid-${String(active)}`))
    emitTurnStart(ctx, session)
    expect(() => { ctx.emit('session/event', session, event(active)) })
      .toThrow(/expected a boolean/)
  })

  it('accepts standalone plan state between turns (the idle immediate commit)', async () => {
    const ctx = await setup()
    expect(() => ctx.sessions.create().append('plan/mode', { active: true }))
      .not.toThrow()
  })

  it('ignores unrelated dispatches and session events', async () => {
    const ctx = await setup()
    const session = Session.create(SessionId('unrelated'))
    expect(() => {
      ctx.emit('tools/change')
      ctx.emit('session/event', session, {
        type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 },
      })
    }).not.toThrow()
  })

  it('rejects invalid existing state on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('plan/mode', { active: 'plan' as unknown as boolean })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(PlanModeInvariant).then(() => undefined)).rejects.toThrow(/expected a boolean/)
  })

  it('replays enclosed existing plan state through its closing boundary', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('plan/mode', { active: true })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(PlanModeInvariant).then(() => undefined)).resolves.toBeUndefined()
  })

  it('accepts standalone existing plan state on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create().append('plan/mode', { active: true })
    await ctx.plugin(InvariantRegistry, { enabled: true })

    await expect(ctx.plugin(PlanModeInvariant).then(() => undefined)).resolves.toBeUndefined()
  })
})
