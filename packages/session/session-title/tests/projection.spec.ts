import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionSeq as SessionSeqType } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitleService from '@deepseek-ai/dsh-session-title'

const CONFIG = { fallbackMaxWords: 8, fallbackMaxBytes: 64, maxTitleBytes: 256 }

async function harness(withTitleService: boolean): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  if (withTitleService) await ctx.plugin(SessionTitleService, CONFIG)
  return { ctx, session: ctx.sessions.create(SessionId('titled')) }
}

function appendTitle(session: Session, title: string): SessionSeqType {
  const messageSeq = session.snapshotEvents().find(event =>
    event.type === 'user/message' && event.data.source.kind === 'user')?.seq
    ?? session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Title source' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' }).seq
  return session.append('session/title', {
    title, messageSeqs: [messageSeq], source: { kind: 'fallback' },
  }).seq
}

describe('title projection unit', () => {
  it('serves null before the first title event', async () => {
    const { ctx, session } = await harness(true)
    const snapshot = ctx.sessionProjections.snapshot(session)
    expect(snapshot.values.title).toBeNull()
    expect(ctx.sessionProjections.checkpoint(session).title).toEqual({ ver: 1, seq: -1, val: null })
  })

  it('serves the latest title last-wins and notifies the change feed with the causing seq', async () => {
    const { ctx, session } = await harness(true)
    const changes: { key: string; value: unknown; seq: SessionSeqType }[] = []
    ctx.sessionProjections.onChanged((_session, key, value, seq) => {
      changes.push({ key, value, seq })
    })
    const firstSeq = appendTitle(session, 'First title')
    const secondSeq = appendTitle(session, 'Second title')
    session.append('turn/start', { turn: 1 })
    expect(changes).toEqual([
      { key: 'title', value: 'First title', seq: firstSeq },
      { key: 'title', value: 'Second title', seq: secondSeq },
    ])
    const snapshot = ctx.sessionProjections.snapshot(session)
    expect(snapshot.values.title).toBe('Second title')
    expect(snapshot.asOfSeq).toBe(session.seq - 1)
  })

  it('reads the version-1 string checkpoint format used by existing title caches', async () => {
    const { ctx } = await harness(true)

    expect(ctx.sessionProjections.viewCheckpoint({
      title: { ver: 1, seq: SessionSeq(8), val: 'Cached title' },
    })).toEqual({ title: 'Cached title' })
  })

  it('folds titles already in the log when the service mounts late (lazy cell build)', async () => {
    const { ctx, session } = await harness(false)
    appendTitle(session, 'Pre-mount title')
    await ctx.plugin(SessionTitleService, CONFIG)
    expect(ctx.sessionProjections.snapshot(session).values.title).toBe('Pre-mount title')
  })

  it('has no title key without the title service, and drops it when the service unloads (HMR safety)', async () => {
    const { ctx, session } = await harness(false)
    expect('title' in ctx.sessionProjections.snapshot(session).values).toBe(false)
    const fiber = await ctx.plugin(SessionTitleService, CONFIG)
    appendTitle(session, 'Ephemeral')
    expect(ctx.sessionProjections.snapshot(session).values.title).toBe('Ephemeral')
    await fiber.dispose()
    expect('title' in ctx.sessionProjections.snapshot(session).values).toBe(false)
  })

  it('keeps thousands of title inputs as a bounded aggregate and checkpoints it', async () => {
    const { ctx, session } = await harness(false)
    session.append('turn/start', { turn: 1 })
    for (let index = 0; index < 5_000; index++) {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: `message ${String(index)}` }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    }
    await ctx.plugin(SessionTitleService, CONFIG)

    const state = ctx.sessionProjections.stateOf(session, 'titleInput')
    expect(state?.count).toBe(5_000)
    expect(state?.first?.text).toBe('message 0')
    expect(state?.lastSeq).toBe(session.seq - 1)
    expect(ctx.sessionProjections.checkpoint(session).titleInput).toBeDefined()
  })

  it('rejects a version-matching checkpoint with inconsistent title input counters', async () => {
    const { ctx, session } = await harness(true)
    const checkpoint = ctx.sessionProjections.checkpoint(session)
    const row = checkpoint.titleInput
    expect(row).toBeDefined()
    const invalidStates = [
      { first: null, count: 1, lastSeq: null },
      { first: { seq: 1, text: 'first' }, count: 1, lastSeq: null },
      { first: { seq: 1, text: 'first' }, count: 0, lastSeq: 1 },
      { first: { seq: 2, text: 'first' }, count: 1, lastSeq: 1 },
    ]
    for (const state of invalidStates) {
      const malformed = {
        ...checkpoint,
        titleInput: { ...row!, val: state },
      }
      expect(() => ctx.sessionProjections.restore(
        malformed, [], SessionLogOffset(0), session.header, session.inheritedEventCount,
      ))
        .toThrow(/title input state must pair its count with first and last message seqs/)
    }

    expect(() => ctx.sessionProjections.restore({
      ...checkpoint,
      titleInput: {
        ...row!,
        val: { first: { seq: 1, text: 'first' }, count: 1, lastSeq: 1 },
      },
    }, [], SessionLogOffset(0), session.header, session.inheritedEventCount)).not.toThrow()
  })
})
