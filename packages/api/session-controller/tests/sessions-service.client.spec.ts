/** Client catalog projection, explicitly retained scopes, streams, and Host operations. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionReference } from '../src/client/contract/sessions.ts'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { LlmAttemptId } from '@deepseek-ai/dsh-llm'
import { RemoteStreamCarrierError } from '@deepseek-ai/dsh-api-gateway/client'
import { SESSION_FORMAT_VERSION, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { ok, streamHandle, type RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { ClientSessions, SessionCreateError, SessionForkError } from '../src/client/sessions/service.ts'
import { scopeOf } from '../src/client/scope.ts'
import type {
  SessionAssistantStreamBaseline, SessionFollowFrame, SessionFollowRequest,
} from '../src/types.ts'
import { FOLLOW, err, followScript, sessionWorld } from './remote/session.client.ts'

const sid = (s: string): SessionId => s as SessionId
/** ClientSessions uses the Gateway client for stream supervision and the native Remote mocks for responses. */
const API_ROSTER = webApp.closure(['@deepseek-ai/dsh-api-gateway'])
/** The first client boot pays the cold module transform of the api cone. */
const COLD_BOOT_TIMEOUT_MS = 60_000

interface Bench {
  ctx: Context
  mock: RemoteMock
  svc: ClientSessions
  unblock: Array<() => void>
}

type BenchFactory = () => Bench

const it = createClientTest({ roster: API_ROSTER }).extend<{ bench: BenchFactory }>({
  bench: async ({ mock, start }, use) => {
    mock.load(sessionWorld)
    const client = await start()
    const benches: Bench[] = []
    try {
      await use(() => {
        const ctx = new Context()
        const svc = new ClientSessions(ctx, client.ctx.remote)
        const b = { ctx, mock, svc, unblock: [] as Array<() => void> }
        benches.push(b)
        return b
      })
    } finally {
      for (const b of benches) for (const finish of b.unblock) finish()
      await Promise.all(benches.map(b => b.ctx.fiber.dispose()))
    }
  },
})

/** Refresh the manager list from programmable rows and flush the microtask batch. */
type FeedRow = {
  id: string
  cwd?: string
  parentId?: string
  origin?: 'subagent'
  running?: boolean
  blank?: boolean
  projections?: import('../src/types.ts').SessionProjectionValues
}

async function feedList(b: Bench, rows: FeedRow[]): Promise<void> {
  b.mock.remote.session.list.mockResolvedValue(ok({
    items: rows.map(r => ({ agentAvailable: true,
      sessionId: sid(r.id), updatedAt: 1, running: r.running ?? false, blank: r.blank ?? false,
      ...(r.cwd !== undefined ? { cwd: r.cwd } : {}),
      ...(r.parentId !== undefined ? { parentSessionId: sid(r.parentId) } : {}),
      ...(r.origin !== undefined ? { origin: r.origin } : {}),
      ...(r.projections === undefined
        ? {}
        : { projections: { kind: 'sequenced' as const, asOfSeq: 0, values: r.projections } }),
    })),
  }))
  await b.svc.refresh()
  await Promise.resolve() // manager notifier flush
}

describe('list store projection', () => {
  it('projects durable titles separately from cwd/id display fallbacks and parent links', async ({ bench }) => {
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
  }, COLD_BOOT_TIMEOUT_MS)

  it('reprojects a blank session from the generic agent-preset projection', async ({ bench }) => {
    const b = bench()
    await feedList(b, [{ id: 's1', blank: true, projections: { agentPreset: 'standard' } }])
    expect(b.svc.list.getSnapshot().byId[sid('s1')]?.projectionValues?.agentPreset).toBe('standard')

    b.svc.handleControlFrame({
      type: 'projection', sessionId: sid('s1'), key: 'agentPreset', value: 'minimal', seq: 1,
    })
    await Promise.resolve()

    expect(b.svc.list.getSnapshot().byId[sid('s1')]?.projectionValues?.agentPreset).toBe('minimal')
  })

  it('reflects live increments (host stream via manager) into the store', async ({ bench }) => {
    const b = bench()
    await feedList(b, [{ id: 's1' }])
    b.svc.handleSessionAdded({ agentAvailable: true,
      sessionId: sid('s2'), updatedAt: 2, running: false, blank: true,
    })
    await Promise.resolve()
    expect(b.svc.list.getSnapshot().ids).toContain('s2')
  })
})

describe('search', () => {
  it('delegates transient content search without changing the list snapshot', async ({ bench }) => {
    const b = bench()
    await feedList(b, [{ id: 's1' }])
    const before = b.svc.list.getSnapshot()
    b.mock.remote.session.search.mockResolvedValue(ok({
      items: [{ sessionId: sid('s1'), snippet: 'matching excerpt' }],
      hasMore: false,
    }))
    const signal = new AbortController().signal
    const call = vi.spyOn(b.mock.rpc, 'call')

    await expect(b.svc.search('needle', signal)).resolves.toEqual({
      ok: true,
      value: {
        items: [{ sessionId: 's1', snippet: 'matching excerpt' }],
        hasMore: false,
      },
    })
    expect(call.mock.calls.find(([, endpoint]) => endpoint === 'session/search')?.[3]).toBe(signal)
    expect(b.svc.list.getSnapshot()).toBe(before)
  })
})

