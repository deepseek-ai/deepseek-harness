/** The Host's last known state of every change request that a listed Session binds. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import type { ChangeRequestListener, ChangeRequestRef, ChangeRequestSnapshot } from '@deepseek-ai/dsh-experimental-forge/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ChangeRequestStates, storedKey, type ChangeRequestStateSources, type ListedSession, type StoredStates } from '../src/states.ts'
import type { ForgeChangeRequestListState, ForgeChangeRequestStatesFrame } from '../src/types.ts'
import { demo, pullUrl, snapshot as openSnapshot } from './harness.ts'

const S1 = SessionId('s1')
const S2 = SessionId('s2')

const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const url = pullUrl

function ref(number: number): ChangeRequestRef {
  return { repository: demo, number }
}

function snapshot(number: number, overrides: Partial<ChangeRequestSnapshot>): ChangeRequestSnapshot {
  return { ...openSnapshot(ref(number)), ...overrides }
}

/** The listed state of `snapshot(number)` with its overrides. */
function state(number: number, overrides: Partial<ForgeChangeRequestListState> = {}): ForgeChangeRequestListState {
  return {
    url: url(number),
    number,
    title: `Change ${number}`,
    state: 'open',
    draft: false,
    checksRollup: 'success',
    reviewDecision: 'none',
    mergeability: 'mergeable',
    ...overrides,
  }
}

/** Sources over fixed listed Sessions, stored states, and polls the test drives. */
function fixture(sessions: readonly ListedSession[], stored: readonly ForgeChangeRequestListState[] = []) {
  const watchers = new Map<number, ChangeRequestListener>()
  const listeners = new Set<(id: SessionId, urls: readonly string[]) => void>()
  const records = new Map(stored.map(value => [storedKey(value.url), value]))
  const put = vi.fn<StoredStates['put']>(async (key, value) => { records.set(key, value) })
  const remove = vi.fn<StoredStates['delete']>(async key => records.delete(key))
  const table: StoredStates = { get: key => records.get(key), entries: () => records.entries(), put, delete: remove }
  const sources = {
    sessions: vi.fn<ChangeRequestStateSources['sessions']>(async () => sessions),
    onBindings: vi.fn<ChangeRequestStateSources['onBindings']>((listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }),
    refOf: (value: string): ChangeRequestRef | undefined => {
      const match = /^https:\/\/fake\.test\/octo\/demo\/pull\/(\d+)$/.exec(value)
      return match === null ? undefined : ref(Number(match[1]))
    },
    watch: vi.fn<ChangeRequestStateSources['watch']>((target, listener) => {
      watchers.set(target.number, listener)
      return () => { watchers.delete(target.number) }
    }),
    open: vi.fn<ChangeRequestStateSources['open']>(async () => table),
    report: vi.fn<ChangeRequestStateSources['report']>(),
  }
  const hub = new ChangeRequestStates(sources)
  cleanups.push(() => hub.dispose())
  return {
    hub,
    sources,
    records,
    put,
    remove,
    watchers,
    listeners,
    poll(number: number, overrides: Partial<ChangeRequestSnapshot> = {}): void {
      watchers.get(number)?.({ key: changeRequestKey(ref(number)), fetchedAt: 1, snapshot: snapshot(number, overrides) })
    },
    fail(number: number): void {
      watchers.get(number)?.({ key: changeRequestKey(ref(number)), fetchedAt: 1, failure: { code: 'unavailable', message: 'down' } })
    },
    bind(id: SessionId, urls: readonly string[]): void {
      for (const listener of listeners) listener(id, urls)
    },
  }
}

/** One stream of the hub, read frame by frame. */
function reader(hub: ChangeRequestStates, allowed: (id: SessionId) => boolean = () => true) {
  const aborter = new AbortController()
  const iterator = hub.stream(allowed, aborter.signal)[Symbol.asyncIterator]()
  cleanups.push(() => { aborter.abort() })
  return {
    async next(): Promise<ForgeChangeRequestStatesFrame | undefined> {
      const result = await iterator.next()
      return result.done === true ? undefined : result.value
    },
    async close(): Promise<void> {
      aborter.abort()
      await iterator.return?.(undefined)
    },
  }
}

