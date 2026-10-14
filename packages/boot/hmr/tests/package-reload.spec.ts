/** Profile reconciliation replaces plugins whose installed package files changed, through a real Loader and Node cache. */
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import NodeModule, { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, FiberState, type Plugin } from '@deepseek-ai/cordis'
import Loader, { ModuleLoader, type Entry } from '@deepseek-ai/cordis-plugin-loader'
import {
  boot, initProfile, ProfileRuntimeResolution, readProfileManifest, readProfilePatches, reconcileProfilePatches, ResolutionRestartRequired,
  type PluginPackages, type ProfileContext, type RuntimeResolution,
} from '@deepseek-ai/dsh-app-boot'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { expect, it, onTestFinished, vi } from 'vitest'
import Hmr from '../src/index.ts'

const watchers = vi.hoisted(() => [] as import('chokidar').FSWatcher[])
vi.mock('chokidar', async (original) => {
  const native = await original<typeof import('chokidar')>()
  return { ...native, watch: () => {
    const watcher = new native.FSWatcher()
    watchers.push(watcher)
    queueMicrotask(() => watcher.emit('ready'))
    return watcher
  } }
})

/** Silence the Loader's report of an entry whose import fails. */
function quiet(ctx: Context): void {
  const error = vi.spyOn(ctx.logger, 'error').mockImplementation(() => {})
  onTestFinished(() => { error.mockRestore() })
}

function file(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source)
}

function plugin(version: string, imports = 'shared-lib'): string {
  return `import { value } from '${imports}'
export const name = 'addon-${version}'
export function apply(ctx, config = {}) {
  ctx.get('reloadTrace').push('start:${version}:' + value + ':' + (config.mode ?? '-'))
  ctx.effect(() => () => { ctx.get('reloadTrace').push('stop:${version}') })
}
`
}

