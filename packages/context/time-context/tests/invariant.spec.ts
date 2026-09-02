import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as TimeInvariant from '@deepseek-ai/dsh-time-context/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

const SECOND = Date.parse('2026-07-14T00:00:00Z')

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(TimeInvariant)
  return ctx
}

function event(
  text: string,
  time = SECOND + 456,
  content?: unknown[],
  plugin = 'time-context',
): SessionEvent<'user/message'> {
  return {
    type: 'user/message',
    seq: SessionSeq(0),
    time,
    data: createUserMessage({
      content: (content ?? [{ type: 'text', text }]) as ContentBlock[],
      source: plugin === 'time-context'
        ? {
          kind: 'plugin',
          plugin,
          form: 'snapshot',
          sections: [{ name: plugin, text }],
        }
        : { kind: 'plugin', plugin },
    }),
  }
}

function reading(
  turn = '1',
  step = '1',
  baseline = 'model-visible message',
  timestamp = '2026-07-14T00:00:00+00:00[UTC]',
  browser = 'Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.',
): string {
  return `Time sampled while preparing turn ${turn}, step ${step}: ${timestamp}\n`
    + `${browser}\n`
    + `Elapsed since the preceding ${baseline}: unavailable.`
}

function preparing(turn: number, step: number, clientTimeZone?: string): Session {
  const session = Session.create(SessionId(`time-invariant-${turn}-${step}`))
  for (let priorTurn = 1; priorTurn < turn; priorTurn += 1) {
    session.append('turn/start', { turn: priorTurn })
    session.append('turn/end', { turn: priorTurn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `turn ${turn}` }],
    source: clientTimeZone === undefined
      ? { kind: 'user' }
      : { kind: 'user', rpcId: `turn-${String(turn)}`, clientTimeZone } as never,
  }), { surfaceOp: 'append' })
  for (let priorStep = 1; priorStep < step; priorStep += 1) {
    session.append('step/start', { turn, step: priorStep })
    session.append('step/end', { turn, step: priorStep })
  }
  session.append('step/start', { turn, step })
  return session
}

function appendReading(session: Session, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: {
      kind: 'plugin',
      plugin: 'time-context',
      form: 'snapshot',
      sections: [{ name: 'time-context', text }],
    },
  }), { surfaceOp: 'append' })
}

