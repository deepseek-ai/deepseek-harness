/** `forgePanel.changeRequestStates` over the Host's Session list, projection cache, and storage. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { storedKey, type StoredStates } from '../src/states.ts'
import type { ForgeChangeRequestListState, ForgeChangeRequestStatesFrame } from '../src/types.ts'
import { bench, pullUrl, type Bench } from './harness.ts'

const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

/** The listed state of the fake provider's snapshot of `number`. */
function state(number: number): ForgeChangeRequestListState {
  return {
    url: pullUrl(number),
    number,
    title: `Change ${number}`,
    state: 'open',
    draft: false,
    checksRollup: 'success',
    reviewDecision: 'none',
    mergeability: 'mergeable',
  }
}

/** A panel Remote with one loaded Session, the Sessions the Host lists, their cached summaries, and stored states. */
async function composed(options: { readonly remoteAccess?: (id: SessionId) => boolean } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'forge-states-'))
  cleanups.push(() => rm(cwd, { recursive: true, force: true }))
  const b = await bench(cwd)
  cleanups.push(() => b.ctx.fiber.dispose())
  const cold: SessionHeader = { ...b.session.header, id: SessionId('cold') }
  const unseen: SessionHeader = { ...b.session.header, id: SessionId('unseen') }
  const records = new Map<string, ForgeChangeRequestListState>()
  const put = vi.fn<StoredStates['put']>(async (key, value) => { records.set(key, value) })
  const remove = vi.fn<StoredStates['delete']>(async key => records.delete(key))
  const table: StoredStates = { get: key => records.get(key), entries: () => records.entries(), put, delete: remove }
  provide(b.ctx, 'sessionQuery', { listSessions: async () => [{ header: b.session.header }, { header: cold }, { header: unseen }] })
  provide(b.ctx, 'sessionProjectionCache', {
    cachedSnapshot: (header: SessionHeader) => header.id === cold.id
      ? {
        asOfSeq: 3,
        values: {
          forgeChangeRequests: [
            { url: pullUrl(8), origin: 'tracked', dismissed: false },
            { url: pullUrl(10), origin: 'tracked', dismissed: true },
          ],
        },
      }
      : undefined,
  })
  provide(b.ctx, 'storageDomain', { open: async () => ({ table: () => table }) })
  if (options.remoteAccess !== undefined) {
    const allows = options.remoteAccess
    provide(b.ctx, 'remoteAccess', { allows: ({ id }: { readonly id: SessionId }) => allows(id) })
  }
  return { b, cold, records, put }
}

/** Register a fake Host service with only the members the panel reads. */
function provide(ctx: Context, name: string, value: object): void {
  ctx.provide(name, value)
}

/** Read frames of `changeRequestStates` until one satisfies `predicate`, keeping every frame read. */
function reader(b: Bench) {
  const aborter = new AbortController()
  const iterator = b.ctx.forgePanel.changeRequestStates(aborter.signal)[Symbol.asyncIterator]()
  const frames: ForgeChangeRequestStatesFrame[] = []
  cleanups.push(async () => {
    aborter.abort()
    await iterator.return?.(undefined)
  })
  return {
    frames,
    async until(
      predicate: (states: ReadonlyMap<string, ForgeChangeRequestListState>) => boolean,
    ): Promise<ReadonlyMap<string, ForgeChangeRequestListState>> {
      const seen = new Map<string, ForgeChangeRequestListState>()
      for (const frame of frames) for (const value of frame.states) seen.set(value.url, value)
      while (!predicate(seen)) {
        const result = await iterator.next()
        if (result.done === true) throw new Error('the stream ended')
        frames.push(result.value)
        for (const value of result.value.states) seen.set(value.url, value)
      }
      return seen
    },
  }
}

