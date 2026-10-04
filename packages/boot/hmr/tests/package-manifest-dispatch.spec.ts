/** HMR dispatch of package manifest changes through a real Loader and a controlled watcher. */
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { FSWatcher, type ChokidarOptions } from 'chokidar'
import { expect, it, onTestFinished, vi } from 'vitest'
import Hmr from '../src/index.ts'

const watchers = vi.hoisted(() => [] as FSWatcher[])
// File notifications are delivered only when a test emits them.
vi.mock('chokidar', async (original) => {
  const actual = await original<typeof import('chokidar')>()
  return { ...actual, watch: (_paths: string | string[], options: ChokidarOptions = {}) => {
    const watcher = new actual.FSWatcher(options)
    watchers.push(watcher)
    queueMicrotask(() => watcher.emit('ready'))
    return watcher
  } }
})

function file(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source)
}

function plugin(marker: string): string {
  return `import { value } from '#dep';
export function apply(ctx) {
  ctx.get('manifestTrace').push('start:${marker}:' + value);
  ctx.effect(() => () => { ctx.get('manifestTrace').push('stop:${marker}'); });
}
`
}

function manifest(entry: string, dep: string): string {
  return JSON.stringify({ name: 'addon', type: 'module', exports: `./${entry}.mjs`, imports: { '#dep': `./${dep}.mjs` } })
}