function addon(dir: string, version: string, source = plugin(version), mode?: string): void {
  const root = join(dir, 'node_modules', 'addon')
  file(join(root, 'package.json'), JSON.stringify({
    name: 'addon', version, type: 'module', exports: './index.mjs', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  file(join(root, 'index.mjs'), source)
  file(join(root, 'cordis.patch.yml'), `- insert:\n    - id: addon\n      name: addon\n${mode === undefined ? '' : `      config: { mode: ${mode} }\n`}`)
}

function shared(dir: string, value: number): void {
  const root = join(dir, 'node_modules', 'shared-lib')
  file(join(root, 'package.json'), JSON.stringify({ name: 'shared-lib', version: `${String(value)}.0.0`, type: 'module', exports: './index.mjs' }))
  file(join(root, 'index.mjs'), `export const value = ${String(value)}\n`)
}

function other(dir: string): void {
  const root = join(dir, 'node_modules', 'other')
  file(join(root, 'package.json'), JSON.stringify({
    name: 'other', version: '1.0.0', type: 'module', exports: './index.mjs', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  file(join(root, 'index.mjs'), `export function apply(ctx) {
  ctx.get('reloadTrace').push('start:other')
  ctx.effect(() => () => { ctx.get('reloadTrace').push('stop:other') })
}
`)
  file(join(root, 'cordis.patch.yml'), '- insert:\n    - id: other\n      name: other\n')
}

function commonjs(dir: string, value: number): void {
  const root = join(dir, 'node_modules', 'cjs-addon')
  file(join(root, 'package.json'), JSON.stringify({
    name: 'cjs-addon', version: '1.0.0', main: './index.cjs', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  file(join(root, 'index.cjs'), `const { value } = require('./helper.cjs')
exports.apply = (ctx) => {
  ctx.get('reloadTrace').push('start:cjs:' + value)
  ctx.effect(() => () => { ctx.get('reloadTrace').push('stop:cjs') })
}
`)
  file(join(root, 'helper.cjs'), `exports.value = ${String(value)}\n`)
  file(join(root, 'cordis.patch.yml'), '- insert:\n    - id: cjs-addon\n      name: cjs-addon\n')
}

/** Date every file below `dir` an hour back, as for packages installed before the application started. */
function age(dir: string): void {
  const past = new Date(Date.now() - 3_600_000)
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) utimesSync(join(entry.parentPath, entry.name), past, past)
  }
}

function linked(home: string, dir: string, value: number): string {
  const target = join(home, 'work', 'linked')
  file(join(target, 'package.json'), JSON.stringify({
    name: '@local/linked', version: '1.0.0', type: 'module', exports: './index.mjs', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  file(join(target, 'index.mjs'), `export function apply(ctx) {
  ctx.get('reloadTrace').push('start:linked:${String(value)}')
  ctx.effect(() => () => { ctx.get('reloadTrace').push('stop:linked') })
}
`)
  file(join(target, 'cordis.patch.yml'), '- insert:\n    - id: linked\n      name: "@local/linked"\n')
  const link = join(dir, 'node_modules', '@local', 'linked')
  mkdirSync(dirname(link), { recursive: true })
  if (lstatSync(link, { throwIfNoEntry: false }) !== undefined) unlinkSync(link)
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  return target
}

async function fixture(bundles = ['addon', 'other'], before?: (home: string, dir: string) => Promise<void>, ready = true) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hmr-package-reload-')))
  const dir = join(home, 'profiles', 'test')
  initProfile(dir, bundles)
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  addon(dir, '1')
  shared(dir, 1)
  other(dir)
  commonjs(dir, 1)
  linked(home, dir, 1)
  age(home)
  await before?.(home, dir)
  const profile: ProfileContext = {
    name: 'test', dir, patchPath: join(dir, 'cordis.patch.yml'), home, cwd: home,
    installAnchor: join(home, 'package.json'), startedBundles: bundles, overlays: [], telemetryDisabledEnv: undefined,
  }
  writeFileSync(profile.patchPath, JSON.stringify([{ insert: [
    { id: 'timer', name: 'cordis:timer' },
    { id: 'hmr', name: 'cordis:hmr', config: { root: [] } },
  ] }]))
  const trace: string[] = []
  let commit: (() => void) | undefined
  const firstWatcher = watchers.length
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (host) => {
    host.provide('profileContext', profile)
    host.provide('reloadTrace', trace)
    host.provide('appReady', { onReady(listener) { commit = listener; return () => { commit = undefined } } })
    host.loader.builtins.timer = Timer
    host.loader.builtins.hmr = Hmr
  })
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  await ctx.loader.await()
  if (ready) commit?.()
  const reconcile = () => ctx.hmr.runExclusive(() => ctx.hmr.reconcileProfile())
  const select = (bundles: string[]) => {
    const manifest = readProfileManifest('test', dir)
    manifest.dsh = { profile: { bundles } }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  }
  /** Deliver a change of the profile patch file to HMR's own watch and wait for its recomposition. */
  const editPatch = async () => {
    // Each configuration watch ignores paths other than its own file.
    for (const watcher of watchers.slice(firstWatcher)) watcher.emit('change', profile.patchPath)
    await vi.waitFor(async () => { await ctx.hmr.runExclusive(async () => {}) })
    await ctx.hmr.runExclusive(async () => {})
  }
  return { ready: () => commit?.(), ctx, home, dir, trace, reconcile, select, editPatch, profile }
}

it('leaves plugins running when no loaded file changed', async () => {
  const f = await fixture()
  expect(f.trace.toSorted()).toEqual(['start:1:1:-', 'start:other'])
  f.trace.length = 0
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toEqual([])
})

it('keeps a module whose file gains a hard link', async () => {
  const f = await fixture()
  f.trace.length = 0
  linkSync(join(f.dir, 'node_modules', 'addon', 'index.mjs'), join(f.home, 'store-copy.mjs'))
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toEqual([])
})

it('replaces a plugin upgraded in place with the configuration of its new bundle patch', async () => {
  const f = await fixture()
  f.trace.length = 0
  addon(f.dir, '2', plugin('2'), 'fast')
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toEqual(['stop:1', 'start:2:1:fast'])
})

it('starts an upgraded plugin with a configuration its previous version rejects', async () => {
  const f = await fixture()
  addon(f.dir, '1', plugin('1').replace('export function apply(ctx, config = {}) {', "export function apply(ctx, config = {}) {\n  if (config.mode) throw new Error('mode is unsupported')"))
  age(f.dir)
  await f.reconcile()
  f.trace.length = 0
  addon(f.dir, '2', plugin('2'), 'fast')
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toEqual(['stop:1', 'start:2:1:fast'])
})

it('links an entry inserted by the upgraded bundle to the current files of a changed dependency', async () => {
  const f = await fixture()
  const extra = join(f.dir, 'node_modules', 'addon', 'extra.mjs')
  f.trace.length = 0
  shared(f.dir, 2)
  addon(f.dir, '1')
  file(extra, `import { value } from 'shared-lib'
export function apply(ctx) { ctx.get('reloadTrace').push('start:extra:' + value) }
`)
  file(join(f.dir, 'node_modules', 'addon', 'cordis.patch.yml'), '- insert:\n    - id: addon\n      name: addon\n    - id: extra\n      name: ./extra.mjs\n')
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace.toSorted()).toEqual(['start:1:2:-', 'start:extra:2', 'stop:1'])
})

it('leaves a changed plugin that no Loader entry owns for a restart', async () => {
  const f = await fixture([])
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })
  const url = pathToFileURL(join(f.dir, 'node_modules', 'addon', 'index.mjs')).href
  await f.ctx.plugin(f.ctx.loader.unwrapExports(await f.ctx.loader.import(url)) as Plugin)
  expect(f.trace).toEqual(['start:1:1:-'])
  addon(f.dir, '2')
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [{ url, reason: 'unmanaged-plugin' }] })
  expect(f.trace).toEqual(['start:1:1:-'])
})

/** A runtime resolution table mapping `addon` to a directory, with further dropped profile packages. */
function table(addonDir: string, ...dropped: string[]): RuntimeResolution {
  const entry = (name: string, packageDir: string) => ({
    name, packageDir, version: '1.0.0', declarer: join(packageDir, 'package.json'), scope: 'profile' as const,
  })
  return {
    profilesDir: '/profiles', profileDir: '/profiles/test', localPackageNames: ['addon', ...dropped],
    entries: [entry('addon', addonDir), ...dropped.map(name => entry(name, isAbsolute(name) ? name : `/packages/${name}`))],
    linkedRoots: [],
  }
}

/**
 * Install a recomputable runtime resolution whose latest generation is `latest`; `replace` decides each publication.
 * @returns Each publication's mapped packages.
 */
function resolution(
  ctx: Context, latest: RuntimeResolution, replace: () => void = () => {},
  published = table('/packages/addon', 'gone'),
) {
  const source = { installAnchor: '', home: '', profileDir: undefined }
  let current: RuntimeResolution = new ProfileRuntimeResolution(source, published)
  const compute = vi.spyOn(ProfileRuntimeResolution.prototype, 'computeLatestResolution')
    .mockResolvedValue(new ProfileRuntimeResolution(source, latest))
  onTestFinished(() => { compute.mockRestore() })
  const calls: string[] = []
  ctx.provide('pluginPackages', {
    // The compatibility preflight finds no package metadata and admits every row.
    packageOf: () => undefined,
    get resolution() { return current },
    replace(next: RuntimeResolution) {
      calls.push(`publish:${next.entries.map(entry => entry.name).join(',')}`)
      replace()
      current = next
    },
  } as Pick<PluginPackages, 'packageOf' | 'resolution' | 'replace'> as PluginPackages)
  return calls
}

it('stops the rows a generation drops before publishing its resolution, then applies it', async () => {
  const f = await fixture()
  f.trace.length = 0
  const calls = resolution(f.ctx, table('/packages/addon-2'), () => { f.trace.push('published') })
  f.select(['addon'])
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(calls).toEqual(['publish:addon'])
  expect(f.trace).toEqual(['stop:other', 'published'])
})

it.each(['unchanged', 'changed'] as const)('rejects a publication failure, starting %s plugins it stopped again', async (kind) => {
  const f = await fixture()
  f.trace.length = 0
  resolution(f.ctx, table('/packages/addon-2'), () => { throw new Error('resolution unreadable') })
  if (kind === 'changed') addon(f.dir, '2')
  await expect(f.reconcile()).rejects.toThrow('resolution unreadable')
  expect(f.trace).toEqual(kind === 'changed' ? ['stop:1', 'start:2:1:-'] : [])
})

it('reports an entry left waiting for a service the replacement no longer provides as a warning', async () => {
  const f = await fixture(['addon', 'other'], async (_home, dir) => {
    addon(dir, '1', `export function apply(ctx) {
  ctx.get('reloadTrace').push('start:1')
  ctx.provide('addonService', {})
}
`)
    file(join(dir, 'node_modules', 'other', 'index.mjs'), `export const inject = ['addonService']
export function apply(ctx) { ctx.get('reloadTrace').push('start:other') }
`)
    age(join(dir, 'node_modules'))
  })
  quiet(f.ctx)
  f.trace.length = 0
  addon(f.dir, '2', "export function apply(ctx) { ctx.get('reloadTrace').push('start:2') }\n")
  // The entry starts once a provider appears.
  await expect(f.reconcile()).resolves.toMatchObject({ warnings: [expect.stringContaining('addonService')] })
  expect(f.trace).toEqual(['start:2'])
})

it('imports a row the update inserts once when its import fails', async () => {
  const f = await fixture(['addon'])
  const error = vi.spyOn(f.ctx.logger, 'error').mockImplementation(() => {})
  onTestFinished(() => { error.mockRestore() })
  file(join(f.dir, 'node_modules', 'other', 'index.mjs'), "import 'missing-lib'\n")
  f.select(['addon', 'other'])
  await expect(f.reconcile()).rejects.toThrow(/missing-lib/u)
  expect(error.mock.calls.filter(([value]) => String(value).includes('missing-lib'))).toHaveLength(1)
})

it('keeps the publication failure when starting the stopped plugins again throws', async () => {
  const f = await fixture()
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })
  resolution(f.ctx, table('/packages/addon-2'), () => { throw new Error('resolution unreadable') })
  addon(f.dir, '2')
  const settle = vi.spyOn(f.ctx.loader, 'await').mockRejectedValueOnce(new Error('loader unavailable'))
  onTestFinished(() => { settle.mockRestore() })
  await expect(f.reconcile()).rejects.toThrow('resolution unreadable')
  expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'loader unavailable' }))
})

it('logs a stopped plugin that does not start again after the publication fails', async () => {
  const f = await fixture()
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })
  resolution(f.ctx, table('/packages/addon-2'), () => { throw new Error('resolution unreadable') })
  addon(f.dir, '2', "export function apply() { throw new Error('addon cannot start') }\n")
  quiet(f.ctx)
  // An unrelated failed entry is left to the next judgment.
  await f.ctx.loader.create({ name: 'late-plugin' })
  await f.ctx.loader.await()
  await expect(f.reconcile()).rejects.toThrow('resolution unreadable')
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^dsh: addon \(addon\): .*addon cannot start/su))
  expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('late-plugin'))
})

