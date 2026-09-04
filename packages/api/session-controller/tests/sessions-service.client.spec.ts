/**
 * ClientSessions: list store projection (manager → {ids, byId, current}
 * with derived titles), the current-selection account (open validation and
 * persisted mask semantics), scope-tree
 * lifecycle (lazy mint / frozen survival / removed teardown with staged
 * deferral — the stage follows list.current), binding identity, breadcrumb
 * projection, create.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import { SESSION_FORMAT_VERSION, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { ClientSessions, SessionCreateError } from '../src/client/sessions/service.ts'
import { scopeOf } from '../src/client/scope.ts'
import type { SessionFollowFrame } from '../src/types.ts'
import {
  FakeApiClient,
  deferred,
  err,
  fakeRemote,
  ok,
  type RuntimeRemotes,
} from './fake-api.client.ts'

const sid = (s: string): SessionId => s as SessionId

interface Bench {
  ctx: Context
  api: FakeApiClient
  svc: ClientSessions
}

function bench(configureRemote?: (remote: RuntimeRemotes) => RuntimeRemotes): Bench {
  const ctx = new Context()
  const api = new FakeApiClient()
  const remote = fakeRemote(api)
  const svc = new ClientSessions(ctx, configureRemote?.(remote) ?? remote)
  return { ctx, api, svc }
}

/** Refresh the manager list from programmable rows and flush the microtask batch. */
type FeedRow = {
  id: string
  cwd?: string
  parentId?: string
  origin?: 'subagent'
  running?: boolean
  blank?: boolean
  projections?: Record<string, unknown>
}

async function feedList(b: Bench, rows: FeedRow[]): Promise<void> {
  b.api.onList = () => Promise.resolve(ok({
    items: rows.map(r => ({
      sessionId: sid(r.id), updatedAt: 1, running: r.running ?? false, blank: r.blank ?? false,
      ...(r.cwd !== undefined ? { cwd: r.cwd } : {}),
      ...(r.parentId !== undefined ? { parentSessionId: sid(r.parentId) } : {}),
      ...(r.origin !== undefined ? { origin: r.origin } : {}),
      ...(r.projections === undefined
        ? {}
        : { projections: { asOfSeq: 0, values: r.projections } }),
    })),
  }) as never)
  await b.svc.refresh()
  await Promise.resolve() // manager notifier flush
}

describe('list store projection', () => {
  it('projects durable titles separately from cwd/id display fallbacks and parent links', async () => {
    const b = bench()
    b.svc.handleControlFrame({
      type: 'projection', sessionId: sid('s1'), key: 'title', value: 'Durable title', seq: 2,
    })
    await feedList(b, [
      { id: 's1', cwd: '/home/u/proj-a/' },
      { id: 's2', parentId: 's1', origin: 'subagent', running: true },
    ])
    const state = b.svc.list.getSnapshot()
    expect(state.ids).toEqual(['s1', 's2'])
    expect(state.byId[sid('s1')]).toMatchObject({ title: 'Durable title', displayTitle: 'Durable title', cwd: '/home/u/proj-a/' })
    expect(state.byId[sid('s2')]).toMatchObject({
      displayTitle: 's2', parentId: 's1', origin: 'subagent', running: true,
    })
    expect(state.byId[sid('s2')]?.title).toBeUndefined()
  })

  it('reprojects a blank session from the generic agent-preset projection', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1', blank: true, projections: { agentPreset: 'standard' } }])
    expect(b.svc.list.getSnapshot().byId[sid('s1')]?.projectionValues?.agentPreset).toBe('standard')

    b.svc.handleControlFrame({
      type: 'projection', sessionId: sid('s1'), key: 'agentPreset', value: 'minimal', seq: 1,
    })
    await Promise.resolve()

    expect(b.svc.list.getSnapshot().byId[sid('s1')]?.projectionValues?.agentPreset).toBe('minimal')
  })

  it('reflects live increments (host stream via manager) into the store', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1' }])
    b.svc.handleSessionAdded({
      sessionId: sid('s2'), updatedAt: 2, running: false, blank: true,
    })
    await Promise.resolve()
    expect(b.svc.list.getSnapshot().ids).toContain('s2')
  })
})

describe('search', () => {
  it('delegates transient content search without changing the list snapshot', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1' }])
    const before = b.svc.list.getSnapshot()
    b.api.onSearch = () => Promise.resolve(ok({
      items: [{ sessionId: sid('s1'), snippet: 'matching excerpt' }],
      hasMore: false,
    }))
    const signal = new AbortController().signal

    await expect(b.svc.search('needle', signal)).resolves.toEqual({
      ok: true,
      value: {
        items: [{ sessionId: 's1', snippet: 'matching excerpt' }],
        hasMore: false,
      },
    })
    expect(b.api.lastSearchSignal).toBe(signal)
    expect(b.svc.list.getSnapshot()).toBe(before)
  })
})

