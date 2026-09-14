import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ISessions, SessionListState, SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type {
  IWorkspaces, WorkspaceId, WorkspaceSnapshot, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { ClientRemote, DirectoryListing } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { LayoutController } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { DirectoryBrowseError, UiWorkspaceService } from '../src/client/navigation.ts'

const sid = (id: string): SessionId => SessionId(id)
const wid = (id: string): WorkspaceId => id as WorkspaceId

afterEach(() => {
  vi.restoreAllMocks()
})

function workspace(
  id: string,
  sessionIds: readonly SessionId[] = [],
  createdAt = '2026-01-01T00:00:00.000Z',
): WorkspaceView {
  return {
    workspaceId: wid(id),
    path: `/w/${id}`,
    title: id,
    sessionIds,
    createdAt,
    updatedAt: createdAt,
  }
}

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: sid(id),
    displayTitle: id,
    running: false,
    blank: false,
    updatedAt: 0,
    ...overrides,
  }
}

function sessionState(
  summaries: readonly SessionSummary[] = [],
  current?: SessionId,
  phase: SessionListState['phase'] = 'ready',
): SessionListState {
  return {
    ids: summaries.map(item => item.id),
    byId: Object.fromEntries(summaries.map(item => [item.id, item])),
    current,
    phase,
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
}

function workspaceState(
  items: WorkspaceSnapshot['items'] = [],
  archivedSessionIds: readonly SessionId[] = [],
  phase: WorkspaceSnapshot['phase'] = 'ready',
): WorkspaceSnapshot {
  return {
    items,
    archivedSessionIds,
    phase,
    state: phase === 'ready' ? 'idle' : 'loading',
    error: null,
  }
}

class MutableSource<T> {
  private readonly listeners = new Set<() => void>()

  constructor(private value: T) {}

  getSnapshot(): T {
    return this.value
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(value: T): void {
    this.value = value
    for (const listener of [...this.listeners]) listener()
  }

  update(update: (value: T) => T): void {
    this.set(update(this.value))
  }

  listenersSnapshot(): readonly (() => void)[] {
    return [...this.listeners]
  }
}

class FakeSessions {
  readonly list: MutableSource<SessionListState>
  readonly create: ReturnType<typeof vi.fn<ISessions['create']>>
  readonly open: ReturnType<typeof vi.fn<(id: SessionId) => void>>
  readonly clear: ReturnType<typeof vi.fn<() => void>>
  readonly fork = vi.fn<ISessions['fork']>(async () => sid('forked'))

  constructor(initial: SessionListState) {
    this.list = new MutableSource(initial)
    this.create = vi.fn<ISessions['create']>(async options =>
      options?.sessionId ?? sid(`created-${String(options?.workspaceId ?? 'none')}`))
    this.open = vi.fn((id: SessionId) => {
      this.list.update(state => ({ ...state, current: id }))
    })
    this.clear = vi.fn(() => {
      this.list.update(state => ({ ...state, current: undefined }))
    })
  }
}

class FakeWorkspaces implements IWorkspaces {
  readonly list: MutableSource<WorkspaceSnapshot>
  readonly archiveCalls: SessionId[] = []
  readonly unarchiveCalls: SessionId[] = []
  onArchive: IWorkspaces['archiveSession'] = async (sessionId) => {
    this.list.update(state => ({
      ...state,
      archivedSessionIds: [...state.archivedSessionIds, sessionId],
    }))
  }

  onUnarchive: IWorkspaces['unarchiveSession'] = async (sessionId) => {
    this.list.update(state => ({
      ...state,
      archivedSessionIds: state.archivedSessionIds.filter(id => id !== sessionId),
    }))
  }

  declare readonly create: IWorkspaces['create']
  declare readonly rename: IWorkspaces['rename']
  declare readonly delete: IWorkspaces['delete']
  declare readonly insertBefore: IWorkspaces['insertBefore']
  declare readonly insertSessionBefore: IWorkspaces['insertSessionBefore']

  constructor(initial: WorkspaceSnapshot) {
    this.list = new MutableSource(initial)
  }

  archiveSession(sessionId: SessionId): Promise<void> {
    this.archiveCalls.push(sessionId)
    return this.onArchive(sessionId)
  }

  unarchiveSession(sessionId: SessionId): Promise<void> {
    this.unarchiveCalls.push(sessionId)
    return this.onUnarchive(sessionId)
  }
}

const listing: DirectoryListing = {
  path: '/home/u',
  home: '/home/u',
  crumbs: [{ name: '/', path: '/', hidden: false }],
  entries: [{ name: 'project', path: '/home/u/project', hidden: false }],
  truncated: false,
}

/** The directory-picking Remote namespace, recorded and scripted per case. */
class FakeDirectoryPicker {
  readonly calls: { method: string; payload: unknown }[] = []

  onPick: () => Promise<RemoteResult<string | null>> = () => Promise.resolve({ ok: true, value: null })
  onList: () => Promise<RemoteResult<DirectoryListing>> = () => Promise.resolve({ ok: true, value: listing })
  onCreateDirectory: () => Promise<RemoteResult<string>> =
    () => Promise.resolve({ ok: true, value: '/home/u/new' })

  readonly remote: ClientRemote['directoryPicker'] = {
    pick: () => this.record('pick', {}, this.onPick()),
    list: (path?: string) => this.record('list', { path }, this.onList()),
    createDirectory: (path: string, name: string) =>
      this.record('createDirectory', { path, name }, this.onCreateDirectory()),
  }

  callsOf(method: string): unknown[] {
    return this.calls.filter(call => call.method === method).map(call => call.payload)
  }

  private record<T>(method: string, payload: unknown, result: Promise<T>): Promise<T> {
    this.calls.push({ method, payload })
    return result
  }
}

interface BenchOptions {
  readonly workspaces?: WorkspaceSnapshot
  readonly sessions?: SessionListState
}

function bench(options: BenchOptions = {}) {
  const ctx = new Context()
  const layout = new LayoutController({
    selectPanel: vi.fn(), retainMainPanels: vi.fn(),
    setSidebar: vi.fn(), toggleSidebar: vi.fn(), setViewportWidth: vi.fn(),
    setRightbar: vi.fn(), openRightbar: vi.fn(), closeRightbar: vi.fn(),
  }, () => true)
  const selectPanel = vi.spyOn(layout, 'selectPanel')
  ctx.provide('layout', layout)
  ctx.effect(() => () => { layout.dispose() })
  const directoryPicker = new FakeDirectoryPicker()
  const workspaces = new FakeWorkspaces(options.workspaces ?? workspaceState([], [], 'pending'))
  const sessions = new FakeSessions(options.sessions ?? sessionState([], undefined, 'pending'))
  const uiWorkspace = new UiWorkspaceService(
    ctx,
    directoryPicker.remote,
    workspaces,
    sessions as unknown as ISessions,
  )
  return { ctx, directoryPicker, sessions, uiWorkspace, workspaces, layout, selectPanel }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('UiWorkspaceService', () => {
  it('selects a Session before revealing its Conversation, including the current Session', () => {
    const current = sid('current')
    const b = bench({ sessions: sessionState([summary('current')], current) })
    b.selectPanel.mockImplementation(() => {
      expect(b.sessions.list.getSnapshot().current).toBe(current)
    })
    b.uiWorkspace.openSession(current)
    expect(b.sessions.open).toHaveBeenCalledWith(current)
    expect(b.selectPanel).toHaveBeenCalledWith(null)
    expect(b.sessions.open.mock.invocationCallOrder[0]).toBeLessThan(b.selectPanel.mock.invocationCallOrder[0]!)
  })

  it('keeps the current panel when selecting a Session throws', () => {
    const b = bench()
    b.sessions.open.mockImplementationOnce(() => { throw new Error('selection failed') })
    expect(() => { b.uiWorkspace.openSession(sid('target')) }).toThrow('selection failed')
    expect(b.selectPanel).not.toHaveBeenCalled()
  })

  it('leaves a later panel selection in place when New Session finishes', async () => {
    const b = bench({
      sessions: sessionState([summary('current')], sid('current')),
      workspaces: workspaceState([workspace('alpha')]),
    })
    const created = Promise.withResolvers<SessionId>()
    b.sessions.create.mockReturnValue(created.promise)
    const opening = vi.spyOn(b.uiWorkspace, 'openWorkspace')
    b.uiWorkspace.startSession(wid('alpha'))
    b.layout.selectPanel('panel-a' as MainPanelId)
    created.resolve(sid('late'))
    await opening.mock.results[0]!.value
    expect(b.sessions.open).not.toHaveBeenCalled()
    expect(b.selectPanel).toHaveBeenCalledExactlyOnceWith('panel-a')
    expect(b.sessions.list.getSnapshot().current).toBe(sid('current'))
  })

  it('opens only the latest Workspace request when creation completes out of order', async () => {
    const b = bench({
      sessions: sessionState([summary('current')], sid('current')),
      workspaces: workspaceState([workspace('alpha'), workspace('beta')]),
    })
    const older = Promise.withResolvers<SessionId>()
    const newer = Promise.withResolvers<SessionId>()
    b.sessions.create.mockImplementation(options => options?.workspaceId === wid('alpha') ? older.promise : newer.promise)
    const oldDraft = vi.fn()
    const newDraft = vi.fn()
    const first = b.uiWorkspace.openWorkspace(wid('alpha'), oldDraft)
    const second = b.uiWorkspace.openWorkspace(wid('beta'), newDraft)
    newer.resolve(sid('newer'))
    await second
    older.resolve(sid('older'))
    await first
    expect(oldDraft).not.toHaveBeenCalled()
    expect(newDraft).toHaveBeenCalledExactlyOnceWith(sid('newer'))
    expect(b.sessions.open).toHaveBeenCalledExactlyOnceWith(sid('newer'))
  })

  it('does not move drafts or reopen a Workspace after reselecting the current Session', async () => {
    const b = bench({
      sessions: sessionState([summary('current')], sid('current')),
      workspaces: workspaceState([workspace('alpha')]),
    })
    const created = Promise.withResolvers<SessionId>()
    b.sessions.create.mockReturnValue(created.promise)
    const moveDraft = vi.fn()
    const pending = b.uiWorkspace.openWorkspace(wid('alpha'), moveDraft)
    b.uiWorkspace.openSession(sid('current'))
    created.resolve(sid('late'))
    await pending
    expect(moveDraft).not.toHaveBeenCalled()
    expect(b.sessions.open).toHaveBeenCalledExactlyOnceWith(sid('current'))
  })

  it('keeps navigation performed by preparation and propagates preparation failures', async () => {
    const b = bench({
      sessions: sessionState([summary('current')], sid('current')),
      workspaces: workspaceState([workspace('alpha')]),
    })
    await b.uiWorkspace.openWorkspace(wid('alpha'), () => { b.layout.selectPanel('panel-a' as MainPanelId) })
    expect(b.sessions.open).not.toHaveBeenCalled()
    await expect(b.uiWorkspace.openWorkspace(wid('alpha'), () => { throw new Error('draft failed') })).rejects.toThrow('draft failed')
    expect(b.sessions.open).not.toHaveBeenCalled()
  })

  it('opens a fork only while its navigation is current and preserves fork failures', async () => {
    const b = bench()
    await b.uiWorkspace.forkSession(sid('source'))
    expect(b.sessions.fork).toHaveBeenCalledWith({ sessionId: sid('source'), increaseTitle: true })
    expect(b.sessions.open).toHaveBeenCalledExactlyOnceWith(sid('forked'))
    const forked = Promise.withResolvers<SessionId>()
    b.sessions.fork.mockReturnValueOnce(forked.promise)
    const pending = b.uiWorkspace.forkSession(sid('source'))
    b.layout.selectPanel('panel-a' as MainPanelId)
    forked.resolve(sid('late-fork'))
    await pending
    expect(b.sessions.open).toHaveBeenCalledOnce()
    b.sessions.fork.mockRejectedValueOnce(new Error('fork failed'))
    await expect(b.uiWorkspace.forkSession(sid('source'))).rejects.toThrow('fork failed')
    expect(b.sessions.open).toHaveBeenCalledOnce()
  })

  it('does not open a pending Workspace or fork after the navigation owner is disposed', async () => {
    for (const kind of ['workspace', 'fork'] as const) {
      const b = bench({
        sessions: sessionState([summary('current')], sid('current')),
        workspaces: workspaceState([workspace('alpha')]),
      })
      const resolved = Promise.withResolvers<SessionId>()
      b.sessions.create.mockReturnValue(resolved.promise)
      b.sessions.fork.mockReturnValue(resolved.promise)
      const pending = kind === 'workspace'
        ? b.uiWorkspace.openWorkspace(wid('alpha'))
        : b.uiWorkspace.forkSession(sid('current'))
      await b.ctx.fiber.dispose()
      resolved.resolve(sid('late'))
      await pending
      expect(b.sessions.open).not.toHaveBeenCalled()
    }
  })

  it('reuses only an unarchived member blank and coalesces concurrent creation', async () => {
    const b = bench()
    const memberBlank = sid('member-blank')
    const archivedBlank = sid('archived-blank')
    const summaries: readonly SessionSummary[] = [
      summary('stray', { blank: true, cwd: '/w/alpha' }),
      summary('member-blank', { blank: true, cwd: '/w/alpha' }),
      summary('active', { cwd: '/w/beta' }),
      summary('archived-blank', { blank: true, cwd: '/w/gamma' }),
    ]
    b.workspaces.list.set(workspaceState([
      workspace('alpha', [memberBlank]),
      workspace('beta', [sid('active')]),
      workspace('gamma', [archivedBlank]),
    ], [archivedBlank]))
    b.sessions.list.set({
      ...sessionState(summaries, memberBlank),
      ids: [sid('missing'), ...summaries.map(item => item.id)],
    })

    await expect(Promise.all([
      b.uiWorkspace.connectWorkspace(wid('alpha')),
      b.uiWorkspace.connectWorkspace(wid('alpha')),
    ])).resolves.toEqual([memberBlank, memberBlank])
    expect(b.sessions.create).not.toHaveBeenCalled()

    const creation = Promise.withResolvers<SessionId>()
    b.sessions.create.mockImplementation(() => creation.promise)
    const first = b.uiWorkspace.connectWorkspace(wid('beta'))
    const second = b.uiWorkspace.connectWorkspace(wid('beta'))
    expect(b.sessions.create).toHaveBeenCalledTimes(1)
    creation.resolve(sid('fresh-beta'))
    await expect(Promise.all([first, second])).resolves.toEqual([sid('fresh-beta'), sid('fresh-beta')])

    b.sessions.create.mockImplementation(async options => sid(`fresh-${String(options?.workspaceId)}`))
    await expect(b.uiWorkspace.connectWorkspace(wid('gamma'))).resolves.toBe(sid('fresh-gamma'))
    expect(b.sessions.create).toHaveBeenLastCalledWith({ workspaceId: wid('gamma') })
    await expect(b.uiWorkspace.connectWorkspace(wid('ghost')))
      .rejects.toThrow('uiWorkspace.connectWorkspace: unknown workspace ghost')
  })

  it('targets an explicit, current-session, then recent Workspace and reports failed starts', async () => {
    const current = summary('current', { cwd: '/w/current-home', updatedAt: 1 })
    const recent = summary('recent', { cwd: '/w/recent-home', updatedAt: 2 })
    const b = bench({
      sessions: sessionState([current, recent], current.id),
      workspaces: workspaceState([
        workspace('current-home', [current.id]),
        workspace('recent-home', [recent.id]),
      ]),
    })
    b.sessions.create.mockImplementation(async options => sid(`opened-${String(options?.workspaceId)}`))

    b.uiWorkspace.startSession(wid('recent-home'))
    await vi.waitFor(() => {
      expect(b.sessions.open).toHaveBeenLastCalledWith(sid('opened-recent-home'))
    })

    b.sessions.open(current.id)
    b.uiWorkspace.startSession()
    await vi.waitFor(() => {
      expect(b.sessions.open).toHaveBeenLastCalledWith(sid('opened-current-home'))
    })

    b.sessions.clear()
    b.uiWorkspace.startSession()
    await vi.waitFor(() => {
      expect(b.sessions.open).toHaveBeenLastCalledWith(sid('opened-recent-home'))
    })

    const empty = bench()
    empty.uiWorkspace.startSession()
    expect(empty.sessions.clear).toHaveBeenCalledOnce()

    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    b.sessions.create.mockRejectedValueOnce(new Error('create failed'))
    b.uiWorkspace.startSession(wid('recent-home'))
    await vi.waitFor(() => {
      expect(warning).toHaveBeenCalledWith('new session failed:', expect.any(Error))
    })
  })

  it('opens the recent Workspace after both baselines arrive', async () => {
    const b = bench()
    b.sessions.create.mockResolvedValue(sid('initial'))

    const stableFirst = workspace('stable-first', [], '2026-01-01T00:00:00.000Z')
    const recent = workspace('recent', [], '2026-01-02T00:00:00.000Z')
    b.workspaces.list.set(workspaceState([stableFirst, recent]))
    expect(b.sessions.create).not.toHaveBeenCalled()
    b.sessions.list.set(sessionState())

    await vi.waitFor(() => {
      expect(b.sessions.open).toHaveBeenCalledWith(sid('initial'))
    })
    expect(b.sessions.create).toHaveBeenCalledWith({ workspaceId: wid('recent') })
    expect(b.workspaces.list.getSnapshot().items.map(item => item.workspaceId)).toEqual([
      wid('stable-first'), wid('recent'),
    ])
  })

  it('uses Workspace creation time when members are absent and preserves Host tie order', async () => {
    const b = bench()
    b.sessions.create.mockResolvedValue(sid('initial'))

    b.workspaces.list.set(workspaceState([
      workspace('newest', [sid('missing')], '2026-03-01T00:00:00.000Z'),
      workspace('same-time', [], '2026-03-01T00:00:00.000Z'),
      workspace('older', [], '2026-01-01T00:00:00.000Z'),
    ]))
    b.sessions.list.set(sessionState())

    await vi.waitFor(() => {
      expect(b.sessions.open).toHaveBeenCalledWith(sid('initial'))
    })
    expect(b.sessions.create).toHaveBeenCalledWith({ workspaceId: wid('newest') })
  })

  it('retries failed initial selection and never overwrites a later selection', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const b = bench()
    let attempts = 0
    b.sessions.create.mockImplementation(() => ++attempts === 1
      ? Promise.reject(new Error('attach exploded'))
      : Promise.resolve(sid('retry')))
    b.workspaces.list.set(workspaceState([workspace('recent')]))
    b.sessions.list.set(sessionState())
    await vi.waitFor(() => {
      expect(warning).toHaveBeenCalledWith('initial workspace selection failed:', expect.any(Error))
    })
    b.workspaces.list.update(state => ({ ...state, items: [...state.items] }))
    await vi.waitFor(() => {
      expect(b.sessions.open).toHaveBeenCalledWith(sid('retry'))
    })
    expect(attempts).toBe(2)

    const changed = bench()
    const pending = Promise.withResolvers<SessionId>()
    changed.sessions.create.mockImplementation(() => pending.promise)
    changed.workspaces.list.set(workspaceState([workspace('recent')]))
    changed.sessions.list.set(sessionState())
    await vi.waitFor(() => { expect(changed.sessions.create).toHaveBeenCalledOnce() })
    changed.sessions.open(sid('manual'))
    pending.resolve(sid('automatic'))
    await flush()
    expect(changed.sessions.open).toHaveBeenCalledTimes(1)
    expect(changed.sessions.open).toHaveBeenCalledWith(sid('manual'))
  })

  it('stops initial navigation when its Cordis lifetime is disposed', async () => {
    const success = bench()
    const resolved = Promise.withResolvers<SessionId>()
    success.sessions.create.mockImplementation(() => resolved.promise)
    success.workspaces.list.set(workspaceState([workspace('recent')]))
    success.sessions.list.set(sessionState())
    await vi.waitFor(() => { expect(success.sessions.create).toHaveBeenCalledOnce() })
    await success.ctx.fiber.dispose()
    resolved.resolve(sid('late'))
    await flush()
    expect(success.sessions.open).not.toHaveBeenCalled()
    success.workspaces.list.set(workspaceState([workspace('ignored')]))
    expect(success.sessions.create).toHaveBeenCalledOnce()

    const failure = bench()
    const rejected = Promise.withResolvers<SessionId>()
    failure.sessions.create.mockImplementation(() => rejected.promise)
    failure.workspaces.list.set(workspaceState([workspace('recent')]))
    failure.sessions.list.set(sessionState())
    await vi.waitFor(() => { expect(failure.sessions.create).toHaveBeenCalledOnce() })
    const staleReconciles = failure.workspaces.list.listenersSnapshot()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await failure.ctx.fiber.dispose()
    rejected.reject(new Error('late failure'))
    await flush()
    for (const reconcile of staleReconciles) reconcile()
    expect(warning).not.toHaveBeenCalled()
    expect(failure.sessions.create).toHaveBeenCalledOnce()
  })

  it('clears a current Session only after it enters the archive baseline', () => {
    const current = summary('current')
    const idle = summary('idle')
    const b = bench({
      sessions: sessionState([current, idle], current.id),
      workspaces: workspaceState([workspace('one', [current.id, idle.id])]),
    })

    b.workspaces.list.update(state => ({ ...state, archivedSessionIds: [idle.id] }))
    expect(b.sessions.clear).not.toHaveBeenCalled()
    b.workspaces.list.update(state => ({ ...state, archivedSessionIds: [current.id] }))
    expect(b.sessions.clear).toHaveBeenCalledOnce()

    b.sessions.open(idle.id)
    b.workspaces.list.update(state => ({ ...state, archivedSessionIds: [idle.id] }))
    expect(b.sessions.clear).toHaveBeenCalledTimes(2)

    const archived = bench({
      sessions: sessionState([current], current.id),
      workspaces: workspaceState([workspace('one', [current.id])], [current.id]),
    })
    expect(archived.sessions.clear).toHaveBeenCalledOnce()
  })

  it('forwards archive commands and preserves failures', async () => {
    const idle = sid('idle')
    const b = bench()

    await b.uiWorkspace.archiveSession(idle)
    expect(b.workspaces.archiveCalls).toEqual([idle])

    b.workspaces.onArchive = () => Promise.reject(new Error('archive rejected'))
    await expect(b.uiWorkspace.archiveSession(idle)).rejects.toThrow('archive rejected')
    expect(b.workspaces.archiveCalls).toEqual([idle, idle])
  })

  it('forwards unarchive commands and preserves failures', async () => {
    const idle = sid('idle')
    const b = bench()

    await b.uiWorkspace.unarchiveSession(idle)
    expect(b.workspaces.unarchiveCalls).toEqual([idle])

    b.workspaces.onUnarchive = () => Promise.reject(new Error('unarchive rejected'))
    await expect(b.uiWorkspace.unarchiveSession(idle)).rejects.toThrow('unarchive rejected')
    expect(b.workspaces.unarchiveCalls).toEqual([idle, idle])
  })

  it('passes directory operations to the Host and preserves structured browse failures', async () => {
    const b = bench()
    b.directoryPicker.onPick = () => Promise.resolve({ ok: true, value: '/w/alpha' })
    await expect(b.uiWorkspace.pickDirectory()).resolves.toBe('/w/alpha')
    b.directoryPicker.onPick = () => Promise.resolve({ ok: true, value: null })
    await expect(b.uiWorkspace.pickDirectory()).resolves.toBeNull()
    expect(b.directoryPicker.callsOf('pick')).toEqual([{}, {}])

    await expect(b.uiWorkspace.listDirectory()).resolves.toEqual(listing)
    await expect(b.uiWorkspace.listDirectory('/home/u')).resolves.toEqual(listing)
    expect(b.directoryPicker.callsOf('list')).toEqual([{ path: undefined }, { path: '/home/u' }])
    await expect(b.uiWorkspace.createDirectory('/home/u', 'new')).resolves.toBe('/home/u/new')
    expect(b.directoryPicker.callsOf('createDirectory')).toEqual([{ path: '/home/u', name: 'new' }])
    b.directoryPicker.onPick = () => Promise.resolve({
      ok: false, error: new RemoteError('gateway/internal', 'no chooser', {}),
    })
    await expect(b.uiWorkspace.pickDirectory()).rejects.toThrow('directory picker failed: no chooser')
    b.directoryPicker.onList = () => Promise.resolve({
      ok: false, error: new RemoteError('directory-picker/unreadable', 'denied', { path: '/private' }),
    })
    const listFailure = b.uiWorkspace.listDirectory('/private')
    await expect(listFailure).rejects.toBeInstanceOf(DirectoryBrowseError)
    await expect(listFailure).rejects.toMatchObject({ rpcError: { code: 'directory-picker/unreadable' } })
    b.directoryPicker.onCreateDirectory = () => Promise.resolve({
      ok: false, error: new RemoteError('directory-picker/exists', 'taken', { path: '/home/u/new' }),
    })
    await expect(b.uiWorkspace.createDirectory('/home/u', 'new')).rejects.toMatchObject({
      rpcError: { code: 'directory-picker/exists' },
    })
  })
})