it('reports a stopped entry that no recomposition started again by its fiber state', async () => {
  const f = await fixture()
  const url = pathToFileURL(join(f.dir, 'node_modules', 'addon', 'index.mjs')).href
  const plugin = f.ctx.loader.unwrapExports(await f.ctx.loader.import(url)) as Plugin
  const fibers = [...f.ctx.registry.get(plugin)?.fibers ?? []]
  f.ctx.registry.delete(plugin)
  await Promise.all(fibers.map(fiber => fiber.await()))
  // Applying the same patches leaves the unchanged Include's rows alone.
  const warnings = await f.ctx.hmr.runExclusive(() => reconcileProfilePatches(f.ctx.root, readProfilePatches('test', f.profile), 'test'))
  expect(warnings).toEqual([expect.stringMatching(/^addon \(addon\): fiber state 4/u)])
})

it('logs a failure to restore the stopped rows and still reports the rejected publication', async () => {
  const f = await fixture()
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })
  resolution(f.ctx, table('/packages/addon-2'), () => { throw new ResolutionRestartRequired('installation mapping changed') })
  const include = [...f.ctx.loader.entries()].find(entry => entry.options.id === 'include') as Entry
  const restoring = vi.spyOn(include.subgroup!, 'create').mockRejectedValueOnce(new Error('restore failed'))
  onTestFinished(() => { restoring.mockRestore() })
  f.select(['addon'])
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [], restartReason: 'package-moved' })
  expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'restore failed' }))
})

it('restores the composition while the resolution waits for a restart', async () => {
  const f = await fixture()
  f.trace.length = 0
  resolution(f.ctx, table('/packages/addon-2'), () => { throw new ResolutionRestartRequired('installation mapping changed') })
  f.select(['addon'])
  const config = readFileSync(join(f.dir, 'cordis.yml'), 'utf8')
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [], restartReason: 'package-moved' })
  // The row the generation drops stops before the publication and starts again once it is rejected.
  expect(f.trace).toEqual(['stop:other', 'start:other'])
  // Stopping and restoring rows leaves the profile's configuration file as it was.
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(readFileSync(join(f.dir, 'cordis.yml'), 'utf8')).toBe(config)
})

it('waits for a dropped row to finish disposing, and keeps a stopped kept row stopped, until the resolution publishes', async () => {
  const f = await fixture(['addon', 'other'], async (_home, dir) => {
    file(join(dir, 'node_modules', 'other', 'index.mjs'), `export function apply(ctx) {
  ctx.get('reloadTrace').push('start:other')
  ctx.effect(() => async () => { await new Promise(resolve => setTimeout(resolve, 20)); ctx.get('reloadTrace').push('stop:other') })
}
`)
  })
  f.trace.length = 0
  // The addon's own file changed, so HMR stops its entry before the recomposition.
  addon(f.dir, '2')
  resolution(f.ctx, table('/packages/addon-2'), () => { f.trace.push('published') })
  f.select(['addon'])
  await f.reconcile()
  expect(f.trace).toEqual(['stop:1', 'stop:other', 'published', 'start:2:1:-'])
})

it('puts several dropped rows back at their places when the resolution waits for a restart', async () => {
  const f = await fixture()
  const rows = [{ id: 'timer', name: 'cordis:timer' }, { id: 'hmr', name: 'cordis:hmr', config: { root: [] } }]
  const order = ['first', 'middle', 'second']
  writeFileSync(f.profile.patchPath, JSON.stringify([{ insert: [...rows, { id: 'first', name: 'other' }, { id: 'middle', name: 'other' }, { id: 'second', name: 'other' }] }]))
  await f.reconcile()
  resolution(f.ctx, table('/packages/addon-2'), () => { throw new ResolutionRestartRequired('installation mapping changed') })
  writeFileSync(f.profile.patchPath, JSON.stringify([{ insert: [...rows, { id: 'middle', name: 'other' }] }]))
  await expect(f.reconcile()).resolves.toMatchObject({ restartReason: 'package-moved' })
  const include = [...f.ctx.loader.entries()].find(entry => entry.options.id === 'include') as Entry
  expect(include.subgroup!.data.map(row => row.id).filter(id => order.includes(id))).toEqual(order)
})

it('puts a dropped row back into its group when the resolution waits for a restart', async () => {
  const f = await fixture()
  const rows = [{ id: 'timer', name: 'cordis:timer' }, { id: 'hmr', name: 'cordis:hmr', config: { root: [] } }]
  writeFileSync(f.profile.patchPath, JSON.stringify([{ insert: [...rows, { id: 'group', name: 'cordis:group', config: [{ id: 'child', name: 'other' }] }] }]))
  await f.reconcile()
  f.trace.length = 0
  resolution(f.ctx, table('/packages/addon-2'), () => { throw new ResolutionRestartRequired('installation mapping changed') })
  writeFileSync(f.profile.patchPath, JSON.stringify([{ insert: [...rows, { id: 'group', name: 'cordis:group', config: [] }] }]))
  await expect(f.reconcile()).resolves.toMatchObject({ restartReason: 'package-moved' })
  expect(f.trace).toEqual(['stop:other', 'start:other'])
  const group = [...f.ctx.loader.entries()].find(entry => entry.options.id === 'group') as Entry
  expect(group.subgroup!.data.map(row => row.id)).toEqual(['child'])
})

it('removes a disabled row a generation drops without waiting for a fiber', async () => {
  const f = await fixture()
  const rows = [{ id: 'timer', name: 'cordis:timer' }, { id: 'hmr', name: 'cordis:hmr', config: { root: [] } }]
  writeFileSync(f.profile.patchPath, JSON.stringify([{ insert: [...rows, { id: 'idle', name: 'other', disabled: true }] }]))
  await f.reconcile()
  f.trace.length = 0
  resolution(f.ctx, table('/packages/addon-2'), () => { f.trace.push('published') })
  writeFileSync(f.profile.patchPath, JSON.stringify([{ insert: rows }]))
  await f.reconcile()
  expect(f.trace).toEqual(['published'])
  expect([...f.ctx.loader.entries()].some(entry => entry.options.id === 'idle')).toBe(false)
})

it('stops a row a generation drops from a group before publishing its resolution', async () => {
  const f = await fixture()
  const rows = [{ id: 'timer', name: 'cordis:timer' }, { id: 'hmr', name: 'cordis:hmr', config: { root: [] } }]
  writeFileSync(f.profile.patchPath, JSON.stringify([{ insert: [...rows, { id: 'group', name: 'cordis:group', config: [{ id: 'child', name: 'other' }] }] }]))
  await f.reconcile()
  f.trace.length = 0
  resolution(f.ctx, table('/packages/addon-2'), () => { f.trace.push('published') })
  writeFileSync(f.profile.patchPath, JSON.stringify([{ insert: [...rows, { id: 'group', name: 'cordis:group', config: [] }] }]))
  await f.reconcile()
  expect(f.trace).toEqual(['stop:other', 'published'])
})
it.each(['added', 'nested', 'renamed'] as const)('leaves a generation with an %s row unapplied while the resolution waits for a restart', async (kind) => {
  const f = await fixture(['addon'])
  f.trace.length = 0
  resolution(f.ctx, table('/packages/addon-2'), () => { throw new ResolutionRestartRequired('installation mapping changed') })
  const rows = [{ id: 'timer', name: 'cordis:timer' }, { id: 'hmr', name: 'cordis:hmr', config: { root: [] } }]
  if (kind === 'added') f.select(['addon', 'other'])
  else {
    writeFileSync(f.profile.patchPath, JSON.stringify(kind === 'nested'
      ? [{ insert: [...rows, { id: 'group', name: 'cordis:group', config: [{ id: 'child', name: 'other' }] }] }]
      : [{ insert: rows }, { id: 'addon', name: 'other' }]))
  }
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [], restartReason: 'package-moved' })
  expect(f.trace).toEqual([])
})

