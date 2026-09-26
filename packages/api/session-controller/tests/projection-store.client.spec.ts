/**
 * Projection value store (push model; session-projection subsystem page:
 * docs/subsystems/session-projection.md): the higher-seq-wins rule among
 * sequenced writes (a stale baseline cannot overwrite a newer push frame; a
 * replayed frame cannot regress), cached list values yielding to every
 * sequenced write regardless of seq, capability absence as undefined,
 * generation invalidation, and the Session/manager wiring (tail-page seeding,
 * control-stream projection routing pre- and post-instantiation, the list
 * rows' title projection).
 */
import { describe, expect } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { ok, type RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import {
  createClientTest, type ClientTestFixtures, webApp,
} from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { ProjectionValueStore } from '../src/client/sessions/projection-store.ts'
import { SessionManager } from '../src/client/sessions/manager.ts'
import type { SessionRemotes } from '../src/client/sessions/remotes.ts'
import { entries, plainTurn } from './event-script.client.ts'
import { sessionBench } from './remote/bench.client.ts'
import { FOLLOW, followScript, sessionWorld } from './remote/session.client.ts'

// Test-domain keys merged into the projection map (the Service Definition package's
// pure-type outlet), the same way domain host plugins merge theirs.
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    'test/marks': { marks: string[] }
  }
}

const SID = 'fk-s1' as SessionId
/** A Session talks through the Gateway client; its dependency cone is the Typert registry and the Connection. */
const API_ROSTER = webApp.closure(['@deepseek-ai/dsh-api-gateway'])
const it = createClientTest({ roster: API_ROSTER })
/** The first client boot pays the cold module transform of the api cone. */
const COLD_BOOT_TIMEOUT_MS = 60_000

function makeManager(mock: RemoteMock, remote: ClientTestFixtures['remote']): SessionManager {
  mock.load(sessionWorld)
  // Manager-routing cases never open a Session, so they do not need the broader Client Remote's $stream member.
  return new SessionManager(remote as unknown as SessionRemotes)
}

