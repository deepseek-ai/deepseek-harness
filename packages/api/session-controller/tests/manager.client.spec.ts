/**
 * SessionManager orchestration: lazy resident instances, list lifecycle, host
 * frame routing, and control baselines for uninstantiated sessions.
 */

import { describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionControlFrame } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-session-title/client'
import { SessionManager } from '../src/client/sessions/manager.ts'
import { FakeApiClient, deferred, err, fakeRemote, ok } from './fake-api.client.ts'
import { entries, plainTurn } from './event-script.client.ts'

const S1 = 'fk-m1' as SessionId
const S2 = 'fk-m2' as SessionId

type SummaryOver = Partial<{
  updatedAt: number
  running: boolean
  blank: boolean
  cwd: string
  parentSessionId: SessionId
  origin: 'subagent'
}>

function summary(sessionId: SessionId, over: SummaryOver = {}) {
  return { sessionId, updatedAt: 100, running: false, blank: false, ...over }
}

function makeManager(): SessionManager {
  const api = new FakeApiClient()
  return new SessionManager(fakeRemote(api))
}

describe('SessionManager instances', () => {
  it('lazily builds one resident instance per id and syncs the running bit from the list', async () => {
    const api = new FakeApiClient()
    api.onList = () => Promise.resolve(ok({ items: [summary(S1, { running: true })] as never[] }))
    const manager = new SessionManager(fakeRemote(api))
    await manager.refreshList()
    const session = manager.get(S1)
    expect(manager.get(S1)).toBe(session) // resident: same instance forever
    expect(session.getSnapshot().running).toBe(true) // list preceded instantiation
  })

})