it('judges the activation without importing an entry whose import failed before the resolution publishes', async () => {
  const f = await fixture([])
  quiet(f.ctx)
  const id = await f.ctx.loader.create({ name: 'late-plugin' })
  await f.ctx.loader.await()
  await f.reconcile()
  const order: string[] = []
  resolution(f.ctx, table('/packages/addon-2'), () => { order.push('publish') })
  const tree = f.ctx.loader.resolve(id).parent.tree
  const original = tree.import.bind(tree)
  const load = vi.spyOn(tree, 'import').mockImplementation((...args): Promise<unknown> => { order.push('import'); return original(...args) as Promise<unknown> })
  onTestFinished(() => { load.mockRestore() })
  await f.reconcile()
  // Importing before the resolution publishes could evaluate plugin code against the previous mappings.
  expect(order[0]).toBe('publish')
  expect(order).toContain('import')
})

it('keeps an entry that failed to import before as a warning when it fails with another error', async () => {
  const f = await fixture([])
  quiet(f.ctx)
  const id = await f.ctx.loader.create({ name: 'late-plugin' })
  await f.ctx.loader.await()
  await f.reconcile()
  const tree = f.ctx.loader.resolve(id).parent.tree
  const load = vi.spyOn(tree, 'import').mockRejectedValue(new Error('another missing dependency'))
  onTestFinished(() => { load.mockRestore() })
  const result = await f.reconcile()
  expect(result.warnings).toEqual([expect.stringContaining('another missing dependency')])
})

it('records plugins started before application readiness without restarting a recently installed one', async () => {
  const f = await fixture(['addon'], undefined, false)
  // A plugin installed just now starts after HMR but before the application is ready; writing its files stamps them
  // with the file clock, as an installation does.
  other(f.dir)
  await f.ctx.loader.create({ name: 'other' })
  await f.ctx.loader.await()
  f.ready()
  f.trace.length = 0
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toEqual([])
})

// The recomposition that disables the failed entry still retries it, which expires the profile's package
// configuration and evicts its failed modules, so enabling it later reads the installed dependency.
it('loads a failed entry enabled again after its dependency was installed', async () => {
  const f = await fixture(undefined, async (_home, dir) => {
    addon(dir, '1', plugin('1', 'late-lib'))
  })
  quiet(f.ctx)
  const rows = [{ id: 'timer', name: 'cordis:timer' }, { id: 'hmr', name: 'cordis:hmr', config: { root: [] } }]
  writeFileSync(f.profile.patchPath, JSON.stringify([{ insert: rows }, { id: 'addon', disabled: true }]))
  await f.reconcile()
  file(join(f.dir, 'node_modules', 'late-lib', 'package.json'), JSON.stringify({ name: 'late-lib', type: 'module', exports: './index.mjs' }))
  file(join(f.dir, 'node_modules', 'late-lib', 'index.mjs'), 'export const value = 7\n')
  writeFileSync(f.profile.patchPath, JSON.stringify([{ insert: rows }]))
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toContain('start:1:7:-')
})

it('starts a service plugin again once the dependency whose evaluation failed is corrected', async () => {
  const f = await fixture(['addon'], async (_home, dir) => {
    file(join(dir, 'node_modules', 'addon', 'dep.mjs'), "throw new Error('dep fails')\n")
    file(join(dir, 'node_modules', 'addon', 'index.mjs'), `import './dep.mjs'
export default class Addon {
  constructor(ctx) { ctx.get('reloadTrace').push('start:service') }
}
`)
  })
  quiet(f.ctx)
  file(join(f.dir, 'node_modules', 'addon', 'dep.mjs'), 'export {}\n')
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toEqual(['start:service'])
})

it.each(['link', 'missing'] as const)('finds the host module graph through a process entry given as a %s path', async (kind) => {
  const argv = process.argv
  onTestFinished(() => { process.argv = argv })
  const f = await fixture(undefined, async (home, dir) => {
    const main = join(dir, 'main.mjs')
    file(main, "import './node_modules/shared-lib/index.mjs'\n")
    await ModuleLoader.fromInternal()!.import(pathToFileURL(main).href, import.meta.url, {})
    const entry = join(home, 'bin-dsh')
    if (kind === 'link') symlinkSync(main, entry)
    process.argv = [argv[0]!, entry]
  })
  shared(f.dir, 2)
  const url = pathToFileURL(join(f.dir, 'node_modules', 'shared-lib', 'index.mjs')).href
  await expect(f.reconcile()).resolves.toEqual({ warnings: [],
    pending: kind === 'link' ? [{ url, reason: 'host-module' }] : [] })
})

it('leaves a CommonJS plugin registered outside a Loader entry, and its cache, for a restart', async () => {
  const f = await fixture([])
  const require = createRequire(import.meta.url)
  const root = join(f.dir, 'node_modules', 'cjs-addon')
  await f.ctx.plugin(f.ctx.loader.unwrapExports(require(join(root, 'index.cjs'))) as Plugin)
  expect(f.trace).toEqual(['start:cjs:1'])
  const cached = require.cache[join(root, 'helper.cjs')]
  commonjs(f.dir, 2)
  const result = await f.reconcile()
  expect(result.pending).toContainEqual({ url: pathToFileURL(join(root, 'helper.cjs')).href, reason: 'unmanaged-plugin' })
  expect(require.cache[join(root, 'helper.cjs')]).toBe(cached)
  expect(f.trace).toEqual(['start:cjs:1'])
})

it('replaces a changed module that a data URL module imports', async () => {
  const f = await fixture()
  const url = pathToFileURL(join(f.dir, 'node_modules', 'shared-lib', 'index.mjs')).href
  await import(`data:text/javascript,import ${JSON.stringify(url)}`)
  f.trace.length = 0
  shared(f.dir, 2)
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toEqual(['stop:1', 'start:1:2:-'])
})

it('reads no plugin from a CommonJS module that is still loading', async () => {
  const f = await fixture()
  const require = createRequire(import.meta.url)
  const partial = join(f.dir, 'node_modules', 'addon', 'partial.cjs')
  file(partial, 'module.exports = {}\n')
  // A module whose evaluation has not finished is cached with `loaded: false`.
  require.cache[partial] = { exports: { apply() {} }, loaded: false } as NodeJS.Module
  onTestFinished(() => { Reflect.deleteProperty(require.cache, partial) })
  f.trace.length = 0
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toEqual([])
})

it('replaces a module first loaded during a recomposition whose file changed before it settled', async () => {
  const f = await fixture(['addon'], async (_home, dir) => {
    const root = join(dir, 'node_modules', 'other')
    file(join(root, 'dep.mjs'), 'export const value = 1\n')
    // The write lands well after the comparison; file clocks can date a write within one tick of it earlier.
    file(join(root, 'index.mjs'), `import { writeFileSync } from 'node:fs'
import { setTimeout } from 'node:timers/promises'
import { value } from './dep.mjs'
export async function apply(ctx) {
  ctx.get('reloadTrace').push('start:other:' + value)
  await setTimeout(50)
  writeFileSync(${JSON.stringify(join(root, 'dep.mjs'))}, 'export const value = 2\\n')
}
`)
  })
  f.trace.length = 0
  f.select(['addon', 'other'])
  await f.reconcile()
  expect(f.trace).toEqual(['start:other:1'])
  f.trace.length = 0
  await f.reconcile()
  expect(f.trace).toEqual(['start:other:2'])
})

