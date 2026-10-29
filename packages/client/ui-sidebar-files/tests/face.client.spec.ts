/** Directory subscriptions and read settlements through the face's real store actions. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Mock } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceDirectoryListing } from '@deepseek-ai/dsh-api-workspace-files/types'
import { canOpenOf, createList, filesFace } from '../src/client/face.ts'
import type { FilesInjected, TabTypeRegistry, WorkspaceFilesListRemote } from '../src/client/face.ts'
import { childPath } from '../src/client/store.ts'
import { createFilesStore } from '../src/client/store.ts'
import type { DirLevel } from '../src/client/store.ts'
import { DirectoryNode } from '../src/client/directory-node.ts'
import { scriptedList } from './scripted-list.client.ts'
import { sessionFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type { PaneId, TabId } from '@deepseek-ai/dsh-client-ui-dockkit'

const SESSION = 's-1' as SessionId
const ROOT = '/work/app'
const PANE = 'pane-1' as PaneId
const TAB = 'tab-1' as TabId

const LEVEL: DirLevel = { entries: [{ name: 'src', type: 'directory' }], truncated: false }

/** Every address opens. */
const CAN_OPEN = { getSnapshot: () => () => true, subscribe: () => () => {} }

function mount() {
  const instance = createFilesStore().create()
  const script = scriptedList()
  /** The tabs the face placed itself beside, with each placement's release. */
  const placed: { readonly tabId: TabId; readonly face: FilesInjected; readonly release: Mock<() => void> }[] = []
  const face = filesFace(script.list, script.watch, CAN_OPEN, () => ({ getSnapshot: () => ({ address: '', params: undefined, revision: 0 }), subscribe: () => () => {} }))(SESSION, instance, (tabId, bound) => {
    const release = vi.fn<() => void>()
    placed.push({ tabId, face: bound, release })
    return release
  })
  // The lifetime of the tab the navigator is drawn for.
  const controller = new AbortController()
  let release: (() => void) | undefined
  /** A navigator drawn beside the tab's content in the pane. */
  const attach = (): void => { release = face.attach(PANE, TAB, controller.signal) }
  /** The navigator goes and its tab closes; the pane is forgotten once the task ends. */
  const leave = async (): Promise<void> => {
    release?.()
    controller.abort()
    await Promise.resolve()
  }
  onTestFinished(async () => {
    release?.()
    controller.abort()
    await script.dispose()
  })
  return {
    ...script, face, controller, attach, leave, instance, placed, actions: instance.actions,
    snapshot: () => instance.getSnapshot().byPane[PANE]?.tree,
  }
}