describe('Session projection value semantics', () => {
  it('exposes a watermark only for current Host-sequenced values', () => {
    const store = new ProjectionValueStore()
    expect(store.seqOf('inbox')).toBeUndefined()
    store.applyCached({ inbox: { 'next-turn': [], 'next-step': [] } })
    expect(store.seqOf('inbox')).toBeUndefined()
    store.apply('inbox', { 'next-turn': [], 'next-step': [] }, SessionSeq(4))
    store.apply('inbox', { 'next-turn': [], 'next-step': [] }, SessionSeq(2))
    expect(store.seqOf('inbox')).toBe(4)
    store.seed({ asOfSeq: SessionSeq(6), values: {} })
    expect(store.seqOf('inbox')).toBeUndefined()
  })

  it('reads undefined until a value lands (capability absence)', () => {
    const store = new ProjectionValueStore()
    expect(store.get('test/marks')).toBeUndefined()
    expect(store.faceOf('test/marks').getSnapshot()).toBeUndefined()
  })

  it('applies frames last-wins by seq: replayed and stale frames drop', () => {
    const store = new ProjectionValueStore()
    store.apply('test/marks', { marks: ['a'] }, SessionSeq(5))
    store.apply('test/marks', { marks: ['a', 'b'] }, SessionSeq(9))
    expect(store.get('test/marks')).toEqual({ marks: ['a', 'b'] })
    store.apply('test/marks', { marks: ['stale'] }, SessionSeq(5))
    store.apply('test/marks', { marks: ['equal'] }, SessionSeq(9))
    expect(store.get('test/marks')).toEqual({ marks: ['a', 'b'] })
  })

  it('a stale baseline can neither overwrite nor clear a newer frame; a fresh one reseeds and clears', () => {
    const store = new ProjectionValueStore()
    store.apply('test/marks', { marks: ['frame-20'] }, SessionSeq(20))
    // Stale cut: carried key loses to the newer frame; omitted key survives.
    store.seed({ asOfSeq: SessionSeq(10), values: { 'test/marks': { marks: ['baseline-10'] } } })
    expect(store.get('test/marks')).toEqual({ marks: ['frame-20'] })
    store.seed({ asOfSeq: SessionSeq(15), values: {} })
    expect(store.get('test/marks')).toEqual({ marks: ['frame-20'] })
    // Fresh cut: carried key reseeds…
    store.seed({ asOfSeq: SessionSeq(30), values: { 'test/marks': { marks: ['baseline-30'] } } })
    expect(store.get('test/marks')).toEqual({ marks: ['baseline-30'] })
    // …and an omitting fresh cut clears (capability absent as of the cut).
    store.seed({ asOfSeq: SessionSeq(40), values: {} })
    expect(store.get('test/marks')).toBeUndefined()
  })

  it('cached values fill empty keys only and never displace a sequenced row', () => {
    const store = new ProjectionValueStore()
    store.applyCached({ 'test/marks': { marks: ['cached'] }, title: 'Cached title' })
    expect(store.values()).toEqual({ 'test/marks': { marks: ['cached'] }, title: 'Cached title' })
    // A later cached view replaces an earlier one: neither carries a seq.
    store.applyCached({ title: 'Cached again' })
    expect(store.get('title')).toBe('Cached again')
    // Once a sequenced row exists, cached values for that key are ignored.
    store.apply('title', 'Pushed', SessionSeq(0))
    store.applyCached({ title: 'Cached late', 'test/marks': { marks: ['cached late'] } })
    expect(store.get('title')).toBe('Pushed')
    expect(store.get('test/marks')).toEqual({ marks: ['cached late'] })
  })

  it('every sequenced write outranks a cached row regardless of seq', () => {
    const store = new ProjectionValueStore()
    store.applyCached({ 'test/marks': { marks: ['cached'] }, title: 'Cached title', schedule: [] })
    // A frame at the lowest cursor still replaces the cached value.
    store.apply('title', 'Frame at -1', -1)
    expect(store.get('title')).toBe('Frame at -1')
    // A baseline discards every cached row first: the carried key lands at its
    // cut, the omitted keys clear even though a cached row has no seq to compare.
    store.seed({ asOfSeq: SessionSeq(2), values: { 'test/marks': { marks: ['baseline-2'] } } })
    expect(store.values()).toEqual({ 'test/marks': { marks: ['baseline-2'] } })
    // The same baseline rule keeps protecting newer sequenced rows.
    store.apply('title', 'Frame at 9', SessionSeq(9))
    store.applyCached({ title: 'Cached late' })
    store.seed({ asOfSeq: SessionSeq(5), values: { 'test/marks': { marks: ['baseline-5'] } } })
    expect(store.values()).toEqual({ 'test/marks': { marks: ['baseline-5'] }, title: 'Frame at 9' })
  })

  it('notifies faces for cached fills and for their discard by a baseline', async () => {
    const store = new ProjectionValueStore()
    const observed: unknown[] = []
    store.faceOf('title').subscribe(() => { observed.push(store.get('title')) })
    store.applyCached({ title: 'Cached title' })
    await Promise.resolve()
    store.seed({ asOfSeq: SessionSeq(3), values: {} })
    await Promise.resolve()
    expect(observed).toEqual(['Cached title', undefined])
  })

  it('clears all generation watermarks without replacing subscribed faces', async () => {
    const store = new ProjectionValueStore()
    const face = store.faceOf('test/marks')
    const observed: unknown[] = []
    const unsubscribe = face.subscribe(() => { observed.push(face.getSnapshot()) })
    try {
      store.apply('test/marks', { marks: ['lost-tail'] }, SessionSeq(20))
      store.apply('empty-session', 'old generation', -1)
      const previous = store.values()
      await Promise.resolve()
      store.clear()
      await Promise.resolve()

      expect(face.getSnapshot()).toBeUndefined()
      expect(store.get('empty-session')).toBeUndefined()
      expect(store.faceOf('test/marks')).toBe(face)
      expect(store.values()).toEqual({})
      expect(store.values()).not.toBe(previous)
      store.seed({ asOfSeq: SessionSeq(1), values: { 'test/marks': { marks: ['durable'] } } })
      await Promise.resolve()
      expect(observed).toEqual([{ marks: ['lost-tail'] }, undefined, { marks: ['durable'] }])
    } finally {
      unsubscribe()
    }
  })

  it('notifies the key face on change (batched) and not on dropped applications', async () => {
    const store = new ProjectionValueStore()
    let keyTicks = 0
    let anyTicks = 0
    store.faceOf('test/marks').subscribe(() => { keyTicks += 1 })
    store.subscribeAny(() => { anyTicks += 1 })
    store.apply('test/marks', { marks: ['a'] }, SessionSeq(5))
    await Promise.resolve()
    expect(keyTicks).toBe(1)
    expect(anyTicks).toBe(1)
    store.apply('test/marks', { marks: ['replay'] }, SessionSeq(3))
    await Promise.resolve()
    expect(keyTicks).toBe(1)
    expect(anyTicks).toBe(1)
  })

  it('faces are identity-stable per key (the React binding cache premise)', () => {
    const store = new ProjectionValueStore()
    expect(store.faceOf('test/marks')).toBe(store.faceOf('test/marks'))
  })

  it('publishes one reference-stable whole-value snapshot until a row changes', () => {
    const store = new ProjectionValueStore()
    const empty = store.values()
    expect(store.values()).toBe(empty)
    store.apply('test/marks', { marks: ['a'] }, SessionSeq(1))
    const populated = store.values()
    expect(populated).toEqual({ 'test/marks': { marks: ['a'] } })
    expect(populated).not.toBe(empty)
    expect(store.values()).toBe(populated)
  })
})