it('replaces other changed plugins when one changed plugin cannot be replaced', async () => {
  const f = await fixture(['other'])
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })
  const url = pathToFileURL(join(f.dir, 'node_modules', 'addon', 'index.mjs')).href
  await f.ctx.plugin(f.ctx.loader.unwrapExports(await f.ctx.loader.import(url)) as Plugin)
  f.trace.length = 0
  addon(f.dir, '2')
  other(f.dir)
  file(join(f.dir, 'node_modules', 'other', 'index.mjs'), `export function apply(ctx) {
  ctx.get('reloadTrace').push('start:other:2')
}
`)
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [{ url, reason: 'unmanaged-plugin' }] })
  expect(f.trace).toEqual(['stop:other', 'start:other:2'])
})

it('starts a replaced entry outside the profile composition once and judges its activation', async () => {
  const f = await fixture([])
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })
  const id = await f.ctx.loader.create({ name: 'addon' })
  await f.ctx.loader.await()
  f.trace.length = 0
  addon(f.dir, '2')
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toEqual(['stop:1', 'start:2:1:-'])
  addon(f.dir, '3', "export function apply() { throw new Error('version 3 cannot start') }\n")
  await expect(f.reconcile()).rejects.toThrow('version 3 cannot start')
  expect(f.ctx.loader.resolve(id).fiber?.state).not.toBe(FiberState.ACTIVE)
})

it('reports a replaced entry whose package entry point now fails to import', async () => {
  const f = await fixture([])
  const error = vi.spyOn(f.ctx.logger, 'error').mockImplementation(() => {})
  onTestFinished(() => { error.mockRestore() })
  await f.ctx.loader.create({ name: 'addon' })
  await f.ctx.loader.await()
  const root = join(f.dir, 'node_modules', 'addon')
  addon(f.dir, '2')
  file(join(root, 'moved.mjs'), "import 'missing-lib'\n")
  file(join(root, 'package.json'), JSON.stringify({ name: 'addon', version: '2', type: 'module', exports: './moved.mjs' }))
  await expect(f.reconcile()).rejects.toThrow('did not activate')
})

it('does not start the new code of a plugin its new bundle patch disables', async () => {
  const f = await fixture()
  f.trace.length = 0
  addon(f.dir, '2', plugin('2'))
  file(join(f.dir, 'node_modules', 'addon', 'cordis.patch.yml'), '- insert:\n    - id: addon\n      name: addon\n      disabled: true\n')
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toEqual(['stop:1'])
})

it('replaces the importers of a changed shared dependency only', async () => {
  const f = await fixture()
  f.trace.length = 0
  shared(f.dir, 2)
  await f.reconcile()
  expect(f.trace).toEqual(['stop:1', 'start:1:2:-'])
})

it('replaces a plugin of a linked package whose target changed', async () => {
  const f = await fixture(['@local/linked'])
  expect(f.trace).toEqual(['start:linked:1'])
  linked(f.home, f.dir, 2)
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toEqual(['start:linked:1', 'stop:linked', 'start:linked:2'])
})

it('stops a plugin whose replacement fails to load and starts its corrected files', async () => {
  const f = await fixture()
  quiet(f.ctx)
  f.trace.length = 0
  addon(f.dir, '2', plugin('2', 'missing-lib'))
  await expect(f.reconcile()).rejects.toThrow(/failed to import: .*'missing-lib'/u)
  expect(f.trace).toEqual(['stop:1'])
  // An unchanged failure is reported without rejecting later recompositions.
  await expect(f.reconcile()).resolves.toEqual({ warnings: [expect.stringContaining("'missing-lib'")], pending: [] })
  addon(f.dir, '3')
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toEqual(['stop:1', 'start:3:1:-'])
})

it('loads a changed dependency together with the corrected plugin that failed to load', async () => {
  const f = await fixture()
  quiet(f.ctx)
  f.trace.length = 0
  shared(f.dir, 2)
  addon(f.dir, '2', plugin('2', 'missing-lib'))
  await expect(f.reconcile()).rejects.toThrow('missing-lib')
  addon(f.dir, '3')
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toEqual(['stop:1', 'start:3:2:-'])
})

it('loads a plugin whose missing dependency was installed after its replacement failed', async () => {
  const f = await fixture()
  quiet(f.ctx)
  f.trace.length = 0
  addon(f.dir, '2', plugin('2', 'late-lib'))
  await expect(f.reconcile()).rejects.toThrow('late-lib')
  file(join(f.dir, 'node_modules', 'late-lib', 'package.json'), JSON.stringify({ name: 'late-lib', type: 'module', exports: './index.mjs' }))
  file(join(f.dir, 'node_modules', 'late-lib', 'index.mjs'), 'export const value = 7\n')
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toEqual(['stop:1', 'start:2:7:-'])
})

it('loads a package reinstalled at the same path after removal', async () => {
  const f = await fixture()
  f.select(['other'])
  await f.reconcile()
  rmSync(join(f.dir, 'node_modules', 'addon'), { recursive: true })
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  addon(f.dir, '2')
  f.select(['addon', 'other'])
  f.trace.length = 0
  await f.reconcile()
  expect(f.trace).toEqual(['start:2:1:-'])
})

it('replaces a CommonJS plugin whose required file changed', async () => {
  const f = await fixture(['cjs-addon'])
  expect(f.trace).toEqual(['start:cjs:1'])
  commonjs(f.dir, 2)
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toEqual(['start:cjs:1', 'stop:cjs', 'start:cjs:2'])
})

it('stops a CommonJS plugin whose required file fails and applies its correction', async () => {
  const f = await fixture(['cjs-addon'])
  quiet(f.ctx)
  const helper = join(f.dir, 'node_modules', 'cjs-addon', 'helper.cjs')
  file(helper, "throw new Error('broken helper')\n")
  await expect(f.reconcile()).rejects.toThrow('broken helper')
  expect(f.trace).toEqual(['start:cjs:1', 'stop:cjs'])
  commonjs(f.dir, 3)
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toEqual(['start:cjs:1', 'stop:cjs', 'start:cjs:3'])
})

it('keeps a module first loaded after the last observation when its file predates it', async () => {
  const f = await fixture()
  const late = join(f.dir, 'node_modules', 'late', 'index.mjs')
  file(late, 'export const loaded = Symbol("late")\nexport function apply() {}\n')
  age(join(f.dir, 'node_modules', 'late'))
  const url = pathToFileURL(late).href
  const first = await f.ctx.loader.import(url) as { loaded: symbol }
  // A running plugin keeps its package loaded.
  await f.ctx.plugin(f.ctx.loader.unwrapExports(first) as Plugin)
  await f.reconcile()
  expect((await f.ctx.loader.import(url) as { loaded: symbol }).loaded).toBe(first.loaded)
})

it('compares module files on a file system without a native realpath, as a packed worker has', async () => {
  const f = await fixture()
  const native: unknown = Reflect.get(realpathSync, 'native')
  Reflect.deleteProperty(realpathSync, 'native')
  onTestFinished(() => { Reflect.set(realpathSync, 'native', native) })
  f.trace.length = 0
  addon(f.dir, '2')
  try {
    await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  } finally { Reflect.set(realpathSync, 'native', native) }
  expect(f.trace).toEqual(['stop:1', 'start:2:1:-'])
})

it('evicts a package a stopped plugin imported dynamically once the resolution drops its mapping', async () => {
  const f = await fixture()
  const lazy = join(f.dir, 'node_modules', 'lazy-dep')
  file(join(lazy, 'package.json'), JSON.stringify({ name: 'lazy-dep', type: 'module' }))
  file(join(lazy, 'index.mjs'), 'export const loaded = Symbol("lazy")\n')
  age(lazy)
  const url = pathToFileURL(join(realpathSync(lazy), 'index.mjs')).href
  const first = await f.ctx.loader.import(url) as { loaded: symbol }
  resolution(f.ctx, table('/packages/addon'), () => {}, table('/packages/addon', realpathSync(lazy)))
  await f.reconcile()
  expect((await f.ctx.loader.import(url) as { loaded: symbol }).loaded).not.toBe(first.loaded)
})

