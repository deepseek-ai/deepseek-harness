/** Shared scheduling of caller mutations, exact-file handlers and Include refreshes. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader, { ModuleLoader } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { FSWatcher } from 'chokidar'
import { expect, it, onTestFinished, vi } from 'vitest'
import Hmr from '../src/index.ts'

const watchers = vi.hoisted(() => [] as FSWatcher[])
const watchState = vi.hoisted(() => ({ error: undefined as Error | undefined }))
vi.mock('chokidar', async (original) => {
  const native = await original<typeof import('chokidar')>()
  return { ...native, watch: () => {
    const watcher = new native.FSWatcher()
    watchers.push(watcher)
    queueMicrotask(() => watchState.error === undefined ? watcher.emit('ready') : watcher.emit('error', watchState.error))
    return watcher
  } }
})

async function fixture(config: Partial<Hmr.Config> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-coordination-'))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(dir).href + '/'
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }) })
  await ctx.plugin(Loader)
  await ctx.plugin(Timer)
  const provider = await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0, ...config })
  return { ctx, dir, hmr: ctx.hmr, provider }
}

it('serializes mutations, rejects nesting and keeps the queue usable after failure', async () => {
  const { hmr } = await fixture()
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const entered = Promise.withResolvers<undefined>()
  const order: number[] = []
  const first = hmr.runExclusive(async () => {
    order.push(1)
    entered.resolve(undefined)
    await release.promise
    throw new Error('partial package failure')
  })
  const rejection = expect(first).rejects.toThrow('partial package failure')
  await entered.promise
  const second = hmr.runExclusive(async () => {
    order.push(2)
    await expect(hmr.runExclusive(async () => {})).rejects.toThrow('cannot be nested')
  })
  expect(order).toEqual([1])
  release.resolve(undefined)
  await rejection
  await second
  expect(order).toEqual([1, 2])
})

it('holds configuration handlers behind configuration mutations', async () => {
  const { hmr, dir } = await fixture()
  const filename = join(dir, 'package.json')
  writeFileSync(filename, '{}')
  const order: string[] = []
  const refreshed = Promise.withResolvers<undefined>()
  const dispose = await hmr.watchConfig(filename, async () => {
    order.push('refresh')
    refreshed.resolve(undefined)
  })
  await expect(hmr.watchConfig(filename, async () => {})).rejects.toThrow('already registered')
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const entered = Promise.withResolvers<undefined>()
  const change = hmr.runExclusive(async () => {
    entered.resolve(undefined)
    await release.promise
    order.push('write')
  })
  await entered.promise
  watchers.at(-1)!.emit('change', filename)
  expect(order).toEqual([])
  release.resolve(undefined)
  await change
  await refreshed.promise
  await dispose()
  expect(order).toEqual(['write', 'refresh'])
})

it('reports unrelated lock-file notifications without reloading', async () => {
  const { ctx, dir, hmr } = await fixture()
  const loaded = vi.spyOn(ctx.loader, 'await')
  onTestFinished(() => { loaded.mockRestore() })
  const observed = Promise.withResolvers<string>()
  ctx.on('hmr/change', (url) => { observed.resolve(url) })
  watchers.at(-1)!.emit('change', 'package.json.lock')
  expect(await observed.promise).toBe(pathToFileURL(join(realpathSync(dir), 'package.json.lock')).href)
  await hmr.runExclusive(async () => {})
  expect(loaded).not.toHaveBeenCalled()
})

it('can dispose HMR from its own transaction without waiting on itself', async () => {
  const { ctx, hmr } = await fixture()
  await hmr.runExclusive(async () => { await ctx.fiber.dispose() })
  await expect(hmr.runExclusive(async () => {})).rejects.toThrow('disposed')
})


it('refreshes an Include through the queue and skips registered exact paths', async () => {
  const { ctx, dir, hmr } = await fixture()
  const moduleWatcher = watchers.at(-1)!
  const file = join(dir, 'nested.yml')
  writeFileSync(file, '[]\n')
  const imported = vi.spyOn(ctx.loader, 'import').mockResolvedValue(Include)
  onTestFinished(() => { imported.mockRestore() })
  const id = await ctx.loader.create({ name: 'include', config: { path: pathToFileURL(file).href } })
  await ctx.loader.await()
  const include = ctx.loader.resolve(id).subtree as Include
  const refresh = vi.spyOn(include, 'refresh')
  moduleWatcher.emit('change', file)
  await vi.waitFor(() => { expect(refresh).toHaveBeenCalledOnce() })
  await hmr.runExclusive(async () => {})
  const refreshed = Promise.withResolvers<undefined>()
  const registered = await hmr.watchConfig(file, async () => { refreshed.resolve(undefined) })
  const observed = Promise.withResolvers<string>()
  ctx.on('hmr/change', (url) => { observed.resolve(url) })
  moduleWatcher.emit('change', file)
  moduleWatcher.emit('change', 'ack.txt')
  await observed.promise
  watchers.at(-1)!.emit('change', file)
  await refreshed.promise
  await registered()
  await hmr.runExclusive(async () => {})
  expect(refresh).toHaveBeenCalledOnce()
})

it('queues cached module replacements behind configuration mutations and recovers after failure', async () => {
  const { ctx, dir, hmr } = await fixture()
  const file = join(dir, 'source.mjs')
  writeFileSync(file, 'export {}')
  const cached = vi.spyOn(ctx.loader.internal!.loadCache, 'has').mockReturnValue(true)
  onTestFinished(() => { cached.mockRestore() })
  const complete = Promise.withResolvers<undefined>()
  const replacement = vi.spyOn(hmr as unknown as { partialReload(): Promise<void> }, 'partialReload')
    .mockImplementation(async () => { complete.resolve(undefined); throw new Error('module failed') })
  const warning = Promise.withResolvers<undefined>()
  const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => { warning.resolve(undefined) })
  onTestFinished(() => { replacement.mockRestore(); warn.mockRestore() })
  const release = Promise.withResolvers<undefined>()
  onTestFinished(() => { release.resolve(undefined) })
  const entered = Promise.withResolvers<undefined>()
  const operation = hmr.runExclusive(async () => { entered.resolve(undefined); await release.promise })
  await entered.promise
  watchers.at(-1)!.emit('change', file)
  expect(replacement).not.toHaveBeenCalled()
  release.resolve(undefined)
  await operation
  await complete.promise
  await warning.promise
  await hmr.runExclusive(async () => {})
  expect(replacement).toHaveBeenCalledOnce()
})

it('requests the host full-reload hook for framework files', async () => {
  const { ctx, dir, hmr } = await fixture()
  const file = join(dir, 'framework.mjs')
  writeFileSync(file, 'export {}')
  ;(hmr as unknown as { externals: Set<string> }).externals.add(pathToFileURL(join(realpathSync(dir), 'framework.mjs')).href)
  const called = Promise.withResolvers<undefined>()
  const exit = vi.spyOn(ctx.loader, 'exit').mockImplementation(() => { called.resolve(undefined) })
  onTestFinished(() => { exit.mockRestore() })
  watchers.at(-1)!.emit('change', file)
  await called.promise
  await hmr.runExclusive(async () => {})
  expect(exit).toHaveBeenCalledOnce()
})


it('closes an exact watcher from its running transaction', async () => {
  const { hmr, dir } = await fixture()
  const dispose = await hmr.watchConfig(join(dir, 'missing.yml'), async () => {})
  await hmr.runExclusive(async () => { await dispose() })
})

it('rejects unavailable Node internals before starting a watcher', async () => {
  const native = vi.spyOn(ModuleLoader, 'fromInternal').mockReturnValue(undefined)
  onTestFinished(() => { native.mockRestore() })
  await expect(fixture()).rejects.toThrow('--expose-internals')
})

it('rejects watcher startup failure and logs later watcher errors', async () => {
  watchState.error = new Error('watch startup failed')
  onTestFinished(() => { watchState.error = undefined })
  await expect(fixture({ root: ['.'] })).rejects.toThrow('watch startup failed')
  watchState.error = undefined
  const { ctx } = await fixture({ base: '.', root: ['.'] })
  const warn = vi.spyOn(ctx.logger, 'warn')
  watchers.at(-1)!.emit('error', new Error('watch runtime failed'))
  expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'watch runtime failed' }))
})

it('starts without a process entry module', async () => {
  const argv = process.argv
  process.argv = []
  onTestFinished(() => { process.argv = argv })
  const { hmr } = await fixture()
  await hmr.runExclusive(async () => {})
})

it('rebinds configuration handlers when its provider is reconfigured within a reload', async () => {
  const { ctx, hmr, dir, provider } = await fixture()
  const file = join(dir, 'profile.yml')
  writeFileSync(file, '[]')
  const refresh = vi.fn(async () => {})
  const binding = ctx.inject(['hmr'], async (owner) => {
    await owner.effect(() => owner.hmr.watchConfig(file, refresh))
  })
  await binding.await()
  await hmr.runExclusive(async () => {
    provider.update({ root: [], ignored: [], debounce: 1 })
    await provider.await()
    await binding.await()
  })
  expect(ctx.hmr).not.toBe(hmr)
  const current = watchers.at(-1)
  current?.emit('change', file)
  await vi.waitFor(() => { expect(refresh).toHaveBeenCalledOnce() })
})