describe('Session tail-page seeding', () => {
  it('seeds the store from a history response carrying a projections block', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(ok({
      records: entries(plainTurn(SessionSeq(0), 0, '问', '答')) as never[], hasMore: false,
      projections: { asOfSeq: 5, values: { 'test/marks': { marks: ['from-baseline'] } } },
    } as never)))
    await session.open()
    expect(session.projections.get('test/marks')).toEqual({ marks: ['from-baseline'] })
  }, COLD_BOOT_TIMEOUT_MS)

  it('a resync serving a stale block keeps the newer pushed value (seq rule end to end)', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(ok({
      records: entries(plainTurn(SessionSeq(0), 0, 'a', 'b')) as never[], hasMore: false,
      projections: { asOfSeq: 5, values: { 'test/marks': { marks: ['baseline'] } } },
    } as never)))
    await session.open()
    session.projections.apply('test/marks', { marks: ['pushed-9'] }, SessionSeq(9))
    await session.resync()
    expect(session.projections.get('test/marks')).toEqual({ marks: ['pushed-9'] })
  })

  it('treats a blockless response as no reset: pushed values survive', async ({ mock, start }) => {
    const session = await sessionBench(mock, start, SID)
    mock.stream(FOLLOW, followScript(ok({ records: entries(plainTurn(SessionSeq(0), 0, 'a', 'b')) as never[], hasMore: false })))
    await session.open()
    session.projections.apply('test/marks', { marks: ['pushed'] }, SessionSeq(9))
    await session.resync()
    expect(session.projections.get('test/marks')).toEqual({ marks: ['pushed'] })
  })
})

