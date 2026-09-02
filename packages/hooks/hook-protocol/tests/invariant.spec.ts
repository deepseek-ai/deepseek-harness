import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import * as HookInvariant from '@deepseek-ai/dsh-hook-protocol/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(HookInvariant)
  return ctx
}

const invoked = (overrides: Record<string, unknown> = {}) => ({
  turn: 1,
  point: 'PreToolUse',
  dialect: 'claude-code' as const,
  handlerId: 'hook-1',
  ...overrides,
})

const result = (overrides: Record<string, unknown> = {}) => ({
  turn: 1,
  point: 'PreToolUse',
  handlerId: 'hook-1',
  decision: 'pass',
  durationMs: 3,
  ...overrides,
})

function startTurn(session: Session, turn = 1): void {
  session.append('turn/start', { turn })
}

describe('hook-protocol invariants', () => {
  it('pairs serial and repeated handler invocations', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    startTurn(session)
    session.append('hook/invoked', invoked())
    session.append('hook/invoked', invoked())
    session.append('step/start', { turn: 1, step: 1 })
    session.append('hook/result', result())
    session.append('hook/result', result())
  })

  it('rebuilds pending hook invocations from an existing session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('hook/invoked', invoked())
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(HookInvariant)
    expect(() => session.append('hook/result', result())).not.toThrow()
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  })

  it('adopts a bare session first observed through publication', async () => {
    const ctx = await setup()
    const session = Session.create(SessionId('bare-hook-session'))
    expect(() => {
      ctx.emit('session/event', session, {
        type: 'turn/start', seq: SessionSeq(0), time: 0,
        data: { turn: 1 },
      })
      ctx.emit('session/event', session, {
        type: 'hook/invoked', seq: SessionSeq(1), time: 1, data: invoked(),
      })
      ctx.emit('session/event', session, {
        type: 'hook/result', seq: SessionSeq(2), time: 2, data: result(),
      })
    }).not.toThrow()
  })

  it('rejects hook events outside or for a different open turn', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    expect(() => session.append('hook/invoked', invoked())).toThrow(/outside any open turn/)
    startTurn(session)
    expect(() => session.append('hook/invoked', invoked({ turn: 2 }))).toThrow(/but open turn is 1/)
  })

  it('rejects an unenclosed hook event when replaying an existing session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    startTurn(session)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('hook/invoked', invoked())
    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(HookInvariant).then(() => undefined)).rejects.toThrow(/outside any open turn/)
  })

  it.each([
    [invoked({ point: '' }), /point and handlerId must be non-empty/],
    [invoked({ handlerId: '' }), /point and handlerId must be non-empty/],
    [invoked({ dialect: 'other' }), /unknown dialect/],
  ])('rejects malformed hook invocation %#', async (data, message) => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    startTurn(session)
    expect(() => session.append('hook/invoked', data as never)).toThrow(message)
  })

  it('rejects unmatched and malformed results', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    startTurn(session)
    expect(() => session.append('hook/result', result())).toThrow(/no matching hook\/invoked/)
    session.append('hook/invoked', invoked())
    expect(() => session.append('hook/result', result({ durationMs: -1 })))
      .toThrow(/durationMs must be a non-negative finite number/)
    expect(() => session.append('hook/result', result({ point: 'Stop' })))
      .toThrow(/no matching hook\/invoked/)
  })
})
