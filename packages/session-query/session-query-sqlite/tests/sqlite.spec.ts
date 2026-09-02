import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import { DatabaseSync } from 'node:sqlite'
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import SessionStore, { SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent, SessionHeader, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import SessionPersistence, {
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  SessionReadOnlyError,
} from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionAccess,
  SessionHandle,
  SessionHandleReadOptions,
  SessionPersistenceListOptions,
  SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SqliteSessionQueryEngine, {
  SESSION_QUERY_SQLITE_SCHEMA_VERSION,
} from '@deepseek-ai/dsh-session-query-sqlite'
import {
  SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY,
  SessionQueryError,
  SessionSearchCursor,
  type SessionAvailability,
  type SessionQueryErrorCode,
  type SessionSearchRequest,
} from '@deepseek-ai/dsh-session-query'

const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function temporaryPath(name = 'search.db'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-session-search-'))
  temporaryDirectories.push(directory)
  return join(directory, name)
}

function header(id: string, createdAt = 1, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt, isSeeded: false, ...extra }
}

function messageEvents(text: string, time = 1): SessionEvent[] {
  return [{
    type: 'user/message',
    seq: SessionSeq(0),
    time,
    data: createUserMessage({
      content: [{ type: 'text', text }], source: { kind: 'user' },
    }),
    surfaceOp: 'append',
  }]
}

function expectCode(code: SessionQueryErrorCode): Error {
  return expect.objectContaining({ code }) as Error
}

function replaceCursorOffset(
  cursor: ReturnType<typeof SessionSearchCursor>,
  offset: number,
): ReturnType<typeof SessionSearchCursor> {
  const payload = JSON.parse(
    Buffer.from(cursor, 'base64url').toString('utf8'),
  ) as Record<string, unknown>
  return SessionSearchCursor(Buffer.from(JSON.stringify({ ...payload, offset }), 'utf8').toString('base64url'))
}

class TestHandle implements SessionHandle {
  readonly inheritedEventCount = SessionLogOffset(0)

  constructor(
    readonly id: SessionIdType,
    readonly header: SessionHeader,
    readonly access: SessionAccess,
  ) {}

  async read(_offset = 0, _length?: number, options?: SessionHandleReadOptions): Promise<readonly SessionEvent[]> {
    TestPersistence.reads.set(this.id, (TestPersistence.reads.get(this.id) ?? 0) + 1)
    TestPersistence.readSignals.push(options?.signal)
    if (TestPersistence.failure !== undefined) throw TestPersistence.failure
    const entry = TestPersistence.entries.get(this.id)
    if (entry === undefined) throw new SessionPersistenceNotFoundError(this.id)
    await TestPersistence.readEffect?.(entry, options?.signal)
    TestPersistence.readEffect = undefined
    return structuredClone(entry.events)
  }

  append(events: readonly SessionEvent[]): Promise<void> {
    if (this.access === 'read') return Promise.reject(new SessionReadOnlyError(this.id, 'append'))
    const entry = TestPersistence.entries.get(this.id)
    if (entry === undefined) return Promise.reject(new SessionPersistenceNotFoundError(this.id))
    entry.events.push(...structuredClone(events))
    TestPersistence.revisions.set(this.id, ++TestPersistence.nextRevision)
    return Promise.resolve()
  }

  flush(): Promise<void> {
    if (this.access === 'read') return Promise.reject(new SessionReadOnlyError(this.id, 'flush'))
    return Promise.resolve()
  }

  close(): Promise<void> {
    return Promise.resolve()
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }
}

class TestPersistence extends SessionPersistence {
  static entries = new Map<SessionIdType, { meta: SessionHeader; events: SessionEvent[] }>()
  static revisions = new Map<SessionIdType, number>()
  static nextRevision = 0
  static reads = new Map<SessionIdType, number>()
  static readSignals: Array<AbortSignal | undefined> = []
  static listSignals: Array<AbortSignal | undefined> = []
  static readEffect: ((
    entry: { meta: SessionHeader; events: SessionEvent[] },
    signal?: AbortSignal,
  ) => void | Promise<void>) | undefined
  static listGate: Promise<void> | undefined
  static listStarted: (() => void) | undefined
  static listEffect: ((signal?: AbortSignal) => void | Promise<void>) | undefined
  static listOverride: (() => SessionPersistenceSnapshot[]) | undefined
  static failure: unknown

  static reset(entries: readonly { meta: SessionHeader; events: SessionEvent[] }[] = []): void {
    this.entries = new Map()
    this.revisions = new Map()
    this.reads = new Map()
    this.readSignals = []
    this.listSignals = []
    this.readEffect = undefined
    for (const entry of entries) this.set(entry)
    this.listGate = undefined
    this.listStarted = undefined
    this.listEffect = undefined
    this.listOverride = undefined
    this.failure = undefined
  }

  static set(entry: { meta: SessionHeader; events: SessionEvent[] }): void {
    this.entries.set(entry.meta.id, structuredClone(entry))
    this.revisions.set(entry.meta.id, ++this.nextRevision)
  }

  create(header: SessionHeader): Promise<SessionHandle> {
    TestPersistence.set({ meta: header, events: [] })
    return Promise.resolve(new TestHandle(header.id, structuredClone(header), 'write'))
  }

  // Appends are durable on resolution here; nothing buffers, so the service-wide flush is a no-op.
  async flush(): Promise<void> {}

  open(id: SessionIdType, access: SessionAccess): Promise<SessionHandle> {
    const entry = TestPersistence.entries.get(id)
    if (entry === undefined) return Promise.reject(new SessionPersistenceNotFoundError(id))
    return Promise.resolve(new TestHandle(id, structuredClone(entry.meta), access))
  }

  stat(id: SessionIdType): Promise<SessionPersistenceSnapshot | undefined> {
    const entry = TestPersistence.entries.get(id)
    if (entry === undefined) return Promise.resolve(undefined)
    return Promise.resolve({
      header: structuredClone(entry.meta),
      revision: SessionPersistenceRevision(`test:${TestPersistence.revisions.get(id)}`),
    })
  }

  async list(options?: SessionPersistenceListOptions): Promise<readonly SessionPersistenceSnapshot[]> {
    TestPersistence.listSignals.push(options?.signal)
    TestPersistence.listStarted?.()
    await TestPersistence.listGate
    if (TestPersistence.failure !== undefined) throw TestPersistence.failure
    const snapshots = TestPersistence.listOverride?.()
      ?? [...TestPersistence.entries.values()].map(entry => ({
        header: structuredClone(entry.meta),
        revision: SessionPersistenceRevision(`test:${TestPersistence.revisions.get(entry.meta.id)}`),
      }))
    await TestPersistence.listEffect?.(options?.signal)
    return snapshots
  }
}

async function liveContext(config: ConstructorParameters<typeof SqliteSessionQueryEngine>[1] = { path: ':memory:' }): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SqliteSessionQueryEngine, config)
  return ctx
}