describe('manager frame routing', () => {
  const sid = (s: string): SessionId => s as SessionId

  it('lands projection frames before instantiation and the Session adopts the same store', ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    manager.handleControlFrame({
      type: 'projection', sessionId: sid('s1'), key: 'test/marks', value: { marks: ['early'] }, seq: 7,
    })
    const session = manager.get(sid('s1'))
    expect(session.projections.get('test/marks')).toEqual({ marks: ['early'] })
    // Frames after instantiation land in the same store.
    manager.handleControlFrame({
      type: 'projection', sessionId: sid('s1'), key: 'test/marks', value: { marks: ['later'] }, seq: 9,
    })
    expect(session.projections.get('test/marks')).toEqual({ marks: ['later'] })
  })

  it('preserves a newer title when the control baseline omits it', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    remote.session.list.mockResolvedValue(ok({
      items: [{ agentAvailable: true, sessionId: sid('s1'), updatedAt: 1, running: false, blank: false }],
    }))
    await manager.refreshList()
    manager.handleControlFrame({
      type: 'projection', sessionId: sid('s1'), key: 'title', value: 'Projected title', seq: 4,
    })
    await Promise.resolve()
    expect(manager.getListSnapshot().items[0]?.title).toBe('Projected title')
    manager.handleControlFrame({
      type: 'baseline',
      value: {
        projections: { [sid('s1')]: { asOfSeq: 2, values: {} } },
      },
    })
    await Promise.resolve()
    expect(manager.getListSnapshot().items[0]?.title).toBe('Projected title')
  })

  it('routes a cached list block below every sequenced write: a Session baseline at any cut replaces it and a list refresh cannot restore it', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    remote.session.list.mockResolvedValue(ok({
      items: [{ agentAvailable: false,
        sessionId: sid('s1'), updatedAt: 1, running: false, blank: false,
        // A cold row viewed from a stale record whose own watermark outruns
        // the connected Session's cut.
        projections: { kind: 'cached', asOfSeq: 40, values: { title: 'Cached title', 'test/marks': { marks: ['cached'] } } },
      }],
    }))
    await manager.refreshList()
    expect(manager.getListSnapshot().items[0]?.title).toBe('Cached title')

    // The connected Session answers at a lower cut: it still wins outright,
    // and the key it omits clears rather than surviving on its stale seq.
    manager.handleControlFrame({
      type: 'baseline',
      value: {
        projections: { [sid('s1')]: { asOfSeq: 2, values: { title: 'Connected title' } } },
      },
    })
    await Promise.resolve()
    expect(manager.getListSnapshot().items[0]?.title).toBe('Connected title')
    expect(manager.getListSnapshot().items[0]?.projectionValues).toEqual({ title: 'Connected title' })

    // A later list refresh serving the stale block again cannot displace the
    // sequenced value, whatever watermark the block claims.
    await manager.refreshList()
    expect(manager.getListSnapshot().items[0]?.title).toBe('Connected title')
    expect(manager.get(sid('s1')).projections.get('test/marks')).toEqual({ marks: ['cached'] })
  })

  it('merges a sequenced list block under higher-seq-wins: a lower-cut baseline neither overwrites nor clears it', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    remote.session.list.mockResolvedValue(ok({
      items: [{ agentAvailable: true,
        sessionId: sid('s1'), updatedAt: 1, running: false, blank: false,
        // The Host's live registry served the block: its watermark shares the connection's seq space.
        projections: { kind: 'sequenced', asOfSeq: 40, values: { title: 'Live title', 'test/marks': { marks: ['live'] } } },
      }],
    }))
    await manager.refreshList()
    expect(manager.getListSnapshot().items[0]?.title).toBe('Live title')

    // A delayed baseline at a lower cut is stale against the block: it can
    // neither overwrite the carried key nor clear the omitted one.
    manager.handleControlFrame({
      type: 'baseline',
      value: {
        projections: { [sid('s1')]: { asOfSeq: 2, values: { title: 'Delayed baseline' } } },
      },
    })
    await Promise.resolve()
    expect(manager.getListSnapshot().items[0]?.title).toBe('Live title')
    expect(manager.get(sid('s1')).projections.get('test/marks')).toEqual({ marks: ['live'] })

    // A frame past the block's watermark still advances it.
    manager.handleControlFrame({
      type: 'projection', sessionId: sid('s1'), key: 'title', value: 'Frame title', seq: 41,
    })
    await Promise.resolve()
    expect(manager.getListSnapshot().items[0]?.title).toBe('Frame title')
  })

  it('projects every retained value into list rows with stable snapshot identity', async ({ mock, remote }) => {
    const manager = makeManager(mock, remote)
    remote.session.list.mockResolvedValue(ok({
      items: [{ agentAvailable: true,
        sessionId: sid('s1'), updatedAt: 1, running: false, blank: false,
        projections: {
          kind: 'sequenced',
          asOfSeq: 2,
          values: { 'test/marks': { marks: ['baseline'] } },
        },
      }],
    }))
    await manager.refreshList()
    const baseline = manager.getListSnapshot().items[0]?.projectionValues
    expect(baseline).toEqual({ 'test/marks': { marks: ['baseline'] } })
    expect(manager.getListSnapshot().items[0]?.projectionValues).toBe(baseline)

    manager.handleControlFrame({
      type: 'projection', sessionId: sid('s1'), key: 'test/marks',
      value: { marks: ['live'] }, seq: 3,
    })
    await Promise.resolve()
    expect(manager.getListSnapshot().items[0]?.projectionValues)
      .toEqual({ 'test/marks': { marks: ['live'] } })
    expect(manager.getListSnapshot().items[0]?.projectionValues).not.toBe(baseline)
  })

  it.for([undefined, []])('drops the removed ordinary Session store with catalog %s', async (catalog, { mock, remote }) => {
    const manager = makeManager(mock, remote)
    remote.session.list.mockResolvedValue(ok({
      items: [{ agentAvailable: true, sessionId: sid('s1'), updatedAt: 1, running: false, blank: false }],
    }))
    await manager.refreshList()
    manager.handleControlFrame({
      type: 'projection', sessionId: sid('s1'), key: 'title', value: 'Doomed', seq: 4,
    })
    if (catalog !== undefined) {
      manager.handleControlFrame({ type: 'projection', sessionId: sid('s1'), key: 'subagentCatalog', value: catalog, seq: 4 })
    }
    manager.handleSessionRemoved(sid('s1'))
    expect(manager.getListSnapshot().projectionsBySession[sid('s1')]).toBeUndefined()
    expect(manager.get(sid('s1')).projections.get('title')).toBeUndefined()
    await manager.dispose()
  })
})
