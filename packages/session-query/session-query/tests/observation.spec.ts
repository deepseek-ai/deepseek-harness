import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import SessionPersistence, {
  SessionPersistenceCorruptionError,
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  SessionReadOnlyError,
} from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionAccess,
  SessionHandle,
  SessionHandleReadOptions,
  SessionPersistenceSnapshot,
  SessionPersistenceStatOptions,
} from '@deepseek-ai/dsh-session-persistence'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, vi } from 'vitest'
import { SessionObservationReader } from '../src/observation.ts'

function header(id: string): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, isSeeded: false, cwd: '/workspace' }
}

function messageEvent(seq: number, text: string): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: seq + 1,
    data: createUserMessage({
      content: [{ type: 'text', text }], source: { kind: 'user' },
    }),
    surfaceOp: 'append',
  }
}

/** A log whose writer crashed mid-turn: read-only viewing must balance it in memory. */
function interruptedLog(text: string): SessionEvent[] {
  return [
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    messageEvent(1, text),
  ]
}

interface StoredEntry {
  header: SessionHeader
  events: SessionEvent[]
  revision: string
}

interface StubCounters {
  stat: number
  open: number
  read: number
}

interface StubHooks {
  /** Runs inside `stat` before it resolves. */
  onStat?: () => void
  /** Runs inside `read` before it resolves. */
  onRead?: () => void
  /** Replaces the read result for every open handle. */
  readFailure?: unknown
  /** Replaces the stat result. */
  statFailure?: unknown
}

/** Object-stub persistence: only the members the observation reader touches. */
function stubPersistence(
  store: Map<SessionIdType, StoredEntry>,
  counters: StubCounters,
  hooks: StubHooks = {},
): SessionPersistence {
  const stat = (
    id: SessionIdType,
    options?: SessionPersistenceStatOptions,
  ): Promise<SessionPersistenceSnapshot | undefined> => {
    counters.stat += 1
    void options
    const entry = store.get(id)
    hooks.onStat?.()
    if (hooks.statFailure !== undefined) {
      // Exercise containment of a backend violating the Error rejection convention.
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors
      return Promise.reject(hooks.statFailure)
    }
    if (entry === undefined) return Promise.resolve(undefined)
    return Promise.resolve({
      header: structuredClone(entry.header),
      revision: SessionPersistenceRevision(entry.revision),
    })
  }
  const open = (id: SessionIdType, access: SessionAccess): Promise<SessionHandle> => {
    counters.open += 1
    const entry = store.get(id)
    if (entry === undefined) return Promise.reject(new SessionPersistenceNotFoundError(id))
    const handle: SessionHandle = {
      id,
      header: structuredClone(entry.header),
      inheritedEventCount: SessionLogOffset(0),
      access,
      read: (
        _offset?: number,
        _length?: number,
        options?: SessionHandleReadOptions,
      ): Promise<readonly SessionEvent[]> => {
        counters.read += 1
        void options
        hooks.onRead?.()
        if (hooks.readFailure !== undefined) {
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors
          return Promise.reject(hooks.readFailure)
        }
        return Promise.resolve(structuredClone(entry.events))
      },
      append: () => Promise.reject(new SessionReadOnlyError(id, 'append')),
      flush: () => Promise.reject(new SessionReadOnlyError(id, 'flush')),
      close: () => Promise.resolve(),
      [Symbol.asyncDispose]: () => Promise.resolve(),
    }
    return Promise.resolve(handle)
  }
  return { stat, open } as never
}

async function readerContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return ctx
}

