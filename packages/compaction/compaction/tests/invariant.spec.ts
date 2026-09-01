import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import * as CompactionInvariant from '@deepseek-ai/dsh-compaction/invariant'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(CompactionInvariant)
  return ctx
}

const TEST_COMPACTION_ID = CompactionId('test-compaction')
const NEXT_COMPACTION_ID = CompactionId('next-test-compaction')
const TEST_COMMAND_ID = CommandId('test-command')
const NEXT_COMMAND_ID = CommandId('next-test-command')

const summary = (overrides: Record<string, unknown> = {}) => ({
  compactionId: TEST_COMPACTION_ID,
  summary: [{ type: 'text' as const, text: 'short' }],
  shadowedRange: { start: 2, end: 4 },
  shadowedSeqs: [2, 3, 4],
  shadowedTokenCount: 12,
  provider: 'mock',
  model: 'mock',
  ...overrides,
})

function startTurn(session: ReturnType<Context['sessions']['create']>, turn = 1): void {
  session.append('turn/start', { turn })
}

describe('compaction invariants', () => {
  it('accepts successful and failed compaction lifecycles', async () => {
    const ctx = await setup()
    const success = ctx.sessions.create()
    startTurn(success)
    success.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
    success.append('compaction/summary', summary())
    success.append('compaction/end', { compactionId: TEST_COMPACTION_ID, turn: 1 })

    const failed = ctx.sessions.create()
    startTurn(failed, 2)
    failed.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 2 })
    failed.append('compaction/end', { compactionId: TEST_COMPACTION_ID, turn: 2, error: 'provider failed' })
  })

  it('accepts standalone successful and failed compaction lifecycles between turns', async () => {
    const ctx = await setup()
    const success = ctx.sessions.create()
    success.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: null })
    success.append('compaction/summary', summary())
    success.append('compaction/end', { compactionId: TEST_COMPACTION_ID, turn: null })

    const failed = ctx.sessions.create()
    failed.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: null })
    failed.append('compaction/end', { compactionId: TEST_COMPACTION_ID, turn: null, error: 'provider failed' })
  })

  it('clears an inherited open compaction trace at end-seed during replay', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const source = Session.create(SessionId('stale-compaction-source'))
    source.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: null })
    const replayed = ctx.sessions.create(SessionId('stale-compaction-replay'), {
      seed: source.snapshotEvents(),
    })
    expect(replayed.snapshotEvents().map(event => event.type))
      .toEqual(['compaction/start', 'session/end-seed'])

    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(CompactionInvariant)

    expect(() => {
      replayed.append('compaction/start', { compactionId: NEXT_COMPACTION_ID, turn: null })
      replayed.append('compaction/end', { compactionId: NEXT_COMPACTION_ID, turn: null, error: 'new attempt failed' })
    }).not.toThrow()
  })

  it('allows repair turn boundaries after end-seed clears a seeded numbered orphan', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const source = Session.create(SessionId('stale-numbered-compaction-source'))
    startTurn(source)
    source.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
    const replayed = ctx.sessions.create(SessionId('stale-numbered-compaction-replay'), {
      seed: source.snapshotEvents(),
    })
    expect(replayed.snapshotEvents().map(event => event.type))
      .toEqual(['turn/start', 'compaction/start', 'session/end-seed'])

    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(CompactionInvariant)

    expect(() => replayed.append(
      'turn/end',
      { turn: 1, reason: { kind: 'interrupted' } },
    )).not.toThrow()
  })

  it('accepts inherited repair boundaries before the end-seed that clears a standalone orphan', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const source = Session.create(SessionId('stale-repaired-compaction-source'))
    source.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: null })
    startTurn(source)
    source.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
    const replayed = ctx.sessions.create(SessionId('stale-repaired-compaction-replay'), {
      seed: source.snapshotEvents(),
    })
    expect(replayed.snapshotEvents().map(event => event.type)).toEqual([
      'compaction/start',
      'turn/start',
      'turn/end',
      'session/end-seed',
    ])

    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(CompactionInvariant).then(() => undefined)).resolves.toBeUndefined()

    expect(() => {
      startTurn(replayed, 2)
      replayed.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    }).not.toThrow()
  })

  it('rejects a closed standalone bracket that contains a turn before end-seed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const source = Session.create(SessionId('closed-nested-compaction-source'))
    source.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: null })
    startTurn(source)
    source.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } })
    source.append('compaction/end', { compactionId: TEST_COMPACTION_ID, turn: null, error: 'failed after crossing turn' })
    const replayed = ctx.sessions.create(SessionId('closed-nested-compaction-replay'), {
      seed: source.snapshotEvents(),
    })
    expect(replayed.snapshotEvents().at(-1)?.type).toBe('session/end-seed')

    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(CompactionInvariant).then(() => undefined))
      .rejects.toThrow(/turn\/start cannot cross an open standalone compaction/)
  })

  it('rebuilds an open trace when the companion loads after the session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(CompactionInvariant)
    expect(() => session.append('compaction/end', {
      compactionId: TEST_COMPACTION_ID,
      turn: 1,
      error: 'resume failed',
    })).not.toThrow()
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  })

  it('adopts a bare session and ignores unrelated committed events', async () => {
    const ctx = await setup()
    const session = Session.create(SessionId('bare-compaction-session'))
    expect(() => {
      ctx.emit('session/event', session, {
        type: 'turn/start', seq: 0, time: 0,
        data: { turn: 1 },
      })
      ctx.emit('session/event', session, {
        type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 },
      })
      ctx.emit('session/event', session, {
        type: 'compaction/start', seq: 2, time: 2,
        data: { compactionId: TEST_COMPACTION_ID, turn: 1 },
      })
    }).not.toThrow()
  })

  it('rejects compaction outside or for a different open turn', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    expect(() => session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 }))
      .toThrow(/outside any open turn/)
    startTurn(session)
    expect(() => session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 2 }))
      .toThrow(/but open turn is 1/)
  })

  it('rejects a standalone bracket while a turn is open and a numbered bracket between turns', async () => {
    const ctx = await setup()
    const open = ctx.sessions.create()
    startTurn(open)
    expect(() => open.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: null }))
      .toThrow(/standalone but turn 1 is open/)

    const idle = ctx.sessions.create()
    expect(() => idle.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 }))
      .toThrow(/outside any open turn/)
  })

  it('attributes a nested standalone start to the standalone owner', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: null })
    expect(() => session.append('compaction/start', { compactionId: NEXT_COMPACTION_ID, turn: null }))
      .toThrow(/standalone compaction is still compacting/)
  })

  it('rejects an unenclosed compaction event when replaying an existing session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    startTurn(session)
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
    await ctx.plugin(InvariantRegistry)
    await expect(ctx.plugin(CompactionInvariant).then(() => undefined)).rejects.toThrow(/outside any open turn/)
  })

  it('rejects turn boundaries that cross live standalone or numbered compaction brackets', async () => {
    const ctx = await setup()
    const standalone = ctx.sessions.create()
    standalone.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: null })
    expect(() => { startTurn(standalone) })
      .toThrow(/turn\/start cannot cross an open standalone compaction/)
    standalone.append('compaction/end', { compactionId: TEST_COMPACTION_ID, turn: null, error: 'cancelled' })
    expect(() => {
      startTurn(standalone)
      standalone.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    }).not.toThrow()

    const numbered = ctx.sessions.create()
    startTurn(numbered)
    numbered.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
    expect(() => numbered.append(
      'turn/end',
      { turn: 1, reason: { kind: 'completed' } },
    )).toThrow(/turn\/end cannot cross an open compaction for turn 1/)
    numbered.append('compaction/end', { compactionId: TEST_COMPACTION_ID, turn: 1, error: 'cancelled' })
    expect(() => numbered.append(
      'turn/end',
      { turn: 1, reason: { kind: 'completed' } },
    )).not.toThrow()
  })

  it('rejects a replacement checkpoint for another compaction transaction', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    const original = session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'original' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    startTurn(session)
    session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
    session.append('compaction/summary', summary())

    expect(() => session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'checkpoint' }],
      source: compactCheckpointSource(NEXT_COMPACTION_ID),
    }), {
      surfaceOp: { op: 'replace', start: original.seq, end: original.seq },
      sourceEventSeqs: [original.seq],
    })).toThrow(/compaction checkpoint id .* does not match compaction\/start id/)
  })

  it('requires checkpoint provenance to name an open transaction', async () => {
    const ctx = await setup()
    const withoutStart = ctx.sessions.create()
    const original = withoutStart.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'original' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(() => withoutStart.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'checkpoint' }],
      source: compactCheckpointSource(TEST_COMPACTION_ID),
    }), {
      surfaceOp: { op: 'replace', start: original.seq, end: original.seq },
      sourceEventSeqs: [original.seq],
    })).toThrow(/no matching compaction\/start/)

    const emptyCommand = ctx.sessions.create()
    const replaced = emptyCommand.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'original' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    startTurn(emptyCommand)
    emptyCommand.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
    expect(() => emptyCommand.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'checkpoint' }],
      source: compactCheckpointSource(TEST_COMPACTION_ID, CommandId('')),
    }), {
      surfaceOp: { op: 'replace', start: replaced.seq, end: replaced.seq },
      sourceEventSeqs: [replaced.seq],
    })).toThrow(/checkpoint sourceCommandId must be a non-empty string/)
  })

  it.each([
    ['empty start id', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', { compactionId: CompactionId(''), turn: 1 })
    }, /compaction\/start compactionId must be a non-empty string/],
    ['empty start source command id', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', {
        compactionId: TEST_COMPACTION_ID,
        sourceCommandId: CommandId(''),
        turn: 1,
      })
    }, /compaction\/start sourceCommandId must be a non-empty string/],
    ['summary without start', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/summary', summary())
    }, /no matching compaction\/start/],
    ['nested start', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
      session.append('compaction/start', { compactionId: NEXT_COMPACTION_ID, turn: 2 })
    }, /still compacting/],
    ['repeated summary', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
      session.append('compaction/summary', summary())
      session.append('compaction/summary', summary())
    }, /repeated within one compaction/],
    ['summary for another compaction', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
      session.append('compaction/summary', summary({ compactionId: NEXT_COMPACTION_ID }))
    }, /compaction\/summary id .* does not match compaction\/start id/],
    ['summary for another source command', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', {
        compactionId: TEST_COMPACTION_ID,
        sourceCommandId: TEST_COMMAND_ID,
        turn: 1,
      })
      session.append('compaction/summary', summary({ sourceCommandId: NEXT_COMMAND_ID }))
    }, /compaction\/summary sourceCommandId .* does not match compaction\/start sourceCommandId/],
    ['empty shadow set', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
      session.append('compaction/summary', summary({ shadowedSeqs: [] }))
    }, /shadowedSeqs must be non-empty/],
    ['wrong endpoints', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
      session.append('compaction/summary', summary({ shadowedRange: { start: 1, end: 4 } }))
    }, /shadowedRange must match/],
    ['invalid token count', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
      session.append('compaction/summary', summary({ shadowedTokenCount: -1 }))
    }, /non-negative safe integer/],
    ['end without start', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/end', { compactionId: TEST_COMPACTION_ID, turn: 1, error: 'failed' })
    }, /no matching compaction\/start/],
    ['wrong end turn', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
      session.append('compaction/end', { compactionId: TEST_COMPACTION_ID, turn: 2, error: 'failed' })
    }, /does not match/],
    ['end for another compaction', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
      session.append('compaction/end', { compactionId: NEXT_COMPACTION_ID, turn: 1, error: 'failed' })
    }, /compaction\/end id .* does not match compaction\/start id/],
    ['end missing the source command', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', {
        compactionId: TEST_COMPACTION_ID,
        sourceCommandId: TEST_COMMAND_ID,
        turn: 1,
      })
      session.append('compaction/end', { compactionId: TEST_COMPACTION_ID, turn: 1, error: 'failed' })
    }, /compaction\/end sourceCommandId .* does not match compaction\/start sourceCommandId/],
    ['empty end source command id', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', {
        compactionId: TEST_COMPACTION_ID,
        sourceCommandId: TEST_COMMAND_ID,
        turn: 1,
      })
      session.append('compaction/end', {
        compactionId: TEST_COMPACTION_ID,
        sourceCommandId: CommandId(''),
        turn: 1,
        error: 'failed',
      })
    }, /compaction\/end sourceCommandId must be a non-empty string/],
    ['success without summary', (session: ReturnType<Context['sessions']['create']>) => {
      session.append('compaction/start', { compactionId: TEST_COMPACTION_ID, turn: 1 })
      session.append('compaction/end', { compactionId: TEST_COMPACTION_ID, turn: 1 })
    }, /requires one compaction\/summary/],
  ])('rejects %s', async (_name, action, message) => {
    const ctx = await setup()
    const session = ctx.sessions.create()
    startTurn(session)
    expect(() => { action(session) }).toThrow(message)
  })
})