describe('forgePanel.changeRequestStates', () => {
  it('streams the states of the visible bindings of loaded and cached Sessions, then of later bindings', async () => {
    const { b, records } = await composed()
    b.ctx.forgeSession.track(b.session, pullUrl(7))
    const r = reader(b)

    const first = await r.until(states => states.has(pullUrl(7)) && states.has(pullUrl(8)))
    expect(r.frames[0]).toEqual({ type: 'baseline', states: [] })
    expect([...first.values()]).toEqual(expect.arrayContaining([state(7), state(8)]))
    expect(first.has(pullUrl(10))).toBe(false)
    // Other client-visible units of a loaded Session change without rebinding anything.
    b.session.append('working-directory/change', { cwd: `${b.session.header.cwd ?? ''}/sub` })
    b.ctx.forgeSession.track(b.session, pullUrl(9))
    expect((await r.until(states => states.has(pullUrl(9)))).get(pullUrl(9))).toEqual(state(9))
    expect(records.get(storedKey(pullUrl(9)))).toEqual(state(9))
    // A second stream shares the run and starts from the states the first one saw.
    expect(await reader(b).until(states => states.has(pullUrl(9)))).toEqual(await r.until(() => true))
    expect(b.provider.fetches.flat().filter(number => number === 9)).toHaveLength(1)
  })

  it('sends only the states of change requests that a Session the caller may read binds', async () => {
    const { b, cold } = await composed({ remoteAccess: id => id === cold.id })
    b.ctx.forgeSession.track(b.session, pullUrl(7))
    const r = reader(b)

    const states = await r.until(seen => seen.has(pullUrl(8)))
    b.ctx.forgeSession.track(b.session, pullUrl(9))
    await vi.waitFor(() => { expect(b.provider.fetches.flat()).toEqual(expect.arrayContaining([7, 8, 9])) })
    expect([...states.keys()]).toEqual([pullUrl(8)])
  })

  it('warns when storing a state fails and still sends it', async () => {
    const { b, put } = await composed()
    const warn = vi.spyOn(b.ctx.logger, 'warn').mockImplementation(() => undefined)
    put.mockRejectedValue(new Error('disk full'))
    b.ctx.forgeSession.track(b.session, pullUrl(7))

    expect((await reader(b).until(states => states.has(pullUrl(7)))).get(pullUrl(7))).toEqual(state(7))
    await vi.waitFor(() => { expect(warn).toHaveBeenCalledWith('forge-panel: storing a change request state failed: Error: disk full') })
  })

  it('refuses to stream without the Session list and storage services', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forge-states-'))
    cleanups.push(() => rm(cwd, { recursive: true, force: true }))
    const b = await bench(cwd)
    cleanups.push(() => b.ctx.fiber.dispose())

    await expect(reader(b).until(() => false)).rejects.toThrow(
      'forge-panel: change request states need the sessionQuery, sessionProjectionCache, storageDomain, and sessions services',
    )
  })

  it('replaces the closed cache with a reopened provider result', async () => {
    const { b, records } = await composed()
    records.set(storedKey(pullUrl(7)), { ...state(7), state: 'closed' })
    b.ctx.forgeSession.track(b.session, pullUrl(7))
    const r = reader(b)
    await r.until(states => states.get(pullUrl(7))?.state === 'open')
    expect(r.frames[0]?.states).toContainEqual({ ...state(7), state: 'closed' })
    expect(records.get(storedKey(pullUrl(7)))?.state).toBe('open')
  })

  it('finishes accepted state storage before the controller owner unloads', async () => {
    const { b, put, records } = await composed()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const order: string[] = []
    put.mockImplementationOnce(async (key, value) => {
      entered.resolve(undefined)
      await release.promise
      records.set(key, value)
      order.push('written')
    })
    b.ctx.forgeSession.track(b.session, pullUrl(7))
    const reading = reader(b).until(states => states.has(pullUrl(7)))
    await entered.promise
    const disposing = b.ctx.fiber.dispose().then(() => { order.push('disposed') })
    release.resolve(undefined)
    await Promise.all([reading, disposing])
    expect(order).toEqual(['written', 'disposed'])
    expect(records.has(storedKey(pullUrl(7)))).toBe(true)
  })

})
