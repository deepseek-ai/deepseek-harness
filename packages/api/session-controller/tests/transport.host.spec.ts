import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent, SessionHeader, SurfaceIntent } from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { subagentIdentityProjectionDefinition } from '@deepseek-ai/dsh-subagent/src/projection.ts'
import { describe, expect, it, vi } from 'vitest'
import { SessionHistoryController } from '../src/history.ts'
import { installSessionReadTestServices, testSessionPersistence } from './test-remote.ts'

const signal = (): AbortSignal => new AbortController().signal

function append(
  session: Session,
  type: string,
  data: unknown,
  options?: Partial<SurfaceIntent>,
): SessionEvent {
  return (session.append as unknown as (
    eventType: string,
    eventData: unknown,
    eventOptions?: unknown,
  ) => SessionEvent)(type, data, options)
}

function event(type: string, seq: SessionSeq, data: unknown = {}): SessionEvent {
  return {
    type,
    seq,
    time: seq + 1,
    data,
    ...type.startsWith('fixture/') ? { ignorable: true } : {},
  } as SessionEvent
}

function eventSession(header: SessionHeader, events: readonly SessionEvent[]): Session {
  return {
    id: header.id,
    header,
    inheritedEventCount: SessionLogOffset(0),
    seq: events.length,
    eventAt: (seq: number) => events[seq],
    snapshotEvents: (fromSeq = 0, toSeqExclusive = events.length) => events.slice(fromSeq, toSeqExclusive),
  } as unknown as Session
}

function cold(
  ctx: Context,
  header: SessionHeader,
  events: readonly SessionEvent[],
): void {
  if (header.isSeeded) throw new Error('seeded cold fixtures require an explicit inherited cut')
  ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
    list: () => Promise.resolve([header]),
    inspect: () => Promise.resolve({
      meta: header,
      inheritedEventCount: SessionLogOffset(0),
      events,
    }),
  }) as never)
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

async function setup(): Promise<{ ctx: Context; transport: SessionHistoryController }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  installSessionReadTestServices(ctx)
  ctx.sessionProjections.register(subagentIdentityProjectionDefinition)
  const transport = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
  return { ctx, transport }
}

