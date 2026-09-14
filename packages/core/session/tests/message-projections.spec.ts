import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import SessionStore, { Session, SessionId, SessionSeq, SessionLogOffset, foldSurface, deriveEventMessage } from '../src/index.ts'
import type { SessionEvent, SessionMessageProjection } from '../src/index.ts'
import { MESSAGE_PROJECTION_EVENT_TYPES } from '../src/known-event-types.ts'
import { SurfaceManager } from '../src/surface.ts'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'test/project': { seq: SessionSeq; text: string }
  }
}

const projection: SessionMessageProjection<'test/project'> = {
  type: 'test/project',
  project(event, context) {
    const source = context.events[event.data.seq - context.baseSeq]!
    const original = deriveEventMessage(source, context.messages)!
    if (event.data.text === 'reject') throw new Error('rejected decision')
    return new Map([[source.seq, deepFreeze({ ...original, content: [{ type: 'text' as const, text: event.data.text }] })]])
  },
}

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function input(session: Session) {
  return session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'original' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
}

describe('plugin-owned message projections', () => {
  it('refuses required events when no interpreter is supplied', () => {
    const type = [...MESSAGE_PROJECTION_EVENT_TYPES][0]!
    const event = { type, seq: SessionSeq(0), time: 0, data: {} } as SessionEvent
    const session = Session.create(SessionId('missing'))
    expect(() => session.append(event.type as 'test/project', event.data as never)).toThrow(/requires a message projection/)
    expect(() => foldSurface([event])).toThrow(/requires a message projection/)
    expect(() => Session.create(session.id, [event])).toThrow(/requires a message projection/)
    expect(session.seq).toBe(0)
  })

  it('applies generic decisions atomically and replays them through detached folds', () => {
    const definitions = [projection]
    const session = Session.create(SessionId('pure'), undefined, undefined, undefined, definitions)
    const source = input(session)
    const original = session.deriveMessages()
    expect(() => session.append('test/project', { seq: source.seq, text: 'reject' })).toThrow('rejected decision')
    expect(session.deriveMessages()).toEqual(original)
    session.append('test/project', { seq: source.seq, text: 'projected' })
    expect(session.deriveMessages()[0]?.content).toEqual([{ type: 'text', text: 'projected' }])
    expect(session.surface.replaceGeneration).toBe(0)
    expect(session.surface.contentGeneration).toBe(1)
    const folded = foldSurface(session.snapshotEvents(), definitions)
    expect(deriveEventMessage(source, folded.projectedMessages)).toEqual(session.deriveMessages()[0])
    expect(source.data.content).toEqual([{ type: 'text', text: 'original' }])
  })

  it('registers by fiber and refuses cached or pending decisions after disposal', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin({
      inject: ['sessions'],
      apply(owner: Context) { owner.sessions.registerMessageProjection(projection) },
    })
    expect(() => ctx.sessions.registerMessageProjection(projection)).toThrow(/already registered/)
    const live = ctx.sessions.create(SessionId('live'))
    const source = input(live)
    live.append('test/project', { seq: source.seq, text: 'changed' })
    const pending = ctx.sessions.create(SessionId('pending'))
    input(pending)
    pending.append('test/project', { seq: source.seq, text: 'changed' })
    const before = live.deriveMessages()
    const child = ctx.sessions.fork(live)
    expect(child.deriveMessages()).toEqual(before)
    const restored = ctx.sessions.prepare(SessionId('restore'), {
      seed: [...live.snapshotEvents()], meta: { ...live.header, id: SessionId('restore') },
      inheritedEventCount: live.inheritedEventCount, eventState: 'shared-frozen',
    })
    expect(restored.deriveMessages()).toEqual(before)
    await fiber.dispose()
    expect(ctx.sessions.messageProjections).toEqual([])
    for (const session of [live, pending, child, restored]) {
      expect(() => session.deriveMessages()).toThrow(/was removed or replaced/)
      expect(() => session.deriveEventMessage(source)).toThrow(/was removed or replaced/)
      expect(() => session.surface.replaceGeneration).toThrow(/was removed or replaced/)
      expect(() => session.surface.contentGeneration).toThrow(/was removed or replaced/)
      expect(() => session.append('turn/start', { turn: 1 })).toThrow(/was removed or replaced/)
    }
    expect(before[0]?.content).toEqual([{ type: 'text', text: 'changed' }])
  })

  it('applies a supplied interpreter to a loaded window with absolute sequences', () => {
    const session = Session.create(SessionId('window'), undefined, undefined, undefined, [projection])
    input(session)
    const source = input(session)
    session.append('test/project', { seq: source.seq, text: 'window' })
    const events = session.snapshotEvents().slice(1)
    const surface = new SurfaceManager(events, SessionLogOffset(1), [projection])
    expect(surface.nodes).toEqual([source.seq])
    expect(surface.deriveEventMessage(source)?.content).toEqual([{ type: 'text', text: 'window' }])
  })

  it('does not retain an interpreter for a candidate that never committed', () => {
    const session = Session.create(SessionId('candidate'))
    const source = input(session)
    const definitions: SessionMessageProjection[] = [projection]
    const surface = new SurfaceManager(session.snapshotEvents(), undefined, definitions)
    surface.validateNext({ type: 'test/project', seq: SessionSeq(1), time: 0, data: { seq: source.seq, text: 'unused' } })
    definitions.length = 0
    expect(surface.deriveEventMessage(source)).toBe(source.data)
  })
})