describe('scope tree', () => {
  it('opens a conversation from follow projections without a second projection request', async ({ bench }) => {
    const b = bench()
    b.mock.stream(FOLLOW, followScript(ok({
      records: [], hasMore: false,
      projections: { asOfSeq: 0, values: { subagentCatalog: [{
        id: sid('child'), createdAt: 1, mode: 'one-shot',
      }] } },
    })))
    await feedList(b, [{ id: 's1' }])
    using reference = b.svc.retain(sid('s1'), { source: 'controllerOperation' })
    await reference.ready
    await vi.waitFor(() => {
      expect(b.svc.list.getSnapshot().projectionsBySession[sid('s1')]?.values.subagentCatalog)
        .toEqual([{ id: sid('child'), createdAt: 1, mode: 'one-shot' }])
    })
    expect(b.mock.remote.session.projections).not.toHaveBeenCalled()
  })

  it('publishes the final Assistant message before retiring transient chunks at Step end', async ({ bench }) => {
    const b = bench()
    await feedList(b, [{ id: 's1' }])
    using _reference = b.svc.retain(sid('s1'), { source: 'controllerOperation' })
    await _reference.ready
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

    b.mock.streams.push(FOLLOW, {
      type: 'assistant-stream',
      frame: {
        type: 'start', attemptId, revision: 1, startedAfterSeq: -1,
        turn: 1, step: 1,
      },
    })
    await b.mock.streams.drained(FOLLOW)
    b.mock.streams.push(FOLLOW, {
      type: 'assistant-stream',
      frame: {
        type: 'chunk', attemptId, revision: 2, index: 0,
        time: 1,
        chunk: { type: 'text-delta', index: 0, text: 'live' },
      },
    })
    await b.mock.streams.drained(FOLLOW)
    await vi.waitFor(() => {
      expect(binding.eventSource.getSnapshot().entries).toHaveLength(1)
    })
    b.mock.streams.push(FOLLOW, durableMessage)
    await b.mock.streams.drained(FOLLOW)
    await Promise.resolve()
    expect(binding.eventSource.getSnapshot().entries).toHaveLength(1)

    b.mock.streams.push(FOLLOW, {
      type: 'assistant-stream',
      frame: {
        type: 'end', attemptId, revision: 3, index: 1,
        outcome: { kind: 'committed', eventType: 'assistant/message', seq: 0 },
      },
    })
    await b.mock.streams.drained(FOLLOW)
    await vi.waitFor(() => {
      expect(binding.eventSource.getSnapshot().entries).toHaveLength(2)
    })

    expect(publications).toEqual([
      ['assistant/live-chunk'],
      ['assistant/live-chunk', 'assistant/message'],
    ])
    b.mock.streams.push(FOLLOW, {
      type: 'event', event: { type: 'step/end', seq: 1, time: 3, data: { turn: 1, step: 1 } },
    })
    await b.mock.streams.drained(FOLLOW)
    expect(binding.eventSource.getSnapshot().entries.map(entry => entry.event.type))
      .toEqual(['assistant/message', 'step/end'])
    expect(binding.eventSource.getSnapshot().change).toEqual({ kind: 'settle-assistant', attemptId })
    dispose()
  })

  it('replaces an active assistant baseline on reconnect without duplicate chunks', async ({ bench }) => {
    const b = bench()
    const attemptId = LlmAttemptId('reconnect-attempt')
    let records: never[] = []
    let assistantStreamBaseline: SessionAssistantStreamBaseline = {
      revision: 2,
      activeAttempt: {
        attemptId, startedAfterSeq: -1, turn: 1, step: 1,
        nextIndex: 1,
        stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['a'] }],
      },
    }
    b.mock.stream(FOLLOW, followScript(
      () => ok({ records, hasMore: false }),
      { assistantStream: () => assistantStreamBaseline },
    ))
    await feedList(b, [{ id: 's1' }])
    using _reference = b.svc.retain(sid('s1'), { source: 'controllerOperation' })
    await _reference.ready
    const binding = b.svc.binding(sid('s1'))
    if (binding === undefined) throw new Error('expected Session binding')
    await vi.waitFor(() => {
      expect(binding.eventSource.getSnapshot().entries).toHaveLength(1)
    })

    records = []
    assistantStreamBaseline = {
      revision: 3,
      activeAttempt: {
        attemptId, startedAfterSeq: -1, turn: 1, step: 1,
        nextIndex: 2,
        stream: [{ type: 'text-chunks', time0: 1, index: 0, dt: [1], texts: ['a', 'b'] }],
      },
    }
    b.mock.streams.fail(FOLLOW, new RemoteStreamCarrierError('lost'))
    await vi.waitFor(() => {
      expect(b.mock.log.requests(FOLLOW)).toHaveLength(2)
      expect(binding.eventSource.getSnapshot().entries).toHaveLength(2)
    })

    expect(binding.eventSource.getSnapshot().entries.map(entry => (
      entry.event.type === 'assistant/live-chunk' && entry.event.data.chunk.type === 'text-delta'
        ? entry.event.data.chunk.text
        : undefined
    ))).toEqual(['a', 'b'])
  })

  it('stages a post-opening assistant settlement behind its exact active attempt', async ({ bench }) => {
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
    const history = ok({
      records: [priorMessage] as never[],
      hasMore: false,
    })
    const assistantStreamBaseline: SessionAssistantStreamBaseline = {
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
    b.mock.stream(FOLLOW, followScript(history, { assistantStream: assistantStreamBaseline }))
    await feedList(b, [{ id: 's1' }])
    using _reference = b.svc.retain(sid('s1'), { source: 'controllerOperation' })
    await _reference.ready
    const binding = b.svc.binding(sid('s1'))
    if (binding === undefined) throw new Error('expected Session binding')
    await vi.waitFor(() => {
      expect(binding.session.getSnapshot().openState).toBe('open')
    })

    expect(binding.eventSource.getSnapshot().entries.map(entry => entry.event.type))
      .toEqual(['assistant/message', 'assistant/live-chunk'])
    expect(binding.eventSource.getSnapshot().entries[0]?.event).toBe(priorMessage.event)

    b.mock.streams.push(FOLLOW, currentMessage)
    await b.mock.streams.drained(FOLLOW)
    await Promise.resolve()
    expect(binding.eventSource.getSnapshot().entries.map(entry => entry.event.type))
      .toEqual(['assistant/message', 'assistant/live-chunk'])

    b.mock.streams.push(FOLLOW, {
      type: 'assistant-stream',
      frame: {
        type: 'end', attemptId, revision: 3, index: 1,
        outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 },
      },
    })
    await b.mock.streams.drained(FOLLOW)
    await vi.waitFor(() => {
      expect(binding.eventSource.getSnapshot().entries.map(entry => entry.event.type))
        .toEqual(['assistant/message', 'assistant/live-chunk', 'assistant/message'])
    })
    expect(binding.eventSource.getSnapshot().change).toEqual({
      kind: 'append', entries: [currentMessage],
    })
  })

  it('replaces an invalid settlement with the authoritative post-end baseline', async ({ bench }) => {
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
    let assistantStreamBaseline: SessionAssistantStreamBaseline = {
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
    b.mock.stream(FOLLOW, followScript(
      () => ok({ records, hasMore: false }),
      { assistantStream: () => assistantStreamBaseline },
    ))
    await feedList(b, [{ id: 's1' }])
    using _reference = b.svc.retain(sid('s1'), { source: 'controllerOperation' })
    await _reference.ready
    const binding = b.svc.binding(sid('s1'))
    if (binding === undefined) throw new Error('expected Session binding')
    await vi.waitFor(() => {
      expect(binding.eventSource.getSnapshot().entries.map(entry => entry.event.type))
        .toEqual(['turn/start', 'assistant/live-chunk'])
    })
    const openingRevision = binding.eventSource.getSnapshot().revision

    b.mock.streams.push(FOLLOW, message)
    await b.mock.streams.drained(FOLLOW)
    await Promise.resolve()
    expect(binding.eventSource.getSnapshot().entries.map(entry => entry.event.type))
      .toEqual(['turn/start', 'assistant/live-chunk'])
    records = [prior, message] as never[]
    assistantStreamBaseline = { revision: 3 }
    b.mock.streams.push(FOLLOW, {
      type: 'assistant-stream',
      frame: {
        type: 'end', attemptId, revision: 3, index: 0,
        outcome: { kind: 'committed', eventType: 'assistant/message', seq: 0 },
      },
    })
    await b.mock.streams.drained(FOLLOW)
    await vi.waitFor(() => {
      expect(b.mock.log.requests(FOLLOW)).toHaveLength(2)
      expect(b.mock.log.streams(FOLLOW).filter(stream => stream.state === 'open')).toHaveLength(1)
      expect(binding.eventSource.getSnapshot().revision).toBeGreaterThan(openingRevision)
      expect(binding.eventSource.getSnapshot().entries.map(entry => entry.event.type))
        .toEqual(['turn/start', 'assistant/message'])
    })
  })

  it('holds a Host-addressed Context across an empty catalog baseline', async ({ bench }) => {
    const b = bench()
    using reference = b.svc.retainAgentScope(sid('s-early'))
    const scoped = reference.binding.ctx
    expect(scopeOf(scoped)).toBe('s-early')
    b.svc.handleControlFrame({ type: 'baseline', value: { projections: {} } })
    await feedList(b, [])
    expect(b.svc.scope(sid('s-early'))).toBe(scoped)
    reference.release()
    expect(b.svc.scope(sid('s-early'))).toBeUndefined()
  })

  it('borrows only retained bindings and preserves them while the catalog changes', async ({ bench }) => {
    const b = bench()
    await feedList(b, [{ id: 's1' }])
    expect(b.svc.scope(sid('s1'))).toBeUndefined()
    using reference = b.svc.retain(sid('s1'), { source: 'controllerOperation' })
    await reference.ready
    const binding = reference.binding
    expect(b.svc.scope(sid('s1'))).toBe(binding.ctx)
    expect(b.svc.sessionOf(binding.ctx)).toBe(binding.session)
    await feedList(b, [])
    expect(b.svc.binding(sid('s1'))).toBe(binding)
    await feedList(b, [{ id: 's1', running: true }])
    expect(b.svc.binding(sid('s1'))).toBe(binding)
    reference.release()
    expect(b.svc.binding(sid('s1'))).toBeUndefined()
  })

  it('closes an opened journal when its removed scope drops', async ({ bench }) => {
    const b = bench()
    const follows = () => b.mock.log.streams(FOLLOW).filter(({ args }) => {
      const request = args[0] as SessionFollowRequest
      return request.address.kind === 'session' && request.address.sessionId === sid('s1')
    })
    await feedList(b, [{ id: 's1' }])
    using reference = b.svc.retain(sid('s1'), { source: 'controllerOperation' })
    await reference.ready
    const session = b.svc.binding(sid('s1'))?.session
    if (session === undefined) throw new Error('expected the selected Session binding')
    await vi.waitFor(() => { expect(follows().filter(stream => stream.state === 'open')).toHaveLength(1) })
    const notified = vi.fn()
    session.subscribe(notified)

    await feedList(b, [])
    expect(b.svc.binding(sid('s1'))?.session).toBe(session)
    reference.release()

    await vi.waitFor(() => { expect(follows().filter(stream => stream.state === 'open')).toHaveLength(0) })
    notified.mockClear()
    expect(b.mock.streams.push(FOLLOW, {
      type: 'event',
      event: { seq: 0, timestamp: 0, type: 'turn/start', data: { turn: 0 } } as never,
    }, ([request]) => {
      const address = (request as SessionFollowRequest).address
      return address.kind === 'session' && address.sessionId === sid('s1')
    })).toBe(0)
    await b.mock.streams.drained(FOLLOW)
    await Promise.resolve()
    expect(follows()).toHaveLength(1)
    expect(notified).not.toHaveBeenCalled()
  })
})