async function fixture(source = plugin('a'), options: { lateHmr?: boolean; packageJson?: string } = {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-hmr-manifest-dispatch-')))
  const ctx = new Context()
  onTestFinished(async () => {
    try { await ctx.fiber.dispose() } finally { rmSync(root, { recursive: true, force: true }) }
  })
  const pkg = join(root, 'plugins', 'addon')
  file(join(pkg, 'package.json'), options.packageJson ?? manifest('a', 'dep-1'))
  file(join(pkg, 'a.mjs'), source)
  file(join(pkg, 'b.mjs'), plugin('b'))
  file(join(pkg, 'dep-1.mjs'), 'export const value = 1')
  file(join(pkg, 'dep-2.mjs'), 'export const value = 2')
  file(join(root, 'app', 'package.json'), '{"type":"module"}')
  mkdirSync(join(root, 'app', 'node_modules'), { recursive: true })
  symlinkSync(pkg, join(root, 'app', 'node_modules', 'addon'), process.platform === 'win32' ? 'junction' : 'dir')
  const trace: string[] = []
  ctx.baseUrl = pathToFileURL(join(root, 'app')).href + '/'
  ctx.provide('manifestTrace', trace)
  await ctx.plugin(Loader)
  await ctx.plugin(Timer)
  const startHmr = async () => {
    const start = watchers.length
    const fiber = (await ctx.plugin(Hmr, { root: ['../plugins'], ignored: [], debounce: 0 })).ctx.fiber
    return { fiber, watcher: watchers.slice(start).at(-1)! }
  }
  const initialHmr = options.lateHmr ? undefined : await startHmr()
  const entry = ctx.loader.resolve(await ctx.loader.create({ name: 'addon' }))
  await ctx.loader.await()
  let hmr = initialHmr ?? await startHmr()
  const warn = vi.spyOn(ctx.logger, 'warn')
  onTestFinished(() => { warn.mockRestore() })
  const restartHmr = async () => {
    await hmr.fiber.dispose()
    hmr = await startHmr()
  }
  const emit = async (...paths: string[]) => {
    const dispatch = vi.spyOn(ctx.hmr, 'runExclusive')
    try {
      for (const path of paths) hmr.watcher.emit('change', path)
      await vi.waitFor(() => { expect(dispatch).toHaveBeenCalledOnce() })
      const result = dispatch.mock.results[0]!
      expect(result.type).toBe('return')
      await result.value
    } finally {
      dispatch.mockRestore()
    }
  }
  return { ctx, pkg, trace, emit, entry, warn, restartHmr }
}

it('does not reload for a manifest alone and resolves the new entry when the Loader entry restarts', async () => {
  const f = await fixture()
  expect(f.trace).toEqual(['start:a:1'])
  file(join(f.pkg, 'package.json'), manifest('b', 'dep-2'))
  await f.emit(join(f.pkg, 'package.json'))
  expect(f.trace).toEqual(['start:a:1'])

  await f.entry.update({ disabled: true })
  await f.entry.update({ disabled: false })
  await f.ctx.loader.await()
  expect(f.trace).toEqual(['start:a:1', 'stop:a', 'start:b:2'])
})

const jsonPlugin = `import manifest from './package.json' with { type: 'json' };
export function apply(ctx) {
  ctx.get('manifestTrace').push('start:json:' + manifest.imports['#dep']);
  ctx.effect(() => () => { ctx.get('manifestTrace').push('stop:json'); });
}
`

it('reloads a plugin that imports its changed manifest as a JSON module', async () => {
  const f = await fixture(jsonPlugin)
  expect(f.trace).toEqual(['start:json:./dep-1.mjs'])
  file(join(f.pkg, 'package.json'), manifest('a', 'dep-2'))
  await f.emit(join(f.pkg, 'package.json'))
  expect(f.trace).toEqual(['start:json:./dep-1.mjs', 'stop:json', 'start:json:./dep-2.mjs'])
})

it('requests a host reload for a changed manifest in the host module graph', async () => {
  const f = await fixture(jsonPlugin)
  const filename = join(f.pkg, 'package.json')
  const externals = Reflect.get(f.ctx.hmr, 'externals') as Set<string>
  externals.add(pathToFileURL(filename).href)
  const exit = vi.spyOn(f.ctx.loader, 'exit').mockImplementation(() => {})
  onTestFinished(() => { exit.mockRestore() })
  file(filename, manifest('a', 'dep-2'))
  await f.emit(filename)
  expect(exit).toHaveBeenCalledOnce()
  expect(f.trace).toEqual(['start:json:./dep-1.mjs'])
})

it('leaves a configuration-owned manifest to its dedicated watcher', async () => {
  const f = await fixture(jsonPlugin)
  const filename = join(f.pkg, 'package.json')
  const dispose = await f.ctx.hmr.watchConfig(filename, async () => {})
  try {
    file(filename, manifest('a', 'dep-2'))
    await f.emit(filename)
    expect(f.trace).toEqual(['start:json:./dep-1.mjs'])
  } finally {
    await dispose()
  }
})

it('resolves package imports from the changed manifest when a source change reloads the plugin', async () => {
  const f = await fixture()
  file(join(f.pkg, 'package.json'), manifest('a', 'dep-2'))
  file(join(f.pkg, 'a.mjs'), `${plugin('a')}// edited\n`)
  await f.emit(join(f.pkg, 'a.mjs'), join(f.pkg, 'package.json'))
  await f.ctx.loader.await()
  expect(f.trace).toEqual(['start:a:1', 'stop:a', 'start:a:2'])
})

it('keeps cached package imports when only source changes', async () => {
  const f = await fixture()
  file(join(f.pkg, 'package.json'), manifest('a', 'dep-2'))
  file(join(f.pkg, 'a.mjs'), `${plugin('a')}// edited\n`)
  await f.emit(join(f.pkg, 'a.mjs'))
  await f.ctx.loader.await()
  expect(f.trace).toEqual(['start:a:1', 'stop:a', 'start:a:1'])
})

it('leaves manifests below node_modules to their package lifecycle', async () => {
  const f = await fixture()
  const installed = join(dirname(f.pkg), 'node_modules', 'dep', 'package.json')
  file(installed, '{"name":"dep"}')
  const invalidate = vi.spyOn(Reflect.get(f.ctx.hmr, 'manifests') as { invalidate(path: string): void }, 'invalidate')
  onTestFinished(() => { invalidate.mockRestore() })
  await f.emit(installed)
  expect(invalidate).not.toHaveBeenCalled()
})

it.each(['exports', 'main'] as const)('keeps reloading the loaded entry after %s moves and selects the new entry on restart', async (field) => {
  const packageJson = (entry: string, dep: string) => JSON.stringify({
    name: 'addon', type: 'module', [field]: `./${entry}.mjs`, imports: { '#dep': `./${dep}.mjs` },
  })
  const f = await fixture(plugin('a'), { packageJson: packageJson('a', 'dep-1') })
  const originalNamespace = f.entry.moduleNamespace
  file(join(f.pkg, 'package.json'), packageJson('b', 'dep-2'))
  await f.emit(join(f.pkg, 'package.json'))
  expect(f.trace).toEqual(['start:a:1'])
  expect(f.entry.moduleNamespace).toBe(originalNamespace)
  file(join(f.pkg, 'a.mjs'), plugin('a-edited'))
  await f.emit(join(f.pkg, 'a.mjs'))
  expect(f.trace).toEqual(['start:a:1', 'stop:a', 'start:a-edited:2'])
  expect(f.entry.moduleNamespace).not.toBe(originalNamespace)
  expect(f.entry.moduleNamespace).toBe(await f.ctx.loader.import(pathToFileURL(join(f.pkg, 'a.mjs')).href))
  await f.entry.update({ disabled: true })
  await f.entry.update({ disabled: false })
  await f.ctx.loader.await()
  expect(f.trace).toEqual(['start:a:1', 'stop:a', 'start:a-edited:2', 'stop:a-edited', 'start:b:2'])
  expect(f.warn).not.toHaveBeenCalled()
})

it('retains the loaded entry through repeated reloads when the new entry is already cached', async () => {
  const f = await fixture()
  file(join(f.pkg, 'package.json'), manifest('b', 'dep-2'))
  await f.emit(join(f.pkg, 'package.json'))
  await f.ctx.loader.import('addon')
  const originalNamespace = f.entry.moduleNamespace
  file(join(f.pkg, 'a.mjs'), plugin('a-first'))
  await f.emit(join(f.pkg, 'a.mjs'))
  const firstNamespace = f.entry.moduleNamespace
  expect(firstNamespace).not.toBe(originalNamespace)
  file(join(f.pkg, 'a.mjs'), plugin('a-second'))
  await f.emit(join(f.pkg, 'a.mjs'))
  expect(f.entry.moduleNamespace).not.toBe(firstNamespace)
  expect(f.trace).toEqual(['start:a:1', 'stop:a', 'start:a-first:2', 'stop:a-first', 'start:a-second:2'])
  expect(f.warn).not.toHaveBeenCalled()
})

it.each(['apply', 'apply as default'])('retains a re-export entry using its namespace when it exports %s', async (exported) => {
  const f = await fixture(`export { ${exported} } from './b.mjs';\n`)
  const implementation: unknown = await f.ctx.loader.import(pathToFileURL(join(f.pkg, 'b.mjs')).href)
  expect(implementation).toMatchObject({ apply: f.entry.fiber?.runtime?.callback })
  expect(f.entry.moduleNamespace).not.toBe(implementation)
  file(join(f.pkg, 'c.mjs'), plugin('c'))
  file(join(f.pkg, 'package.json'), manifest('c', 'dep-1'))
  await f.emit(join(f.pkg, 'package.json'))
  file(join(f.pkg, 'dep-1.mjs'), 'export const value = 2')
  await f.emit(join(f.pkg, 'dep-1.mjs'))
  expect(f.trace).toEqual(['start:b:1', 'stop:b', 'start:b:2'])
  expect(f.entry.moduleNamespace).toBe(await f.ctx.loader.import(pathToFileURL(join(f.pkg, 'a.mjs')).href))
  await f.entry.update({ disabled: true })
  await f.entry.update({ disabled: false })
  await f.ctx.loader.await()
  expect(f.trace).toEqual(['start:b:1', 'stop:b', 'start:b:2', 'stop:b', 'start:c:2'])
  expect(f.warn).not.toHaveBeenCalled()
})

it('tracks an entry loaded before HMR starts', async () => {
  const f = await fixture(plugin('a'), { lateHmr: true })
  file(join(f.pkg, 'package.json'), manifest('b', 'dep-1'))
  await f.emit(join(f.pkg, 'package.json'))
  file(join(f.pkg, 'a.mjs'), plugin('a-late'))
  await f.emit(join(f.pkg, 'a.mjs'))
  expect(f.trace).toEqual(['start:a:1', 'stop:a', 'start:a-late:1'])
  expect(f.warn).not.toHaveBeenCalled()
})

it('keeps entry identity when HMR is recreated between source reloads', async () => {
  const f = await fixture()
  file(join(f.pkg, 'a.mjs'), plugin('a-first'))
  await f.emit(join(f.pkg, 'a.mjs'))
  const firstNamespace = f.entry.moduleNamespace
  await f.restartHmr()
  expect(f.entry.moduleNamespace).toBe(firstNamespace)
  file(join(f.pkg, 'a.mjs'), plugin('a-second'))
  await f.emit(join(f.pkg, 'a.mjs'))
  expect(f.entry.moduleNamespace).not.toBe(firstNamespace)
  expect(f.trace).toEqual(['start:a:1', 'stop:a', 'start:a-first:1', 'stop:a-first', 'start:a-second:1'])
  expect(f.warn).not.toHaveBeenCalled()
})

it('leaves an unimported disabled entry without a Node cache entry alone', async () => {
  const f = await fixture()
  const disabled = f.ctx.loader.resolve(await f.ctx.loader.create({
    name: pathToFileURL(join(f.pkg, 'b.mjs')).href, disabled: true,
  }))
  expect(disabled.moduleNamespace).toBeUndefined()
  file(join(f.pkg, 'a.mjs'), plugin('a-edited'))
  await f.emit(join(f.pkg, 'a.mjs'))
  expect(disabled.moduleNamespace).toBeUndefined()
  expect(disabled.fiber).toBeUndefined()
  expect(f.trace).toEqual(['start:a:1', 'stop:a', 'start:a-edited:1'])
  expect(f.warn).not.toHaveBeenCalled()
})

it('leaves a cordis builtin outside the Node namespace index without reporting an error', async () => {
  const f = await fixture()
  const builtin = { apply: vi.fn() }
  f.ctx.loader.builtins.fixture = builtin
  const entry = f.ctx.loader.resolve(await f.ctx.loader.create({ name: 'cordis:fixture' }))
  await f.ctx.loader.await()
  expect(entry.moduleNamespace).toBe(builtin)
  file(join(f.pkg, 'a.mjs'), plugin('a-edited'))
  await f.emit(join(f.pkg, 'a.mjs'))
  expect(builtin.apply).toHaveBeenCalledOnce()
  expect(f.trace).toEqual(['start:a:1', 'stop:a', 'start:a-edited:1'])
  expect(f.warn).not.toHaveBeenCalled()
})

it('updates disabled entry namespaces through repeated reloads without activating them', async () => {
  const f = await fixture()
  const originalNamespace = f.entry.moduleNamespace
  await f.entry.update({ disabled: true })
  await f.ctx.loader.await()
  file(join(f.pkg, 'a.mjs'), plugin('disabled-first'))
  await f.emit(join(f.pkg, 'a.mjs'))
  const firstNamespace = f.entry.moduleNamespace
  expect(firstNamespace).not.toBe(originalNamespace)
  expect(firstNamespace).toBe(await f.ctx.loader.import('addon'))
  expect(f.trace).toEqual(['start:a:1', 'stop:a'])
  file(join(f.pkg, 'a.mjs'), plugin('disabled-second'))
  await f.emit(join(f.pkg, 'a.mjs'))
  expect(f.entry.moduleNamespace).not.toBe(firstNamespace)
  expect(f.trace).toEqual(['start:a:1', 'stop:a'])
  expect(f.warn).not.toHaveBeenCalled()
  await f.entry.update({ disabled: false })
  await f.ctx.loader.await()
  expect(f.trace).toEqual(['start:a:1', 'stop:a', 'start:disabled-second:1'])
})

it('reports a resolution error for an unimported entry through the existing warning path', async () => {
  const f = await fixture()
  await f.ctx.loader.create({ name: './missing-plugin.mjs', disabled: true })
  file(join(f.pkg, 'a.mjs'), plugin('a-edited'))
  await f.emit(join(f.pkg, 'a.mjs'))
  expect(f.warn).toHaveBeenCalledWith(expect.objectContaining({ code: 'ERR_MODULE_NOT_FOUND' }))
  expect(f.trace).toEqual(['start:a:1', 'stop:a', 'start:a-edited:1'])
})

it('reports a recorded namespace missing from the cache while reloading another entry', async () => {
  const f = await fixture()
  const originalFiber = f.entry.fiber
  const originalNamespace = f.entry.moduleNamespace
  await f.ctx.loader.create({ name: pathToFileURL(join(f.pkg, 'b.mjs')).href })
  await f.ctx.loader.await()
  expect(Map.prototype.delete.call(f.ctx.loader.internal!.loadCache, pathToFileURL(join(f.pkg, 'a.mjs')).href)).toBe(true)
  file(join(f.pkg, 'b.mjs'), plugin('b-edited'))
  await f.emit(join(f.pkg, 'b.mjs'))
  expect(f.warn).toHaveBeenCalledWith(expect.objectContaining({
    message: `HMR cannot locate the loaded module for addon from ${f.ctx.baseUrl}`,
  }))
  expect(f.entry.fiber).toBe(originalFiber)
  expect(f.entry.moduleNamespace).toBe(originalNamespace)
  expect(f.trace).toEqual(['start:a:1', 'start:b:1', 'stop:b', 'start:b-edited:1'])
})

it.each(['import', 'activation'] as const)('retains the prior namespace after replacement %s fails and can reload again', async (phase) => {
  const f = await fixture()
  const originalNamespace = f.entry.moduleNamespace
  const originalCallback = f.entry.fiber?.runtime?.callback
  const message = `replacement ${phase} failed`
  file(join(f.pkg, 'a.mjs'), phase === 'import'
    ? `throw new Error(${JSON.stringify(message)});\n${plugin('failed')}`
    : `export function apply() { throw new Error(${JSON.stringify(message)}); }`)
  await expect(f.emit(join(f.pkg, 'a.mjs'))).rejects.toThrow(message)
  expect(f.entry.moduleNamespace).toBe(originalNamespace)
  expect(await f.ctx.loader.import('addon')).toBe(originalNamespace)
  expect(f.entry.fiber?.runtime?.callback).toBe(originalCallback)
  expect(f.trace).toEqual(phase === 'import' ? ['start:a:1'] : ['start:a:1', 'stop:a', 'start:a:1'])
  file(join(f.pkg, 'a.mjs'), plugin('recovered'))
  await f.emit(join(f.pkg, 'a.mjs'))
  expect(f.entry.moduleNamespace).not.toBe(originalNamespace)
  expect(f.trace.at(-1)).toBe('start:recovered:1')
})

it('reloads a native CommonJS entry and retains its new import namespace', async () => {
  const f = await fixture()
  const filename = join(f.pkg, 'common.cjs')
  const source = (version: number) => `exports.apply = ctx => {
    ctx.get('manifestTrace').push('start:cjs:${version}');
    ctx.effect(() => () => { ctx.get('manifestTrace').push('stop:cjs:${version}'); });
  };`
  file(filename, source(1))
  const entry = f.ctx.loader.resolve(await f.ctx.loader.create({ name: pathToFileURL(filename).href }))
  await f.ctx.loader.await()
  const originalNamespace = entry.moduleNamespace
  file(filename, source(2))
  await f.emit(filename)
  expect(entry.moduleNamespace).not.toBe(originalNamespace)
  expect(entry.moduleNamespace).toBe(await f.ctx.loader.import(pathToFileURL(filename).href))
  expect(f.trace).toEqual(['start:a:1', 'start:cjs:1', 'stop:cjs:1', 'start:cjs:2'])
  expect(f.warn).not.toHaveBeenCalled()
})

it('handles an entry still evaluating while another entry reloads', async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const key = 'dsh-hmr-pending-entry-' + randomUUID()
  Reflect.set(globalThis, key, { entered: () => { entered.resolve(undefined) }, wait: release.promise })
  f.ctx.provide('releasePendingEntry', () => { release.resolve(undefined) })
  const filename = join(f.pkg, 'pending.mjs')
  file(filename, `const gate = globalThis[${JSON.stringify(key)}]; gate.entered(); await gate.wait;\n${plugin('pending')}`)
  const loading = f.ctx.loader.create({ name: pathToFileURL(filename).href })
  onTestFinished(async () => {
    release.resolve(undefined)
    try { await loading } finally { Reflect.deleteProperty(globalThis, key) }
  })
  try {
    await entered.promise
    file(join(f.pkg, 'a.mjs'), plugin('a-edited').replace('export function apply(ctx) {',
      "export function apply(ctx) { ctx.get('releasePendingEntry')();"))
    await f.emit(join(f.pkg, 'a.mjs'))
    const entry = f.ctx.loader.resolve(await loading)
    await f.ctx.loader.await()
    expect(entry.moduleNamespace).toBe(await f.ctx.loader.import(pathToFileURL(filename).href))
    expect(f.trace).toEqual(['start:a:1', 'stop:a', 'start:a-edited:1', 'start:pending:1'])
    expect(f.warn).not.toHaveBeenCalled()
  } finally {
    release.resolve(undefined)
    await loading
  }
})