it('keeps the modules below a directory that stays mapped inside a dropped one', async () => {
  const f = await fixture()
  const outer = join(f.dir, 'node_modules', 'outer-lib')
  const inner = join(outer, 'node_modules', 'inner-lib')
  file(join(outer, 'package.json'), JSON.stringify({ name: 'outer-lib', type: 'module' }))
  file(join(outer, 'index.mjs'), 'export const loaded = Symbol("outer")\n')
  file(join(inner, 'package.json'), JSON.stringify({ name: 'inner-lib', type: 'module' }))
  file(join(inner, 'index.mjs'), 'export const loaded = Symbol("inner")\n')
  age(outer)
  const outerUrl = pathToFileURL(join(realpathSync(outer), 'index.mjs')).href
  const innerUrl = pathToFileURL(join(realpathSync(inner), 'index.mjs')).href
  const outerFirst = await f.ctx.loader.import(outerUrl) as { loaded: symbol }
  const innerFirst = await f.ctx.loader.import(innerUrl) as { loaded: symbol }
  resolution(f.ctx, table('/packages/addon', realpathSync(inner)), () => {}, table('/packages/addon', realpathSync(outer), realpathSync(inner)))
  await f.reconcile()
  expect((await f.ctx.loader.import(outerUrl) as { loaded: symbol }).loaded).not.toBe(outerFirst.loaded)
  expect((await f.ctx.loader.import(innerUrl) as { loaded: symbol }).loaded).toBe(innerFirst.loaded)
})

it('keeps the modules of a stopped plugin whose package stays mapped', async () => {
  const f = await fixture()
  const url = pathToFileURL(join(f.dir, 'node_modules', 'addon', 'index.mjs')).href
  const first: unknown = await f.ctx.loader.import(url)
  f.select(['other'])
  await f.reconcile()
  // Only the packages of dropped mappings are evicted; the deselected bundle's unchanged files stay loaded.
  expect(await f.ctx.loader.import(url)).toBe(first)
})

it('evaluates again a module first loaded after the last observation when its file was written since', async () => {
  const f = await fixture()
  const late = join(f.dir, 'node_modules', 'late', 'index.mjs')
  file(late, 'export const loaded = Symbol("late")\n')
  const url = pathToFileURL(late).href
  const first = await f.ctx.loader.import(url) as { loaded: symbol }
  await f.reconcile()
  expect((await f.ctx.loader.import(url) as { loaded: symbol }).loaded).not.toBe(first.loaded)
})

it('ignores modules whose loading failed while collecting importers', async () => {
  const f = await fixture()
  const broken = join(f.dir, 'node_modules', 'broken', 'index.mjs')
  file(broken, "import 'missing-lib'\n")
  await expect(f.ctx.loader.import(pathToFileURL(broken).href)).rejects.toThrow()
  f.trace.length = 0
  shared(f.dir, 2)
  await f.reconcile()
  expect(f.trace).toEqual(['stop:1', 'start:1:2:-'])
})

it('leaves changed modules of the host module graph for a restart', async () => {
  const argv = process.argv
  onTestFinished(() => { process.argv = argv })
  const f = await fixture(undefined, async (_home, dir) => {
    const main = join(dir, 'main.mjs')
    file(main, "import './node_modules/shared-lib/index.mjs'\n")
    process.argv = [argv[0]!, main]
    await ModuleLoader.fromInternal()!.import(pathToFileURL(main).href, import.meta.url, {})
  })
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })
  const url = pathToFileURL(join(f.dir, 'node_modules', 'shared-lib', 'index.mjs')).href
  f.trace.length = 0
  shared(f.dir, 2)
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [{ url, reason: 'host-module' }] })
  expect(f.trace).toEqual([])
})

it('still recomposes when planning the replacement fails', async () => {
  const f = await fixture()
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })
  Reflect.set(f.ctx.hmr, 'hostModules', () => Promise.reject(new Error('graph unavailable')))
  f.trace.length = 0
  shared(f.dir, 2)
  f.select(['addon'])
  const url = pathToFileURL(join(f.dir, 'node_modules', 'shared-lib', 'index.mjs')).href
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [{ url, reason: 'module-comparison' }] })
  expect(f.trace).toEqual(['stop:other'])
  expect(warn).toHaveBeenCalledWith(expect.objectContaining({ message: 'graph unavailable' }))
})

it('replaces running plugins before reporting a recomposition failure', async () => {
  const f = await fixture()
  f.trace.length = 0
  shared(f.dir, 2)
  writeFileSync(join(f.dir, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'timer', name: 'cordis:timer' },
    { id: 'hmr', name: 'cordis:hmr', config: { root: [] } },
    { id: 'broken', name: './missing.mjs' },
  ] }]))
  const error = vi.spyOn(f.ctx.logger, 'error').mockImplementation(() => {})
  onTestFinished(() => { error.mockRestore() })
  await expect(f.ctx.hmr.runExclusive(() => f.ctx.hmr.reconcileProfile(['broken']))).rejects.toThrow('broken')
  expect(f.trace).toEqual(['stop:1', 'start:1:2:-'])
})

it('reconciles only inside an HMR transaction of a profile application', async () => {
  const f = await fixture()
  await expect(f.ctx.hmr.reconcileProfile()).rejects.toThrow('must run inside runExclusive')
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(f.dir + '/').href
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  await ctx.plugin(Timer)
  await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
  await expect(ctx.hmr.runExclusive(() => ctx.hmr.reconcileProfile())).rejects.toThrow('requires profileContext')
})

it('replaces changed modules when the process has no entry module', async () => {
  const argv = process.argv
  process.argv = []
  onTestFinished(() => { process.argv = argv })
  const f = await fixture()
  f.trace.length = 0
  shared(f.dir, 2)
  await f.reconcile()
  expect(f.trace).toEqual(['stop:1', 'start:1:2:-'])
})

it('retries a failed replacement of a plugin loaded after the last observation', async () => {
  const f = await fixture([])
  quiet(f.ctx)
  await f.ctx.loader.create({ name: 'addon' })
  await f.ctx.loader.await()
  addon(f.dir, '2', plugin('2', 'missing-lib'))
  await expect(f.reconcile()).rejects.toThrow('missing-lib')
  addon(f.dir, '3')
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toEqual(['start:1:1:-', 'stop:1', 'start:3:1:-'])
})

it('logs the changed modules its own profile watch leaves', async () => {
  const argv = process.argv
  onTestFinished(() => { process.argv = argv })
  const f = await fixture(undefined, async (_home, dir) => {
    const main = join(dir, 'main.mjs')
    file(main, "import './node_modules/shared-lib/index.mjs'\n")
    process.argv = [argv[0]!, main]
    await ModuleLoader.fromInternal()!.import(pathToFileURL(main).href, import.meta.url, {})
  })
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })
  shared(f.dir, 2)
  await f.editPatch()
  const url = pathToFileURL(join(f.dir, 'node_modules', 'shared-lib', 'index.mjs')).href
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('keep running their previous code'), [{ url, reason: 'host-module' }])
})

it('reports a required restart when the profile packages cannot be listed', async () => {
  const f = await fixture(undefined, async (_home, dir) => {
    // A scope entry that is a file makes listing its packages fail.
    file(join(dir, 'node_modules', '@broken'), '')
  })
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })
  f.trace.length = 0
  f.select(['addon'])
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [], restartReason: 'module-comparison' })
  expect(f.trace).toEqual(['stop:other'])
  expect(warn).toHaveBeenCalledWith(expect.objectContaining({ code: 'ENOTDIR' }))
})

