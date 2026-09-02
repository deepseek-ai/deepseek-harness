import { createUserMessage, createMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionLogOffset, SessionSeq, SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Session, SessionEvent, SessionHeader, SessionId as SessionIdType } from '@deepseek-ai/dsh-session'
import SessionPersistence, {
  SessionPersistenceNotFoundError,
  SessionPersistenceRevision,
  SessionReadOnlyError,
} from '@deepseek-ai/dsh-session-persistence'
import type {
  SessionAccess,
  SessionHandle,
  SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import { type SessionQueryErrorCode } from '@deepseek-ai/dsh-session-query'
import { TestSessionQueryEngine } from './test-service.ts'

type MutableSessionHeader = { -readonly [K in keyof SessionHeader]: SessionHeader[K] }

/** Test-only mutable view used to verify detached returned metadata. */
function mutableHeader(value: SessionHeader): MutableSessionHeader {
  return value
}

function header(id: string, createdAt = 1, extra: Partial<SessionHeader> = {}): SessionHeader {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt, isSeeded: false, ...extra }
}

function appendEvent(seq: number, sources?: readonly number[]): SessionEvent {
  return {
    type: 'user/message',
    seq: SessionSeq(seq),
    time: seq + 1,
    data: createUserMessage({
      content: [{ type: 'text', text: `event ${seq}` }], source: { kind: 'user' },
    }),
    surfaceOp: 'append',
    ...sources === undefined ? {} : { sourceEventSeqs: sources as unknown as SessionSeq[] },
  }
}

class TraceHandle implements SessionHandle {
  readonly inheritedEventCount = SessionLogOffset(0)
  constructor(
    readonly id: SessionIdType,
    readonly header: SessionHeader,
    readonly access: SessionAccess,
  ) {}

  read(): Promise<readonly SessionEvent[]> {
    TracePersistence.readCalls += 1
    if (TracePersistence.readFailure !== undefined) return Promise.reject(TracePersistence.readFailure)
    const entry = TracePersistence.entries.get(this.id)
    if (entry === undefined) return Promise.reject(new SessionPersistenceNotFoundError(this.id))
    return Promise.resolve(structuredClone(entry.events))
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

class TracePersistence extends SessionPersistence {
  static entries = new Map<SessionIdType, { meta: SessionHeader; events: SessionEvent[] }>()
  static listCalls = 0
  static readCalls = 0
  static listFailure: Error | undefined
  static readFailure: Error | undefined
  static afterList: (() => void) | undefined

  static reset(entries: readonly { meta: SessionHeader; events: SessionEvent[] }[] = []): void {
    this.entries = new Map(entries.map(entry => [entry.meta.id, structuredClone(entry)]))
    this.listCalls = 0
    this.readCalls = 0
    this.listFailure = undefined
    this.readFailure = undefined
    this.afterList = undefined
  }

  create(header: SessionHeader): Promise<SessionHandle> {
    TracePersistence.entries.set(header.id, { meta: structuredClone(header), events: [] })
    return Promise.resolve(new TraceHandle(header.id, structuredClone(header), 'write'))
  }

  // Appends are durable on resolution here; nothing buffers, so the service-wide flush is a no-op.
  async flush(): Promise<void> {}

  open(id: SessionIdType, access: SessionAccess): Promise<SessionHandle> {
    const entry = TracePersistence.entries.get(id)
    if (entry === undefined) return Promise.reject(new SessionPersistenceNotFoundError(id))
    return Promise.resolve(new TraceHandle(id, structuredClone(entry.meta), access))
  }

  stat(id: SessionIdType): Promise<SessionPersistenceSnapshot | undefined> {
    const entry = TracePersistence.entries.get(id)
    if (entry === undefined) return Promise.resolve(undefined)
    return Promise.resolve({
      header: structuredClone(entry.meta),
      revision: SessionPersistenceRevision(`events:${entry.events.length}`),
    })
  }

  list(): Promise<readonly SessionPersistenceSnapshot[]> {
    TracePersistence.listCalls += 1
    if (TracePersistence.listFailure !== undefined) return Promise.reject(TracePersistence.listFailure)
    const result = [...TracePersistence.entries.values()].map(entry => ({
      header: structuredClone(entry.meta),
      revision: SessionPersistenceRevision(`events:${entry.events.length}`),
    }))
    TracePersistence.afterList?.()
    return Promise.resolve(result)
  }
}

async function queryContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TestSessionQueryEngine)
  return ctx
}

