import { describe, expect, it, vi } from 'vitest'
import {
  ClientWorkspaceModel, type WorkspaceRemote,
} from '../src/client/index.ts'
import type {
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteRequest,
  WorkspaceDeleteValue,
  WorkspaceFollowFrame,
  WorkspaceInsertBeforeRequest,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceOrderValue,
  WorkspaceRenameRequest,
  WorkspaceUnarchiveSessionRequest,
  WorkspaceValue,
  WorkspaceId,
  WorkspaceView,
} from '../src/types.ts'
import { RemoteError, type RemoteFailure, type RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

const sid = (id: string): SessionId => id as SessionId
const wid = (id: string): WorkspaceId => id as WorkspaceId

function workspace(
  id: string,
  sessionIds: readonly SessionId[] = [],
  updatedAt = '2026-01-01T00:00:00.000Z',
): WorkspaceView {
  return {
    workspaceId: wid(id),
    path: `/w/${id}`,
    title: id,
    sessionIds,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt,
  }
}

function remoteOk<T>(value: T): RemoteResult<T> {
  return { ok: true, value }
}

function workspaceError(error: RemoteFailure): RemoteResult<never> {
  return { ok: false, error }
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, reject, resolve }
}

class FakeWorkspaceRemote implements WorkspaceRemote {
  readonly calls: Array<{ readonly method: string; readonly request: unknown }> = []
  onCreate: (request: WorkspaceCreateRequest) => Promise<RemoteResult<WorkspaceCreateValue>> = request =>
    Promise.resolve(remoteOk({ workspace: workspace(request.path.split('/').pop() ?? 'workspace'), created: true }))
  onRename: (request: WorkspaceRenameRequest) => Promise<RemoteResult<WorkspaceValue>> = request =>
    Promise.resolve(remoteOk({ workspace: { ...workspace(String(request.workspaceId)), title: request.title } }))
  onDelete: (_request: WorkspaceDeleteRequest) => Promise<RemoteResult<WorkspaceDeleteValue>> = () =>
    Promise.resolve(remoteOk({ deleted: true }))
  onInsertBefore: (
    request: WorkspaceInsertBeforeRequest,
  ) => Promise<RemoteResult<WorkspaceOrderValue>> = request =>
    Promise.resolve(remoteOk({ workspaceIds: [request.workspaceId] }))
  onInsertSessionBefore: (
    request: WorkspaceInsertSessionBeforeRequest,
  ) => Promise<RemoteResult<WorkspaceValue>> = request => Promise.resolve(remoteOk({
    workspace: workspace(String(request.workspaceId), [request.sessionId]),
  }))
  onArchiveSession: (
    request: WorkspaceArchiveSessionRequest,
  ) => Promise<RemoteResult<WorkspaceArchiveValue>> = request =>
    Promise.resolve(remoteOk({ archivedSessionIds: [request.sessionId] }))
  onUnarchiveSession: (
    request: WorkspaceUnarchiveSessionRequest,
  ) => Promise<RemoteResult<WorkspaceArchiveValue>> = request =>
    Promise.resolve(remoteOk({ archivedSessionIds: [request.sessionId] }))

  create(request: WorkspaceCreateRequest): Promise<RemoteResult<WorkspaceCreateValue>> {
    this.record('create', request)
    return this.onCreate(request)
  }

  rename(request: WorkspaceRenameRequest): Promise<RemoteResult<WorkspaceValue>> {
    this.record('rename', request)
    return this.onRename(request)
  }

  delete(request: WorkspaceDeleteRequest): Promise<RemoteResult<WorkspaceDeleteValue>> {
    this.record('delete', request)
    return this.onDelete(request)
  }

  insertBefore(request: WorkspaceInsertBeforeRequest): Promise<RemoteResult<WorkspaceOrderValue>> {
    this.record('insertBefore', request)
    return this.onInsertBefore(request)
  }

  insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest): Promise<RemoteResult<WorkspaceValue>> {
    this.record('insertSessionBefore', request)
    return this.onInsertSessionBefore(request)
  }

  archiveSession(request: WorkspaceArchiveSessionRequest): Promise<RemoteResult<WorkspaceArchiveValue>> {
    this.record('archiveSession', request)
    return this.onArchiveSession(request)
  }

  unarchiveSession(request: WorkspaceUnarchiveSessionRequest): Promise<RemoteResult<WorkspaceArchiveValue>> {
    this.record('unarchiveSession', request)
    return this.onUnarchiveSession(request)
  }

  async *follow(_signal?: AbortSignal): AsyncGenerator<WorkspaceFollowFrame> {}

  private record(method: string, request: unknown): void {
    this.calls.push({ method, request })
  }
}