describe('time-context invariants', () => {
  it('accepts a reading whose turn, step, baseline, and timestamp agree', async () => {
    const ctx = await setup()
    const text = 'Time sampled while preparing turn 2, step 3: 2026-07-14T00:00:00+00:00[UTC]\n'
      + 'Browser time zone for this request: unavailable. Ask the user to clarify otherwise-unqualified dates and times.\n'
      + 'Elapsed since the preceding step context: 4m 2s.'
    expect(() => { ctx.emit('session/event', preparing(2, 3), event(text)) }).not.toThrow()
  })

  it('accepts a reading durably appended after a long process pause', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('session/event', preparing(1, 1), event(reading(), SECOND + 60_000))
    }).not.toThrow()
  })

  it('requires browser-zone policy and timestamp to match current-turn request provenance', async () => {
    const ctx = await setup()
    const policy = 'Browser time zone for this request: Asia/Shanghai. '
      + 'Interpret otherwise-unqualified dates and times in this zone.'
    expect(() => {
      ctx.emit('session/event', preparing(1, 1, 'Asia/Shanghai'), event(reading(
        '1',
        '1',
        'model-visible message',
        '2026-07-14T08:00:00+08:00[Asia/Shanghai]',
        policy,
      ), SECOND + 456))
    }).not.toThrow()
    expect(() => {
      ctx.emit('session/event', preparing(1, 1, 'Asia/Shanghai'), event(reading()))
    }).toThrow(/browser-zone text/)
    expect(() => {
      ctx.emit('session/event', preparing(1, 1, 'Asia/Shanghai'), event(reading(
        '1',
        '1',
        'model-visible message',
        '2026-07-14T00:00:00+00:00[UTC]',
        policy,
      )))
    }).toThrow(/rendered timestamp does not match the unique browser zone/)
  })

  it('reports browser-zone timestamp formatter failures as invariant violations', async () => {
    const ctx = await setup()
    const policy = 'Browser time zone for this request: Asia/Shanghai. '
      + 'Interpret otherwise-unqualified dates and times in this zone.'
    const formatToParts = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts')
      .mockImplementationOnce(() => { throw new RangeError('formatter unavailable') })
    try {
      expect(() => {
        ctx.emit('session/event', preparing(1, 1, 'Asia/Shanghai'), event(reading(
          '1',
          '1',
          'model-visible message',
          '2026-07-14T08:00:00+08:00[Asia/Shanghai]',
          policy,
        )))
      }).toThrow(/browser zone cannot format its durable timestamp: RangeError: formatter unavailable/)
    } finally {
      formatToParts.mockRestore()
    }
  })

  it('rejects invalid browser provenance loaded across the durable boundary', async () => {
    const ctx = await setup()
    const timeZone = 'Not/A_Real_Zone'
    const policy = `Browser time zone for this request: ${timeZone}. `
      + 'Interpret otherwise-unqualified dates and times in this zone.'
    expect(() => {
      ctx.emit('session/event', preparing(1, 1, timeZone), event(reading(
        '1',
        '1',
        'model-visible message',
        `2026-07-14T00:00:00+00:00[${timeZone}]`,
        policy,
      )))
    }).toThrow(/browser time zone is unsupported/)
  })

  it('rejects one corrupt zone even when another zone would classify the turn as mixed', async () => {
    const ctx = await setup()
    const session = preparing(1, 1, 'Asia/Shanghai')
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'second browser prompt' }],
      source: {
        kind: 'user',
        rpcId: 'turn-1-invalid',
        clientTimeZone: 'Not/A_Real_Zone',
      } as never,
    }), { surfaceOp: 'append' })
    expect(() => {
      ctx.emit('session/event', session, event(reading(
        '1',
        '1',
        'model-visible message',
        '2026-07-14T00:00:00+00:00[UTC]',
        'Browser time zone for this request: mixed ["Asia/Shanghai","Not/A_Real_Zone"]. '
        + 'Ask the user to clarify otherwise-unqualified dates and times.',
      )))
    }).toThrow(/browser time zone is unsupported/)
  })

  it('validates each existing reading against its preceding durable prefix', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('time-invariant-late-valid'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'prepare' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    appendReading(session, reading())

    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(TimeInvariant)).resolves.toBeDefined()
  })

  it('rejects an invalid existing reading on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('time-invariant-late-invalid'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'prepare' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    appendReading(session, reading('1', '2', 'step context'))

    await ctx.plugin(InvariantRegistry, { enabled: true })
    await expect(ctx.plugin(TimeInvariant).then(() => undefined)).rejects.toThrow(/expected turn 1\/step 1/)
  })

  it.each([
    [reading('1', '3', 'step context'), /expected turn 2\/step 3/],
    [reading('2', '2', 'step context'), /expected turn 2\/step 3/],
  ])('rejects a reading that disagrees with its session position', async (text, message) => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', preparing(2, 3), event(text)) }).toThrow(message)
  })

  it('rejects a reading after cancellation closes the turn', async () => {
    const ctx = await setup()
    const session = preparing(1, 2)
    session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    expect(() => { ctx.emit('session/event', session, event(reading('1', '2', 'step context'))) })
      .toThrow(/inside an open turn/)
  })

  it('rejects a reading outside prompt assembly', async () => {
    const ctx = await setup()
    const ended = preparing(1, 1)
    ended.append('step/end', { turn: 1, step: 1 })
    expect(() => { ctx.emit('session/event', ended, event(reading())) }).toThrow(/follow step\/start/)
    const notEntered = Session.create(SessionId('time-invariant-turn-only'))
    notEntered.append('turn/start', { turn: 1 })
    expect(() => { ctx.emit('session/event', notEntered, event(reading())) }).toThrow(/follow step\/start/)
    expect(() => {
      ctx.emit('session/event', Session.create(SessionId('time-invariant-empty')), event(reading()))
    }).toThrow(/inside an open turn/)
    const requested = preparing(1, 1)
    requested.append('request/header', {
      header: { config: { provider: 'mock', model: 'model' } },
      reason: 'initial',
    })
    expect(() => { ctx.emit('session/event', requested, event(reading())) }).toThrow(/precede request\/header/)
  })

  it.each([
    ['not a reading', SECOND, undefined, /durable reading format/],
    [reading('0'), SECOND, undefined, /positive safe integers/],
    [reading('999999999999999999999'), SECOND, undefined, /positive safe integers/],
    [reading('1', '0', 'step context'), SECOND, undefined, /positive safe integers/],
    [reading('1', '999999999999999999999', 'step context'), SECOND, undefined, /positive safe integers/],
    [reading('1', '1', 'step context'), SECOND, undefined, /wrong elapsed-time baseline/],
    [reading('1', '2', 'model-visible message'), SECOND, undefined, /wrong elapsed-time baseline/],
    [reading('1', '1', 'model-visible message', '2026-99-99T00:00:00+00:00[UTC]'), SECOND, undefined, /must parse and not postdate/],
    [reading(), Number.NaN, undefined, /must parse and not postdate/],
    [reading(), SECOND - 1, undefined, /must parse and not postdate/],
    ['ignored', SECOND, [], /exactly one text block/],
    ['ignored', SECOND, [{ type: 'image', data: 'x', mimeType: 'image/png' }], /exactly one text block/],
    ['ignored', SECOND, [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }], /exactly one text block/],
    [reading(), SECOND, [{ type: 'text', text: reading(), extra: true }], /exactly one text block/],
  ] as const)('rejects an incoherent durable reading', async (text, time, content, message) => {
    const ctx = await setup()
    const preparationStep = text.includes('turn 1, step 2:') ? 2 : 1
    expect(() => {
      ctx.emit('session/event', preparing(1, preparationStep), event(
        text,
        time,
        content === undefined ? undefined : [...content],
      ))
    }).toThrow(message)
  })

  it('requires exact snapshot provenance without copied request authority', async () => {
    const ctx = await setup()
    const base = event(reading())
    for (const source of [
      { kind: 'plugin', plugin: 'time-context' },
      { ...base.data.source, authority: {} },
      {
        kind: 'plugin',
        plugin: 'time-context',
        form: 'snapshot',
        sections: [{ name: 'time-context', text: 'different' }],
      },
      {
        kind: 'plugin',
        plugin: 'time-context',
        form: 'snapshot',
        sections: { 0: { name: 'time-context', text: reading() }, length: 1 },
      },
      {
        kind: 'plugin',
        plugin: 'time-context',
        form: 'snapshot',
        sections: [{ name: 'time-context', text: reading(), extra: true }],
      },
    ]) {
      const malformed: SessionEvent<'user/message'> = {
        ...base,
        data: { ...base.data, source: source as never },
      }
      expect(() => { ctx.emit('session/event', preparing(1, 1), malformed) })
        .toThrow(/must carry only the exact snapshot text/)
    }
  })

  it('validates a seeded Session created after invariant registration', async () => {
    const ctx = await setup()
    const text = reading('1', '2', 'step context')
    expect(() => {
      ctx.sessions.create(SessionId('time-invariant-created-invalid'), {
        seed: [
          { type: 'turn/start', seq: SessionSeq(0), time: SECOND, data: { turn: 1 } },
          { type: 'step/start', seq: SessionSeq(1), time: SECOND, data: { turn: 1, step: 1 } },
          { ...event(text), seq: SessionSeq(2), surfaceOp: 'append' },
        ],
      })
    }).toThrow(/expected turn 1\/step 1/)
    expect(ctx.sessions.get(SessionId('time-invariant-created-invalid'))).toBeUndefined()
  })

  it('ignores context messages owned by another package', async () => {
    const ctx = await setup()
    const other = event('unrelated', SECOND + 456, undefined, 'other')
    expect(() => { ctx.emit('session/event', preparing(1, 1), other) }).not.toThrow()
    const user: SessionEvent<'user/message'> = {
      ...event('unrelated'),
      data: createUserMessage({
        content: [{ type: 'text', text: 'unrelated' }],
        source: { kind: 'user' },
      }),
    }
    expect(() => { ctx.emit('session/event', preparing(1, 1), user) }).not.toThrow()
    expect(() => {
      ctx.emit('session/event', preparing(1, 1), {
        type: 'turn/start', seq: SessionSeq(0), time: 0, data: { turn: 1 },
      })
      ctx.emit('tools/change')
    }).not.toThrow()
  })
})
