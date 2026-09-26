/** Loader commits volatile config values into running fibers without remounting; ordinary changes keep the update lifecycle. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis'
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import z from '@deepseek-ai/schemastery'
import { Config } from './volatile-config.fixture.ts'
import Hmr from '@deepseek-ai/dsh-hmr'
import { boot, reconcileProfilePatches } from '@deepseek-ai/dsh-app-boot'

function context() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  return ctx
}

async function runtimeContext() {
  const ctx = context()
  await ctx.plugin(Loader)
  return ctx
}

async function mountEntry(ctx: Context, plugin: Plugin, config: unknown = {}): Promise<Fiber> {
  const name = `consumer-${Object.keys(ctx.loader.builtins).length}`
  ctx.loader.builtins[name] = plugin
  const id = await ctx.loader.create({ name: `cordis:${name}`, config })
  const fiber = ctx.loader.resolve(id).fiber!
  await fiber.await()
  return fiber
}

async function update(fiber: Fiber, config: unknown): Promise<void> {
  await fiber.entry!.update({ config })
  await fiber.await()
}

describe('volatile Loader updates', () => {
  it('updates a whole-config reference and reports the root path', async () => {
    const ctx = await runtimeContext()
    const Config = z.object({ title: z.string() }).volatile()
    const events = vi.fn()
    const fiber = await mountEntry(ctx, { Config, apply(owner: Context) {
      owner.on('loader/volatile-update', events)
    } }, { title: 'first' })
    const reference = fiber.config as ReturnType<typeof Config>
    await update(fiber, { title: 'second' })
    expect(fiber.config).toBe(reference)
    expect(reference.get()).toEqual({ title: 'second' })
    expect(events).toHaveBeenCalledExactlyOnceWith([[]])
  })
  it('commits all references before one local event without remounting', async () => {
    const ctx = await runtimeContext()
    const configs: ReturnType<typeof Config>[] = []
    const observed: unknown[] = []
    const mount = vi.fn(function (owner: Context, config: ReturnType<typeof Config>) {
      configs.push(config)
      owner.on('loader/volatile-update', paths => observed.push({ paths, title: config.title.get(), count: config.nested.count.get() }))
    })
    const first = await mountEntry(ctx, { Config, apply: mount }, {})
    await mountEntry(ctx, { Config, apply: mount }, {})
    const initial = configs[0]!
    const title = initial.title
    await update(first, { title: 'hello' })
    expect(observed).toEqual([])
    await update(first, { title: 'next', nested: { count: 2 } })
    await first.await()
    expect(mount).toHaveBeenCalledTimes(2)
    expect(first.config).toBe(initial)
    expect(initial.title).toBe(title)
    expect(configs[1]!.title.get()).toBe('hello')
    expect(observed).toEqual([{ paths: [['title'], ['nested', 'count']], title: 'next', count: 2 }])
    await update(first, { title: 'next', nested: { count: 2 } })
    expect(observed).toHaveLength(1)
    await update(first, { optional: 'added' })
    expect(initial.optional.get()).toBe('added')
    await update(first, {})
    expect(initial.optional.get()).toBeUndefined()
  })

  it('keeps references on invalid updates and replaces them on mixed updates', async () => {
    const ctx = await runtimeContext()
    const notifications = vi.fn()
    const disposed = vi.fn()
    const configs: ReturnType<typeof Config>[] = []
    const plugin = { Config, apply(owner: Context, config: ReturnType<typeof Config>) {
      configs.push(config)
      owner.on('loader/volatile-update', notifications)
      owner.effect(() => disposed)
    } }
    const fiber = await mountEntry(ctx, plugin, {})
    const before = configs[0]!
    await update(fiber, { title: 'invalid candidate', nested: { count: -1 } })
    expect(before.title.get()).toBe('hello')
    expect(notifications).not.toHaveBeenCalled()
    await update(fiber, { title: 'new', fixed: 'restart' })
    await fiber.await()
    expect(configs).toHaveLength(2)
    expect(disposed).toHaveBeenCalledOnce()
    expect(notifications).not.toHaveBeenCalled()
    expect(before.title.get()).toBe('hello')
    expect(configs[1]!.title.get()).toBe('new')
    expect(configs[1]!.title).not.toBe(before.title)
  })

  it('bypasses custom update hooks for volatile changes and retains them for mixed changes', async () => {
    const ctx = await runtimeContext()
    const hooks: string[] = []
    const globalHook = vi.fn((_config: unknown, _noSave: boolean, next: () => void) => { next() })
    ctx.on('internal/update', globalHook, { global: true })
    const fiber = await mountEntry(ctx, { Config, apply(owner: Context) {
      owner.on('internal/update', (config: ReturnType<typeof Config>) => {
        hooks.push(config.title.get())
      })
    } }, {})
    const initial = fiber.config as ReturnType<typeof Config>
    await update(fiber, { title: 'accepted' })
    expect(fiber.config).toBe(initial)
    expect(initial.title.get()).toBe('accepted')
    await update(fiber, { title: 'accepted' })
    expect(hooks).toEqual([])
    expect(globalHook).not.toHaveBeenCalled()
    await update(fiber, { title: 'custom', fixed: 'changed' })
    expect(hooks).toEqual(['custom'])
    expect(initial.title.get()).toBe('accepted')
  })

  it('compares ordinary dates and arrays and retains the existing nonvolatile restart behavior', async () => {
    const ctx = await runtimeContext()
    const schema = z.object({ live: z.string().volatile(), date: z.date(), list: z.array(z.string()) })
    const apply = vi.fn(function () {})
    const fiber = await mountEntry(ctx, { Config: schema, apply }, { live: 'a', date: '2026-01-01', list: ['a'] })
    await update(fiber, { live: 'b', date: '2026-01-01', list: ['a'] })
    await fiber.await()
    expect(apply).toHaveBeenCalledOnce()
    await update(fiber, { live: 'c', date: '2026-01-02', list: ['a'] })
    await fiber.await()
    expect(apply).toHaveBeenCalledTimes(2)
    await update(fiber, { live: 'd', date: '2026-01-02', list: ['b'] })
    await fiber.await()
    expect(apply).toHaveBeenCalledTimes(3)
    const ordinary = await mountEntry(ctx, { Config: z.object({ value: z.string() }), apply() { apply() } }, { value: 'same' })
    ordinary.update({ value: 'same' })
    await ordinary.await()
    expect(apply).toHaveBeenCalledTimes(5)
  })

  it('resolves pending updates and creates fresh references after dependency replacement', async () => {
    const ctx = await runtimeContext()
    const configs: ReturnType<typeof Config>[] = []
    const consumer = await mountEntry(ctx, { Config, inject: ['volatile-test-provider'], apply(_ctx: Context, config: ReturnType<typeof Config>) {
      configs.push(config)
    } }, {})
    await update(consumer, { title: 'pending' })
    const provider = await ctx.plugin({ apply(owner: Context) { owner.provide('volatile-test-provider', {}) } })
    await consumer.await()
    expect(configs[0]!.title.get()).toBe('pending')
    await update(consumer, { title: 'live' })
    await provider.dispose()
    const before = configs[0]!.title
    await ctx.plugin({ apply(owner: Context) { owner.provide('volatile-test-provider', {}) } })
    await consumer.await()
    expect(configs).toHaveLength(2)
    expect(configs[1]!.title.get()).toBe('live')
    expect(configs[1]!.title).not.toBe(before)
  })

  it('remounts for changed class instances and cyclic ordinary config', async () => {
    const ctx = await runtimeContext()
    const schema = z.object({
      live: z.string().volatile(),
      url: z.transform(z.string(), value => new URL(value)),
      data: z.transform(z.string(), () => { const data: Record<string, unknown> = {}; data.self = data; return data }),
    })
    const apply = vi.fn(function () {})
    const oldUrl = 'https://a.example/'
    const newUrl = 'https://b.example/'
    const fiber = await mountEntry(ctx, { Config: schema, apply }, { live: 'a', url: oldUrl })
    const before = fiber.config as ReturnType<typeof schema>
    await update(fiber, { live: 'b', url: newUrl })
    await fiber.await()
    expect(apply).toHaveBeenCalledTimes(2)
    expect((fiber.config as ReturnType<typeof schema>).url.href).toBe(newUrl)
    expect(before.live.get()).toBe('a')
    await update(fiber, { live: 'c', url: newUrl, data: 'first' })
    await update(fiber, { live: 'd', url: newUrl, data: 'second' })
    expect(apply).toHaveBeenCalledTimes(4)
  })

  it('distinguishes undefined from null inside volatile arrays', async () => {
    const ctx = await runtimeContext()
    const schema = z.object({ values: z.array(z.any()).volatile() })
    const events = vi.fn()
    const fiber = await mountEntry(ctx, { Config: schema, apply(owner: Context) {
      owner.on('loader/volatile-update', events)
    } }, { values: [undefined] })
    await update(fiber, { values: [null] })
    expect((fiber.config as ReturnType<typeof schema>).values.get()).toEqual([null])
    expect(events).toHaveBeenCalledExactlyOnceWith([['values']])
  })
})

it('reloads real YAML and persists plain values independently of custom update hooks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-volatile-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  const configs: ReturnType<typeof Config>[] = []
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  const updates = vi.fn()
  const consumer = { Config, apply(owner: Context, config: ReturnType<typeof Config>) {
    configs.push(config)
    owner.on('internal/update', updates)
  } }
  ctx.loader.builtins['volatile-test'] = consumer
  const filename = join(root, 'cordis.yml')
  await writeFile(filename, '- id: group\n  name: cordis:group\n  group: true\n  config:\n    - id: consumer\n      name: cordis:volatile-test\n      config:\n        title: initial\n')
  const rootId = await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(filename).href } })
  await ctx.loader.await()
  const include = ctx.loader.resolve(rootId).subtree as Include
  const group = include.store.group!.fiber!
  const groupUid = group.uid
  const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'consumer')!
  expect(configs[0]!.title.get()).toBe('initial')
  await ctx.plugin(Timer)
  // An exact-file config watch mirrors the HMR root-watch Include path, which packages/boot/hmr covers with a mocked watcher.
  await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
  const stopWatching = await ctx.hmr.watchConfig(filename, async () => {
    await include.refresh()
    await ctx.loader.await()
  })
  await writeFile(filename, '- id: group\n  name: cordis:group\n  group: true\n  config:\n    - id: consumer\n      name: cordis:volatile-test\n      config:\n        title: file-update\n')
  // The config watcher stabilizes writes for two seconds before publishing a change.
  await vi.waitFor(() => { expect(configs[0]!.title.get()).toBe('file-update') }, { timeout: 10_000 })
  await stopWatching()
  expect(configs).toHaveLength(1)
  expect(include.store.group!.fiber).toBe(group)
  expect(group.uid).toBe(groupUid)
  expect(configs[0]!.title.get()).toBe('file-update')
  entry.fiber!.update({ title: 'program-update', group: { list: ['item'] } })
  expect(entry.options.config).toEqual({ title: 'program-update', group: { list: ['item'] } })
  entry.fiber!.update({ title: 'ephemeral' }, true)
  expect(entry.options.config).toEqual({ title: 'program-update', group: { list: ['item'] } })
  await ctx.fiber.dispose()
  const saved = await readFile(filename, 'utf8')
  expect(saved).toContain('program-update')
  expect(saved).not.toContain('get:')
  expect(saved).not.toContain('ephemeral')
  expect(updates).toHaveBeenCalledTimes(2)
  const restored = context()
  restored.baseUrl = ctx.baseUrl
  await restored.plugin(Loader)
  restored.loader.builtins.include = Include
  restored.loader.builtins.group = Group
  restored.loader.builtins['volatile-test'] = consumer
  await restored.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(filename).href } })
  await restored.loader.await()
  expect(configs).toHaveLength(2)
  expect(configs[1]!.title.get()).toBe('program-update')
  expect(configs[1]!.group.get()).toEqual({ list: ['item'] })
  await restored.fiber.dispose()
})

it('updates volatile children through Group and Include custom updates and saves ordinary config', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-volatile-tree-'))
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }) })
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.group = Group
  const configs: ReturnType<typeof Config>[] = []
  const notifications = vi.fn()
  const childUpdates = vi.fn()
  ctx.loader.builtins['volatile-test'] = { Config, apply(owner: Context, config: ReturnType<typeof Config>) {
    configs.push(config)
    owner.on('loader/volatile-update', notifications)
    owner.on('internal/update', childUpdates)
  } }
  const child = (title: string) => ({ id: 'consumer', name: 'cordis:volatile-test', config: { title } })
  const filename = join(root, 'tree.json')
  const includePath = pathToFileURL(filename).href
  await writeFile(filename, JSON.stringify([{ id: 'group', name: 'cordis:group', group: true, config: [child('initial')] }]))
  const rootId = await ctx.loader.create({ name: 'cordis:include', config: { path: includePath } })
  await ctx.loader.await()
  const includeEntry = ctx.loader.resolve(rootId)
  const include = includeEntry.subtree as Include
  const group = include.store.group!
  const consumer = include.store.consumer!
  const originalInclude = includeEntry.fiber
  const originalGroup = group.fiber
  const originalConsumer = consumer.fiber
  const initial = configs[0]!

  group.fiber!.update([child('group-update')])
  await ctx.loader.await()
  expect(initial.title.get()).toBe('group-update')
  expect(group.options.config).toEqual([child('group-update')])
  includeEntry.fiber!.update({ path: includePath, patches: [{ id: 'consumer', config: { title: 'include-update' } }] })
  await ctx.loader.await()
  expect(initial.title.get()).toBe('include-update')
  expect(includeEntry.fiber).toBe(originalInclude)
  expect(group.fiber).toBe(originalGroup)
  expect(consumer.fiber).toBe(originalConsumer)
  expect(consumer.fiber!.config).toBe(initial)
  expect(configs).toHaveLength(1)
  expect(notifications).toHaveBeenCalledTimes(2)
  expect(childUpdates).not.toHaveBeenCalled()

  const ordinary = await ctx.loader.create({ name: 'cordis:volatile-test', config: {} })
  const entry = ctx.loader.resolve(ordinary)
  entry.fiber!.update({ title: 'custom-update', fixed: 'ordinary' })
  expect(childUpdates).toHaveBeenCalledOnce()
  expect(entry.options.config).toEqual({ title: 'custom-update', fixed: 'ordinary' })
  expect((entry.fiber!.config as ReturnType<typeof Config>).title.get()).toBe('hello')
  entry.fiber!.update({ title: 'ephemeral', fixed: 'ordinary' }, true)
  expect(childUpdates).toHaveBeenCalledTimes(2)
  expect(entry.options.config).toEqual({ title: 'custom-update', fixed: 'ordinary' })
  expect(() => { entry.fiber!.update({ nested: { count: -1 } }) }).toThrow()
  expect(childUpdates).toHaveBeenCalledTimes(2)
  expect(entry.options.config).toEqual({ title: 'custom-update', fixed: 'ordinary' })
})

it('commits volatile edits in place and retains direct Fiber updates', async () => {
  const ctx = await runtimeContext()
  const notifications = vi.fn()
  const apply = vi.fn(function (owner: Context) { owner.on('loader/volatile-update', notifications) })
  const fiber = await mountEntry(ctx, { Config, apply }, {})
  const original = fiber.config as ReturnType<typeof Config>
  await ctx.loader.create({ name: 'cordis:disabled', disabled: true })
  await update(fiber, { title: 'enabled' })
  expect(apply).toHaveBeenCalledOnce()
  expect(fiber.config).toBe(original)
  expect(original.title.get()).toBe('enabled')
  expect(notifications).toHaveBeenCalledExactlyOnceWith([['title']])
  await update(fiber, { title: 'invalid', nested: { count: -1 } })
  expect(original.title.get()).toBe('enabled')
  await update(fiber, { title: 'mixed', fixed: 'changed' })
  expect(apply).toHaveBeenCalledTimes(2)
  expect(original.title.get()).toBe('enabled')
  const current = fiber.config as ReturnType<typeof Config>
  expect(current.title.get()).toBe('mixed')

  const hook = vi.fn((_config: unknown, _noSave: boolean, next: () => void) => { next() })
  fiber.ctx.on('internal/update', hook)
  fiber.update({ title: 'direct' })
  await fiber.await()
  expect(hook).toHaveBeenCalledOnce()
  expect(apply).toHaveBeenCalledTimes(3)
  expect(current.title.get()).toBe('mixed')
  expect(notifications).toHaveBeenCalledOnce()
})

it('parses a volatile-only update through the config hook without patching the entry context', async () => {
  const ctx = await runtimeContext()
  const trace: string[] = []
  const trim = vi.fn((value: string) => { trace.push('validate'); return value.trim() })
  const Config = z.object({ block: z.object({ title: z.transform(z.string(), trim, true) }).volatile() })
  const fiber = await mountEntry(ctx, { Config, apply(owner: Context) {
    owner.on('loader/volatile-update', () => { trace.push('notify') })
  } }, { block: { title: 'initial' } })
  const current = fiber.config as ReturnType<typeof Config>
  const resolveHook = vi.fn((_raw: unknown, next: () => unknown) => next())
  fiber.ctx.on('internal/config', resolveHook)
  const contextPatch = vi.fn((_entry: unknown, next: () => void) => { next() })
  ctx.on('loader/patch-context', contextPatch)
  trim.mockClear()
  trace.length = 0
  const raw = { block: { title: ' changed ' } }
  await fiber.entry!.update({ config: raw })
  expect(contextPatch).not.toHaveBeenCalled()
  expect(trim).toHaveBeenCalledExactlyOnceWith(' changed ')
  expect(resolveHook).toHaveBeenCalledOnce()
  expect(trace).toEqual(['validate', 'notify'])
  expect(current.block.get()).toEqual({ title: 'changed' })
  expect(fiber._config).toBe(raw)
})

it.each([true, false])('keeps old references untouched when isolation replaces a dependency (available: %s)', async (available) => {
  const ctx = await runtimeContext()
  const configs: ReturnType<typeof Config>[] = []
  const notifications = vi.fn()
  ctx.loader.builtins.provider = { apply(owner: Context) { owner.provide('volatile-isolated-service', {}) } }
  ctx.loader.builtins.consumer = {
    inject: ['volatile-isolated-service'], Config,
    apply(owner: Context, config: ReturnType<typeof Config>) {
      configs.push(config)
      owner.on('loader/volatile-update', notifications)
    },
  }
  const provider = (realm: string) => ctx.loader.create({
    name: 'cordis:provider', isolate: { 'volatile-isolated-service': realm },
  })
  await provider('a')
  if (available) await provider('b')
  const id = await ctx.loader.create({
    name: 'cordis:consumer', isolate: { 'volatile-isolated-service': 'a' }, config: { title: 'old' },
  })
  await ctx.loader.await()
  const original = configs[0]!
  await ctx.loader.resolve(id).update({ isolate: { 'volatile-isolated-service': 'b' }, config: { title: 'new' } })
  await ctx.loader.await()
  expect(configs).toHaveLength(available ? 2 : 1)
  expect(original.title.get()).toBe('old')
  expect(notifications).not.toHaveBeenCalled()
  if (!available) {
    await provider('b')
    await ctx.loader.await()
  }
  expect(configs).toHaveLength(2)
  expect(configs[1]!.title.get()).toBe('new')
})

it.each(['group', 'include'] as const)('applies profile patches to a %s subtree without HMR and keeps mixed updates on the normal lifecycle', async (kind) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-volatile-profile-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const configs: ReturnType<typeof Config>[] = []
  const events = vi.fn()
  const dispose = vi.fn()
  const consumer = { Config, apply(owner: Context, config: ReturnType<typeof Config>) {
    configs.push(config)
    owner.on('loader/volatile-update', events)
    owner.effect(() => dispose)
  } }
  const child = (title: string, fixed = 'fixed') => ({ id: 'consumer', name: 'cordis:consumer', config: { title, fixed } })
  const nested = join(root, 'nested.json')
  await writeFile(nested, JSON.stringify([child('initial')]))
  const carrierConfig = (title: string, fixed = 'fixed') => kind === 'group'
    ? [child(title, fixed)]
    : { path: pathToFileURL(nested).href, patches: [{ id: 'consumer', config: { title, fixed } }] }
  const filename = join(root, 'cordis.yml')
  await writeFile(filename, JSON.stringify([{ id: 'parent', name: `cordis:${kind}`, group: kind === 'group', config: carrierConfig('initial') }]))
  const ctx = await boot('volatile-test', filename, undefined, async (ctx) => {
    ctx.loader.builtins.consumer = consumer
  })
  onTestFinished(() => ctx.fiber.dispose())
  expect(ctx.get('hmr')).toBeUndefined()
  const parent = [...ctx.loader.entries()].find(entry => entry.options.id === 'parent')!
  const entry = [...ctx.loader.entries()].find(entry => entry.options.id === 'consumer')!
  const parentFiber = parent.fiber
  const childFiber = entry.fiber
  const original = configs[0]!
  const reference = original.title
  const patch = (title: string, fixed = 'fixed') => [{ id: 'parent', config: carrierConfig(title, fixed) }]
  await reconcileProfilePatches(ctx, patch('first'), 'volatile-test')
  await reconcileProfilePatches(ctx, patch('second'), 'volatile-test')
  expect(parent.fiber).toBe(parentFiber)
  expect(entry.fiber).toBe(childFiber)
  expect(entry.fiber!.config).toBe(original)
  expect(original.title).toBe(reference)
  expect(reference.get()).toBe('second')
  expect(configs).toHaveLength(1)
  expect(dispose).not.toHaveBeenCalled()
  expect(events).toHaveBeenCalledTimes(2)
  expect(events).toHaveBeenLastCalledWith([['title']])
  await reconcileProfilePatches(ctx, patch('second'), 'volatile-test')
  expect(events).toHaveBeenCalledTimes(2)
  await reconcileProfilePatches(ctx, patch('mixed', 'changed'), 'volatile-test')
  expect(parent.fiber).toBe(parentFiber)
  expect(configs).toHaveLength(2)
  expect(dispose).toHaveBeenCalledOnce()
  expect(reference.get()).toBe('second')
  expect(configs[1]!.title.get()).toBe('mixed')
  expect(events).toHaveBeenCalledTimes(2)
})

it('logs an invalid candidate and keeps its references while other entries commit', async () => {
  const ctx = await runtimeContext()
  const events = vi.fn()
  const plugin = { Config, apply(owner: Context) { owner.on('loader/volatile-update', events) } }
  const invalid = await mountEntry(ctx, plugin)
  const healthy = await mountEntry(ctx, plugin)
  const warning = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warning.mockRestore() })
  await invalid.entry!.update({ config: { title: 'invalid', nested: { count: -1 } } })
  await healthy.entry!.update({ config: { title: 'healthy' } })
  expect(warning).toHaveBeenCalledTimes(2)
  expect((invalid.config as ReturnType<typeof Config>).title.get()).toBe('hello')
  expect(invalid._config).toEqual({ title: 'invalid', nested: { count: -1 } })
  expect((healthy.config as ReturnType<typeof Config>).title.get()).toBe('healthy')
  expect(events).toHaveBeenCalledExactlyOnceWith([['title']])
})

it.each([false, true])('retains raw expression edits for dependency restoration (volatile: %s)', async (volatile) => {
  const ctx = await runtimeContext()
  const schema = z.object({ value: volatile ? z.string().volatile() : z.string() })
  const values: unknown[] = []
  const provide = (a: string, b: string) => ctx.plugin({ apply(owner: Context) { owner.provide('volatile-expression-source', { a, b }) } })
  const provider = await provide('same', 'same')
  const fiber = await mountEntry(ctx, { Config: schema, inject: ['volatile-expression-source'], apply(_owner: Context, config: ReturnType<typeof schema>) {
    values.push(typeof config.value === 'string' ? config.value : config.value.get())
  } }, { value: { __jsExpr: "ctx.get('volatile-expression-source').a" } })
  const raw = { value: { __jsExpr: "ctx.get('volatile-expression-source').b" } }
  await fiber.entry!.update({ config: raw })
  await fiber.await()
  expect(values).toEqual(volatile ? ['same'] : ['same', 'same'])
  expect(fiber._config).toBe(raw)
  await provider.dispose()
  await provide('old-route', 'new-route')
  await fiber.await()
  expect(values).toEqual(volatile ? ['same', 'new-route'] : ['same', 'same', 'new-route'])
})

it('remounts when changed expressions resolve to ordinary values different from the live config', async () => {
  const ctx = await runtimeContext()
  const source = { a: 'initial', b: 'initial' }
  ctx.provide('volatile-expression-source', source)
  const configs: ReturnType<typeof Config>[] = []
  const events = vi.fn()
  const fiber = await mountEntry(ctx, { Config, apply(owner: Context, config: ReturnType<typeof Config>) {
    configs.push(config)
    owner.on('loader/volatile-update', events)
  } }, { fixed: { __jsExpr: "ctx.get('volatile-expression-source').a" }, title: 'old' })
  source.a = source.b = 'changed'
  await update(fiber, { fixed: { __jsExpr: "ctx.get('volatile-expression-source').b" }, title: 'new' })
  expect(configs).toHaveLength(2)
  expect(configs[0]!.title.get()).toBe('old')
  expect(configs[1]!.fixed).toBe('changed')
  expect(configs[1]!.title.get()).toBe('new')
  expect(events).not.toHaveBeenCalled()
})

it('compares ordinary URL transforms by value and remounts when an expression result changes', async () => {
  const ctx = await runtimeContext()
  const source = { value: 'initial' }
  ctx.provide('volatile-transform-source', source)
  const schema = z.object({
    url: z.transform(z.string(), value => new URL(value), true),
    fixed: z.string(),
    live: z.string().volatile(),
  })
  const events = vi.fn()
  const mount = vi.fn(function (owner: Context) { owner.on('loader/volatile-update', events) })
  const fixed = { __jsExpr: "ctx.get('volatile-transform-source').value" }
  const raw = { url: 'https://example.com/', fixed, live: 'old' }
  const fiber = await mountEntry(ctx, { Config: schema, apply: mount }, raw)
  const current = fiber.config as ReturnType<typeof schema>
  await update(fiber, { ...raw, live: 'new' })
  expect(mount).toHaveBeenCalledOnce()
  expect(fiber.config).toBe(current)
  expect(current.url.href).toBe(raw.url)
  expect(current.fixed).toBe('initial')
  expect(current.live.get()).toBe('new')
  expect(events).toHaveBeenCalledExactlyOnceWith([['live']])
  source.value = 'changed'
  await update(fiber, { ...raw, live: 'remounted' })
  expect(mount).toHaveBeenCalledTimes(2)
  expect(current.fixed).toBe('initial')
  expect(current.live.get()).toBe('new')
  expect(events).toHaveBeenCalledOnce()
  const replaced = fiber.config as ReturnType<typeof schema>
  expect(replaced.fixed).toBe('changed')
  expect(replaced.live.get()).toBe('remounted')
})

it('remounts when an ordinary parent expression removes a live reference path', async () => {
  const ctx = await runtimeContext()
  const source: { block: { value: string } | undefined } = { block: { value: 'old' } }
  ctx.provide('volatile-path-source', source)
  const schema = z.object({ block: z.object({ value: z.string().volatile() }).extra('default', undefined), live: z.string().volatile() })
  const events = vi.fn()
  const mount = vi.fn(function (owner: Context) { owner.on('loader/volatile-update', events) })
  const raw = { block: { __jsExpr: "ctx.get('volatile-path-source').block" }, live: 'old' }
  const fiber = await mountEntry(ctx, { Config: schema, apply: mount }, raw)
  const current = fiber.config as ReturnType<typeof schema>
  source.block = undefined
  await update(fiber, { ...raw, live: 'new' })
  expect(mount).toHaveBeenCalledTimes(2)
  expect(current.block.value.get()).toBe('old')
  expect(events).not.toHaveBeenCalled()
  expect((fiber.config as ReturnType<typeof schema>).block).toBeUndefined()
})

it('keeps an ordinary plugin mounted when an absent object becomes its explicit default', async () => {
  const ctx = await runtimeContext()
  const Config = z.object({ nested: z.object({ fixed: z.string() }).default({ fixed: 'default' }) })
  const mount = vi.fn()
  const fiber = await mountEntry(ctx, { Config, apply: mount }, {})
  const config: unknown = fiber.config
  await update(fiber, { nested: { fixed: 'default' } })
  expect(fiber.config).toBe(config)
  expect(mount).toHaveBeenCalledTimes(1)
  await update(fiber, { nested: { fixed: 'changed' } })
  expect(mount).toHaveBeenCalledTimes(2)
  expect(fiber.config).toEqual({ nested: { fixed: 'changed' } })
})

it('keeps a noSave volatile value as the pending raw config across a no-op entry update', async () => {
  const ctx = await runtimeContext()
  const fiber = await mountEntry(ctx, { Config, apply() {} }, { title: 'saved' })
  fiber.update({ title: 'ephemeral' }, true)
  await fiber.await()
  expect((fiber.config as ReturnType<typeof Config>).title.get()).toBe('ephemeral')
  expect(fiber.entry!.options.config).toEqual({ title: 'saved' })
  await fiber.entry!.update({ config: { title: 'saved' } })
  expect(fiber._config).toEqual({ title: 'ephemeral' })
  expect((fiber.config as ReturnType<typeof Config>).title.get()).toBe('ephemeral')
})

it('isolates a failing notification listener and dispatches with a Context receiver', async () => {
  const ctx = await runtimeContext()
  const receivers: unknown[] = []
  const fiber = await mountEntry(ctx, { Config, apply(owner: Context) {
    owner.on('loader/volatile-update', function (this: Context) { receivers.push(this.fiber); throw new Error('listener boom') })
  } }, {})
  const other = await mountEntry(ctx, { Config, apply() {} }, {})
  const warning = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warning.mockRestore() })
  await update(fiber, { title: 'committed' })
  expect((fiber.config as ReturnType<typeof Config>).title.get()).toBe('committed')
  expect(receivers).toEqual([fiber])
  expect(warning).toHaveBeenCalledWith(expect.objectContaining({ message: 'listener boom' }))
  await update(other, { title: 'unaffected' })
  expect((other.config as ReturnType<typeof Config>).title.get()).toBe('unaffected')
})

it('remounts instead of committing when an ordinary field parses into a fresh class instance', async () => {
  const ctx = await runtimeContext()
  class Handle { constructor(public readonly name: string) {} }
  const schema = z.object({ handle: z.transform(z.string(), value => new Handle(value)), live: z.string().volatile() })
  const mount = vi.fn()
  const fiber = await mountEntry(ctx, { Config: schema, apply: mount }, { handle: 'h', live: 'old' })
  const before = fiber.config as ReturnType<typeof schema>
  await update(fiber, { handle: 'h', live: 'new' })
  expect(mount).toHaveBeenCalledTimes(2)
  expect(before.live.get()).toBe('old')
  expect((fiber.config as ReturnType<typeof schema>).live.get()).toBe('new')
})