it('keeps an active entry namespace when a later same-name entry has never been enabled', async () => {
  const f = await fixture()
  await f.ctx.loader.root.update([
    ...f.ctx.loader.root.data,
    { id: 'disabled-shadow', name: 'addon', disabled: true },
  ])
  await f.ctx.loader.await()
  const disabled = f.ctx.loader.resolve('disabled-shadow')
  expect(disabled.moduleNamespace).toBeUndefined()
  expect(disabled.fiber).toBeUndefined()
  const before = [...f.trace]
  file(join(f.pkg, 'package.json'), manifest('b', 'dep-2'))
  await f.emit(join(f.pkg, 'package.json'))
  expect(f.trace).toEqual(before)
  file(join(f.pkg, 'a.mjs'), plugin('a-edited'))
  await f.emit(join(f.pkg, 'a.mjs'))
  expect(f.trace).toEqual([...before, 'stop:a', 'start:a-edited:2'])
  expect(disabled.fiber).toBeUndefined()
  expect(f.warn).not.toHaveBeenCalled()
})

type DispatchFixture = Awaited<ReturnType<typeof fixture>>

async function addConfiguredEntry(f: DispatchFixture, id: string, name: string, disabled = false) {
  const options = { id, name, disabled }
  const entry = f.ctx.loader.resolve(await f.ctx.loader.create(options))
  await f.ctx.loader.await()
  return entry
}