describe('SessionObservationReader live path', () => {
  it('creates independent live leases and rejects retention after disposal', async () => {
    const ctx = await readerContext()
    const session = ctx.sessions.create(SessionId('live-leases'), { meta: { cwd: '/workspace' } })
    const reader = new SessionObservationReader(ctx)
    const observed = await reader.read(session.id, { projectionMode: 'none' })
    const retained = observed.retain()

    observed[Symbol.dispose]()
    expect(() => observed.retain()).toThrow('is disposed')
    expect(retained.source).toBe('live')
    retained[Symbol.dispose]()
    await ctx.fiber.dispose()
  })

  it('computes live projections when the registry is mounted and surfaces its failure raw', async () => {
    const ctx = await readerContext()
    await ctx.plugin(SessionProjectionRegistry)
    const session = ctx.sessions.create(SessionId('live-projections'))
    const reader = new SessionObservationReader(ctx)

    using observed = await reader.read(session.id)
    expect(observed.projections).toBeDefined()

    vi.spyOn(ctx.sessionProjections, 'snapshot').mockImplementation(() => {
      throw new Error('projection failed')
    })
    await expect(reader.read(session.id)).rejects.toThrow('projection failed')
    await ctx.fiber.dispose()
  })

  it('reports a missing session when no persistence service is mounted', async () => {
    const ctx = await readerContext()
    await expect(new SessionObservationReader(ctx).read(SessionId('absent'))).rejects.toMatchObject({
      code: 'SESSION_QUERY_SESSION_NOT_FOUND',
    })
    await ctx.fiber.dispose()
  })
})