describe('scope tree', () => {
  it('publishes transient Assistant chunks and the named durable v2 settlement through one event source', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1' }])
    b.svc.open(sid('s1'))
    const binding = b.svc.binding(sid('s1'))
    if (binding === undefined) throw new Error('expected Session binding')
    await vi.waitFor(() => {
      expect(binding.session.getSnapshot().openState).toBe('open')
    })
    const attemptId = LlmAttemptId('web-live-attempt')
    const durableMessage = {
      type: 'event' as const,
      event: {
        type: 'assistant/message', seq: 0, time: 2,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'live' }],
            source: { kind: 'model', provider: 'p', model: 'm' },
            id: 'message-1',
          },
          stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['live'] }],
        },
        surfaceOp: 'append' as const,
      },
    }
    const publications: string[][] = []
    const dispose = binding.eventSource.subscribe(() => {
      publications.push(binding.eventSource.getSnapshot().entries.map(entry => entry.event.type))
    })

    await b.api.pushFollow(sid('s1'), {
      type: 'assistant-stream',
      frame: {
        type: 'start', attemptId, revision: 1, startedAfterSeq: -1,
        turn: 1, step: 1,
      },
    })
    await b.api.pushFollow(sid('s1'), {
      type: 'assistant-stream',
      frame: {
        type: 'chunk', attemptId, revision: 2, index: 0,
        time: 1,
        chunk: { type: 'text-delta', index: 0, text: 'live' },
      },
    })
    await vi.waitFor(() => {
      expect(binding.eventSource.getSnapshot().entries).toHaveLength(1)
    })
    await b.api.pushFollow(sid('s1'), durableMessage)
    await Promise.resolve()
    expect(binding.eventSource.getSnapshot().entries).toHaveLength(1)

    await b.api.pushFollow(sid('s1'), {
      type: 'assistant-stream',
      frame: {
        type: 'end', attemptId, revision: 3, index: 1,
        outcome: { kind: 'committed', eventType: 'assistant/message', seq: 0 },
      },
    })
    await vi.waitFor(() => {
      expect(binding.eventSource.getSnapshot().entries).toHaveLength(1)
    })

    expect(publications).toEqual([
      ['assistant/live-chunk'],
      ['assistant/message'],
    ])
    dispose()
  })

  it('replaces an active assistant baseline on reconnect without duplicate chunks', async () => {
    const b = bench()
    const attemptId = LlmAttemptId('reconnect-attempt')
    let records: never[] = []
    b.api.onHistory = () => Promise.resolve(ok({ records, hasMore: false }))
    b.api.assistantStreamBaseline = {
      revision: 2,
      activeAttempt: {
        attemptId, startedAfterSeq: -1, turn: 1, step: 1,
        nextIndex: 1,
        stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['a'] }],
      },
    }
    await feedList(b, [{ id: 's1' }])
    b.svc.open(sid('s1'))
    const binding = b.svc.binding(sid('s1'))
    if (binding === undefined) throw new Error('expected Session binding')
    await vi.waitFor(() => {
      expect(binding.eventSource.getSnapshot().entries).toHaveLength(1)
    })

    records = []
    b.api.assistantStreamBaseline = {
      revision: 3,
      activeAttempt: {
        attemptId, startedAfterSeq: -1, turn: 1, step: 1,
        nextIndex: 2,
        stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [1], texts: ['a', 'b'] }],
      },
    }
    b.api.failStreams(new RemoteStreamCarrierError('lost'))
    await vi.waitFor(() => {
      expect(b.api.followStarts.filter(id => id === sid('s1'))).toHaveLength(2)
      expect(binding.eventSource.getSnapshot().entries).toHaveLength(2)
    })

    expect(binding.eventSource.getSnapshot().entries.map(entry => (
      entry.event.type === 'assistant/live-chunk' && entry.event.data.chunk.type === 'text-delta'
        ? entry.event.data.chunk.text
        : undefined
    ))).toEqual(['a', 'b'])
  })

  it('stages a post-opening assistant settlement behind its exact active attempt', async () => {
    const b = bench()
    const attemptId = LlmAttemptId('reconnect-settlement-attempt')
    const priorMessage = {
      type: 'event' as const,
      event: {
        type: 'assistant/message', seq: 0, time: 30,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'retry ' }],
            source: { kind: 'model', provider: 'p', model: 'm' },
            id: 'prior-attempt-message',
          },
          stream: [{ type: 'text-chunks', time0: 10, index: 0, dt: [], texts: ['retry '] }],
        },
        surfaceOp: 'append' as const,
      },
    }
    const currentMessage = {
      type: 'event' as const,
      event: {
        type: 'assistant/message', seq: 1, time: 19,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'settled' }],
            source: { kind: 'model', provider: 'p', model: 'm' },
            id: 'current-attempt-message',
          },
          stream: [{ type: 'text-chunks', time0: 20, index: 0, dt: [], texts: ['settled'] }],
        },
        surfaceOp: 'append' as const,
      },
    }
    b.api.onHistory = () => Promise.resolve(ok({
      records: [priorMessage] as never[],
      hasMore: false,
    }))
    b.api.assistantStreamBaseline = {
      revision: 2,
      activeAttempt: {
        attemptId,
        startedAfterSeq: SessionSeq(0),
        turn: 1,
        step: 1,
        nextIndex: 1,
        stream: currentMessage.event.data.stream,
      },
    }
    await feedList(b, [{ id: 's1' }])
    b.svc.open(sid('s1'))
    const binding = b.svc.binding(sid('s1'))
    if (binding === undefined) throw new Error('expected Session binding')
    await vi.waitFor(() => {
      expect(binding.session.getSnapshot().openState).toBe('open')
    })

    expect(binding.eventSource.getSnapshot().entries.map(entry => entry.event.type))
      .toEqual(['assistant/message', 'assistant/live-chunk'])
    expect(binding.eventSource.getSnapshot().entries[0]?.event).toBe(priorMessage.event)

    await b.api.pushFollow(sid('s1'), currentMessage)
    await Promise.resolve()
    expect(binding.eventSource.getSnapshot().entries.map(entry => entry.event.type))
      .toEqual(['assistant/message', 'assistant/live-chunk'])

    await b.api.pushFollow(sid('s1'), {
      type: 'assistant-stream',
      frame: {
        type: 'end', attemptId, revision: 3, index: 1,
        outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 },
      },
    })
    await vi.waitFor(() => {
      expect(binding.eventSource.getSnapshot().entries.map(entry => entry.event.type))
        .toEqual(['assistant/message', 'assistant/message'])
    })
    expect(binding.eventSource.getSnapshot().change).toEqual({
      kind: 'settle-assistant', attemptId: String(attemptId), entry: currentMessage,
    })
  })

  it('replaces an invalid settlement with the authoritative post-end baseline', async () => {
    const b = bench()
    const attemptId = LlmAttemptId('reconnect-end-index-attempt')
    const prior = {
      type: 'event' as const,
      event: { type: 'turn/start', seq: 0, time: 19, data: { turn: 1 } },
    }
    const message = {
      type: 'event' as const,
      event: {
        type: 'assistant/message', seq: 1, time: 21,
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'settled' }],
            source: { kind: 'model', provider: 'p', model: 'm' },
            id: 'current-attempt-message',
          },
          stream: [{ type: 'text-chunks', time0: 20, index: 0, dt: [], texts: ['settled'] }],
        },
        surfaceOp: 'append' as const,
      },
    }
    let records = [prior] as never[]
    b.api.onHistory = () => Promise.resolve(ok({
      records,
      hasMore: false,
    }))
    b.api.assistantStreamBaseline = {
      revision: 2,
      activeAttempt: {
        attemptId,
        startedAfterSeq: SessionSeq(0),
        turn: 1,
        step: 1,
        nextIndex: 1,
        stream: message.event.data.stream,
      },
    }
    await feedList(b, [{ id: 's1' }])
    b.svc.open(sid('s1'))
    const binding = b.svc.binding(sid('s1'))
    if (binding === undefined) throw new Error('expected Session binding')
    await vi.waitFor(() => {
      expect(binding.eventSource.getSnapshot().entries.map(entry => entry.event.type))
        .toEqual(['turn/start', 'assistant/live-chunk'])
    })
    const openingRevision = binding.eventSource.getSnapshot().revision

    await b.api.pushFollow(sid('s1'), message)
    await Promise.resolve()
    expect(binding.eventSource.getSnapshot().entries.map(entry => entry.event.type))
      .toEqual(['turn/start', 'assistant/live-chunk'])
    records = [prior, message] as never[]
    b.api.assistantStreamBaseline = { revision: 3 }
    await b.api.pushFollow(sid('s1'), {
      type: 'assistant-stream',
      frame: {
        type: 'end', attemptId, revision: 3, index: 0,
        outcome: { kind: 'committed', eventType: 'assistant/message', seq: 0 },
      },
    })
    await vi.waitFor(() => {
      expect(b.api.followStarts.filter(id => id === sid('s1'))).toHaveLength(2)
      expect(b.api.activeFollows(sid('s1'))).toBe(1)
      expect(binding.eventSource.getSnapshot().revision).toBeGreaterThan(openingRevision)
      expect(binding.eventSource.getSnapshot().entries.map(entry => entry.event.type))
        .toEqual(['turn/start', 'assistant/message'])
    })
  })

  it('retains a Host-addressed scope until the first Session baseline owns pruning', async () => {
    const b = bench()
    const scoped = b.svc.resolveAgentScope(sid('s-early'))
    expect(scopeOf(scoped)).toBe('s-early')

    b.svc.handleControlFrame({
      type: 'baseline',
      value: { queues: {}, jobs: {}, projections: {} },
    })
    await Promise.resolve()
    expect(b.svc.resolveAgentScope(sid('s-early'))).toBe(scoped)

    await feedList(b, [])
    expect(b.svc.scope(sid('s-early'))).toBeUndefined()
  })

  it('mints lazily on first resolution, tags the ctx, and keeps binding identity stable', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1' }])
    expect(b.svc.scope(sid('unknown'))).toBeUndefined()
    const scoped = b.svc.scope(sid('s1'))
    expect(scoped).toBeDefined()
    expect(scopeOf(scoped as Context)).toBe('s1')
    expect(scopeOf(b.ctx)).toBeUndefined()
    const binding = b.svc.binding(sid('s1'))
    b.svc.open(sid('s1'))
    expect(b.svc.sessionOf(scoped as Context)).toBe(binding?.session)
    expect(b.svc.binding(sid('s1'))).toBe(binding)
    expect(binding?.ctx).toBe(scoped)
  })

  it('tears down an off-stage removed session but defers the staged one until the stage moves', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1' }, { id: 's2' }])
    const ctx1 = b.svc.scope(sid('s1'))
    b.svc.open(sid('s1')) // s1 staged (current)
    b.svc.scope(sid('s2')) // s2 scoped but off stage

    await feedList(b, [{ id: 's1' }]) // s2 removed, off stage: torn down
    expect(b.svc.scope(sid('s2'))).toBeUndefined()

    await feedList(b, []) // s1 removed while staged (current masks): deferred, scope survives
    expect(b.svc.scope(sid('s1'))).toBe(ctx1)

    await feedList(b, [{ id: 's3' }])
    b.svc.open(sid('s3')) // stage moves: deferred teardown sweeps s1
    expect(b.svc.scope(sid('s1'))).toBeUndefined()
  })

  it('keeps the scope when the session merely stops running (frozen ≠ removed)', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1', running: true }])
    const scoped = b.svc.scope(sid('s1'))
    await feedList(b, [{ id: 's1', running: false }])
    expect(b.svc.scope(sid('s1'))).toBe(scoped)
  })

  it('cancels a deferred teardown when the id reappears in the list', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1' }])
    const scoped = b.svc.scope(sid('s1'))
    b.svc.open(sid('s1'))
    await feedList(b, []) // removed while staged → deferred
    await feedList(b, [{ id: 's1' }, { id: 's2' }]) // reappears (current resurfaces, stage unchanged)
    b.svc.open(sid('s2')) // stage moves; sweep must NOT tear down the re-listed s1
    expect(b.svc.scope(sid('s1'))).toBe(scoped)
  })

  it('closes an opened journal when its removed scope drops', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1' }])
    b.svc.open(sid('s1'))
    const session = b.svc.binding(sid('s1'))?.session
    if (session === undefined) throw new Error('expected the selected Session binding')
    await vi.waitFor(() => { expect(b.api.activeFollows(sid('s1'))).toBe(1) })
    const notified = vi.fn()
    session.subscribe(notified)

    await feedList(b, [])
    await feedList(b, [{ id: 's2' }])
    b.svc.open(sid('s2'))

    await vi.waitFor(() => { expect(b.api.activeFollows(sid('s1'))).toBe(0) })
    notified.mockClear()
    await b.api.pushFollow(sid('s1'), {
      type: 'event',
      event: { seq: 0, timestamp: 0, type: 'turn/start', data: { turn: 0 } } as never,
    })
    await Promise.resolve()
    expect(b.api.followStarts.filter(id => id === sid('s1'))).toHaveLength(1)
    expect(notified).not.toHaveBeenCalled()
  })
})