describe('filesFace', () => {
  it.each(['/', 'C:/', 'C:\\', '/work/app/'])('expands a child of the exact root key %s', async (root) => {
    const h = mount()
    const child = childPath(root, 'src')
    h.attach()
    h.face.hold(PANE, root)
    await h.watches.ready(root)
    await h.settle({ ok: true, value: LEVEL })
    h.face.toggle(PANE, root, child, [root])
    const stream = await h.watches.ready(child)
    expect(h.snapshot()?.expanded).toEqual([root, child])
    expect(h.list).toHaveBeenLastCalledWith(SESSION, child, stream.signal)
    await h.settle({ ok: true, value: { entries: [], truncated: false } })
  })

  it('subscribes to the root before listing it and waits for ready', async () => {
    const { face, list, watches, settle, snapshot, attach } = mount()
    attach()
    face.hold(PANE, ROOT)
    const stream = await watches.forPath(ROOT)
    expect(stream.sessionId).toBe(SESSION)
    expect(stream.signal.aborted).toBe(false)
    expect(list).not.toHaveBeenCalled()
    expect(snapshot()).toEqual({ root: ROOT, expanded: [ROOT], levels: {}, autoRefresh: true })
    await stream.deliver('ready')
    expect(list).toHaveBeenCalledWith(SESSION, ROOT, stream.signal)
    expect(snapshot()!.levels[ROOT]).toEqual({ kind: 'loading' })
    await settle({ ok: true, value: LEVEL })
    expect(snapshot()!.levels[ROOT]).toEqual({ kind: 'ready', level: LEVEL })
  })

  it('records a failed listing under its level', async () => {
    const { face, watches, settle, snapshot, attach } = mount()
    attach()
    face.hold(PANE, ROOT)
    await watches.ready(ROOT)
    const error = new RemoteError('workspace-file/not-directory', 'not a directory', { path: ROOT, kind: 'file' })
    await settle({ ok: false, error })
    expect(snapshot()!.levels[ROOT]).toEqual({ kind: 'failed', failure: error })
  })

  it('subscribes on expansion, releases on collapse, and rereads a reopened directory after ready', async () => {
    const { face, list, watches, settle, snapshot, attach } = mount()
    const child = `${ROOT}/src`
    attach()
    face.hold(PANE, ROOT)
    const rootStream = await watches.ready(ROOT)
    await settle({ ok: true, value: LEVEL })
    face.toggle(PANE, ROOT, child, [ROOT])
    expect(snapshot()!.expanded).toEqual([ROOT, child])
    expect(list).toHaveBeenCalledTimes(1)
    const childStream = await watches.ready(child)
    expect(list).toHaveBeenLastCalledWith(SESSION, child, childStream.signal)
    await settle({ ok: true, value: LEVEL })
    face.toggle(PANE, ROOT, child, [ROOT, child])
    expect(childStream.signal.aborted).toBe(true)
    await childStream.released.promise
    expect(rootStream.signal.aborted).toBe(false)
    expect(snapshot()!.expanded).toEqual([ROOT])
    expect(list).toHaveBeenCalledTimes(2)
    face.toggle(PANE, ROOT, child, [ROOT])
    // Reopened, the kept level draws at once and is marked until its listing settles.
    expect(snapshot()!.levels[child]).toEqual({ kind: 'ready', level: LEVEL, refreshing: true })
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
      h.face.toggle(PANE, parent, path, h.snapshot()!.expanded)
    }
    h.attach()
    h.face.hold(PANE, ROOT)
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

  it('forgets the pane once its last tab closes, and a late settlement writes nothing', async () => {
    const { face, watches, settle, snapshot, attach, leave } = mount()
    attach()
    face.hold(PANE, ROOT)
    const stream = await watches.ready(ROOT)
    await leave()
    expect(stream.signal.aborted).toBe(true)
    expect(snapshot()).toBeUndefined()
    await settle({ ok: true, value: LEVEL })
    await stream.released.promise
    expect(snapshot()).toBeUndefined()
  })

  it('a pane forgotten before ready closes the subscription without starting a listing', async () => {
    const { face, list, watches, snapshot, attach, leave } = mount()
    attach()
    face.hold(PANE, ROOT)
    const stream = await watches.forPath(ROOT)
    await leave()
    await stream.released.promise
    expect(stream.signal.aborted).toBe(true)
    expect(list).not.toHaveBeenCalled()
    expect(snapshot()).toBeUndefined()
  })

  it('starts nothing for a pane that was never attached or whose tab already closed', () => {
    const { face, watches, snapshot, controller, instance } = mount()
    face.hold(PANE, ROOT)()
    controller.abort()
    face.attach(PANE, TAB, controller.signal)()
    face.hold(PANE, ROOT)
    face.scrolled(PANE, 40)
    expect(watches.opened).toEqual([])
    expect(snapshot()).toBeUndefined()
    expect(instance.getSnapshot().byPane).toEqual({})
  })

  it('shows and focuses only a pane with a drawing recorded, even one its navigator has not attached yet', async () => {
    const { face, instance } = mount()
    face.focus(PANE)
    expect(instance.getSnapshot().byPane).toEqual({})
    // A tab that just moved draws in its new pane before that drawing's effects attach it.
    const moved = 'pane-moved' as PaneId
    face.toggleDrawn(moved, {} as HTMLElement)
    face.focus(moved)
    // The store records only attached panes, so the navigator shows once those effects attach it.
    expect(instance.getSnapshot().byPane[moved]).toBeUndefined()
    const tab = new AbortController()
    onTestFinished(() => { tab.abort() })
    face.attach(moved, 'tab-moved' as TabId, tab.signal)
    expect(instance.getSnapshot().byPane[moved]?.open).toBe(true)
    // The tree drawn there next takes the keyboard.
    const body = { scrollTop: 0, focus: vi.fn() }
    face.bodyDrawn(moved, `${ROOT}/a.ts`, body as Partial<HTMLElement> as HTMLElement)
    await Promise.resolve()
    expect(body.focus).toHaveBeenCalledTimes(1)
    face.hide('pane-never' as PaneId)
    expect(instance.getSnapshot().byPane['pane-never' as PaneId]).toBeUndefined()
  })

  it('ends a reveal still listing an ancestor when the reader collapses that ancestor', async () => {
    const h = mount()
    const src = `${ROOT}/src`
    const address = sessionFileAddress(SESSION, 'src/a.ts')
    const body = { scrollTop: 0, contains: () => false, ownerDocument: {} as Document } as Partial<HTMLElement> as HTMLElement
    h.attach()
    h.face.hold(PANE, ROOT)
    await h.watches.ready(ROOT)
    await h.settle({ ok: true, value: LEVEL })
    h.face.bodyDrawn(PANE, address, body)
    await h.watches.ready(src)
    expect(h.outstanding()).toEqual([src])
    h.face.toggle(PANE, ROOT, src, h.snapshot()!.expanded)
    expect(h.snapshot()!.expanded).toEqual([ROOT])
    await h.settle({ ok: true, value: { entries: [{ name: 'a.ts', type: 'file' }], truncated: false } })
    // The tree drawn again for the same file does not reveal it again either.
    h.face.bodyDrawn(PANE, address, null)
    h.face.bodyDrawn(PANE, address, body)
    expect(h.snapshot()!.expanded).toEqual([ROOT])
    expect(h.list).toHaveBeenCalledTimes(2)
    expect(h.watches.opened.filter(stream => stream.path === src)).toHaveLength(1)
  })

  it('keeps one tree for repeated holds at its root and replaces it at another root', async () => {
    const h = mount()
    h.attach()
    // A second navigator for the same tab in the same pane changes nothing, and releases once.
    const again = h.face.attach(PANE, TAB, h.controller.signal)
    again()
    again()
    h.face.hold(PANE, ROOT)
    const first = await h.watches.ready(ROOT)
    await h.settle({ ok: true, value: LEVEL })
    h.face.hold(PANE, ROOT)
    expect(h.watches.opened).toHaveLength(1)
    expect(h.snapshot()!.levels[ROOT]).toEqual({ kind: 'ready', level: LEVEL })

    const other = '/work/other'
    h.face.hold(PANE, other)
    await first.released.promise
    expect(h.snapshot()).toEqual({ root: other, levels: {}, expanded: [other], autoRefresh: true })
    const second = await h.watches.ready(other)
    await h.settle({ ok: true, value: LEVEL })
    expect(h.snapshot()!.levels[other]).toEqual({ kind: 'ready', level: LEVEL })
    await h.leave()
    await second.released.promise
  })

  it('closes the listing once no hold remains at the end of the task, and lists the kept tree again in place', async () => {
    const h = mount()
    const child = `${ROOT}/src`
    h.attach()
    const release = h.face.hold(PANE, ROOT)
    const rootStream = await h.watches.ready(ROOT)
    await h.settle({ ok: true, value: LEVEL })
    h.face.toggle(PANE, ROOT, child, [ROOT])
    const childStream = await h.watches.ready(child)
    await h.settle({ ok: true, value: LEVEL })
    h.face.setAutoRefresh(PANE, false)

    // A release followed by a hold in the same task, as a tab switch does, keeps the listing.
    release()
    release()
    const next = h.face.hold(PANE, ROOT)
    await Promise.resolve()
    expect(rootStream.signal.aborted).toBe(false)
    next()
    await Promise.resolve()
    expect(rootStream.signal.aborted).toBe(true)
    expect(childStream.signal.aborted).toBe(true)
    const kept = h.snapshot()!
    expect(kept).toMatchObject({ expanded: [ROOT, child], autoRefresh: false })

    // The kept levels draw at once and are marked until they are listed again.
    h.face.hold(PANE, ROOT)
    expect(h.snapshot()!.levels).toEqual({
      [ROOT]: { ...kept.levels[ROOT], refreshing: true },
      [child]: { ...kept.levels[child], refreshing: true },
    })
    await h.watches.ready(ROOT, 1)
    await h.settle({ ok: true, value: LEVEL })
    await h.watches.ready(child, 1)
    await h.settle({ ok: true, value: LEVEL })
    expect(h.snapshot()).toMatchObject({ expanded: [ROOT, child], autoRefresh: false })
    expect(h.list).toHaveBeenCalledTimes(4)
  })

  it('writes nothing for a refresh still listing when the pane leaves the layout', async () => {
    const refreshTree = vi.spyOn(DirectoryNode.prototype, 'refreshTree')
    onTestFinished(() => { refreshTree.mockRestore() })
    const h = mount()
    const child = `${ROOT}/src`
    h.attach()
    h.face.hold(PANE, ROOT)
    await h.watches.ready(ROOT)
    await h.settle({ ok: true, value: LEVEL })
    h.face.toggle(PANE, ROOT, child, [ROOT])
    await h.watches.ready(child)
    await h.settle({ ok: true, value: LEVEL })
    h.face.refresh(PANE)
    await h.waitForList(2)
    await h.leave()
    // The root's listing settles after the tree is forgotten; its open child must not list or write.
    await h.settle({ ok: true, value: LEVEL })
    const refreshing = refreshTree.mock.results[0]
    if (refreshing?.type !== 'return') throw new Error('expected the refresh to start')
    await expect(refreshing.value).resolves.toBeUndefined()
    expect(h.snapshot()).toBeUndefined()
    expect(h.list).toHaveBeenCalledTimes(3)
  })

  it('ignores expansion after cancellation or when its parent is not active', async () => {
    const h = mount()
    h.face.toggle(PANE, ROOT, `${ROOT}/src`, [ROOT])
    expect(h.snapshot()).toBeUndefined()
    h.attach()
    h.face.hold(PANE, ROOT)
    const stream = await h.watches.ready(ROOT)
    await h.settle({ ok: true, value: LEVEL })
    const before = h.snapshot()
    h.face.toggle(PANE, `${ROOT}/src`, `${ROOT}/src/nested`, [ROOT])
    expect(h.snapshot()).toBe(before)
    expect(h.watches.opened.map(watch => watch.path)).toEqual([ROOT])
    await h.leave()
    await stream.released.promise
    h.face.toggle(PANE, ROOT, `${ROOT}/src`, [ROOT])
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
    h.attach()
    h.face.hold(PANE, ROOT)
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

  it('does not publish a watch failure when the pane closes during its fallback list', async () => {
    const close = vi.spyOn(DirectoryNode.prototype, 'close')
    onTestFinished(() => { close.mockRestore() })
    const h = mount()
    h.attach()
    h.face.hold(PANE, ROOT)
    const stream = await h.watches.forPath(ROOT)
    stream.fail(new Error('watch disconnected'))
    await h.waitForList(0)
    await h.leave()
    const closing = close.mock.results[0]
    if (closing?.type !== 'return') throw new Error('expected the pane to close its directory tree')
    await h.settle({ ok: true, value: LEVEL })
    await expect(closing.value).resolves.toBeUndefined()
    expect(h.snapshot()).toBeUndefined()
    expect(h.watches.opened).toHaveLength(1)
  })

  it('manually refreshes expanded nodes while preserving cached levels and the automatic setting', async () => {
    const { face, watches, settle, waitForList, snapshot, attach, actions } = mount()
    const child = `${ROOT}/src`
    const collapsed = `${ROOT}/docs`
    attach()
    face.hold(PANE, ROOT)
    await watches.ready(ROOT)
    await settle({ ok: true, value: LEVEL })
    face.toggle(PANE, ROOT, child, snapshot()!.expanded)
    await watches.ready(child)
    await settle({ ok: true, value: LEVEL })
    actions.loaded(PANE, collapsed, LEVEL)
    face.setAutoRefresh(PANE, false)
    const cached = snapshot()!

    face.refresh(PANE)
    expect((await waitForList(2)).path).toBe(ROOT)
    expect(snapshot()!.levels).toEqual({ ...cached.levels, [ROOT]: { ...cached.levels[ROOT], refreshing: true } })
    await settle({ ok: true, value: LEVEL })
    expect((await waitForList(3)).path).toBe(child)
    expect(snapshot()!.levels[child]).toEqual({ ...cached.levels[child], refreshing: true })
    await settle({ ok: true, value: { entries: [], truncated: false } })
    expect(snapshot()!.levels[collapsed]).toEqual(cached.levels[collapsed])
    expect(snapshot()).toMatchObject({ expanded: [ROOT, child], autoRefresh: false })
    expect(watches.opened.map(stream => stream.path)).toEqual([ROOT, child])
    expect(watches.opened.every(stream => !stream.signal.aborted)).toBe(true)
  })
})

describe('filesFace pane records follow the tabs that drew them', () => {
  const OTHER = 'pane-2' as PaneId
  const B = 'tab-2' as TabId

  it('keeps a pane while a tab whose navigator was there is open, and forgets it when that tab closes', async () => {
    const h = mount()
    const tab = new AbortController()
    const release = h.face.attach(PANE, TAB, tab.signal)
    h.face.hold(PANE, ROOT)()
    expect(h.snapshot()).toBeDefined()
    // The pane shows another tab: the navigator goes, its tab stays open.
    release()
    await Promise.resolve()
    expect(h.snapshot()).toBeDefined()
    tab.abort()
    await Promise.resolve()
    expect(h.instance.getSnapshot().byPane[PANE]).toBeUndefined()
  })

  it('keeps a pane whose tab is replaced in place, as the replacement draws in the same task', async () => {
    const h = mount()
    const page = new AbortController()
    const release = h.face.attach(PANE, TAB, page.signal)
    h.face.hold(PANE, ROOT)()
    // The page closes as the commit replacing it is planned, before its navigator goes.
    page.abort()
    release()
    h.face.attach(PANE, B, new AbortController().signal)
    await Promise.resolve()
    expect(h.snapshot()).toBeDefined()
  })

  it('moves a tab to the pane where its navigator draws next, forgetting the pane it leaves', async () => {
    const h = mount()
    const tab = new AbortController()
    h.face.attach(PANE, TAB, tab.signal)()
    h.face.focus(PANE)
    h.face.attach(OTHER, TAB, tab.signal)
    await Promise.resolve()
    // The pane it left is forgotten, and the pane it arrived in starts without a record.
    expect(h.instance.getSnapshot().byPane).toEqual({})
    h.face.focus(OTHER)
    expect(h.instance.getSnapshot().byPane[OTHER]?.open).toBe(true)
    tab.abort()
    await Promise.resolve()
    // Still drawn there, so the pane stays until its navigator goes.
    expect(h.instance.getSnapshot().byPane[OTHER]).toBeDefined()
  })

  it('places itself beside a tab through its owner, independently of the pane records', async () => {
    const h = mount()
    const tab = new AbortController()
    const release = h.face.attach(PANE, TAB, tab.signal)
    h.face.hold(PANE, ROOT)()
    const unplace = h.face.placeBeside(TAB)
    expect(h.placed.map(entry => [entry.tabId, entry.face])).toEqual([[TAB, h.face]])
    unplace()
    expect(h.placed[0]!.release).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(h.snapshot()).toBeDefined()
    release()
  })

  it('forgets a record that only drawings made, once those drawings go with no navigator attached', async () => {
    const h = mount()
    const width = h.face.keyedHooks.rowWidth(PANE)
    expect(h.face.keyedHooks.rowWidth(PANE)).toBe(width)
    // The tab closed before the drawing's effects attached its navigator.
    h.controller.abort()
    h.face.attach(PANE, TAB, h.controller.signal)()
    await Promise.resolve()
    h.face.focus(PANE)
    expect(h.instance.getSnapshot().byPane).toEqual({})
    const fresh = h.face.keyedHooks.rowWidth(PANE)
    expect(fresh).not.toBe(width)
    const row = { contains: () => false, ownerDocument: {} as Document, parentElement: null } as Partial<HTMLElement> as HTMLElement
    const drawings: readonly ((drawn: boolean) => void)[] = [
      (drawn) => { h.face.toggleDrawn(PANE, drawn ? row : null) },
      (drawn) => { h.face.currentDrawn(PANE, drawn ? row : null) },
      (drawn) => { h.face.navigatorDrawn(PANE, drawn ? row : null, true) },
      (drawn) => { h.face.bodyDrawn(PANE, sessionFileAddress(SESSION, 'a.ts'), drawn ? row : null) },
    ]
    let previous = fresh
    for (const drawing of drawings) {
      drawing(true)
      expect(h.face.keyedHooks.rowWidth(PANE)).toBe(previous)
      drawing(false)
      await Promise.resolve()
      const next = h.face.keyedHooks.rowWidth(PANE)
      expect(next).not.toBe(previous)
      previous = next
    }
  })

  it('records nothing for drawings that go after their pane was forgotten', async () => {
    const h = mount()
    h.attach()
    h.face.hold(PANE, ROOT)()
    await h.leave()
    h.face.bodyDrawn(PANE, 'dsh-resource://file/session/s-1/a.ts', null)
    h.face.currentDrawn(PANE, null)
    h.face.navigatorDrawn(PANE, null, true)
    h.face.toggleDrawn(PANE, null)
    h.face.scrolled(PANE, 40)
    expect(h.face.hold(PANE, ROOT)).toBeTypeOf('function')
    expect(h.watches.opened).toHaveLength(1)
    expect(h.instance.getSnapshot().byPane).toEqual({})
  })
})

describe('canOpenOf', () => {
  it('answers whether a tab type opens an address, with a new predicate only when registrations change', () => {
    let entries: readonly never[] = []
    const listeners = new Set<() => void>()
    const registry: TabTypeRegistry = {
      entries: () => entries,
      candidates: address => address.endsWith('.ts') ? entries : [],
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const canOpen = canOpenOf(registry)
    const first = canOpen.getSnapshot()
    expect(canOpen.getSnapshot()).toBe(first)
    expect(first('a.ts')).toBe(false)
    const heard = vi.fn()
    const unsubscribe = canOpen.subscribe(heard)
    entries = [{} as never]
    for (const listener of listeners) listener()
    expect(heard).toHaveBeenCalledTimes(1)
    const next = canOpen.getSnapshot()
    expect(next).not.toBe(first)
    expect([next('a.ts'), next('a.png')]).toEqual([true, false])
    unsubscribe()
    expect(listeners.size).toBe(0)
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