it('compares only CommonJS modules when module hooks keep the ES module cache on another thread', async () => {
  const f = await fixture(['cjs-addon'])
  const internal = ModuleLoader.fromInternal()!
  const cache: unknown = Reflect.get(internal, 'loadCache')
  Reflect.set(internal, 'loadCache', undefined)
  onTestFinished(() => { Reflect.set(internal, 'loadCache', cache) })
  const warn = vi.spyOn(f.ctx.logger, 'warn')
  onTestFinished(() => { warn.mockRestore() })
  commonjs(f.dir, 2)
  await expect(f.reconcile()).resolves.toMatchObject({ warnings: [] })
  expect(warn).not.toHaveBeenCalled()
})

it('reads no module links and ignores source changes with a worker-style loader', async () => {
  const f = await fixture()
  const internal = ModuleLoader.fromInternal()!
  const cache: unknown = Reflect.get(internal, 'loadCache')
  Reflect.set(internal, 'loadCache', undefined)
  onTestFinished(() => { Reflect.set(internal, 'loadCache', cache) })
  const warn = vi.spyOn(f.ctx.logger, 'warn')
  onTestFinished(() => { warn.mockRestore() })
  const changes: string[] = []
  f.ctx.on('hmr/change', (url) => { changes.push(url) })
  const source = join(f.dir, 'node_modules', 'addon', 'index.mjs')
  await expect(f.ctx.hmr.getLinked(pathToFileURL(source).href)).resolves.toEqual([])
  for (const watcher of watchers.slice(-1)) watcher.emit('change', source)
  await vi.waitFor(() => { expect(changes).toEqual([pathToFileURL(source).href]) })
  expect(warn).not.toHaveBeenCalled()
})

it('requests a restart for module replacement without Node-compatible caches', async () => {
  const f = await fixture()
  const internal = ModuleLoader.fromInternal()!
  const esm: unknown = Reflect.get(internal, 'loadCache')
  const commonjs: unknown = Reflect.get(NodeModule, '_cache')
  Reflect.set(internal, 'loadCache', undefined)
  Reflect.set(NodeModule, '_cache', undefined)
  onTestFinished(() => { Reflect.set(internal, 'loadCache', esm); Reflect.set(NodeModule, '_cache', commonjs) })
  const warn = vi.spyOn(f.ctx.logger, 'warn')
  onTestFinished(() => { warn.mockRestore() })
  f.trace.length = 0
  // Patches remain identical: native imports cannot run while these cache fields are hidden.
  shared(f.dir, 2)
  const result = await f.reconcile()
  Reflect.set(internal, 'loadCache', esm)
  Reflect.set(NodeModule, '_cache', commonjs)
  expect(result).toEqual({ warnings: [], pending: [], restartReason: 'module-comparison' })
  expect(f.trace).toEqual([])
  expect(warn).not.toHaveBeenCalled()
})

it('removes a plugin whose replacement fails to load without reporting the failure', async () => {
  const f = await fixture()
  addon(f.dir, '2', plugin('2', 'missing-lib'))
  f.select(['other'])
  f.trace.length = 0
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toEqual(['stop:1'])
})

it('replaces changed plugins beside CommonJS cache entries that are not Node modules', async () => {
  const f = await fixture()
  const require = createRequire(import.meta.url)
  const planted = join(f.dir, 'planted.cjs')
  // Some libraries store plain objects in require.cache to provide a module without loading it.
  require.cache[planted] = { exports: {} } as NodeJS.Module
  onTestFinished(() => { Reflect.deleteProperty(require.cache, planted) })
  f.trace.length = 0
  addon(f.dir, '2')
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toEqual(['stop:1', 'start:2:1:-'])
})

it('imports the corrected files of an entry whose import failed', async () => {
  const f = await fixture()
  addon(f.dir, '2', plugin('2', 'missing-lib'))
  f.select(['other'])
  await f.reconcile()
  // Selected again, the entry imports the broken files and has no fiber.
  // The Loader logs the entry's import failure.
  const error = vi.spyOn(f.ctx.logger, 'error').mockImplementation(() => {})
  onTestFinished(() => { error.mockRestore() })
  f.select(['addon', 'other'])
  await expect(f.reconcile()).rejects.toThrow(/failed to import: .*missing-lib/u)
  f.trace.length = 0
  addon(f.dir, '3')
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toEqual(['start:3:1:-'])
})

it('leaves a disabled entry whose import failed until it is enabled', async () => {
  const f = await fixture()
  addon(f.dir, '2', plugin('2', 'missing-lib'))
  f.select(['other'])
  await f.reconcile()
  // The Loader logs the entry's import failure.
  const error = vi.spyOn(f.ctx.logger, 'error').mockImplementation(() => {})
  onTestFinished(() => { error.mockRestore() })
  f.select(['addon', 'other'])
  await expect(f.reconcile()).rejects.toThrow('failed to import')
  const rows = [{ id: 'timer', name: 'cordis:timer' }, { id: 'hmr', name: 'cordis:hmr', config: { root: [] } }]
  writeFileSync(f.profile.patchPath, JSON.stringify([{ insert: rows }, { id: 'addon', disabled: true }]))
  await f.reconcile()
  f.trace.length = 0
  addon(f.dir, '3')
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toEqual([])
  writeFileSync(f.profile.patchPath, JSON.stringify([{ insert: rows }]))
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toEqual(['start:3:1:-'])
})


/** Install a plugin package that records its start. */
function late(dir: string): void {
  const root = join(dir, 'node_modules', 'late-plugin')
  file(join(root, 'package.json'), JSON.stringify({ name: 'late-plugin', type: 'module', exports: './index.mjs' }))
  file(join(root, 'index.mjs'), "export function apply(ctx) { ctx.get('reloadTrace').push('start:late') }\n")
}

it('retries a failed import while the profile packages cannot be listed', async () => {
  const f = await fixture([])
  quiet(f.ctx)
  await f.ctx.loader.create({ name: 'late-plugin' })
  await f.ctx.loader.await()
  // A scope entry that is a file makes listing its packages fail.
  file(join(f.dir, 'node_modules', '@broken'), '')
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })
  late(f.dir)
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [], restartReason: 'module-comparison' })
  expect(f.trace).toEqual(['start:late'])
})

it('starts an entry whose missing dependency was installed after startup', async () => {
  const f = await fixture([], async (_home, dir) => {
    file(join(dir, 'node_modules', 'needs-late', 'package.json'), JSON.stringify({ name: 'needs-late', type: 'module', exports: './index.mjs' }))
    file(join(dir, 'node_modules', 'needs-late', 'index.mjs'), "export { apply } from 'late-plugin'\n")
  })
  quiet(f.ctx)
  await f.ctx.loader.create({ name: 'needs-late' })
  await f.ctx.loader.await()
  await f.reconcile()
  late(f.dir)
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toEqual(['start:late'])
})

it('imports a failing replacement with a new configuration once', async () => {
  const f = await fixture()
  const error = vi.spyOn(f.ctx.logger, 'error').mockImplementation(() => {})
  onTestFinished(() => { error.mockRestore() })
  addon(f.dir, '2', plugin('2', 'missing-lib'), 'fast')
  await expect(f.reconcile()).rejects.toThrow('missing-lib')
  expect(error.mock.calls.filter(([value]) => String(value).includes('missing-lib'))).toHaveLength(1)
})

