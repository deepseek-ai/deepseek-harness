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

function bench(ids: readonly SessionId[]) {
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
  const recent = new RecentSessionViews(sessions, workspaceController, status)
  onRetain = () => { recent.reconcile() }
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
  return { recent, list, workspaces, retain, subagentAddress, update, retained, setOnRetain, setStatus }
}

describe('recently viewed Sessions', () => {
  it('retains a left Session without facets and releases it when the main view returns to it', () => {
    const b = bench([sid('a')])
    b.recent.leave(sid('a'))
    expect(b.retain).toHaveBeenCalledExactlyOnceWith(sid('a'), { source: 'recentViews' })
    expect(b.retained()).toEqual([sid('a')])
    b.recent.enter(sid('a'))
    expect(b.retained()).toEqual([])
  })

  it('skips blank, archived, and unlisted Sessions and retains a subagent through its address', () => {
    const b = bench([sid('blank'), sid('archived'), sid('child')])
    b.update(sid('blank'), { blank: true })
    b.workspaces.set({ ...b.workspaces.getSnapshot(), archivedSessionIds: [sid('archived')] })
    const address = { parentSessionId: sid('parent'), childSessionId: sid('child'), mode: 'continuable' as const }
    b.subagentAddress.mockImplementation(id => id === sid('child') ? address : undefined)
    b.recent.leave(sid('blank'))
    b.recent.leave(sid('archived'))
    b.recent.leave(sid('missing'))
    expect(b.retain).not.toHaveBeenCalled()
    b.recent.leave(sid('child'))
    expect(b.retain).toHaveBeenCalledExactlyOnceWith(address, { source: 'recentViews' })
  })

  it('keeps one entry per Session when it is left again', () => {
    const b = bench([sid('a')])
    b.recent.leave(sid('a'))
    b.recent.leave(sid('a'))
    expect(b.retain).toHaveBeenCalledTimes(2)
    expect(b.retained()).toEqual([sid('a')])
  })

  it('keeps ten idle Sessions beyond any running ones and evicts the least recently left idle Session', () => {
    const ids = Array.from({ length: 13 }, (_, index) => sid(`s${index}`))
    const b = bench(ids)
    b.update(sid('s0'), { running: true })
    b.setStatus(sid('s1'), { running: true })
    for (const id of ids.slice(0, 12)) b.recent.leave(id)
    expect(b.retained()).toHaveLength(12)
    b.recent.leave(sid('s12'))
    expect(b.retained()).toHaveLength(12)
    expect(b.retained()).toEqual(expect.arrayContaining([sid('s0'), sid('s1')]))
    expect(b.retained()).not.toContain(sid('s2'))
    b.update(sid('s0'), { running: false })
    b.recent.reconcile()
    expect(b.retained()).toHaveLength(11)
    expect(b.retained()).not.toContain(sid('s0'))
  })

  it('keeps a new entry when retention reconciles a list already beyond the limit', () => {
    const ids = Array.from({ length: 12 }, (_, index) => sid(`r${index}`))
    const b = bench(ids)
    for (const id of ids) b.update(id, { running: true })
    for (const id of ids.slice(0, 11)) b.recent.leave(id)
    b.recent.leave(ids[11]!)
    for (const id of ids) b.update(id, { running: false })
    b.recent.reconcile()
    expect(b.retained()).toHaveLength(10)
    expect(b.retained()).toContain(ids[11])
    b.recent.dispose()
    expect(b.retained()).toEqual([])
  })

  it('releases a reference retained while the list is disposed and reports a failed retention', () => {
    const b = bench([sid('a'), sid('b')])
    b.setOnRetain(() => { b.recent.dispose() })
    b.recent.leave(sid('a'))
    expect(b.retained()).toEqual([])
    b.recent.leave(sid('b'))
    expect(b.retained()).toEqual([])
    const failure = new Error('retain failed')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const other = bench([sid('c')])
    other.retain.mockImplementationOnce(() => { throw failure })
    other.recent.leave(sid('c'))
    expect(warn).toHaveBeenCalledWith('recent Session view retention failed:', failure)
    expect(other.retained()).toEqual([])
    warn.mockRestore()
  })

  it('retains a Session left again before releasing its earlier entry', () => {
    const b = bench([sid('a')])
    b.recent.leave(sid('a'))
    const releaseOrder: string[] = []
    b.setOnRetain(() => { releaseOrder.push(`retained:${String(b.retained().length)}`) })
    b.recent.leave(sid('a'))
    expect(releaseOrder).toEqual(['retained:1'])
    expect(b.retained()).toEqual([sid('a')])
  })

  it('neither counts nor evicts Sessions awaiting the user or holding an unread completion until they are read', () => {
    const ids = Array.from({ length: 13 }, (_, index) => sid(`u${index}`))
    const b = bench(ids)
    b.setStatus(sid('u0'), { pendingInteraction: { key: 'question:1', kind: 'question', sessionId: sid('u0') } as SessionPendingInteraction })
    b.setStatus(sid('u1'), { completionUnread: true })
    b.setStatus(sid('u2'), { completionUnread: true, completionFailed: true })
    for (const id of ids) b.recent.leave(id)
    expect(b.retained()).toHaveLength(13)
    b.setStatus(sid('u1'), { completionUnread: false })
    b.recent.reconcile()
    expect(b.retained()).toHaveLength(12)
    expect(b.retained()).not.toContain(sid('u1'))
    expect(b.retained()).toEqual(expect.arrayContaining([sid('u0'), sid('u2')]))
  })

  it('evicts pinned Sessions only after every unpinned Session needing no attention', () => {
    const ids = Array.from({ length: 12 }, (_, index) => sid(`p${index}`))
    const b = bench(ids)
    b.workspaces.set({ ...b.workspaces.getSnapshot(), pinnedSessionIds: [sid('p0'), sid('p1')] })
    for (const id of ids) b.recent.leave(id)
    expect(b.retained()).toHaveLength(10)
    expect(b.retained()).toEqual(expect.arrayContaining([sid('p0'), sid('p1')]))
    expect(b.retained()).not.toContain(sid('p2'))
    expect(b.retained()).not.toContain(sid('p3'))
  })

  it('drops removed and archived Sessions on reconcile and releases every entry on dispose', () => {
    const b = bench([sid('a'), sid('b'), sid('c')])
    for (const id of [sid('a'), sid('b'), sid('c')]) b.recent.leave(id)
    const state = b.list.getSnapshot()
    const { [sid('a')]: _removed, ...byId } = state.byId
    b.list.set({ ...state, ids: state.ids.filter(id => id !== sid('a')), byId })
    b.workspaces.set({ ...b.workspaces.getSnapshot(), archivedSessionIds: [sid('b')] })
    b.recent.reconcile()
    expect(b.retained()).toEqual([sid('c')])
    b.recent.dispose()
    expect(b.retained()).toEqual([])
  })
})