describe('SessionObservationReader cold path', () => {
  it('balances an interrupted stored turn in memory and exposes the durable revision', async () => {
    const ctx = await readerContext()
    const meta = header('interrupted-cold')
    const store = new Map([[meta.id, { header: meta, events: interruptedLog('crashed'), revision: 'r1' }]])
    const counters = { stat: 0, open: 0, read: 0 }
    ctx.provide('sessionPersistence', stubPersistence(store, counters))
    const reader = new SessionObservationReader(ctx)

    using observed = await reader.read(meta.id)

    expect(observed.source).toBe('prepared')
    expect(observed.header).toMatchObject({ id: meta.id, cwd: '/workspace' })
    expect(observed.revision).toBe(SessionPersistenceRevision('r1'))
    expect(observed.events.map(event => event.type)).toEqual(['turn/start', 'user/message', 'turn/end'])
    expect(observed.cursor).toBe(2)
    // No projection registry is mounted, so the observation carries none.
    expect(observed.projections).toBeUndefined()
    // Balancing is in-memory only: nothing was written back to the store.
    expect(store.get(meta.id)?.events).toHaveLength(2)
    await ctx.fiber.dispose()
  })

  it('observes an empty stored log with a -1 cursor', async () => {
    const ctx = await readerContext()
    const meta = header('empty-cold')
    const store = new Map([[meta.id, { header: meta, events: [], revision: 'r1' }]])
    ctx.provide('sessionPersistence', stubPersistence(store, { stat: 0, open: 0, read: 0 }))

    using observed = await new SessionObservationReader(ctx).read(meta.id, { projectionMode: 'none' })

    expect(observed.events).toEqual([])
    expect(observed.cursor).toBe(-1)
    await ctx.fiber.dispose()
  })

  it('reference-counts prepared leases and rejects retention after disposal', async () => {
    const ctx = await readerContext()
    const meta = header('prepared-leases')
    const store = new Map([[meta.id, { header: meta, events: [messageEvent(0, 'kept')], revision: 'r1' }]])
    const counters = { stat: 0, open: 0, read: 0 }
    ctx.provide('sessionPersistence', stubPersistence(store, counters))
    const reader = new SessionObservationReader(ctx)
    const observed = await reader.read(meta.id, { projectionMode: 'none' })
    const retained = observed.retain()

    observed[Symbol.dispose]()
    observed[Symbol.dispose]()
    expect(() => observed.retain()).toThrow('is disposed')
    retained[Symbol.dispose]()
    await ctx.fiber.dispose()
  })

  it('serves an unchanged revision from its cache without re-reading the log', async () => {
    const ctx = await readerContext()
    const meta = header('cache-hit')
    const store = new Map([[meta.id, { header: meta, events: [messageEvent(0, 'stable')], revision: 'r1' }]])
    const counters = { stat: 0, open: 0, read: 0 }
    ctx.provide('sessionPersistence', stubPersistence(store, counters))
    const reader = new SessionObservationReader(ctx)

    using first = await reader.read(meta.id, { projectionMode: 'none' })
    using second = await reader.read(meta.id, { projectionMode: 'none' })

    expect(counters).toEqual({ stat: 2, open: 1, read: 1 })
    expect(second.events).toBe(first.events)
    await ctx.fiber.dispose()
  })

  it('reloads when the durable revision changes', async () => {
    const ctx = await readerContext()
    const meta = header('cache-stale')
    const entry = { header: meta, events: [messageEvent(0, 'old')], revision: 'r1' }
    const store = new Map([[meta.id, entry]])
    const counters = { stat: 0, open: 0, read: 0 }
    ctx.provide('sessionPersistence', stubPersistence(store, counters))
    const reader = new SessionObservationReader(ctx)

    using first = await reader.read(meta.id, { projectionMode: 'none' })
    entry.events = [messageEvent(0, 'old'), messageEvent(1, 'new')]
    entry.revision = 'r2'
    using second = await reader.read(meta.id, { projectionMode: 'none' })

    expect(counters).toEqual({ stat: 2, open: 2, read: 2 })
    expect(first.cursor).toBe(0)
    expect(second.cursor).toBe(1)
    expect(second.revision).toBe(SessionPersistenceRevision('r2'))
    await ctx.fiber.dispose()
  })

  it('keeps pinned entries cached past the capacity and never evicts them', async () => {
    const ctx = await readerContext()
    const a = header('pinned-a')
    const b = header('pinned-b')
    const store = new Map([
      [a.id, { header: a, events: [messageEvent(0, 'a')], revision: 'ra' }],
      [b.id, { header: b, events: [messageEvent(0, 'b')], revision: 'rb' }],
    ])
    const counters = { stat: 0, open: 0, read: 0 }
    ctx.provide('sessionPersistence', stubPersistence(store, counters))
    const reader = new SessionObservationReader(ctx, 1)

    const pinnedA = await reader.read(a.id, { projectionMode: 'none' })
    using pinnedB = await reader.read(b.id, { projectionMode: 'none' })
    // Both entries are pinned by live leases, so both stay cached over capacity.
    using hitA = await reader.read(a.id, { projectionMode: 'none' })
    using hitB = await reader.read(b.id, { projectionMode: 'none' })

    expect(counters.read).toBe(2)
    expect(hitA.events).toBe(pinnedA.events)
    expect(hitB.events).toBe(pinnedB.events)
    pinnedA[Symbol.dispose]()
    await ctx.fiber.dispose()
  })

  it('continues evicting past pinned entries until the cache reaches its bound', async () => {
    const ctx = await readerContext()
    const a = header('sweep-a')
    const b = header('sweep-b')
    const c = header('sweep-c')
    const store = new Map([
      [a.id, { header: a, events: [messageEvent(0, 'a')], revision: 'ra' }],
      [b.id, { header: b, events: [messageEvent(0, 'b')], revision: 'rb' }],
      [c.id, { header: c, events: [messageEvent(0, 'c')], revision: 'rc' }],
    ])
    const counters = { stat: 0, open: 0, read: 0 }
    ctx.provide('sessionPersistence', stubPersistence(store, counters))
    const reader = new SessionObservationReader(ctx, 1)

    using pinnedA = await reader.read(a.id, { projectionMode: 'none' })
    void pinnedA
    {
      using observedB = await reader.read(b.id, { projectionMode: 'none' })
      void observedB
    }
    {
      // Storing C sweeps past pinned A and evicts unpinned B, and the cache
      // stays over its bound because the remaining entries are protected.
      using observedC = await reader.read(c.id, { projectionMode: 'none' })
      void observedC
    }
    expect(counters.read).toBe(3)
    using hitA = await reader.read(a.id, { projectionMode: 'none' })
    void hitA
    expect(counters.read).toBe(3)
    using rereadB = await reader.read(b.id, { projectionMode: 'none' })
    void rereadB
    expect(counters.read).toBe(4)
    await ctx.fiber.dispose()
  })

  it('evicts on lease release when pins forced the cache over its bound', async () => {
    const ctx = await readerContext()
    const a = header('release-a')
    const b = header('release-b')
    const store = new Map([
      [a.id, { header: a, events: [messageEvent(0, 'a')], revision: 'ra' }],
      [b.id, { header: b, events: [messageEvent(0, 'b')], revision: 'rb' }],
    ])
    const counters = { stat: 0, open: 0, read: 0 }
    ctx.provide('sessionPersistence', stubPersistence(store, counters))
    const reader = new SessionObservationReader(ctx, 1)

    const pinnedA = await reader.read(a.id, { projectionMode: 'none' })
    {
      using observedB = await reader.read(b.id, { projectionMode: 'none' })
      void observedB
    }
    // B's release found the cache over its bound (A stayed pinned) and evicted
    // the just-unpinned B instead of leaving it resident for good.
    expect(counters.read).toBe(2)
    {
      using rereadB = await reader.read(b.id, { projectionMode: 'none' })
      void rereadB
    }
    expect(counters.read).toBe(3)
    pinnedA[Symbol.dispose]()
    await ctx.fiber.dispose()
  })

  it('a release sweep keeps evicting while the cache stays over its bound', async () => {
    const ctx = await readerContext()
    const a = header('sweep-release-a')
    const b = header('sweep-release-b')
    const c = header('sweep-release-c')
    const store = new Map([
      [a.id, { header: a, events: [messageEvent(0, 'a')], revision: 'ra' }],
      [b.id, { header: b, events: [messageEvent(0, 'b')], revision: 'rb' }],
      [c.id, { header: c, events: [messageEvent(0, 'c')], revision: 'rc' }],
    ])
    const counters = { stat: 0, open: 0, read: 0 }
    ctx.provide('sessionPersistence', stubPersistence(store, counters))
    const reader = new SessionObservationReader(ctx, 1)

    const pinnedA = await reader.read(a.id, { projectionMode: 'none' })
    const pinnedB = await reader.read(b.id, { projectionMode: 'none' })
    const pinnedC = await reader.read(c.id, { projectionMode: 'none' })
    // B's release evicts B but the cache is still over its bound past the
    // remaining pins, so the sweep continues (and finds only pinned entries).
    pinnedB[Symbol.dispose]()
    pinnedC[Symbol.dispose]()
    expect(counters.read).toBe(3)
    {
      using rereadB = await reader.read(b.id, { projectionMode: 'none' })
      void rereadB
    }
    expect(counters.read).toBe(4)
    pinnedA[Symbol.dispose]()
    await ctx.fiber.dispose()
  })

  it('evicts the least recently used unpinned entry at the capacity bound', async () => {
    const ctx = await readerContext()
    const a = header('lru-a')
    const b = header('lru-b')
    const c = header('lru-c')
    const store = new Map([
      [a.id, { header: a, events: [messageEvent(0, 'a')], revision: 'ra' }],
      [b.id, { header: b, events: [messageEvent(0, 'b')], revision: 'rb' }],
      [c.id, { header: c, events: [messageEvent(0, 'c')], revision: 'rc' }],
    ])
    const counters = { stat: 0, open: 0, read: 0 }
    ctx.provide('sessionPersistence', stubPersistence(store, counters))
    const reader = new SessionObservationReader(ctx, 2)
    const readOnce = async (id: SessionIdType): Promise<void> => {
      using observed = await reader.read(id, { projectionMode: 'none' })
      void observed
    }

    await readOnce(a.id)
    await readOnce(b.id)
    await readOnce(a.id) // cache hit; A becomes most recently used
    expect(counters.read).toBe(2)
    await readOnce(c.id) // evicts B (least recently used), keeps A
    expect(counters.read).toBe(3)
    await readOnce(a.id)
    expect(counters.read).toBe(3)
    await readOnce(b.id)
    expect(counters.read).toBe(4)
    await ctx.fiber.dispose()
  })

  it('discards cached revisions produced by a replaced persistence instance', async () => {
    const meta = header('swapped-instance')

    class SwapHandle implements SessionHandle {
      readonly inheritedEventCount = SessionLogOffset(0)
      constructor(readonly id: SessionIdType, readonly header: SessionHeader, readonly access: SessionAccess) {}
      read(): Promise<readonly SessionEvent[]> {
        SwapPersistence.readCalls += 1
        return Promise.resolve([messageEvent(0, 'swap')])
      }

      append(): Promise<void> {
        return Promise.reject(new SessionReadOnlyError(this.id, 'append'))
      }

      flush(): Promise<void> {
        return Promise.reject(new SessionReadOnlyError(this.id, 'flush'))
      }

      close(): Promise<void> {
        return Promise.resolve()
      }

      [Symbol.asyncDispose](): Promise<void> {
        return this.close()
      }
    }

    class SwapPersistence extends SessionPersistence {
      static readCalls = 0

      create(): Promise<SessionHandle> {
        return Promise.reject(new Error('not used'))
      }

      // Appends are durable on resolution here; nothing buffers, so the service-wide flush is a no-op.
      async flush(): Promise<void> {}

      open(id: SessionIdType, access: SessionAccess): Promise<SessionHandle> {
        return Promise.resolve(new SwapHandle(id, structuredClone(meta), access))
      }

      stat(): Promise<SessionPersistenceSnapshot | undefined> {
        return Promise.resolve({
          header: structuredClone(meta),
          revision: SessionPersistenceRevision('constant'),
        })
      }

      list(): Promise<readonly SessionPersistenceSnapshot[]> {
        return Promise.resolve([])
      }
    }

    const ctx = await readerContext()
    const reader = new SessionObservationReader(ctx)
    const first = await ctx.plugin(SwapPersistence)
    {
      using observed = await reader.read(meta.id, { projectionMode: 'none' })
      void observed
    }
    expect(SwapPersistence.readCalls).toBe(1)
    await first.dispose()
    const second = await ctx.plugin(SwapPersistence)
    {
      using observed = await reader.read(meta.id, { projectionMode: 'none' })
      void observed
    }
    // The revision string matches, but revisions from different instances are
    // incomparable, so the cached entry must not be reused.
    expect(SwapPersistence.readCalls).toBe(2)
    await second.dispose()
    await ctx.fiber.dispose()
  })

  it('prefers a live Session that attaches while the cold log is read', async () => {
    const ctx = await readerContext()
    const meta = header('attached-during-read')
    const store = new Map([[meta.id, { header: meta, events: [messageEvent(0, 'stale')], revision: 'r1' }]])
    const counters = { stat: 0, open: 0, read: 0 }
    ctx.provide('sessionPersistence', stubPersistence(store, counters, {
      onRead: () => {
        ctx.sessions.create(meta.id, {
          meta: { createdAt: meta.createdAt, ...meta.cwd === undefined ? {} : { cwd: meta.cwd } },
        })
      },
    }))

    using observed = await new SessionObservationReader(ctx).read(meta.id, { projectionMode: 'none' })

    expect(observed.source).toBe('live')
    await ctx.fiber.dispose()
  })

  it('prefers a live Session that attaches while the snapshot is stated', async () => {
    const ctx = await readerContext()
    const meta = header('attached-during-stat')
    const store = new Map([[meta.id, { header: meta, events: [messageEvent(0, 'stale')], revision: 'r1' }]])
    const counters = { stat: 0, open: 0, read: 0 }
    ctx.provide('sessionPersistence', stubPersistence(store, counters, {
      onStat: () => {
        ctx.sessions.create(meta.id, {
          meta: { createdAt: meta.createdAt, ...meta.cwd === undefined ? {} : { cwd: meta.cwd } },
        })
      },
    }))

    using observed = await new SessionObservationReader(ctx).read(meta.id, { projectionMode: 'none' })

    expect(observed.source).toBe('live')
    expect(counters.open).toBe(0)
    await ctx.fiber.dispose()
  })

  it('retries the live path when the store rejects preparation for a live owner', async () => {
    const ctx = await readerContext()
    const meta = header('prepare-collision')
    const store = new Map([[meta.id, { header: meta, events: [messageEvent(0, 'stale')], revision: 'r1' }]])
    const counters = { stat: 0, open: 0, read: 0 }
    ctx.provide('sessionPersistence', stubPersistence(store, counters))
    vi.spyOn(ctx.sessions, 'prepare').mockImplementationOnce(() => {
      // A racing owner claims the id between the reader's live check and its
      // preparation; the nested create uses the store's real prepare.
      ctx.sessions.create(meta.id, { meta: { createdAt: meta.createdAt, ...meta.cwd === undefined ? {} : { cwd: meta.cwd } } })
      throw new Error(`session "${meta.id}" already exists`)
    })

    using observed = await new SessionObservationReader(ctx).read(meta.id, { projectionMode: 'none' })

    expect(observed.source).toBe('live')
    await ctx.fiber.dispose()
  })

  it('maps a stored log the restore validation refuses to a corrupt-session failure', async () => {
    const ctx = await readerContext()
    const meta = header('bad-restore')
    const store = new Map([[meta.id, {
      header: meta,
      events: [{ ...messageEvent(0, 'gap'), seq: SessionSeq(5) }],
      revision: 'r1',
    }]])
    ctx.provide('sessionPersistence', stubPersistence(store, { stat: 0, open: 0, read: 0 }))

    await expect(new SessionObservationReader(ctx).read(meta.id)).rejects.toMatchObject({
      code: 'SESSION_QUERY_CORRUPT_SESSION',
      message: expect.stringContaining('is corrupt') as string,
    })
    await ctx.fiber.dispose()
  })

  it('maps stat absence, open not-found, corruption, and non-Error rejections', async () => {
    const ctx = await readerContext()
    const meta = header('failure-taxonomy')
    const counters = { stat: 0, open: 0, read: 0 }
    const store = new Map<SessionIdType, StoredEntry>()
    const hooks: StubHooks = {}
    ctx.provide('sessionPersistence', stubPersistence(store, counters, hooks))
    const reader = new SessionObservationReader(ctx)

    await expect(reader.read(meta.id)).rejects.toMatchObject({
      code: 'SESSION_QUERY_SESSION_NOT_FOUND',
    })

    store.set(meta.id, { header: meta, events: [messageEvent(0, 'gone')], revision: 'r1' })
    hooks.onStat = () => {
      delete hooks.onStat
      // Deleted between stat and open: open reports not-found.
      store.delete(meta.id)
    }
    await expect(reader.read(meta.id)).rejects.toMatchObject({
      code: 'SESSION_QUERY_SESSION_NOT_FOUND',
      cause: expect.any(SessionPersistenceNotFoundError) as Error,
    })

    store.set(meta.id, { header: meta, events: [messageEvent(0, 'torn')], revision: 'r2' })
    hooks.readFailure = new SessionPersistenceCorruptionError('stored prefix failed validation', {
      cause: new Error('torn record'),
    })
    await expect(reader.read(meta.id)).rejects.toMatchObject({
      code: 'SESSION_QUERY_CORRUPT_SESSION',
      message: `stored session "${meta.id}" is corrupt: stored prefix failed validation`,
    })
    hooks.readFailure = undefined

    hooks.statFailure = 'offline'
    await expect(reader.read(meta.id)).rejects.toMatchObject({
      code: 'SESSION_QUERY_PERSISTENCE_FAILED',
      message: expect.stringContaining('unknown error') as string,
    })
    await ctx.fiber.dispose()
  })

  it('reports a header whose id does not match the requested session as a source conflict', async () => {
    const ctx = await readerContext()
    const meta = header('expected-id')
    const store = new Map([[meta.id, {
      header: { ...meta, id: SessionId('other-id') },
      events: [messageEvent(0, 'other')],
      revision: 'r1',
    }]])
    ctx.provide('sessionPersistence', stubPersistence(store, { stat: 0, open: 0, read: 0 }))

    await expect(new SessionObservationReader(ctx).read(meta.id)).rejects.toMatchObject({
      code: 'SESSION_QUERY_SOURCE_CONFLICT',
    })
    await ctx.fiber.dispose()
  })

  it('maps pre-abort, stat-time, read-time, and post-read cancellation to aborted reads', async () => {
    const ctx = await readerContext()
    const meta = header('aborted-cold')
    const store = new Map([[meta.id, { header: meta, events: [messageEvent(0, 'slow')], revision: 'r1' }]])
    const counters = { stat: 0, open: 0, read: 0 }
    const hooks: StubHooks = {}
    ctx.provide('sessionPersistence', stubPersistence(store, counters, hooks))
    const reader = new SessionObservationReader(ctx)

    const preAborted = new AbortController()
    preAborted.abort(new Error('before start'))
    await expect(reader.read(meta.id, { signal: preAborted.signal })).rejects.toMatchObject({
      code: 'SESSION_QUERY_ABORTED',
    })
    expect(counters.stat).toBe(0)

    const statAbort = new AbortController()
    hooks.onStat = () => {
      delete hooks.onStat
      statAbort.abort(new Error('stat deadline'))
      throw new Error('stat interrupted')
    }
    await expect(reader.read(meta.id, { signal: statAbort.signal })).rejects.toMatchObject({
      code: 'SESSION_QUERY_ABORTED',
    })

    const statResolvedAbort = new AbortController()
    hooks.onStat = () => {
      delete hooks.onStat
      statResolvedAbort.abort(new Error('after stat'))
    }
    await expect(reader.read(meta.id, { signal: statResolvedAbort.signal })).rejects.toMatchObject({
      code: 'SESSION_QUERY_ABORTED',
    })

    const readAbort = new AbortController()
    hooks.onRead = () => {
      delete hooks.onRead
      readAbort.abort(new Error('read deadline'))
      throw new Error('read interrupted')
    }
    await expect(reader.read(meta.id, { signal: readAbort.signal })).rejects.toMatchObject({
      code: 'SESSION_QUERY_ABORTED',
    })

    const readResolvedAbort = new AbortController()
    hooks.onRead = () => {
      delete hooks.onRead
      readResolvedAbort.abort(new Error('after read'))
    }
    await expect(reader.read(meta.id, { signal: readResolvedAbort.signal })).rejects.toMatchObject({
      code: 'SESSION_QUERY_ABORTED',
    })
    await ctx.fiber.dispose()
  })

  it('surfaces a read failure that is neither corruption nor absence as a persistence failure', async () => {
    const ctx = await readerContext()
    const meta = header('read-failed')
    const store = new Map([[meta.id, { header: meta, events: [messageEvent(0, 'x')], revision: 'r1' }]])
    ctx.provide('sessionPersistence', stubPersistence(store, { stat: 0, open: 0, read: 0 }, {
      readFailure: new Error('disk detached'),
    }))

    await expect(new SessionObservationReader(ctx).read(meta.id)).rejects.toMatchObject({
      code: 'SESSION_QUERY_PERSISTENCE_FAILED',
      message: expect.stringContaining('disk detached') as string,
    })
    await ctx.fiber.dispose()
  })
})