function cachedNamespace(f: DispatchFixture, filename: string): unknown {
  const url = pathToFileURL(join(f.pkg, filename)).href
  const job = f.ctx.loader.internal!.loadCache.get(url)
  expect(job?.module).toBeDefined()
  return job!.module!.getNamespace()
}

function liveFibers(runtime: Plugin.Runtime | null | undefined) {
  expect(runtime).toBeDefined()
  expect(runtime).not.toBeNull()
  return [...runtime!.fibers].filter(fiber => fiber.uid !== null)
}

async function sharedEntryFixture(kind: 'default' | 'named') {
  const source = kind === 'default'
    ? "export { apply as default } from './b.mjs';\n"
    : "export { apply } from './b.mjs';\n"
  const f = await fixture(source)
  const secondFile = kind === 'default' ? 'c.mjs' : 'b.mjs'
  if (kind === 'default') file(join(f.pkg, secondFile), source)
  const second = await addConfiguredEntry(f, 'shared-second', pathToFileURL(join(f.pkg, secondFile)).href)
  const firstPlugin = f.ctx.loader.unwrapExports(f.entry.moduleNamespace) as Plugin
  const secondPlugin = f.ctx.loader.unwrapExports(second.moduleNamespace) as Plugin
  expect(f.entry.moduleNamespace).not.toBe(second.moduleNamespace)
  expect(f.entry.moduleNamespace).toBe(cachedNamespace(f, 'a.mjs'))
  expect(second.moduleNamespace).toBe(cachedNamespace(f, secondFile))
  if (kind === 'default') expect(firstPlugin).toBe(secondPlugin)
  else expect(firstPlugin).not.toBe(secondPlugin)
  expect(f.entry.fiber?.runtime).toBe(second.fiber?.runtime)
  expect(liveFibers(f.entry.fiber?.runtime)).toHaveLength(2)
  expect(f.trace).toEqual(['start:b:1', 'start:b:1'])
  return { ...f, second, secondFile, firstPlugin }
}