describe('SQLite session search', () => {
  it('defaults and validates opening policy and persisted inspection concurrency through its Cordis config', async () => {
    const defaultCtx = await liveContext()
    expect((defaultCtx.sessionQuery as SqliteSessionQueryEngine).config.openAt).toBe('startup')
    expect((defaultCtx.sessionQuery as SqliteSessionQueryEngine).config.persistedReadConcurrency)
      .toBe(SESSION_QUERY_DEFAULT_PERSISTED_INSPECT_CONCURRENCY)

    const configuredValue = 2
    const configured = new SqliteSessionQueryEngine.Config({
      path: ':memory:',
      openAt: 'first-search',
      persistedReadConcurrency: configuredValue,
    })
    expect(configured.openAt).toBe('first-search')
    expect(configured.persistedReadConcurrency).toBe(configuredValue)
    const configuredCtx = await liveContext(configured)
    expect((configuredCtx.sessionQuery as SqliteSessionQueryEngine).config.persistedReadConcurrency)
      .toBe(configuredValue)

    for (const persistedReadConcurrency of [0, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => new SqliteSessionQueryEngine.Config({
        path: ':memory:',
        persistedReadConcurrency,
      })).toThrow()
    }
    expect(() => new SqliteSessionQueryEngine.Config({
      path: ':memory:',
      openAt: 'later' as never,
    })).toThrow()
  })

  it('mounts and disposes first-search mode without opening its database', async () => {
    const path = await temporaryPath('unopened.db')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const search = await ctx.plugin(SqliteSessionQueryEngine, {
      path,
      openAt: 'first-search',
    })

    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await search.dispose()
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses search in never mode while inherited reads and traces keep working', async () => {
    const path = await temporaryPath('never-mode.db')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const search = await ctx.plugin(SqliteSessionQueryEngine, { path, openAt: 'never' })
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    expect(service.config.openAt).toBe('never')

    const parent = SessionId('never-parent')
    const child = SessionId('never-child')
    ctx.sessions.create(parent, { seed: messageEvents('never opened needle'), meta: { createdAt: 10 } })
    ctx.sessions.create(child, { meta: { parentSession: parent, createdAt: 20 } })

    await expect(service.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SEARCH_DISABLED'))
    await expect(service.searchEvents({ sessionId: parent, query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SEARCH_DISABLED'))

    expect((await service.listSessions()).map(record => record.header.id).sort())
      .toEqual([child, parent])
    const lineage = await service.traceSession(parent)
    expect(lineage.complete).toBe(true)
    expect(lineage.descendants.map(node => node.session.header.id)).toEqual([child])

    // The disabled index never touches the filesystem, in mount, use, or disposal.
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    await search.dispose()
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('opens once on the first search and reuses readiness for later searches', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SqliteSessionQueryEngine, {
      path: ':memory:',
      openAt: 'first-search',
    })
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    const internals = service as unknown as { _open(): Promise<void> }
    const open = vi.spyOn(internals, '_open')

    await expect(service.searchSessions({ query: 'first' })).resolves.toEqual({ items: [] })
    await expect(service.searchSessions({ query: 'second' })).resolves.toEqual({ items: [] })

    expect(open).toHaveBeenCalledOnce()
  })

  it('shares one readiness promise across concurrent first searches', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SqliteSessionQueryEngine, {
      path: ':memory:',
      openAt: 'first-search',
    })
    const service = ctx.sessionQuery as SqliteSessionQueryEngine
    const internals = service as unknown as { _open(): Promise<void> }
    const originalOpen = internals._open.bind(internals)
    const release = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<undefined>()
    const open = vi.spyOn(internals, '_open').mockImplementation(async () => {
      started.resolve(undefined)
      await release.promise
      await originalOpen()
    })

    const first = service.searchSessions({ query: 'first' })
    const second = service.searchSessions({ query: 'second' })
    await started.promise
    expect(open).toHaveBeenCalledOnce()
    release.resolve(undefined)

    await expect(Promise.all([first, second])).resolves.toEqual([
      { items: [] },
      { items: [] },
    ])
    expect(open).toHaveBeenCalledOnce()
  })

  it('searches two-character Unicode61 tokens in live-only sessions', async () => {
    const ctx = await liveContext({ path: ':memory:', snippetChars: 20 })
    const session = ctx.sessions.create(SessionId('live'), {
      seed: messageEvents('inherited context'),
      inheritedEventCount: SessionLogOffset(1),
      // agentPreset rides along: the index rebuilds the header a caller reads,
      // and a session listed under the wrong composition is a lie about what it
      // ran. The full-header comparison below is what pins every column.
      meta: { cwd: '/work', createdAt: 10, isSeeded: true, delegationDepth: 2, agentPreset: 'minimal' },
    })
    session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'An AI helper' }], source: { kind: 'user' },
      }),
      { surfaceOp: 'append' },
    )

    await expect(ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'AI' }))
      .resolves.toMatchObject({
        session: session.header,
        items: [{ sessionId: session.id, seq: SessionSeq(2), snippet: 'An AI helper' }],
      })
    await expect(ctx.sessionQuery.searchSessions({ query: 'AI' }))
      .resolves.toMatchObject({ items: [{ header: session.header, live: true, persisted: false }] })
  })

  it('excludes assistant reasoning while indexing visible answer text', async () => {
    const ctx = await liveContext()
    const session = ctx.sessions.create(SessionId('reasoning'))
    session.append(
      'assistant/message',
      {
        turn: 1,
        step: 1,
        message: createAssistantMessage({
          content: [
            { type: 'reasoning', text: 'private-chain-marker' },
            { type: 'text', text: 'visible-answer-marker' },
          ],
          source: { provider: 'mock', model: 'mock' },
        }),
      },
      { surfaceOp: 'append' },
    )

    await expect(ctx.sessionQuery.searchSessions({ query: 'private-chain-marker' }))
      .resolves.toEqual({ items: [] })
    await expect(ctx.sessionQuery.searchSessions({ query: 'visible-answer-marker' }))
      .resolves.toMatchObject({
        items: [{
          header: { id: session.id },
          bestMatch: { snippet: 'visible-answer-marker' },
        }],
      })
  })

  it('searches all surfaces by default and applies metadata before ranking', async () => {
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 10, maxLimit: 20 })
    const parent = SessionId('parent')
    const events: SessionEvent[] = [
      { type: 'user/message', seq: SessionSeq(0), time: 10, data: createUserMessage({
        content: [{ type: 'text', text: 'needle original' }], source: { kind: 'user' },
      }), surfaceOp: 'append' },
      { type: 'assistant/chunk', seq: SessionSeq(1), time: 11, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'needle raw' } } },
      { type: 'user/message', seq: SessionSeq(2), time: 12, data: createUserMessage({
        content: [{ type: 'text', text: 'needle summary' }], source: { kind: 'plugin', plugin: 'test' },
      }), surfaceOp: { op: 'replace', start: SessionSeq(0), end: SessionSeq(0) }, sourceEventSeqs: [SessionSeq(0)] },
      { type: 'turn/end', seq: SessionSeq(3), time: 13, data: { turn: 1, reason: { kind: 'error', error: { message: 'needle failure', code: 'UNKNOWN' } } } },
    ]
    ctx.sessions.create(SessionId('a'), { seed: events, meta: { cwd: '/a', parentSession: parent, createdAt: 20 } })
    ctx.sessions.create(SessionId('b'), { seed: messageEvents('needle peer', 12), meta: { createdAt: 20 } })

    const all = await ctx.sessionQuery.searchEvents({ sessionId: SessionId('a'), query: 'needle' })
    expect(new Set(all.items.map(item => item.surface))).toEqual(new Set(['current', 'shadowed', 'log-only']))
    await expect(ctx.sessionQuery.searchEvents({
      sessionId: SessionId('a'),
      query: 'needle',
      filters: [
        { kind: 'seq', from: 2, to: 2 },
        { kind: 'time', from: 12, to: 12 },
        { kind: 'type', values: ['user/message'] },
        { kind: 'surface', values: ['current'] },
      ],
    })).resolves.toMatchObject({ items: [{ seq: SessionSeq(2), surface: 'current' }] })

    const grouped = await ctx.sessionQuery.searchSessions({
      query: 'needle',
      sessionFilters: [
        { kind: 'id', values: [SessionId('a')] },
        { kind: 'cwd', values: ['/a'] },
        { kind: 'created-at', from: 20, to: 20 },
        { kind: 'parent', values: [parent] },
        { kind: 'availability', values: ['live'] },
      ],
      eventFilters: [{ kind: 'surface', values: ['shadowed'] }],
    })
    expect(grouped.items).toHaveLength(1)
    expect(grouped.items[0]).toMatchObject({
      header: { id: SessionId('a'), cwd: '/a', parentSession: parent },
      live: true,
      persisted: false,
      bestMatch: { seq: SessionSeq(0), surface: 'shadowed' },
    })
  })

  it('searches at the supported FTS5 outer-predicate boundary in both scopes', async () => {
    const ctx = await liveContext()
    const session = ctx.sessions.create(SessionId('predicate-boundary'), {
      seed: messageEvents('needle'),
      meta: { cwd: '/work' },
    })
    const sessionFilters = Array.from(
      { length: 14 },
      () => ({ kind: 'cwd' as const, values: ['/work', null] }),
    )
    const eventFilters = Array.from(
      { length: 13 },
      () => ({ kind: 'type' as const, values: ['user/message' as const] }),
    )

    await expect(ctx.sessionQuery.searchSessions({ query: 'needle', sessionFilters }))
      .resolves.toMatchObject({ items: [{ header: { id: session.id } }] })
    await expect(ctx.sessionQuery.searchEvents({
      sessionId: session.id,
      query: 'needle',
      filters: eventFilters,
    })).resolves.toMatchObject({ items: [{ sessionId: session.id, seq: SessionSeq(0) }] })
  })

  it('rejects unsupported FTS5 outer-predicate counts with typed errors', async () => {
    const ctx = await liveContext()
    const session = ctx.sessions.create(SessionId('predicate-limit'), { seed: messageEvents('needle') })
    const sessionFilters = Array.from(
      { length: 1_100 },
      () => ({ kind: 'id' as const, values: [session.id] }),
    )
    const eventFilters = Array.from(
      { length: 1_100 },
      () => ({ kind: 'type' as const, values: ['user/message' as const] }),
    )

    await expect(ctx.sessionQuery.searchSessions({ query: 'needle', sessionFilters }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(ctx.sessionQuery.searchEvents({
      sessionId: session.id,
      query: 'needle',
      filters: eventFilters,
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(ctx.sessionQuery.searchSessions({
      query: 'needle',
      sessionFilters: sessionFilters.slice(0, 7),
      eventFilters: eventFilters.slice(0, 8),
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(ctx.sessionQuery.searchEvents({
      sessionId: session.id,
      query: 'needle',
      filters: eventFilters.slice(0, 14),
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
  })

  it('uses literal phrase tokens, stable ties, and bounded Unicode snippets', async () => {
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 10, maxLimit: 10, snippetChars: 5 })
    ctx.sessions.create(SessionId('a'), { seed: messageEvents('😀😀 alpha beta BRAID 😀😀', 10), meta: { createdAt: 1 } })
    ctx.sessions.create(SessionId('b'), { seed: messageEvents('alpha beta', 10), meta: { createdAt: 1 } })
    ctx.sessions.create(SessionId('c'), { seed: messageEvents('alpha middle beta', 10), meta: { createdAt: 1 } })
    ctx.sessions.create(SessionId('d'), { seed: messageEvents('alpha beta', 10), meta: { createdAt: 1 } })
    ctx.sessions.create(SessionId('operator'), { seed: messageEvents('needle OR absent', 10), meta: { createdAt: 1 } })
    ctx.sessions.create(SessionId('only'), { seed: messageEvents('needle only', 10), meta: { createdAt: 1 } })
    ctx.sessions.create(SessionId('quote'), { seed: messageEvents('say "needle" exactly', 10), meta: { createdAt: 1 } })

    const phrase = await ctx.sessionQuery.searchSessions({ query: 'alpha beta' })
    expect(phrase.items.map(item => item.header.id)).toEqual([SessionId('b'), SessionId('d'), SessionId('a')])
    expect(phrase.items.every(item => Array.from(item.bestMatch.snippet).length <= 5)).toBe(true)
    await expect(ctx.sessionQuery.searchSessions({ query: 'AI' })).resolves.toEqual({ items: [] })
    await expect(ctx.sessionQuery.searchSessions({ query: 'needle OR absent' }))
      .resolves.toMatchObject({ items: [{ header: { id: SessionId('operator') } }] })
    await expect(ctx.sessionQuery.searchSessions({ query: 'say "needle"' }))
      .resolves.toMatchObject({ items: [{ header: { id: SessionId('quote') } }] })
    await expect(ctx.sessionQuery.searchSessions({ query: '*' })).resolves.toEqual({ items: [] })
  })

  it('ranks live and persisted matches on one source-comparable contract', async () => {
    const persisted = header('z-persisted')
    TestPersistence.reset([
      { meta: persisted, events: messageEvents('needle needle', 10) },
      ...Array.from({ length: 12 }, (_, index) => ({
        meta: header(`filler-${index}`),
        events: messageEvents('needle', 10),
      })),
    ])
    const ctx = await liveContext()
    const persistence = await ctx.plugin(TestPersistence)
    ctx.sessions.create(SessionId('a-live'), {
      seed: messageEvents('needle needle', 10),
      meta: { createdAt: persisted.createdAt },
    })

    const result = await ctx.sessionQuery.searchSessions({
      query: 'needle',
      sessionFilters: [{ kind: 'id', values: [SessionId('a-live'), persisted.id] }],
    })
    expect(result.items.map(item => item.header.id)).toEqual([SessionId('a-live'), persisted.id])
    await persistence.dispose()
  })

  it('positions snippets from FTS5 matches across diacritics and punctuation', async () => {
    const ctx = await liveContext({ path: ':memory:', snippetChars: 14 })
    const session = ctx.sessions.create(SessionId('snippet'), {
      seed: messageEvents('long long long—café,\nnext value', 10),
    })

    const page = await ctx.sessionQuery.searchEvents({ sessionId: session.id, query: 'CAFE' })
    expect(page.items).toHaveLength(1)
    expect(page.items[0]!.snippet).toContain('café')
    expect(page.items[0]!.snippet).toContain('—')
    expect(page.items[0]!.snippet).not.toContain('\n')
    expect(Array.from(page.items[0]!.snippet).length).toBeLessThanOrEqual(14)
  })

  it('binds cursors to requests and only invalidates within-session pages for target changes', async () => {
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 1, maxLimit: 5 })
    const target = ctx.sessions.create(SessionId('target'), {
      seed: [
        ...messageEvents('needle one', 10),
        { ...messageEvents('needle two', 11)[0]!, seq: SessionSeq(1) },
        { ...messageEvents('needle three', 12)[0]!, seq: SessionSeq(2) },
      ],
    })
    ctx.sessions.create(SessionId('other'), { seed: messageEvents('needle other', 10) })

    const eventPage = await ctx.sessionQuery.searchEvents({ sessionId: target.id, query: 'needle', limit: 1 })
    const sessionPage = await ctx.sessionQuery.searchSessions({ query: 'needle', limit: 1 })
    expect(eventPage.nextCursor).toEqual(expect.any(String))
    expect(sessionPage.nextCursor).toEqual(expect.any(String))
    if (eventPage.nextCursor === undefined || sessionPage.nextCursor === undefined) throw new Error('expected cursors')

    const unsafeOffsetCursor = replaceCursorOffset(eventPage.nextCursor, 1e100)
    await expect(ctx.sessionQuery.searchEvents({
      sessionId: target.id,
      query: 'needle',
      limit: 1,
      cursor: unsafeOffsetCursor,
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_CURSOR'))

    const eventKeys = eventPage.items.map(item => `${item.sessionId}:${item.seq}`)
    let eventCursor: ReturnType<typeof SessionSearchCursor> | undefined = eventPage.nextCursor
    while (eventCursor !== undefined) {
      const next = await ctx.sessionQuery.searchEvents({
        sessionId: target.id,
        query: 'needle',
        limit: 1,
        cursor: eventCursor,
      })
      eventKeys.push(...next.items.map(item => `${item.sessionId}:${item.seq}`))
      eventCursor = next.nextCursor
    }
    expect(eventKeys).toHaveLength(3)
    expect(new Set(eventKeys).size).toBe(eventKeys.length)

    const sessionIds = sessionPage.items.map(item => item.header.id)
    let sessionCursor: ReturnType<typeof SessionSearchCursor> | undefined = sessionPage.nextCursor
    while (sessionCursor !== undefined) {
      const next = await ctx.sessionQuery.searchSessions({ query: 'needle', limit: 1, cursor: sessionCursor })
      sessionIds.push(...next.items.map(item => item.header.id))
      sessionCursor = next.nextCursor
    }
    expect(sessionIds).toHaveLength(2)
    expect(new Set(sessionIds).size).toBe(sessionIds.length)

    ctx.sessions.create(SessionId('unrelated'), { seed: messageEvents('needle unrelated', 20) })
    await expect(ctx.sessionQuery.searchEvents({
      sessionId: target.id,
      query: 'needle',
      limit: 1,
      cursor: eventPage.nextCursor,
    })).resolves.toMatchObject({ items: [{ sessionId: target.id }] })
    await expect(ctx.sessionQuery.searchSessions({ query: 'needle', limit: 1, cursor: sessionPage.nextCursor }))
      .rejects.toThrow(expectCode('SESSION_QUERY_STALE_CURSOR'))
    await expect(ctx.sessionQuery.searchEvents({
      sessionId: target.id,
      query: 'different',
      limit: 1,
      cursor: eventPage.nextCursor,
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_CURSOR'))

    target.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'needle four' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await expect(ctx.sessionQuery.searchEvents({
      sessionId: target.id,
      query: 'needle',
      limit: 1,
      cursor: eventPage.nextCursor,
    })).rejects.toThrow(expectCode('SESSION_QUERY_STALE_CURSOR'))
  })

  it('invalidates session cursors after transient persistence topology changes', async () => {
    TestPersistence.reset()
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 1, maxLimit: 5 })
    ctx.sessions.create(SessionId('first'), { seed: messageEvents('needle first') })
    ctx.sessions.create(SessionId('second'), { seed: messageEvents('needle second') })
    const page = await ctx.sessionQuery.searchSessions({ query: 'needle', limit: 1 })
    if (page.nextCursor === undefined) throw new Error('expected cursor')

    const persistence = await ctx.plugin(TestPersistence)
    await persistence.dispose()

    await expect(ctx.sessionQuery.searchSessions({
      query: 'needle',
      limit: 1,
      cursor: page.nextCursor,
    })).rejects.toThrow(expectCode('SESSION_QUERY_STALE_CURSOR'))
  })

  it('rejects invalid requests, filters, cursors, and direct config', async () => {
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 2, maxLimit: 3 })
    const session = ctx.sessions.create(SessionId('valid'), { seed: messageEvents('needle') })
    for (const request of [
      { sessionId: session.id, query: '' },
      { sessionId: session.id, query: 'needle', limit: 0 },
      { sessionId: session.id, query: 'needle', limit: 4 },
      { sessionId: session.id, query: 'needle', filters: [{ kind: 'seq', from: 2, to: 1 }] },
      { sessionId: session.id, query: 'needle', filters: [{ kind: 'surface', values: ['future'] }] },
      { sessionId: session.id, query: 'bad\0query' },
    ] as const) {
      await expect(ctx.sessionQuery.searchEvents(request as never)).rejects.toBeInstanceOf(Error)
    }
    await expect(ctx.sessionQuery.searchSessions({
      query: 'needle',
      sessionFilters: [{ kind: 'availability', values: ['remote' as never] }],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(ctx.sessionQuery.searchSessions({
      query: 'needle',
      sessionFilters: [{ kind: 'future' } as never],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(ctx.sessionQuery.searchSessions({
      query: 'needle',
      eventFilters: [{ kind: 'future' } as never],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(ctx.sessionQuery.searchEvents({
      sessionId: session.id,
      query: 'needle',
      filters: [{ kind: 'future' } as never],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(ctx.sessionQuery.searchEvents({
      sessionId: session.id,
      query: 'needle',
      cursor: SessionSearchCursor('not-json'),
    }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INVALID_CURSOR'))
    await expect(ctx.sessionQuery.searchEvents({ sessionId: SessionId('absent'), query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SESSION_NOT_FOUND'))

    for (const config of [
      { path: '' },
      { path: ':memory:', defaultLimit: 0 },
      { path: ':memory:', maxLimit: 0 },
      { path: ':memory:', defaultLimit: 1e100 },
      { path: ':memory:', maxLimit: 1e100 },
      { path: ':memory:', snippetChars: 0 },
      { path: ':memory:', readWindowMax: -1 },
      { path: ':memory:', persistedReadConcurrency: 0 },
      { path: ':memory:', persistedReadConcurrency: Number.MAX_SAFE_INTEGER + 1 },
      { path: ':memory:', preparedSessionCacheSize: 0 },
      { path: ':memory:', preparedSessionCacheSize: Number.MAX_SAFE_INTEGER + 1 },
      { path: ':memory:', defaultLimit: 3, maxLimit: 2 },
      { path: ':memory:', openAt: 'later' },
      { path: ':memory:', journalMode: 'memory' },
    ]) {
      const direct = new Context()
      await direct.plugin(SessionStore)
      expect(() => new SqliteSessionQueryEngine(direct, config as never))
        .toThrow(expectCode('SESSION_QUERY_INVALID_CONFIG'))
      expect(direct.sessionQuery).toBeUndefined()
    }
  })

  it('rejects aggregate filter bindings above SQLite\'s portable variable limit', async () => {
    const ctx = await liveContext()
    const session = ctx.sessions.create(SessionId('binding-limit'), { seed: messageEvents('needle') })
    // Each clause is below the ceiling; combined with its sibling and fixed
    // query bindings, the complete statement is not portable.
    const halfPortableLimit = 16_383
    const ids = Array.from(
      { length: halfPortableLimit },
      (_, index) => SessionId(`binding-${index}`),
    )
    const types = Array.from({ length: halfPortableLimit }, () => 'user/message' as const)
    const surfaces = Array.from({ length: halfPortableLimit }, () => 'current' as const)

    await expect(ctx.sessionQuery.searchSessions({
      query: 'needle',
      sessionFilters: [{ kind: 'id', values: ids }],
      eventFilters: [{ kind: 'type', values: types }],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
    await expect(ctx.sessionQuery.searchEvents({
      sessionId: session.id,
      query: 'needle',
      filters: [
        { kind: 'type', values: types },
        { kind: 'surface', values: surfaces },
      ],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
  })

  it('rejects one 125,000-value filter list with a typed error', async () => {
    const ctx = await liveContext()
    const ids = Array.from(
      { length: 125_000 },
      (_, index) => SessionId(`oversized-binding-${index}`),
    )

    await expect(ctx.sessionQuery.searchSessions({
      query: 'needle',
      sessionFilters: [{ kind: 'id', values: ids }],
    })).rejects.toThrow(expectCode('SESSION_QUERY_INVALID_FILTER'))
  })
})

describe('SQLite reconciliation and source lifecycle', () => {
  it('owns queued request and filter values before waiting for the serializer', async () => {
    const durable = header('owned')
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    const persistence = await ctx.plugin(TestPersistence)
    let release!: () => void
    TestPersistence.listGate = new Promise<void>((resolve) => { release = resolve })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    TestPersistence.listStarted = () => {
      TestPersistence.listStarted = undefined
      markStarted()
    }
    const blocking = ctx.sessionQuery.searchSessions({ query: 'needle' })
    await started

    const availability: SessionAvailability[] = ['persisted']
    const request: SessionSearchRequest = {
      query: 'needle',
      sessionFilters: [{ kind: 'availability', values: availability }],
    }
    const queued = ctx.sessionQuery.searchSessions(request)
    request.query = 'absent'
    availability[0] = 'live'
    release()

    await expect(blocking).resolves.toMatchObject({ items: [{ header: durable }] })
    await expect(queued).resolves.toMatchObject({ items: [{ header: durable }] })
    await persistence.dispose()
  })

  it('mounts persistence dynamically, shadows with TEMP live rows, reveals, and hides on unmount', async () => {
    const shared = header('shared', 10, { cwd: '/work' })
    const durable = header('durable', 5)
    TestPersistence.reset([
      { meta: shared, events: messageEvents('persisted needle') },
      { meta: durable, events: messageEvents('durable needle') },
    ])
    const ctx = await liveContext()
    await expect(ctx.sessionQuery.searchSessions({ query: 'durable' })).resolves.toEqual({ items: [] })
    const persistenceFiber = await ctx.plugin(TestPersistence)

    await expect(ctx.sessionQuery.searchSessions({ query: 'durable' }))
      .resolves.toMatchObject({ items: [{ header: durable, live: false, persisted: true }] })
    const live = ctx.sessions.prepare(shared.id, { meta: { createdAt: 10, cwd: '/work' } })
    live.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'live needle' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const detach = ctx.sessions.enter(live)
    ctx.sessions.announce(live)

    await expect(ctx.sessionQuery.searchSessions({ query: 'persisted' })).resolves.toEqual({ items: [] })
    await expect(ctx.sessionQuery.searchSessions({ query: 'live' }))
      .resolves.toMatchObject({ items: [{ header: shared, live: true, persisted: true }] })
    detach()
    await expect(ctx.sessionQuery.searchSessions({ query: 'persisted' }))
      .resolves.toMatchObject({ items: [{ header: shared, live: false, persisted: true }] })

    await persistenceFiber.dispose()
    await expect(ctx.sessionQuery.searchSessions({ query: 'durable' })).resolves.toEqual({ items: [] })
    await expect(ctx.sessionQuery.searchEvents({ sessionId: durable.id, query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SESSION_NOT_FOUND'))
  })

  it('does not load a persisted log while the same session is live', async () => {
    const shared = header('checkpointed-live', 10)
    TestPersistence.reset([{ meta: shared, events: messageEvents('persisted needle') }])
    const ctx = await liveContext()
    const live = ctx.sessions.prepare(shared.id, {
      seed: messageEvents('live needle'),
      meta: { createdAt: shared.createdAt },
    })
    const detach = ctx.sessions.enter(live)
    ctx.sessions.announce(live)
    const persistence = await ctx.plugin(TestPersistence)

    await expect(ctx.sessionQuery.searchSessions({
      query: 'live',
      sessionFilters: [{ kind: 'availability', values: ['persisted'] }],
    })).resolves.toMatchObject({
      items: [{ header: shared, live: true, persisted: true }],
    })
    expect(TestPersistence.reads.get(shared.id)).toBeUndefined()

    detach()
    await expect(ctx.sessionQuery.searchSessions({ query: 'persisted' }))
      .resolves.toMatchObject({ items: [{ header: shared, live: false, persisted: true }] })
    expect(TestPersistence.reads.get(shared.id)).toBe(1)
    await persistence.dispose()
  })

  it('retries when a live owner attaches during persistence observation', async () => {
    TestPersistence.reset()
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    TestPersistence.listEffect = () => {
      TestPersistence.listEffect = undefined
      ctx.sessions.create(SessionId('attached'), { seed: messageEvents('attached needle') })
    }

    await expect(ctx.sessionQuery.searchSessions({ query: 'attached' }))
      .resolves.toMatchObject({ items: [{ header: { id: SessionId('attached') } }] })
  })

  it('prefers a live owner that attaches during a persisted read and never mutates the store', async () => {
    const shared = header('attach-during-read', 10)
    const persistedEvents = messageEvents('persisted needle')
    TestPersistence.reset([{ meta: shared, events: persistedEvents }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    TestPersistence.readEffect = () => {
      ctx.sessions.create(shared.id, {
        seed: messageEvents('live needle'),
        meta: { createdAt: shared.createdAt },
      })
    }

    await expect(ctx.sessionQuery.searchSessions({ query: 'live' }))
      .resolves.toMatchObject({ items: [{ header: shared, live: true, persisted: true }] })
    // The cold read is observation-only: the stored log is unchanged.
    expect(TestPersistence.entries.get(shared.id)?.events).toEqual(persistedEvents)
  })

  it('retries when one live owner replaces another during persistence observation', async () => {
    TestPersistence.reset()
    const ctx = await liveContext()
    const first = ctx.sessions.prepare(SessionId('first'), { seed: messageEvents('first needle') })
    const detachFirst = ctx.sessions.enter(first)
    ctx.sessions.announce(first)
    await ctx.plugin(TestPersistence)
    TestPersistence.listEffect = () => {
      TestPersistence.listEffect = undefined
      detachFirst()
      ctx.sessions.create(SessionId('second'), { seed: messageEvents('second needle') })
    }

    await expect(ctx.sessionQuery.searchSessions({ query: 'second' }))
      .resolves.toMatchObject({ items: [{ header: { id: SessionId('second') } }] })
  })

  it('uses the reconciled persistence binding through the query boundary', async () => {
    const durable = header('post-reconcile-unmount')
    TestPersistence.reset([{ meta: durable, events: [
      ...messageEvents('durable needle', 1),
      { ...messageEvents('durable needle again', 2)[0]!, seq: SessionSeq(1) },
    ] }])
    const ctx = await liveContext({ path: ':memory:', defaultLimit: 1, maxLimit: 2 })
    const persistence = await ctx.plugin(TestPersistence)
    const internals = ctx.sessionQuery as unknown as {
      _reconcile(signal: AbortSignal | undefined): Promise<{
        identity: symbol
        service?: SessionPersistence
      }>
    }
    const reconcile = internals._reconcile.bind(internals)
    const boundary = vi.spyOn(internals, '_reconcile').mockImplementation(async (signal) => {
      const binding = await reconcile(signal)
      await persistence.dispose()
      return binding
    })

    const page = await ctx.sessionQuery.searchEvents({
      sessionId: durable.id,
      query: 'needle',
      limit: 1,
    })
    expect(page.items).toMatchObject([{ sessionId: durable.id }])
    expect(page.nextCursor).toEqual(expect.any(String))
    boundary.mockRestore()
    await expect(ctx.sessionQuery.searchEvents({ sessionId: durable.id, query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SESSION_NOT_FOUND'))
  })

  it('discards a stale list rejection when persistence unmounts during observation', async () => {
    const durable = header('racing')
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    const persistenceFiber = await ctx.plugin(TestPersistence)
    let release!: () => void
    TestPersistence.listGate = new Promise<void>((resolve) => { release = resolve })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    TestPersistence.listStarted = () => {
      TestPersistence.listStarted = undefined
      markStarted()
    }

    const search = ctx.sessionQuery.searchSessions({ query: 'needle' })
    await started
    await persistenceFiber.dispose()
    TestPersistence.failure = new Error('stale backend rejection')
    release()
    await expect(search).resolves.toEqual({ items: [] })
  })

  it('retries against a replacement after the prior binding rejects', async () => {
    const durable = header('replacement')
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    const prior = await ctx.plugin(TestPersistence)
    let rejectPrior!: (reason: unknown) => void
    TestPersistence.listGate = new Promise<void>((_resolve, reject) => { rejectPrior = reject })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    TestPersistence.listStarted = () => {
      TestPersistence.listStarted = undefined
      markStarted()
    }

    const search = ctx.sessionQuery.searchSessions({ query: 'needle' })
    await started
    await prior.dispose()
    TestPersistence.listGate = undefined
    const replacement = await ctx.plugin(TestPersistence)
    rejectPrior(new Error('stale prior binding'))
    await expect(search).resolves.toMatchObject({ items: [{ header: durable }] })
    await replacement.dispose()
  })

  it('reloads a replacement source even when its opaque revisions collide', async () => {
    const durable = header('colliding-replacement')
    TestPersistence.reset([{ meta: durable, events: messageEvents('old content') }])
    const revision = TestPersistence.revisions.get(durable.id)!
    const ctx = await liveContext()
    const prior = await ctx.plugin(TestPersistence)
    await expect(ctx.sessionQuery.searchSessions({ query: 'old' }))
      .resolves.toMatchObject({ items: [{ header: durable }] })
    await prior.dispose()

    TestPersistence.set({ meta: durable, events: messageEvents('new needle') })
    TestPersistence.revisions.set(durable.id, revision)
    const replacement = await ctx.plugin(TestPersistence)
    const page = await ctx.sessionQuery.searchSessions({ query: 'new needle' })
    expect(TestPersistence.reads.get(durable.id)).toBe(2)
    expect(page).toMatchObject({ items: [{ header: durable }] })
    await expect(ctx.sessionQuery.searchSessions({ query: 'old' })).resolves.toEqual({ items: [] })
    expect(TestPersistence.reads.get(durable.id)).toBe(2)
    await replacement.dispose()
  })

  it('retries when a successful observation belongs to a source unmounted during listing', async () => {
    const durable = header('successful-unmount')
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    const persistence = await ctx.plugin(TestPersistence)
    let lists = 0
    TestPersistence.listEffect = async () => {
      lists += 1
      if (lists === 2) await persistence.dispose()
    }

    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' })).resolves.toEqual({ items: [] })
    expect(lists).toBe(2)
  })

  it('retries when the snapshot population changes during observation', async () => {
    const first = header('first')
    const added = header('added-during-list')
    TestPersistence.reset([{ meta: first, events: messageEvents('first needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    TestPersistence.listEffect = () => {
      TestPersistence.listEffect = undefined
      TestPersistence.set({ meta: added, events: messageEvents('added needle') })
    }

    const page = await ctx.sessionQuery.searchSessions({ query: 'needle' })
    expect(page.items.map(item => item.header.id).sort()).toEqual([added.id, first.id].sort())
    expect(TestPersistence.reads.get(first.id)).toBe(2)
    expect(TestPersistence.reads.get(added.id)).toBe(1)
  })

  it('fails after one retry when persistence snapshots keep changing', async () => {
    const durable = header('continuous-mutation')
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    let lists = 0
    TestPersistence.listEffect = () => {
      lists += 1
      TestPersistence.set({ meta: durable, events: messageEvents(`durable needle ${lists}`) })
    }

    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    expect(lists).toBe(4)
  })

  it('retries if the persistence binding changes while live sessions are observed', async () => {
    const durable = header('live-boundary-retry')
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    const internals = ctx.sessionQuery as unknown as {
      _persistenceBinding: { identity: symbol; service?: SessionPersistence }
    }
    const originalList = ctx.sessions.list.bind(ctx.sessions)
    let bumped = false
    const list = vi.spyOn(ctx.sessions, 'list').mockImplementation(() => {
      if (!bumped) {
        bumped = true
        internals._persistenceBinding = {
          ...internals._persistenceBinding,
          identity: Symbol(),
        }
      }
      return originalList()
    })

    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' }))
      .resolves.toMatchObject({ items: [{ header: durable }] })
    expect(TestPersistence.reads.get(durable.id)).toBe(2)
    list.mockRestore()
  })

  it('rejects malformed snapshots and preserves typed persistence failures', async () => {
    const durable = header('invalid-snapshot')
    TestPersistence.reset([{ meta: durable, events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)

    TestPersistence.listOverride = () => 'not-an-array' as never
    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    TestPersistence.listOverride = () => [{ header: durable, revision: 1 as never }]
    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    TestPersistence.listOverride = () => [
      { header: durable, revision: SessionPersistenceRevision('duplicate:1') },
      { header: durable, revision: SessionPersistenceRevision('duplicate:2') },
    ]
    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))

    TestPersistence.listOverride = undefined
    const typed = new SessionQueryError('typed persistence failure', 'SESSION_QUERY_PERSISTENCE_FAILED')
    TestPersistence.failure = typed
    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' })).rejects.toBe(typed)
  })

  it('rejects immutable header conflicts between live and persisted sources', async () => {
    const shared = header('conflict', 10, { delegationDepth: 1 })
    TestPersistence.reset([{ meta: shared, events: messageEvents('persisted needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    ctx.sessions.create(shared.id, {
      seed: messageEvents('live needle'),
      meta: { createdAt: 10, delegationDepth: 2 },
    })

    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SOURCE_CONFLICT'))
  })

  it('preserves unchanged persisted generations while reconciling new, changed, and deleted rows', { timeout: 20_000 }, async () => {
    const path = await temporaryPath()
    const unchanged = header('unchanged')
    const changed = header('changed')
    const deleted = header('deleted')
    TestPersistence.reset([
      { meta: unchanged, events: messageEvents('unchanged needle') },
      { meta: changed, events: messageEvents('old needle') },
      { meta: deleted, events: messageEvents('deleted needle') },
    ])
    const first = new Context()
    await first.plugin(SessionStore)
    await first.plugin(SessionProjectionRegistry)
    const firstPersistence = await first.plugin(TestPersistence)
    const firstSearch = await first.plugin(SqliteSessionQueryEngine, { path })
    await first.sessionQuery.searchSessions({ query: 'needle' })
    expect(Object.fromEntries(TestPersistence.reads)).toEqual({ unchanged: 1, changed: 1, deleted: 1 })
    await first.sessionQuery.searchSessions({ query: 'needle' })
    expect(Object.fromEntries(TestPersistence.reads)).toEqual({ unchanged: 1, changed: 1, deleted: 1 })
    await firstSearch.dispose()
    await firstPersistence.dispose()

    const beforeDb = new DatabaseSync(path)
    const beforeRows = beforeDb.prepare('SELECT id, generation FROM persisted_sessions ORDER BY id').all() as Array<{ id: string; generation: number }>
    beforeDb.close()
    const before = new Map(beforeRows.map(row => [row.id, row.generation]))

    const added = header('added')
    TestPersistence.entries.delete(deleted.id)
    TestPersistence.set({ meta: changed, events: messageEvents('changed needle') })
    TestPersistence.set({ meta: added, events: messageEvents('added needle') })
    const second = new Context()
    await second.plugin(SessionStore)
    await second.plugin(SessionProjectionRegistry)
    const secondPersistence = await second.plugin(TestPersistence)
    const secondSearch = await second.plugin(SqliteSessionQueryEngine, { path })
    const result = await second.sessionQuery.searchSessions({ query: 'needle' })
    expect(result.items.map(item => item.header.id).sort()).toEqual([added.id, changed.id, unchanged.id].sort())
    expect(Object.fromEntries(TestPersistence.reads)).toEqual({
      unchanged: 1,
      changed: 2,
      deleted: 1,
      added: 1,
    })
    await secondSearch.dispose()
    await secondPersistence.dispose()

    const afterDb = new DatabaseSync(path)
    const afterRows = afterDb.prepare('SELECT id, generation FROM persisted_sessions ORDER BY id').all() as Array<{ id: string; generation: number }>
    afterDb.close()
    const after = new Map(afterRows.map(row => [row.id, row.generation]))
    expect(after.get(unchanged.id)).toBe(before.get(unchanged.id))
    expect(after.get(changed.id)).toBeGreaterThan(before.get(changed.id)!)
    expect(after.has(deleted.id)).toBe(false)
    expect(after.has(added.id)).toBe(true)
  })

  it('drops connection-local live overlays on reopen and retains persistent bases', async () => {
    const path = await temporaryPath()
    const shared = header('shared', 10)
    TestPersistence.reset([{ meta: shared, events: messageEvents('persisted needle') }])
    const first = new Context()
    await first.plugin(SessionStore)
    await first.plugin(SessionProjectionRegistry)
    const persistence = await first.plugin(TestPersistence)
    const live = first.sessions.create(shared.id, { seed: messageEvents('live needle'), meta: { createdAt: 10 } })
    const search = await first.plugin(SqliteSessionQueryEngine, { path })
    await expect(first.sessionQuery.searchEvents({ sessionId: live.id, query: 'live' })).resolves.toMatchObject({ items: [{}] })
    await search.dispose()
    await persistence.dispose()

    const second = new Context()
    await second.plugin(SessionStore)
    await second.plugin(SessionProjectionRegistry)
    const persistenceAgain = await second.plugin(TestPersistence)
    const searchAgain = await second.plugin(SqliteSessionQueryEngine, { path })
    await expect(second.sessionQuery.searchSessions({ query: 'live' })).resolves.toEqual({ items: [] })
    await expect(second.sessionQuery.searchSessions({ query: 'persisted' }))
      .resolves.toMatchObject({ items: [{ header: shared, live: false, persisted: true }] })
    expect(TestPersistence.reads.get(shared.id)).toBe(1)
    await searchAgain.dispose()
    await persistenceAgain.dispose()
  })

  it('refreshes after an external writer replaces a stored log, then reuses the new revision', async () => {
    const durable = header('repair')
    TestPersistence.reset([{ meta: durable, events: messageEvents('before repair') }])
    const ctx = await liveContext()
    const persistence = await ctx.plugin(TestPersistence)
    await expect(ctx.sessionQuery.searchSessions({ query: 'before' }))
      .resolves.toMatchObject({ items: [{ header: durable }] })
    // An external writer (resume-time torn-tail repair, or another append)
    // replaces the stored log and moves its revision.
    TestPersistence.set({ meta: durable, events: messageEvents('repaired needle') })

    await expect(ctx.sessionQuery.searchSessions({ query: 'repaired' }))
      .resolves.toMatchObject({ items: [{ header: durable }] })
    expect(TestPersistence.reads.get(durable.id)).toBe(2)
    await ctx.sessionQuery.searchSessions({ query: 'repaired' })
    expect(TestPersistence.reads.get(durable.id)).toBe(2)
    await persistence.dispose()
  })

  it('recovers on the next search after source and SQLite transaction failures', async () => {
    TestPersistence.reset([{ meta: header('durable'), events: messageEvents('durable needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    TestPersistence.failure = 'offline'
    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    const signal = new AbortController().signal
    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' }, { signal }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    TestPersistence.failure = new Error('still offline')
    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' }, { signal }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    TestPersistence.failure = undefined
    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' })).resolves.toMatchObject({ items: [{}] })

    const live = ctx.sessions.create(SessionId('live'), { seed: messageEvents('base') })
    await ctx.sessionQuery.searchEvents({ sessionId: live.id, query: 'base' })
    const db = (ctx.sessionQuery as unknown as { _db: DatabaseSync })._db
    db.exec('PRAGMA query_only = ON')
    live.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'retry needle' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await expect(ctx.sessionQuery.searchEvents({ sessionId: live.id, query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    db.exec('PRAGMA query_only = OFF')
    // seq 2: one-event seed, end-seed, then the live message.
    await expect(ctx.sessionQuery.searchEvents({ sessionId: live.id, query: 'needle' }))
      .resolves.toMatchObject({ items: [{ seq: SessionSeq(2) }] })
  })
})

describe('SQLite schema, cancellation, and real persistence integration', () => {
  it('creates a new database and WAL sidecars owner-only without changing its parent mode', async () => {
    if (process.platform === 'win32') return
    const path = await temporaryPath()
    const directory = dirname(path)
    await chmod(directory, 0o755)

    const ctx = await liveContext({ path })
    await ctx.sessionQuery.searchSessions({ query: 'needle' })

    expect((await stat(directory)).mode & 0o777).toBe(0o755)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(`${path}-wal`)).mode & 0o777).toBe(0o600)
    expect((await stat(`${path}-shm`)).mode & 0o777).toBe(0o600)
    await (ctx.sessionQuery as SqliteSessionQueryEngine).close()
  })

  it('creates a persistent rollback journal owner-only', async () => {
    if (process.platform === 'win32') return
    const path = await temporaryPath()
    const ctx = await liveContext({ path, journalMode: 'persist' })
    await ctx.sessionQuery.searchSessions({ query: 'needle' })

    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(`${path}-journal`)).mode & 0o777).toBe(0o600)
    await (ctx.sessionQuery as SqliteSessionQueryEngine).close()
  })

  it('preserves the mode of an existing database file', async () => {
    if (process.platform === 'win32') return
    const path = await temporaryPath()
    await writeFile(path, '', { mode: 0o644 })
    await chmod(path, 0o644)

    const ctx = await liveContext({ path, journalMode: 'delete' })
    await ctx.sessionQuery.searchSessions({ query: 'needle' })

    expect((await stat(path)).mode & 0o777).toBe(0o644)
    await (ctx.sessionQuery as SqliteSessionQueryEngine).close()
  })

  it('surfaces filesystem failures while pre-creating the database', async () => {
    const path = `${await temporaryPath()}\0`
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)

    await expect(ctx.plugin(SqliteSessionQueryEngine, { path })).rejects.toMatchObject({
      code: 'SESSION_QUERY_INDEX_FAILED',
      cause: { code: 'ERR_INVALID_ARG_VALUE' },
    })
    expect(ctx.sessionQuery).toBeUndefined()
  })

  it('resets a recognized incompatible schema but refuses unknown or foreign tables', { timeout: 20_000 }, async () => {
    const stalePath = await temporaryPath('stale.db')
    const staleOwner = await liveContext({ path: stalePath })
    await (staleOwner.sessionQuery as SqliteSessionQueryEngine).close()
    const stale = new DatabaseSync(stalePath)
    stale.exec(`PRAGMA user_version = ${SESSION_QUERY_SQLITE_SCHEMA_VERSION - 1}`)
    stale.close()
    const staleCtx = await liveContext({ path: stalePath })
    staleCtx.sessions.create(SessionId('live'), { seed: messageEvents('needle') })
    await staleCtx.sessionQuery.searchSessions({ query: 'needle' })
    await (staleCtx.sessionQuery as SqliteSessionQueryEngine).close()
    const rebuilt = new DatabaseSync(stalePath)
    expect((rebuilt.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
      .toBe(SESSION_QUERY_SQLITE_SCHEMA_VERSION)
    rebuilt.close()

    const augmentedPath = await temporaryPath('augmented.db')
    const augmentedOwner = await liveContext({ path: augmentedPath })
    await (augmentedOwner.sessionQuery as SqliteSessionQueryEngine).close()
    const augmented = new DatabaseSync(augmentedPath)
    augmented.exec('CREATE TABLE unrelated(value TEXT)')
    augmented.exec("INSERT INTO unrelated VALUES ('safe')")
    augmented.exec('PRAGMA user_version = 999')
    augmented.close()
    const augmentedCtx = new Context()
    await augmentedCtx.plugin(SessionStore)
    await augmentedCtx.plugin(SessionProjectionRegistry)
    await expect(augmentedCtx.plugin(SqliteSessionQueryEngine, { path: augmentedPath }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    expect(augmentedCtx.sessionQuery).toBeUndefined()
    const stillAugmented = new DatabaseSync(augmentedPath)
    expect(stillAugmented.prepare('SELECT value FROM unrelated').get()).toEqual({ value: 'safe' })
    expect(stillAugmented.prepare('PRAGMA user_version').get()).toEqual({ user_version: 999 })
    stillAugmented.close()

    const currentAugmentedPath = await temporaryPath('current-augmented.db')
    const currentAugmentedOwner = await liveContext({ path: currentAugmentedPath })
    await (currentAugmentedOwner.sessionQuery as SqliteSessionQueryEngine).close()
    const currentAugmented = new DatabaseSync(currentAugmentedPath)
    currentAugmented.exec('CREATE TABLE unrelated(value TEXT)')
    currentAugmented.exec("INSERT INTO unrelated VALUES ('safe')")
    currentAugmented.close()
    const currentAugmentedCtx = new Context()
    await currentAugmentedCtx.plugin(SessionStore)
    await currentAugmentedCtx.plugin(SessionProjectionRegistry)
    await expect(currentAugmentedCtx.plugin(SqliteSessionQueryEngine, {
      path: currentAugmentedPath,
      journalMode: 'delete',
    })).rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    expect(currentAugmentedCtx.sessionQuery).toBeUndefined()
    const stillCurrentAugmented = new DatabaseSync(currentAugmentedPath)
    expect(stillCurrentAugmented.prepare('SELECT value FROM unrelated').get()).toEqual({ value: 'safe' })
    expect(stillCurrentAugmented.prepare('PRAGMA user_version').get())
      .toEqual({ user_version: SESSION_QUERY_SQLITE_SCHEMA_VERSION })
    expect(stillCurrentAugmented.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    stillCurrentAugmented.close()

    const foreignPath = await temporaryPath('foreign.db')
    const foreign = new DatabaseSync(foreignPath)
    foreign.exec('PRAGMA journal_mode = WAL')
    foreign.exec('CREATE TABLE canonical(value TEXT)')
    foreign.exec("INSERT INTO canonical VALUES ('safe')")
    foreign.close()
    const foreignCtx = new Context()
    await foreignCtx.plugin(SessionStore)
    await foreignCtx.plugin(SessionProjectionRegistry)
    await expect(foreignCtx.plugin(SqliteSessionQueryEngine, { path: foreignPath, journalMode: 'delete' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    expect(foreignCtx.sessionQuery).toBeUndefined()
    const stillForeign = new DatabaseSync(foreignPath)
    expect(stillForeign.prepare('SELECT value FROM canonical').get()).toEqual({ value: 'safe' })
    expect(stillForeign.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    stillForeign.close()

    const wildcardPath = await temporaryPath('sqlite-wildcard.db')
    const wildcard = new DatabaseSync(wildcardPath)
    wildcard.exec('PRAGMA journal_mode = WAL')
    wildcard.exec('CREATE TABLE sqliteX(value TEXT)')
    wildcard.exec("INSERT INTO sqliteX VALUES ('safe')")
    wildcard.close()
    const wildcardCtx = new Context()
    await wildcardCtx.plugin(SessionStore)
    await wildcardCtx.plugin(SessionProjectionRegistry)
    await expect(wildcardCtx.plugin(SqliteSessionQueryEngine, {
      path: wildcardPath,
      journalMode: 'delete',
    })).rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    expect(wildcardCtx.sessionQuery).toBeUndefined()
    const stillWildcard = new DatabaseSync(wildcardPath)
    expect(stillWildcard.prepare('SELECT value FROM sqliteX').get()).toEqual({ value: 'safe' })
    expect(stillWildcard.prepare('PRAGMA application_id').get()).toEqual({ application_id: 0 })
    expect(stillWildcard.prepare('PRAGMA user_version').get()).toEqual({ user_version: 0 })
    expect(stillWildcard.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    stillWildcard.close()

    const otherAppPath = await temporaryPath('other-app.db')
    const otherApp = new DatabaseSync(otherAppPath)
    otherApp.exec('PRAGMA application_id = 123')
    otherApp.close()
    const otherAppCtx = new Context()
    await otherAppCtx.plugin(SessionStore)
    await otherAppCtx.plugin(SessionProjectionRegistry)
    await expect(otherAppCtx.plugin(SqliteSessionQueryEngine, { path: otherAppPath }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    expect(otherAppCtx.sessionQuery).toBeUndefined()
  })

  it('fails plugin initialization without an unhandled rejection or partial service', async () => {
    const path = await temporaryPath('never-queried.db')
    const foreign = new DatabaseSync(path)
    foreign.exec('CREATE TABLE canonical(value TEXT)')
    foreign.close()
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(SessionProjectionRegistry)
      await expect(ctx.plugin(SqliteSessionQueryEngine, { path }))
        .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      expect(unhandled).toEqual([])
      expect(ctx.sessionQuery).toBeUndefined()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('defers an invalid database failure only in first-search mode', async () => {
    const path = await temporaryPath('lazy-invalid.db')
    const foreign = new DatabaseSync(path)
    foreign.exec('CREATE TABLE canonical(value TEXT)')
    foreign.close()

    const lazyCtx = new Context()
    await lazyCtx.plugin(SessionStore)
    await lazyCtx.plugin(SessionProjectionRegistry)
    const lazy = await lazyCtx.plugin(SqliteSessionQueryEngine, {
      path,
      openAt: 'first-search',
    })
    expect(lazyCtx.sessionQuery).toBeInstanceOf(SqliteSessionQueryEngine)
    await expect(lazyCtx.sessionQuery.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    await lazy.dispose()

    const eagerCtx = new Context()
    await eagerCtx.plugin(SessionStore)
    await eagerCtx.plugin(SessionProjectionRegistry)
    await expect(eagerCtx.plugin(SqliteSessionQueryEngine, { path }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    expect(eagerCtx.sessionQuery).toBeUndefined()
  })

  it.each(['sessions', 'events'] as const)(
    'forwards one exact reconciliation signal through both snapshot lists and persisted inspection for %s search',
    async (scope) => {
      const durable = header(`signal-${scope}`)
      TestPersistence.reset([{ meta: durable, events: messageEvents('signal needle') }])
      const ctx = await liveContext()
      await ctx.plugin(TestPersistence)
      const controller = new AbortController()

      const result = scope === 'sessions'
        ? await ctx.sessionQuery.searchSessions({ query: 'needle' }, { signal: controller.signal })
        : await ctx.sessionQuery.searchEvents(
          { sessionId: durable.id, query: 'needle' },
          { signal: controller.signal },
        )

      expect(result.items).toHaveLength(1)
      expect(TestPersistence.listSignals).toEqual([controller.signal, controller.signal])
      expect(TestPersistence.readSignals).toEqual([controller.signal])
    },
  )

  it.each(['sessions', 'events'] as const)(
    'starts no persistence observation for a pre-aborted %s search',
    async (scope) => {
      const durable = header(`pre-aborted-${scope}`)
      TestPersistence.reset([{ meta: durable, events: messageEvents('needle') }])
      const ctx = await liveContext()
      await ctx.plugin(TestPersistence)
      const controller = new AbortController()
      controller.abort(new Error(`pre-aborted ${scope}`))

      const pending = scope === 'sessions'
        ? ctx.sessionQuery.searchSessions({ query: 'needle' }, { signal: controller.signal })
        : ctx.sessionQuery.searchEvents(
          { sessionId: durable.id, query: 'needle' },
          { signal: controller.signal },
        )

      await expect(pending).rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))
      expect(TestPersistence.listSignals).toEqual([])
      expect(TestPersistence.readSignals).toEqual([])
    },
  )

  it('awaits cooperative snapshot-list cancellation cleanup without starting another observation step', async () => {
    const durable = header('cooperative-list-abort')
    TestPersistence.reset([{ meta: durable, events: messageEvents('needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    const started = Promise.withResolvers<AbortSignal>()
    const abortObserved = Promise.withResolvers<undefined>()
    const cleanup = Promise.withResolvers<undefined>()
    TestPersistence.listEffect = async (signal) => {
      TestPersistence.listEffect = undefined
      if (signal === undefined) throw new Error('expected reconciliation signal')
      started.resolve(signal)
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      abortObserved.resolve(undefined)
      await cleanup.promise
      signal.throwIfAborted()
    }
    const controller = new AbortController()
    const pending = ctx.sessionQuery.searchSessions({ query: 'needle' }, { signal: controller.signal })
    expect(await started.promise).toBe(controller.signal)
    let settled = false
    void pending.then(
      () => { settled = true },
      () => { settled = true },
    )

    controller.abort(new Error('cooperative list cancellation'))
    await abortObserved.promise
    expect(settled).toBe(false)
    expect(TestPersistence.listSignals).toEqual([controller.signal])
    expect(TestPersistence.readSignals).toEqual([])

    cleanup.resolve(undefined)
    await expect(pending).rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))
  })

  it('keeps a second search serialized while an abort-ignoring snapshot list finishes', async () => {
    const durable = header('serialized-list-abort')
    TestPersistence.reset([{ meta: durable, events: messageEvents('needle') }])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    const cleanup = Promise.withResolvers<undefined>()
    const started = Promise.withResolvers<undefined>()
    TestPersistence.listGate = cleanup.promise
    TestPersistence.listStarted = () => {
      TestPersistence.listStarted = undefined
      started.resolve(undefined)
    }
    const controller = new AbortController()
    const first = ctx.sessionQuery.searchSessions({ query: 'needle' }, { signal: controller.signal })
    await started.promise
    let firstSettled = false
    let secondSettled = false
    void first.then(
      () => { firstSettled = true },
      () => { firstSettled = true },
    )
    controller.abort(new Error('ignored list cancellation'))
    const second = ctx.sessionQuery.searchEvents({ sessionId: durable.id, query: 'needle' })
    void second.then(
      () => { secondSettled = true },
      () => { secondSettled = true },
    )
    await Promise.resolve()

    expect(firstSettled).toBe(false)
    expect(secondSettled).toBe(false)
    expect(TestPersistence.listSignals).toEqual([controller.signal])
    expect(TestPersistence.readSignals).toEqual([])

    cleanup.resolve(undefined)
    await expect(first).rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))
    await expect(second).resolves.toMatchObject({ items: [{ sessionId: durable.id }] })
  })

  it('awaits an abort-ignoring inspection and starts neither another inspection nor the after-list', async () => {
    const first = header('ignored-inspect-first')
    const second = header('ignored-inspect-second')
    TestPersistence.reset([
      { meta: first, events: messageEvents('first needle') },
      { meta: second, events: messageEvents('second needle') },
    ])
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    const started = Promise.withResolvers<AbortSignal>()
    const cleanup = Promise.withResolvers<undefined>()
    TestPersistence.readEffect = async (_entry, signal) => {
      TestPersistence.readEffect = undefined
      if (signal === undefined) throw new Error('expected reconciliation signal')
      started.resolve(signal)
      await cleanup.promise
    }
    const controller = new AbortController()
    const pending = ctx.sessionQuery.searchSessions({ query: 'needle' }, { signal: controller.signal })
    expect(await started.promise).toBe(controller.signal)
    let settled = false
    void pending.then(
      () => { settled = true },
      () => { settled = true },
    )

    controller.abort(new Error('ignored inspect cancellation'))
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(TestPersistence.listSignals).toEqual([controller.signal])
    expect(TestPersistence.reads.get(first.id)).toBe(1)
    expect(TestPersistence.reads.get(second.id)).toBeUndefined()

    cleanup.resolve(undefined)
    await expect(pending).rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))
    expect(TestPersistence.listSignals).toEqual([controller.signal])
    expect(TestPersistence.reads.get(second.id)).toBeUndefined()
  })

  it('cancels both queued and in-flight source waits without committing them', async () => {
    TestPersistence.reset()
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)

    const boundaryController = new AbortController()
    const boundary = ctx.sessionQuery.searchSessions({ query: 'needle' }, { signal: boundaryController.signal })
    queueMicrotask(() => { boundaryController.abort() })
    await expect(boundary).rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))

    const readyController = new AbortController()
    readyController.abort()
    const internals = ctx.sessionQuery as unknown as {
      _ensureReady(signal: AbortSignal): Promise<void>
    }
    await expect(internals._ensureReady(readyController.signal))
      .rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))

    let releaseBlocking!: () => void
    TestPersistence.listGate = new Promise<void>((resolve) => { releaseBlocking = resolve })
    let markBlockingStarted!: () => void
    const blockingStarted = new Promise<void>((resolve) => { markBlockingStarted = resolve })
    TestPersistence.listStarted = () => {
      TestPersistence.listStarted = undefined
      markBlockingStarted()
    }
    const blocking = ctx.sessionQuery.searchSessions({ query: 'needle' })
    await blockingStarted

    const queuedController = new AbortController()
    const queued = ctx.sessionQuery.searchSessions({ query: 'needle' }, { signal: queuedController.signal })
    queuedController.abort()
    await expect(queued).rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))

    releaseBlocking()
    await expect(blocking).resolves.toEqual({ items: [] })

    TestPersistence.set({
      meta: header('uncommitted'),
      events: messageEvents('durable needle'),
    })
    let releaseActive!: () => void
    TestPersistence.listGate = new Promise<void>((resolve) => { releaseActive = resolve })
    let markActiveStarted!: () => void
    const activeStarted = new Promise<void>((resolve) => { markActiveStarted = resolve })
    TestPersistence.listStarted = () => {
      TestPersistence.listStarted = undefined
      markActiveStarted()
    }
    const activeController = new AbortController()
    const active = ctx.sessionQuery.searchSessions({ query: 'needle' }, { signal: activeController.signal })
    await activeStarted
    activeController.abort()
    let activeSettled = false
    void active.then(
      () => { activeSettled = true },
      () => { activeSettled = true },
    )
    await Promise.resolve()
    expect(activeSettled).toBe(false)
    releaseActive()
    await expect(active).rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))

    const db = (ctx.sessionQuery as unknown as { _db: DatabaseSync })._db
    expect(db.prepare('SELECT COUNT(*) AS count FROM persisted_sessions').get()).toEqual({ count: 0 })
    await expect(ctx.sessionQuery.searchSessions({ query: 'needle' }))
      .resolves.toMatchObject({ items: [{ header: { id: SessionId('uncommitted') } }] })
  })

  it.each([
    [new Error('ready error'), 'ready error'],
    ['non-error ready failure', 'session-search dependency rejected with a non-Error value'],
  ])('normalizes a rejected readiness wait before mapping it to an index error', async (failure, detail) => {
    TestPersistence.reset()
    const ctx = await liveContext()
    const internals = ctx.sessionQuery as unknown as {
      _ready: Promise<void>
      _ensureReady(signal: AbortSignal): Promise<void>
    }
    internals._ready = Promise.resolve().then(() => {
      throw failure
    })

    await expect(internals._ensureReady(new AbortController().signal))
      .rejects.toThrow(`session-search SQLite index failed to open: ${detail}`)
  })

  it('checks cancellation after readiness before reconciliation accesses SQLite', async () => {
    TestPersistence.reset()
    const ctx = await liveContext()
    const internals = ctx.sessionQuery as unknown as {
      _db: DatabaseSync
      _ready: Promise<void>
      _ensureReady(signal: AbortSignal | undefined): Promise<void>
    }
    const readiness = Promise.withResolvers<undefined>()
    internals._ready = readiness.promise
    const readyWaitStarted = Promise.withResolvers<undefined>()
    const ensureReady = internals._ensureReady.bind(internals)
    vi.spyOn(internals, '_ensureReady').mockImplementation(async (signal) => {
      const pending = ensureReady(signal)
      readyWaitStarted.resolve(undefined)
      return pending
    })
    const prepare = vi.spyOn(internals._db, 'prepare')
    const reason = new Error('cancelled after readiness')
    const controller = new AbortController()
    const pending = ctx.sessionQuery.searchSessions({ query: 'needle' }, { signal: controller.signal })
    await readyWaitStarted.promise

    const queueBoundaryAbort = readiness.promise.then(() => {
      queueMicrotask(() => { controller.abort(reason) })
    })
    readiness.resolve(undefined)
    await queueBoundaryAbort

    await expect(pending).rejects.toThrow(expectCode('SESSION_QUERY_ABORTED'))
    expect(prepare).not.toHaveBeenCalled()
  })

  it('rejects queued and future work when close waits for an accepted operation', async () => {
    TestPersistence.reset()
    let release!: () => void
    TestPersistence.listGate = new Promise<void>((resolve) => { release = resolve })
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => { markStarted = resolve })
    TestPersistence.listStarted = () => {
      TestPersistence.listStarted = undefined
      markStarted()
    }
    const ctx = await liveContext()
    await ctx.plugin(TestPersistence)
    const search = ctx.sessionQuery as SqliteSessionQueryEngine
    const accepted = search.searchSessions({ query: 'needle' })
    await started
    const queued = search.searchSessions({ query: 'needle' })
    const closing = search.close()
    const repeatedClose = search.close()
    expect(repeatedClose).toBe(closing)
    release()

    await expect(accepted).resolves.toEqual({ items: [] })
    await expect(queued).rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    await Promise.all([closing, repeatedClose])
    await expect(search.searchSessions({ query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INDEX_FAILED'))
    expect(search.close()).toBe(closing)
  })

  it('awaits optional-persistence child-fiber quiescence on disposal', async () => {
    TestPersistence.reset()
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const search = await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:' })
    const persistence = await ctx.plugin(TestPersistence)
    const optional = (ctx.sessionQuery as unknown as {
      _optionalPersistenceFiber: Fiber
    })._optionalPersistenceFiber
    let release!: () => void
    const cleanup = new Promise<void>((resolve) => { release = resolve })
    optional.ctx.effect(() => () => cleanup)

    let settled = false
    const disposing = search.dispose().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    release()
    await disposing
    await persistence.dispose()
  })

  it('combines the real JSONL persistence backend with the real search service keylessly', async () => {
    const persistenceRoot = await temporaryPath('sessions')
    const searchPath = await temporaryPath('derived.db')
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const persistence = await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
    const search = await ctx.plugin(SqliteSessionQueryEngine, { path: searchPath })
    const meta = header('real', 10, { cwd: '/work' })
    const writer = await ctx.sessionPersistence.create(meta)
    await writer.append(messageEvents('real JSONL needle'))
    await writer.close()

    await expect(ctx.sessionQuery.searchSessions({ query: 'JSONL needle' }))
      .resolves.toMatchObject({ items: [{ header: meta, persisted: true, live: false }] })
    await expect(ctx.sessionQuery.searchEvents({ sessionId: meta.id, query: 'JSONL needle' }))
      .resolves.toMatchObject({ session: meta, items: [{ sessionId: meta.id, seq: SessionSeq(0) }] })
    await expect(ctx.sessionQuery.searchEvents({ sessionId: SessionId('absent'), query: 'needle' }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SESSION_NOT_FOUND'))
    await search.dispose()
    const reader = await ctx.sessionPersistence.open(meta.id, 'read')
    expect(reader.header).toMatchObject(meta)
    await expect(reader.read()).resolves.toMatchObject([{ seq: SessionSeq(0) }])
    await reader.close()
    await persistence.dispose()
  })

  it('reconciles a reopened derived index: unchanged revisions skip reads, another store reloads', async () => {
    const persistenceRootA = await temporaryPath('sessions-a')
    const persistenceRootB = await temporaryPath('sessions-b')
    const searchPath = await temporaryPath('derived-collision.db')
    const shared = header('same-id', 10)
    const storeSession = async (ctx: Context, events: SessionEvent[]): Promise<void> => {
      const writer = await ctx.sessionPersistence.create(shared)
      await writer.append(events)
      await writer.close()
    }

    const first = new Context()
    await first.plugin(SessionStore)
    await first.plugin(SessionProjectionRegistry)
    const persistenceA = await first.plugin(JsonlSessionPersistence, { root: persistenceRootA, compression: 'none' })
    await storeSession(first, messageEvents('alpha source'))
    const openA = vi.spyOn(first.sessionPersistence, 'open')
    const searchA = await first.plugin(SqliteSessionQueryEngine, { path: searchPath })
    await expect(first.sessionQuery.searchSessions({ query: 'alpha' }))
      .resolves.toMatchObject({ items: [{ header: shared }] })
    expect(openA).toHaveBeenCalledTimes(1)
    await searchA.dispose()
    await persistenceA.dispose()

    const reopened = new Context()
    await reopened.plugin(SessionStore)
    await reopened.plugin(SessionProjectionRegistry)
    const persistenceAAgain = await reopened.plugin(JsonlSessionPersistence, { root: persistenceRootA, compression: 'none' })
    const reopenedOpen = vi.spyOn(reopened.sessionPersistence, 'open')
    const searchAAgain = await reopened.plugin(SqliteSessionQueryEngine, { path: searchPath })
    await expect(reopened.sessionQuery.searchSessions({ query: 'alpha' }))
      .resolves.toMatchObject({ items: [{ header: shared }] })
    expect(reopenedOpen).not.toHaveBeenCalled()
    await searchAAgain.dispose()
    await persistenceAAgain.dispose()

    const second = new Context()
    await second.plugin(SessionStore)
    await second.plugin(SessionProjectionRegistry)
    const persistenceB = await second.plugin(JsonlSessionPersistence, { root: persistenceRootB, compression: 'none' })
    await storeSession(second, messageEvents('bravo source'))
    const openB = vi.spyOn(second.sessionPersistence, 'open')
    const searchB = await second.plugin(SqliteSessionQueryEngine, { path: searchPath })
    await expect(second.sessionQuery.searchSessions({ query: 'bravo' }))
      .resolves.toMatchObject({ items: [{ header: shared }] })
    await expect(second.sessionQuery.searchSessions({ query: 'alpha' })).resolves.toEqual({ items: [] })
    expect(openB).toHaveBeenCalledTimes(1)
    await searchB.dispose()
    await persistenceB.dispose()
  })
})