function expectCode(code: SessionQueryErrorCode): Error {
  return expect.objectContaining({ code }) as Error
}

function appendTraceEvents(session: Session): void {
  session.append('turn/start', { turn: 1 })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/chunk', {
    turn: 1,
    step: 1,
    chunk: { type: 'text-delta', index: 0, text: 'draft' },
  })
  session.append(
    'user/message',
    createUserMessage({
      content: [{ type: 'text', text: 'original' }], source: { kind: 'user' },
    }),
    { surfaceOp: 'append', sourceEventSeqs: [SessionSeq(2)] },
  )
  session.append(
    'assistant/message',
    {
      turn: 1, step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'summary one' }],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'mock' },
        },
      }),
    },
    { surfaceOp: { op: 'replace', start: SessionSeq(3), end: SessionSeq(3) }, sourceEventSeqs: [SessionSeq(3), SessionSeq(2)] },
  )
  session.append(
    'user/message',
    createUserMessage({
      content: [{ type: 'text', text: 'context' }], source: { kind: 'plugin', plugin: 'test' },
    }),
    { surfaceOp: 'append' },
  )
  session.append('step/end', { turn: 1, step: 1 })
  session.append('step/start', { turn: 1, step: 2 })
  session.append(
    'assistant/message',
    {
      turn: 1, step: 2,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'summary two' }],
        source: {
          kind: 'model',
          ...{ provider: 'mock', model: 'mock' },
        },
      }),
    },
    { surfaceOp: { op: 'replace', start: SessionSeq(4), end: SessionSeq(4) }, sourceEventSeqs: [SessionSeq(2), SessionSeq(4)] },
  )
}