it('reloads both active namespaces for one package name independently after exports move', async () => {
  const f = await fixture()
  const firstNamespace = f.entry.moduleNamespace
  const firstRuntime = f.entry.fiber?.runtime
  file(join(f.pkg, 'package.json'), manifest('b', 'dep-2'))
  await f.emit(join(f.pkg, 'package.json'))
  const second = await addConfiguredEntry(f, 'active-after-move', 'addon')
  const secondNamespace = second.moduleNamespace
  const secondRuntime = second.fiber?.runtime
  expect(firstNamespace).not.toBe(secondNamespace)
  expect(firstRuntime).not.toBe(secondRuntime)
  expect(liveFibers(firstRuntime)).toHaveLength(1)
  expect(liveFibers(secondRuntime)).toHaveLength(1)
  expect(f.trace).toEqual(['start:a:1', 'start:b:2'])

  file(join(f.pkg, 'a.mjs'), plugin('a-independent'))
  await f.emit(join(f.pkg, 'a.mjs'))
  const reloadedFirst = f.entry.moduleNamespace
  expect(reloadedFirst).not.toBe(firstNamespace)
  expect(reloadedFirst).toBe(cachedNamespace(f, 'a.mjs'))
  expect(second.moduleNamespace).toBe(secondNamespace)
  expect(second.fiber?.runtime).toBe(secondRuntime)
  expect(f.trace).toEqual(['start:a:1', 'start:b:2', 'stop:a', 'start:a-independent:2'])

  file(join(f.pkg, 'b.mjs'), plugin('b-independent'))
  await f.emit(join(f.pkg, 'b.mjs'))
  expect(f.entry.moduleNamespace).toBe(reloadedFirst)
  expect(second.moduleNamespace).not.toBe(secondNamespace)
  expect(second.moduleNamespace).toBe(cachedNamespace(f, 'b.mjs'))
  expect(liveFibers(f.entry.fiber?.runtime)).toHaveLength(1)
  expect(liveFibers(second.fiber?.runtime)).toHaveLength(1)
  expect(f.trace).toEqual([
    'start:a:1', 'start:b:2', 'stop:a', 'start:a-independent:2', 'stop:b', 'start:b-independent:2',
  ])
  expect(f.warn).not.toHaveBeenCalled()
})

