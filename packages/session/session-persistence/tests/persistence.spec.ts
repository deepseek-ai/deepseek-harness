import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import { isJsonValue } from '@deepseek-ai/dsh-util-values'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import {
  DEFAULT_PREPARED_SESSION_CACHE_SIZE, DEFAULT_WRITE_BATCH_MAX_DELAY_MS, MAX_WRITE_BATCH_DELAY_MS,
  SessionPersistence, SessionPersistenceRevision, PersistenceCoordinator,
  type PersistenceBackend, type SessionPersistenceSnapshot, type StoredPrefix, type StoredSuffix,
} from '../src/index.ts'
import { runPersistenceContract, meta, oneTurnLog } from './contract.ts'
import {
  legacyMessageLog, preReactLoopLog, runCoordinatorContract, type CoordinatorFixture,
} from './coordinator-contract.ts'

/** The durable store shape: materialized sessions only (no lazy entries). */
type MemoryStore = Map<string, { meta: SessionHeader; events: SessionEvent[] }>

/** Test-store revision that changes for any metadata or event mutation. */
function memoryRevision(entry: { meta: SessionHeader; events: SessionEvent[] }): SessionPersistenceRevision {
  return SessionPersistenceRevision(JSON.stringify(entry))
}

/** An obsolete event fixture that emulates an untyped pre-change producer. */
function legacyHeaderDelta(seq = 0): SessionEvent {
  return {
    type: 'request/header-delta',
    seq,
    time: 1,
    data: { config: { model: 'legacy' } },
  } as unknown as SessionEvent
}

/** An unsupported named-mode fixture emulating an untyped producer. */
function legacyModeSet(seq = 0): SessionEvent {
  return {
    type: 'mode/set',
    seq,
    time: 1,
    data: { mode: 'plan' },
  } as unknown as SessionEvent
}

/** An obsolete full-header reason fixture from the removed delta codec. */
function legacyFallbackHeader(seq = 0): SessionEvent {
  return {
    type: 'request/header',
    seq,
    time: 1,
    data: { header: { config: { model: 'legacy' } }, reason: 'fallback' },
  } as unknown as SessionEvent
}

/** Optional plugin config: an EXTERNAL store shared across backend instances. */
interface MemoryConfig { store?: MemoryStore }

/** Test-only view of the coordinator containers whose retirement is the contract under test. */
interface CoordinatorInternals {
  states: Map<unknown, unknown>
  live: Map<unknown, {
    writes: { pending: unknown[]; active: Promise<void> | undefined; hasWork: boolean }
  }>
  chains: Map<unknown, unknown>
  retirements: Map<unknown, Promise<void>>
}

/**
 * Reference {@link PersistenceCoordinator} vehicle and abstract-service coverage, backed by a
 * dependency-free map with atomic writes and no torn-tail marker. Supplying the map lets multiple
 * instances share materialized sessions, the in-memory analogue of reload over one artifact;
 * durable behavior is covered by the JSONL provider.
 */
class MemoryPersistence extends SessionPersistence implements PersistenceBackend<never> {
  override readonly supportsRawArtifacts = false

  static inject = ['sessions']

  override readonly name = 'session-persistence-memory'

  /** The whole durable store: materialized sessions only (no lazy entries). */
  private store: MemoryStore
  private coordinator: PersistenceCoordinator<never>

  constructor(ctx: Context, config?: MemoryConfig) {
    super(ctx)
    // Assign the store BEFORE constructing the coordinator: the coordinator's
    // constructor installs the write path and synchronously seeds existing live
    // sessions through loadStored(), so store must exist first.
    this.store = config?.store ?? new Map<string, { meta: SessionHeader; events: SessionEvent[] }>()
    this.coordinator = new PersistenceCoordinator<never>(this.ctx, this)
  }

  // --- Service API (delegated to the coordinator) ---

  locate(_meta: SessionHeader): undefined {
    return undefined
  }

  create(m: SessionHeader): Promise<void> {
    return this.coordinator.create(m)
  }

  override ensureMaterialized(session: Session): Promise<void> {
    return this.coordinator.ensureMaterialized(session)
  }

  append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    return this.coordinator.append(id, events)
  }

  override prepare(id: SessionId, signal?: AbortSignal): ReturnType<PersistenceCoordinator['prepare']> {
    return this.coordinator.prepare(id, signal)
  }

  load(id: SessionId): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.load(id).then(loaded => ({ meta: loaded.meta, events: [...loaded.events] }))
  }

  inspect(id: SessionId, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.inspect(id, signal)
      .then(loaded => ({ meta: loaded.meta, events: [...loaded.events] }))
  }

  borrowSession(id: SessionId, signal?: AbortSignal): ReturnType<PersistenceCoordinator['borrowSession']> {
    return this.coordinator.borrowSession(id, signal)
  }

  readFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    return this.coordinator.readFrom(id, fromSeq, signal)
  }

  // --- PersistenceBackend hooks (the Map storage primitives) ---

  // A Map-backed store has no torn tails, so `tornMarker` is never set.
  async loadStored(id: SessionId): Promise<StoredPrefix<never> | undefined> {
    const entry = this.store.get(id)
    if (!entry) return undefined
    return {
      meta: structuredClone(entry.meta),
      events: structuredClone(entry.events),
      revision: memoryRevision(entry),
    }
  }

  async readStoredRevision(id: SessionId): Promise<SessionPersistenceRevision | undefined> {
    const entry = this.store.get(id)
    return entry === undefined ? undefined : memoryRevision(entry)
  }

  async appendBatch(m: SessionHeader, events: readonly SessionEvent[], _isMaterialized: boolean): Promise<void> {
    // Defense-in-depth: the coordinator already validates serializability, but a
    // durable store must reject non-JSON data at its own boundary too.
    for (const e of events) {
      if (!isJsonValue(e.data)) throw new Error(`event "${e.type}" carries non-JSON-serializable data`)
    }
    const existing = this.store.get(m.id)
    if (!existing) {
      // The coordinator sends the first batch for materialization; later batches append.
      this.store.set(m.id, { meta: structuredClone(m), events: structuredClone(events) as SessionEvent[] })
    } else {
      existing.events.push(...structuredClone(events) as SessionEvent[])
    }
  }

  materializeHeader(m: SessionHeader): Promise<void> {
    this.store.set(m.id, { meta: structuredClone(m), events: [] })
    return Promise.resolve()
  }

  async commitRepair(m: SessionHeader, _tornMarker: undefined, closers: readonly SessionEvent[]): Promise<void> {
    // No torn tails in a Map store, so `_tornMarker` is always undefined; only the
    // synthetic closers are appended (the same DELETE+INSERT a DB backend does,
    // minus the truncate).
    const entry = this.store.get(m.id)
    /* v8 ignore next -- commitRepair only runs for a materialized (stored) session */
    if (!entry) return
    if (closers.length > 0) entry.events.push(...structuredClone(closers) as SessionEvent[])
  }

  async list(signal?: AbortSignal): Promise<SessionHeader[]> {
    signal?.throwIfAborted()
    return [...this.store.values()].map(e => structuredClone(e.meta))
  }

  async listSnapshots(signal?: AbortSignal): Promise<SessionPersistenceSnapshot[]> {
    signal?.throwIfAborted()
    return [...this.store.values()].map(entry => ({
      header: structuredClone(entry.meta),
      revision: memoryRevision(entry),
    }))
  }
}

/** Controllable storage primitive for serialization and retirement failure tests. */
class ControlledBackend implements PersistenceBackend<never> {
  readonly name = 'session-persistence-controlled'
  readonly store: MemoryStore = new Map()
  readonly lifecycle: string[] = []
  lastAppendedBatch: readonly SessionEvent[] | undefined
  appendAttempts = 0
  loadAttempts = 0
  repairAttempts = 0
  beforeAppend?: (attempt: number) => Promise<void>
  beforeLoadStored?: (attempt: number, signal?: AbortSignal) => Promise<void>
  /** When set, the declared seek hook delegates here so readFrom exercises it; unset throws (tests set it first). */
  seekHook?: (id: SessionId, fromSeq: number, signal?: AbortSignal) => Promise<StoredSuffix | undefined>

  loadStoredFrom(id: SessionId, fromSeq: number, signal?: AbortSignal): Promise<StoredSuffix | undefined> {
    if (this.seekHook === undefined) throw new Error('seekHook not configured for this test')
    return this.seekHook(id, fromSeq, signal)
  }

  async loadStored(id: SessionId, signal?: AbortSignal): Promise<StoredPrefix<never> | undefined> {
    const attempt = ++this.loadAttempts
    await this.beforeLoadStored?.(attempt, signal)
    const entry = this.store.get(id)
    if (entry === undefined) return undefined
    return {
      meta: structuredClone(entry.meta),
      events: structuredClone(entry.events),
      revision: memoryRevision(entry),
    }
  }