describe('session lineage tracing', () => {
  it('returns complete ancestry, deterministic descendant trees, and detached records', async () => {
    const ctx = await queryContext()
    const root = ctx.sessions.create(SessionId('root'), { meta: { createdAt: 0 } })
    const parent = ctx.sessions.create(SessionId('parent'), {
      meta: { createdAt: 1, parentSession: root.id },
    })
    const target = ctx.sessions.create(SessionId('target'), {
      meta: { createdAt: 2, parentSession: parent.id },
    })
    ctx.sessions.create(SessionId('b'), { meta: { createdAt: 4, parentSession: target.id } })
    const childA = ctx.sessions.create(SessionId('a'), {
      meta: { createdAt: 4, parentSession: target.id },
    })
    ctx.sessions.create(SessionId('older'), { meta: { createdAt: 3, parentSession: target.id } })
    ctx.sessions.create(SessionId('grandchild'), {
      meta: { createdAt: 5, parentSession: childA.id },
    })

    const trace = await ctx.sessionQuery.traceSession(target.id)
    expect(trace.complete).toBe(true)
    if (!trace.complete) throw new Error('expected complete lineage')
    expect(trace.ancestors.map(record => record.header.id)).toEqual([parent.id, root.id])
    expect(trace.root.header.id).toBe(root.id)
    expect(trace.descendants.map(node => node.session.header.id))
      .toEqual([SessionId('older'), SessionId('a'), SessionId('b')])
    expect(trace.descendants[1]?.descendants.map(node => node.session.header.id))
      .toEqual([SessionId('grandchild')])

    mutableHeader(trace.target.header).createdAt = 99
    mutableHeader(trace.ancestors[0]!.header).createdAt = 99
    mutableHeader(trace.root.header).createdAt = 99
    mutableHeader(trace.descendants[0]!.session.header).createdAt = 99
    const repeated = await ctx.sessionQuery.traceSession(target.id)
    expect(repeated.target.header.createdAt).toBe(2)
    expect(repeated.ancestors[0]?.header.createdAt).toBe(1)
    expect(repeated.descendants[0]?.session.header.createdAt).toBe(3)
  })

  it('represents root and unresolved-parent traces explicitly', async () => {
    const ctx = await queryContext()
    const root = ctx.sessions.create(SessionId('root'), { meta: { createdAt: 1 } })
    const partial = ctx.sessions.create(SessionId('partial'), {
      meta: { createdAt: 2, parentSession: SessionId('outside') },
    })

    await expect(ctx.sessionQuery.traceSession(root.id)).resolves.toMatchObject({
      complete: true,
      root: { header: { id: root.id } },
      ancestors: [],
    })
    await expect(ctx.sessionQuery.traceSession(partial.id)).resolves.toMatchObject({
      complete: false,
      unresolvedParentId: SessionId('outside'),
      ancestors: [],
    })
  })

  it('rejects target-connected cycles and missing targets', async () => {
    const ctx = await queryContext()
    ctx.sessions.create(SessionId('a'), {
      meta: { createdAt: 1, parentSession: SessionId('b') },
    })
    ctx.sessions.create(SessionId('b'), {
      meta: { createdAt: 2, parentSession: SessionId('a') },
    })

    await expect(ctx.sessionQuery.traceSession(SessionId('a')))
      .rejects.toThrow(expectCode('SESSION_QUERY_INVALID_LINEAGE'))
    await expect(ctx.sessionQuery.traceSession(SessionId('missing')))
      .rejects.toThrow(expectCode('SESSION_QUERY_SESSION_NOT_FOUND'))
  })

  it('uses one cross-corpus observation and preserves persistence failure semantics', async () => {
    const durable = header('durable')
    TracePersistence.reset([{ meta: durable, events: [appendEvent(0)] }])
    const ctx = await queryContext()
    await ctx.plugin(TracePersistence)

    await expect(ctx.sessionQuery.traceSession(durable.id)).resolves.toMatchObject({
      target: { live: false, persisted: true },
      complete: true,
    })
    expect(TracePersistence.listCalls).toBe(1)
    expect(TracePersistence.readCalls).toBe(0)

    TracePersistence.listFailure = new Error('unavailable')
    await expect(ctx.sessionQuery.traceSession(durable.id))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
  })

  it('constructs deeply nested descendants without consuming the JavaScript call stack', async () => {
    const ctx = await queryContext()
    const root = ctx.sessions.create(SessionId('deep-0'), { meta: { createdAt: 0 } })
    let parent = root
    for (let depth = 1; depth < 3_000; depth += 1) {
      parent = ctx.sessions.create(SessionId(`deep-${depth}`), {
        meta: { createdAt: depth, parentSession: parent.id },
      })
    }

    const trace = await ctx.sessionQuery.traceSession(root.id)
    expect(trace.complete).toBe(true)
    let node = trace.descendants[0]
    for (let depth = 1; depth < 3_000; depth += 1) {
      if (node === undefined) throw new Error(`lineage ended before depth ${depth}`)
      if (depth === 2_999) expect(node.session.header.id).toBe(SessionId('deep-2999'))
      node = node.descendants[0]
    }
    expect(node).toBeUndefined()
  })
})

