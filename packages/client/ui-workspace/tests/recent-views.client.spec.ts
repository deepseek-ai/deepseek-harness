import { describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  ISessions, SessionListState, SessionReference, SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { SessionStatus, SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session-status/client'
import type { SessionPendingInteraction } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RecentSessionViews } from '../src/client/recent-views.ts'

const sid = (id: string): SessionId => brandString<SessionId>(id)

function row(id: SessionId, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { id, displayTitle: id, running: false, blank: false, updatedAt: 0, retainedBy: {}, ...overrides }
}

function bench(ids: readonly SessionId[], limit = 10) {
  const list = createSnapshotStore<SessionListState>({
    ids: [...ids], byId: Object.fromEntries(ids.map(id => [id, row(id)])), phase: 'ready', projectionsBySession: {},
  })
  const workspaces = createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], pinnedSessionIds: [], phase: 'ready', state: 'idle', error: null,
  })
  const held = new Map<SessionId, number>()
  // The Session Controller publishes the list synchronously inside retain; navigation reconciles from it.
  let onRetain = (): void => {}
  const retain = vi.fn<ISessions['retain']>((target) => {
    const sessionId = typeof target === 'string' ? target : target.childSessionId
    held.set(sessionId, (held.get(sessionId) ?? 0) + 1)
    onRetain()
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      held.set(sessionId, (held.get(sessionId) ?? 1) - 1)
    }
    const binding = { sessionId } as SessionReference['binding']
    return { sessionId, binding, ready: Promise.resolve(binding), release, [Symbol.dispose]: release }
  })
  const subagentAddress = vi.fn<ISessions['subagentAddress']>(() => undefined)
  const sessions: Pick<ISessions, 'list' | 'retain' | 'subagentAddress'> = { list, retain, subagentAddress }
  const workspaceController: Pick<IWorkspaces, 'list'> = { list: workspaces }
  const status = createSnapshotStore<SessionStatusSnapshot>(new Map())
  const recentViewLimit = createSnapshotStore<number | undefined>(limit)
  const recent = new RecentSessionViews(sessions, workspaceController, status, recentViewLimit)
  const stop = recent.start()
  const update = (id: SessionId, patch: Partial<SessionSummary>): void => {
    const state = list.getSnapshot()
    list.set({ ...state, byId: { ...state.byId, [id]: row(id, { ...state.byId[id], ...patch }) } })
  }
  const retained = (): SessionId[] => [...held].filter(([, count]) => count > 0).map(([id]) => id)
  const setOnRetain = (hook: () => void): void => { onRetain = hook }
  const setStatus = (id: SessionId, patch: Partial<SessionStatus>): void => {
    const next = new Map(status.getSnapshot())
    next.set(id, { running: false, pendingInteraction: undefined, completionUnread: false, completionFailed: false, ...patch })
    status.set(next)
  }
  /** Show each Session in the main view in turn, then show `last`. */
  const visit = (ids: readonly SessionId[], last?: SessionId): void => {
    for (const id of ids) recent.show(id)
    recent.show(last)
  }
  return {
    recent, stop, list, workspaces, retain, subagentAddress, update, retained, setOnRetain, setStatus, visit,
    recentViewLimit,
  }
}