describe('Agent scope disposal lifecycle', () => {
  it('root disposal runs Agent scope effects', async () => {
    const b = bench()
    const readiness = b.ctx.plugin(() => undefined)
    await readiness
    b.svc.handleSessionAdded({
      sessionId: sid('live'), updatedAt: 1, running: false, blank: true,
    })
    await Promise.resolve()
    const scoped = b.svc.scope(sid('live'))
    if (scoped === undefined) throw new Error('fixture Agent Context was not minted')
    await scoped.fiber.await()
    const scopeDisposed = vi.fn()
    scoped.effect(() => scopeDisposed, 'fixture Agent scope effect')
    await b.ctx.fiber.dispose()

    expect(scopeDisposed).toHaveBeenCalledOnce()
    expect(b.svc.sessionOf(scoped)).toBeUndefined()
  })

  it('root disposal waits for an opened Session source to finish closing', async () => {
    const closeGate = deferred<undefined>()
    const abortObserved = vi.fn()
    let followSignal: AbortSignal | undefined
    const b = bench(remote => ({
      ...remote,
      session: {
        ...remote.session,
        follow: (request, signal) => {
          if (signal === undefined) throw new Error('fixture requires a signal')
          followSignal = signal
          let opened = false
          return {
            [Symbol.asyncIterator]: () => ({
              next: () => {
                if (!opened) {
                  opened = true
                  return Promise.resolve({
                    done: false,
                    value: {
                      type: 'snapshot',
                      header: {
                        version: SESSION_FORMAT_VERSION,
                        id: request.address.kind === 'session'
                          ? request.address.sessionId
                          : request.address.childSessionId,
                        createdAt: 0,
                        isSeeded: false,
                      },
                      cursor: -1,
                      records: [],
                      hasMore: false,
                      projections: { asOfSeq: -1, values: {} },
                      assistantStream: { revision: 0 },
                    } as const,
                  })
                }
                return new Promise((_resolve, reject) => {
                  signal.addEventListener('abort', () => {
                    abortObserved()
                    void closeGate.promise.then(() => {
                      reject(signal.reason instanceof Error
                        ? signal.reason
                        : new Error(String(signal.reason)))
                    })
                  }, { once: true })
                })
              },
            }),
          }
        },
      },
    }))
    const readiness = b.ctx.plugin(() => undefined)
    await readiness
    await feedList(b, [{ id: 's1' }])
    b.svc.open(sid('s1'))
    await vi.waitFor(() => {
      expect(b.svc.binding(sid('s1'))?.session.getSnapshot().openState).toBe('open')
    })

    const disposal = b.ctx.fiber.dispose()
    const settled = vi.fn()
    const observed = disposal.then(settled)

    await vi.waitFor(() => { expect(abortObserved).toHaveBeenCalledOnce() })
    expect(followSignal?.aborted).toBe(true)
    expect(settled).not.toHaveBeenCalled()

    closeGate.resolve(undefined)
    await observed
    expect(settled).toHaveBeenCalledOnce()
  })

  it('root disposal joins every Session drop already started by pruning under load', async () => {
    const closeGates = new Map<SessionId, ReturnType<typeof deferred<undefined>>>()
    const aborted = new Set<SessionId>()
    const b = bench(remote => ({
      ...remote,
      session: {
        ...remote.session,
        follow: (request, signal) => {
          if (signal === undefined) throw new Error('fixture requires a signal')
          const sessionId = request.address.kind === 'session'
            ? request.address.sessionId
            : request.address.childSessionId
          const closeGate = deferred<undefined>()
          closeGates.set(sessionId, closeGate)
          let opened = false
          return {
            [Symbol.asyncIterator]: () => ({
              next: () => {
                if (!opened) {
                  opened = true
                  return Promise.resolve({
                    done: false,
                    value: {
                      type: 'snapshot',
                      header: { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, isSeeded: false },
                      cursor: -1,
                      records: [],
                      hasMore: false,
                      projections: { asOfSeq: -1, values: {} },
                      assistantStream: { revision: 0 },
                    } as const,
                  })
                }
                return new Promise<IteratorResult<SessionFollowFrame>>((_resolve, reject) => {
                  signal.addEventListener('abort', () => {
                    aborted.add(sessionId)
                    void closeGate.promise.then(() => {
                      reject(signal.reason instanceof Error
                        ? signal.reason
                        : new Error(String(signal.reason)))
                    })
                  }, { once: true })
                })
              },
            }),
          }
        },
      },
    }))
    const readiness = b.ctx.plugin(() => undefined)
    await readiness
    const sessionIds = Array.from({ length: 24 }, (_, index) => sid(`load-${String(index)}`))
    const retained = sessionIds.at(-1)
    const held = sessionIds[0]
    if (retained === undefined || held === undefined) throw new Error('fixture requires sessions')
    await feedList(b, sessionIds.map(id => ({ id })))
    for (const id of sessionIds) b.svc.open(id)
    await vi.waitFor(() => {
      for (const id of sessionIds) {
        expect(b.svc.binding(id)?.session.getSnapshot().openState).toBe('open')
      }
    })

    const pruned = sessionIds.slice(0, -1)
    await feedList(b, [{ id: retained }])
    await vi.waitFor(() => { expect(aborted.size).toBe(pruned.length) })
    for (const id of pruned) expect(b.svc.scope(id)).toBeUndefined()

    const disposal = b.ctx.fiber.dispose()
    const settled = vi.fn()
    const observed = disposal.then(settled)
    await vi.waitFor(() => { expect(aborted.size).toBe(sessionIds.length) })

    const otherClosures: Promise<void>[] = []
    for (const [id, gate] of closeGates) {
      if (id === held) continue
      gate.resolve(undefined)
      otherClosures.push(gate.promise)
    }
    await Promise.all(otherClosures)
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(settled).not.toHaveBeenCalled()

    closeGates.get(held)?.resolve(undefined)
    await observed
    expect(settled).toHaveBeenCalledOnce()
  })
})

