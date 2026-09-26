/** Directory subscriptions and read settlements through the face's real store actions. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceDirectoryListing } from '@deepseek-ai/dsh-api-workspace-files/types'
import { childPath, createList, filesFace } from '../src/client/face.ts'
import type { WorkspaceFilesListRemote } from '../src/client/face.ts'
import { createFilesStore } from '../src/client/store.ts'
import type { DirLevel } from '../src/client/store.ts'
import { DirectoryNode } from '../src/client/directory-node.ts'
import { scriptedList } from './scripted-list.client.ts'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'

const SESSION = 's-1' as SessionId
const ROOT = '/work/app'
const TAB = 'tab-1' as TabId

const LEVEL: DirLevel = { entries: [{ name: 'src', type: 'directory' }], truncated: false }

function mount() {
  const instance = createFilesStore().create()
  const script = scriptedList()
  const face = filesFace(script.list, script.watch)(SESSION, instance.actions)
  const controller = new AbortController()
  onTestFinished(async () => {
    controller.abort()
    await script.dispose()
  })
  return { ...script, face, controller, instance, actions: instance.actions, snapshot: () => instance.getSnapshot().byTab[TAB] }
}

describe('filesFace', () => {
  it.each(['/', 'C:/', 'C:\\', '/work/app/'])('expands a child of the exact root key %s', async (root) => {
    const h = mount()
    const child = childPath(root, 'src')
    h.face.start(TAB, root, h.controller.signal)
    await h.watches.ready(root)
    await h.settle({ ok: true, value: LEVEL })
    h.face.toggle(TAB, root, child, [root], h.controller.signal)
    const stream = await h.watches.ready(child)
    expect(h.snapshot()?.expanded).toEqual([root, child])
    expect(h.list).toHaveBeenLastCalledWith(SESSION, child, stream.signal)
    await h.settle({ ok: true, value: { entries: [], truncated: false } })
  })

  it('subscribes to the root before listing it and waits for ready', async () => {
    const { face, list, watches, settle, snapshot, controller } = mount()
    face.start(TAB, ROOT, controller.signal)
    const stream = await watches.forPath(ROOT)
    expect(stream.sessionId).toBe(SESSION)
    expect(stream.signal.aborted).toBe(false)
    expect(list).not.toHaveBeenCalled()
    expect(snapshot()).toEqual({ root: ROOT, expanded: [ROOT], levels: {}, scrollTop: 0, autoRefresh: true })
    await stream.deliver('ready')
    expect(list).toHaveBeenCalledWith(SESSION, ROOT, stream.signal)
    expect(snapshot()!.levels[ROOT]).toEqual({ kind: 'loading' })
    await settle({ ok: true, value: LEVEL })
    expect(snapshot()!.levels[ROOT]).toEqual({ kind: 'ready', level: LEVEL })
  })

  it('records a failed listing under its level', async () => {
    const { face, watches, settle, snapshot, controller } = mount()
    face.start(TAB, ROOT, controller.signal)
    await watches.ready(ROOT)
    const error = new RemoteError('workspace-file/not-directory', 'not a directory', { path: ROOT, kind: 'file' })
    await settle({ ok: false, error })
    expect(snapshot()!.levels[ROOT]).toEqual({ kind: 'failed', failure: error })
  })

  it('subscribes on expansion, releases on collapse, and rereads a reopened directory after ready', async () => {
    const { face, list, watches, settle, snapshot, controller } = mount()
    const { signal } = controller
    const child = `${ROOT}/src`
    face.start(TAB, ROOT, signal)
    const rootStream = await watches.ready(ROOT)
    await settle({ ok: true, value: LEVEL })
    face.toggle(TAB, ROOT, child, [ROOT], signal)
    expect(snapshot()!.expanded).toEqual([ROOT, child])
    expect(list).toHaveBeenCalledTimes(1)
    const childStream = await watches.ready(child)
    expect(list).toHaveBeenLastCalledWith(SESSION, child, childStream.signal)
    await settle({ ok: true, value: LEVEL })
    face.toggle(TAB, ROOT, child, [ROOT, child], signal)
    expect(childStream.signal.aborted).toBe(true)
    await childStream.released.promise
    expect(rootStream.signal.aborted).toBe(false)
    expect(snapshot()!.expanded).toEqual([ROOT])
    expect(list).toHaveBeenCalledTimes(2)
    face.toggle(TAB, ROOT, child, [ROOT], signal)
    expect(snapshot()!.levels[child]).toEqual({ kind: 'ready', level: LEVEL })
    expect(list).toHaveBeenCalledTimes(2)
    const reopened = await watches.ready(child, 1)
    expect(reopened.signal).not.toBe(childStream.signal)
    expect(reopened.signal.aborted).toBe(false)
    expect(list).toHaveBeenLastCalledWith(SESSION, child, reopened.signal)
    const current: DirLevel = { entries: [{ name: 'new.ts', type: 'file' }], truncated: false }
    await settle({ ok: true, value: current })
    expect(snapshot()!.levels[child]).toEqual({ kind: 'ready', level: current })
  })

  it.each([false, true])('keeps deep expansion intent while restoring an ancestor (reopen: %s)', async (reopen) => {
    const h = mount()
    const refresh = vi.spyOn(DirectoryNode.prototype, 'refresh')
    onTestFinished(() => { refresh.mockRestore() })
    const src = `${ROOT}/src`
    const components = `${src}/components`
    const nested = `${components}/nested`
    const srcLevel: DirLevel = { entries: [{ name: 'components', type: 'directory' }], truncated: false }
    const componentsLevel: DirLevel = { entries: [{ name: 'nested', type: 'directory' }], truncated: false }
    const empty: DirLevel = { entries: [], truncated: false }
    const toggle = (parent: string, path: string): void => {
      h.face.toggle(TAB, parent, path, h.snapshot()!.expanded, h.controller.signal)
    }
    h.face.start(TAB, ROOT, h.controller.signal)
    await h.watches.ready(ROOT)
    await h.settle({ ok: true, value: LEVEL })
    for (const [parent, path, level] of [[ROOT, src, srcLevel], [src, components, componentsLevel], [components, nested, empty]] as const) {
      toggle(parent, path)
      await h.watches.ready(path)
      await h.settle({ ok: true, value: level })
    }
    toggle(ROOT, src)
    await Promise.all(h.watches.opened.slice(1).map(stream => stream.released.promise))
    toggle(ROOT, src)
    await h.watches.ready(src, 1)
    expect(h.outstanding()).toEqual([src])
    expect(h.watches.opened.filter(stream => !stream.signal.aborted).map(stream => stream.path)).toEqual([ROOT, src])

    toggle(components, nested)
    expect(h.snapshot()!.expanded).not.toContain(nested)
    if (reopen) {
      toggle(components, nested)
      expect(h.snapshot()!.expanded).toContain(nested)
    }
    await h.settle({ ok: true, value: srcLevel })
    await h.watches.ready(components, 1)
    const reading = refresh.mock.results.at(-1)
    if (reading?.type !== 'return') throw new Error('Expected the restored directory to start listing')
    await h.settle({ ok: true, value: componentsLevel })
    await reading.value
    expect(h.watches.opened.filter(stream => stream.path === nested)).toHaveLength(reopen ? 2 : 1)
    if (reopen) {
      await h.watches.ready(nested, 1)
      await h.settle({ ok: true, value: empty })
    }
  })

  it('abort forgets the bucket and a late settlement writes nothing', async () => {
    const { face, watches, settle, snapshot, controller } = mount()
    face.start(TAB, ROOT, controller.signal)
    const stream = await watches.ready(ROOT)
    controller.abort()
    expect(stream.signal.aborted).toBe(true)
    expect(snapshot()).toBeUndefined()
    await settle({ ok: true, value: LEVEL })
    await stream.released.promise
    expect(snapshot()).toBeUndefined()
  })

  it('abort before ready closes the subscription without starting a listing', async () => {
    const { face, list, watches, snapshot, controller } = mount()
    face.start(TAB, ROOT, controller.signal)
    const stream = await watches.forPath(ROOT)
    controller.abort()
    await stream.released.promise
    expect(stream.signal.aborted).toBe(true)
    expect(list).not.toHaveBeenCalled()
    expect(snapshot()).toBeUndefined()
  })

  it('makes no request for a record that already ended', () => {
    const { face, list, controller } = mount()
    controller.abort()
    face.load(TAB, ROOT, controller.signal)
    expect(list).not.toHaveBeenCalled()
  })

  it('ignores expansion after cancellation or when its parent is not active', async () => {
    const h = mount()
    h.face.toggle(TAB, ROOT, `${ROOT}/src`, [ROOT], h.controller.signal)
    expect(h.snapshot()).toBeUndefined()
    h.face.start(TAB, ROOT, h.controller.signal)
    const stream = await h.watches.ready(ROOT)
    await h.settle({ ok: true, value: LEVEL })
    const before = h.snapshot()
    h.face.toggle(TAB, `${ROOT}/src`, `${ROOT}/src/nested`, [ROOT], h.controller.signal)
    expect(h.snapshot()).toBe(before)
    expect(h.watches.opened.map(watch => watch.path)).toEqual([ROOT])
    h.controller.abort()
    await stream.released.promise
    h.face.toggle(TAB, ROOT, `${ROOT}/src`, [ROOT], h.controller.signal)
    expect(h.snapshot()).toBeUndefined()
    expect(h.list).toHaveBeenCalledTimes(1)
    expect(h.watches.opened).toHaveLength(1)
  })

  it.each([new Error('watch disconnected'), 'watch disconnected'])('records a watch failure without an Error prefix: %s', async (failure) => {
    const h = mount()
    const reported = Promise.withResolvers<undefined>()
    const unsubscribe = h.instance.subscribe(() => {
      const level = h.snapshot()?.levels[ROOT]
      if (level?.kind === 'ready' && level.failure !== undefined) reported.resolve(undefined)
    })
    onTestFinished(unsubscribe)
    h.face.start(TAB, ROOT, h.controller.signal)
    const stream = await h.watches.forPath(ROOT)
    stream.fail(failure)
    expect((await h.waitForList(0)).path).toBe(ROOT)
    await h.settle({ ok: true, value: LEVEL })
    await reported.promise
    expect(h.snapshot()!.levels[ROOT]).toMatchObject({
      kind: 'ready', level: LEVEL,
      failure: { code: 'gateway/internal', message: 'watch disconnected' },
    })
    await stream.released.promise
  })

  it('does not publish a watch failure when the tab closes during its fallback list', async () => {
    const close = vi.spyOn(DirectoryNode.prototype, 'close')
    onTestFinished(() => { close.mockRestore() })
    const h = mount()
    h.face.start(TAB, ROOT, h.controller.signal)
    const stream = await h.watches.forPath(ROOT)
    stream.fail(new Error('watch disconnected'))
    await h.waitForList(0)
    h.controller.abort()
    const closing = close.mock.results[0]
    if (closing?.type !== 'return') throw new Error('expected the tab to close its directory tree')
    await h.settle({ ok: true, value: LEVEL })
    await expect(closing.value).resolves.toBeUndefined()
    expect(h.snapshot()).toBeUndefined()
    expect(h.watches.opened).toHaveLength(1)
  })

  it('lets the latest listing of a level win, whichever settles first', async () => {
    const { face, list, watches, settle, settleLatest, snapshot, outstanding, controller } = mount()
    const { signal } = controller
    const older: DirLevel = { entries: [{ name: 'old.txt', type: 'file' }], truncated: false }
    face.start(TAB, ROOT, signal)
    await watches.ready(ROOT)
    face.load(TAB, ROOT, signal)
    expect(list).toHaveBeenCalledTimes(2)
    expect(outstanding()).toEqual([ROOT, ROOT])
    await settleLatest({ ok: true, value: LEVEL })
    expect(snapshot()!.levels[ROOT]).toEqual({ kind: 'ready', level: LEVEL })
    await settle({ ok: true, value: older })
    expect(snapshot()!.levels[ROOT]).toEqual({ kind: 'ready', level: LEVEL })
    face.load(TAB, ROOT, signal)
    face.load(TAB, ROOT, signal)
    await settleLatest({ ok: true, value: LEVEL })
    await settle({ ok: false, error: new RemoteError('workspace-file/not-found', 'gone', { path: ROOT }) })
    expect(snapshot()!.levels[ROOT]).toEqual({ kind: 'ready', level: LEVEL })
  })

  it('manually refreshes expanded nodes while preserving cached levels, scroll, and the automatic setting', async () => {
    const { face, watches, settle, waitForList, snapshot, controller, actions } = mount()
    const child = `${ROOT}/src`
    const collapsed = `${ROOT}/docs`
    face.start(TAB, ROOT, controller.signal)
    await watches.ready(ROOT)
    await settle({ ok: true, value: LEVEL })
    face.toggle(TAB, ROOT, child, snapshot()!.expanded, controller.signal)
    await watches.ready(child)
    await settle({ ok: true, value: LEVEL })
    actions.loaded(TAB, collapsed, LEVEL)
    actions.scrolled(TAB, 120)
    face.setAutoRefresh(TAB, false)
    const cached = snapshot()!

    face.refresh(TAB)
    expect((await waitForList(2)).path).toBe(ROOT)
    expect(snapshot()!.levels).toEqual(cached.levels)
    await settle({ ok: true, value: LEVEL })
    expect((await waitForList(3)).path).toBe(child)
    expect(snapshot()!.levels[child]).toEqual(cached.levels[child])
    await settle({ ok: true, value: { entries: [], truncated: false } })
    expect(snapshot()!.levels[collapsed]).toEqual(cached.levels[collapsed])
    expect(snapshot()).toMatchObject({ expanded: [ROOT, child], scrollTop: 120, autoRefresh: false })
    expect(watches.opened.map(stream => stream.path)).toEqual([ROOT, child])
    expect(watches.opened.every(stream => !stream.signal.aborted)).toBe(true)
  })
})

describe('createList', () => {
  it('passes the session, the absolute path, and the signal through, and keeps entries and truncation', async () => {
    const listing: WorkspaceDirectoryListing = {
      path: 'src',
      entries: [{ name: 'a.ts', type: 'file', size: 3 }],
      truncated: true,
    }
    const list = vi.fn<WorkspaceFilesListRemote['workspaceFiles']['list']>()
      .mockResolvedValue({ ok: true, value: listing })
    const signal = new AbortController().signal
    const result = await createList({ workspaceFiles: { list } })(SESSION, `${ROOT}/src`, signal)
    expect(list).toHaveBeenCalledWith(SESSION, `${ROOT}/src`, signal)
    expect(result).toEqual({ ok: true, value: { entries: listing.entries, truncated: true } })
  })

  it('returns a failure as the endpoint reported it', async () => {
    const error = new RemoteError('workspace-file/not-directory', 'file', { path: 'x', kind: 'file' })
    const list = vi.fn<WorkspaceFilesListRemote['workspaceFiles']['list']>()
      .mockResolvedValue({ ok: false, error })
    const result = await createList({ workspaceFiles: { list } })(SESSION, `${ROOT}/x`, new AbortController().signal)
    expect(result).toEqual({ ok: false, error })
  })
})

describe('childPath', () => {
  it('joins with one slash whatever the parent ends in', () => {
    expect(childPath('/work/app', 'src')).toBe('/work/app/src')
    expect(childPath('/work/app/', 'src')).toBe('/work/app/src')
    expect(childPath('/', 'etc')).toBe('/etc')
    expect(childPath('C:\\work\\', 'src')).toBe('C:\\work/src')
  })
})