it('refreshes both default re-export namespaces sharing one plugin without multiplying instances', async () => {
  const f = await sharedEntryFixture('default')
  const firstNamespace = f.entry.moduleNamespace
  const secondNamespace = f.second.moduleNamespace
  const oldFibers = liveFibers(f.entry.fiber?.runtime)
  const before = f.trace.length
  file(join(f.pkg, 'dep-1.mjs'), 'export const value = 2')
  await f.emit(join(f.pkg, 'dep-1.mjs'))

  expect(f.entry.moduleNamespace).not.toBe(firstNamespace)
  expect(f.second.moduleNamespace).not.toBe(secondNamespace)
  expect(f.entry.moduleNamespace).not.toBe(f.second.moduleNamespace)
  expect(f.entry.moduleNamespace).toBe(cachedNamespace(f, 'a.mjs'))
  expect(f.second.moduleNamespace).toBe(cachedNamespace(f, 'c.mjs'))
  expect(f.ctx.loader.unwrapExports(f.entry.moduleNamespace)).toBe(f.ctx.loader.unwrapExports(f.second.moduleNamespace))
  expect(f.entry.fiber?.runtime).toBe(f.second.fiber?.runtime)
  expect(liveFibers(f.entry.fiber?.runtime)).toHaveLength(2)
  expect(oldFibers.every(fiber => fiber.uid === null)).toBe(true)
  expect(f.trace.slice(before).sort()).toEqual(['start:b:2', 'start:b:2', 'stop:b', 'stop:b'])
  expect(f.warn).not.toHaveBeenCalled()
})