describe('current selection (migrated from ui-layout, arbitrated into the list snapshot)', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('open() writes list.current; unknown ids fail loud', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1' }])
    expect(b.svc.list.getSnapshot().current).toBeUndefined()
    b.svc.open(sid('s1'))
    expect(b.svc.list.getSnapshot().current).toBe('s1')
    expect(() => { b.svc.open(sid('ghost')) }).toThrow(/unknown session ghost/)
    expect(b.svc.list.getSnapshot().current).toBe('s1') // failed open leaves the selection alone
  })

  it('clear() blanks list.current and the persisted selection', async () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v) },
      removeItem: (k: string) => { storage.delete(k) },
      clear: () => { storage.clear() },
    })
    const b = bench()
    await feedList(b, [{ id: 's1' }])
    b.svc.open(sid('s1'))
    expect(storage.get('dsh.sessions.current')).toContain('s1')
    b.svc.clear()
    expect(b.svc.list.getSnapshot().current).toBeUndefined()
    // Persisted wipe: a fresh service with the same storage stays on empty.
    const again = bench()
    await feedList(again, [{ id: 's1' }])
    expect(again.svc.list.getSnapshot().current).toBeUndefined()
  })

  it('masks (not destroys) the selection while its session is off the list', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1' }, { id: 's2' }])
    b.svc.open(sid('s1'))
    await feedList(b, [{ id: 's2' }]) // s1 removed → current falls to the empty state
    expect(b.svc.list.getSnapshot().current).toBeUndefined()
    await feedList(b, [{ id: 's1' }, { id: 's2' }]) // s1 returns → selection resurfaces
    expect(b.svc.list.getSnapshot().current).toBe('s1')
  })

  it('persists the selection under dsh.sessions.current and rehydrates it into a fresh service', async () => {
    const storage = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v) },
    })
    const first = bench()
    await feedList(first, [{ id: 's1' }])
    first.svc.open(sid('s1'))
    expect(storage.get('dsh.sessions.current')).toContain('s1')
    // A fresh boot (same storage) recovers the selection once the list holds the session.
    const second = bench()
    await feedList(second, [{ id: 's1' }])
    expect(second.svc.list.getSnapshot().current).toBe('s1')
  })
})