function modelFor(remote = new FakeWorkspaceRemote()): ClientWorkspaceModel {
  return new ClientWorkspaceModel(remote)
}

function baseline(
  model: ClientWorkspaceModel,
  items: readonly WorkspaceView[] = [],
  archivedSessionIds: readonly SessionId[] = [],
): void {
  model.replaceBaseline({ items, archivedSessionIds })
}

describe('ClientWorkspaceModel', () => {
  it('replaces reconnect state and applies ordered increments', () => {
    const model = modelFor()
    expect(model.getSnapshot()).toMatchObject({ phase: 'pending', state: 'loading' })
    baseline(model, [workspace('old'), workspace('kept')])
    model.upsertView(workspace('new'))
    model.replaceOrder([wid('kept'), wid('new'), wid('old')])
    model.replaceArchived([sid('hidden')])
    model.removeView(wid('old'))
    expect(model.getSnapshot()).toMatchObject({ phase: 'ready', state: 'idle', archivedSessionIds: ['hidden'] })
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['kept', 'new'])

    baseline(model, [workspace('fresh')])
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['fresh'])
    expect(model.getSnapshot().archivedSessionIds).toEqual([])
  })

  it('keeps the last baseline during retry and exposes a terminal stream failure', () => {
    const model = modelFor()
    baseline(model, [workspace('visible')])
    model.handleCarrierFailure()
    expect(model.getSnapshot()).toMatchObject({ phase: 'ready', state: 'loading', error: null })
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['visible'])
    model.handleStreamFailure(new RemoteError('gateway/internal', 'wire down', {}))
    expect(model.getSnapshot()).toMatchObject({
      phase: 'ready', state: 'error', error: { code: 'gateway/internal', message: 'wire down' },
    })
    // An unmarked value never crosses the stream boundary: it is a local fault.
    expect(() => { model.handleStreamFailure('plain failure') }).toThrow()
    baseline(model, [workspace('restored')])
    expect(model.getSnapshot()).toMatchObject({ phase: 'ready', state: 'idle', error: null })
  })

  it('creates by path and prepends the returned row', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    remote.onCreate = request => Promise.resolve(remoteOk({
      workspace: workspace('created', [], '2026-02-01T00:00:00.000Z'),
      created: request.path === '/w/created',
    }))
    await expect(model.create({ path: '/w/created' })).resolves.toMatchObject({ ok: true })
    expect(remote.calls).toContainEqual({ method: 'create', request: { path: '/w/created' } })
    expect(model.getSnapshot().items[0]?.workspaceId).toBe('created')
  })

  it('lets newer stream order outrank unary echoes and rolls failures back', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    baseline(model, [workspace('one'), workspace('two'), workspace('three')])

    const gate = deferred<RemoteResult<WorkspaceOrderValue>>()
    remote.onInsertBefore = () => gate.promise
    const pending = model.insertBefore(wid('three'), wid('one'))
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['three', 'one', 'two'])
    model.replaceOrder([wid('one'), wid('three'), wid('two')])
    gate.resolve(remoteOk({ workspaceIds: [wid('three'), wid('one'), wid('two')] }))
    await pending
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['one', 'three', 'two'])

    remote.onInsertBefore = () => Promise.resolve(workspaceError(
      new RemoteError('workspace/not-found', 'gone', { workspaceId: wid('three') }),
    ))
    const rejected = model.insertBefore(wid('three'))
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['one', 'two', 'three'])
    await expect(rejected).resolves.toMatchObject({ ok: false })
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['one', 'three', 'two'])
  })

  it('keeps a newer optimistic reorder when an older refused call settles', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    baseline(model, [workspace('one'), workspace('two'), workspace('three')])
    const firstGate = deferred<RemoteResult<WorkspaceOrderValue>>()
    const secondGate = deferred<RemoteResult<WorkspaceOrderValue>>()
    let request = 0
    remote.onInsertBefore = () => request++ === 0 ? firstGate.promise : secondGate.promise

    const first = model.insertBefore(wid('three'), wid('one'))
    const second = model.insertBefore(wid('two'), wid('three'))
    firstGate.resolve(workspaceError(
      new RemoteError('workspace/not-found', 'first refused', { workspaceId: wid('three') }),
    ))
    await expect(first).resolves.toMatchObject({ ok: false })
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['two', 'three', 'one'])
    secondGate.resolve(remoteOk({ workspaceIds: [wid('two'), wid('three'), wid('one')] }))
    await expect(second).resolves.toMatchObject({ ok: true })
  })

  it('rolls overlapping rejected reorders back to the last Host order', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    baseline(model, [workspace('one'), workspace('two'), workspace('three')])
    const firstGate = deferred<RemoteResult<WorkspaceOrderValue>>()
    const secondGate = deferred<RemoteResult<WorkspaceOrderValue>>()
    let request = 0
    remote.onInsertBefore = () => request++ === 0 ? firstGate.promise : secondGate.promise

    const first = model.insertBefore(wid('three'), wid('one'))
    const second = model.insertBefore(wid('two'), wid('three'))
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['two', 'three', 'one'])
    firstGate.resolve(workspaceError(new RemoteError('workspace/not-found', 'first rejected', { workspaceId: wid('three') })))
    await expect(first).resolves.toMatchObject({ ok: false })
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['two', 'three', 'one'])
    secondGate.resolve(workspaceError(new RemoteError('workspace/not-found', 'second rejected', { workspaceId: wid('two') })))
    await expect(second).resolves.toMatchObject({ ok: false })
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['one', 'two', 'three'])
  })

  it('retains removal tombstones across later baselines', () => {
    const model = modelFor()
    baseline(model, [workspace('gone'), workspace('kept')])
    model.removeView(wid('gone'))
    model.removeView(wid('gone'))
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['kept'])
    baseline(model, [workspace('gone')])
    expect(model.getSnapshot().items).toEqual([])
  })

  it('does not let delayed unary data resurrect a removed Workspace', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    baseline(model, [workspace('gone')])
    const gate = deferred<RemoteResult<WorkspaceValue>>()
    remote.onRename = () => gate.promise
    const rename = model.rename(wid('gone'), 'late')
    model.removeView(wid('gone'))
    gate.resolve(remoteOk({ workspace: { ...workspace('gone'), title: 'late' } }))
    await expect(rename).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().items).toEqual([])
  })

  it('applies Workspace mutation echoes and leaves failed results unchanged', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    baseline(model, [workspace('one', [sid('first'), sid('second')])], [sid('archived')])

    remote.onRename = () => Promise.resolve(workspaceError(new RemoteError('workspace/not-found', 'gone', { workspaceId: wid('one') })))
    await expect(model.rename(wid('one'), 'ignored')).resolves.toMatchObject({ ok: false })
    expect(model.getSnapshot().items[0]?.title).toBe('one')

    remote.onDelete = () => Promise.resolve(workspaceError(new RemoteError('workspace/not-found', 'gone', { workspaceId: wid('one') })))
    await expect(model.delete(wid('one'))).resolves.toMatchObject({ ok: false })
    expect(model.getSnapshot().items).toHaveLength(1)

    remote.onInsertSessionBefore = request => Promise.resolve(remoteOk({
      workspace: workspace('one', [request.sessionId, sid('first')], '2026-02-01T00:00:00.000Z'),
    }))
    await expect(model.insertSessionBefore(wid('one'), sid('second'), sid('first')))
      .resolves.toMatchObject({ ok: true })
    expect(remote.calls).toContainEqual({
      method: 'insertSessionBefore',
      request: { workspaceId: 'one', sessionId: 'second', beforeSessionId: 'first' },
    })

    remote.onInsertSessionBefore = () => Promise.resolve(workspaceError(
      new RemoteError('workspace/move-invalid', 'invalid move', { workspaceId: wid('one'), sessionId: sid('second') }),
    ))
    await expect(model.insertSessionBefore(wid('one'), sid('second')))
      .resolves.toMatchObject({ ok: false })
    expect(remote.calls).toContainEqual({
      method: 'insertSessionBefore',
      request: { workspaceId: 'one', sessionId: 'second' },
    })

    remote.onArchiveSession = () => Promise.resolve(workspaceError(
      new RemoteError('session/not-found', 'missing', { sessionId: sid('missing') }),
    ))
    await expect(model.archiveSession(sid('missing'))).resolves.toMatchObject({ ok: false })
    expect(model.getSnapshot().archivedSessionIds).toEqual(['archived'])
    remote.onArchiveSession = request => Promise.resolve(remoteOk({ archivedSessionIds: [request.sessionId] }))
    await expect(model.archiveSession(sid('fresh'))).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().archivedSessionIds).toEqual(['fresh'])

    remote.onUnarchiveSession = () => Promise.resolve(workspaceError(
      new RemoteError('session/not-found', 'missing', { sessionId: sid('missing') }),
    ))
    await expect(model.unarchiveSession(sid('missing'))).resolves.toMatchObject({ ok: false })
    expect(model.getSnapshot().archivedSessionIds).toEqual(['fresh'])
    remote.onUnarchiveSession = () => Promise.resolve(remoteOk({ archivedSessionIds: [] }))
    await expect(model.unarchiveSession(sid('fresh'))).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().archivedSessionIds).toEqual([])
    expect(remote.calls).toContainEqual({ method: 'unarchiveSession', request: { sessionId: 'fresh' } })
  })

  it('keeps the latest unarchive reply when overlapping requests settle out of order', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    baseline(model, [], [sid('first'), sid('second')])
    const firstGate = deferred<RemoteResult<WorkspaceArchiveValue>>()
    const secondGate = deferred<RemoteResult<WorkspaceArchiveValue>>()
    let request = 0
    remote.onUnarchiveSession = () => request++ === 0 ? firstGate.promise : secondGate.promise

    const first = model.unarchiveSession(sid('first'))
    const second = model.unarchiveSession(sid('second'))
    secondGate.resolve(remoteOk({ archivedSessionIds: [] }))
    await expect(second).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().archivedSessionIds).toEqual([])
    firstGate.resolve(remoteOk({ archivedSessionIds: [sid('second')] }))
    await expect(first).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().archivedSessionIds).toEqual([])
  })

  it('keeps a pushed archive set when an unarchive reply lands later', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    baseline(model, [], [sid('first')])
    const gate = deferred<RemoteResult<WorkspaceArchiveValue>>()
    remote.onUnarchiveSession = () => gate.promise

    const pending = model.unarchiveSession(sid('first'))
    model.replaceArchived([sid('first'), sid('second')])
    gate.resolve(remoteOk({ archivedSessionIds: [] }))
    await expect(pending).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().archivedSessionIds).toEqual(['first', 'second'])
  })

  it('keeps the latest archive reply when overlapping requests settle out of order', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    const firstGate = deferred<RemoteResult<WorkspaceArchiveValue>>()
    const secondGate = deferred<RemoteResult<WorkspaceArchiveValue>>()
    let request = 0
    remote.onArchiveSession = () => request++ === 0 ? firstGate.promise : secondGate.promise

    const first = model.archiveSession(sid('first'))
    const second = model.archiveSession(sid('second'))
    secondGate.resolve(remoteOk({ archivedSessionIds: [sid('first'), sid('second')] }))
    await expect(second).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().archivedSessionIds).toEqual(['first', 'second'])
    firstGate.resolve(remoteOk({ archivedSessionIds: [sid('first')] }))
    await expect(first).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().archivedSessionIds).toEqual(['first', 'second'])
  })

  it('keeps a baseline archive set when an unarchive reply lands later', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    baseline(model, [], [sid('first')])
    const gate = deferred<RemoteResult<WorkspaceArchiveValue>>()
    remote.onUnarchiveSession = () => gate.promise

    const pending = model.unarchiveSession(sid('first'))
    baseline(model, [], [sid('second')])
    gate.resolve(remoteOk({ archivedSessionIds: [] }))
    await expect(pending).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().archivedSessionIds).toEqual(['second'])
  })

  it('keeps the newest row and places Workspaces missing from partial orders last', async () => {
    const model = modelFor()
    baseline(model, [
      workspace('one', [], '2026-02-01T00:00:00.000Z'),
      workspace('two'),
    ])
    model.upsertView(workspace('one', [], '2025-12-01T00:00:00.000Z'))
    expect(model.getSnapshot().items[0]?.updatedAt).toBe('2026-02-01T00:00:00.000Z')
    model.upsertView(workspace('one', [sid('new')], '2026-03-01T00:00:00.000Z'))
    expect(model.getSnapshot().items[0]?.sessionIds).toEqual(['new'])

    model.replaceOrder([wid('one')])
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['one', 'two'])
    model.replaceOrder([wid('two')])
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['two', 'one'])
    model.replaceOrder([wid('one')])
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['one', 'two'])

    await expect(model.insertBefore(wid('one'), wid('one'))).resolves.toMatchObject({ ok: true })
    expect(model.getSnapshot().items.map(item => item.workspaceId)).toEqual(['one', 'two'])
  })

  it('notifies subscribers and cancels a queued notification after an immediate delete echo', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    baseline(model, [workspace('gone')])
    await Promise.resolve()
    const listener = vi.fn()
    const unsubscribe = model.subscribe(listener)

    const deletion = model.delete(wid('gone'))
    model.removeView(wid('gone'))
    await expect(deletion).resolves.toMatchObject({ ok: true })
    expect(listener).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(listener).toHaveBeenCalledOnce()

    unsubscribe()
    model.handleCarrierFailure()
    await Promise.resolve()
    expect(listener).toHaveBeenCalledOnce()
  })

  it('removes from a unary delete echo before the operation resolves', async () => {
    const remote = new FakeWorkspaceRemote()
    const model = modelFor(remote)
    baseline(model, [workspace('gone')])
    await expect(model.delete(wid('gone'))).resolves.toMatchObject({ ok: true })
    expect(remote.calls).toContainEqual({ method: 'delete', request: { workspaceId: 'gone' } })
    expect(model.getSnapshot().items).toEqual([])
    model.removeView(wid('gone'))
    expect(model.getSnapshot().items).toEqual([])
  })
})