describe('session event tracing', () => {
  it('returns direct replacement and cited source-event links in their contract order', async () => {
    const ctx = await queryContext()
    const session = ctx.sessions.create(SessionId('trace'))
    appendTraceEvents(session)

    const original = await ctx.sessionQuery.traceEvent({ sessionId: session.id, seq: SessionSeq(3) })
    expect(original.target).toMatchObject({
      sessionId: session.id,
      seq: SessionSeq(3),
      type: 'user/message',
      surface: 'shadowed',
    })
    expect(original).toMatchObject({
      replacedBy: 4,
      replacementChain: [4, 8],
      replacedEventSeqs: [],
      sourceEventSeqs: [2],
      derivedEventSeqs: [4],
    })
    await expect(ctx.sessionQuery.traceEvent({ sessionId: session.id, seq: SessionSeq(4) }))
      .resolves.toMatchObject({
        replacedBy: 8,
        replacementChain: [8],
        replacedEventSeqs: [3],
        sourceEventSeqs: [3, 2],
        derivedEventSeqs: [8],
      })
    await expect(ctx.sessionQuery.traceEvent({ sessionId: session.id, seq: SessionSeq(2) }))
      .resolves.toMatchObject({
        target: { surface: 'log-only' },
        replacementChain: [],
        sourceEventSeqs: [],
        derivedEventSeqs: [3, 4, 8],
      })
    await expect(ctx.sessionQuery.traceEvent({ sessionId: session.id, seq: SessionSeq(8) }))
      .resolves.toMatchObject({
        replacementChain: [],
        replacedEventSeqs: [4],
        sourceEventSeqs: [2, 4],
        derivedEventSeqs: [],
      })
  })

  it('returns fresh trace arrays and target records', async () => {
    const ctx = await queryContext()
    const session = ctx.sessions.create(SessionId('detached'))
    appendTraceEvents(session)

    const first = await ctx.sessionQuery.traceEvent({ sessionId: session.id, seq: SessionSeq(4) })
    first.target.time = -1
    first.replacementChain.push(SessionSeq(99))
    first.replacedEventSeqs.push(SessionSeq(99))
    first.sourceEventSeqs.push(SessionSeq(99))
    first.derivedEventSeqs.push(SessionSeq(99))
    const repeated = await ctx.sessionQuery.traceEvent({ sessionId: session.id, seq: SessionSeq(4) })
    expect(repeated.target.time).not.toBe(-1)
    expect(repeated.replacementChain).toEqual([8])
    expect(repeated.replacedEventSeqs).toEqual([3])
    expect(repeated.sourceEventSeqs).toEqual([3, 2])
    expect(repeated.derivedEventSeqs).toEqual([8])
  })

  it('inspects persisted logs once, prefers live logs, and preserves failures and conflicts', async () => {
    const durable = header('shared', 1, { cwd: '/same' })
    TracePersistence.reset([{ meta: durable, events: [appendEvent(0)] }])
    const ctx = await queryContext()
    await ctx.plugin(TracePersistence)

    await expect(ctx.sessionQuery.traceEvent({ sessionId: durable.id, seq: SessionSeq(0) }))
      .resolves.toMatchObject({ target: { type: 'user/message', surface: 'current' } })
    expect([TracePersistence.listCalls, TracePersistence.readCalls]).toEqual([1, 1])

    const live = ctx.sessions.create(durable.id, { meta: { createdAt: 1, cwd: '/same' } })
    live.append('turn/start', { turn: 1 })
    live.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: 'live' }], source: { kind: 'plugin', plugin: 'test' },
      }),
      { surfaceOp: 'append' },
    )
    TracePersistence.listFailure = new Error('list unavailable')
    TracePersistence.readFailure = new Error('inspect unavailable')
    await expect(ctx.sessionQuery.traceEvent({ sessionId: durable.id, seq: SessionSeq(1) }))
      .resolves.toMatchObject({ target: { type: 'user/message' } })
    expect([TracePersistence.listCalls, TracePersistence.readCalls]).toEqual([1, 1])

    TracePersistence.reset([{ meta: durable, events: [appendEvent(0)] }])
    const failedCtx = await queryContext()
    await failedCtx.plugin(TracePersistence)
    TracePersistence.listFailure = new Error('list unavailable')
    await expect(failedCtx.sessionQuery.traceEvent({ sessionId: durable.id, seq: SessionSeq(0) }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    TracePersistence.listFailure = undefined
    TracePersistence.readFailure = new Error('inspect unavailable')
    await expect(failedCtx.sessionQuery.traceEvent({ sessionId: durable.id, seq: SessionSeq(0) }))
      .rejects.toThrow(expectCode('SESSION_QUERY_PERSISTENCE_FAILED'))
    TracePersistence.readFailure = undefined
    TracePersistence.afterList = () => {
      mutableHeader(TracePersistence.entries.get(durable.id)!.meta).cwd = '/changed'
    }
    await expect(failedCtx.sessionQuery.traceEvent({ sessionId: durable.id, seq: SessionSeq(0) }))
      .rejects.toThrow(expectCode('SESSION_QUERY_SOURCE_CONFLICT'))
  })

  it('checks target existence before surface or source-event analysis', async () => {
    const bad = header('bad-target')
    const malformed: SessionEvent[] = [appendEvent(0), {
      type: 'assistant/message',
      seq: SessionSeq(1),
      time: 2,
      data: {
        turn: 1, step: 1,
        message: createMessage({
          role: 'assistant',
          content: [],
          source: {
            kind: 'model',
            ...{ provider: 'mock', model: 'mock' },
          },
        }),
      },
      surfaceOp: { op: 'replace', start: SessionSeq(9), end: SessionSeq(9) },
      sourceEventSeqs: [],
    }]
    TracePersistence.reset([{ meta: bad, events: malformed }])
    const ctx = await queryContext()
    await ctx.plugin(TracePersistence)

    await expect(ctx.sessionQuery.traceEvent({ sessionId: bad.id, seq: SessionSeq(9) }))
      .rejects.toThrow(expectCode('SESSION_QUERY_EVENT_NOT_FOUND'))
    await expect(ctx.sessionQuery.traceEvent({ sessionId: bad.id, seq: SessionSeq(0) }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INVALID_SURFACE'))
  })

  it.each([
    ['non-surface sources', [
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 }, sourceEventSeqs: [0] },
    ]],
    ['invalid source array', [
      { ...appendEvent(0), sourceEventSeqs: 'invalid' },
    ]],
    ['empty sources', [
      appendEvent(0, []),
    ]],
    ['sparse sources', [
      appendEvent(0, Array<number>(1)),
    ]],
    ['duplicate sources', [
      appendEvent(0),
      appendEvent(1, [0, 0]),
    ]],
    ['missing earlier source', [
      appendEvent(0),
      appendEvent(1, [-1]),
    ]],
    ['future source', [
      appendEvent(0, [1]),
      appendEvent(1),
    ]],
    ['replacement without sources', [
      appendEvent(0),
      { ...appendEvent(1), surfaceOp: { op: 'replace', start: 0, end: 0 } },
    ]],
    ['replacement missing a shadowed source', [
      { type: 'assistant/chunk', seq: SessionSeq(0), time: 1, data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'draft' } } },
      appendEvent(1),
      { ...appendEvent(2, [0]), surfaceOp: { op: 'replace', start: 1, end: 1 } },
    ]],
  ] as const)('rejects an invalid surface log: %s', async (_name, rawEvents) => {
    const durable = header('invalid-provenance')
    const events = structuredClone(rawEvents) as unknown as SessionEvent[]
    TracePersistence.reset([{ meta: durable, events }])
    const ctx = await queryContext()
    await ctx.plugin(TracePersistence)

    await expect(ctx.sessionQuery.traceEvent({ sessionId: durable.id, seq: SessionSeq(0) }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INVALID_SURFACE'))
  })

  it('rejects surfaceOp on a non-surface event as an invalid surface', async () => {
    const durable = header('invalid-non-surface-op')
    const events = [{
      type: 'turn/start',
      seq: SessionSeq(0),
      time: 1,
      data: { turn: 1 },
      surfaceOp: 'append',
    }] as unknown as SessionEvent[]
    TracePersistence.reset([{ meta: durable, events }])
    const ctx = await queryContext()
    await ctx.plugin(TracePersistence)

    await expect(ctx.sessionQuery.traceEvent({ sessionId: durable.id, seq: SessionSeq(0) }))
      .rejects.toThrow(expectCode('SESSION_QUERY_INVALID_SURFACE'))
  })

  it('applies the same surface contract to listEvents', async () => {
    const durable = header('list-regression')
    TracePersistence.reset([{ meta: durable, events: [appendEvent(0), appendEvent(1, [0, 0])] }])
    const ctx = await queryContext()
    await ctx.plugin(TracePersistence)

    await expect(ctx.sessionQuery.listEvents(durable.id))
      .rejects.toThrow(expectCode('SESSION_QUERY_INVALID_SURFACE'))
  })
})