it('refreshes named re-export and implementation namespaces sharing a callback without multiplying instances', async () => {
  const f = await sharedEntryFixture('named')
  const firstNamespace = f.entry.moduleNamespace
  const secondNamespace = f.second.moduleNamespace
  const oldFibers = liveFibers(f.entry.fiber?.runtime)
  const before = f.trace.length
  file(join(f.pkg, 'b.mjs'), plugin('implementation-updated'))
  await f.emit(join(f.pkg, 'b.mjs'))

  expect(f.entry.moduleNamespace).not.toBe(firstNamespace)
  expect(f.second.moduleNamespace).not.toBe(secondNamespace)
  expect(f.entry.moduleNamespace).toBe(cachedNamespace(f, 'a.mjs'))
  expect(f.second.moduleNamespace).toBe(cachedNamespace(f, 'b.mjs'))
  expect(f.ctx.loader.unwrapExports(f.entry.moduleNamespace)).not.toBe(f.ctx.loader.unwrapExports(f.second.moduleNamespace))
  expect(f.entry.fiber?.runtime).toBe(f.second.fiber?.runtime)
  expect(liveFibers(f.entry.fiber?.runtime)).toHaveLength(2)
  expect(oldFibers.every(fiber => fiber.uid === null)).toBe(true)
  expect(f.trace.slice(before).sort()).toEqual([
    'start:implementation-updated:1', 'start:implementation-updated:1', 'stop:b', 'stop:b',
  ])
  expect(f.warn).not.toHaveBeenCalled()
})

function activeTraceCount(trace: string[], marker: string): number {
  return trace.filter(event => event.startsWith(`start:${marker}:`)).length
    - trace.filter(event => event === `stop:${marker}`).length
}

it('assigns each entry its own replacement when a shared runtime splits into distinct callbacks', async () => {
  const f = await sharedEntryFixture('default')
  const firstNamespace = f.entry.moduleNamespace
  const secondNamespace = f.second.moduleNamespace
  const oldFibers = liveFibers(f.entry.fiber?.runtime)
  const before = f.trace.length
  file(join(f.pkg, 'a.mjs'), plugin('a-split'))
  file(join(f.pkg, 'c.mjs'), plugin('c-split'))
  await f.emit(join(f.pkg, 'a.mjs'), join(f.pkg, 'c.mjs'))

  expect(f.entry.moduleNamespace).not.toBe(firstNamespace)
  expect(f.second.moduleNamespace).not.toBe(secondNamespace)
  expect(f.entry.moduleNamespace).toBe(cachedNamespace(f, 'a.mjs'))
  expect(f.second.moduleNamespace).toBe(cachedNamespace(f, 'c.mjs'))
  expect(f.entry.moduleNamespace).toMatchObject({ apply: f.entry.fiber?.runtime?.callback })
  expect(f.second.moduleNamespace).toMatchObject({ apply: f.second.fiber?.runtime?.callback })
  expect(f.entry.fiber?.runtime).not.toBe(f.second.fiber?.runtime)
  expect(liveFibers(f.entry.fiber?.runtime)).toHaveLength(1)
  expect(liveFibers(f.second.fiber?.runtime)).toHaveLength(1)
  expect(oldFibers.every(fiber => fiber.uid === null)).toBe(true)
  expect(f.trace.slice(before).sort()).toEqual(['start:a-split:1', 'start:c-split:1', 'stop:b', 'stop:b'])
  expect(f.warn).not.toHaveBeenCalled()
})

it('restores shared entries and a programmatic instance when split replacements are ambiguous', async () => {
  const f = await sharedEntryFixture('default')
  const firstNamespace = f.entry.moduleNamespace
  const secondNamespace = f.second.moduleNamespace
  const programmatic = (await f.ctx.plugin(f.firstPlugin)).ctx.fiber
  expect(programmatic.entry).toBeUndefined()
  expect(liveFibers(f.ctx.registry.get(f.firstPlugin))).toHaveLength(3)
  file(join(f.pkg, 'a.mjs'), plugin('a-split'))
  file(join(f.pkg, 'c.mjs'), plugin('c-split'))
  await expect(f.emit(join(f.pkg, 'a.mjs'), join(f.pkg, 'c.mjs'))).rejects.toThrow(
    'HMR replacement is ambiguous for a plugin instance without a Loader entry',
  )

  expect(f.entry.moduleNamespace).toBe(firstNamespace)
  expect(f.second.moduleNamespace).toBe(secondNamespace)
  expect(cachedNamespace(f, 'a.mjs')).toBe(firstNamespace)
  expect(cachedNamespace(f, 'c.mjs')).toBe(secondNamespace)
  const restored = f.ctx.registry.get(f.firstPlugin)
  const fibers = liveFibers(restored)
  expect(fibers).toHaveLength(3)
  expect(fibers.filter(fiber => fiber.entry === undefined)).toHaveLength(1)
  expect(f.entry.fiber?.runtime).toBe(restored)
  expect(f.second.fiber?.runtime).toBe(restored)
  expect(activeTraceCount(f.trace, 'b')).toBe(3)
  expect(activeTraceCount(f.trace, 'a-split')).toBe(0)
  expect(activeTraceCount(f.trace, 'c-split')).toBe(0)
})

