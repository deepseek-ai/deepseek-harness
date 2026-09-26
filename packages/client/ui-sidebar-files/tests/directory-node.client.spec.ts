/** Directory-node lifecycle tests with controlled stream delivery and deferred reads. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { DirectoryNode } from '../src/client/directory-node.ts'
import type { DirLevel } from '../src/client/store.ts'
import { scriptedList } from './scripted-list.client.ts'
import type { ScriptedList } from './scripted-list.client.ts'
import type { DirectoryWatch } from './scripted-watch.client.ts'

const SESSION = 'directory-node-session' as SessionId
const ROOT = '/work/app'
const SRC = `${ROOT}/src`
const COMPONENTS = `${SRC}/components`
const EMPTY: DirLevel = { entries: [], truncated: false }
const ROOT_LEVEL: DirLevel = { entries: [{ name: 'src', type: 'directory' }], truncated: false }
const SRC_LEVEL: DirLevel = { entries: [{ name: 'components', type: 'directory' }], truncated: false }

function mount(path = ROOT, restore: readonly string[] = []) {
  const script = scriptedList()
  const lifetime = new AbortController()
  const reported = Promise.withResolvers<readonly [string, unknown]>()
  const failed = vi.fn((path: string, error: unknown) => { reported.resolve([path, error]) })
  const node = new DirectoryNode(path, async (path, signal) => {
    const result = await script.list(SESSION, path, signal)
    return result.ok ? result.value : undefined
  }, (path, signal) => script.watch(SESSION, path, signal), failed, lifetime.signal, restore)
  onTestFinished(async () => {
    const closing = node.close()
    lifetime.abort()
    await script.dispose()
    await closing
  })
  node.open()
  return { node, script, failed, reported, lifetime }
}

function readCompletion(refresh: MockInstance<DirectoryNode['refresh']>, index = refresh.mock.results.length - 1): Promise<void> {
  const result = refresh.mock.results[index]
  if (result?.type !== 'return') throw new Error('expected the event to start a directory refresh')
  return result.value
}

/** The refresh promise includes child reconciliation, which follows the deferred list response. */
async function watchedRead(node: DirectoryNode, script: ScriptedList, event: 'ready' | 'change' = 'ready', occurrence = 0) {
  const refresh = vi.spyOn(node, 'refresh')
  const index = refresh.mock.calls.length
  const stream = await script.watches.forPath(node.path, occurrence)
  await stream.deliver(event)
  return { stream, finished: readCompletion(refresh, index) }
}

async function listReady(node: DirectoryNode, script: ScriptedList, level: DirLevel): Promise<DirectoryWatch> {
  const read = await watchedRead(node, script)
  await script.settle({ ok: true, value: level })
  await read.finished
  return read.stream
}