describe('SessionHistoryController', () => {
  it('opens at the current cursor and follows later events from an ordinary Session', async () => {
    const { ctx, transport } = await setup()
    const session = ctx.sessions.create(SessionId('ordinary'), { meta: { cwd: '/workspace' } })
    session.append('turn/start', { turn: 1 })
    const abort = new AbortController()
    const iterator = transport.follow(
      { address: { kind: 'session', sessionId: session.id } },
      abort.signal,
    )[Symbol.asyncIterator]()

    expect(await iterator.next()).toMatchObject({ done: false, value: { type: 'snapshot', cursor: 0 } })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { type: 'event', event: { type: 'turn/end', seq: 1 } },
    })

    const page = await transport.page(
      { address: { kind: 'session', sessionId: session.id }, throughSeq: 1 },
      new AbortController().signal,
    )
    expect(page.records.map(entry => entry.event.seq)).toEqual([0, 1])

    abort.abort()
    expect(await iterator.next()).toMatchObject({ done: true })
  })

  it('ends active followers when the owning Controller unloads', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    installSessionReadTestServices(ctx)
    let transport!: SessionHistoryController
    const owner = ctx.plugin(Object.assign(
      (inner: Context) => {
        transport = new SessionHistoryController(inner, (observation) => { observation[Symbol.dispose]() })
      },
      { inject: ['sessions', 'sessionQuery'] },
    ))
    await owner.await()
    const session = ctx.sessions.create(SessionId('controller-unload'), { meta: { cwd: '/workspace' } })
    const iterator = transport.follow(
      { address: { kind: 'session', sessionId: session.id } },
      new AbortController().signal,
    )[Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'snapshot', cursor: -1 },
    })
    const pending = iterator.next()
    await owner.dispose()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    await ctx.fiber.dispose()
  })

  it('reconnects with a complete replacement snapshot before later live events', async () => {
    const { ctx, transport } = await setup()
    const session = ctx.sessions.create(SessionId('resume'), { meta: { cwd: '/workspace' } })
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    const abort = new AbortController()
    const iterator = transport.follow({
      address: { kind: 'session', sessionId: session.id },
    }, abort.signal)[Symbol.asyncIterator]()

    expect(await iterator.next()).toMatchObject({
      done: false,
      value: {
        type: 'snapshot',
        cursor: 2,
        records: [
          { type: 'event', event: { seq: 0 } },
          { type: 'event', event: { seq: 1 } },
          { type: 'event', event: { seq: 2 } },
        ],
      },
    })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    expect(await iterator.next()).toMatchObject({ done: false, value: { type: 'event', event: { seq: 3 } } })

    abort.abort()
    expect(await iterator.next()).toMatchObject({ done: true })
  })

  it('subscribes before a cold read and ignores unrelated and replayed buffered events', async () => {
    const { ctx, transport } = await setup()
    const sessionId = SessionId('cold-race')
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: 1,
      cwd: '/workspace',
      isSeeded: false,
    }
    const inspected = deferred<{
      meta: SessionHeader
      inheritedEventCount: SessionLogOffset
      events: readonly SessionEvent[]
    }>()
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: () => Promise.resolve([header]),
      inspect: () => inspected.promise,
    }) as never)
    const abort = new AbortController()
    const iterator = transport.follow({ address: { kind: 'session', sessionId } }, abort.signal)
      [Symbol.asyncIterator]()
    const opening = iterator.next()

    const unrelated = event('fixture/other', SessionSeq(0))
    const start = event('fixture/start', SessionSeq(0))
    ctx.emit('session/event', eventSession({ ...header, id: SessionId('unrelated') }, [unrelated]), unrelated)
    ctx.emit('session/event', eventSession(header, [start]), start)
    inspected.resolve({
      meta: header,
      inheritedEventCount: SessionLogOffset(0),
      events: [event('fixture/start', SessionSeq(0))],
    })
    await expect(opening).resolves.toMatchObject({ done: false, value: { type: 'snapshot', cursor: 0 } })

    const waiting = iterator.next()
    abort.abort()
    await expect(waiting).resolves.toMatchObject({ done: true })
  })

  it('buffers creation while the opening observation is unresolved', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const sessionId = SessionId('created-during-observation')
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: 1,
      cwd: '/workspace',
      isSeeded: false,
    }
    const observed = deferred<SessionObservation>()
    ctx.provide('sessionQuery', { observeSession: () => observed.promise } as never)
    const transport = new SessionHistoryController(ctx, vi.fn())
    const abort = new AbortController()
    const iterator = transport.follow({ address: { kind: 'session', sessionId } }, abort.signal)
      [Symbol.asyncIterator]()
    const opening = iterator.next()

    const attached = ctx.sessions.create(sessionId, { meta: header, seed: [event('fixture/seed', SessionSeq(0))] })
    observed.resolve({
      source: 'live',
      header: attached.header,
      events: attached.snapshotEvents(),
      cursor: attached.seq - 1,
      projections: { asOfSeq: attached.seq - 1, values: {} },
      retain: vi.fn(),
      [Symbol.dispose]: vi.fn(),
    } as unknown as SessionObservation)
    await expect(opening).resolves.toMatchObject({
      done: false,
      value: {
        type: 'snapshot',
        cursor: 1,
        records: [
          { type: 'event', event: { seq: 0 } },
          { type: 'event', event: { seq: 1 } },
        ],
      },
    })
    expect(attached.id).toBe(sessionId)
    abort.abort()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
  })

  it('bridges the unpublished end-seed boundary when a cold source attaches', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    installSessionReadTestServices(ctx)
    let transport!: SessionHistoryController
    let agentCtx!: Context
    await ctx.plugin(Object.assign(
      (inner: Context) => {
        transport = new SessionHistoryController(inner, (observation) => { observation[Symbol.dispose]() })
      },
      { inject: ['sessions', 'sessionQuery'] },
    ))
    await ctx.plugin(Object.assign(
      (inner: Context) => { agentCtx = createScope(inner, { name: 'agent' }).ctx },
      { inject: ['sessions'] },
    ))
    const sessionId = SessionId('cold-attach')
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: 1,
      cwd: '/workspace',
      isSeeded: false,
    }
    const seed = [event('fixture/start', SessionSeq(0))]
    cold(ctx, header, seed)
    agentCtx.on('session/created', (session) => {
      if (session.id !== sessionId) return
      append(session, 'fixture/setup-one', {})
      append(session, 'fixture/setup-two', {})
    })
    const abort = new AbortController()
    const iterator = transport.follow({ address: { kind: 'session', sessionId } }, abort.signal)
      [Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { type: 'snapshot', cursor: 0 } })
    agentCtx.sessions.create(SessionId('unrelated-created'), { meta: { cwd: '/workspace' } })
    const attached = agentCtx.sessions.prepare(sessionId, { meta: header, seed })
    agentCtx.sessions.enter(attached)
    agentCtx.sessions.announce(attached)
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'event', event: { type: 'session/end-seed', seq: 1 } },
    })
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'event', event: { type: 'fixture/setup-one', seq: 2 } },
    })
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'event', event: { type: 'fixture/setup-two', seq: 3 } },
    })
    append(attached, 'fixture/live', {})
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: 'event', event: { type: 'fixture/live', seq: 4 } },
    })

    abort.abort()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
  })

  it('rejects gaps in replayed and live event sequences', async () => {
    const replay = await setup()
    const replayId = SessionId('replay-gap')
    const replayHeader: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: replayId,
      createdAt: 1,
      cwd: '/workspace',
      isSeeded: false,
    }
    cold(replay.ctx, replayHeader, [event('fixture/start', SessionSeq(0)), event('fixture/gap', SessionSeq(2))])
    const replayed = replay.transport.follow({
      address: { kind: 'session', sessionId: replayId },
    }, signal())[Symbol.asyncIterator]()
    await expect(replayed.next()).rejects.toMatchObject({ code: 'SESSION_QUERY_CORRUPT_SESSION' })

    const live = await setup()
    const session = live.ctx.sessions.create(SessionId('live-gap'), { meta: { cwd: '/workspace' } })
    append(session, 'fixture/start', {})
    live.ctx.provide('agents', { get: () => ({ id: session.id }) } as never)
    const followed = live.transport.follow({
      address: { kind: 'session', sessionId: session.id },
    }, signal())[Symbol.asyncIterator]()
    await expect(followed.next()).resolves.toMatchObject({ done: false, value: { type: 'snapshot', cursor: 0 } })
    const skipped = event('fixture/skipped', SessionSeq(1))
    const gap = event('fixture/gap', SessionSeq(2))
    live.ctx.emit('session/event', eventSession(
      session.header,
      [event('fixture/start', SessionSeq(0)), skipped, gap],
    ), gap)
    await expect(followed.next()).rejects.toMatchObject({ code: 'gateway/internal' })
  })

  it('opens an empty source at cursor -1', async () => {
    const { ctx, transport } = await setup()
    const session = ctx.sessions.create(SessionId('empty-follow'), { meta: { cwd: '/workspace' } })
    const abort = new AbortController()
    const iterator = transport.follow({
      address: { kind: 'session', sessionId: session.id },
    }, abort.signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { type: 'snapshot', cursor: -1 } })
    await expect(transport.page({
      address: { kind: 'session', sessionId: session.id }, throughSeq: -1,
    }, signal())).resolves.toMatchObject({ records: [], hasMore: false })
    abort.abort()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
  })

  it('publishes an empty projection baseline when the query has no registry', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const sessionId = SessionId('projectionless-follow')
    const meta: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: 1,
      cwd: '/workspace',
      isSeeded: false,
    }
    ctx.provide('sessionQuery', {
      observeSession: () => Promise.resolve({
        source: 'live',
        header: meta,
        inheritedEventCount: SessionLogOffset(0),
        events: [],
        cursor: -1,
        retain: vi.fn(), [Symbol.dispose]: vi.fn(),
      } satisfies SessionObservation),
    } as never)
    const history = new SessionHistoryController(ctx, vi.fn())
    const abort = new AbortController()
    const iterator = history.follow({ address: { kind: 'session', sessionId } }, abort.signal)
      [Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'snapshot', projections: { asOfSeq: -1, values: {} } },
    })
    abort.abort()
    await expect(iterator.next()).resolves.toMatchObject({ done: true })
    await ctx.fiber.dispose()
  })

  it('disposes a retained promotion when background activation rejects synchronously', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const sessionId = SessionId('promotion-failure')
    const meta = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, cwd: '/workspace' }
    const disposePromotion = vi.fn()
    const promotion = {
      source: 'prepared', header: meta, events: [], cursor: -1,
      projections: { asOfSeq: -1, values: {} },
      retain: vi.fn(), [Symbol.dispose]: disposePromotion,
    } as unknown as SessionObservation
    const source = {
      ...promotion,
      retain: () => promotion,
      [Symbol.dispose]: vi.fn(),
    } as SessionObservation
    ctx.provide('sessionQuery', {
      observeSession: () => Promise.resolve(source),
    } as never)
    const history = new SessionHistoryController(ctx, () => { throw new Error('activation failed') })
    const iterator = history.follow({ address: { kind: 'session', sessionId } }, signal())
      [Symbol.asyncIterator]()

    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'snapshot' } })
    await expect(iterator.next()).rejects.toThrow('activation failed')
    expect(disposePromotion).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('requires the durable parent and mode for a direct subagent address', async () => {
    const { ctx, transport } = await setup()
    const parentSessionId = SessionId('parent')
    const childSessionId = SessionId('child')
    ctx.sessions.create(parentSessionId, { meta: { cwd: '/workspace' } })
    const child = ctx.sessions.create(childSessionId, {
      meta: { cwd: '/workspace', origin: 'subagent', parentSession: parentSessionId },
    })
    child.append('subagent/descriptor', snapshotSubagentDescriptor({
      mode: 'continuable',
      provider: 'test',
      label: 'child',
    }))
    const signal = new AbortController().signal

    await expect(transport.page({
      address: { kind: 'subagent', parentSessionId, childSessionId, mode: 'continuable' },
      throughSeq: 0,
    }, signal)).resolves.toMatchObject({
      records: [{ type: 'event', event: { type: 'subagent/descriptor' } }],
    })
    await expect(transport.page({
      address: {
        kind: 'subagent',
        parentSessionId: SessionId('other-parent'),
        childSessionId,
        mode: 'continuable',
      },
      throughSeq: 0,
    }, signal)).rejects.toMatchObject({ code: 'subagent/unauthorized' })
    await expect(transport.page({
      address: { kind: 'subagent', parentSessionId, childSessionId, mode: 'one-shot' },
      throughSeq: 0,
    }, signal)).rejects.toMatchObject({ code: 'subagent/unauthorized' })
    await expect(transport.page({
      address: { kind: 'session', sessionId: childSessionId },
      throughSeq: 0,
    }, signal)).rejects.toMatchObject({ code: 'session/agent-busy' })
  })

  it('preserves a cold inspection failure for the Gateway error branch', async () => {
    const { ctx, transport } = await setup()
    const sessionId = SessionId('corrupt-cold')
    const failure = new Error('cold log is corrupt')
    const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, isSeeded: false, cwd: '/workspace' }
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: () => Promise.resolve([header]),
      inspect: () => Promise.reject(failure),
    }) as never)

    await expect(transport.page({
      address: { kind: 'session', sessionId },
      throughSeq: -1,
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'SESSION_QUERY_PERSISTENCE_FAILED',
      cause: failure,
    })
  })

  it('rejects malformed page and follow cursors at the service boundary', async () => {
    const { ctx, transport } = await setup()
    const session = ctx.sessions.create(SessionId('validation'), { meta: { cwd: '/workspace' } })
    const address = { kind: 'session' as const, sessionId: session.id }
    for (const request of [
      { address, throughSeq: -2 },
      { address, throughSeq: -0 },
      { address, throughSeq: 0.5 },
      { address, throughSeq: -1, beforeSeq: -1 },
      { address, throughSeq: -1, beforeSeq: -0 },
      { address, throughSeq: -1, beforeSeq: 1.5 },
      { address, throughSeq: -1, maxMessages: 0 },
      { address, throughSeq: -1, maxMessages: 1.5 },
    ]) {
      await expect(transport.page(request, signal())).rejects.toMatchObject({ code: 'gateway/bad-request' })
    }
    await expect(transport.page({ address, throughSeq: 0 }, signal()))
      .rejects.toMatchObject({ code: 'gateway/bad-request' })

    const corrupt = await setup()
    const corruptId = SessionId('missing-through-seq')
    cold(
      corrupt.ctx,
      { version: SESSION_FORMAT_VERSION, id: corruptId, createdAt: 1, cwd: '/workspace', isSeeded: false },
      [event('fixture/start', SessionSeq(0)), event('fixture/gap', SessionSeq(2))],
    )
    await expect(corrupt.transport.page({
      address: { kind: 'session', sessionId: corruptId }, throughSeq: 1,
    }, signal())).rejects.toMatchObject({ code: 'SESSION_QUERY_CORRUPT_SESSION' })
    for (const maxMessages of [0, 0.5]) {
      const iterator = transport.follow({ address, maxMessages }, signal())[Symbol.asyncIterator]()
      await expect(iterator.next()).rejects.toMatchObject({ code: 'gateway/bad-request' })
    }
  })

  it('reports missing ordinary and subagent sources without fabricating inspection failures', async () => {
    const { ctx, transport } = await setup()
    const ordinary = { kind: 'session' as const, sessionId: SessionId('missing') }
    await expect(transport.page({ address: ordinary, throughSeq: -1 }, signal()))
      .rejects.toMatchObject({ code: 'session/not-found' })

    const inspect = vi.fn(() => Promise.resolve(undefined))
    const stat = vi.fn(() => Promise.resolve(undefined))
    ctx.provide('sessionPersistence', testSessionPersistence(ctx, {
      list: () => Promise.resolve([]),
      stat,
      inspect,
    }) as never)
    await expect(transport.page({ address: ordinary, throughSeq: -1 }, signal()))
      .rejects.toMatchObject({ code: 'session/not-found' })
    await expect(transport.page({
      address: {
        kind: 'subagent',
        parentSessionId: SessionId('parent'),
        childSessionId: SessionId('missing-child'),
        mode: 'continuable',
      },
      throughSeq: -1,
    }, signal())).rejects.toMatchObject({ code: 'subagent/not-found' })
    // Absence is decided by the stat preflight; no log open is attempted.
    expect(stat).toHaveBeenCalledTimes(2)
    expect(inspect).not.toHaveBeenCalled()
  })

  it('rejects incomplete cold metadata before serving a source', async () => {
    const first = await setup()
    const sessionId = SessionId('incomplete')
    const address = { kind: 'session' as const, sessionId }
    const firstHeader: SessionHeader = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, isSeeded: false }
    first.ctx.provide('sessionPersistence', testSessionPersistence(first.ctx, {
      list: () => Promise.resolve([firstHeader]),
      inspect: () => Promise.resolve({
        meta: firstHeader,
        inheritedEventCount: SessionLogOffset(0),
        events: [],
      }),
    }) as never)
    await expect(first.transport.page({ address, throughSeq: -1 }, signal()))
      .rejects.toMatchObject({ code: 'session/not-found' })

    const second = await setup()
    const listed: SessionHeader = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, cwd: '/workspace', isSeeded: false }
    const inspected: SessionHeader = { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1, isSeeded: false }
    second.ctx.provide('sessionPersistence', testSessionPersistence(second.ctx, {
      list: () => Promise.resolve([listed]),
      inspect: () => Promise.resolve({
        meta: inspected,
        inheritedEventCount: SessionLogOffset(0),
        events: [],
      }),
    }) as never)
    await expect(second.transport.page({ address, throughSeq: -1 }, signal()))
      .rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('serves cold ordinary history and validates every durable subagent descriptor state', async () => {
    const ordinaryBench = await setup()
    const ordinaryId = SessionId('cold-ordinary')
    const ordinaryHeader: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: ordinaryId,
      createdAt: 1,
      cwd: '/workspace',
      isSeeded: false,
    }
    cold(ordinaryBench.ctx, ordinaryHeader, [event('turn/start', SessionSeq(0), { turn: 1 })])
    await expect(ordinaryBench.transport.page({
      address: { kind: 'session', sessionId: ordinaryId },
      throughSeq: 0,
    }, signal())).resolves.toMatchObject({
      records: [{ type: 'event', event: { seq: 0 } }],
    })

    const parentSessionId = SessionId('cold-parent')
    const childSessionId = SessionId('cold-child')
    const childHeader: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: childSessionId,
      createdAt: 1,
      cwd: '/workspace',
      isSeeded: false,
      origin: 'subagent' as const,
      parentSession: parentSessionId,
    }
    const childAddress = {
      kind: 'subagent' as const,
      parentSessionId,
      childSessionId,
      mode: 'continuable' as const,
    }
    const missing = await setup()
    cold(missing.ctx, childHeader, [])
    await expect(missing.transport.page({ address: childAddress, throughSeq: -1 }, signal()))
      .rejects.toMatchObject({ code: 'subagent/catalog-diagnostic', details: { reason: 'corrupt' } })

    const corrupt = await setup()
    cold(corrupt.ctx, childHeader, [event('subagent/descriptor', SessionSeq(0), { version: 'bad' })])
    await expect(corrupt.transport.page({ address: childAddress, throughSeq: 0 }, signal()))
      .rejects.toMatchObject({ code: 'subagent/catalog-diagnostic', details: { reason: 'corrupt' } })

    const ordinaryChild = await setup()
    const { origin: _origin, ...ordinaryChildHeader } = childHeader
    cold(ordinaryChild.ctx, ordinaryChildHeader, [])
    await expect(ordinaryChild.transport.page({ address: childAddress, throughSeq: -1 }, signal()))
      .rejects.toMatchObject({ code: 'subagent/unauthorized' })
  })

  it('reports an unavailable descriptor when an observed child has no projection value', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const parentSessionId = SessionId('missing-projection-parent')
    const childSessionId = SessionId('missing-projection-child')
    const meta: SessionHeader = {
      version: SESSION_FORMAT_VERSION,
      id: childSessionId,
      createdAt: 1,
      cwd: '/workspace',
      isSeeded: false,
      origin: 'subagent',
      parentSession: parentSessionId,
    }
    ctx.provide('sessionQuery', {
      observeSession: () => Promise.resolve({
        source: 'live',
        header: meta,
        inheritedEventCount: SessionLogOffset(0),
        events: [],
        cursor: -1,
        projections: { asOfSeq: -1, values: {} },
        retain: vi.fn(), [Symbol.dispose]: vi.fn(),
      } as unknown as SessionObservation),
    } as never)
    const history = new SessionHistoryController(ctx, vi.fn())

    await expect(history.page({
      address: { kind: 'subagent', parentSessionId, childSessionId, mode: 'continuable' },
      throughSeq: -1,
    }, signal())).rejects.toMatchObject({
      code: 'subagent/catalog-diagnostic', details: { reason: 'unsupported' },
    })
    await ctx.fiber.dispose()
  })

  it('keeps pages projection-free and computes projections only for child authorization', async () => {
    const ordinary = await setup()
    const session = ordinary.ctx.sessions.create(SessionId('projected'), { meta: { cwd: '/workspace' } })
    session.append('turn/start', { turn: 1 })
    const ordinarySnapshot = vi.spyOn(ordinary.ctx.sessionProjections, 'snapshot')
    const ordinaryPage = await ordinary.transport.page({
      address: { kind: 'session', sessionId: session.id },
      throughSeq: 0,
    }, signal())
    expect('projections' in ordinaryPage).toBe(false)
    expect(ordinarySnapshot).not.toHaveBeenCalled()

    const child = await setup()
    const parentSessionId = SessionId('projection-parent')
    const childSessionId = SessionId('projection-child')
    const childSession = child.ctx.sessions.create(childSessionId, {
      meta: { cwd: '/workspace', origin: 'subagent', parentSession: parentSessionId },
    })
    childSession.append('subagent/descriptor', snapshotSubagentDescriptor({
      mode: 'continuable', provider: 'test', label: 'child',
    }))
    const childSnapshot = vi.spyOn(child.ctx.sessionProjections, 'snapshot')
    const page = await child.transport.page({
      address: { kind: 'subagent', parentSessionId, childSessionId, mode: 'continuable' },
      throughSeq: 0,
    }, signal())
    expect('projections' in page).toBe(false)
    expect(childSnapshot).toHaveBeenCalledWith(childSession)
  })

  it('keeps message-aligned pagination contiguous across replacement provenance', async () => {
    const { ctx, transport } = await setup()
    const session = ctx.sessions.create(SessionId('pagination'), { meta: { cwd: '/workspace' } })
    session.append('turn/start', { turn: 1 })
    append(session, 'user/message', { content: [], source: { kind: 'user' } }, { surfaceOp: 'append' })
    const firstReply = append(session, 'assistant/message', { turn: 1, step: 1, message: {} }, { surfaceOp: 'append' })
    append(session, 'user/message', { content: [], source: { kind: 'user' } }, { surfaceOp: 'append' })
    append(session, 'assistant/message', { turn: 1, step: 2, message: {} }, { surfaceOp: 'append' })
    const summary = append(session, 'fixture/summary', {})
    const replacement = append(session, 'user/message', { content: [], source: { kind: 'plugin' } }, {
      surfaceOp: { op: 'replace', start: SessionSeq(1), end: SessionSeq(4) },
      sourceEventSeqs: [SessionSeq(1), firstReply.seq, SessionSeq(3), SessionSeq(4), summary.seq],
    })

    const page = await transport.page({
      address: { kind: 'session', sessionId: session.id }, throughSeq: replacement.seq, maxMessages: 2,
    }, signal())
    expect(page.records.map(entry => entry.event.seq))
      .toEqual([3, 4, 5, replacement.seq])
    expect(page.hasMore).toBe(true)
    const before = await transport.page({
      address: { kind: 'session', sessionId: session.id }, throughSeq: replacement.seq, beforeSeq: 3, maxMessages: 1,
    }, signal())
    expect(before.records.map(entry => entry.event.seq)).toEqual([2])
  })

  it('keeps cited source events in the page that owns their appended message', async () => {
    const { ctx, transport } = await setup()
    const session = ctx.sessions.create(SessionId('pagination-sources'), { meta: { cwd: '/workspace' } })
    const source = append(session, 'fixture/source', {})
    append(session, 'user/message', { content: [], source: { kind: 'plugin' } }, {
      surfaceOp: 'append', sourceEventSeqs: [source.seq],
    })

    const page = await transport.page({
      address: { kind: 'session', sessionId: session.id }, throughSeq: 1, maxMessages: 1,
    }, signal())
    expect(page.records.map(entry => entry.event.seq)).toEqual([0, 1])
    expect(page.hasMore).toBe(false)
  })

})