it.each(['import', 'activation'] as const)('restores every shared entry when one replacement %s fails and can reload again', async (phase) => {
  const f = await sharedEntryFixture('default')
  const firstNamespace = f.entry.moduleNamespace
  const secondNamespace = f.second.moduleNamespace
  const message = `shared replacement ${phase} failed`
  file(join(f.pkg, 'a.mjs'), plugin('a-replacement'))
  file(join(f.pkg, 'c.mjs'), phase === 'import'
    ? `throw new Error(${JSON.stringify(message)});\n${plugin('c-failed')}`
    : `export function apply() { throw new Error(${JSON.stringify(message)}); }`)
  await expect(f.emit(join(f.pkg, 'a.mjs'), join(f.pkg, 'c.mjs'))).rejects.toThrow(message)

  expect(f.entry.moduleNamespace).toBe(firstNamespace)
  expect(f.second.moduleNamespace).toBe(secondNamespace)
  expect(cachedNamespace(f, 'a.mjs')).toBe(firstNamespace)
  expect(cachedNamespace(f, 'c.mjs')).toBe(secondNamespace)
  const restored = f.ctx.registry.get(f.firstPlugin)
  expect(f.entry.fiber?.runtime).toBe(restored)
  expect(f.second.fiber?.runtime).toBe(restored)
  expect(liveFibers(restored)).toHaveLength(2)
  expect(activeTraceCount(f.trace, 'b')).toBe(2)
  expect(activeTraceCount(f.trace, 'a-replacement')).toBe(0)
  expect(activeTraceCount(f.trace, 'c-failed')).toBe(0)

  file(join(f.pkg, 'c.mjs'), plugin('c-recovered'))
  await f.emit(join(f.pkg, 'a.mjs'), join(f.pkg, 'c.mjs'))
  expect(f.entry.moduleNamespace).not.toBe(firstNamespace)
  expect(f.second.moduleNamespace).not.toBe(secondNamespace)
  expect(f.entry.moduleNamespace).toBe(cachedNamespace(f, 'a.mjs'))
  expect(f.second.moduleNamespace).toBe(cachedNamespace(f, 'c.mjs'))
  expect(f.entry.moduleNamespace).toMatchObject({ apply: f.entry.fiber?.runtime?.callback })
  expect(f.second.moduleNamespace).toMatchObject({ apply: f.second.fiber?.runtime?.callback })
  expect(f.entry.fiber?.runtime).not.toBe(f.second.fiber?.runtime)
  expect(liveFibers(f.entry.fiber?.runtime)).toHaveLength(1)
  expect(liveFibers(f.second.fiber?.runtime)).toHaveLength(1)
  expect(activeTraceCount(f.trace, 'b')).toBe(0)
  expect(activeTraceCount(f.trace, 'a-replacement')).toBe(1)
  expect(activeTraceCount(f.trace, 'c-recovered')).toBe(1)
})

it('deduplicates a repeated namespace without activating a same-name uninitialized entry', async () => {
  const f = await fixture()
  const second = await addConfiguredEntry(f, 'duplicate-active', 'addon')
  const disabled = await addConfiguredEntry(f, 'duplicate-disabled', 'addon', true)
  const originalNamespace = f.entry.moduleNamespace
  expect(second.moduleNamespace).toBe(originalNamespace)
  expect(disabled.moduleNamespace).toBeUndefined()
  expect(disabled.fiber).toBeUndefined()
  expect(liveFibers(f.entry.fiber?.runtime)).toHaveLength(2)
  file(join(f.pkg, 'package.json'), manifest('b', 'dep-2'))
  await f.emit(join(f.pkg, 'package.json'))
  const before = f.trace.length
  file(join(f.pkg, 'a.mjs'), plugin('deduplicated'))
  await f.emit(join(f.pkg, 'a.mjs'))

  expect(f.entry.moduleNamespace).not.toBe(originalNamespace)
  expect(f.entry.moduleNamespace).toBe(cachedNamespace(f, 'a.mjs'))
  expect(second.moduleNamespace).toBe(f.entry.moduleNamespace)
  expect(f.entry.fiber?.runtime).toBe(second.fiber?.runtime)
  expect(liveFibers(f.entry.fiber?.runtime)).toHaveLength(2)
  expect(disabled.moduleNamespace).toBeUndefined()
  expect(disabled.fiber).toBeUndefined()
  expect(f.trace.slice(before).sort()).toEqual([
    'start:deduplicated:2', 'start:deduplicated:2', 'stop:a', 'stop:a',
  ])
  expect(f.warn).not.toHaveBeenCalled()
})
