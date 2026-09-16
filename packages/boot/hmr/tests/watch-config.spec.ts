import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import * as fs from 'node:fs'
import { realpath } from 'node:fs/promises'
import * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { watchConfig } from '../src/watch-config.ts'
import Hmr from '../src/index.ts'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { FSWatcher, type ChokidarOptions } from 'chokidar'

const configWatch = vi.hoisted(() => ({ create: undefined as ((options?: ChokidarOptions) => FSWatcher) | undefined }))
vi.mock('node:fs', async (importOriginal) => {
  const native = await importOriginal<typeof import('node:fs')>()
  return { ...native, realpathSync: vi.fn(native.realpathSync) }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const native = await importOriginal<typeof import('node:fs/promises')>()
  return { ...native, stat: vi.fn(native.stat), realpath: vi.fn(native.realpath) }
})
vi.mock('chokidar', async (importOriginal) => {
  const native = await importOriginal<typeof import('chokidar')>()
  return { ...native, watch: (paths: string | string[], options?: ChokidarOptions) =>
    configWatch.create === undefined ? native.watch(paths, options) : configWatch.create(options) }
})

/** Every per-test tree root, removed once the booted watcher has been disposed. */
const hmrRoots: string[] = []

async function bootHmr(dir: string, root: string[] = [], usePolling?: boolean): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(dir).href + '/'
  await ctx.plugin(Loader)
  await ctx.plugin(Timer)
  await ctx.plugin(Hmr, {
    root,
    ignored: [],
    debounce: 0,
    ...usePolling === undefined ? {} : { usePolling },
  })
  return ctx
}