describe('list lifecycle', () => {
  it('single-flights refreshList and preserves the Host baseline order', async () => {
    const api = new FakeApiClient()
    const gate = deferred<Awaited<ReturnType<FakeApiClient['onList']>>>()
    api.onList = () => gate.promise
    const manager = new SessionManager(fakeRemote(api))
    const first = manager.refreshList()
    const second = manager.refreshList()
    expect(manager.getListSnapshot().state).toBe('loading')
    gate.resolve(ok({ items: [summary(S2, { updatedAt: 200 }), summary(S1)] as never[] }))
    await Promise.all([first, second])
    expect(api.callsOf('session.list')).toHaveLength(1)
    const snapshot = manager.getListSnapshot()
    expect(snapshot.state).toBe('idle')
    expect(snapshot.items.map(i => i.sessionId)).toEqual([S2, S1])
  })

  it('replays incremental frames over hydration and never batch-reorders established ids', async () => {
    const api = new FakeApiClient()
    const first = deferred<Awaited<ReturnType<FakeApiClient['onList']>>>()
    api.onList = () => first.promise
    const manager = new SessionManager(fakeRemote(api))
    const hydration = manager.refreshList()
    manager.handleSessionAdded(summary(S2, { blank: true }))
    first.resolve(ok({ items: [summary(S1)] as never[] }))
    await hydration
    expect(manager.getListSnapshot().items.map(item => item.sessionId)).toEqual([S2, S1])

    api.onList = () => Promise.resolve(ok({
      items: [summary(S1, { updatedAt: 900 }), summary(S2, { updatedAt: 800 })] as never[],
    }))
    await manager.refreshList()
    expect(manager.getListSnapshot().items.map(item => item.sessionId)).toEqual([S2, S1])
  })

  it('advances list activity from the filtered Host notification', async () => {
    const api = new FakeApiClient()
    api.onList = () => Promise.resolve(ok({ items: [summary(S1)] as never[] }))
    const manager = new SessionManager(fakeRemote(api))
    await manager.refreshList()

    manager.handleSessionActivity(S1, 500)
    expect(manager.getListSnapshot().items[0]?.updatedAt).toBe(500)
  })

  it('keeps the error in the list snapshot on failure', async () => {
    const api = new FakeApiClient()
    api.onList = () => Promise.resolve(err(new RemoteError('gateway/internal', 'boom', {})))
    const manager = new SessionManager(fakeRemote(api))
    await manager.refreshList()
    expect(manager.getListSnapshot()).toMatchObject({ state: 'error', error: { code: 'gateway/internal' } })
    // A failed pull does not step the arrival phase: still pending.
    expect(manager.getListSnapshot().phase).toBe('pending')
  })

  it('phase steps pending → ready on the first successful pull and never returns', async () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(fakeRemote(api))
    expect(manager.getListSnapshot().phase).toBe('pending')
    await manager.refreshList()
    expect(manager.getListSnapshot().phase).toBe('ready')
    // Sticky across later failures: the pull-activity axis reports the error,
    // the arrival phase holds.
    api.onList = () => Promise.resolve(err(new RemoteError('gateway/internal', 'down', {})))
    await manager.refreshList()
    expect(manager.getListSnapshot()).toMatchObject({ state: 'error', phase: 'ready' })
    // And across an empty re-pull (empty-with-ready = truly no sessions).
    api.onList = () => Promise.resolve(ok({ items: [] as never[] }))
    await manager.refreshList()
    expect(manager.getListSnapshot()).toMatchObject({ state: 'idle', phase: 'ready' })
    expect(manager.getListSnapshot().items).toEqual([])
  })

  it('merges create into the list immediately without waiting for a refresh', async () => {
    const api = new FakeApiClient()
    api.onCreate = () => Promise.resolve(ok({ sessionId: S2 }))
    const manager = new SessionManager(fakeRemote(api))
    const result = await manager.create()
    expect(result).toMatchObject({ ok: true, value: { sessionId: S2 } })
    expect(manager.getListSnapshot().items.map(i => i.sessionId)).toEqual([S2])
  })

  it('retains title projections before list arrival, keeps last-wins by seq, and clears them on removal', async () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(fakeRemote(api))
    const titleFrame = (title: string, seq: number) => {
      manager.handleControlFrame({ type: 'projection', sessionId: S1, key: 'title', value: title, seq })
    }
    titleFrame('Newest', 4)
    titleFrame('Stale', 3)
    titleFrame('Equal', 4)
    api.onList = () => Promise.resolve(ok({
      items: [summary(S1), summary(S2, { updatedAt: 200 })] as never[],
    }))
    await manager.refreshList()

    const titled = manager.getListSnapshot()
    expect(titled.items.map(item => item.sessionId)).toEqual([S1, S2])
    expect(titled.items[0]?.title).toBe('Newest')
    expect(titled.items[1]?.title).toBeUndefined()

    manager.handleSessionRemoved(S1)
    manager.handleSessionAdded(summary(S1, { blank: true }))
    expect(manager.getListSnapshot().items.find(item => item.sessionId === S1)?.title).toBeUndefined()
  })

  it('seeds cold titles from the list rows\' projections block under higher-seq-wins', async () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(fakeRemote(api))
    // A push frame landed before the list (S2's title is newer than the block's cut).
    manager.handleControlFrame({
      type: 'projection', sessionId: S2, key: 'title', value: 'Pushed', seq: 9,
    })
    api.onList = () => Promise.resolve(ok({
      items: [
        { ...summary(S1), projections: { asOfSeq: 4, values: { title: 'Cold cached' } } },
        { ...summary(S2, { updatedAt: 200 }), projections: { asOfSeq: 5, values: { title: 'List stale' } } },
      ] as never[],
    }))
    await manager.refreshList()
    const items = manager.getListSnapshot().items
    // Cold row: title surfaces straight from the list block — no open, no history.
    expect(items.find(item => item.sessionId === S1)?.title).toBe('Cold cached')
    // The stale list block (seq 5) cannot overwrite the newer push frame (seq 9).
    expect(items.find(item => item.sessionId === S2)?.title).toBe('Pushed')
  })

  it('drops a projection row beyond the subscription baseline before accepting its durable replay', async () => {
    const api = new FakeApiClient()
    api.onList = () => Promise.resolve(ok({ items: [summary(S1)] as never[] }))
    const manager = new SessionManager(fakeRemote(api))
    await manager.refreshList()
    const frame = (payload: SessionControlFrame) => { manager.handleControlFrame(payload) }
    frame({ type: 'projection', sessionId: S1, key: 'title', value: 'Unflushed', seq: 4 })

    // The durable baseline says the host only knows up to seq 2: the phantom
    // row rode lost state and must drop, or last-wins pins it forever.
    frame({
      type: 'baseline',
      value: {
        queues: {}, jobs: {},
        projections: { [S1]: { asOfSeq: 2, values: {} } },
      },
    })
    expect(manager.getListSnapshot().items[0]?.title).toBeUndefined()

    frame({ type: 'projection', sessionId: S1, key: 'title', value: 'Durable', seq: 2 })
    expect(manager.getListSnapshot().items[0]?.title).toBe('Durable')

    // A baseline at or past the row's seq keeps it (nothing phantom to drop).
    frame({
      type: 'baseline',
      value: {
        queues: {}, jobs: {},
        projections: { [S1]: { asOfSeq: 2, values: { title: 'Durable' } } },
      },
    })
    expect(manager.getListSnapshot().items[0]?.title).toBe('Durable')
  })
})

describe('search', () => {
  it('returns bounded Host results and forwards the caller signal', async () => {
    const api = new FakeApiClient()
    api.onSearch = () => Promise.resolve(ok({
      items: [{ sessionId: S1, snippet: 'matching excerpt' }],
      hasMore: true,
    }))
    const manager = new SessionManager(fakeRemote(api))
    const signal = new AbortController().signal

    await expect(manager.search('exact phrase', signal)).resolves.toEqual({
      ok: true,
      value: {
        items: [{ sessionId: S1, snippet: 'matching excerpt' }],
        hasMore: true,
      },
    })
    expect(api.callsOf('session.search')).toEqual([{ query: 'exact phrase' }])
    expect(api.lastSearchSignal).toBe(signal)
  })

  it('preserves business errors and propagates a non-Remote throw', async () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(fakeRemote(api))
    api.onSearch = () => Promise.resolve(err(new RemoteError('gateway/internal', 'index unavailable', {})))
    const signal = new AbortController().signal
    await expect(manager.search('first', signal)).resolves.toMatchObject({
      ok: false,
      error: { code: 'gateway/internal', message: 'index unavailable' },
    })

    api.onSearch = () => Promise.reject(new Error('wire down'))
    await expect(manager.search('second', signal)).rejects.toThrow('wire down')
  })
})

