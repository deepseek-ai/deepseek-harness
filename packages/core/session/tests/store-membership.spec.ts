import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import SessionStore, {
  appendPluginRecord,
  Session,
  SessionId,
  SessionLogOffset,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap {
    'plugin:test/store-membership': { value: number }
  }
}

describe('Session store membership', () => {
  let ctx: Context

  beforeEach(async () => {
    ctx = new Context()
    await ctx.plugin(SessionStore)
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
  })

  it.each([
    { name: 'events', append: (session: Session) => session.append('turn/start', { turn: 1 }) },
    { name: 'plugin records', append: (session: Session) => appendPluginRecord(session, 'plugin:test/store-membership', { value: 1 }) },
  ])('keeps independent $name local and adopts their history without replaying notifications', async ({ append }) => {
    const session = Session.create(SessionId('independent'))
    const observed: SessionEvent[] = []
    let initialHistory: readonly SessionEvent[] | undefined
    let disposalError: unknown
    ctx.on('session/event', (_session, event) => { observed.push(event) })
    ctx.on('session/created', (created) => {
      initialHistory = created.snapshotEvents()
      expect(() => append(created)).toThrow('cannot append before session/created completes')
    })
    ctx.on('session/disposed', (disposed) => {
      try { append(disposed) } catch (error) { disposalError = error }
    })

    append(session)
    const history = session.snapshotEvents()
    expect(history).toHaveLength(1)
    expect(Object.isFrozen(history[0])).toBe(true)
    expect(Object.isFrozen(history[0]?.data)).toBe(true)
    expect(observed).toEqual([])

    const leave = ctx.effect(() => ctx.sessions.enter(session))
    expect(() => append(session)).toThrow('cannot append before session/created completes')
    ctx.sessions.announce(session)
    expect(initialHistory).toBe(history)
    expect(observed).toEqual([])
    append(session)
    expect(history).toHaveLength(1)
    expect(observed).toEqual(session.snapshotEvents(SessionLogOffset(1)))

    await leave()
    expect(disposalError).toBeInstanceOf(Error)
    expect(String(disposalError)).toContain('cannot append outside a SessionStore')
    expect(() => append(session)).toThrow('cannot append outside a SessionStore')
    expect(session.seq).toBe(2)
  })

  it.each([
    { name: 'events', append: (session: Session) => session.append('turn/start', { turn: 1 }) },
    { name: 'plugin records', append: (session: Session) => appendPluginRecord(session, 'plugin:test/store-membership', { value: 1 }) },
  ])('allows $name only after creation announcement and before removal', async ({ append }) => {
    const session = ctx.sessions.prepare(SessionId('membership'))
    const observed: SessionEvent[] = []
    ctx.on('session/event', (_session, event) => { observed.push(event) })
    const empty = session.snapshotEvents()

    expect(() => append(session)).toThrow('cannot append outside a SessionStore')
    expect(session.snapshotEvents()).toBe(empty)
    expect(observed).toEqual([])

    const leave = ctx.effect(() => ctx.sessions.enter(session))
    expect(() => append(session)).toThrow('cannot append before session/created completes')
    ctx.on('session/created', (created) => {
      if (created !== session) return
      expect(() => append(session)).toThrow('cannot append before session/created completes')
      expect(session.snapshotEvents()).toBe(empty)
    })
    ctx.sessions.announce(session)
    append(session)
    const committed = session.snapshotEvents()
    expect(committed).toHaveLength(1)
    expect(observed).toEqual(committed)

    await leave()
    const replacement = ctx.sessions.create(session.id)
    expect(ctx.sessions.get(session.id)).toBe(replacement)
    expect(() => append(session)).toThrow('cannot append outside a SessionStore')
    expect(session.snapshotEvents()).toBe(committed)
    expect(replacement.seq).toBe(0)
    expect(observed).toEqual(committed)
  })

  it('keeps writes disabled after a failed announcement', () => {
    const session = ctx.sessions.prepare(SessionId('failed-announcement'))
    ctx.effect(() => ctx.sessions.enter(session))
    ctx.on('session/created', () => { throw new Error('creation observer failed') })
    expect(() => { ctx.sessions.announce(session) }).toThrow('creation observer failed')
    expect(() => session.append('turn/start', { turn: 1 })).toThrow('cannot append before session/created completes')
    expect(() => { ctx.sessions.announce(session) }).toThrow('already announced')
    expect(session.seq).toBe(0)
  })

  it.each(['events', 'plugin records'] as const)('rejects %s before reading payloads when writes are disabled', async (kind) => {
    const session = ctx.sessions.prepare(SessionId('unread-payload'))
    let reads = 0
    const read = (): number => { reads++; return 1 }
    const append = (): void => {
      if (kind === 'events') session.append('turn/start', { get turn() { return read() } })
      else appendPluginRecord(session, 'plugin:test/store-membership', { get value() { return read() } })
    }

    expect(append).toThrow('cannot append outside a SessionStore')
    const leave = ctx.effect(() => ctx.sessions.enter(session))
    expect(append).toThrow('cannot append before session/created completes')
    ctx.on('session/created', () => {
      expect(append).toThrow('cannot append before session/created completes')
    })
    ctx.sessions.announce(session)
    await leave()
    expect(append).toThrow('cannot append outside a SessionStore')
    expect(reads).toBe(0)
    expect(session.seq).toBe(0)
  })

  it.each(['events', 'plugin records'] as const)('rejects %s when reading the payload detaches the Session', (kind) => {
    const session = ctx.sessions.prepare(SessionId('payload-detach'))
    const detach = ctx.sessions.enter(session)
    ctx.effect(() => detach)
    ctx.sessions.announce(session)
    const observed: SessionEvent[] = []
    ctx.on('session/event', (_session, event) => { observed.push(event) })
    const read = (): number => { detach(); return 1 }

    expect(() => {
      if (kind === 'events') session.append('turn/start', { get turn() { return read() } })
      else appendPluginRecord(session, 'plugin:test/store-membership', { get value() { return read() } })
    }).toThrow('cannot append outside a SessionStore')
    expect(ctx.sessions.get(session.id)).toBeUndefined()
    expect(session.seq).toBe(0)
    expect(observed).toEqual([])
  })

  it.each(['events', 'plugin records'] as const)('rechecks %s after payload evaluation transfers an independent Session to a store', (kind) => {
    const session = Session.create(SessionId('payload-adoption'))
    const read = (): number => {
      ctx.effect(() => ctx.sessions.enter(session))
      return 1
    }
    expect(() => {
      if (kind === 'events') session.append('turn/start', { get turn() { return read() } })
      else appendPluginRecord(session, 'plugin:test/store-membership', { get value() { return read() } })
    }).toThrow('cannot append before session/created completes')
    expect(ctx.sessions.get(session.id)).toBe(session)
    expect(session.seq).toBe(0)
    ctx.sessions.announce(session)
    session.append('turn/start', { turn: 1 })
    expect(session.seq).toBe(1)
  })

  it('appends to independent constructor, restore, and fork history without publication', () => {
    const observed: SessionEvent[] = []
    ctx.on('session/event', (_session, event) => { observed.push(event) })
    const seed: readonly SessionEvent[] = deepFreeze([
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    ])
    const id = SessionId('history')
    const created = Session.create(id, seed)
    const restored = Session.fromRestore(id, seed, created.header, SessionLogOffset(0), 'shared-frozen')
    const childId = SessionId('child')
    const forked = Session.create(childId, seed, {
      ...created.header, id: childId, parentSession: id, isSeeded: true,
    }, SessionLogOffset(1))
    for (const session of [created, restored, forked]) {
      const history = session.snapshotEvents()
      expect(history[0]).toEqual(seed[0])
      expect(history[1]).toMatchObject({
        type: 'session/end-seed', seq: 1, data: session === forked ? { inherited: true } : {},
      })
      expect(Object.isFrozen(history[1])).toBe(true)
      expect(Object.isFrozen(history[1]?.data)).toBe(true)
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      expect(history).toHaveLength(2)
      expect(session.seq).toBe(3)
    }
    expect(observed).toEqual([])
  })

  it.each(['detached', 'shared-frozen'] as const)('keeps prepared restored history read-only (%s)', (eventState) => {
    const source = Session.create(SessionId('restored'))
    source.append('turn/start', { turn: 1 })
    const session = ctx.sessions.prepare(source.id, {
      seed: [...source.snapshotEvents()],
      meta: source.header,
      inheritedEventCount: SessionLogOffset(0),
      eventState,
    })
    const history = session.snapshotEvents()
    expect(() => session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }))
      .toThrow('cannot append outside a SessionStore')
    expect(session.snapshotEvents()).toBe(history)
  })

  it('revokes writes when the owning fiber releases a session', async () => {
    const session = ctx.sessions.create(SessionId('owned'))
    session.append('turn/start', { turn: 1 })
    await ctx.fiber.dispose()

    expect(() => session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }))
      .toThrow('cannot append outside a SessionStore')
    expect(session.seq).toBe(1)
  })
})