  async readStoredRevision(id: SessionId, signal?: AbortSignal): Promise<SessionPersistenceRevision | undefined> {
    signal?.throwIfAborted()
    const entry = this.store.get(id)
    return entry === undefined ? undefined : memoryRevision(entry)
  }

  async appendBatch(m: SessionHeader, events: readonly SessionEvent[], _isMaterialized: boolean): Promise<void> {
    this.lastAppendedBatch = events
    const attempt = ++this.appendAttempts
    await this.beforeAppend?.(attempt)
    const entry = this.store.get(m.id)
    if (entry === undefined) {
      this.store.set(m.id, { meta: structuredClone(m), events: structuredClone(events) as SessionEvent[] })
    } else {
      entry.events.push(...structuredClone(events) as SessionEvent[])
    }
  }

  async commitRepair(m: SessionHeader, _tornMarker: undefined, closers: readonly SessionEvent[]): Promise<void> {
    this.repairAttempts += 1
    const entry = this.store.get(m.id)
    if (entry !== undefined) entry.events.push(...structuredClone(closers) as SessionEvent[])
  }

  async list(): Promise<SessionHeader[]> {
    return [...this.store.values()].map(entry => structuredClone(entry.meta))
  }

  async close(): Promise<void> {
    this.lifecycle.push('close')
  }
}

runPersistenceContract('memory', async () => {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const fiber = await ctx.plugin(MemoryPersistence)
  return {
    persistence: ctx.sessionPersistence,
    dispose: async () => { await fiber.dispose() },
  }
})

describe('the inherited readRaw default', () => {
  it('rejects unsupported reads distinctly from absence and honors an aborted signal', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(MemoryPersistence)
    expect(ctx.sessionPersistence.supportsRawArtifacts).toBe(false)
    await expect(
      ctx.sessionPersistence.readRaw(SessionId('any-session')),
    ).rejects.toThrow('does not expose raw artifacts')
    await expect(
      ctx.sessionPersistence.readRaw(SessionId('any-session'), AbortSignal.abort()),
    ).rejects.toThrow()
    // A non-Error abort reason falls back to a wrapped Error rejection.
    const controller = new AbortController()
    controller.abort('boom')
    await expect(
      ctx.sessionPersistence.readRaw(SessionId('any-session'), controller.signal),
    ).rejects.toThrow('aborted')
  })
})

// Each fixture shares one map across mounts. No `corruptTail` is supplied because map writes are
// atomic; the suite asserts that skip while JSONL covers the repair branch.
runCoordinatorContract('memory', async (): Promise<CoordinatorFixture> => {
  const store: MemoryStore = new Map()
  return {
    mount: async ctx => ctx.plugin(MemoryPersistence, { store }),
    cleanup: async () => { store.clear() },
  }
})

describe('PersistenceCoordinator seed ownership', () => {
  it('retains the immutable session seed without cloning it', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))

    try {
      const session = ctx.sessions.create(SessionId('shared-seed'), { seed: oneTurnLog() })
      const seed = session.snapshotEvents()
      await ctx.sessions.flush(session)

      expect(backend.lastAppendedBatch).toBe(seed)
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })
})

describe('PersistenceCoordinator bounded writes', () => {
  it('cancels the batching deadline when live initialization rejects', async () => {
    vi.useFakeTimers()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const failure = new Error('initialization failed')
    backend.beforeLoadStored = () => Promise.reject(failure)
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      new PersistenceCoordinator(inner, backend, {
        preparedSessionCacheSize: DEFAULT_PREPARED_SESSION_CACHE_SIZE,
        writeBatchMaxDelayMs: MAX_WRITE_BATCH_DELAY_MS,
      })
    }, { inject: ['sessions'] }))

    try {
      const session = ctx.sessions.create(SessionId('bounded-init-failure'))
      session.append('turn/start', { turn: 1 })

      await expect(ctx.sessions.flush(session)).rejects.toBe(failure)
      expect(vi.getTimerCount()).toBe(0)
      try {
        await fiber.dispose()
      } catch {
        // The initialization failure was already asserted at the flush boundary.
      }
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      try {
        await fiber.dispose()
      } catch {
        // The expected initialization failure was asserted above; cleanup only
        // needs to release any remaining parent effects.
      }
      try {
        await ctx.fiber.dispose()
      } catch {
        // The child failure was already asserted through the backend fiber.
      }
      vi.useRealTimers()
    }
  })

  it('starts a follow-up batch for events admitted during an in-flight write', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const appendGate = Promise.withResolvers<boolean>()
    backend.beforeAppend = async (attempt) => {
      if (attempt === 1) await appendGate.promise
    }
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      new PersistenceCoordinator(inner, backend, {
        preparedSessionCacheSize: DEFAULT_PREPARED_SESSION_CACHE_SIZE,
        writeBatchMaxDelayMs: 1,
      })
    }, { inject: ['sessions'] }))

    try {
      const session = ctx.sessions.create(SessionId('bounded-follow-up'))
      await ctx.sessions.flush(session)
      session.append('turn/start', { turn: 1 })
      await vi.waitFor(() => { expect(backend.appendAttempts).toBe(1) })

      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      appendGate.resolve(true)

      await vi.waitFor(() => {
        expect(backend.appendAttempts).toBe(2)
        expect(backend.store.get(session.id)?.events.map(event => event.seq)).toEqual([0, 1])
      })
    } finally {
      appendGate.resolve(true)
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('retries a failed overlapping background write at the explicit flush barrier', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const appendGate = Promise.withResolvers<boolean>()
    backend.beforeAppend = async (attempt) => {
      if (attempt === 1) {
        await appendGate.promise
        throw new Error('transient background failure')
      }
    }
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      new PersistenceCoordinator(inner, backend, {
        preparedSessionCacheSize: DEFAULT_PREPARED_SESSION_CACHE_SIZE,
        writeBatchMaxDelayMs: 1,
      })
    }, { inject: ['sessions'] }))

    try {
      const session = ctx.sessions.create(SessionId('bounded-flush-retry'))
      await ctx.sessions.flush(session)
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await vi.waitFor(() => { expect(backend.appendAttempts).toBe(1) })

      const barriers = [ctx.sessions.flush(session), ctx.sessions.flush(session)]
      appendGate.resolve(true)

      await expect(Promise.all(barriers)).resolves.toEqual([true, true])
      expect(backend.appendAttempts).toBe(2)
      expect(backend.store.get(session.id)?.events.map(event => event.seq)).toEqual([0, 1])
    } finally {
      appendGate.resolve(true)
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })
})

describe('PersistenceCoordinator stored identity', () => {
  it('rejects a mismatched backend header before repair or state publication', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const requested = SessionId('requested')
    backend.store.set(requested, {
      meta: meta('different'),
      events: [{
        type: 'turn/start',
        seq: 0,
        time: 1,
        data: { turn: 1 },
      }],
    })
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    try {
      await expect(coordinator.load(requested)).rejects.toThrow(/stored session identity mismatch/)
      expect(backend.repairAttempts).toBe(0)
      expect((coordinator as unknown as CoordinatorInternals).states.size).toBe(0)
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('reserves a cold id across asynchronous storage repair', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('cold-load-reservation')
    const header = meta(id)
    const start: SessionEvent = {
      type: 'turn/start',
      seq: 0,
      time: 1,
      data: { turn: 1 },
    }
    backend.store.set(id, { meta: header, events: [start] })
    const loadGate = Promise.withResolvers<boolean>()
    backend.beforeLoadStored = async () => { await loadGate.promise }
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))

    try {
      const loading = coordinator.load(id)
      await vi.waitFor(() => { expect(backend.loadAttempts).toBe(1) })

      await expect(ctx.plugin(Object.assign((inner: Context) => {
        inner.sessions.create(id, { seed: [start], meta: header })
      }, { inject: ['sessions'] }))).rejects.toThrow(/persisted state already owns this identity/)
      expect(ctx.sessions.get(id)).toBeUndefined()

      loadGate.resolve(true)
      const loaded = await loading
      expect(loaded.events.map(event => event.type)).toEqual(['turn/start', 'turn/end'])

      const resumed = ctx.sessions.create(id, { seed: loaded.events, meta: loaded.meta })
      await expect(ctx.sessions.flush(resumed)).resolves.toBe(true)
    } finally {
      loadGate.resolve(true)
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })
})