it('reports an entry whose import failed and whose disabling expression throws', async () => {
  const f = await fixture([])
  quiet(f.ctx)
  const id = await f.ctx.loader.create({ name: 'late-plugin' })
  await f.ctx.loader.await()
  Reflect.set(f.ctx.loader.resolve(id).options, 'disabled', { __jsExpr: 'undefined.x' })
  // Recomposition still applies and judges; the unchanged expression failure is reported.
  await expect(f.reconcile()).resolves.toEqual({ warnings: [expect.stringContaining('disabled expression failed')], pending: [] })
})

it('leaves a changed plugin that an unchanged plugin registered dynamically for a restart', async () => {
  const f = await fixture(['other'], async (_home, dir) => {
    const root = join(dir, 'node_modules', 'other')
    file(join(root, 'child.mjs'), "export function apply(ctx) { ctx.get('reloadTrace').push('start:child:1') }\n")
    file(join(root, 'index.mjs'), "const child = await import('./child.mjs')\nexport function apply(ctx) { ctx.plugin(child) }\n")
  })
  f.trace.length = 0
  const child = join(f.dir, 'node_modules', 'other', 'child.mjs')
  file(child, "export function apply(ctx) { ctx.get('reloadTrace').push('start:child:2') }\n")
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [{ url: pathToFileURL(child).href, reason: 'unmanaged-plugin' }] })
  expect(f.trace).toEqual([])
})

it('recovers from an initial listing failure without replacing unchanged old files', async () => {
  const f = await fixture(undefined, async (_home, dir) => { file(join(dir, 'node_modules', '@broken'), '') })
  unlinkSync(join(f.dir, 'node_modules', '@broken'))
  f.trace.length = 0
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toEqual([])
})

it('records freshly mounted plugin files so installing the next bundle does not restart them', async () => {
  const f = await fixture([])
  addon(f.dir, '2')
  f.select(['addon'])
  await f.reconcile()
  f.trace.length = 0
  other(f.dir)
  f.select(['addon', 'other'])
  await f.reconcile()
  expect(f.trace).toEqual(['start:other'])
})

it('walks Node 22 null-prototype linked arrays', async () => {
  const f = await fixture()
  const internal = ModuleLoader.fromInternal()!
  const url = pathToFileURL(join(f.dir, 'node_modules', 'addon', 'index.mjs')).href
  const job = internal.loadCache.get(url)!
  const linked = job.linked
  const children = Array.from(await linked)
  Object.setPrototypeOf(children, null)
  Reflect.set(job, 'linked', Promise.resolve(children))
  onTestFinished(() => { Reflect.set(job, 'linked', linked) })
  shared(f.dir, 2)
  f.trace.length = 0
  await f.reconcile()
  expect(f.trace).toEqual(['stop:1', 'start:1:2:-'])
})

it('keeps CommonJS plugins and their caches pending when no ES module jobs are available', async () => {
  const f = await fixture(['cjs-addon'])
  const internal = ModuleLoader.fromInternal()!
  const esm: unknown = Reflect.get(internal, 'loadCache')
  const require = createRequire(import.meta.url)
  const helper = join(f.dir, 'node_modules', 'cjs-addon', 'helper.cjs')
  const cached = require.cache[helper]
  file(helper, 'exports.value = 2\n')
  Reflect.set(internal, 'loadCache', undefined)
  onTestFinished(() => { Reflect.set(internal, 'loadCache', esm) })
  try {
    const expected = { warnings: [], restartReason: 'module-comparison',
      pending: [{ url: pathToFileURL(helper).href, reason: 'module-comparison' }] }
    await expect(f.reconcile()).resolves.toEqual(expected)
    await expect(f.reconcile()).resolves.toEqual(expected)
    expect(require.cache[helper]).toBe(cached)
    expect(f.trace).toEqual(['start:cjs:1'])
  } finally { Reflect.set(internal, 'loadCache', esm) }
})

it.each(['disabled', 'removed', 'incompatible', 'dynamic'] as const)('never evaluates the replacement of a %s row', async (kind) => {
  const f = await fixture()
  const marker = join(f.home, 'evaluated')
  addon(f.dir, '2', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'yes');\n` + plugin('2'))
  if (kind === 'incompatible') {
    const path = join(f.dir, 'node_modules', 'addon', 'package.json')
    file(path, JSON.stringify({ name: 'addon', version: '2.0.0', type: 'module', exports: './index.mjs',
      peerDependencies: { '@deepseek-ai/dsh': '<0.0.0' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  } else if (kind === 'removed') {
    f.select(['other'])
  } else {
    file(join(f.dir, 'node_modules', 'addon', 'cordis.patch.yml'),
      `- insert:\n    - id: addon\n      name: addon\n      disabled: ${kind === 'dynamic' ? '!!js "true"' : 'true'}\n`)
  }
  f.trace.length = 0
  await f.reconcile()
  expect(existsSync(marker)).toBe(false)
  expect(f.trace).toEqual(['stop:1'])
  addon(f.dir, '3')
  f.select(['addon', 'other'])
  await f.reconcile()
  expect(f.trace).toContain('start:3:1:-')
})

it('restarts both CommonJS requirers of a changed shared child', async () => {
  const f = await fixture(['cjs-addon'], async (_home, dir) => {
    const root = join(dir, 'node_modules', 'other')
    file(join(root, 'package.json'), JSON.stringify({ name: 'other', version: '1.0.0', main: './index.cjs',
      dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    file(join(root, 'index.cjs'), `const helper = require('../cjs-addon/helper.cjs')
exports.apply = ctx => {
  ctx.get('reloadTrace').push('start:second:' + helper.value)
  ctx.effect(() => () => ctx.get('reloadTrace').push('stop:second'))
}
`)
  })
  f.select(['cjs-addon', 'other'])
  await f.reconcile()
  f.trace.length = 0
  file(join(f.dir, 'node_modules', 'cjs-addon', 'helper.cjs'), 'exports.value = 2\n')
  await f.reconcile()
  expect(f.trace.toSorted()).toEqual(['start:cjs:2', 'start:second:2', 'stop:cjs', 'stop:second'])
})


it('replaces a row whose disabling is an expression', async () => {
  const f = await fixture(undefined, async (_home, dir) => {
    file(join(dir, 'node_modules', 'addon', 'cordis.patch.yml'),
      '- insert:\n    - id: addon\n      name: addon\n      disabled: !!js "false"\n')
  })
  f.trace.length = 0
  shared(f.dir, 2)
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toEqual(['stop:1', 'start:1:2:-'])
})

it('logs a profile-wide restart requirement from its watch when caches are unavailable', async () => {
  const f = await fixture()
  const internal = ModuleLoader.fromInternal()!
  const esm: unknown = Reflect.get(internal, 'loadCache')
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore(); Reflect.set(internal, 'loadCache', esm) })
  Reflect.set(internal, 'loadCache', undefined)
  try {
    await f.editPatch()
    expect(warn).toHaveBeenCalledWith('restart required: %s', 'module-comparison')
  } finally { Reflect.set(internal, 'loadCache', esm) }
})


it.each(['group', 'include'] as const)('replaces the children of a nested %s', async (kind) => {
  const f = await fixture(['addon'], async (_home, dir) => {
    const config = join(dir, 'nested.yml')
    file(config, '- id: child\n  name: addon\n')
    file(join(dir, 'node_modules', 'addon', 'cordis.patch.yml'), JSON.stringify([{ insert: [kind === 'group'
      ? { id: 'nested', name: 'cordis:group', config: [{ id: 'child', name: 'addon' }] }
      : { id: 'nested', name: 'cordis:include', config: { path: pathToFileURL(config).href } }] }]))
  })
  f.trace.length = 0
  addon(f.dir, '2')
  await expect(f.reconcile()).resolves.toEqual({ warnings: [], pending: [] })
  expect(f.trace).toEqual(['stop:1', 'start:2:1:-'])
})
