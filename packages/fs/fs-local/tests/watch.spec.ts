/** Watch initialization and asynchronous release at the Chokidar adapter. */
import { Context } from '@deepseek-ai/cordis'
import { FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import { dirname, join, resolve } from 'node:path'
import * as chokidar from 'chokidar'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { LocalFileSystem } from '../src/index.ts'

vi.mock('chokidar', async (importOriginal) => {
  const original = await importOriginal<typeof import('chokidar')>()
  return { ...original, watch: vi.fn(original.watch) }
})

afterEach(() => { vi.restoreAllMocks() })

async function setup(kind: 'file' | 'directory' | 'missing' = 'file') {
  const watcher = new chokidar.FSWatcher()
  onTestFinished(() => watcher.close())
  const started = Promise.withResolvers<undefined>()
  const watch = vi.mocked(chokidar.watch).mockReset().mockImplementation(() => {
    started.resolve(undefined)
    return watcher
  })
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(LocalFileSystem)
  const path = resolve('/workspace/file.txt')
  const target = { targetKey: FsTargetKey(path), displayPath: 'file.txt' }
  const stat = vi.spyOn(ctx.fs, 'stat').mockResolvedValue(kind === 'missing'
    ? undefined : { type: kind, version: FsVersion('v1'), size: 1 })
  const changed = vi.fn<(error?: Error) => void>()
  const controller = new AbortController()
  onTestFinished(() => { controller.abort() })
  return { watcher, watch, fs: ctx.fs, target, changed, controller, path, stat, started: started.promise }
}

describe('local filesystem watch', () => {
  it.each(['file', 'missing'] as const)('waits for the parent watch of a %s target and awaits closure', async (kind) => {
    const h = await setup(kind)
    const pending = h.fs.watch(h.target, h.changed, h.controller.signal)
    await h.started
    const ignored = h.watch.mock.calls[0]![1]!.ignored
    if (typeof ignored !== 'function') throw new Error('Expected a target filter')
    expect(h.watch).toHaveBeenCalledExactlyOnceWith(dirname(h.path), { ignoreInitial: true, depth: 0, ignored })
    expect(ignored(dirname(h.path))).toBe(false)
    expect(ignored(h.path)).toBe(false)
    expect(ignored(join(dirname(h.path), 'unrelated.txt'))).toBe(true)
    let ready = false
    void pending.then(() => { ready = true })
    await Promise.resolve(undefined)
    expect(ready).toBe(false)
    h.watcher.emit('ready')
    const close = await pending
    h.watcher.emit('all', 'addDir', dirname(h.path))
    h.watcher.emit('all', 'change', join(dirname(h.path), 'unrelated.txt'))
    expect(h.changed).not.toHaveBeenCalled()
    h.watcher.emit('all', 'change', h.path)
    expect(h.changed).toHaveBeenCalledExactlyOnceWith()
    const closed = Promise.withResolvers<undefined>()
    onTestFinished(() => { closed.resolve(undefined) })
    const nativeClose = h.watcher.close.bind(h.watcher)
    vi.spyOn(h.watcher, 'close').mockImplementationOnce(async () => { await closed.promise; await nativeClose() })
    const closing = close()
    try {
      expect(h.watcher.closed).toBe(false)
    } finally {
      closed.resolve(undefined)
      await closing
    }
    expect(h.watcher.closed).toBe(true)
  })

  it('watches a directory itself without filtering its direct entries', async () => {
    const h = await setup('directory')
    const pending = h.fs.watch(h.target, h.changed, h.controller.signal)
    await h.started
    expect(h.watch.mock.calls[0]![0]).toBe(h.path)
    const ignored = h.watch.mock.calls[0]![1]!.ignored
    if (typeof ignored !== 'function') throw new Error('Expected a target filter')
    expect(ignored(join(h.path, 'child.txt'))).toBe(false)
    h.watcher.emit('ready')
    const close = await pending
    h.watcher.emit('all', 'change', join(h.path, 'child.txt'))
    expect(h.changed).toHaveBeenCalledExactlyOnceWith()
    await close()
  })

  it('does not acquire a watcher when cancelled during metadata lookup', async () => {
    const h = await setup()
    const metadata = Promise.withResolvers<undefined>()
    h.stat.mockReturnValueOnce(metadata.promise)
    const pending = h.fs.watch(h.target, h.changed, h.controller.signal)
    const rejected = expect(pending).rejects.toThrow()
    h.controller.abort()
    metadata.resolve(undefined)
    await rejected
    expect(h.watch).not.toHaveBeenCalled()
  })

  it('rejects an already-cancelled initialization without acquiring a watcher', async () => {
    const h = await setup()
    h.controller.abort()
    await expect(h.fs.watch(h.target, h.changed, h.controller.signal)).rejects.toThrow()
    expect(h.watch).not.toHaveBeenCalled()
  })

  it('closes the acquired watcher when initialization is cancelled', async () => {
    const h = await setup()
    const pending = h.fs.watch(h.target, h.changed, h.controller.signal)
    const rejected = expect(pending).rejects.toThrow()
    await h.started
    h.controller.abort()
    await rejected
    expect(h.watcher.closed).toBe(true)
    expect(h.changed).not.toHaveBeenCalled()
  })

  it('reports initialization errors and closes before rejecting', async () => {
    const h = await setup()
    const error = new Error('watch failed')
    const pending = h.fs.watch(h.target, h.changed, h.controller.signal)
    const rejected = expect(pending).rejects.toBe(error)
    await h.started
    h.watcher.emit('error', error)
    await rejected
    expect(h.changed).toHaveBeenCalledExactlyOnceWith(error)
    expect(h.watcher.closed).toBe(true)
  })

  it('normalizes watcher errors after initialization', async () => {
    const h = await setup()
    const pending = h.fs.watch(h.target, h.changed, h.controller.signal)
    await h.started
    h.watcher.emit('ready')
    const close = await pending
    const error = new Error('watch failed')
    h.watcher.emit('error', error)
    // EventEmitter callbacks can receive non-Error values from the external watcher.
    h.watcher.emit('error', 'watch unavailable')
    expect(h.changed.mock.calls).toEqual([[error], [new Error('watch unavailable')]])
    await close()
    expect(h.watcher.closed).toBe(true)
  })
})