describe('PersistenceCoordinator session preparations', () => {
  it.each([0, 1.5])('rejects invalid preparation cache capacity %s', (capacity) => {
    const ctx = new Context()
    const backend = new ControlledBackend()

    expect(() => new PersistenceCoordinator(ctx, backend, {
      preparedSessionCacheSize: capacity,
      writeBatchMaxDelayMs: DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
    })).toThrow(/positive safe integer/)
  })

  it.each([0, 1.5, MAX_WRITE_BATCH_DELAY_MS + 1])('rejects invalid write batch delay %s', (delay) => {
    const ctx = new Context()
    const backend = new ControlledBackend()

    expect(() => new PersistenceCoordinator(ctx, backend, {
      preparedSessionCacheSize: DEFAULT_PREPARED_SESSION_CACHE_SIZE,
      writeBatchMaxDelayMs: delay,
    })).toThrow(/writeBatchMaxDelayMs must be an integer between/)
  })

  it('retries invalidated prepare and load reservations', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const prepareId = SessionId('prepare-reservation-retry')
    const loadId = SessionId('load-reservation-retry')
    backend.store.set(prepareId, { meta: meta(prepareId), events: oneTurnLog() })
    backend.store.set(loadId, { meta: meta(loadId), events: oneTurnLog() })
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const preparations = (coordinator as unknown as {
      preparations: { reserve: (...args: unknown[]) => Promise<unknown> }
    }).preparations
    const reserve = vi.spyOn(preparations, 'reserve')

    try {
      reserve.mockResolvedValueOnce(undefined)
      const preparation = await coordinator.prepare(prepareId)
      preparation[Symbol.dispose]()

      reserve.mockResolvedValueOnce(undefined)
      await expect(coordinator.load(loadId)).resolves.toMatchObject({ meta: { id: loadId } })
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('prefers a session that becomes live across preparation reads', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const prepareId = SessionId('prepare-became-live')
    const loadId = SessionId('load-became-live')
    const inspectId = SessionId('inspect-became-live')
    const validatedInspectId = SessionId('validated-inspect-became-live')
    const failedInspectId = SessionId('failed-inspect-became-live')
    for (const id of [prepareId, loadId, inspectId, validatedInspectId]) {
      backend.store.set(id, { meta: meta(id), events: oneTurnLog() })
    }
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))

    try {
      const prepareLive = Session.create(prepareId, oneTurnLog(), meta(prepareId))
      const prepareGet = vi.spyOn(ctx.sessions, 'get')
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(prepareLive)
      await expect(coordinator.prepare(prepareId)).rejects.toThrow(/while it is live/)
      prepareGet.mockRestore()

      const loadLive = Session.create(loadId, oneTurnLog(), meta(loadId))
      const loadGet = vi.spyOn(ctx.sessions, 'get')
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(loadLive)
      await expect(coordinator.load(loadId)).resolves.toMatchObject({ meta: { id: loadId } })
      loadGet.mockRestore()

      const inspectLive = Session.create(inspectId, oneTurnLog(), meta(inspectId))
      const inspectGet = vi.spyOn(ctx.sessions, 'get')
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(inspectLive)
      await expect(coordinator.inspect(inspectId)).resolves.toMatchObject({ meta: { id: inspectId } })
      inspectGet.mockRestore()

      const validatedInspectLive = Session.create(validatedInspectId, oneTurnLog(), meta(validatedInspectId))
      const validatedInspectGet = vi.spyOn(ctx.sessions, 'get')
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(validatedInspectLive)
      await expect(coordinator.inspect(validatedInspectId))
        .resolves.toMatchObject({ meta: { id: validatedInspectId } })
      validatedInspectGet.mockRestore()

      const failedInspectLive = Session.create(failedInspectId, oneTurnLog(), meta(failedInspectId))
      backend.beforeLoadStored = () => Promise.reject(new Error('load failed'))
      const failedInspectGet = vi.spyOn(ctx.sessions, 'get')
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(failedInspectLive)
      await expect(coordinator.inspect(failedInspectId))
        .resolves.toMatchObject({ meta: { id: failedInspectId } })
      failedInspectGet.mockRestore()
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('rejects a prepared commit when durable state already has a live owner', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('prepared-commit-live-owner')
    backend.store.set(id, { meta: meta(id), events: oneTurnLog() })
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const owner = Session.create(id, oneTurnLog(), meta(id))
    const states = (coordinator as unknown as {
      states: Map<SessionId, {
        meta: SessionHeader
        cursor: number
        materialized: boolean
        owner?: Session
      }>
    }).states
    states.set(id, {
      meta: owner.header,
      cursor: oneTurnLog().length,
      materialized: true,
      owner,
    })

    try {
      await expect(coordinator.prepare(id)).rejects.toThrow(/live persistence owner/)
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('rejects publication after a preparation state no longer matches', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('prepared-publication-mismatch')
    backend.store.set(id, { meta: meta(id), events: oneTurnLog() })
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const preparation = await coordinator.prepare(id)
    const preparations = (coordinator as unknown as {
      preparations: {
        reservationFor: (session: Session) => { state: { cursor: number } } | undefined
      }
    }).preparations
    const reservation = preparations.reservationFor(preparation.session)
    if (reservation === undefined) throw new Error('test preparation must stay reserved')
    reservation.state.cursor += 1
    const detach = ctx.sessions.enter(preparation.session)

    try {
      expect(() => { ctx.sessions.announce(preparation.session) }).toThrow(/no longer matches/)
    } finally {
      detach()
      preparation[Symbol.dispose]()
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('observes a restored suffix initialization failure', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('prepared-suffix-init-failure')
    backend.store.set(id, { meta: meta(id), events: oneTurnLog() })
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const preparation = await coordinator.prepare(id)
    const internals = coordinator as unknown as {
      preparations: { reservationFor: (session: Session) => object | undefined }
      attachPrepared: (session: Session, reservation: object) => { init: Promise<void> }
    }
    const reservation = internals.preparations.reservationFor(preparation.session)
    if (reservation === undefined) throw new Error('test preparation must stay reserved')
    const failure = new Error('restored suffix append failed')
    backend.beforeAppend = () => Promise.reject(failure)
    preparation.session.append('turn/start', { turn: 2 })

    try {
      const live = internals.attachPrepared(preparation.session, reservation)
      await expect(live.init).rejects.toBe(failure)
    } finally {
      preparation[Symbol.dispose]()
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('writes new events after publishing a preparation with no unpublished suffix', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('prepared-live-write')
    const stored = [
      ...oneTurnLog(),
      { type: 'session/end-seed', seq: 6, time: 7, data: {} } as SessionEvent,
    ]
    backend.store.set(id, { meta: meta(id), events: stored })
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const preparation = await coordinator.prepare(id)
    const detach = ctx.sessions.enter(preparation.session)

    try {
      ctx.sessions.announce(preparation.session)
      preparation.session.append('turn/start', { turn: 2 })
      preparation.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

      await expect(ctx.sessions.flush(preparation.session)).resolves.toBe(true)
      expect(backend.store.get(id)?.events.map(event => event.seq))
        .toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    } finally {
      detach()
      preparation[Symbol.dispose]()
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('reuses the exact Session from inspect through repeated unpublished prepare calls', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('inspect-prepare-reuse')
    backend.store.set(id, { meta: meta(id), events: oneTurnLog() })
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    let first: Awaited<ReturnType<typeof coordinator.prepare>> | undefined
    let second: Awaited<ReturnType<typeof coordinator.prepare>> | undefined

    try {
      const inspected = await coordinator.inspect(id)
      first = await coordinator.prepare(id)

      expect(backend.loadAttempts).toBe(1)
      expect(first.session.snapshotEvents()[0]).toBe(inspected.events[0])

      first[Symbol.dispose]()
      second = await coordinator.prepare(id)
      expect(second.session).toBe(first.session)
      expect(backend.loadAttempts).toBe(1)
    } finally {
      second?.[Symbol.dispose]()
      first?.[Symbol.dispose]()
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('reloads a cached inspection after the durable revision changes', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('inspect-revision-refresh')
    backend.store.set(id, { meta: meta(id), events: oneTurnLog() })
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))

    try {
      const first = await coordinator.inspect(id)
      backend.store.get(id)!.events.push(
        { type: 'turn/start', seq: 6, time: 7, data: { turn: 2 } },
        { type: 'turn/end', seq: 7, time: 8, data: { turn: 2, reason: { kind: 'completed' } } },
      )

      const refreshed = await coordinator.inspect(id)
      expect(refreshed.events).toHaveLength(8)
      expect(refreshed.events[0]).not.toBe(first.events[0])
      expect(backend.loadAttempts).toBe(2)
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('does not restore from a cached inspection after the durable revision changes', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('prepare-revision-refresh')
    backend.store.set(id, { meta: meta(id), events: oneTurnLog() })
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    let preparation: Awaited<ReturnType<typeof coordinator.prepare>> | undefined

    try {
      const inspected = await coordinator.inspect(id)
      backend.store.get(id)!.events.push(
        { type: 'turn/start', seq: 6, time: 7, data: { turn: 2 } },
        { type: 'turn/end', seq: 7, time: 8, data: { turn: 2, reason: { kind: 'completed' } } },
      )

      preparation = await coordinator.prepare(id)
      expect(preparation.session.snapshotEvents()).toHaveLength(9)
      expect(preparation.session.snapshotEvents()[0]).not.toBe(inspected.events[0])
      expect(backend.loadAttempts).toBe(2)
    } finally {
      preparation?.[Symbol.dispose]()
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('retains a reserved preparation when inspection observes a newer external revision', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('reserved-inspect-revision-race')
    backend.store.set(id, { meta: meta(id), events: oneTurnLog() })
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    let preparation: Awaited<ReturnType<typeof coordinator.prepare>> | undefined
    let detach: (() => void) | undefined

    try {
      const cached = await coordinator.inspect(id)
      preparation = await coordinator.prepare(id)
      backend.store.get(id)!.events.push(
        { type: 'turn/start', seq: 6, time: 7, data: { turn: 2 } },
        { type: 'turn/end', seq: 7, time: 8, data: { turn: 2, reason: { kind: 'completed' } } },
      )

      await expect(coordinator.inspect(id)).resolves.toBe(cached)
      const preparations = (coordinator as unknown as {
        preparations: { reservationFor: (session: Session) => object | undefined }
      }).preparations
      expect(preparations.reservationFor(preparation.session)).toBeDefined()

      detach = ctx.sessions.enter(preparation.session)
      expect(() => { ctx.sessions.announce(preparation!.session) }).not.toThrow()
      expect(preparations.reservationFor(preparation.session)).toBeUndefined()
    } finally {
      detach?.()
      preparation?.[Symbol.dispose]()
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('queues a same-tick cold append behind preparation readiness', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('inspect-cold-append-race')
    backend.store.set(id, { meta: meta(id), events: oneTurnLog() })
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))

    try {
      const inspection = coordinator.inspect(id)
      const append = coordinator.append(id, [{
        type: 'turn/start',
        seq: oneTurnLog().length,
        time: 7,
        data: { turn: 2 },
      }])

      await expect(inspection).resolves.toMatchObject({
        meta: { id },
        events: [...oneTurnLog(), { seq: 6 }, { seq: 7 }],
      })
      await expect(append).resolves.toBeUndefined()
      expect(backend.loadAttempts).toBe(2)
      expect(backend.store.get(id)?.events).toHaveLength(oneTurnLog().length + 1)
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('allows a same-tick cold append to start before inspection', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('cold-append-inspect-race')
    backend.store.set(id, { meta: meta(id), events: oneTurnLog() })
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))

    try {
      const append = coordinator.append(id, [{
        type: 'turn/start',
        seq: oneTurnLog().length,
        time: 7,
        data: { turn: 2 },
      }])
      const inspection = coordinator.inspect(id)

      await expect(append).resolves.toBeUndefined()
      await expect(inspection).resolves.toMatchObject({
        meta: { id },
        events: [...oneTurnLog(), { seq: 6 }, { seq: 7 }],
      })
      expect(backend.loadAttempts).toBe(2)
      expect(backend.store.get(id)?.events).toHaveLength(oneTurnLog().length + 1)
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('retries cold append adoption when the prepared revision becomes stale', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('append-adoption-revision-refresh')
    backend.store.set(id, { meta: meta(id), events: oneTurnLog() })
    const readStoredRevision = backend.readStoredRevision.bind(backend)
    vi.spyOn(backend, 'readStoredRevision')
      .mockResolvedValueOnce(SessionPersistenceRevision('stale-revision'))
      .mockImplementation(readStoredRevision)
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))

    try {
      await coordinator.append(id, [{
        type: 'turn/start',
        seq: oneTurnLog().length,
        time: 7,
        data: { turn: 2 },
      }])

      expect(backend.loadAttempts).toBe(2)
      expect(backend.appendAttempts).toBe(1)
      expect(backend.store.get(id)?.events).toHaveLength(oneTurnLog().length + 1)
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('inspects an open live turn without balancing it', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))

    try {
      const session = ctx.sessions.create(SessionId('inspect-live-open-turn'))
      session.append('turn/start', { turn: 1 })

      const inspected = await coordinator.inspect(session.id)
      expect(inspected.events).toBe(session.snapshotEvents())
      expect(inspected.events.map(event => event.type)).toEqual(['turn/start'])
      await expect(coordinator.load(session.id)).rejects.toThrow(/live turn is open/)
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('keeps synthetic recovery in memory during inspect and commits it only once on prepare', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('inspect-repair-commit')
    backend.store.set(id, {
      meta: meta(id),
      events: [{
        type: 'turn/start',
        seq: 0,
        time: 1,
        data: { turn: 1 },
      }],
    })
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    let first: Awaited<ReturnType<typeof coordinator.prepare>> | undefined
    let second: Awaited<ReturnType<typeof coordinator.prepare>> | undefined

    try {
      const inspected = await coordinator.inspect(id)
      expect(inspected.events.map(event => event.type)).toEqual(['turn/start', 'turn/end'])
      expect(backend.store.get(id)?.events.map(event => event.type)).toEqual(['turn/start'])
      expect(backend.repairAttempts).toBe(0)

      first = await coordinator.prepare(id)
      expect(backend.repairAttempts).toBe(1)
      expect(backend.store.get(id)?.events.map(event => event.type)).toEqual(['turn/start', 'turn/end'])
      first[Symbol.dispose]()

      second = await coordinator.prepare(id)
      expect(second.session).toBe(first.session)
      expect(backend.loadAttempts).toBe(2)
      expect(backend.repairAttempts).toBe(1)
    } finally {
      second?.[Symbol.dispose]()
      first?.[Symbol.dispose]()
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('reloads the committed graph when another writer appends after repair', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('repair-external-append')
    backend.store.set(id, {
      meta: meta(id),
      events: [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }],
    })
    const commitRepair = backend.commitRepair.bind(backend)
    vi.spyOn(backend, 'commitRepair').mockImplementation(async (header, tornMarker, closers) => {
      await commitRepair(header, tornMarker, closers)
      const entry = backend.store.get(id)
      if (entry === undefined) throw new Error('test repair must keep storage materialized')
      const seq = entry.events.length
      entry.events.push(
        { type: 'turn/start', seq, time: 3, data: { turn: 2 } },
        { type: 'turn/end', seq: seq + 1, time: 4, data: { turn: 2, reason: { kind: 'completed' } } },
      )
    })
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    let preparation: Awaited<ReturnType<typeof coordinator.prepare>> | undefined

    try {
      preparation = await coordinator.prepare(id)

      expect(preparation.session.snapshotEvents().map(event => event.type)).toEqual([
        'turn/start',
        'turn/end',
        'turn/start',
        'turn/end',
        'session/end-seed',
      ])
      expect(backend.loadAttempts).toBe(2)
      expect(backend.repairAttempts).toBe(1)
    } finally {
      preparation?.[Symbol.dispose]()
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('rejects preparation when storage disappears during the post-repair reload', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('repair-disappeared')
    backend.store.set(id, {
      meta: meta(id),
      events: [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }],
    })
    const commitRepair = backend.commitRepair.bind(backend)
    vi.spyOn(backend, 'commitRepair').mockImplementation(async (header, tornMarker, closers) => {
      await commitRepair(header, tornMarker, closers)
      backend.store.delete(id)
    })
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))

    try {
      await expect(coordinator.prepare(id)).rejects.toThrow(/not found/)
      expect(backend.repairAttempts).toBe(1)
      expect(backend.loadAttempts).toBe(2)
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('waits for an existing reservation and reuses it after release', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('prepare-reservation-wait')
    backend.store.set(id, { meta: meta(id), events: oneTurnLog() })
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    let first: Awaited<ReturnType<typeof coordinator.prepare>> | undefined
    let second: Awaited<ReturnType<typeof coordinator.prepare>> | undefined

    try {
      first = await coordinator.prepare(id)
      let secondResolved = false
      const waiting = coordinator.prepare(id).then((preparation) => {
        secondResolved = true
        return preparation
      })
      await Promise.resolve()
      expect(secondResolved).toBe(false)

      first[Symbol.dispose]()
      second = await waiting
      expect(second.session).toBe(first.session)
      expect(backend.loadAttempts).toBe(1)
    } finally {
      second?.[Symbol.dispose]()
      first?.[Symbol.dispose]()
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('evicts only ready preparations by LRU capacity', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const firstId = SessionId('preparation-lru-first')
    const secondId = SessionId('preparation-lru-second')
    backend.store.set(firstId, { meta: meta(firstId), events: oneTurnLog() })
    backend.store.set(secondId, { meta: meta(secondId), events: oneTurnLog() })
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend, {
        preparedSessionCacheSize: 1,
        writeBatchMaxDelayMs: DEFAULT_WRITE_BATCH_MAX_DELAY_MS,
      })
    }, { inject: ['sessions'] }))

    try {
      await coordinator.inspect(firstId)
      await coordinator.inspect(secondId)
      await coordinator.inspect(firstId)
      expect(backend.loadAttempts).toBe(3)
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('rejects append while an unpublished preparation owns the persisted cursor', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('reserved-append')
    backend.store.set(id, { meta: meta(id), events: oneTurnLog() })
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    let preparation: Awaited<ReturnType<typeof coordinator.prepare>> | undefined

    try {
      preparation = await coordinator.prepare(id)
      await expect(coordinator.append(id, [{
        type: 'turn/start',
        seq: oneTurnLog().length,
        time: 7,
        data: { turn: 2 },
      }])).rejects.toThrow(/persisted preparation is reserved/)
    } finally {
      preparation?.[Symbol.dispose]()
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })
})

describe('PersistenceCoordinator seek reads', () => {
  it('loads the whole prefix only when a bounded legacy suffix needs earlier message identities', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('seek-read-from-legacy')
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    backend.seekHook = async (hookId, fromSeq) => {
      const entry = backend.store.get(hookId)
      if (entry === undefined) return undefined
      return { meta: structuredClone(entry.meta), events: entry.events.filter(e => e.seq >= fromSeq) }
    }

    try {
      const assertLegacySuffixUsesWholePrefix = async (
        events: SessionEvent[],
        fromSeq: number,
        firstType: SessionEvent['type'],
      ): Promise<void> => {
        backend.store.set(id, { meta: meta(id), events })
        const loadsBefore = backend.loadAttempts
        const result = await coordinator.readFrom(id, fromSeq)
        expect(result.events[0]?.type).toBe(firstType)
        expect(backend.loadAttempts).toBe(loadsBefore + 1)
      }
      const legacyMessages = legacyMessageLog()
      await assertLegacySuffixUsesWholePrefix(legacyMessages, 1, 'user/message')
      await assertLegacySuffixUsesWholePrefix(legacyMessages, 3, 'assistant/message')
      await assertLegacySuffixUsesWholePrefix(legacyMessages, 5, 'tool/result')
      await assertLegacySuffixUsesWholePrefix(preReactLoopLog(), 3, 'user/message')

      backend.store.set(id, { meta: meta(id), events: legacyMessages })
      const directCurrent = await coordinator.readFrom(id, 0)
      backend.store.set(id, { meta: meta(id), events: directCurrent.events })
      const loadsBeforeCurrent = backend.loadAttempts
      await coordinator.readFrom(id, 1)
      await coordinator.readFrom(id, 3)
      await coordinator.readFrom(id, 5)
      expect(backend.loadAttempts).toBe(loadsBeforeCurrent)

      for (const [type, data] of [
        ['user/message', {}],
        ['assistant/message', {}],
        ['tool/result', {}],
      ] as const) {
        backend.store.set(id, {
          meta: meta(id),
          events: [{ type, seq: 0, time: 1, data } as unknown as SessionEvent],
        })
        const loadsBefore = backend.loadAttempts
        await expect(coordinator.readFrom(id, 0)).rejects.toThrow('lacks an identified message')
        expect(backend.loadAttempts).toBe(loadsBefore)
      }
      backend.store.set(id, {
        meta: meta(id),
        events: [{
          type: 'external/null', seq: 0, time: 1, data: null, ignorable: true,
        } as unknown as SessionEvent],
      })
      const loadsBeforeNullData = backend.loadAttempts
      expect((await coordinator.readFrom(id, 0)).events[0]?.data).toBeNull()
      expect(backend.loadAttempts).toBe(loadsBeforeNullData)
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })
})

describe('PersistenceCoordinator observation cancellation', () => {
  it('borrows live Sessions before, during, and after cold source validation', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const afterBorrowId = SessionId('borrow-became-live-before-validation')
    const afterValidationId = SessionId('borrow-became-live-after-validation')
    for (const id of [afterBorrowId, afterValidationId]) {
      backend.store.set(id, { meta: meta(id), events: oneTurnLog() })
    }
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))

    try {
      const immediate = ctx.sessions.create(SessionId('borrow-already-live'))
      const immediateSource = await coordinator.borrowSession(immediate.id)
      expect(immediateSource).toMatchObject({ source: 'live', inspection: { meta: { id: immediate.id } } })
      immediateSource[Symbol.dispose]()

      const afterBorrow = Session.create(afterBorrowId, oneTurnLog(), meta(afterBorrowId))
      const afterBorrowGet = vi.spyOn(ctx.sessions, 'get')
        .mockReturnValueOnce(undefined)
        .mockReturnValue(afterBorrow)
      const attachedSource = await coordinator.borrowSession(afterBorrowId)
      expect(attachedSource).toMatchObject({ source: 'live', inspection: { meta: { id: afterBorrowId } } })
      attachedSource[Symbol.dispose]()
      afterBorrowGet.mockRestore()

      const afterValidation = Session.create(afterValidationId, oneTurnLog(), meta(afterValidationId))
      const afterValidationGet = vi.spyOn(ctx.sessions, 'get')
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(undefined)
        .mockReturnValue(afterValidation)
      const publishedSource = await coordinator.borrowSession(afterValidationId)
      expect(publishedSource).toMatchObject({
        source: 'live', inspection: { meta: { id: afterValidationId } },
      })
      publishedSource[Symbol.dispose]()
      afterValidationGet.mockRestore()
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('returns and releases a current prepared observation', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('borrow-current-prepared')
    backend.store.set(id, { meta: meta(id), events: oneTurnLog() })
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))

    try {
      const source = await coordinator.borrowSession(id)
      expect(source).toMatchObject({ source: 'prepared', inspection: { meta: { id } } })
      source[Symbol.dispose]()
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('reloads a stale prepared observation and retains one claimed concurrently', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const staleId = SessionId('borrow-stale-prepared')
    const retainedId = SessionId('borrow-retained-prepared')
    for (const id of [staleId, retainedId]) {
      backend.store.set(id, { meta: meta(id), events: oneTurnLog() })
    }
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))

    try {
      const readRevision = backend.readStoredRevision.bind(backend)
      const revision = vi.spyOn(backend, 'readStoredRevision')
        .mockResolvedValueOnce(SessionPersistenceRevision('stale'))
        .mockImplementation(readRevision)
      const stale = await coordinator.borrowSession(staleId)
      expect(stale.source).toBe('prepared')
      expect(backend.loadAttempts).toBe(2)
      stale[Symbol.dispose]()
      revision.mockRestore()

      const preparations = (coordinator as unknown as {
        preparations: { discardReady: (id: SessionId, source: unknown) => string }
      }).preparations
      vi.spyOn(backend, 'readStoredRevision').mockResolvedValue(SessionPersistenceRevision('changed'))
      const discard = vi.spyOn(preparations, 'discardReady').mockReturnValue('retained')
      const retained = await coordinator.borrowSession(retainedId)
      expect(retained.source).toBe('prepared')
      expect(discard).toHaveBeenCalledOnce()
      retained[Symbol.dispose]()
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('falls back to a concurrently attached Session after revision validation fails', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('borrow-failed-validation-became-live')
    backend.store.set(id, { meta: meta(id), events: oneTurnLog() })
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const attached = Session.create(id, oneTurnLog(), meta(id))
    const get = vi.spyOn(ctx.sessions, 'get')
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
      .mockReturnValue(attached)
    vi.spyOn(backend, 'readStoredRevision').mockRejectedValue(new Error('revision failed'))

    try {
      const source = await coordinator.borrowSession(id)
      expect(source).toMatchObject({ source: 'live', inspection: { meta: { id } } })
      source[Symbol.dispose]()
    } finally {
      get.mockRestore()
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('rethrows revision validation failure when no live Session won the race', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('borrow-failed-validation')
    backend.store.set(id, { meta: meta(id), events: oneTurnLog() })
    const failure = new Error('revision failed')
    vi.spyOn(backend, 'readStoredRevision').mockRejectedValue(failure)
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))

    try {
      await expect(coordinator.borrowSession(id)).rejects.toBe(failure)
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('promptly rejects a queued inspect without invoking it and keeps the same-id chain healthy', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('queued-inspect-cancellation')
    backend.store.set(id, { meta: meta(id), events: oneTurnLog() })
    const loadGate = Promise.withResolvers<boolean>()
    backend.beforeLoadStored = async (attempt) => {
      if (attempt === 1) await loadGate.promise
    }
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))

    try {
      const prior = coordinator.inspect(id)
      await vi.waitFor(() => { expect(backend.loadAttempts).toBe(1) })
      const controller = new AbortController()
      const reason = new Error('queued inspect cancelled')
      const queued = coordinator.inspect(id, controller.signal)
      let observedReason: unknown
      const observedAbort = queued.catch((error: unknown) => {
        observedReason = error
      })

      controller.abort(reason)

      await vi.waitFor(() => { expect(observedReason).toBe(reason) })
      expect(backend.loadAttempts).toBe(1)
      const subsequent = coordinator.inspect(id)
      expect(backend.loadAttempts).toBe(1)

      loadGate.resolve(true)
      await expect(prior).resolves.toMatchObject({ meta: { id } })
      await observedAbort
      await expect(subsequent).resolves.toMatchObject({ meta: { id } })
      expect(backend.loadAttempts).toBe(1)
      await vi.waitFor(() => {
        expect((coordinator as unknown as CoordinatorInternals).chains.size).toBe(0)
      })
    } finally {
      loadGate.resolve(true)
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('keeps a shared cold read alive when its creating inspect is cancelled', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('creating-inspect-cancellation')
    backend.store.set(id, { meta: meta(id), events: oneTurnLog() })
    const loadGate = Promise.withResolvers<boolean>()
    backend.beforeLoadStored = () => loadGate.promise.then(() => undefined)
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    let prepared: Awaited<ReturnType<typeof coordinator.prepare>> | undefined

    try {
      const controller = new AbortController()
      const reason = new Error('creating inspect cancelled')
      const inspection = coordinator.inspect(id, controller.signal)
      await vi.waitFor(() => { expect(backend.loadAttempts).toBe(1) })
      const reservation = coordinator.prepare(id)

      controller.abort(reason)
      await expect(inspection).rejects.toBe(reason)
      loadGate.resolve(true)
      prepared = await reservation
      expect(prepared.session.id).toBe(id)
      expect(backend.loadAttempts).toBe(1)
    } finally {
      loadGate.resolve(true)
      prepared?.[Symbol.dispose]()
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('preserves inspect cancellation when the session concurrently becomes live', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('cancelled-inspect-became-live')
    backend.store.set(id, { meta: meta(id), events: oneTurnLog() })
    const controller = new AbortController()
    const reason = new Error('inspect cancelled while publishing')
    backend.beforeLoadStored = async () => {
      controller.abort(reason)
      throw new Error('load stopped after cancellation')
    }
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const live = Session.create(id, oneTurnLog(), meta(id))
    const get = vi.spyOn(ctx.sessions, 'get')
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(live)

    try {
      await expect(coordinator.inspect(id, controller.signal)).rejects.toBe(reason)
    } finally {
      get.mockRestore()
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('readFrom via the seek hook: serves the suffix, maps undefined to not-found, and relays hook failures by abort state', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const id = SessionId('seek-read-from')
    const log = oneTurnLog()
    backend.store.set(id, { meta: meta(id), events: log })
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))

    try {
      // Happy path through the hook: only the suffix comes back, detached.
      backend.seekHook = async (hookId, fromSeq) => {
        const entry = backend.store.get(hookId)
        if (entry === undefined) return undefined
        return { meta: structuredClone(entry.meta), events: entry.events.filter(e => e.seq >= fromSeq) }
      }
      const suffix = await coordinator.readFrom(id, 3)
      expect(suffix.events).toEqual(log.slice(3))
      // The hook's `undefined` is the backend contract's not-found result.
      await expect(coordinator.readFrom(SessionId('missing-seek'), 0)).rejects.toThrow('not found')

      // A hook failure with no cancellation in play propagates as-is.
      const hookFailure = new Error('seek backend exploded')
      backend.seekHook = () => Promise.reject(hookFailure)
      await expect(coordinator.readFrom(id, 0)).rejects.toBe(hookFailure)

      // A hook failure after cancellation surfaces the caller's abort reason,
      // not the backend's internal teardown error. The abort fires only once
      // the hook is provably entered, so the failure exercises the catch (not
      // the pre-invocation throwIfAborted).
      const controller = new AbortController()
      const reason = new Error('read-from cancelled mid-hook')
      let hookEntered = false
      backend.seekHook = async (_hookId, _fromSeq, signal) => {
        hookEntered = true
        await new Promise<void>((resolve) => { signal?.addEventListener('abort', () => { resolve() }, { once: true }) })
        throw new Error('backend teardown after abort')
      }
      const pending = coordinator.readFrom(id, 0, controller.signal)
      const observed = pending.catch((error: unknown) => error)
      await vi.waitFor(() => { expect(hookEntered).toBe(true) })
      controller.abort(reason)
      expect(await observed).toBe(reason)
    } finally {
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('rejects a cancelled inspect while an in-flight retirement drain is still pending', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    let coordinator!: PersistenceCoordinator<never>
    const backendFiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const internals = coordinator as unknown as CoordinatorInternals
    const appendGate = Promise.withResolvers<boolean>()
    backend.beforeAppend = async () => { await appendGate.promise }

    try {
      const id = SessionId('retiring-inspect')
      let session!: Session
      const sessionFiber = await ctx.plugin(Object.assign((inner: Context) => {
        session = inner.sessions.create(id)
      }, { inject: ['sessions'] }))
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      // Dispose the session so retirement starts; its append is gated, so the
      // retirement promise stays pending in the coordinator.
      await sessionFiber.dispose()
      await vi.waitFor(() => { expect(internals.retirements.has(id)).toBe(true) })
      const baselineLoads = backend.loadAttempts

      const controller = new AbortController()
      const reason = new Error('inspect cancelled during retirement')
      const pending = coordinator.inspect(id, controller.signal)
      let observedReason: unknown
      const observed = pending.catch((error: unknown) => { observedReason = error })

      // Cancel before the gated retirement can settle: the inspect must reject
      // promptly instead of waiting for the drain, and must never reach the
      // backend read.
      controller.abort(reason)
      await vi.waitFor(() => { expect(observedReason).toBe(reason) })
      expect(backend.loadAttempts).toBe(baselineLoads)

      appendGate.resolve(true)
      await observed
    } finally {
      appendGate.resolve(true)
      await backendFiber.dispose()
      await ctx.fiber.dispose()
    }
  })
})

describe('PersistenceCoordinator retirement', () => {
  it('a retiring unmaterialized owner without buffered events releases its id', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const backendFiber = await ctx.plugin(Object.assign((inner: Context) => {
      new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const loadGate = Promise.withResolvers<boolean>()
    backend.beforeLoadStored = async (attempt) => {
      if (attempt === 1) await loadGate.promise
    }

    try {
      const id = SessionId('retiring-lazy-owner')
      const firstFiber = await ctx.plugin(Object.assign((inner: Context) => {
        inner.sessions.create(id)
      }, { inject: ['sessions'] }))
      await vi.waitFor(() => { expect(backend.loadAttempts).toBe(1) })
      await firstFiber.dispose()

      let reuse!: Session
      await ctx.plugin(Object.assign((inner: Context) => {
        reuse = inner.sessions.create(id)
      }, { inject: ['sessions'] }))
      const reuseFlush = ctx.sessions.flush(reuse)

      loadGate.resolve(true)
      await expect(reuseFlush).resolves.toBe(true)
    } finally {
      loadGate.resolve(true)
      await backendFiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('a superseded retirement leaves the successor lifecycle\'s pending drain in place', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    let coordinator!: PersistenceCoordinator<never>
    const backendFiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const internals = coordinator as unknown as CoordinatorInternals
    const readGate = Promise.withResolvers<boolean>()

    try {
      const id = SessionId('superseded-retirement')
      // First lifecycle: unmaterialized (zero events), so a same-id successor
      // may legally reclaim the abandoned id later.
      let first!: Session
      const firstFiber = await ctx.plugin(Object.assign((inner: Context) => {
        first = inner.sessions.create(id)
      }, { inject: ['sessions'] }))
      await ctx.sessions.flush(first)

      // Occupy the per-id serialize chain with a gated physical read:
      // inspect() correctly borrows the still-live Session without entering
      // the backend chain, while both retirements must queue behind readFrom().
      const readEntered = Promise.withResolvers<undefined>()
      backend.seekHook = async () => {
        readEntered.resolve(undefined)
        await readGate.promise
        return undefined
      }
      const parked = coordinator.readFrom(id, 0).catch((error: unknown) => error)
      await readEntered.promise

      // First retirement queues behind the gate and stays pending.
      await firstFiber.dispose()
      await vi.waitFor(() => { expect(internals.retirements.has(id)).toBe(true) })
      const firstRetirement = internals.retirements.get(id)

      // Successor lifecycle retires while the first drain is still in flight:
      // retire() replaces the map entry synchronously.
      const secondFiber = await ctx.plugin(Object.assign((inner: Context) => {
        inner.sessions.create(id)
      }, { inject: ['sessions'] }))
      await secondFiber.dispose()
      await vi.waitFor(() => {
        expect(internals.retirements.get(id)).not.toBe(firstRetirement)
      })

      // Release the chain: the first drain settles and its forget() must not
      // delete the successor's entry (exact-entry guard); the successor's own
      // forget() then clears the map.
      readGate.resolve(true)
      expect(await parked).toBeInstanceOf(Error) // the parked inspect (not found) is observed
      await firstRetirement
      await vi.waitFor(() => { expect(internals.retirements.has(id)).toBe(false) })
    } finally {
      readGate.resolve(true)
      await backendFiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('a replacement queued before retirement cleanup still collides with the live owner', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    const backendFiber = await ctx.plugin(Object.assign((inner: Context) => {
      new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const appendGate = Promise.withResolvers<boolean>()

    try {
      const id = SessionId('retiring-live-owner')
      let first!: Session
      const firstFiber = await ctx.plugin(Object.assign((inner: Context) => {
        first = inner.sessions.create(id)
      }, { inject: ['sessions'] }))
      await ctx.sessions.flush(first)
      backend.beforeAppend = async () => { await appendGate.promise }
      first.append('turn/start', { turn: 1 })
      first.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await vi.waitFor(() => { expect(backend.appendAttempts).toBe(1) })
      await firstFiber.dispose()

      let reuse!: Session
      await ctx.plugin(Object.assign((inner: Context) => {
        reuse = inner.sessions.create(id)
      }, { inject: ['sessions'] }))
      const reuseFlush = ctx.sessions.flush(reuse)

      appendGate.resolve(true)
      await expect(reuseFlush).rejects.toThrow(/bound to a different live session/)
      expect(backend.store.get(id)?.events.map(event => event.seq)).toEqual([0, 1])
    } finally {
      appendGate.resolve(true)
      await backendFiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('a racing cold load survives retirement cleanup and rejects same-id reuse', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    let coordinator!: PersistenceCoordinator<never>
    const backendFiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const appendGate = Promise.withResolvers<boolean>()
    const loadGate = Promise.withResolvers<boolean>()

    try {
      const id = SessionId('retiring-buffered-owner')
      let first!: Session
      const firstFiber = await ctx.plugin(Object.assign((inner: Context) => {
        first = inner.sessions.create(id)
      }, { inject: ['sessions'] }))
      await ctx.sessions.flush(first)
      backend.beforeAppend = async () => { await appendGate.promise }
      first.append('turn/start', { turn: 1 })
      first.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await vi.waitFor(() => { expect(backend.appendAttempts).toBe(1) })
      await firstFiber.dispose()
      const baselineLoads = backend.loadAttempts
      backend.beforeLoadStored = async () => { await loadGate.promise }
      const coldLoad = coordinator.load(id)

      appendGate.resolve(true)
      await vi.waitFor(() => { expect(backend.loadAttempts).toBe(baselineLoads + 1) })

      await expect(ctx.plugin(Object.assign((inner: Context) => {
        inner.sessions.create(id)
      }, { inject: ['sessions'] }))).rejects.toThrow(/persisted state already owns this identity/)

      loadGate.resolve(true)
      await expect(coldLoad).resolves.toMatchObject({
        events: [{ seq: 0 }, { seq: 1 }],
      })

      let reuse!: Session
      await ctx.plugin(Object.assign((inner: Context) => {
        reuse = inner.sessions.create(id)
      }, { inject: ['sessions'] }))
      await expect(ctx.sessions.flush(reuse)).rejects.toThrow(/id collision/)
      await vi.waitFor(() => {
        expect(backend.store.get(id)?.events.map(event => event.seq)).toEqual([0, 1])
      })
    } finally {
      appendGate.resolve(true)
      loadGate.resolve(true)
      await backendFiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('a settled chain tail cannot delete a newer operation for the same id', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const internals = coordinator as unknown as CoordinatorInternals
    const first = Promise.withResolvers<boolean>()
    const second = Promise.withResolvers<boolean>()
    backend.beforeAppend = async (attempt) => {
      if (attempt === 1) await first.promise
      if (attempt === 2) await second.promise
    }

    try {
      const id = SessionId('chain-tail')
      await coordinator.create(meta(id))
      const firstAppend = coordinator.append(id, [{
        type: 'turn/start',
        seq: 0,
        time: 1,
        data: { turn: 1 },
      }])
      const secondAppend = coordinator.append(id, [{
        type: 'turn/end',
        seq: 1,
        time: 2,
        data: { turn: 1, reason: { kind: 'completed' } },
      }])

      await vi.waitFor(() => { expect(backend.appendAttempts).toBe(1) })
      first.resolve(true)
      await vi.waitFor(() => { expect(backend.appendAttempts).toBe(2) })
      expect(internals.chains.size).toBe(1)
      second.resolve(true)
      await Promise.all([firstAppend, secondAppend])
      await vi.waitFor(() => { expect(internals.chains.size).toBe(0) })
      expect(backend.store.get(id)?.events.map(event => event.seq)).toEqual([0, 1])
    } finally {
      first.resolve(true)
      second.resolve(true)
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('backend teardown retries a failed session retirement before close', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    let coordinator!: PersistenceCoordinator<never>
    const backendFiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const internals = coordinator as unknown as CoordinatorInternals
    let retryEnabled = false
    backend.beforeAppend = async () => {
      if (!retryEnabled) {
        backend.lifecycle.push('append-failed')
        throw new Error('transient append failure')
      }
      backend.lifecycle.push('append-committed')
    }

    try {
      let session!: Session
      const sessionFiber = await ctx.plugin(Object.assign((inner: Context) => {
        session = inner.sessions.create(SessionId('retry-retirement'))
      }, { inject: ['sessions'] }))
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await sessionFiber.dispose()

      await vi.waitFor(() => {
        expect(backend.appendAttempts).toBeGreaterThanOrEqual(1)
        expect([...internals.live.values()][0]?.writes.pending).toEqual(expect.arrayContaining([
          expect.objectContaining({ seq: 0 }),
          expect.objectContaining({ seq: 1 }),
        ]))
      })

      retryEnabled = true
      await backendFiber.dispose()
      expect(backend.store.get(SessionId('retry-retirement'))?.events.map(event => event.seq)).toEqual([0, 1])
      expect(backend.lifecycle.at(-2)).toBe('append-committed')
      expect(backend.lifecycle.at(-1)).toBe('close')
    } finally {
      await backendFiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('backend teardown waits for an in-flight session retirement before close', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    let coordinator!: PersistenceCoordinator<never>
    const backendFiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const internals = coordinator as unknown as CoordinatorInternals
    const appendGate = Promise.withResolvers<boolean>()
    backend.beforeAppend = async () => {
      backend.lifecycle.push('append-started')
      await appendGate.promise
      backend.lifecycle.push('append-committed')
    }

    try {
      let session!: Session
      const sessionFiber = await ctx.plugin(Object.assign((inner: Context) => {
        session = inner.sessions.create(SessionId('inflight-retirement'))
      }, { inject: ['sessions'] }))
      session.append('turn/start', { turn: 1 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await sessionFiber.dispose()
      await vi.waitFor(() => {
        expect(backend.appendAttempts).toBe(1)
        expect(internals.live.size).toBe(1)
        expect([...internals.live.values()][0]?.writes.active).toBeInstanceOf(Promise)
      })

      let disposed = false
      const teardown = backendFiber.dispose().then(() => { disposed = true })
      await Promise.resolve()
      expect(disposed).toBe(false)
      expect(backend.lifecycle).toEqual(['append-started'])

      appendGate.resolve(true)
      await teardown
      expect(backend.store.get(SessionId('inflight-retirement'))?.events.map(event => event.seq)).toEqual([0, 1])
      expect(backend.lifecycle).toEqual(['append-started', 'append-committed', 'close'])
    } finally {
      appendGate.resolve(true)
      await backendFiber.dispose()
      await ctx.fiber.dispose()
    }
  })

  it('backend teardown waits for a detached public append before close', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const backend = new ControlledBackend()
    let coordinator!: PersistenceCoordinator<never>
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, backend)
    }, { inject: ['sessions'] }))
    const appendGate = Promise.withResolvers<boolean>()
    backend.beforeAppend = async () => {
      backend.lifecycle.push('append-started')
      await appendGate.promise
      backend.lifecycle.push('append-committed')
    }

    try {
      const id = SessionId('inflight-public-append')
      await coordinator.create(meta(id))
      const append = coordinator.append(id, [{
        type: 'turn/start',
        seq: 0,
        time: 1,
        data: { turn: 1 },
      }])
      await vi.waitFor(() => { expect(backend.appendAttempts).toBe(1) })

      let disposed = false
      const teardown = fiber.dispose().then(() => { disposed = true })
      await Promise.resolve()
      expect(disposed).toBe(false)

      appendGate.resolve(true)
      await Promise.all([append, teardown])
      expect(backend.lifecycle).toEqual(['append-started', 'append-committed', 'close'])
    } finally {
      appendGate.resolve(true)
      await fiber.dispose()
      await ctx.fiber.dispose()
    }
  })
})

describe('SessionPersistence service registration', () => {
  it('materializes an explicitly durable live session without adding events', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(MemoryPersistence)
    const session = ctx.sessions.create(SessionId('durable-empty'), { meta: { cwd: '/workspace' } })

    await ctx.sessionPersistence.ensureMaterialized(session)
    await ctx.sessionPersistence.ensureMaterialized(session)

    await expect(ctx.sessionPersistence.list()).resolves.toEqual([session.header])
    await expect(ctx.sessionPersistence.load(session.id)).resolves.toEqual({ meta: session.header, events: [] })
    await ctx.fiber.dispose()
  })

  it('fails loud when a direct backend does not support empty materialization', async () => {
    const session = Session.create(SessionId('unsupported-empty'))
    await expect(SessionPersistence.prototype.ensureMaterialized.call({} as SessionPersistence, session))
      .rejects.toThrow(/cannot materialize an empty session/)
  })

  it('fails loud when a coordinator backend omits empty materialization', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    let coordinator!: PersistenceCoordinator
    await ctx.plugin(Object.assign((inner: Context) => {
      coordinator = new PersistenceCoordinator(inner, new ControlledBackend())
    }, { inject: ['sessions'] }))
    const session = ctx.sessions.create(SessionId('unsupported-coordinator'))

    await expect(coordinator.ensureMaterialized(session)).rejects.toThrow(/cannot materialize an empty session/)
    await ctx.fiber.dispose()
  })

  it('accepts current aborted and error turn endings without legacy conversion', async () => {
    const store: MemoryStore = new Map()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const endings: SessionEvent[] = [
      {
        type: 'turn/end', seq: 5, time: 6,
        data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } },
      },
      {
        type: 'turn/end', seq: 5, time: 6,
        data: { turn: 1, reason: { kind: 'error', error: { message: 'failed', code: 'UNKNOWN' } } },
      },
    ]
    for (const [index, ending] of endings.entries()) {
      const m = meta(`current-ending-${index}`)
      store.set(m.id, { meta: m, events: [...oneTurnLog().slice(0, -1), ending] })
    }
    await ctx.plugin(MemoryPersistence, { store })
    await Promise.all([...store.keys()].map(id => ctx.sessionPersistence.load(SessionId(id))))
    await ctx.fiber.dispose()
  })

  it('rejects preparing an id that already has a live Session', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(MemoryPersistence)
    const session = ctx.sessions.create(SessionId('live-prepare-conflict'))

    await expect(ctx.sessionPersistence.prepare(session.id)).rejects.toThrow(/while it is live/)
    await ctx.fiber.dispose()
  })

  it('provides a cancellation-aware default preparation for simple backends', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(MemoryPersistence)
    const m = meta('default-preparation')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    const defaultPrepare = SessionPersistence.prototype.prepare.bind(ctx.sessionPersistence)

    const preparation = await defaultPrepare(m.id)
    expect(preparation.session.header).toEqual(m)
    preparation[Symbol.dispose]()

    const preAborted = new AbortController()
    const preAbortReason = new Error('pre-aborted preparation')
    preAborted.abort(preAbortReason)
    await expect(defaultPrepare(m.id, preAborted.signal))
      .rejects.toBe(preAbortReason)

    const postAborted = new AbortController()
    const postAbortReason = new Error('post-load preparation abort')
    const originalLoad = ctx.sessionPersistence.load.bind(ctx.sessionPersistence)
    ctx.sessionPersistence.load = async (id) => {
      const loaded = await originalLoad(id)
      postAborted.abort(postAbortReason)
      return loaded
    }
    await expect(defaultPrepare(m.id, postAborted.signal))
      .rejects.toBe(postAbortReason)

    await fiber.dispose()
  })

  it('requires SessionStore for the default preparation', async () => {
    const id = SessionId('default-preparation-without-store')
    const persistence = {
      ctx: new Context(),
      load: () => Promise.resolve({ meta: meta(id), events: oneTurnLog() }),
    } as unknown as SessionPersistence

    await expect(SessionPersistence.prototype.prepare.call(persistence, id))
      .rejects.toThrow(/SessionStore is not configured/)
  })

  it('registers as ctx.sessionPersistence and is removed on fiber dispose (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(MemoryPersistence)
    expect(ctx.sessionPersistence).toBeInstanceOf(SessionPersistence)

    await fiber.dispose()
    expect(ctx.sessionPersistence).toBeUndefined()
  })

  it('round-trips through the registered service instance', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(MemoryPersistence)
    const m = meta('reg')
    await ctx.sessionPersistence.create(m)
    await ctx.sessionPersistence.append(m.id, oneTurnLog())
    const loaded = await ctx.sessionPersistence.load(m.id)
    expect(loaded.events).toHaveLength(6)
    await fiber.dispose()
  })

  it('rejects non-JSON session metadata before registering lazy state', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(MemoryPersistence)
    const invalid = { ...meta('invalid-meta'), createdAt: 1n as unknown as number }

    await expect(ctx.sessionPersistence.create(invalid))
      .rejects.toThrow('session metadata must be losslessly JSON-serializable')
    await fiber.dispose()
  })

  it('rejects a legacy header delta from a pre-change live producer', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(MemoryPersistence)
    const session = ctx.sessions.create(SessionId('legacy-live'), { meta: { cwd: '/legacy' } })
    // Model the runtime shape available to JavaScript or a hot-loaded plugin
    // compiled against the obsolete event vocabulary.
    const appendLegacy = session.append.bind(session) as (type: string, data: unknown) => SessionEvent
    expect(() => appendLegacy('request/header-delta', { config: { model: 'legacy' } }))
      .toThrow(/unsupported legacy request\/header-delta format/)
    expect(session.snapshotEvents()).toHaveLength(0)
    await fiber.dispose()
  })

  it('rejects a legacy fallback header buffered by a pre-change live producer', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(MemoryPersistence)
    const session = ctx.sessions.create(SessionId('legacy-fallback-live'), { meta: { cwd: '/legacy' } })
    const appendLegacy = session.append.bind(session) as (type: string, data: unknown) => SessionEvent

    expect(() => appendLegacy('request/header', legacyFallbackHeader().data))
      .toThrow('unsupported legacy request/header reason "fallback"')
    expect(session.snapshotEvents()).toHaveLength(0)
    await fiber.dispose()
  })

  it('rejects a legacy stored prefix during live HMR adoption', async () => {
    const id = SessionId('legacy-hmr')
    const m = meta(id, '/legacy')
    const legacy = legacyHeaderDelta()
    const store: MemoryStore = new Map([[id, { meta: m, events: [legacy] }]])
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    // A current live session cannot carry the obsolete event in its seed, but
    // HMR still has to identify the persisted prefix as unsupported rather than
    // treating it as an ordinary live-prefix collision.
    const session = ctx.sessions.create(id, { meta: { cwd: '/legacy' } })
    const fiber = await ctx.plugin(MemoryPersistence, { store })

    await expect(ctx.sessions.flush(session))
      .rejects.toThrow(/unsupported legacy request\/header-delta event at seq 0/)
    await Promise.allSettled([fiber.dispose()])
  })

  it('rejects a stored legacy fallback header during load', async () => {
    const id = SessionId('legacy-fallback-load')
    const m = meta(id, '/legacy')
    const store: MemoryStore = new Map([[id, { meta: m, events: [legacyFallbackHeader()] }]])
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(MemoryPersistence, { store })

    await expect(ctx.sessionPersistence.load(id))
      .rejects.toThrow('unsupported legacy request/header reason "fallback" at seq 0')
    await fiber.dispose()
  })

  it('rejects a stored legacy named-mode event during load', async () => {
    const id = SessionId('legacy-mode-load')
    const m = meta(id, '/legacy')
    const store: MemoryStore = new Map([[id, { meta: m, events: [legacyModeSet()] }]])
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(MemoryPersistence, { store })

    await expect(ctx.sessionPersistence.load(id))
      .rejects.toThrow('unsupported legacy mode/set event at seq 0')
    await fiber.dispose()
  })

  it('retires all coordinator bookkeeping for disposed sessions', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = await ctx.plugin(MemoryPersistence)
    const { coordinator } = ctx.sessionPersistence as unknown as { coordinator: CoordinatorInternals }

    try {
      for (let index = 0; index < 3; index += 1) {
        let session!: Session
        const sessionFiber = await ctx.plugin(Object.assign((inner: Context) => {
          session = inner.sessions.create(SessionId(`disposed-${index}`))
        }, { inject: ['sessions'] }))
        session.append('turn/start', { turn: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
        await ctx.sessions.flush(session)
        await sessionFiber.dispose()
      }

      await vi.waitFor(() => {
        expect(ctx.sessions.list()).toHaveLength(0)
        expect({
          states: coordinator.states.size,
          live: coordinator.live.size,
          chains: coordinator.chains.size,
        }).toEqual({ states: 0, live: 0, chains: 0 })
      })
    } finally {
      await fiber.dispose()
    }
  })
})