describe('binding and stage lifecycle', () => {
  it('binding() is pure resolution: no staging, no deferred sweep', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1' }, { id: 's2' }])
    b.svc.open(sid('s1')) // staged
    b.svc.binding(sid('s2')) // resolution only — must NOT move the stage
    await feedList(b, [{ id: 's2' }]) // s1 removed: still staged → deferred, scope survives
    expect(b.svc.scope(sid('s1'))).toBeDefined()
  })

  it('staging (current write) opens the session event window; resolution and re-staging do not re-pull', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1' }, { id: 's2' }])
    const followStarts = () => b.api.followStarts.map(String)
    // Resolution is addressing, not staging: no window pull.
    b.svc.scope(sid('s1'))
    b.svc.binding(sid('s1'))
    expect(followStarts()).toEqual([])
    b.svc.open(sid('s1'))
    await vi.waitFor(() => {
      expect(followStarts()).toEqual(['s1'])
    })
    // Same current again: no second pull.
    b.svc.open(sid('s1'))
    expect(followStarts()).toHaveLength(1)
    // Stage moves: the new occupant opens.
    b.svc.open(sid('s2'))
    await vi.waitFor(() => {
      expect(followStarts()).toEqual(['s1', 's2'])
    })
  })

  it('startup restore: a persisted selection validated by the first projection opens its window unprompted', async () => {
    const storage = new Map<string, string>([
      ['dsh.sessions.current', JSON.stringify({ sessionId: 's1' })],
    ])
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => { storage.set(k, v) },
    })
    try {
      const b = bench()
      expect(b.api.followStarts).toEqual([])
      await feedList(b, [{ id: 's1' }]) // projection validates the persisted id → current lands → stage follows
      await vi.waitFor(() => {
        expect(b.api.followStarts.map(String)).toEqual(['s1'])
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('catalog-addressed navigation', () => {
  it('uses catalog labels for a listed addressed route', async () => {
    const b = bench()
    b.api.onSubagentList = (payload) => {
      const parentSessionId = payload as SessionId
      if (parentSessionId === sid('root')) {
        return Promise.resolve(ok({
          entries: [{
            kind: 'child', id: sid('child'), mode: 'continuable', label: 'Child',
            activity: 'inactive', hasChildren: true,
          }] as never[],
          parentAvailable: true,
        }))
      }
      if (parentSessionId === sid('child')) {
        return Promise.resolve(ok({
          entries: [{
            kind: 'child', id: sid('grandchild'), mode: 'continuable', label: 'Grandchild',
            activity: 'inactive', hasChildren: false,
          }] as never[],
          parentAvailable: false,
        }))
      }
      return Promise.resolve(ok({ entries: [], parentAvailable: false }))
    }
    await feedList(b, [
      { id: 'root' },
      { id: 'child', cwd: '/summary-child', parentId: 'root', origin: 'subagent' },
      { id: 'grandchild', cwd: '/summary-grandchild', parentId: 'child', origin: 'subagent' },
    ])
    await b.svc.refreshSubagents(sid('root'))
    await b.svc.refreshSubagents(sid('child'))
    b.svc.openSubagent({
      parentSessionId: sid('child'), childSessionId: sid('grandchild'), mode: 'continuable',
    })

    expect(b.svc.list.getSnapshot().byId[sid('child')]?.displayTitle).toBe('Child')
    expect(b.svc.list.getSnapshot().byId[sid('grandchild')]?.displayTitle).toBe('Grandchild')
  })

  it('projects a directly opened descendant route without retaining ancestor scopes or addresses', async () => {
    const b = bench()
    b.api.onSubagentList = (payload) => {
      const parentSessionId = payload as SessionId
      if (parentSessionId === sid('root')) {
        return Promise.resolve(ok({
          entries: [{
            kind: 'child', id: sid('child'), mode: 'continuable', label: 'Child',
            activity: 'inactive', hasChildren: true,
          }] as never[],
          parentAvailable: true,
        }))
      }
      if (parentSessionId === sid('child')) {
        return Promise.resolve(ok({
          entries: [{
            kind: 'child', id: sid('grandchild'), mode: 'continuable', label: 'Grandchild',
            activity: 'inactive', hasChildren: false,
          }] as never[],
          parentAvailable: false,
        }))
      }
      return Promise.resolve(ok({ entries: [], parentAvailable: false }))
    }
    await feedList(b, [{ id: 'root' }])
    await b.svc.refreshSubagents(sid('root'))
    await b.svc.refreshSubagents(sid('child'))
    b.svc.openSubagent({
      parentSessionId: sid('child'), childSessionId: sid('grandchild'), mode: 'continuable',
    })

    const list = b.svc.list.getSnapshot()
    expect(list.ids).toEqual([sid('root')])
    expect(list.byId[sid('child')]).toMatchObject({ parentId: sid('root'), origin: 'subagent' })
    expect(list.byId[sid('grandchild')]).toMatchObject({ parentId: sid('child'), origin: 'subagent' })
    expect(b.svc.binding(sid('child'))).toBeUndefined()
    expect(b.svc.subagentAddress(sid('child'))).toBeUndefined()

    b.svc.open(sid('child'))
    expect(b.svc.list.getSnapshot().current).toBe(sid('child'))
    expect(b.svc.subagentAddress(sid('child'))).toEqual({
      parentSessionId: sid('root'), childSessionId: sid('child'), mode: 'continuable',
    })
  })
})

describe('create', () => {
  it('passes a preallocated id and preserves it on ordinary failure', async () => {
    const b = bench()
    b.api.onCreate = () => Promise.resolve(ok({ sessionId: sid('fresh') }))
    await expect(b.svc.create({ cwd: '/w', sessionId: sid('fresh') })).resolves.toBe('fresh')
    expect(b.api.callsOf('session.create')).toEqual([{ cwd: '/w', sessionId: 'fresh' }])
    b.api.onCreate = () => Promise.resolve(err(new RemoteError('gateway/internal', '爆了', {})))
    const failure = await b.svc.create({ sessionId: sid('candidate') }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionCreateError)
    expect(failure).toMatchObject({
      requestedSessionId: 'candidate',
      rpcError: { code: 'gateway/internal', message: '爆了' },
    })
  })

  it('resolves with the session already listed and binding-resolvable (no flush wait)', async () => {
    const b = bench()
    b.api.onCreate = () => Promise.resolve(ok({ sessionId: sid('born') }))
    const born = await b.svc.create({ workspaceId: 'ws' as never })
    // Synchronously after resolution — the draft hand-off contract: the
    // create echo IS the entity entering the client's view (blank row +
    // resolvable scope/binding), no notifier flush in between.
    expect(b.svc.list.getSnapshot().byId[born]).toMatchObject({ id: 'born', blank: true })
    expect(b.svc.binding(born)).toBeDefined()
    expect(b.svc.scope(born)).toBeDefined()
  })

  it('lists the published id after Workspace attachment fails (publication precedes attachment)', async () => {
    const b = bench()
    b.api.onCreate = () => Promise.resolve(err(new RemoteError(
      'session/workspace-attach-failed',
      'ledger unavailable',
      { sessionId: sid('published'), workspaceId: 'ws' },
    )))
    const failure = await b.svc.create({
      workspaceId: 'ws' as never,
      sessionId: sid('published'),
    }).catch((error: unknown) => error)
    await Promise.resolve()
    expect(failure).toBeInstanceOf(SessionCreateError)
    expect(failure).toMatchObject({
      requestedSessionId: 'published',
      rpcError: { code: 'session/workspace-attach-failed' },
    })
    expect(b.svc.list.getSnapshot().byId[sid('published')]).toMatchObject({ id: 'published', blank: true })
  })
})

describe('fork', () => {
  it.each([
    ['Roadmap', 'Roadmap (1)'],
    ['Roadmap (1)', 'Roadmap (2)'],
    ['计划（1）', '计划（2）'],
    ['计划 （9）', '计划 （10）'],
  ])('increments the durable title %j after the child is published', async (sourceTitle, childTitle) => {
    const b = bench()
    b.svc.handleControlFrame({
      type: 'projection', sessionId: sid('source'), key: 'title', value: sourceTitle, seq: 2,
    })
    await feedList(b, [{ id: 'source', cwd: '/work' }])
    b.api.onFork = () => Promise.resolve(ok({ sessionId: sid('child') }))
    b.api.onRename = (payload) => {
      const { title } = payload as { title: string }
      return Promise.resolve(ok({ title, seq: 3 }))
    }

    await expect(b.svc.fork({
      sessionId: sid('source'), atSeq: 7, increaseTitle: true,
    })).resolves.toBe('child')

    expect(b.api.callsOf('session.fork')).toEqual([{ sessionId: 'source', atSeq: 7 }])
    expect(b.api.callsOf('session.rename')).toEqual([{ sessionId: 'child', title: childTitle }])
    await Promise.resolve()
    expect(b.svc.list.getSnapshot().byId[sid('child')]).toMatchObject({
      title: childTitle,
      displayTitle: childTitle,
      parentId: 'source',
    })
  })

  it('floors a fractional anchor to the real event seq the wire accepts', async () => {
    const b = bench()
    await feedList(b, [{ id: 'source', cwd: '/work' }])
    b.api.onFork = () => Promise.resolve(ok({ sessionId: sid('child') }))

    // The frozen node of an interrupted turn carries turnEnd.seq - 0.9.
    await expect(b.svc.fork({ sessionId: sid('source'), atSeq: 41.1 })).resolves.toBe('child')

    expect(b.api.callsOf('session.fork')).toEqual([{ sessionId: 'source', atSeq: 41 }])
  })

  it('does not rename without the title policy or a durable source title', async () => {
    const b = bench()
    await feedList(b, [{ id: 'source', cwd: '/work' }])
    b.api.onFork = () => Promise.resolve(ok({ sessionId: sid('child') }))
    await expect(b.svc.fork({ sessionId: sid('source'), increaseTitle: true })).resolves.toBe('child')
    expect(b.api.callsOf('session.rename')).toEqual([])

    b.api.onFork = () => Promise.resolve(ok({ sessionId: sid('child-2') }))
    await expect(b.svc.fork({ sessionId: sid('source') })).resolves.toBe('child-2')
    expect(b.api.callsOf('session.rename')).toEqual([])
  })

  it('rejects when child rename fails while keeping the published child addressable', async () => {
    const b = bench()
    b.svc.handleControlFrame({
      type: 'projection', sessionId: sid('source'), key: 'title', value: 'Roadmap', seq: 2,
    })
    await feedList(b, [{ id: 'source' }])
    b.api.onFork = () => Promise.resolve(ok({ sessionId: sid('child') }))
    b.api.onRename = () => Promise.resolve(err(new RemoteError('session/title-invalid', 'rejected', { sessionId: sid('child') })))

    await expect(b.svc.fork({ sessionId: sid('source'), increaseTitle: true }))
      .rejects.toThrow('fork child rename failed: session/title-invalid: rejected')
    expect(b.svc.binding(sid('child'))).toBeDefined()
  })
})

describe('scope lifecycle rides the list mirror (entity parity: no client-side pre-birth)', () => {
  it('a session-added frame births the row (blank) and makes the scope resolvable; removal prunes it', async () => {
    const b = bench()
    await feedList(b, [])
    expect(b.svc.scope(sid('s-new'))).toBeUndefined() // not in view: no scope, no exceptions
    b.svc.handleSessionAdded({
      sessionId: sid('s-new'), updatedAt: 2, running: false, blank: true, cwd: '/w/a',
    })
    await Promise.resolve()
    const scoped = b.svc.scope(sid('s-new'))
    expect(scoped).toBeDefined()
    expect(scopeOf(scoped as Context)).toBe('s-new')
    b.svc.handleSessionRemoved(sid('s-new'))
    await Promise.resolve()
    expect(b.svc.scope(sid('s-new'))).toBeUndefined()
  })
})

describe('blank mirror', () => {
  it('flips blank=false from the running:true status frame (cross-client conversion)', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1', blank: true }])
    expect(b.svc.list.getSnapshot().byId[sid('s1')]).toMatchObject({ blank: true })
    b.svc.handleSessionStatus(sid('s1'), true)
    await Promise.resolve()
    expect(b.svc.list.getSnapshot().byId[sid('s1')]).toMatchObject({ blank: false, running: true })
    // The instantiated Session mirrors the same flip.
    expect(b.svc.binding(sid('s1'))?.session.getSnapshot().blank).toBe(false)
  })

  it('flips blank=false on prompt ACCEPTANCE, not on the attempt', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1', blank: true, cwd: '/w/a' }])
    const session = b.svc.binding(sid('s1'))!.session
    expect(session.getSnapshot().blank).toBe(true)
    const gate = deferred<Awaited<ReturnType<FakeApiClient['onPrompt']>>>()
    b.api.onPrompt = () => gate.promise
    const send = session.prompt([{ type: 'text', text: 'hi' }], 'queue')
    // In flight: still blank (the flip point is the success response, which
    // proves the user message reached the host log).
    expect(session.getSnapshot().blank).toBe(true)
    gate.resolve(ok({ accepted: true as const }))
    await send
    expect(session.getSnapshot().blank).toBe(false)
    await Promise.resolve()
    expect(b.svc.list.getSnapshot().byId[sid('s1')]).toMatchObject({ blank: false })
  })

  it('keeps a rejected first prompt blank: hidden and still reusable', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1', blank: true, cwd: '/w/a' }])
    const session = b.svc.binding(sid('s1'))!.session
    b.api.onPrompt = () => Promise.resolve(err(new RemoteError('gateway/internal', 'agent busy', {})))
    const result = await session.prompt([{ type: 'text', text: 'hi' }], 'queue')
    expect(result.ok).toBe(false)
    // No flip on failure: local stays aligned with the host authority
    // (events.length still 0), so the session stays hidden and reusable.
    expect(session.getSnapshot().blank).toBe(true)
    await Promise.resolve()
    expect(b.svc.list.getSnapshot().byId[sid('s1')]).toMatchObject({ blank: true })
  })

  it('takes session-added blank=true as the hidden birth and list blank as reconnect authority', async () => {
    const b = bench()
    await feedList(b, [])
    b.svc.handleSessionAdded({
      sessionId: sid('s-new'), updatedAt: 2, running: false, blank: true, cwd: '/w/a',
    })
    await Promise.resolve()
    expect(b.svc.list.getSnapshot().byId[sid('s-new')]).toMatchObject({ blank: true })
    // Reconnect re-pull: the summary's blank=false wins (authoritative alignment).
    await feedList(b, [{ id: 's-new', blank: false, cwd: '/w/a' }])
    expect(b.svc.list.getSnapshot().byId[sid('s-new')]).toMatchObject({ blank: false })
  })

  it('never re-blanks: a stale blank=true summary cannot hide an engaged session', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1', blank: true }])
    const session = b.svc.binding(sid('s1'))!.session
    await session.prompt([{ type: 'text', text: 'hi' }], 'queue')
    await Promise.resolve()
    expect(b.svc.list.getSnapshot().byId[sid('s1')]).toMatchObject({ blank: false })
    // The next list pull still claims blank (host hasn't logged the message yet).
    await feedList(b, [{ id: 's1', blank: true }])
    expect(b.svc.binding(sid('s1'))?.session.getSnapshot().blank).toBe(false)
  })
})