describe('SessionObservationReader cold projections', () => {
  it('hydrates prepared projections through the registry when no projection cache is mounted', async () => {
    const ctx = await readerContext()
    await ctx.plugin(SessionProjectionRegistry)
    const meta = header('cold-registry')
    const store = new Map([[meta.id, { header: meta, events: [messageEvent(0, 'projected')], revision: 'r1' }]])
    ctx.provide('sessionPersistence', stubPersistence(store, { stat: 0, open: 0, read: 0 }))

    using observed = await new SessionObservationReader(ctx).read(meta.id)

    expect(observed.source).toBe('prepared')
    expect(observed.projections).toBeDefined()
    await ctx.fiber.dispose()
  })

  it('hydrates prepared projections through a mounted projection cache', async () => {
    const ctx = await readerContext()
    await ctx.plugin(SessionProjectionRegistry)
    const meta = header('cold-cache')
    const store = new Map([[meta.id, { header: meta, events: [messageEvent(0, 'cached')], revision: 'r1' }]])
    ctx.provide('sessionPersistence', stubPersistence(store, { stat: 0, open: 0, read: 0 }))
    const snapshot = { asOfSeq: 0, values: {} }
    const hydratePrepared = vi.fn().mockReturnValue(snapshot)
    ctx.provide('sessionProjectionCache', { hydratePrepared } as never)

    using observed = await new SessionObservationReader(ctx).read(meta.id)

    expect(observed.projections).toBe(snapshot)
    expect(hydratePrepared).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('wraps a prepared projection failure as a corrupt-session failure', async () => {
    const ctx = await readerContext()
    await ctx.plugin(SessionProjectionRegistry)
    const meta = header('cold-projection-failure')
    const store = new Map([[meta.id, { header: meta, events: [messageEvent(0, 'broken')], revision: 'r1' }]])
    ctx.provide('sessionPersistence', stubPersistence(store, { stat: 0, open: 0, read: 0 }))
    vi.spyOn(ctx.sessionProjections, 'hydrate').mockImplementation(() => {
      throw new Error('hydration failed')
    })

    await expect(new SessionObservationReader(ctx).read(meta.id)).rejects.toMatchObject({
      code: 'SESSION_QUERY_CORRUPT_SESSION',
      message: expect.stringContaining('failed to project') as string,
    })
    await ctx.fiber.dispose()
  })
})
