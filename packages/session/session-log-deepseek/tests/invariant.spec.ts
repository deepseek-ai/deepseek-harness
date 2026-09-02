import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import InvariantRegistry, { InvariantError } from '@deepseek-ai/dsh-invariants'
import SessionStore, { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import * as SessionLogInvariant from '../src/invariant.ts'
import type {} from '../src/types.ts'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function setup(): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(SessionLogInvariant)
  return ctx
}

describe('DeepSeek session-log acceptance invariant', () => {
  it('accepts a watermark naming an earlier event in its containing Session', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('valid'))
    session.append('turn/start', { turn: 1 })
    expect(() => session.append('session-log-deepseek/delivery-accepted', { sessionId: session.id, throughSeq: SessionSeq(0) }))
      .not.toThrow()
  })

  it('rejects a live watermark for another Session or a non-earlier sequence', async () => {
    const ctx = await setup()
    const wrongId = ctx.sessions.create(SessionId('wrong-id'))
    wrongId.append('turn/start', { turn: 1 })
    expect(() => wrongId.append('session-log-deepseek/delivery-accepted', {
      sessionId: SessionId('other'),
      throughSeq: SessionSeq(0),
    })).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-session-log-deepseek',
    }))

    const wrongSeq = ctx.sessions.create(SessionId('wrong-seq'))
    wrongSeq.append('turn/start', { turn: 1 })
    expect(() => wrongSeq.append('session-log-deepseek/delivery-accepted', {
      sessionId: wrongSeq.id,
      throughSeq: SessionSeq(1),
    })).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-session-log-deepseek',
    }))
    expect(() => wrongSeq.append('session-log-deepseek/delivery-accepted', {
      sessionId: wrongSeq.id,
      throughSeq: -1 as never,
    })).toThrow(expect.objectContaining<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-session-log-deepseek',
    }))
  })

  it('validates existing history when the invariant loads after the Session', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const id = SessionId('late-invalid')
    ctx.sessions.create(id, { seed: [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      {
        type: 'session-log-deepseek/delivery-accepted',
        seq: SessionSeq(1),
        time: 2,
        data: { sessionId: id, throughSeq: SessionSeq(1) },
      },
    ] })

    let failure: unknown
    try {
      await ctx.plugin(SessionLogInvariant)
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject<Partial<InvariantError>>({
      code: 'INVARIANT',
      packageName: '@deepseek-ai/dsh-session-log-deepseek',
    })
  })

  it('allows an inherited parent watermark inside a fork seed', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const parentId = SessionId('fork-parent')
    const childId = SessionId('fork-child')
    ctx.sessions.create(childId, {
      seed: [
        { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
        {
          type: 'session-log-deepseek/delivery-accepted',
          seq: SessionSeq(1),
          time: 2,
          data: { sessionId: parentId, throughSeq: SessionSeq(0) },
        },
      ],
      inheritedEventCount: SessionLogOffset(2),
      meta: { parentSession: parentId, isSeeded: true },
    })

    await expect(ctx.plugin(SessionLogInvariant)).resolves.toBeDefined()
  })
})