describe('Host Remote event routing', () => {
  it('adds/removes/flips sessions and keeps removed instances resident', async () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(fakeRemote(api))
    manager.handleSessionAdded(summary(S1, { blank: true }))
    manager.handleSessionAdded(summary(S1, { blank: true })) // dup: ignored
    expect(manager.getListSnapshot().items).toHaveLength(1)

    const session = manager.get(S1)
    manager.handleSessionStatus(S1, true)
    expect(session.getSnapshot().running).toBe(true)
    expect(manager.getListSnapshot().items[0]?.running).toBe(true)

    manager.handleSessionError(S1, '炸了')
    expect(session.getSnapshot().lastAgentError).toBe('炸了')

    manager.handleSessionRemoved(S1)
    expect(manager.getListSnapshot().items).toHaveLength(0)
    expect(session.getSnapshot().removed).toBe(true)
    expect(manager.get(S1)).toBe(session) // resident-instance rule survives removal
  })
})

describe('subagent catalogs', () => {
  it('keeps a catalog-discovered child address across ordinary selection and status frames', async () => {
    const api = new FakeApiClient()
    api.onList = () => Promise.resolve(ok({ items: [
      summary(S1),
      summary(S2, { parentSessionId: S1, origin: 'subagent' }),
    ] as never[] }))
    api.onSubagentList = () => Promise.resolve(ok({
      entries: [{
        kind: 'child', id: S2, mode: 'continuable', label: 'worker',
        activity: 'running', hasChildren: false,
      }] as never[],
      parentAvailable: true,
    }))
    const manager = new SessionManager(fakeRemote(api))
    await manager.refreshList()
    await manager.refreshSubagents(S1)
    manager.selectSubagent({ parentSessionId: S1, childSessionId: S2, mode: 'continuable' })

    expect(manager.getListSnapshot().currentAddress).toEqual({
      parentSessionId: S1, childSessionId: S2, mode: 'continuable',
    })
    expect(manager.get(S2).getSnapshot().subagent).toEqual({
      address: { parentSessionId: S1, childSessionId: S2, mode: 'continuable' },
      parentAvailable: true,
    })
    // Clicking the same child through an ordinary list-selection path must not
    // erase the catalog-derived address and fall back to session.* transport.
    manager.select(S2)
    expect(manager.getListSnapshot().currentAddress).toEqual({
      parentSessionId: S1, childSessionId: S2, mode: 'continuable',
    })
    expect(manager.get(S2).getSnapshot().subagent).toEqual({
      address: { parentSessionId: S1, childSessionId: S2, mode: 'continuable' },
      parentAvailable: true,
    })
    await manager.get(S2).open()
    await manager.get(S2).prompt([{ type: 'text', text: 'continue' }], 'queue')
    expect(api.callsOf('session.follow')).toEqual([
      {
        address: {
          kind: 'subagent', parentSessionId: S1, childSessionId: S2, mode: 'continuable',
        },
        assistantStream: true,
        maxMessages: 50,
      },
    ])
    expect(api.callsOf('subagent.history')).toEqual([])
    expect(api.callsOf('subagents.prompt')).toEqual([
      {
        requestId: expect.any(String) as unknown as string,
        parentSessionId: S1, childSessionId: S2,
        mode: 'continuable',
        delivery: 'queue',
        content: [{ type: 'text', text: 'continue' }],
        clientTimeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
    ])
    expect(api.callsOf('session.history')).toEqual([])
    expect(api.callsOf('session.prompt')).toEqual([])
    const listCalls = api.callsOf('subagents.list').length
    manager.handleSessionStatus(S2, false)
    expect(manager.getListSnapshot().subagentsByParent[S1]?.entries[0]).toMatchObject({
      kind: 'child', id: S2, activity: 'inactive',
    })
    expect(api.callsOf('subagents.list')).toHaveLength(listCalls)

    manager.handleSessionRemoved(S2)
    expect(manager.getListSnapshot().items.find(item => item.sessionId === S2)).toMatchObject({
      origin: 'subagent', parentSessionId: S1, running: false,
    })
    expect(manager.get(S2).getSnapshot()).toMatchObject({
      removed: false,
      subagent: {
        address: { parentSessionId: S1, childSessionId: S2, mode: 'continuable' },
      },
    })
  })

  it('refetches debounced membership only while the parent catalog is open', async () => {
    vi.useFakeTimers()
    try {
      const api = new FakeApiClient()
      const manager = new SessionManager(fakeRemote(api))
      await manager.refreshSubagents(S1)
      manager.setSubagentCatalogOpen(S1, true)
      await Promise.resolve()
      const baseline = api.callsOf('subagents.list').length
      manager.handleSessionAdded(summary(S2, { parentSessionId: S1 }))
      manager.handleSessionAdded(summary('fk-m3' as SessionId, { parentSessionId: S1 }))
      await vi.advanceTimersByTimeAsync(50)
      expect(api.callsOf('subagents.list')).toHaveLength(baseline + 1)

      manager.setSubagentCatalogOpen(S1, false)
      manager.handleSessionAdded(summary('fk-m4' as SessionId, { parentSessionId: S1 }))
      await vi.advanceTimersByTimeAsync(50)
      expect(api.callsOf('subagents.list')).toHaveLength(baseline + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('marks a loaded parent row expandable only for a direct subagent publication', async () => {
    const api = new FakeApiClient()
    const root = 'fk-root' as SessionId
    api.onSubagentList = () => Promise.resolve(ok({
      entries: [
        {
          kind: 'child', id: S1, mode: 'continuable', label: 'parent',
          activity: 'inactive', hasChildren: false,
        },
        {
          kind: 'child', id: S2, mode: 'continuable', label: 'ordinary parent',
          activity: 'inactive', hasChildren: false,
        },
      ] as never[],
      parentAvailable: true,
    }))
    const manager = new SessionManager(fakeRemote(api))
    await manager.refreshSubagents(root)

    manager.handleSessionAdded(summary('fk-grandchild' as SessionId, {
      parentSessionId: S1, origin: 'subagent',
    }))
    manager.handleSessionAdded(summary('fk-fork' as SessionId, { parentSessionId: S2 }))

    expect(manager.getListSnapshot().subagentsByParent[root]?.entries).toMatchObject([
      { kind: 'child', id: S1, hasChildren: true },
      { kind: 'child', id: S2, hasChildren: false },
    ])
  })

  it('preserves a live expandability hint across only the older in-flight catalog response', async () => {
    const api = new FakeApiClient()
    const root = 'fk-root' as SessionId
    const response = deferred<Awaited<ReturnType<FakeApiClient['onSubagentList']>>>()
    api.onSubagentList = () => response.promise
    const manager = new SessionManager(fakeRemote(api))
    const refresh = manager.refreshSubagents(root)

    manager.handleSessionAdded(summary('fk-grandchild' as SessionId, {
      parentSessionId: S1, origin: 'subagent',
    }))
    response.resolve(ok({
      entries: [{
        kind: 'child', id: S1, mode: 'continuable', label: 'parent',
        activity: 'inactive', hasChildren: false,
      }] as never[],
      parentAvailable: true,
    }))
    await refresh

    expect(manager.getListSnapshot().subagentsByParent[root]?.entries).toMatchObject([
      { kind: 'child', id: S1, hasChildren: true },
    ])

    api.onSubagentList = () => Promise.resolve(ok({
      entries: [{
        kind: 'child', id: S1, mode: 'continuable', label: 'parent',
        activity: 'inactive', hasChildren: false,
      }] as never[],
      parentAvailable: true,
    }))
    await manager.refreshSubagents(root)
    expect(manager.getListSnapshot().subagentsByParent[root]?.entries).toMatchObject([
      { kind: 'child', id: S1, hasChildren: false },
    ])
  })

  it('replays status frames over an older in-flight catalog response', async () => {
    const api = new FakeApiClient()
    const root = 'fk-root' as SessionId
    const response = deferred<Awaited<ReturnType<FakeApiClient['onSubagentList']>>>()
    api.onSubagentList = () => response.promise
    const manager = new SessionManager(fakeRemote(api))
    const refresh = manager.refreshSubagents(root)

    manager.handleSessionStatus(S1, false)
    manager.handleSessionStatus(S2, true)
    response.resolve(ok({
      entries: [
        {
          kind: 'child', id: S1, mode: 'continuable', label: 'stopped',
          activity: 'running', hasChildren: false,
        },
        {
          kind: 'child', id: S2, mode: 'continuable', label: 'started',
          activity: 'inactive', hasChildren: false,
        },
      ] as never[],
      parentAvailable: true,
    }))
    await refresh

    expect(manager.getListSnapshot().subagentsByParent[root]?.entries).toMatchObject([
      { kind: 'child', id: S1, activity: 'inactive' },
      { kind: 'child', id: S2, activity: 'running' },
    ])
  })

  it('marks a detached catalog child inactive without requiring a selected address', async () => {
    const api = new FakeApiClient()
    api.onSubagentList = () => Promise.resolve(ok({
      entries: [{
        kind: 'child', id: S2, mode: 'continuable', label: 'worker',
        activity: 'running', hasChildren: false,
      }] as never[],
      parentAvailable: true,
    }))
    const manager = new SessionManager(fakeRemote(api))
    await manager.refreshSubagents(S1)

    manager.handleSessionRemoved(S2)

    expect(manager.getListSnapshot().subagentsByParent[S1]?.entries).toMatchObject([
      { kind: 'child', id: S2, activity: 'inactive' },
    ])
  })

  it('coalesces overlapping catalog reads without scheduling a trailing pull', async () => {
    const api = new FakeApiClient()
    const root = 'fk-root' as SessionId
    const first = deferred<Awaited<ReturnType<FakeApiClient['onSubagentList']>>>()
    api.onSubagentList = () => first.promise
    const manager = new SessionManager(fakeRemote(api))

    const refresh = manager.refreshSubagents(root)
    expect(manager.refreshSubagents(root)).toBe(refresh)
    api.onSubagentList = () => Promise.resolve(ok({ entries: [], parentAvailable: true }))
    first.resolve(ok({ entries: [], parentAvailable: true }))
    await refresh

    expect(api.callsOf('subagents.list')).toHaveLength(1)
  })

  it('runs one trailing catalog refresh for a membership change coalesced into an in-flight pull', async () => {
    vi.useFakeTimers()
    try {
      const api = new FakeApiClient()
      const root = 'fk-root' as SessionId
      const first = deferred<Awaited<ReturnType<FakeApiClient['onSubagentList']>>>()
      const second = deferred<Awaited<ReturnType<FakeApiClient['onSubagentList']>>>()
      api.onSubagentList = () => first.promise
      const manager = new SessionManager(fakeRemote(api), root)
      const refresh = manager.refreshSubagents(root)
      manager.setSubagentCatalogOpen(root, true)

      // A membership frame arrives while the pull is in flight; the debounced
      // refresh it schedules fires 50ms later and is coalesced into the pull —
      // which was requested before the new child existed. The stale mark must
      // queue one trailing pull carrying the change.
      manager.handleSessionAdded(summary(S2, { parentSessionId: root }))
      await vi.advanceTimersByTimeAsync(50)
      api.onSubagentList = () => second.promise
      first.resolve(ok({
        entries: [{
          kind: 'child', id: S1, mode: 'continuable', label: 'older',
          activity: 'inactive', hasChildren: false,
        }] as never[],
        parentAvailable: true,
      }))
      await refresh
      // The trailing pull is already in flight (kicked synchronously in finally).
      second.resolve(ok({
        entries: [
          {
            kind: 'child', id: S1, mode: 'continuable', label: 'older',
            activity: 'inactive', hasChildren: false,
          },
          {
            kind: 'child', id: S2, mode: 'continuable', label: 'new child',
            activity: 'inactive', hasChildren: false,
          },
        ] as never[],
        parentAvailable: true,
      }))
      await second.promise
      // The Remote face resolves one microtask after the response settles.
      await vi.advanceTimersByTimeAsync(0)

      expect(api.callsOf('subagents.list')).toHaveLength(2)
      expect(manager.getListSnapshot().subagentsByParent[root]?.entries).toMatchObject([
        { kind: 'child', id: S1, label: 'older' },
        { kind: 'child', id: S2, label: 'new child' },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps removal invalidation across a stale success and failed trailing pull', async () => {
    const api = new FakeApiClient()
    const root = 'fk-root' as SessionId
    const child = () => ({
      kind: 'child' as const, id: S2, mode: 'continuable' as const, label: 'worker',
      activity: 'inactive' as const, hasChildren: false,
    })
    const first = deferred<Awaited<ReturnType<FakeApiClient['onSubagentList']>>>()
    api.onSubagentList = () => first.promise
    const manager = new SessionManager(fakeRemote(api))
    const refresh = manager.refreshSubagents(root)
    first.resolve(ok({ entries: [child()] as never[], parentAvailable: true }))
    await refresh
    manager.selectSubagent({ parentSessionId: root, childSessionId: S2, mode: 'continuable' })

    // The removal lands while a second pull is in flight: the invalidation
    // must survive the pre-removal ok response, so one trailing pull runs.
    const mid = deferred<Awaited<ReturnType<FakeApiClient['onSubagentList']>>>()
    api.onSubagentList = () => mid.promise
    const midRefresh = manager.refreshSubagents(root)
    manager.handleSessionRemoved(root)
    const trailing = deferred<Awaited<ReturnType<FakeApiClient['onSubagentList']>>>()
    api.onSubagentList = () => trailing.promise
    mid.resolve(ok({ entries: [child()] as never[], parentAvailable: true }))
    await midRefresh
    expect(manager.getListSnapshot().subagentsByParent[root]?.parentAvailable).toBe(false)
    expect(manager.get(S2).getSnapshot().subagent).toMatchObject({ parentAvailable: false })

    trailing.resolve(err(new RemoteError('gateway/internal', 'trailing pull failed', {})))
    await vi.waitFor(() => {
      expect(manager.getListSnapshot().subagentsByParent[root]).toMatchObject({
        state: 'error',
        parentAvailable: false,
      })
    })

    const rootCalls = api.callsOf('subagents.list').filter(call => call === root)
    expect(rootCalls).toHaveLength(3)
    expect(manager.getListSnapshot().subagentsByParent[root]?.parentAvailable).toBe(false)
    expect(manager.get(S2).getSnapshot().subagent).toMatchObject({ parentAvailable: false })
  })

  it('invalidates catalog availability when the owning parent is removed', async () => {
    const api = new FakeApiClient()
    const root = 'fk-root' as SessionId
    api.onSubagentList = () => Promise.resolve(ok({
      entries: [{
        kind: 'child', id: S2, mode: 'continuable', label: 'worker',
        activity: 'inactive', hasChildren: false,
      }] as never[],
      parentAvailable: true,
    }))
    const manager = new SessionManager(fakeRemote(api))
    await manager.refreshSubagents(root)
    manager.selectSubagent({ parentSessionId: root, childSessionId: S2, mode: 'continuable' })
    expect(manager.get(S2).getSnapshot().subagent).toMatchObject({ parentAvailable: true })

    manager.handleSessionRemoved(root)

    expect(manager.getListSnapshot().subagentsByParent[root]?.parentAvailable).toBe(false)
    expect(manager.get(S2).getSnapshot().subagent).toMatchObject({ parentAvailable: false })
  })
})

describe('remaining branches', () => {
  it('refreshList propagates a non-Remote throw', async () => {
    const api = new FakeApiClient()
    api.onList = () => Promise.reject(new Error('list wire down'))
    const manager = new SessionManager(fakeRemote(api))
    await expect(manager.refreshList()).rejects.toThrow('list wire down')
  })

  it('refreshList pushes running bits down to already-instantiated sessions', async () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(fakeRemote(api))
    const session = manager.get(S1)
    api.onList = () => Promise.resolve(ok({ items: [summary(S1, { running: true })] as never[] }))
    await manager.refreshList()
    expect(session.getSnapshot().running).toBe(true)
  })

  it('create passes cwd and a preallocated id, folds transport throws, and deduplicates the echo', async () => {
    const api = new FakeApiClient()
    api.onCreate = () => Promise.resolve(ok({ sessionId: S1 }))
    const manager = new SessionManager(fakeRemote(api))
    await manager.create({ cwd: '/tmp/w', sessionId: S1 })
    expect(api.callsOf('session.create')).toEqual([{ cwd: '/tmp/w', sessionId: S1 }])
    expect(manager.getListSnapshot().items[0]).toMatchObject({ sessionId: S1, cwd: '/tmp/w' })
    await manager.create({ cwd: '/tmp/w' }) // same id returned: no duplicate row
    expect(manager.getListSnapshot().items).toHaveLength(1)
    api.onCreate = () => Promise.reject(new Error('create wire down'))
    await expect(manager.create()).rejects.toThrow('create wire down')
    // Business error passes through untouched.
    api.onCreate = () => Promise.resolve(err(new RemoteError('gateway/internal', 'no', {})))
    expect(await manager.create()).toMatchObject({ ok: false })
  })

  it('publishes a real Ungrouped summary from workspace-attach-failed', async () => {
    const api = new FakeApiClient()
    api.onCreate = () => Promise.resolve(err(new RemoteError('session/workspace-attach-failed', 'published but unattached', {
      sessionId: S1, workspaceId: 'w1',
    })))
    const manager = new SessionManager(fakeRemote(api))
    const result = await manager.create({ workspaceId: 'w1' as never, sessionId: S1 })
    expect(result).toMatchObject({ ok: false, error: { code: 'session/workspace-attach-failed' } })
    expect(manager.getListSnapshot().items).toEqual([expect.objectContaining({ sessionId: S1 })])
    expect(manager.getListSnapshot().items[0]).not.toHaveProperty('cwd')
  })

  it('reconciles a fork child published before workspace attachment fails', async () => {
    const api = new FakeApiClient()
    api.onFork = () => Promise.resolve(err(new RemoteError('session/workspace-attach-failed', 'forked but unattached', {
      sessionId: S2, workspaceId: 'w1',
    })))
    const manager = new SessionManager(fakeRemote(api))
    const result = await manager.fork({ sessionId: S1 })
    expect(result).toMatchObject({ ok: false, error: { code: 'session/workspace-attach-failed' } })
    expect(manager.getListSnapshot().items).toEqual([expect.objectContaining({
      sessionId: S2,
      parentSessionId: S1,
      blank: false,
    })])
  })

  it('reconciles a preallocated id after an ordinary transport failure', async () => {
    const api = new FakeApiClient()
    api.onCreate = () => Promise.reject(new Error('response lost'))
    const manager = new SessionManager(fakeRemote(api))
    await expect(manager.create({ workspaceId: 'w1' as never, sessionId: S1 }))
      .rejects.toThrow('response lost')
    expect(manager.getListSnapshot().items).toEqual([])

    manager.handleSessionAdded(summary(S1, { blank: true, cwd: '/w/one' }))
    expect(manager.getListSnapshot().items).toEqual([
      expect.objectContaining({ sessionId: S1, cwd: '/w/one' }),
    ])
    manager.handleSessionAdded(summary(S1, { blank: true, cwd: '/w/one' }))
    expect(manager.getListSnapshot().items).toHaveLength(1)
  })

  it('subscribe notifies on list changes and stops after unsubscribe', async () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(fakeRemote(api))
    let notified = 0
    const unsubscribe = manager.subscribe(() => { notified++ })
    await manager.refreshList()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(notified).toBeGreaterThan(0)
    const seen = notified
    unsubscribe()
    manager.handleSessionAdded(summary(S1, { blank: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(notified).toBe(seen)
  })

  it('ignores Host status and error events for sessions without an instance', () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(fakeRemote(api))
    manager.handleSessionStatus(S2, true)
    manager.handleSessionError(S2, '无实例')
  })

  it('keeps list-entry identity for unchanged rows across an unrelated list change', async () => {
    const api = new FakeApiClient()
    api.onList = () => Promise.resolve(ok({ items: [summary(S1), summary(S2, { updatedAt: 200 })] as never[] }))
    const manager = new SessionManager(fakeRemote(api))
    await manager.refreshList()
    const before = manager.getListSnapshot()
    manager.handleSessionStatus(S2, true)
    const after = manager.getListSnapshot()
    expect(after.items).not.toBe(before.items)
    const beforeS1 = before.items.find(e => e.sessionId === S1)
    const afterS1 = after.items.find(e => e.sessionId === S1)
    expect(afterS1).toBe(beforeS1) // untouched entry keeps identity (entryCache)
    // Same-order same-entries snapshot reuses the items array.
    manager.handleSessionError(S1, 'x')
    expect(manager.getListSnapshot().items).toBe(after.items)
  })

  it('carries parentSessionId from the added event into the lineage row', () => {
    const api = new FakeApiClient()
    const manager = new SessionManager(fakeRemote(api))
    manager.handleSessionAdded(summary(S1, { blank: true }))
    manager.handleSessionAdded(summary(S2, {
      blank: true, parentSessionId: S1, origin: 'subagent',
    }))
    const items = manager.getListSnapshot().items
    expect(items.find(e => e.sessionId === S2)).toMatchObject({
      parentSessionId: S1, origin: 'subagent', depth: 1,
    })
  })
})

describe('connected generation', () => {
  it('refreshes query baselines without rebuilding independently resumed Session sources', async () => {
    const api = new FakeApiClient()
    api.onHistory = () => Promise.resolve(ok({
      records: entries(plainTurn(SessionSeq(0), 0, 'a', 'b')) as never[],
      hasMore: false,
      modelSelection: { provider: 'deepseek-official', model: 'deepseek-chat' },
    }))
    const manager = new SessionManager(fakeRemote(api))
    const openedSession = manager.get(S1)
    await openedSession.open()
    manager.get(S2) // instantiated but never opened
    const historyCallsBefore = api.callsOf('session.history').length
    manager.handleConnected()
    await vi.waitFor(() => {
      expect(api.callsOf('session.list').length).toBe(1)
    })
    expect(api.callsOf('session.history')).toHaveLength(historyCallsBefore)
  })

  it('retains the durable parent address and refreshes its catalogs across reconnect', async () => {
    const api = new FakeApiClient()
    const address = {
      parentSessionId: S1, childSessionId: S2, mode: 'continuable' as const,
    }
    const parent = deferred<Awaited<ReturnType<FakeApiClient['onSubagentList']>>>()
    const child = deferred<Awaited<ReturnType<FakeApiClient['onSubagentList']>>>()
    api.onSubagentList = payload => (payload === S1 ? parent.promise : child.promise)
    const manager = new SessionManager(fakeRemote(api), S2, address)

    manager.handleConnected()
    expect(manager.get(S2).getSnapshot().subagent).toEqual({ address })
    parent.resolve(ok({ entries: [], parentAvailable: true }))
    child.resolve(ok({ entries: [], parentAvailable: true }))

    await vi.waitFor(() => {
      expect(api.callsOf('session.list')).toHaveLength(1)
    })
    await vi.waitFor(() => {
      expect(api.callsOf('subagents.list')).toEqual([S1, S2])
    })
    expect(manager.get(S2).getSnapshot().subagent).toEqual({
      address,
      parentAvailable: true,
    })
    expect(manager.getListSnapshot().currentAddress).toEqual(address)
  })
})

describe('completed reminder', () => {
  const status = (manager: SessionManager, sessionId: SessionId, running: boolean): void => {
    manager.handleSessionStatus(sessionId, running)
  }
  const added = (manager: SessionManager, sessionId: SessionId): void => {
    manager.handleSessionAdded(summary(sessionId))
  }
  const entry = (manager: SessionManager, sessionId: SessionId) =>
    manager.getListSnapshot().items.find(item => item.sessionId === sessionId)

  it('arms on a running→idle flip of a non-selected session and clears on select', () => {
    const manager = makeManager()
    added(manager, S1)
    added(manager, S2)
    manager.select(S1)
    expect(entry(manager, S2)?.completed).toBe(false)
    status(manager, S2, true)
    status(manager, S2, false)
    expect(entry(manager, S2)?.completed).toBe(true)
    // Opening the session consumes the reminder.
    manager.select(S2)
    expect(entry(manager, S2)?.completed).toBe(false)
  })

  it('never arms for the session being watched and re-arms after a switch-away re-run', () => {
    const manager = makeManager()
    added(manager, S1)
    added(manager, S2)
    manager.select(S2)
    status(manager, S2, true)
    status(manager, S2, false)
    expect(entry(manager, S2)?.completed).toBe(false) // watched to completion: no reminder
    // Switch away; a fresh run completing again arms the reminder.
    manager.select(S1)
    status(manager, S2, true)
    status(manager, S2, false)
    expect(entry(manager, S2)?.completed).toBe(true)
  })

  it('a re-run disarms the reminder while running and re-arms on its completion', () => {
    const manager = makeManager()
    added(manager, S1)
    added(manager, S2)
    manager.select(S1)
    status(manager, S2, true)
    status(manager, S2, false)
    expect(entry(manager, S2)?.completed).toBe(true)
    // The user starts a new run without opening the session: running wins.
    status(manager, S2, true)
    expect(entry(manager, S2)?.completed).toBe(false)
    status(manager, S2, false)
    expect(entry(manager, S2)?.completed).toBe(true)
  })

  it('session-removed drops the reminder and a re-add starts clean', () => {
    const manager = makeManager()
    added(manager, S1)
    added(manager, S2)
    manager.select(S1)
    status(manager, S2, true)
    status(manager, S2, false)
    expect(entry(manager, S2)?.completed).toBe(true)
    manager.handleSessionRemoved(S2)
    expect(manager.getListSnapshot().items.find(item => item.sessionId === S2)).toBeUndefined()
    added(manager, S2)
    expect(entry(manager, S2)?.completed).toBe(false)
  })

  it('a list refresh carrying the running→idle transition arms the reminder', async () => {
    const api = new FakeApiClient()
    api.onList = () => Promise.resolve(ok({ items: [summary(S1), summary(S2, { updatedAt: 200, running: true })] as never[] }))
    const manager = new SessionManager(fakeRemote(api))
    await manager.refreshList()
    manager.select(S1)
    expect(entry(manager, S2)?.completed).toBe(false)
    api.onList = () => Promise.resolve(ok({ items: [summary(S1), summary(S2, { updatedAt: 200, running: false })] as never[] }))
    await manager.refreshList()
    expect(entry(manager, S2)?.completed).toBe(true)
  })

  it('never arms for sessions already idle at first observation', async () => {
    const api = new FakeApiClient()
    api.onList = () => Promise.resolve(ok({ items: [summary(S1), summary(S2, { updatedAt: 200 })] as never[] }))
    const manager = new SessionManager(fakeRemote(api))
    await manager.refreshList()
    manager.select(S1)
    expect(entry(manager, S2)?.completed).toBe(false)
    api.onList = () => Promise.resolve(ok({ items: [summary(S1), summary(S2, { updatedAt: 201 })] as never[] }))
    await manager.refreshList()
    expect(entry(manager, S2)?.completed).toBe(false)
  })

  it('arms a completion that happened during an in-flight first pull (baseline running, replayed idle)', async () => {
    const api = new FakeApiClient()
    const gate = deferred<Awaited<ReturnType<FakeApiClient['onList']>>>()
    api.onList = () => gate.promise
    const manager = new SessionManager(fakeRemote(api))
    const refresh = manager.refreshList()
    // The session finishes while the first pull is still in flight; the pull
    // response recorded it as running at pull time.
    status(manager, S2, false)
    gate.resolve(ok({ items: [summary(S1), summary(S2, { updatedAt: 200, running: true })] as never[] }))
    await refresh
    expect(entry(manager, S2)?.completed).toBe(true)
  })

  it('arms when a session ran and completed entirely between in-flight mutations (baseline idle)', async () => {
    const api = new FakeApiClient()
    const gate = deferred<Awaited<ReturnType<FakeApiClient['onList']>>>()
    api.onList = () => gate.promise
    const manager = new SessionManager(fakeRemote(api))
    const refresh = manager.refreshList()
    // The unknown session starts and finishes while the first pull is in
    // flight; the pull-time baseline recorded it idle, so the running→idle
    // edge lives entirely inside the replayed mutations.
    status(manager, S2, true)
    status(manager, S2, false)
    gate.resolve(ok({ items: [summary(S1), summary(S2, { updatedAt: 200 })] as never[] }))
    await refresh
    expect(entry(manager, S2)?.completed).toBe(true)
  })
})

describe('background-job mirror', () => {
  const view = (over: Partial<{ id: string; status: string; label: string }> = {}) => ({
    id: 'bash-1', kind: 'bash', label: 'pnpm run build', status: 'running', startedAt: 5, ...over,
  })
  const tasksFrame = (
    sessionId: SessionId,
    jobs: unknown[],
  ): Extract<SessionControlFrame, { type: 'jobs' }> => ({
    type: 'jobs', sessionId, jobs: jobs as never,
  })

  it('mirrors the whole set last-wins, keyed per session, with no Session instance needed', () => {
    const manager = makeManager()
    manager.handleControlFrame(tasksFrame(S1, [view()]))
    manager.handleControlFrame(tasksFrame(S2, [view({ id: 'pwsh-1', label: 'other' })]))
    const first = manager.getListSnapshot().jobsBySession
    expect(first[S1]).toEqual([view()])
    expect(first[S2]?.[0]?.label).toBe('other')

    // Last-wins: the newer whole set replaces, it does not merge.
    manager.handleControlFrame(tasksFrame(S1, [view({ status: 'completed' })]))
    expect(manager.getListSnapshot().jobsBySession[S1]).toEqual([view({ status: 'completed' })])
  })

  it('stores an emptied set as an absent key so absence and [] read alike', () => {
    const manager = makeManager()
    manager.handleControlFrame(tasksFrame(S1, [view()]))
    expect(S1 in manager.getListSnapshot().jobsBySession).toBe(true)
    manager.handleControlFrame(tasksFrame(S1, []))
    expect(S1 in manager.getListSnapshot().jobsBySession).toBe(false)
  })

  it('clears the mirror when the next control baseline has no jobs', () => {
    const manager = makeManager()
    manager.handleControlFrame(tasksFrame(S1, [view()]))
    manager.handleControlFrame({
      type: 'baseline',
      value: { queues: {}, jobs: {}, projections: {} },
    })
    expect(S1 in manager.getListSnapshot().jobsBySession).toBe(false)
  })

  it('drops the rows when the session is removed, whichever stream lands first', () => {
    const manager = makeManager()
    manager.handleSessionAdded(summary(S1, { blank: true }))
    manager.handleControlFrame(tasksFrame(S1, [view()]))
    manager.handleSessionRemoved(S1)
    expect(S1 in manager.getListSnapshot().jobsBySession).toBe(false)
  })

  it('notifies list subscribers so an open header re-renders without a poll', async () => {
    const manager = makeManager()
    const seen = vi.fn()
    manager.subscribe(seen)
    manager.handleControlFrame(tasksFrame(S1, [view()]))
    // The notifier batches on a microtask; the frame itself is already applied.
    await Promise.resolve()
    expect(seen).toHaveBeenCalled()
  })
})