describe('DirectoryNode', () => {
  it('rereads an invalidation arriving between read completion and refresh cleanup', async () => {
    const pending = Promise.withResolvers<DirLevel>()
    const load = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(EMPTY)
    const node = new DirectoryNode(ROOT, load, async function* () {}, vi.fn(), new AbortController().signal)
    onTestFinished(() => node.close())
    const reading = node.refresh()
    pending.resolve(EMPTY)
    queueMicrotask(() => { void node.refresh() })
    await reading
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('opens one watch per expanded directory and waits for each ready before its first list', async () => {
    const { node, script } = mount()
    expect(node.open()).toBe(node)
    expect(script.watches.opened.map(stream => stream.path)).toEqual([ROOT])
    expect(script.list).not.toHaveBeenCalled()
    await listReady(node, script, ROOT_LEVEL)
    expect(node.children.size).toBe(0)

    const child = node.expand(SRC)!
    expect(node.expand(SRC)).toBe(child)
    expect(node.find(SRC)).toBe(child)
    expect(node.find(COMPONENTS)).toBeUndefined()
    expect(script.list).toHaveBeenCalledTimes(1)
    const stream = await listReady(child, script, SRC_LEVEL)
    expect(script.list).toHaveBeenLastCalledWith(SESSION, SRC, stream.signal)
    expect(script.watches.opened.map(stream => stream.path)).toEqual([ROOT, SRC])
    expect(child.children.size).toBe(0)
  })

  it('collapsing a directory aborts its subtree and awaits every watch release', async () => {
    const { node, script } = mount()
    const rootStream = await listReady(node, script, ROOT_LEVEL)
    const child = node.expand(SRC)!
    const childStream = await listReady(child, script, SRC_LEVEL)
    const grandchild = child.expand(COMPONENTS)!
    const grandchildStream = await listReady(grandchild, script, EMPTY)
    const childRelease = childStream.holdRelease()
    const grandchildRelease = grandchildStream.holdRelease()
    let collapsed = false
    const closing = node.collapse(SRC).then(() => { collapsed = true })
    expect(node.find(SRC)).toBeUndefined()
    expect(childStream.signal.aborted).toBe(true)
    expect(grandchildStream.signal.aborted).toBe(true)
    await Promise.all([childStream.releasing.promise, grandchildStream.releasing.promise])
    expect(collapsed).toBe(false)
    childRelease.resolve(undefined)
    await childStream.released.promise
    expect(collapsed).toBe(false)
    grandchildRelease.resolve(undefined)
    await closing
    expect(rootStream.signal.aborted).toBe(false)
    expect(child.children.size).toBe(0)
    expect(script.list).toHaveBeenCalledTimes(3)
  })

  it('does not restore a child collapsed while the reopened parent is still listing', async () => {
    const sibling = `${SRC}/components-other`
    const descendant = `${COMPONENTS}/nested`
    const { node, script } = mount(SRC, [COMPONENTS, descendant, sibling])
    const read = await watchedRead(node, script)
    expect(script.outstanding()).toEqual([SRC])
    expect(node.children.size).toBe(0)
    await node.collapse(COMPONENTS)
    await script.settle({ ok: true, value: {
      entries: [{ name: 'components', type: 'directory' }, { name: 'components-other', type: 'directory' }],
      truncated: false,
    } })
    await read.finished
    expect([...node.children.keys()]).toEqual([sibling])
    expect(script.watches.opened.map(stream => stream.path)).toEqual([SRC, sibling])

    const reopened = node.expand(COMPONENTS)!
    await listReady(reopened, script, { entries: [{ name: 'nested', type: 'directory' }], truncated: false })
    expect(reopened.children.size).toBe(0)
    expect(script.watches.opened.some(stream => stream.path === descendant)).toBe(false)
  })

  it.each(['removed', 'file'] as const)('closes a child subtree when its parent lists it as %s', async (replacement) => {
    const { node, script } = mount()
    const rootStream = await listReady(node, script, ROOT_LEVEL)
    const child = node.expand(SRC)!
    const childStream = await listReady(child, script, SRC_LEVEL)
    const grandchildStream = await listReady(child.expand(COMPONENTS)!, script, EMPTY)
    const read = await watchedRead(node, script, 'change')
    await script.settle({ ok: true, value: {
      entries: replacement === 'file' ? [{ name: 'src', type: 'file' }] : [],
      truncated: false,
    } })
    await read.finished
    expect(node.children.size).toBe(0)
    expect(childStream.signal.aborted).toBe(true)
    expect(grandchildStream.signal.aborted).toBe(true)
    await Promise.all([childStream.released.promise, grandchildStream.released.promise])
    expect(rootStream.signal.aborted).toBe(false)
  })

  it('coalesces notifications during a list into one subsequent read', async () => {
    const { node, script } = mount()
    const read = await watchedRead(node, script)
    await Promise.all([read.stream.deliver('change'), read.stream.deliver('change')])
    expect(script.list).toHaveBeenCalledTimes(1)
    expect(script.outstanding()).toEqual([ROOT])
    await script.settle({ ok: true, value: ROOT_LEVEL })
    expect((await script.waitForList(1)).path).toBe(ROOT)
    expect(script.outstanding()).toEqual([ROOT])
    await script.settle({ ok: true, value: EMPTY })
    await read.finished
    expect(script.list).toHaveBeenCalledTimes(2)
    expect(script.watches.opened).toHaveLength(1)
  })

  it('still initializes newly expanded nodes while automatic refresh is off and refreshes dirty nodes when reenabled', async () => {
    const { node, script } = mount()
    const rootStream = await listReady(node, script, ROOT_LEVEL)
    node.setAutomatic(false)
    const child = node.expand(SRC)!
    const childStream = await listReady(child, script, SRC_LEVEL)
    await rootStream.deliver('change')
    await childStream.deliver('change')
    await childStream.deliver('change')
    expect(script.list).toHaveBeenCalledTimes(2)
    expect(script.outstanding()).toEqual([])

    const rootRefresh = vi.spyOn(node, 'refresh')
    const childRefresh = vi.spyOn(child, 'refresh')
    node.setAutomatic(true)
    await script.waitForList(3)
    const finished = Promise.all([readCompletion(rootRefresh), readCompletion(childRefresh)])
    expect(script.outstanding()).toEqual(expect.arrayContaining([ROOT, SRC]))
    expect(script.outstanding()).toHaveLength(2)
    await script.settle({ ok: true, value: ROOT_LEVEL })
    await script.settle({ ok: true, value: EMPTY })
    await finished
    node.setAutomatic(true)
    expect(script.list).toHaveBeenCalledTimes(4)
    expect(script.watches.opened.map(stream => stream.path)).toEqual([ROOT, SRC])
  })

  it('manual refresh consumes pending changes without enabling automatic refresh', async () => {
    const { node, script } = mount()
    const stream = await listReady(node, script, ROOT_LEVEL)
    node.setAutomatic(false)
    await stream.deliver('change')
    const manual = node.refresh()
    expect((await script.waitForList(1)).path).toBe(ROOT)
    await script.settle({ ok: true, value: EMPTY })
    await manual
    await stream.deliver('change')
    expect(script.list).toHaveBeenCalledTimes(2)
    const refresh = vi.spyOn(node, 'refresh')
    node.setAutomatic(true)
    const finished = readCompletion(refresh)
    await script.settle({ ok: true, value: EMPTY })
    await finished
    expect(script.list).toHaveBeenCalledTimes(3)
  })

  it('close awaits an in-flight read as well as watch release and ignores late restoration data', async () => {
    const { node, script } = mount(ROOT, [SRC])
    const read = await watchedRead(node, script)
    const release = read.stream.holdRelease()
    let closed = false
    const closing = node.close().then(() => { closed = true })
    expect(read.stream.signal.aborted).toBe(true)
    expect((await script.waitForList(0)).signal.aborted).toBe(true)
    await read.stream.releasing.promise
    expect(closed).toBe(false)
    release.resolve(undefined)
    await read.stream.released.promise
    expect(closed).toBe(false)
    await script.settle({ ok: true, value: ROOT_LEVEL })
    await closing
    expect(node.children.size).toBe(0)
    expect(node.expand(SRC)).toBeUndefined()
    expect(script.watches.opened.map(stream => stream.path)).toEqual([ROOT])
  })

  it('closes a subscription cancelled before ready without listing', async () => {
    const { node, script } = mount()
    const stream = await script.watches.forPath(ROOT)
    await node.close()
    expect(stream.signal.aborted).toBe(true)
    expect(script.list).not.toHaveBeenCalled()
    await stream.released.promise
  })

  it('does not report a stream error whose release completes after node cancellation', async () => {
    const { node, script, failed } = mount()
    const stream = await script.watches.forPath(ROOT)
    const release = stream.holdRelease()
    stream.fail(new Error('watch stopped during cancellation'))
    await stream.releasing.promise
    const closing = node.close()
    expect(stream.signal.aborted).toBe(true)
    release.resolve(undefined)
    await closing
    expect(failed).not.toHaveBeenCalled()
    expect(script.list).not.toHaveBeenCalled()
  })

  it('lists after watch-unsupported and keeps manual refresh available without reporting a failed directory', async () => {
    const { node, script, failed } = mount()
    const refresh = vi.spyOn(node, 'refresh')
    const stream = await script.watches.forPath(ROOT)
    stream.fail(new RemoteError('workspace-file/watch-unsupported', 'watching is unavailable', { path: ROOT }))
    expect((await script.waitForList(0)).path).toBe(ROOT)
    const initial = readCompletion(refresh)
    await script.settle({ ok: true, value: ROOT_LEVEL })
    await initial
    const manual = node.refresh()
    expect((await script.waitForList(1)).path).toBe(ROOT)
    await script.settle({ ok: true, value: EMPTY })
    await manual
    await node.close()
    expect(failed).not.toHaveBeenCalled()
    expect(script.list).toHaveBeenCalledTimes(2)
    expect(script.watches.opened).toHaveLength(1)
  })

  it('falls back to an initial list and reports a stream failure before ready', async () => {
    const { script, failed, reported } = mount()
    const stream = await script.watches.forPath(ROOT)
    const error = new Error('directory stream unavailable')
    stream.fail(error)
    expect((await script.waitForList(0)).path).toBe(ROOT)
    expect(failed).not.toHaveBeenCalled()
    await script.settle({ ok: true, value: ROOT_LEVEL })
    expect(await reported.promise).toEqual([ROOT, error])
    await stream.released.promise
  })

  it('reports a later stream failure without replacing an already loaded directory', async () => {
    const { node, script, reported } = mount()
    const stream = await listReady(node, script, ROOT_LEVEL)
    const error = new Error('directory stream disconnected')
    stream.fail(error)
    expect(await reported.promise).toEqual([ROOT, error])
    expect(script.list).toHaveBeenCalledTimes(1)
    await stream.released.promise
  })
})