describe('Agent scope disposal lifecycle', () => {
  it('root disposal runs Agent scope effects', async ({ bench }) => {
    const b = bench()
    const readiness = b.ctx.plugin(() => undefined)
    await readiness
    b.svc.handleSessionAdded({ agentAvailable: true,
      sessionId: sid('live'), updatedAt: 1, running: false, blank: true,
    })
    await Promise.resolve()
    using reference = b.svc.retainAgentScope(sid('live'))
    const scoped = reference.binding.ctx
    if (scoped === undefined) throw new Error('fixture Agent Context was not minted')
    await scoped.fiber.await()
    const scopeDisposed = vi.fn()
    scoped.effect(() => scopeDisposed, 'fixture Agent scope effect')
    await b.ctx.fiber.dispose()

    expect(scopeDisposed).toHaveBeenCalledOnce()
    expect(b.svc.sessionOf(scoped)).toBeUndefined()
  })

  it('root disposal waits for an opened Session source to finish closing', async ({ bench }) => {
    const closeGate = Promise.withResolvers<undefined>()
    const abortObserved = vi.fn()
    let followSignal: AbortSignal | undefined
    const b = bench()
    b.unblock.push(() => { closeGate.resolve(undefined) })
    b.mock.remote.session.follow.mockImplementation((request, signal) => {
      if (signal === undefined) throw new Error('fixture requires a signal')
      followSignal = signal
      let opened = false
      return streamHandle<SessionFollowFrame>({
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
      })
    })
    const readiness = b.ctx.plugin(() => undefined)
    await readiness
    await feedList(b, [{ id: 's1' }])
    using _reference = b.svc.retain(sid('s1'), { source: 'controllerOperation' })
    await _reference.ready
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

  it('root disposal joins every Session drop already started by final release under load', async ({ bench }) => {
    const closeGates = new Map<SessionId, PromiseWithResolvers<undefined>>()
    const aborted = new Set<SessionId>()
    const b = bench()
    b.unblock.push(() => { for (const gate of closeGates.values()) gate.resolve(undefined) })
    b.mock.remote.session.follow.mockImplementation((request, signal) => {
      if (signal === undefined) throw new Error('fixture requires a signal')
      const sessionId = request.address.kind === 'session'
        ? request.address.sessionId
        : request.address.childSessionId
      const closeGate = Promise.withResolvers<undefined>()
      closeGates.set(sessionId, closeGate)
      let opened = false
      return streamHandle<SessionFollowFrame>({
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
      })
    })
    const readiness = b.ctx.plugin(() => undefined)
    await readiness
    const sessionIds = Array.from({ length: 24 }, (_, index) => sid(`load-${String(index)}`))
    const retained = sessionIds.at(-1)
    const held = sessionIds[0]
    if (retained === undefined || held === undefined) throw new Error('fixture requires sessions')
    await feedList(b, sessionIds.map(id => ({ id })))
    const references = new Map<SessionId, SessionReference>()
    for (const id of sessionIds) {
      const reference = b.svc.retain(id, { source: 'controllerOperation' })
      await reference.ready
      references.set(id, reference)
    }
    await vi.waitFor(() => {
      for (const id of sessionIds) {
        expect(b.svc.binding(id)?.session.getSnapshot().openState).toBe('open')
      }
    })

    const pruned = sessionIds.slice(0, -1)
    await feedList(b, [{ id: retained }])
    for (const id of pruned) references.get(id)?.release()
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
    expect(settled).not.toHaveBeenCalled()

    closeGates.get(held)?.resolve(undefined)
    await observed
    expect(settled).toHaveBeenCalledOnce()
  })
})

describe('borrow-only bindings', () => {
  it('keeps catalog discovery separate from history opening and ownership', async ({ bench }) => {
    const b = bench()
    await feedList(b, [{ id: 's1' }, { id: 's2' }])
    expect(b.svc.binding(sid('s1'))).toBeUndefined()
    expect(b.svc.scope(sid('s2'))).toBeUndefined()
    expect(b.mock.log.requests(FOLLOW)).toHaveLength(0)
    using reference = b.svc.retain(sid('s1'), { source: 'controllerOperation' })
    await reference.ready
    using second = b.svc.retain(sid('s1'), { source: 'controllerOperation' })
    await second.ready
    expect(second.binding).toBe(reference.binding)
    expect(b.mock.log.requests(FOLLOW)).toHaveLength(1)
  })
})

describe('catalog-addressed navigation', () => {
  it('retains a projected child independently of its parent and shares its history generation', async ({ bench }) => {
    const b = bench()
    await feedList(b, [{ id: 'root' }])
    b.mock.remote.session.projections.mockResolvedValue(ok({
      asOfSeq: 0, values: { subagentCatalog: [{ id: sid('child'), createdAt: 1, mode: 'continuable', label: 'Child' }] },
    }))
    await b.svc.refreshProjections(sid('root'))
    const address = b.svc.subagentAddress(sid('child'))!
    using first = b.svc.retain(sid('child'), { source: 'controllerOperation' })
    using second = b.svc.retain(address, { source: 'gateway' })
    await Promise.all([first.ready, second.ready])
    expect(first.binding).toBe(second.binding)
    expect(b.svc.scope(sid('root'))).toBeUndefined()
    expect(b.svc.list.getSnapshot().ids).toEqual([sid('root')])
    expect(b.svc.list.getSnapshot().byId[sid('child')]?.retainedBy)
      .toEqual({ controllerOperation: 1, gateway: 1 })
    const binding = first.binding
    first.release()
    expect(b.svc.binding(sid('child'))).toBe(binding)
    expect(b.svc.list.getSnapshot().byId[sid('child')]?.retainedBy).toEqual({ gateway: 1 })
    second.release()
    expect(b.svc.binding(sid('child'))).toBeUndefined()
    expect(b.svc.list.getSnapshot().byId[sid('child')]?.retainedBy).toEqual({})
    expect(b.svc.subagentAddress(sid('child'))).toEqual(address)
    expect(b.mock.log.requests(FOLLOW)).toHaveLength(1)
    expect(b.mock.remote.session.projections).toHaveBeenCalledOnce()
  })

  for (const title of [undefined, 'Investigate startup']) {
    it(`loads an unretained one-shot child with projected title ${String(title)}`, async ({ bench }) => {
      const b = bench()
      if (title !== undefined) b.svc.handleControlFrame({
        type: 'projection', sessionId: sid('one-shot'), key: 'title', value: title, seq: 2,
      })
      b.mock.remote.session.projections.mockResolvedValue(ok({
        asOfSeq: 0, values: { subagentCatalog: [{ id: sid('one-shot'), createdAt: 1, mode: 'one-shot' }] },
      }))
      await b.svc.refreshProjections(sid('root'))
      expect(b.svc.list.getSnapshot().byId[sid('one-shot')]?.displayTitle).toBe(title ?? 'one-shot')
      if (title !== undefined) expect(b.svc.list.getSnapshot().byId[sid('one-shot')]).toMatchObject({
        title, projectionValues: { title },
      })
      expect(b.svc.binding(sid('one-shot'))).toBeUndefined()
      expect(b.svc.retainInfo(sid('one-shot')).getSnapshot().referenceCount).toBe(0)
      expect(b.mock.remote.session.projections).toHaveBeenCalledOnce()
      expect(b.mock.log.requests(FOLLOW)).toHaveLength(0)
    })
  }

  it('keeps projected titles in standard list rows for an addressed route', async ({ bench }) => {
    const b = bench()
    b.mock.remote.session.projections.mockImplementation((payload) => {
      const { sessionId } = payload as { sessionId: SessionId }
      if (sessionId === sid('root')) {
        return Promise.resolve(ok({ asOfSeq: 0, values: { subagentCatalog: [{ createdAt: 1,
          id: sid('child'), mode: 'continuable', label: 'Child',
        }] } }))
      }
      if (sessionId === sid('child')) {
        return Promise.resolve(ok({ asOfSeq: 0, values: { title: 'Child session title', subagentCatalog: [{ createdAt: 1,
          id: sid('grandchild'), mode: 'continuable', label: 'Grandchild',
        }] } }))
      }
      return Promise.resolve(ok({ asOfSeq: 0, values: { subagentCatalog: [] } }))
    })
    await feedList(b, [
      { id: 'root' },
      {
        id: 'child', cwd: '/summary-child', parentId: 'root', origin: 'subagent',
        projections: { title: 'Child session title' },
      },
      { id: 'grandchild', cwd: '/summary-grandchild', parentId: 'child', origin: 'subagent' },
    ])
    await b.svc.refreshProjections(sid('root'))
    await b.svc.refreshProjections(sid('child'))
    using _reference = b.svc.retain({
      parentSessionId: sid('child'), childSessionId: sid('grandchild'), mode: 'continuable',
    }, { source: 'controllerOperation' })
    await _reference.ready

    expect(b.svc.list.getSnapshot().byId[sid('child')]).toMatchObject({
      title: 'Child session title',
      displayTitle: 'Child session title',
      projectionValues: { title: 'Child session title' },
    })
    expect(b.svc.list.getSnapshot().byId[sid('grandchild')]?.displayTitle).toBe('Grandchild')
  })

  it('projects a retained descendant and discovers ancestor addresses without retaining ancestor scopes', async ({ bench }) => {
    const b = bench()
    b.mock.remote.session.projections.mockImplementation((payload) => {
      const { sessionId } = payload as { sessionId: SessionId }
      if (sessionId === sid('root')) {
        return Promise.resolve(ok({ asOfSeq: 0, values: { subagentCatalog: [{ createdAt: 1,
          id: sid('child'), mode: 'continuable', label: 'Child',
        }] } }))
      }
      if (sessionId === sid('child')) {
        return Promise.resolve(ok({ asOfSeq: 0, values: { subagentCatalog: [{ createdAt: 1,
          id: sid('grandchild'), mode: 'continuable', label: 'Grandchild',
        }] } }))
      }
      return Promise.resolve(ok({ asOfSeq: 0, values: { subagentCatalog: [] } }))
    })
    await feedList(b, [{ id: 'root' }])
    await b.svc.refreshProjections(sid('root'))
    await b.svc.refreshProjections(sid('child'))
    using reference = b.svc.retain({
      parentSessionId: sid('child'), childSessionId: sid('grandchild'), mode: 'continuable',
    }, { source: 'controllerOperation' })
    await reference.ready

    const list = b.svc.list.getSnapshot()
    expect(list.ids).toEqual([sid('root')])
    expect(list.byId[sid('child')]).toMatchObject({ parentId: sid('root'), origin: 'subagent' })
    expect(list.byId[sid('grandchild')]).toMatchObject({ parentId: sid('child'), origin: 'subagent' })
    expect(b.svc.binding(sid('child'))).toBeUndefined()
    expect(b.svc.subagentAddress(sid('child'))).toEqual({
      parentSessionId: sid('root'),
      childSessionId: sid('child'),
      mode: 'continuable',
    })
    using child = b.svc.retain(sid('child'), { source: 'controllerOperation' })
    await child.ready
    expect(b.svc.binding(sid('child'))).toBe(child.binding)
    expect(b.svc.binding(sid('grandchild'))).toBe(reference.binding)
  })
})

describe('create', () => {
  it('passes a preallocated id and preserves it on ordinary failure', async ({ bench }) => {
    const b = bench()
    b.mock.remote.session.create.mockResolvedValue(ok({ sessionId: sid('fresh') }))
    await expect(b.svc.create({ cwd: '/w', sessionId: sid('fresh') })).resolves.toBe('fresh')
    expect(b.mock.remote.session.create).toHaveBeenCalledExactlyOnceWith({ cwd: '/w', sessionId: 'fresh' })
    b.mock.remote.session.create.mockResolvedValue(err(new RemoteError('gateway/internal', '爆了', {})))
    const failure = await b.svc.create({ sessionId: sid('candidate') }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(SessionCreateError)
    expect(failure).toMatchObject({
      requestedSessionId: 'candidate',
      rpcError: { code: 'gateway/internal', message: '爆了' },
    })
  })

  it('publishes a created identity without implicitly retaining its binding', async ({ bench }) => {
    const b = bench()
    b.mock.remote.session.create.mockResolvedValue(ok({ sessionId: sid('born') }))
    const born = await b.svc.create({ workspaceId: 'ws' as never })
    // Synchronously after resolution — the draft hand-off contract: the
    // create echo IS the entity entering the client's view (blank row +
    // catalog publication), no notifier flush in between.
    expect(b.svc.list.getSnapshot().byId[born]).toMatchObject({ id: 'born', blank: true })
    expect(b.svc.binding(born)).toBeUndefined()
    expect(b.svc.scope(born)).toBeUndefined()
    using reference = b.svc.retain(born, { source: 'controllerOperation' })
    await reference.ready
    expect(b.svc.binding(born)).toBe(reference.binding)
  })

  it('lists the published id after Workspace attachment fails (publication precedes attachment)', async ({ bench }) => {
    const b = bench()
    b.mock.remote.session.create.mockResolvedValue(err(new RemoteError(
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
  it('propagates a failed fork without creating or retaining a child', async ({ bench }) => {
    const b = bench()
    const error = new RemoteError('session/not-found', 'source missing', { sessionId: sid('source') })
    b.mock.remote.session.fork.mockResolvedValue(err(error))
    const failure = await b.svc.fork({ sessionId: sid('source') }).catch((cause: unknown) => cause)
    expect(failure).toBeInstanceOf(SessionForkError)
    expect(failure).toMatchObject({ sourceSessionId: 'source', rpcError: error })
    expect(b.svc.list.getSnapshot().ids).toEqual([])
    expect(b.mock.log.requests(FOLLOW)).toHaveLength(0)
  })

  it.for([
    ['Roadmap', 'Roadmap (1)'],
    ['Roadmap (1)', 'Roadmap (2)'],
    ['计划（1）', '计划（2）'],
    ['计划 （9）', '计划 （10）'],
  ] as const)('increments the durable title %j after the child is published', async ([sourceTitle, childTitle], { bench }) => {
    const b = bench()
    b.svc.handleControlFrame({
      type: 'projection', sessionId: sid('source'), key: 'title', value: sourceTitle, seq: 2,
    })
    await feedList(b, [{ id: 'source', cwd: '/work' }])
    b.mock.remote.session.fork.mockResolvedValue(ok({ sessionId: sid('child') }))
    b.mock.remote.session.rename.mockImplementation((payload) => {
      const { title } = payload as { title: string }
      return Promise.resolve(ok({ title, seq: 3 }))
    })

    await expect(b.svc.fork({
      sessionId: sid('source'), atSeq: 7, increaseTitle: true,
    })).resolves.toBe('child')

    expect(b.mock.remote.session.fork).toHaveBeenCalledExactlyOnceWith({ sessionId: 'source', atSeq: 7 })
    expect(b.mock.remote.session.rename).toHaveBeenCalledExactlyOnceWith({ sessionId: 'child', title: childTitle })
    expect(b.mock.log.requests(FOLLOW)).toHaveLength(0)
    expect(b.svc.binding(sid('child'))).toBeUndefined()
    expect(b.svc.retainInfo(sid('child')).getSnapshot().referenceCount).toBe(0)
    await Promise.resolve()
    expect(b.svc.list.getSnapshot().byId[sid('child')]).toMatchObject({
      title: childTitle,
      displayTitle: childTitle,
      parentId: 'source',
    })
  })

  it('sends the exact boundary seq verbatim: callers pass real event seqs', async ({ bench }) => {
    const b = bench()
    await feedList(b, [{ id: 'source', cwd: '/work' }])
    b.mock.remote.session.fork.mockResolvedValue(ok({ sessionId: sid('child') }))

    await expect(b.svc.fork({ sessionId: sid('source'), atSeq: 41 })).resolves.toBe('child')

    expect(b.mock.remote.session.fork).toHaveBeenCalledExactlyOnceWith({ sessionId: 'source', atSeq: 41 })
  })

  it('does not rename without the title policy or a durable source title', async ({ bench }) => {
    const b = bench()
    await feedList(b, [{ id: 'source', cwd: '/work' }])
    b.mock.remote.session.fork.mockResolvedValue(ok({ sessionId: sid('child') }))
    await expect(b.svc.fork({ sessionId: sid('source'), increaseTitle: true })).resolves.toBe('child')
    expect(b.mock.remote.session.rename).not.toHaveBeenCalled()

    b.mock.remote.session.fork.mockResolvedValue(ok({ sessionId: sid('child-2') }))
    await expect(b.svc.fork({ sessionId: sid('source') })).resolves.toBe('child-2')
    expect(b.mock.remote.session.rename).not.toHaveBeenCalled()
  })

  it('rejects child rename failure while preserving its catalog row without retaining the child', async ({ bench }) => {
    const b = bench()
    b.svc.handleControlFrame({
      type: 'projection', sessionId: sid('source'), key: 'title', value: 'Roadmap', seq: 2,
    })
    await feedList(b, [{ id: 'source' }])
    b.mock.remote.session.fork.mockResolvedValue(ok({ sessionId: sid('child') }))
    b.mock.remote.session.rename.mockResolvedValue(err(new RemoteError('session/title-invalid', 'rejected', { sessionId: sid('child') })))

    await expect(b.svc.fork({ sessionId: sid('source'), increaseTitle: true }))
      .rejects.toThrow('fork child rename failed: session/title-invalid: rejected')
    expect(b.svc.list.getSnapshot().byId[sid('child')]).toBeDefined()
    expect(b.svc.binding(sid('child'))).toBeUndefined()
    expect(b.svc.retainInfo(sid('child')).getSnapshot().referenceCount).toBe(0)
    expect(b.mock.log.requests(FOLLOW)).toHaveLength(0)
  })
})

describe('catalog arrival', () => {
  it('keeps a retained binding alive without a catalog row after Host removal', async ({ bench }) => {
    const b = bench()
    b.svc.handleSessionAdded({ agentAvailable: true, sessionId: sid('s-new'), updatedAt: 1, running: false, blank: true })
    await Promise.resolve()
    expect(b.svc.binding(sid('s-new'))).toBeUndefined()
    const reference = b.svc.retain(sid('s-new'), { source: 'controllerOperation' })
    await reference.ready
    const binding = reference.binding
    b.svc.handleSessionRemoved(sid('s-new'))
    await Promise.resolve()
    expect(b.svc.list.getSnapshot().ids).not.toContain(sid('s-new'))
    expect(b.svc.list.getSnapshot().byId[sid('s-new')]).toBeUndefined()
    expect(b.svc.retainInfo(sid('s-new')).getSnapshot().referenceCount).toBe(1)
    expect(b.svc.binding(sid('s-new'))).toBe(binding)
    reference.release()
    expect(b.svc.binding(sid('s-new'))).toBeUndefined()
    expect(b.svc.list.getSnapshot().byId[sid('s-new')]).toBeUndefined()
  })
})

describe('blank mirror', () => {
  it('flips blank=false from the running:true status frame (cross-client conversion)', async ({ bench }) => {
    const b = bench()
    await feedList(b, [{ id: 's1', blank: true }])
    expect(b.svc.list.getSnapshot().byId[sid('s1')]).toMatchObject({ blank: true })
    using _reference = b.svc.retain(sid('s1'), { source: 'controllerOperation' })
    await _reference.ready
    b.svc.handleSessionStatus(sid('s1'), true)
    await Promise.resolve()
    expect(b.svc.list.getSnapshot().byId[sid('s1')]).toMatchObject({ blank: false, running: true })
    // The instantiated Session mirrors the same flip.
    expect(b.svc.binding(sid('s1'))?.session.getSnapshot().blank).toBe(false)
  })

  it('flips blank=false on prompt ACCEPTANCE, not on the attempt', async ({ bench }) => {
    const b = bench()
    await feedList(b, [{ id: 's1', blank: true, cwd: '/w/a' }])
    using reference = b.svc.retain(sid('s1'), { source: 'controllerOperation' })
    await reference.ready
    const session = reference.binding.session
    expect(session.getSnapshot().blank).toBe(true)
    const gate = Promise.withResolvers<Awaited<ReturnType<typeof b.mock.remote.session.prompt>>>()
    b.mock.remote.session.prompt.mockReturnValue(gate.promise)
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

  it('keeps a rejected first prompt blank: hidden and still reusable', async ({ bench }) => {
    const b = bench()
    await feedList(b, [{ id: 's1', blank: true, cwd: '/w/a' }])
    using reference = b.svc.retain(sid('s1'), { source: 'controllerOperation' })
    await reference.ready
    const session = reference.binding.session
    b.mock.remote.session.prompt.mockResolvedValue(err(new RemoteError('gateway/internal', 'agent busy', {})))
    const result = await session.prompt([{ type: 'text', text: 'hi' }], 'queue')
    expect(result.ok).toBe(false)
    // No flip on failure: local stays aligned with the host authority
    // (events.length still 0), so the session stays hidden and reusable.
    expect(session.getSnapshot().blank).toBe(true)
    await Promise.resolve()
    expect(b.svc.list.getSnapshot().byId[sid('s1')]).toMatchObject({ blank: true })
  })

  it('takes session-added blank=true as the hidden birth and list blank as reconnect authority', async ({ bench }) => {
    const b = bench()
    await feedList(b, [])
    b.svc.handleSessionAdded({ agentAvailable: true,
      sessionId: sid('s-new'), updatedAt: 2, running: false, blank: true, cwd: '/w/a',
    })
    await Promise.resolve()
    expect(b.svc.list.getSnapshot().byId[sid('s-new')]).toMatchObject({ blank: true })
    // Reconnect re-pull: the summary's blank=false wins (authoritative alignment).
    await feedList(b, [{ id: 's-new', blank: false, cwd: '/w/a' }])
    expect(b.svc.list.getSnapshot().byId[sid('s-new')]).toMatchObject({ blank: false })
  })

  it('never re-blanks: a stale blank=true summary cannot hide an engaged session', async ({ bench }) => {
    const b = bench()
    await feedList(b, [{ id: 's1', blank: true }])
    using reference = b.svc.retain(sid('s1'), { source: 'controllerOperation' })
    await reference.ready
    const session = reference.binding.session
    await session.prompt([{ type: 'text', text: 'hi' }], 'queue')
    await Promise.resolve()
    expect(b.svc.list.getSnapshot().byId[sid('s1')]).toMatchObject({ blank: false })
    // The next list pull still claims blank (host hasn't logged the message yet).
    await feedList(b, [{ id: 's1', blank: true }])
    expect(b.svc.binding(sid('s1'))?.session.getSnapshot().blank).toBe(false)
  })
})

describe('coverage tails (branch duals)', () => {
  it('displayTitleOf falls back to the id for empty and separator-only cwd', async ({ bench }) => {
    const b = bench()
    await feedList(b, [{ id: 'no-base', cwd: '///' }, { id: 'empty-cwd', cwd: '' }])
    const { byId } = b.svc.list.getSnapshot()
    expect(byId[sid('no-base')]?.displayTitle).toBe('no-base')
    expect(byId[sid('empty-cwd')]?.displayTitle).toBe('empty-cwd')
    expect(byId[sid('no-base')]?.title).toBeUndefined()
  })

  it('reading an unknown binding leaves an existing reference unchanged', async ({ bench }) => {
    const b = bench()
    await feedList(b, [{ id: 's1' }])
    using reference = b.svc.retain(sid('s1'), { source: 'controllerOperation' })
    await reference.ready
    expect(b.svc.binding(sid('ghost'))).toBeUndefined()
    expect(b.svc.binding(sid('s1'))).toBe(reference.binding)
  })
})
