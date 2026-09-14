/**
 * The tree's asynchronous half against a scripted listing, and the Remote
 * adapter under it.
 *
 * The face's contract is what reaches the store and when: a level is `loading`
 * before the listing settles, `ready` or `failed` after, never written once the
 * owner's signal aborted or a newer listing of the level was asked for, and a
 * tab whose record is gone leaves no bucket behind. The adapter's is what it
 * keeps and what it drops: entries and the
 * truncation flag reach the store, the endpoint's workspace-relative path does
 * not, and a failure passes through untouched.
 */
import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceDirectoryListing } from '@deepseek-ai/dsh-api-workspace-files/types'
import { childPath, createList, filesFace } from '../src/client/face.ts'
import type { WorkspaceFilesListRemote } from '../src/client/face.ts'
import { createFilesStore } from '../src/client/store.ts'
import type { DirLevel } from '../src/client/store.ts'
import { scriptedList } from './scripted-list.client.ts'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'

const SESSION = 's-1' as SessionId
const ROOT = '/work/app'
const TAB = 'tab-1' as TabId

const LEVEL: DirLevel = { entries: [{ name: 'src', type: 'directory' }], truncated: false }

function mount() {
  const instance = createFilesStore().create()
  const script = scriptedList()
  const face = filesFace(script.list)(SESSION, instance.actions)
  return { ...script, face, snapshot: () => instance.getSnapshot().byTab[TAB] }
}

describe('filesFace', () => {
  it('start seeds the tab and lists the root with the session and the absolute root path', async () => {
    const { face, list, settle, snapshot } = mount()
    const controller = new AbortController()
    face.start(TAB, ROOT, controller.signal)
    expect(list).toHaveBeenCalledWith(SESSION, ROOT, controller.signal)
    expect(snapshot()!.levels[ROOT]).toEqual({ kind: 'loading' })
    await settle({ ok: true, value: LEVEL })
    expect(snapshot()!.levels[ROOT]).toEqual({ kind: 'ready', level: LEVEL })
  })

  it('records a failed listing under its level', async () => {
    const { face, settle, snapshot } = mount()
    face.start(TAB, ROOT, new AbortController().signal)
    const error = new RemoteError('workspace-file/not-directory', 'not a directory', { path: ROOT, kind: 'file' })
    await settle({ ok: false, error })
    expect(snapshot()!.levels[ROOT]).toEqual({ kind: 'failed', failure: error })
  })

  it('toggle expands and lists a directory the first time, and only toggles afterwards', async () => {
    const { face, list, settle, snapshot } = mount()
    const signal = new AbortController().signal
    const child = `${ROOT}/src`
    face.start(TAB, ROOT, signal)
    await settle({ ok: true, value: LEVEL })
    face.toggle(TAB, child, false, signal)
    expect(list).toHaveBeenLastCalledWith(SESSION, child, signal)
    expect(snapshot()!.expanded).toEqual([ROOT, child])
    await settle({ ok: true, value: LEVEL })
    face.toggle(TAB, child, true, signal)
    expect(snapshot()!.expanded).toEqual([ROOT])
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('abort forgets the bucket and a late settlement writes nothing', async () => {
    const { face, settle, snapshot } = mount()
    const controller = new AbortController()
    face.start(TAB, ROOT, controller.signal)
    controller.abort()
    expect(snapshot()).toBeUndefined()
    await settle({ ok: true, value: LEVEL })
    expect(snapshot()).toBeUndefined()
  })

  it('makes no request for a record that already ended', () => {
    const { face, list } = mount()
    const controller = new AbortController()
    controller.abort()
    face.load(TAB, ROOT, controller.signal)
    expect(list).not.toHaveBeenCalled()
  })

  it('lets the latest listing of a level win, whichever settles first', async () => {
    const { face, list, settle, settleLatest, snapshot, outstanding } = mount()
    const signal = new AbortController().signal
    const older: DirLevel = { entries: [{ name: 'old.txt', type: 'file' }], truncated: false }
    face.start(TAB, ROOT, signal)
    // The reload gesture asks for the root again while the first listing is still out.
    face.load(TAB, ROOT, signal)
    expect(list).toHaveBeenCalledTimes(2)
    expect(outstanding()).toEqual([ROOT, ROOT])
    await settleLatest({ ok: true, value: LEVEL })
    expect(snapshot()!.levels[ROOT]).toEqual({ kind: 'ready', level: LEVEL })
    // The retired listing lands afterwards and changes nothing.
    await settle({ ok: true, value: older })
    expect(snapshot()!.levels[ROOT]).toEqual({ kind: 'ready', level: LEVEL })
    // A retired failure is dropped the same way.
    face.load(TAB, ROOT, signal)
    face.load(TAB, ROOT, signal)
    await settleLatest({ ok: true, value: LEVEL })
    await settle({ ok: false, error: new RemoteError('workspace-file/not-found', 'gone', { path: ROOT }) })
    expect(snapshot()!.levels[ROOT]).toEqual({ kind: 'ready', level: LEVEL })
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