async function eventually(test: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!test()) {
    if (Date.now() >= deadline) throw new Error(message)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('HMR exact config paths', () => {
  afterEach(() => {
    for (const root of hmrRoots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it.each(['relative', 'absolute'])('observes %s module roots through a filesystem alias', { timeout: 30_000 }, async (rootKind) => {
    const target = mkdtempSync(join(tmpdir(), 'dsh-hmr-module-canonical-'))
    const alias = `${target}-alias`
    const aliasFilename = join(alias, 'module.ts')
    symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(aliasFilename, 'export const generation = 0\n')
    // This acceptance owns alias-to-cache identity. Other cases below exercise
    // native events; polling keeps Windows fs.watch queue pressure out of it.
    const ctx = await bootHmr(alias, [rootKind === 'relative' ? '.' : alias], true)
    const filename = join(realpathSync(target), 'module.ts')
    const expected = pathToFileURL(filename).href
    const cacheHas = vi.spyOn(ctx.loader.internal!.loadCache, 'has').mockReturnValue(false)
    const observed: string[] = []
    ctx.on('hmr/change', (url) => { observed.push(url) })
    try {
      const deadline = Date.now() + 20_000
      for (let generation = 1; !observed.includes(expected); generation += 1) {
        if (Date.now() >= deadline) {
          throw new Error(`HMR did not observe ${expected} through the alias; observed ${JSON.stringify(observed)}`)
        }
        // The watch base, not the writer spelling, is the alias under test.
        // Grow the file on every write: polling must not depend on timestamp
        // precision when several generations land inside one filesystem tick.
        writeFileSync(filename, `export const generation = ${generation}\n${' '.repeat(generation)}\n`)
        // Leave Chokidar's atomic-write window idle so one coalesced change can publish.
        await new Promise(resolve => setTimeout(resolve, 250))
      }
      expect(cacheHas).toHaveBeenCalledWith(expected)
    } finally {
      await ctx.fiber.dispose()
      unlinkSync(alias)
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('collapses filesystem aliases before registering an exact watch', async () => {
    const target = mkdtempSync(join(tmpdir(), 'dsh-hmr-canonical-'))
    const alias = `${target}-alias`
    symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const ctx = await bootHmr(alias)
    try {
      await watchConfig(ctx, join(alias, 'plugins.yml'), {}, () => {})
      await expect(watchConfig(ctx, join(await realpath(target), 'plugins.yml'), {}, () => {}))
        .rejects.toThrow('config path already registered')
    } finally {
      await ctx.fiber.dispose()
      unlinkSync(alias)
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('observes add, change, and unlink outside its module roots', { timeout: 20_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-config-'))
    hmrRoots.push(dir)
    const filename = join(dir, 'plugins.yml')
    const ctx = await bootHmr(dir)
    const observed: string[] = []
    try {
      await watchConfig(ctx, filename, {}, () => {
        try {
          observed.push(readFileSync(filename, 'utf8'))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          observed.push('missing')
        }
      })

      writeFileSync(filename, 'one', { flag: 'wx' })
      await eventually(() => observed.includes('one'), 'HMR did not observe config creation')
      writeFileSync(filename, 'two')
      await eventually(() => observed.includes('two'), 'HMR did not observe config change')
      unlinkSync(filename)
      await eventually(() => observed.includes('missing'), 'HMR did not observe config removal')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('observes creation when the config parent did not exist at registration', { timeout: 20_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-hmr-config-'))
    hmrRoots.push(root)
    const dir = join(root, 'later')
    const filename = join(dir, 'plugins.yml')
    const ctx = await bootHmr(root)
    const observed: string[] = []
    try {
      await watchConfig(ctx, filename, {}, () => {
        observed.push(readFileSync(filename, 'utf8'))
      })
      mkdirSync(dir)
      writeFileSync(filename, 'created')
      await eventually(() => observed.includes('created'), 'HMR did not observe config creation under a new parent')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('processes native events for a watcher registered during a transaction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-transaction-watch-'))
    const filename = join(dir, 'plugins.yml')
    onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
    const ctx = await bootHmr(dir)
    onTestFinished(() => ctx.fiber.dispose())
    const hmr = ctx.hmr
    const observed = Promise.withResolvers<string>()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation((reason) => { observed.reject(new Error(String(reason))) })
    onTestFinished(() => { warn.mockRestore() })
    await hmr.runExclusive(() => hmr.watchConfig(filename, async () => {
      observed.resolve(readFileSync(filename, 'utf8'))
    }))
    writeFileSync(filename, 'created-after-transaction')
    expect(await observed.promise).toBe('created-after-transaction')
  })

  it('serializes refreshes and waits for them during disposal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-config-'))
    hmrRoots.push(dir)
    const filename = join(dir, 'plugins.yml')
    const ctx = await bootHmr(dir)
    onTestFinished(() => ctx.fiber.dispose())
    const watcher = new FSWatcher()
    const previousFactory = configWatch.create
    onTestFinished(() => { configWatch.create = previousFactory })
    configWatch.create = () => { queueMicrotask(() => { watcher.emit('ready') }); return watcher }
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    onTestFinished(() => { release.resolve(undefined) })
    let calls = 0
    let active = 0
    let maxActive = 0
    const dispose = await watchConfig(ctx, filename, {}, async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      if (++calls === 1) {
        started.resolve(undefined)
        await release.promise
      }
      active -= 1
    })
    watcher.emit('change', join(dir, 'unrelated.yml'))
    expect(calls).toBe(0)
    watcher.emit('add', filename)
    await started.promise
    watcher.emit('change', filename)
    watcher.emit('unlink', filename)
    let disposed = false
    const disposal = dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    release.resolve(undefined)
    await disposal
    expect(maxActive).toBe(1)
    expect(calls).toBe(2)
  })

  it('observes consecutive writes after the previous configuration was applied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-consecutive-'))
    hmrRoots.push(dir)
    const filename = join(dir, 'package.json')
    writeFileSync(filename, 'initial')
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    let watcher!: FSWatcher
    const previousFactory = configWatch.create
    onTestFinished(() => { configWatch.create = previousFactory })
    configWatch.create = (options) => {
      watcher = new FSWatcher(options)
      // Use Chokidar's real normalization with deterministic event delivery.
      Reflect.set(watcher, '_readyEmitted', true)
      queueMicrotask(() => { watcher.emit('ready') })
      return watcher
    }
    const observed: string[] = []
    await watchConfig(ctx, filename, {}, async () => {
      const value = readFileSync(filename, 'utf8')
      observed.push(value)
      if (value === 'enabled') {
        writeFileSync(filename, 'disabled')
        await watcher._emit('change', filename)
      }
    })
    writeFileSync(filename, 'enabled')
    await watcher._emit('change', filename)
    await vi.waitFor(() => { expect(observed).toEqual(['enabled', 'disabled']) }, { timeout: 6_000 })
  }, 10_000)

  it('rejects a patch path whose parent is a regular file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-patch-parent-'))
    hmrRoots.push(dir)
    const parent = join(dir, 'file')
    writeFileSync(parent, '')
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await expect(watchConfig(ctx, join(parent, 'plugins.yml'), {}, () => {}))
      .rejects.toThrow('config watch parent is not a directory')
  })

  it('stops searching when the filesystem root cannot be read', async () => {
    const failure = Object.assign(new Error('filesystem root unavailable'), { code: 'ENOENT' })
    const read = vi.mocked(fsPromises.stat).mockClear().mockRejectedValueOnce(failure)
    onTestFinished(() => { read.mockRestore() })
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await expect(watchConfig(ctx, join(parse(tmpdir()).root, 'plugins.yml'), {}, () => {})).rejects.toBe(failure)
    expect(read).toHaveBeenCalledOnce()
  })

  it.each(['creation', 'ready'] as const)('releases registration after watcher %s fails', async (phase) => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-patch-watch-failure-'))
    hmrRoots.push(dir)
    const ctx = await bootHmr(dir)
    onTestFinished(() => ctx.fiber.dispose())
    const filename = join(dir, 'plugins.yml')
    const previousFactory = configWatch.create
    onTestFinished(() => { configWatch.create = previousFactory })
    const failure = new Error('watcher unavailable')
    const failed = new FSWatcher()
    const closed = vi.spyOn(failed, 'close')
    configWatch.create = () => {
      if (phase === 'creation') throw failure
      queueMicrotask(() => { failed.emit('error', failure) })
      return failed
    }
    await expect(ctx.hmr.watchConfig(filename, async () => {})).rejects.toBe(failure)
    if (phase === 'ready') expect(closed).toHaveBeenCalledOnce()
    const watcher = new FSWatcher()
    configWatch.create = () => { queueMicrotask(() => { watcher.emit('ready') }); return watcher }
    await ctx.hmr.watchConfig(filename, async () => {})
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    onTestFinished(() => { warn.mockRestore() })
    watcher.emit('error', failure)
    expect(warn).toHaveBeenCalledWith(failure)
  })

  it('closes a ready watcher when its context has already been disposed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-patch-disposed-'))
    hmrRoots.push(dir)
    const root = new Context()
    const fiber = root.plugin(() => {})
    await fiber
    const ctx = fiber.ctx
    await fiber.dispose()
    const watcher = new FSWatcher()
    const close = vi.spyOn(watcher, 'close')
    const previousFactory = configWatch.create
    onTestFinished(() => { configWatch.create = previousFactory })
    configWatch.create = () => { queueMicrotask(() => { watcher.emit('ready') }); return watcher }
    await expect(watchConfig(ctx, join(dir, 'plugins.yml'), {}, () => {}))
      .rejects.toThrow('cannot create effect on inactive context')
    expect(close).toHaveBeenCalledOnce()
  })

  it.each([42, new Error('42')])('logs refresh failure %s and continues processing later events', async (failure) => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-patch-failure-'))
    hmrRoots.push(dir)
    const filename = join(dir, 'plugins.yml')
    const ctx = await bootHmr(dir)
    onTestFinished(() => ctx.fiber.dispose())
    const watcher = new FSWatcher()
    const previousFactory = configWatch.create
    onTestFinished(() => { configWatch.create = previousFactory })
    configWatch.create = () => { queueMicrotask(() => { watcher.emit('ready') }); return watcher }
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    onTestFinished(() => { warn.mockRestore() })
    let calls = 0
    const recovered = Promise.withResolvers<undefined>()
    await watchConfig(ctx, filename, {}, () => {
      if (++calls === 1) throw failure
      recovered.resolve(undefined)
    })
    watcher.emit('change', filename)
    await expect.poll(() => warn.mock.calls.length).toBe(2)
    expect(warn.mock.calls[0]).toEqual(['config reload at %C failed', filename])
    expect(warn.mock.calls[1]?.[0]).toMatchObject({ message: '42' })
    watcher.emit('change', filename)
    await recovered.promise
    expect(calls).toBe(2)
  })
})


it('reports inaccessible configuration paths and missing filesystem roots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-path-error-'))
  const ctx = await bootHmr(dir)
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }) })
  const native = await vi.importActual<typeof import('node:fs')>('node:fs')
  const target = join(dir, 'denied.yml')
  const root = parse(dir).root
  const mocked = vi.spyOn(fs, 'realpathSync').mockImplementation((path, options) => {
    if (path === target) throw Object.assign(new Error('denied'), { code: 'EACCES' })
    if (path === root) throw Object.assign(new Error('root missing'), { code: 'ENOENT' })
    return native.realpathSync(path, options)
  })
  onTestFinished(() => { mocked.mockRestore() })
  await expect(ctx.hmr.watchConfig(target, async () => {})).rejects.toThrow('denied')
  await expect(ctx.hmr.watchConfig(root, async () => {})).rejects.toThrow('root missing')
})