describe('recently viewed Sessions', () => {
  it('holds a left Session without facets and releases it when the main view returns to it', () => {
    const b = bench([sid('a'), sid('b')])
    b.visit([sid('a')], sid('b'))
    expect(b.retain).toHaveBeenCalledExactlyOnceWith(sid('a'), { source: 'recentViews' })
    expect(b.retained()).toEqual([sid('a')])
    b.recent.show(sid('a'))
    expect(b.retained()).toEqual([sid('b')])
    b.recent.show(sid('a'))
    expect(b.retain).toHaveBeenCalledTimes(2)
  })

  it('skips blank, archived, and unlisted Sessions and retains a subagent through its address', () => {
    const b = bench([sid('blank'), sid('archived'), sid('child')])
    b.update(sid('blank'), { blank: true })
    b.workspaces.set({ ...b.workspaces.getSnapshot(), archivedSessionIds: [sid('archived')] })
    const address = { parentSessionId: sid('parent'), childSessionId: sid('child'), mode: 'continuable' as const }
    b.subagentAddress.mockImplementation(id => id === sid('child') ? address : undefined)
    b.visit([sid('blank'), sid('archived'), sid('missing')])
    expect(b.retain).not.toHaveBeenCalled()
    b.visit([sid('child')])
    expect(b.retain).toHaveBeenCalledExactlyOnceWith(address, { source: 'recentViews' })
  })

  it('keeps ten idle Sessions beyond any running ones and evicts the least recently left idle Session', () => {
    const ids = Array.from({ length: 13 }, (_, index) => sid(`s${index}`))
    const b = bench(ids)
    b.update(sid('s0'), { running: true })
    b.setStatus(sid('s1'), { running: true })
    b.visit(ids.slice(0, 12))
    expect(b.retained()).toHaveLength(12)
    b.visit([sid('s12')])
    expect(b.retained()).toHaveLength(12)
    expect(b.retained()).toEqual(expect.arrayContaining([sid('s0'), sid('s1')]))
    expect(b.retained()).not.toContain(sid('s2'))
    b.update(sid('s0'), { running: false })
    expect(b.retained()).toHaveLength(11)
    expect(b.retained()).not.toContain(sid('s0'))
  })

  it('does not bring an evicted Session back when room frees up', () => {
    const ids = Array.from({ length: 12 }, (_, index) => sid(`e${index}`))
    const b = bench(ids)
    b.visit(ids.slice(0, 11))
    expect(b.retained()).not.toContain(sid('e0'))
    b.workspaces.set({ ...b.workspaces.getSnapshot(), archivedSessionIds: [sid('e5')] })
    expect(b.retained()).toHaveLength(9)
    expect(b.retained()).not.toContain(sid('e0'))
  })

  it('keeps the main-view Session out of the count when the list reconciles during retention', () => {
    const ids = Array.from({ length: 12 }, (_, index) => sid(`m${index}`))
    const b = bench(ids)
    b.visit(ids.slice(0, 10), sid('m10'))
    expect(b.retained()).toHaveLength(10)
    b.setOnRetain(() => { b.update(sid('m3'), { title: 'touched' }) })
    b.recent.show(sid('m3'))
    expect(b.retained()).toHaveLength(10)
    expect(b.retained()).toEqual(expect.arrayContaining([sid('m1'), sid('m10')]))
    expect(b.retained()).not.toContain(sid('m3'))
  })

  it('keeps a Session the main view retains out of the count before it is shown', () => {
    const ids = Array.from({ length: 13 }, (_, index) => sid(`n${index}`))
    const b = bench(ids)
    b.setStatus(sid('n0'), { completionUnread: true })
    b.visit(ids.slice(0, 11), sid('n11'))
    expect(b.retained()).toHaveLength(11)
    // Retaining n0 for the main view publishes the list; the status then stops protecting it before show().
    b.update(sid('n0'), { retainedBy: { mainView: 1 } })
    b.setStatus(sid('n0'), { completionUnread: false })
    expect(b.retained()).toHaveLength(11)
    expect(b.retained()).toContain(sid('n1'))
    // Showing n0 moves n11 into the recent views; only that one extra Session evicts the oldest.
    b.recent.show(sid('n0'))
    expect(b.retained()).toEqual(expect.arrayContaining(ids.slice(2, 12)))
    expect(b.retained()).toHaveLength(10)
  })

  it('retains before releasing and reports a failed retention without retrying it', () => {
    const b = bench([sid('a'), sid('b'), sid('c')])
    b.visit([sid('a')], sid('b'))
    const order: string[] = []
    b.setOnRetain(() => { order.push(`retained with ${String(b.retained().length)} held`) })
    b.recent.show(sid('a'))
    expect(order).toEqual(['retained with 2 held'])
    expect(b.retained()).toEqual([sid('b')])
    const failure = new Error('retain failed')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    b.retain.mockImplementationOnce(() => { throw failure })
    b.recent.show(sid('c'))
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith('recent Session view retention failed:', failure)
    b.update(sid('a'), { title: 'touched' })
    expect(b.retained()).toEqual([sid('b')])
    warn.mockRestore()
  })

  it('neither counts nor evicts Sessions awaiting the user or holding an unread completion until they are read', () => {
    const ids = Array.from({ length: 13 }, (_, index) => sid(`u${index}`))
    const b = bench(ids)
    b.setStatus(sid('u0'), { pendingInteraction: { key: 'question:1', kind: 'question', sessionId: sid('u0') } as SessionPendingInteraction })
    b.setStatus(sid('u1'), { completionUnread: true })
    b.setStatus(sid('u2'), { completionUnread: true, completionFailed: true })
    b.visit(ids)
    expect(b.retained()).toHaveLength(13)
    b.setStatus(sid('u1'), { completionUnread: false })
    expect(b.retained()).toHaveLength(12)
    expect(b.retained()).not.toContain(sid('u1'))
    expect(b.retained()).toEqual(expect.arrayContaining([sid('u0'), sid('u2')]))
  })

  it('evicts pinned Sessions only after every unpinned Session needing no attention', () => {
    const ids = Array.from({ length: 12 }, (_, index) => sid(`p${index}`))
    const b = bench(ids)
    b.workspaces.set({ ...b.workspaces.getSnapshot(), pinnedSessionIds: [sid('p0'), sid('p1')] })
    b.visit(ids)
    expect(b.retained()).toHaveLength(10)
    expect(b.retained()).toEqual(expect.arrayContaining([sid('p0'), sid('p1')]))
    expect(b.retained()).not.toContain(sid('p2'))
    expect(b.retained()).not.toContain(sid('p3'))
  })

  it('drops removed and archived Sessions and releases everything when stopped, even during retention', () => {
    const b = bench([sid('a'), sid('b'), sid('c'), sid('d')])
    b.visit([sid('a'), sid('b'), sid('c')])
    const state = b.list.getSnapshot()
    const { [sid('a')]: _removed, ...byId } = state.byId
    b.list.set({ ...state, ids: state.ids.filter(id => id !== sid('a')), byId })
    b.workspaces.set({ ...b.workspaces.getSnapshot(), archivedSessionIds: [sid('b')] })
    expect(b.retained()).toEqual([sid('c')])
    b.recent.show(sid('d'))
    b.setOnRetain(() => { b.stop() })
    b.recent.show(undefined)
    expect(b.retain).toHaveBeenLastCalledWith(sid('d'), { source: 'recentViews' })
    expect(b.retained()).toEqual([])
  })
})

describe('recent view configuration', () => {
  it('follows a changed limit, evicting and retaining as it moves', () => {
    const ids = Array.from({ length: 5 }, (_, index) => sid(`l${index}`))
    const b = bench(ids, 2)
    b.visit(ids.slice(0, 4), sid('l4'))
    expect(b.retained()).toEqual([sid('l2'), sid('l3')])
    // Raising the limit does not bring back evicted Sessions; the next Sessions left fill the room.
    b.recentViewLimit.set(4)
    expect(b.retained()).toEqual([sid('l2'), sid('l3')])
    b.visit([sid('l2')], sid('l1'))
    expect(b.retained().toSorted()).toEqual([sid('l2'), sid('l3'), sid('l4')])
    b.recentViewLimit.set(1)
    expect(b.retained()).toEqual([sid('l2')])
  })

  it('keeps every counted Session while the Host sends no limit', () => {
    const ids = Array.from({ length: 12 }, (_, index) => sid(`n${index}`))
    const b = bench(ids)
    b.recentViewLimit.set(undefined)
    b.visit(ids.slice(0, 11), sid('n11'))
    expect(b.retained()).toHaveLength(11)
    b.recentViewLimit.set(3)
    expect(b.retained()).toHaveLength(3)
  })
})
