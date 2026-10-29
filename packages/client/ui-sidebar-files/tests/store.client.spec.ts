/** Pane-local directory caches, expansion preferences, refresh settings, and navigator choices. */
import { describe, expect, it } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { createFilesStore } from '../src/client/store.ts'
import { DEFAULT_NAVIGATOR_WIDTH } from '../src/client/store.ts'
import type { DirLevel } from '../src/client/store.ts'
import type { PaneId } from '@deepseek-ai/dsh-client-ui-dockkit'

const ROOT = '/work/app'
const PANE = 'pane-1' as PaneId

const LEVEL: DirLevel = {
  entries: [{ name: 'src', type: 'directory' }, { name: 'README.md', type: 'file', size: 12 }],
  truncated: false,
}

describe('createFilesStore', () => {
  it('mints an independent instance per call', () => {
    const first = createFilesStore().create()
    const second = createFilesStore().create()
    first.actions.start(PANE, ROOT)
    expect(second.getSnapshot().byPane[PANE]).toBeUndefined()
  })

  it('seeds a pane at its root with the root expanded and nothing loaded', () => {
    const store = createFilesStore().create()
    const { actions } = store
    const getSnapshot = (): ReturnType<typeof store.getSnapshot> => store.getSnapshot()
    actions.start(PANE, ROOT)
    expect(getSnapshot().byPane[PANE]).toEqual({
      open: undefined, width: DEFAULT_NAVIGATOR_WIDTH,
      tree: { root: ROOT, levels: {}, expanded: [ROOT], autoRefresh: true },
    })
  })

  it('shows a failed initial listing and replaces it with a successful retry', () => {
    const store = createFilesStore().create()
    const { actions } = store
    const getSnapshot = (): ReturnType<typeof store.getSnapshot> => store.getSnapshot()
    actions.start(PANE, ROOT)
    actions.loading(PANE, ROOT)
    expect(getSnapshot().byPane[PANE]!.tree!.levels[ROOT]).toEqual({ kind: 'loading' })
    const failure = new RemoteError('workspace-file/not-found', 'gone', { path: ROOT })
    actions.failed(PANE, ROOT, failure)
    expect(getSnapshot().byPane[PANE]!.tree!.levels[ROOT]).toEqual({ kind: 'failed', failure })
    actions.loading(PANE, ROOT)
    expect(getSnapshot().byPane[PANE]!.tree!.levels[ROOT]).toEqual({ kind: 'loading' })
    actions.loaded(PANE, ROOT, LEVEL)
    expect(getSnapshot().byPane[PANE]!.tree!.levels[ROOT]).toEqual({ kind: 'ready', level: LEVEL })
  })

  it('retains a loaded level marked as refreshing while it is listed again, until the listing settles or fails', () => {
    const store = createFilesStore().create()
    const { actions } = store
    const level = () => store.getSnapshot().byPane[PANE]!.tree!.levels[ROOT]
    actions.start(PANE, ROOT)
    actions.loaded(PANE, ROOT, LEVEL)
    actions.loading(PANE, ROOT)
    expect(level()).toEqual({ kind: 'ready', level: LEVEL, refreshing: true })
    // Marking it again changes nothing.
    const refreshing = store.getSnapshot()
    actions.loading(PANE, ROOT)
    expect(store.getSnapshot()).toBe(refreshing)
    const failure = new RemoteError('workspace-file/not-found', 'gone', { path: ROOT })
    actions.failed(PANE, ROOT, failure)
    expect(level()).toEqual({ kind: 'ready', level: LEVEL, failure })
    actions.loading(PANE, ROOT)
    expect(level()).toEqual({ kind: 'ready', level: LEVEL, failure, refreshing: true })
    actions.loaded(PANE, ROOT, LEVEL)
    expect(level()).toEqual({ kind: 'ready', level: LEVEL })
  })

  it('ends the refresh of every level below a directory whose listing fails, and of none beside it', () => {
    const store = createFilesStore().create()
    const { actions } = store
    const levels = () => store.getSnapshot().byPane[PANE]!.tree!.levels
    const src = `${ROOT}/src`
    const deep = `${src}/lib`
    const docs = `${src}/docs`
    const sibling = `${ROOT}/srcs`
    const failure = new RemoteError('workspace-file/not-found', 'gone', { path: deep })
    actions.start(PANE, ROOT)
    for (const path of [ROOT, src, deep, docs, sibling]) actions.loaded(PANE, path, LEVEL)
    actions.failed(PANE, deep, failure)
    for (const path of [ROOT, src, deep, sibling]) actions.loading(PANE, path)
    actions.loading(PANE, `${src}/new`)
    actions.failed(PANE, src, failure)
    expect(levels()[src]).toEqual({ kind: 'ready', level: LEVEL, failure })
    expect(levels()[deep]).toEqual({ kind: 'ready', level: LEVEL, failure })
    expect(levels()[docs]).toEqual({ kind: 'ready', level: LEVEL })
    expect(levels()[`${src}/new`]).toEqual({ kind: 'loading' })
    expect(levels()[ROOT]).toEqual({ kind: 'ready', level: LEVEL, refreshing: true })
    expect(levels()[sibling]).toEqual({ kind: 'ready', level: LEVEL, refreshing: true })
  })

  it('toggles a directory in and out of the expanded set without touching its level', () => {
    const store = createFilesStore().create()
    const { actions } = store
    const getSnapshot = (): ReturnType<typeof store.getSnapshot> => store.getSnapshot()
    const child = `${ROOT}/src`
    actions.start(PANE, ROOT)
    actions.loaded(PANE, child, LEVEL)
    actions.toggled(PANE, child)
    expect(getSnapshot().byPane[PANE]!.tree!.expanded).toEqual([ROOT, child])
    actions.toggled(PANE, child)
    expect(getSnapshot().byPane[PANE]!.tree!.expanded).toEqual([ROOT])
    expect(getSnapshot().byPane[PANE]!.tree!.levels[child]).toEqual({ kind: 'ready', level: LEVEL })
  })

  it('keeps the automatic setting independent for each pane', () => {
    const store = createFilesStore().create()
    const other = 'pane-2' as PaneId
    store.actions.start(PANE, ROOT)
    store.actions.start(other, ROOT)
    store.actions.autoRefresh(PANE, false)
    expect(store.getSnapshot().byPane[PANE]!.tree!.autoRefresh).toBe(false)
    expect(store.getSnapshot().byPane[other]!.tree!.autoRefresh).toBe(true)
    store.actions.autoRefresh(PANE, true)
    expect(store.getSnapshot().byPane[PANE]!.tree!.autoRefresh).toBe(true)
  })

  it.each(['removed', 'file'] as const)('drops cached descendants and expansion when a directory is %s', (replacement) => {
    const store = createFilesStore().create()
    const { actions } = store
    const child = `${ROOT}/src`
    const grandchild = `${child}/nested`
    const sibling = `${ROOT}/src-other`
    actions.start(PANE, ROOT)
    actions.loaded(PANE, ROOT, { entries: [
      { name: 'src', type: 'directory' }, { name: 'src-other', type: 'directory' },
    ], truncated: false })
    for (const path of [child, grandchild, sibling]) {
      actions.toggled(PANE, path)
      actions.loaded(PANE, path, LEVEL)
    }
    actions.loaded(PANE, ROOT, { entries: replacement === 'file'
      ? [{ name: 'src', type: 'file' }, { name: 'src-other', type: 'directory' }]
      : [{ name: 'src-other', type: 'directory' }], truncated: false })
    const state = store.getSnapshot().byPane[PANE]!.tree!
    expect(state.expanded).toEqual([ROOT, sibling])
    expect(Object.keys(state.levels)).toEqual([ROOT, sibling])
    expect(state.levels[sibling]).toEqual({ kind: 'ready', level: LEVEL })
  })

  it('keeps the navigator\'s choices before and across a tree started at a new root', () => {
    const store = createFilesStore().create()
    const { actions } = store
    actions.shown(PANE, true)
    actions.resized(PANE, 320)
    expect(store.getSnapshot().byPane[PANE]).toEqual({ open: true, width: 320, tree: undefined })
    actions.start(PANE, ROOT)
    actions.loaded(PANE, ROOT, LEVEL)
    actions.start(PANE, '/work/other')
    expect(store.getSnapshot().byPane[PANE]).toEqual({
      open: true, width: 320,
      tree: { root: '/work/other', levels: {}, expanded: ['/work/other'], autoRefresh: true },
    })
  })

  it('refuses to write a level for a pane whose tree was never started', () => {
    const { actions } = createFilesStore().create()
    expect(() => { actions.loading('pane-nowhere' as PaneId, ROOT) }).toThrow('no tree for pane "pane-nowhere"')
  })

  it('forget removes exactly the pane that went away', () => {
    const store = createFilesStore().create()
    const { actions } = store
    const getSnapshot = (): ReturnType<typeof store.getSnapshot> => store.getSnapshot()
    actions.start(PANE, ROOT)
    actions.start('pane-2' as PaneId, ROOT)
    actions.forget(PANE)
    expect(Object.keys(getSnapshot().byPane)).toEqual(['pane-2'])
  })
})