describe('ChangeRequestStates', () => {
  it('streams the stored state of every change request a listed Session binds, then the states its polls change', async () => {
    const f = fixture([{ id: S1, urls: [url(7)] }, { id: S2, urls: undefined }], [state(7, { checksRollup: 'pending' })])
    const r = reader(f.hub)

    expect(await r.next()).toEqual({ type: 'baseline', states: [state(7, { checksRollup: 'pending' })] })
    f.poll(7)
    expect(await r.next()).toEqual({ type: 'changed', states: [state(7)] })
    expect(f.records.get(storedKey(url(7)))).toEqual(state(7))
  })

  it('shares one watch per request and retains it for explicit refresh after merging or closing', async () => {
    const f = fixture([{ id: S1, urls: [url(7)] }, { id: S2, urls: [url(7), url(8)] }])
    const r = reader(f.hub)

    expect(await r.next()).toEqual({ type: 'baseline', states: [] })
    expect(f.sources.watch.mock.calls.map(([target]) => target.number)).toEqual([7, 8])
    f.poll(7, { state: 'merged', closedAt: '2026-10-20T00:00:00Z' })
    expect(await r.next()).toEqual({ type: 'changed', states: [state(7, { state: 'merged' })] })
    f.poll(8, { state: 'closed', closedAt: '2026-10-20T00:00:00Z' })
    expect(await r.next()).toEqual({ type: 'changed', states: [state(8, { state: 'closed' })] })
    expect([...f.watchers.keys()]).toEqual([7, 8])
  })

  it('watches stored merged and closed requests for fresh results', async () => {
    const f = fixture([{ id: S1, urls: [url(7), url(8)] }], [state(7, { state: 'merged' }), state(8, { state: 'closed' })])
    const r = reader(f.hub)

    expect(await r.next()).toEqual({ type: 'baseline', states: [state(7, { state: 'merged' }), state(8, { state: 'closed' })] })
    expect(f.sources.watch.mock.calls.map(([target]) => target.number)).toEqual([7, 8])
  })

  it('starts polling a change request when a Session binds it and stops once no Session binds it', async () => {
    const f = fixture([{ id: S1, urls: [] }])
    const r = reader(f.hub)
    expect(await r.next()).toEqual({ type: 'baseline', states: [] })

    f.bind(S1, [url(9)])
    expect([...f.watchers.keys()]).toEqual([9])
    f.poll(9, { draft: true })
    expect(await r.next()).toEqual({ type: 'changed', states: [state(9, { draft: true })] })
    f.bind(S1, [])
    expect([...f.watchers.keys()]).toEqual([])
  })

  it('sends a stream only the states of change requests that a Session it may read binds, including ones bound later', async () => {
    const f = fixture([{ id: S1, urls: [url(7)] }, { id: S2, urls: [url(8)] }], [state(7), state(8)])
    const r = reader(f.hub, id => id === S1)

    expect(await r.next()).toEqual({ type: 'baseline', states: [state(7)] })
    f.poll(8, { checksRollup: 'failure' })
    f.poll(7, { checksRollup: 'pending' })
    expect(await r.next()).toEqual({ type: 'changed', states: [state(7, { checksRollup: 'pending' })] })
    f.bind(S1, [url(7), url(8)])
    expect(await r.next()).toEqual({ type: 'changed', states: [state(8, { checksRollup: 'failure' })] })
  })

  it('stores and sends nothing for failed polls and polls that change nothing', async () => {
    const f = fixture([{ id: S1, urls: [url(7)] }], [state(7)])
    const r = reader(f.hub)
    expect(await r.next()).toEqual({ type: 'baseline', states: [state(7)] })

    f.poll(7)
    f.fail(7)
    f.poll(7, { title: 'Renamed' })
    expect(await r.next()).toEqual({ type: 'changed', states: [state(7, { title: 'Renamed' })] })
    expect(f.put).toHaveBeenCalledOnce()
  })

  it('stops polling and listening once its last stream ends, and starts again for the next stream', async () => {
    const f = fixture([{ id: S1, urls: [url(7)] }])
    const first = reader(f.hub)
    const second = reader(f.hub)
    await first.next()
    await second.next()
    await first.close()
    expect([...f.watchers.keys()]).toEqual([7])

    await second.close()
    expect([...f.watchers.keys()]).toEqual([])
    expect(f.listeners.size).toBe(0)
    const third = reader(f.hub)
    expect(await third.next()).toEqual({ type: 'baseline', states: [] })
    expect(f.sources.sessions).toHaveBeenCalledTimes(2)
    expect([...f.watchers.keys()]).toEqual([7])
  })

  it('forgets stored states that no listed Session binds', async () => {
    const f = fixture([{ id: S1, urls: [url(7)] }], [state(7), state(9)])
    const r = reader(f.hub)

    expect(await r.next()).toEqual({ type: 'baseline', states: [state(7)] })
    expect(f.remove).toHaveBeenCalledExactlyOnceWith(storedKey(url(9)))
    expect([...f.records.values()]).toEqual([state(7)])
  })

  it('reports a failed write and still sends the polled state', async () => {
    const f = fixture([{ id: S1, urls: [url(7)] }])
    const failure = new Error('disk full')
    f.put.mockRejectedValueOnce(failure)
    const r = reader(f.hub)
    await r.next()

    f.poll(7)
    expect(await r.next()).toEqual({ type: 'changed', states: [state(7)] })
    await vi.waitFor(() => { expect(f.sources.report).toHaveBeenCalledWith(failure) })
  })

  it('polls nothing for a URL no provider recognizes', async () => {
    const f = fixture([{ id: S1, urls: ['https://gitlab.example/group/app/-/merge_requests/3'] }])
    const r = reader(f.hub)

    expect(await r.next()).toEqual({ type: 'baseline', states: [] })
    expect(f.sources.watch).not.toHaveBeenCalled()
  })

  it('reports a failed removal of a stored state that no listed Session binds', async () => {
    const f = fixture([{ id: S1, urls: [] }], [state(9)])
    const failure = new Error('read-only')
    f.remove.mockRejectedValueOnce(failure)
    const r = reader(f.hub)

    expect(await r.next()).toEqual({ type: 'baseline', states: [] })
    await vi.waitFor(() => { expect(f.sources.report).toHaveBeenCalledWith(failure) })
  })

  it('fails the streams of a run that cannot start, and starts a new run for the next stream', async () => {
    const f = fixture([{ id: S1, urls: [url(7)] }])
    f.sources.open.mockRejectedValueOnce(new Error('storage unavailable'))

    await expect(reader(f.hub).next()).rejects.toThrow('storage unavailable')
    expect(await reader(f.hub).next()).toEqual({ type: 'baseline', states: [] })
    expect([...f.watchers.keys()]).toEqual([7])
  })

  it('ends a stream whose run the hub stops while it starts, leaving nothing followed or polled', async () => {
    const f = fixture([])
    let list: (sessions: readonly ListedSession[]) => void = () => undefined
    f.sources.sessions.mockReturnValueOnce(new Promise((resolve) => { list = resolve }))
    const r = reader(f.hub)
    const first = r.next()
    await vi.waitFor(() => { expect(f.sources.sessions).toHaveBeenCalledOnce() })

    const disposing = f.hub.dispose()
    list([{ id: S1, urls: [url(7)] }])
    expect(await first).toBeUndefined()
    await disposing
    expect(f.listeners.size).toBe(0)
    expect([...f.watchers.keys()]).toEqual([])
  })

  it('ends every stream and stops polling when disposed', async () => {
    const f = fixture([{ id: S1, urls: [url(7)] }])
    const r = reader(f.hub)
    await r.next()

    await f.hub.dispose()
    expect(await r.next()).toBeUndefined()
    expect([...f.watchers.keys()]).toEqual([])
    expect(f.listeners.size).toBe(0)
  })

  it('ends a stream cancelled after its baseline and releases its watches', async () => {
    const f = fixture([{ id: S1, urls: [url(7)] }])
    const aborter = new AbortController()
    const stream = f.hub.stream(() => true, aborter.signal)[Symbol.asyncIterator]()
    await stream.next()
    aborter.abort()
    try {
      expect((await stream.next()).done).toBe(true)
      expect([...f.watchers.keys()]).toEqual([])
    } finally {
      await f.hub.dispose()
      await stream.return?.(undefined)
    }
  })

  it('drains an accepted write before disposal and refuses streams after disposal', async () => {
    const f = fixture([{ id: S1, urls: [url(7)] }])
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const order: string[] = []
    f.put.mockImplementationOnce(async (key, value) => {
      entered.resolve(undefined)
      await release.promise
      f.records.set(key, value)
      order.push('written')
    })
    const r = reader(f.hub)
    await r.next()
    f.poll(7)
    await entered.promise
    const disposing = f.hub.dispose().then(() => { order.push('disposed') })
    release.resolve(undefined)
    await disposing
    expect(order).toEqual(['written', 'disposed'])
    expect(f.records.get(storedKey(url(7)))).toEqual(state(7))
    expect(await reader(f.hub).next()).toBeUndefined()
    expect(f.sources.open).toHaveBeenCalledTimes(1)
  })

  it('replaces a cached closed state when its shared watch observes reopening', async () => {
    const f = fixture([{ id: S1, urls: [url(7)] }], [state(7, { state: 'closed' })])
    const r = reader(f.hub)
    expect(await r.next()).toEqual({ type: 'baseline', states: [state(7, { state: 'closed' })] })
    f.poll(7, { state: 'open', checksRollup: 'pending' })
    expect(await r.next()).toEqual({ type: 'changed', states: [state(7, { checksRollup: 'pending' })] })
    expect(f.records.get(storedKey(url(7)))?.state).toBe('open')
  })

  it('keeps binding updates during listing ahead of the initial snapshot', async () => {
    const f = fixture([{ id: S1, urls: [url(8)] }])
    const captured = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    f.sources.sessions.mockImplementationOnce(async () => {
      captured.resolve(undefined)
      await release.promise
      return [{ id: S1, urls: [url(8)] }]
    })
    const r = reader(f.hub)
    const first = r.next()
    await captured.promise
    f.bind(S1, [url(7)])
    f.bind(S2, [url(9)])
    release.resolve(undefined)
    await first
    expect([...f.watchers.keys()]).toEqual([7, 9])
  })

  it('retains stored states while an uncached Session may still bind them', async () => {
    const f = fixture([{ id: S1, urls: undefined }], [state(7)])
    await reader(f.hub).next()
    expect(f.remove).not.toHaveBeenCalled()
    f.bind(S1, [url(7)])
    expect([...f.watchers.keys()]).toEqual([7])
  })

  it('releases the binding listener after listing fails', async () => {
    const f = fixture([])
    f.sources.sessions.mockRejectedValueOnce(new Error('list unavailable'))
    await expect(reader(f.hub).next()).rejects.toThrow('list unavailable')
    expect(f.listeners.size).toBe(0)
    expect(await reader(f.hub).next()).toEqual({ type: 'baseline', states: [] })
  })


  it('keeps other readers live when a reader aborts between frames', async () => {
    const f = fixture([{ id: S1, urls: [url(7)] }])
    const aborter = new AbortController()
    const first = f.hub.stream(() => true, aborter.signal)[Symbol.asyncIterator]()
    const second = reader(f.hub)
    await first.next()
    await second.next()
    aborter.abort()
    f.poll(7)
    expect((await first.next()).done).toBe(true)
    expect(await second.next()).toEqual({ type: 'changed', states: [state(7)] })
    expect([...f.watchers.keys()]).toEqual([7])
    await second.close()
    expect([...f.watchers.keys()]).toEqual([])
  })

})