describe('coverage tails (branch duals)', () => {
  it('displayTitleOf falls back to the id for empty and separator-only cwd', async () => {
    const b = bench()
    await feedList(b, [{ id: 'no-base', cwd: '///' }, { id: 'empty-cwd', cwd: '' }])
    const { byId } = b.svc.list.getSnapshot()
    expect(byId[sid('no-base')]?.displayTitle).toBe('no-base')
    expect(byId[sid('empty-cwd')]?.displayTitle).toBe('empty-cwd')
    expect(byId[sid('no-base')]?.title).toBeUndefined()
  })

  it('binding for an unknown session returns undefined and leaves the staged scope intact', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1' }])
    b.svc.open(sid('s1'))
    expect(b.svc.binding(sid('ghost'))).toBeUndefined()
    // Stage unchanged: removing s1 defers (still staged), proving the ghost lookup touched nothing.
    await feedList(b, [])
    expect(b.svc.scope(sid('s1'))).toBeDefined()
  })

  it('a masked current gap holds the stage (no teardown, no re-open) until the stage moves', async () => {
    const b = bench()
    await feedList(b, [{ id: 's1' }])
    b.svc.open(sid('s1'))
    await vi.waitFor(() => { expect(b.api.followStarts).toHaveLength(1) })
    await feedList(b, []) // removed while staged: current masks to undefined, stage holds → deferred
    expect(b.svc.scope(sid('s1'))).toBeDefined()
    // Resurfacing re-projects current = s1: same stage occupant, no second pull.
    await feedList(b, [{ id: 's1' }])
    expect(b.api.followStarts).toHaveLength(1)
    expect(b.svc.list.getSnapshot().current).toBe('s1')
  })

  it('sweep hits both deferral edges: staged-id skip and an already-vacated scope record', async () => {
    const b = bench()
    await feedList(b, [{ id: 'a' }, { id: 'b' }])
    b.svc.scope(sid('a'))
    b.svc.open(sid('b')) // stage: b; both scoped
    await feedList(b, []) // a removed off stage → torn immediately; b removed staged → deferred
    // Move the stage to a THIRD id while b stays deferred: sweep walks a set
    // containing b (torn).
    await feedList(b, [{ id: 'c' }])
    b.svc.open(sid('c'))
    expect(b.svc.scope(sid('b'))).toBeUndefined()
    // Deferral for an id whose record was never minted: force the deferral
    // via removed list state — sweep must tolerate the missing record.
    await feedList(b, []) // c removed while staged → deferred (scope exists)
    await feedList(b, [{ id: 'd' }])
    b.svc.open(sid('d')) // sweep tears c
    expect(b.svc.scope(sid('c'))).toBeUndefined()
  })

})
