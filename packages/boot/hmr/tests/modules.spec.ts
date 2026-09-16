/** Module graph replacement through a real Loader and controlled Node cache. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import NodeModule, { createRequire } from 'node:module'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import Loader, { type ModuleJob, type ModuleLoader } from '@deepseek-ai/cordis-plugin-loader'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { expect, it, onTestFinished, vi } from 'vitest'
import Hmr from '../src/index.ts'

interface ModuleReload {
  internal: ModuleLoader
  externals: Set<string>
  accepted: Set<string>
  declined: Set<string>
  stashed: Set<string>
  analyzeChanges(): Promise<void>
  partialReload(): Promise<void>
}

async function fixture(version: 'v1' | 'v2' = 'v2') {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-hmr-graph-'))
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(dir).href + '/'
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(dir, { recursive: true, force: true }) })
  await ctx.plugin(Loader)
  await ctx.plugin(Timer)
  await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
  const cache = new Map<string, ModuleJob>()
  const imports = new Map<string, Plugin>()
  const resolve = vi.fn((name: string) => ({ url: name }))
  // The adapter supplies only the Node loader operations exercised by HMR.
  const internal = { version, loadCache: cache, resolve,
    resolveSync: (_parent: string, request: { specifier: string }) => resolve(request.specifier),
  } as unknown as ModuleLoader
  const reload = ctx.hmr as unknown as ModuleReload
  reload.internal = internal
  reload.externals = new Set()
  const imported = vi.spyOn(ctx.loader, 'import').mockImplementation(async (name: string) => {
    const plugin = imports.get(name)
    if (plugin === undefined) throw new Error(`missing module: ${name}`)
    return plugin
  })
  const url = (name: string) => pathToFileURL(join(dir, name)).href
  function module(name: string, plugin?: Plugin, children: ModuleJob[] = []): ModuleJob {
    const location = name.startsWith('node:') ? name : url(name)
    // ModuleJob's execution methods belong to Node; this fixture owns its graph and namespace.
    const job = { url: location, linked: Promise.resolve(children),
      module: { url: location, getNamespace: () => plugin },
    } as ModuleJob
    cache.set(location, job)
    if (plugin !== undefined) imports.set(location, plugin)
    return job
  }
  return { ctx, cache, imports, imported, reload, module, url, resolve }
}

it.each(['v1', 'v2'] as const)('replaces a %s module and retains the latest Loader entry configuration', async (version) => {
  const { ctx, module, imports, reload } = await fixture(version)
  const mounted: string[] = []
  const disposed: string[] = []
  const before = { apply(ctx: Context, config: { value: string }) {
    mounted.push(`before:${config.value}`)
    ctx.effect(() => () => { disposed.push('before') })
  } }
  const after = { apply(ctx: Context, config: { value: string }) {
    mounted.push(`after:${config.value}`)
    ctx.effect(() => () => { disposed.push('after') })
  } }
  const job = module('plugin.mjs', before)
  const entry = ctx.loader.resolve(await ctx.loader.create({ name: job.url, config: { value: 'initial' } }))
  await ctx.loader.await()
  await entry.update({ config: { value: 'current' } })
  await ctx.loader.await()
  imports.set(job.url, after)
  const event = vi.fn()
  ctx.on('hmr/reload', event)
  reload.stashed.add(job.url)
  await reload.partialReload()
  expect(mounted.at(-1)).toBe('after:current')
  expect(disposed).toEqual(['before', 'before'])
  expect(event).toHaveBeenCalledOnce()
  await entry.update({ config: { value: 'next' } })
  await ctx.loader.await()
  expect(mounted.at(-1)).toBe('after:next')
})

it('reactivates a source-replaced consumer after provider and consumer configuration changes', async () => {
  const { ctx, module, imports, reload } = await fixture()
  const mounted: string[] = []
  const provider = module('provider.mjs', { apply(ctx: Context, config: { revision: number }) {
    ctx.provide('test.revision', config.revision)
  } })
  const before = { inject: ['test.revision'], apply() {} }
  const after = { inject: ['test.revision'], apply(ctx: Context, config: { value: string }) {
    mounted.push(`${config.value}:${ctx.get('test.revision')}`)
  } }
  const consumer = module('consumer.mjs', before)
  const providerEntry = ctx.loader.resolve(await ctx.loader.create({ name: provider.url, config: { revision: 1 } }))
  const consumerEntry = ctx.loader.resolve(await ctx.loader.create({ name: consumer.url, config: { value: 'initial' } }))
  await ctx.loader.await()
  imports.set(consumer.url, after)
  reload.stashed.add(consumer.url)
  await reload.partialReload()
  expect(mounted).toEqual(['initial:1'])
  await Promise.all([
    providerEntry.update({ config: { revision: 2 } }),
    consumerEntry.update({ config: { value: 'updated' } }),
  ])
  await ctx.loader.await()
  expect(mounted.at(-1)).toBe('updated:2')
})

it('restores cached modules and keeps the old plugin when replacement import fails', async () => {
  const { ctx, module, imported, cache, reload } = await fixture()
  const apply = vi.fn()
  const job = module('plugin.mjs', { apply })
  const entry = ctx.loader.resolve(await ctx.loader.create({ name: job.url }))
  await ctx.loader.await()
  const previous = entry.fiber
  imported.mockRejectedValueOnce(new Error('compile failed'))
  reload.stashed.add(job.url)
  await expect(reload.partialReload()).rejects.toThrow('compile failed')
  expect(cache.get(job.url)).toBe(job)
  expect(entry.fiber).toBe(previous)
  expect(apply).toHaveBeenCalledOnce()
})

it('does not replace a plugin whose dependencies have not changed', async () => {
  const { ctx, module, imported, reload } = await fixture()
  const job = module('plugin.mjs', { apply() {} })
  await ctx.loader.create({ name: job.url })
  await ctx.loader.await()
  const unrelated = module('unrelated.mjs')
  imported.mockClear()
  reload.stashed.add(unrelated.url)
  await reload.partialReload()
  expect(imported).not.toHaveBeenCalled()
})

it('replaces a plugin when a linked dependency changes, excluding framework modules', async () => {
  const { ctx, module, imports, reload } = await fixture()
  const dependency = module('dependency.mjs')
  const framework = module('framework.mjs')
  const job = module('plugin.mjs', { apply() {} }, [dependency, framework])
  await ctx.loader.create({ name: job.url })
  await ctx.loader.await()
  const apply = vi.fn()
  imports.set(job.url, { apply })
  reload.externals.add(framework.url)
  reload.stashed.add(dependency.url)
  await reload.partialReload()
  expect(apply).toHaveBeenCalledOnce()
  expect(reload.accepted).toContain(job.url)
  expect(reload.accepted).not.toContain(framework.url)
})

it('classifies dependency cycles and excludes builtins and unchanged leaf modules', async () => {
  const { module, reload } = await fixture()
  const changed = module('changed.mjs')
  const cycleA = module('a.mjs')
  const cycleB = module('b.mjs', undefined, [cycleA])
  cycleA.linked = Promise.resolve([cycleB])
  const parent = module('parent.mjs', undefined, [changed])
  const leaf = module('leaf.mjs')
  const builtin = module('node:fs')
  parent.linked = Promise.resolve([builtin, changed])
  changed.linked = Promise.resolve([parent, cycleA, leaf, builtin])
  reload.stashed.add(changed.url)
  await reload.analyzeChanges()
  expect(reload.accepted).toEqual(new Set([changed.url, parent.url]))
  expect(reload.declined).toEqual(new Set([leaf.url, cycleA.url, cycleB.url]))
})

it('rejects failed replacement activation and restores the prior plugin', async () => {
  const { ctx, module, imports, cache, reload } = await fixture()
  const mounted: string[] = []
  const original = { apply: () => { mounted.push('original') } }
  const job = module('plugin.mjs', original)
  const entry = ctx.loader.resolve(await ctx.loader.create({ name: job.url }))
  await ctx.loader.await()
  imports.set(job.url, { apply() { throw new Error('activation failed') } })
  const event = vi.fn()
  ctx.on('hmr/reload', event)
  reload.stashed.add(job.url)
  await expect(reload.partialReload()).rejects.toThrow('activation failed')
  expect(cache.get(job.url)).toBe(job)
  expect(mounted).toEqual(['original', 'original'])
  expect(entry.fiber?.runtime?.callback).toBe(original.apply)
  expect(event).not.toHaveBeenCalled()
})


it('leaves disposed child instances to their replacing parent', async () => {
  const { ctx, module, imports, reload } = await fixture()
  const seen: string[] = []
  const original = { apply(_ctx: Context, config: { value: string }) { seen.push(config.value) } }
  const job = module('plugin.mjs', original)
  const entry = ctx.loader.resolve(await ctx.loader.create({ name: job.url, config: { value: 'entry' } }))
  await ctx.loader.await()
  await entry.fiber!.ctx.plugin(original, { value: 'child' })
  await ctx.plugin(original, { value: 'independent' })
  imports.set(job.url, { apply(_ctx: Context, config: { value: string }) { seen.push(`new:${config.value}`) } })
  reload.stashed.add(job.url)
  await reload.partialReload()
  expect(seen).toContain('new:entry')
  expect(seen).not.toContain('new:child')
  expect(seen).toContain('new:independent')
  expect(entry.fiber?._config).toEqual({ value: 'entry' })
})

it('invalidates a disabled module without activating it', async () => {
  const { ctx, module, imports, reload } = await fixture()
  const job = module('disabled.mjs', { apply() {} })
  const id = await ctx.loader.create({ name: job.url, disabled: true })
  const apply = vi.fn()
  imports.set(job.url, { apply })
  reload.stashed.add(job.url)
  await reload.partialReload()
  expect(ctx.loader.resolve(id).fiber).toBeUndefined()
  expect(apply).not.toHaveBeenCalled()
})

it('does not disturb an unchanged runtime after an earlier replacement fails', async () => {
  const { ctx, module, imports, reload } = await fixture()
  const first = module('first.mjs', { apply() {} })
  const untouched = vi.fn()
  const second = module('second.mjs', { apply: untouched })
  await ctx.loader.root.update([{ id: 'first', name: first.url }, { id: 'second', name: second.url }])
  await ctx.loader.await()
  imports.set(first.url, { apply() { throw new Error('failed before second') } })
  reload.stashed.add(first.url)
  reload.stashed.add(second.url)
  await expect(reload.partialReload()).rejects.toThrow('failed before second')
  expect(untouched).toHaveBeenCalledOnce()
})

it('restores the prior plugin when the replacement does not export a plugin', async () => {
  const { ctx, module, imported, reload } = await fixture()
  const original = { apply: vi.fn() }
  const job = module('plugin.mjs', original)
  await ctx.loader.create({ name: job.url })
  await ctx.loader.await()
  imported.mockResolvedValueOnce({ notAPlugin: true })
  reload.stashed.add(job.url)
  await expect(reload.partialReload()).rejects.toThrow('invalid plugin')
  expect(original.apply).toHaveBeenCalledTimes(2)
})

it('reports a missing entry base URL without changing the running module', async () => {
  const { ctx, module, reload } = await fixture()
  const job = module('plugin.mjs', { apply() {} })
  const entry = ctx.loader.resolve(await ctx.loader.create({ name: job.url }))
  await ctx.loader.await()
  const missingBase = new Context()
  onTestFinished(() => missingBase.fiber.dispose())
  entry.parent.tree.ctx = missingBase
  reload.stashed.add(job.url)
  await expect(reload.partialReload()).rejects.toThrow('no base URL')
})

it('ignores framework entries and reports unresolved entry modules', async () => {
  const { ctx, module, resolve, reload } = await fixture()
  const framework = module('framework.mjs', { apply() {} })
  const uncached = module('uncached.mjs', { apply() {} })
  await ctx.loader.create({ name: framework.url })
  await ctx.loader.create({ name: uncached.url })
  await ctx.loader.await()
  reload.externals.add(framework.url)
  resolve.mockImplementation((name) => {
    if (name === uncached.url) throw new Error('entry gone')
    return { url: name }
  })
  reload.stashed.add(module('dependency.mjs').url)
  const warn = vi.spyOn(ctx.logger, 'warn')
  await reload.partialReload()
  expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'entry gone' }))
  expect(await ctx.hmr.getLinked('missing')).toEqual([])
})


it.each(['uncached', 'no-plugin'])('leaves an entry alone when its cache is %s', async (state) => {
  const { ctx, module, cache, imported, reload } = await fixture()
  const job = module('plugin.mjs', { apply() {} })
  await ctx.loader.create({ name: job.url })
  await ctx.loader.await()
  if (state === 'uncached') cache.delete(job.url)
  else job.module!.getNamespace = () => undefined
  imported.mockClear()
  reload.stashed.add(module('changed.mjs').url)
  await reload.partialReload()
  expect(imported).not.toHaveBeenCalled()
})

it('restores the CommonJS cache when an ESM replacement import fails', async () => {
  const { ctx, module, imported, reload } = await fixture()
  const job = module('plugin.cjs', { apply() {} })
  await ctx.loader.create({ name: job.url })
  await ctx.loader.await()
  const require = createRequire(import.meta.url)
  const filename = fileURLToPath(job.url)
  const cached = new NodeModule(filename)
  require.cache[filename] = cached
  onTestFinished(() => { Reflect.deleteProperty(require.cache, filename) })
  imported.mockRejectedValueOnce(new Error('compile failed'))
  reload.stashed.add(job.url)
  await expect(reload.partialReload()).rejects.toThrow('compile failed')
  expect(require.cache[filename]).toBe(cached)
})

it('can replace a plugin that has an earlier activation failure', async () => {
  const { ctx, module, imports, reload } = await fixture()
  const job = module('plugin.mjs', { apply() { throw new Error('earlier activation failed') } })
  await ctx.loader.create({ name: job.url })
  await ctx.loader.await()
  const apply = vi.fn()
  imports.set(job.url, { apply })
  reload.stashed.add(job.url)
  await reload.partialReload()
  expect(apply).toHaveBeenCalledOnce()
})

it('reports the original replacement failure when restoring the old plugin also fails', async () => {
  const { ctx, module, imports, reload } = await fixture()
  let restoring = false
  const job = module('plugin.mjs', { apply() {
    if (restoring) throw new Error('restore failed')
  } })
  await ctx.loader.create({ name: job.url })
  await ctx.loader.await()
  restoring = true
  imports.set(job.url, { apply() { throw new Error('replacement failed') } })
  const warn = vi.spyOn(ctx.logger, 'warn')
  reload.stashed.add(job.url)
  await expect(reload.partialReload()).rejects.toThrow('replacement failed')
  expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'restore failed' }))
})
