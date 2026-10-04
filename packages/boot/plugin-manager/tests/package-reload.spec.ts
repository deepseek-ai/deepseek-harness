/** GUI package operations publish profile package resolution around activation and disposal through the real Loader. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import {
  boot, createRuntimeResolution, initProfile, loadProfileDirectory, PluginPackages,
  readProfileManifest, readProfilePatches, type ProfileContext,
} from '@deepseek-ai/dsh-app-boot'
import Hmr from '@deepseek-ai/dsh-hmr'
import type { ChokidarOptions } from 'chokidar'
import { expect, it, onTestFinished, vi } from 'vitest'
import PluginManager, { type PluginInstallRequestId } from '../src/index.ts'
import * as operations from '../src/operations.ts'

// Changes in these cases come only from GUI operations, never from file notifications.
vi.mock('chokidar', async (original) => {
  const actual = await original<typeof import('chokidar')>()
  return { ...actual, watch: (_paths: string | string[], options: ChokidarOptions = {}) => {
    const watcher = new actual.FSWatcher(options)
    queueMicrotask(() => watcher.emit('ready'))
    return watcher
  } }
})

/** Write the `addon` bundle, whose plugin is its private bare dependency `addon-plugin`. */
function writeBundle(dir: string, version: number): void {
  const bundleDir = join(dir, 'node_modules', 'addon')
  const pluginDir = join(bundleDir, 'node_modules', 'addon-plugin')
  rmSync(bundleDir, { recursive: true, force: true })
  mkdirSync(pluginDir, { recursive: true })
  writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
    name: 'addon', version: `${version}.0.0`, type: 'module',
    dependencies: { 'addon-plugin': `${version}.0.0` }, dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(bundleDir, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'addon', name: 'addon-plugin' }] }]))
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({
    name: 'addon-plugin', version: `${version}.0.0`, type: 'module', exports: './plugin.mjs',
  }))
  writeFileSync(join(pluginDir, 'plugin.mjs'), `
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(join(dir, 'addon-evaluations.log'))}, ${JSON.stringify(`addon:${version}\n`)});
export function apply(ctx) {
  ctx.get('packageReloadTrace').push('start:addon:${version}');
  ctx.provide('addonVersion', ${version});
  ctx.effect(() => () => { ctx.get('packageReloadTrace').push('stop:addon:${version}'); });
}
`)
}

/** Write `addon` and save it as a profile dependency, as `pnpm add` does. */
function installFiles(dir: string, version: number): void {
  writeBundle(dir, version)
  const manifest = readProfileManifest('test', dir)
  manifest.dependencies = { ...manifest.dependencies, addon: `${version}.0.0` }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
}

/** Delete `addon` and drop it from the profile dependencies, as `pnpm remove` does. */
function removeFiles(dir: string): void {
  const manifest = readProfileManifest('test', dir)
  delete manifest.dependencies?.addon
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  rmSync(join(dir, 'node_modules', 'addon'), { recursive: true })
}

function installOtherBundle(dir: string, shared = false): void {
  const bundleDir = join(dir, 'node_modules', 'other')
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
    name: 'other', version: '1.0.0', dependencies: shared ? { 'addon-plugin': '1.0.0' } : {},
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(bundleDir, 'cordis.patch.yml'), '[]\n')
  const manifest = readProfileManifest('test', dir)
  manifest.dependencies = { ...manifest.dependencies, other: '1.0.0' }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
}

async function fixture(options: { live?: boolean; installed?: boolean; enabled?: boolean; shared?: boolean } = {}) {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), 'manager-package-reload-')))
  let owner: Context | undefined
  onTestFinished(async () => {
    await owner?.fiber.dispose()
    rmSync(home, { recursive: true, force: true })
  })
  const dir = join(home, 'profiles', 'test')
  const installAnchor = join(home, 'package.json')
  writeFileSync(installAnchor, '{"name":"installation","dependencies":{}}\n')
  initProfile(dir, options.installed === true && options.enabled !== false ? ['core', 'addon'] : ['core'])
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const core = join(dir, 'node_modules', 'core')
  mkdirSync(core, { recursive: true })
  writeFileSync(join(core, 'package.json'), JSON.stringify({
    name: 'core', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(core, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'manager', name: 'cordis:manager' },
    { id: 'sibling', name: './sibling.mjs' },
  ] }]))
  writeFileSync(join(core, 'sibling.mjs'), `
export function apply(ctx) {
  ctx.get('packageReloadTrace').push('start:sibling');
  ctx.provide('packageReloadSibling', {});
  ctx.effect(() => () => { ctx.get('packageReloadTrace').push('stop:sibling'); });
}
`)
  const manifest = readProfileManifest('test', dir)
  manifest.dependencies = {}
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  if (options.installed === true) installFiles(dir, 1)
  if (options.shared === true) {
    renameSync(join(dir, 'node_modules', 'addon', 'node_modules', 'addon-plugin'), join(dir, 'node_modules', 'addon-plugin'))
    installOtherBundle(dir, true)
    const shared = readProfileManifest('test', dir)
    shared.dsh = { profile: { bundles: ['core', 'addon', 'other'] } }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(shared))
  }
  const loaded = loadProfileDirectory('test', dir, installAnchor)
  const profile: ProfileContext = {
    name: 'test', dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor, cwd: home, home,
    startedBundles: loaded.layers.map(layer => layer.packageName), overlays: [], telemetryDisabledEnv: undefined,
  }
  const resolution = await createRuntimeResolution({ installAnchor, profile: loaded, home })
  const trace: string[] = []
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), async (host) => {
    owner = host
    host.provide('profileContext', profile)
    host.provide('appReady', { onReady(listener) { listener(); return () => {} } })
    host.provide('packageReloadTrace', trace)
    host.loader.builtins.manager = PluginManager
    await host.plugin(PluginPackages, { resolution })
  })
  if (options.live !== false) {
    await ctx.plugin(Timer)
    await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    await ctx.hmr.runExclusive(async () => {})
  }
  const registry = vi.spyOn(operations, 'readProfileRegistry').mockResolvedValue('https://registry.npmjs.org/')
  onTestFinished(() => { registry.mockRestore() })
  // Publications share the plugins' trace, so their order relative to plugin starts and stops is observable.
  const replace = ctx.pluginPackages.replace.bind(ctx.pluginPackages)
  const published = vi.spyOn(ctx.pluginPackages, 'replace').mockImplementation((successor) => {
    trace.push('publish')
    replace(successor)
  })
  onTestFinished(() => { published.mockRestore() })
  const bundleDir = join(dir, 'node_modules', 'addon')
  return {
    ctx, dir, trace, published, manager: ctx.pluginManager,
    parentURL: pathToFileURL(join(dir, 'caller.cjs')).href,
    bundleURL: pathToFileURL(join(bundleDir, 'package.json')).href,
    bundleDir,
    evaluationPath: join(dir, 'addon-evaluations.log'),
    entry: () => [...ctx.loader.entries()].find(row => row.id === 'include:addon'),
  }
}

/** Answer each pnpm run by recording it in the trace and applying `run` to the profile files. */
function mockPnpm(dir: string, trace: string[], run: (args: readonly string[]) => void, exitCode = 0) {
  const pnpm = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async (_context, args) => {
    trace.push(`pnpm:${String(args[0])}`)
    run(args)
    return {
      exitCode, output: exitCode === 0 ? 'completed' : 'fixture install failed', truncated: false, logPath: join(dir, 'pnpm.log'),
    }
  })
  onTestFinished(() => { pnpm.mockRestore() })
  return pnpm
}

it('publishes a newly installed enabled bundle before its private bare plugin starts', async () => {
  const { ctx, dir, trace, published, manager, parentURL, evaluationPath, entry } = await fixture()
  expect(ctx.pluginPackages.packageOf('addon', parentURL)).toBeUndefined()
  mockPnpm(dir, trace, (args) => {
    expect(args.slice(0, 2)).toEqual(['add', 'addon'])
    installFiles(dir, 1)
  })

  expect(await manager.installBundle('addon', { enabled: true })).toMatchObject({ application: 'applied', changed: true })
  expect(published).toHaveBeenCalledOnce()
  expect(trace).toEqual(['start:sibling', 'pnpm:add', 'publish', 'start:addon:1'])
  expect(entry()?.fiber?.state).toBe(FiberState.ACTIVE)
  expect(ctx.get('addonVersion')).toBe(1)
  expect(ctx.pluginPackages.packageOf('addon-plugin', parentURL)?.version).toBe('1.0.0')
  expect(readFileSync(evaluationPath, 'utf8')).toBe('addon:1\n')
})

it('publishes a newly installed disabled bundle without evaluating its plugin', async () => {
  const { ctx, dir, trace, published, manager, parentURL, bundleURL, evaluationPath, entry } = await fixture()
  mockPnpm(dir, trace, () => { installFiles(dir, 1) })

  expect(await manager.installBundle('addon', { enabled: false })).toMatchObject({ application: 'applied', changed: true })
  expect(published).toHaveBeenCalledOnce()
  expect(trace).toEqual(['start:sibling', 'pnpm:add', 'publish'])
  expect(entry()).toBeUndefined()
  expect(existsSync(evaluationPath)).toBe(false)
  expect(ctx.pluginPackages.packageOf('addon', parentURL)?.version).toBe('1.0.0')
  expect(ctx.pluginPackages.packageOf('addon-plugin', bundleURL)?.version).toBe('1.0.0')
})

it('publishes an enabled bundle before its plugin starts', async () => {
  const { ctx, dir, trace, published, manager, parentURL, evaluationPath, entry } = await fixture()
  mockPnpm(dir, trace, () => { installFiles(dir, 1) })
  expect(await manager.installBundle('addon', { enabled: false })).toMatchObject({ application: 'applied' })
  published.mockClear()
  trace.length = 0

  expect(await manager.setBundleEnabled('addon', true)).toMatchObject({ application: 'applied', changed: true })
  expect(published).toHaveBeenCalledOnce()
  expect(trace).toEqual(['publish', 'start:addon:1'])
  expect(entry()?.fiber?.state).toBe(FiberState.ACTIVE)
  expect(ctx.get('addonVersion')).toBe(1)
  expect(ctx.pluginPackages.packageOf('addon-plugin', parentURL)?.version).toBe('1.0.0')
  expect(readFileSync(evaluationPath, 'utf8')).toBe('addon:1\n')
})

it('publishes a disabled bundle only after its plugin stops', async () => {
  const { ctx, trace, published, manager, parentURL, entry } = await fixture({ installed: true })
  expect(entry()?.fiber?.state).toBe(FiberState.ACTIVE)
  expect(ctx.pluginPackages.packageOf('addon-plugin', parentURL)?.version).toBe('1.0.0')
  const sibling: unknown = ctx.get('packageReloadSibling')

  expect(await manager.setBundleEnabled('addon', false)).toMatchObject({ application: 'applied', changed: true })
  expect(published).toHaveBeenCalledOnce()
  expect(trace).toEqual(['start:sibling', 'start:addon:1', 'stop:addon:1', 'publish'])
  expect(entry()).toBeUndefined()
  expect(ctx.get('addonVersion')).toBeUndefined()
  expect(ctx.pluginPackages.packageOf('addon-plugin', parentURL)).toBeUndefined()
  expect(ctx.pluginPackages.packageOf('addon', parentURL)?.version).toBe('1.0.0')
  expect(ctx.get('packageReloadSibling')).toBe(sibling)
})

it('keeps the running plugin and its private package lookup when a bundle is disabled without HMR', async () => {
  const { ctx, trace, published, manager, parentURL, entry } = await fixture({ live: false, installed: true })
  const previous = entry()?.fiber
  expect(previous?.state).toBe(FiberState.ACTIVE)

  expect(await manager.setBundleEnabled('addon', false)).toMatchObject({ application: 'restart-required', changed: true })
  expect(published).not.toHaveBeenCalled()
  expect(entry()?.fiber).toBe(previous)
  expect(previous?.state).toBe(FiberState.ACTIVE)
  expect(ctx.get('addonVersion')).toBe(1)
  expect(ctx.pluginPackages.packageOf('addon-plugin', parentURL)?.version).toBe('1.0.0')
  expect(trace).toEqual(['start:sibling', 'start:addon:1'])
})

it('keeps the running bundle resolution through later package operations without HMR', async () => {
  const { ctx, dir, trace, published, manager, parentURL, entry } = await fixture({ live: false, installed: true })
  const previous = entry()?.fiber
  const mapping = ctx.pluginPackages.packageOf('addon-plugin', parentURL)
  expect(previous?.state).toBe(FiberState.ACTIVE)
  expect(mapping?.version).toBe('1.0.0')
  mockPnpm(dir, trace, (args) => {
    if (args[0] === 'add') {
      installOtherBundle(dir)
    } else {
      expect(args).toEqual(['remove', 'other'])
      const manifest = readProfileManifest('test', dir)
      delete manifest.dependencies?.other
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
      rmSync(join(dir, 'node_modules', 'other'), { recursive: true })
    }
  })
  const expectRunningBundle = () => {
    expect(ctx.pluginPackages.packageOf('addon-plugin', parentURL)).toBe(mapping)
    expect(entry()?.fiber).toBe(previous)
    expect(previous?.state).toBe(FiberState.ACTIVE)
    expect(ctx.get('addonVersion')).toBe(1)
    expect(published).not.toHaveBeenCalled()
  }

  expect(await manager.setBundleEnabled('addon', false)).toMatchObject({ application: 'restart-required', changed: true })
  expectRunningBundle()
  expect(await manager.installBundle('other', { enabled: false })).toMatchObject({ application: 'restart-required', changed: true })
  expectRunningBundle()
  expect(await manager.setBundleEnabled('other', true)).toMatchObject({ application: 'restart-required', changed: true })
  expectRunningBundle()
  expect(await manager.removeBundle('other')).toMatchObject({ application: 'restart-required', changed: true })
  expectRunningBundle()
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['core'])
  expect(readProfileManifest('test', dir).dependencies).toEqual({ addon: '1.0.0' })
  expect(existsSync(join(dir, 'node_modules', 'other'))).toBe(false)
  expect(trace).toEqual(['start:sibling', 'start:addon:1', 'pnpm:add', 'pnpm:remove'])
})

it.each(['disable', 'remove'] as const)('retains a shared dependency after %s of its first declaring bundle', async (operation) => {
  const { ctx, dir, trace, published, manager, parentURL, entry } = await fixture({ installed: true, shared: true })
  const sharedDir = join(dir, 'node_modules', 'addon-plugin')
  expect(ctx.pluginPackages.packageOf('addon-plugin', parentURL)?.dir).toBe(sharedDir)
  mockPnpm(dir, trace, () => { removeFiles(dir) })

  const result = operation === 'disable' ? await manager.setBundleEnabled('addon', false) : await manager.removeBundle('addon')

  expect(result).toMatchObject({ application: 'applied', changed: true })
  expect(published).toHaveBeenCalledOnce()
  expect(published.mock.calls[0]?.[0].entries.find(item => item.name === 'addon-plugin')).toMatchObject({
    packageDir: sharedDir, version: '1.0.0', scope: 'profile', declarer: join(dir, 'node_modules', 'other', 'package.json'),
  })
  expect(entry()).toBeUndefined()
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['core', 'other'])
  expect(ctx.pluginPackages.packageOf('addon-plugin', parentURL)?.dir).toBe(sharedDir)
  expect(createRequire(join(dir, 'node_modules', 'other', 'package.json')).resolve('addon-plugin')).toBe(join(sharedDir, 'plugin.mjs'))
})

it('removes a running bundle after its plugin stops and then publishes', async () => {
  const { ctx, dir, trace, published, manager, parentURL, bundleURL, bundleDir, entry } = await fixture({ installed: true })
  const previous = entry()?.fiber
  expect(previous?.state).toBe(FiberState.ACTIVE)
  const sibling: unknown = ctx.get('packageReloadSibling')
  const pnpm = mockPnpm(dir, trace, (args) => {
    expect(args).toEqual(['remove', 'addon'])
    expect(entry()).toBeUndefined()
    removeFiles(dir)
  })

  expect(await manager.removeBundle('addon')).toMatchObject({
    application: 'applied', changed: true, packageResult: { exitCode: 0 },
  })
  expect(pnpm).toHaveBeenCalledOnce()
  expect(published).toHaveBeenCalledOnce()
  expect(trace).toEqual(['start:sibling', 'start:addon:1', 'stop:addon:1', 'pnpm:remove', 'publish'])
  expect(previous?.uid).toBeNull()
  expect(existsSync(bundleDir)).toBe(false)
  expect(ctx.pluginPackages.packageOf('addon', parentURL)).toBeUndefined()
  expect(ctx.pluginPackages.packageOf('addon-plugin', parentURL)).toBeUndefined()
  expect(ctx.pluginPackages.packageOf('addon-plugin', bundleURL)).toBeUndefined()
  expect(ctx.get('packageReloadSibling')).toBe(sibling)
  expect((await manager.listBundles()).some(bundle => bundle.name === 'addon')).toBe(false)
})

it('removes and publishes a bundle that is not running without HMR', async () => {
  const { ctx, dir, trace, published, manager, parentURL, bundleDir, evaluationPath } = await fixture({
    live: false, installed: true, enabled: false,
  })
  expect(ctx.pluginPackages.packageOf('addon', parentURL)?.version).toBe('1.0.0')
  const sibling: unknown = ctx.get('packageReloadSibling')
  const pnpm = mockPnpm(dir, trace, (args) => {
    expect(args).toEqual(['remove', 'addon'])
    removeFiles(dir)
  })

  expect(await manager.removeBundle('addon')).toMatchObject({
    application: 'restart-required', changed: true, packageResult: { exitCode: 0 },
  })
  expect(pnpm).toHaveBeenCalledOnce()
  expect(published).toHaveBeenCalledOnce()
  expect(trace).toEqual(['start:sibling', 'pnpm:remove', 'publish'])
  expect(existsSync(bundleDir)).toBe(false)
  expect(readProfileManifest('test', dir).dependencies).not.toHaveProperty('addon')
  expect(ctx.pluginPackages.packageOf('addon', parentURL)).toBeUndefined()
  expect(existsSync(evaluationPath)).toBe(false)
  expect(ctx.get('packageReloadSibling')).toBe(sibling)
})

it.each([{ live: true }, { live: false }])('keeps the running version and publishes nothing when an installed bundle is overwritten with HMR=$live', async ({ live }) => {
  const { ctx, dir, trace, published, manager, evaluationPath, entry } = await fixture({ live, installed: true })
  const previous = entry()?.fiber
  expect(previous?.state).toBe(FiberState.ACTIVE)
  expect(ctx.get('addonVersion')).toBe(1)
  mockPnpm(dir, trace, (args) => {
    expect(args.slice(0, 2)).toEqual(['add', 'addon@2'])
    installFiles(dir, 2)
  })

  expect(await manager.installBundle('addon@2', { enabled: true })).toMatchObject({ application: 'restart-required', changed: true })
  expect(published).not.toHaveBeenCalled()
  expect(trace).toEqual(['start:sibling', 'start:addon:1', 'pnpm:add'])
  expect(entry()?.fiber).toBe(previous)
  expect(previous?.state).toBe(FiberState.ACTIVE)
  expect(ctx.get('addonVersion')).toBe(1)
  expect(readFileSync(evaluationPath, 'utf8')).toBe('addon:1\n')
})

it('publishes nothing after installation fails', async () => {
  const { ctx, dir, trace, published, manager, parentURL, evaluationPath, entry } = await fixture()
  mockPnpm(dir, trace, () => { installFiles(dir, 1) }, 1)

  expect(await manager.installBundle('addon', { enabled: true })).toMatchObject({
    application: 'failed', changed: false, error: { diagnostic: 'fixture install failed' }, packageResult: { exitCode: 1 },
  })
  expect(published).not.toHaveBeenCalled()
  expect(trace).toEqual(['start:sibling', 'pnpm:add'])
  expect(readProfileManifest('test', dir).dependencies).toEqual({})
  expect(ctx.pluginPackages.packageOf('addon-plugin', parentURL)).toBeUndefined()
  expect(entry()).toBeUndefined()
  expect(existsSync(evaluationPath)).toBe(false)
})

it.each(['install', 'remove'] as const)('keeps successful %s disk changes when resolution publication fails', async (operation) => {
  const { ctx, dir, trace, published, manager, parentURL, entry } = await fixture({ installed: operation === 'remove' })
  const previous = ctx.pluginPackages.packageOf('addon-plugin', parentURL)
  mockPnpm(dir, trace, () => { if (operation === 'install') installFiles(dir, 1); else removeFiles(dir) })
  published.mockImplementation(() => { throw new Error('publication rejected') })

  const result = operation === 'install' ? await manager.installBundle('addon') : await manager.removeBundle('addon')

  expect(result).toMatchObject({
    application: 'failed', changed: true, error: { diagnostic: 'publication rejected' }, packageResult: { exitCode: 0 },
  })
  expect(published).toHaveBeenCalledOnce()
  const manifest = readProfileManifest('test', dir)
  expect(manifest.dependencies).toEqual(operation === 'install' ? { addon: '1.0.0' } : {})
  expect(manifest.dsh?.profile?.bundles).toEqual(operation === 'install' ? ['core', 'addon'] : ['core'])
  expect(existsSync(join(dir, 'node_modules', 'addon'))).toBe(operation === 'install')
  expect(ctx.pluginPackages.packageOf('addon-plugin', parentURL)).toBe(previous)
  expect(entry()).toBeUndefined()
})

it('publishes nothing after installation is cancelled', async () => {
  const { ctx, dir, trace, published, manager, parentURL, evaluationPath, entry } = await fixture()
  const started = Promise.withResolvers<undefined>()
  const stopped = Promise.withResolvers<undefined>()
  const pnpm = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async (_context, _args, options) => {
    installFiles(dir, 1)
    const signal = options.signal
    if (signal === undefined) throw new Error('Installation did not supply its cancellation signal')
    const abort = () => { stopped.resolve(undefined) }
    signal.addEventListener('abort', abort, { once: true })
    started.resolve(undefined)
    try { await stopped.promise } finally { signal.removeEventListener('abort', abort) }
    return { exitCode: 1, output: 'cancelled', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  const requestId = '9feec888-53de-4c23-8486-965e5a0367b3' as PluginInstallRequestId
  const installing = manager.installBundle('addon', { enabled: true, requestId })
  onTestFinished(async () => {
    stopped.resolve(undefined)
    await installing
    pnpm.mockRestore()
  })
  await started.promise

  expect(await manager.cancelInstall(requestId)).toEqual({ status: 'cancelled' })
  expect(await installing).toMatchObject({ application: 'cancelled', changed: false })
  expect(published).not.toHaveBeenCalled()
  expect(trace).toEqual(['start:sibling'])
  expect(readProfileManifest('test', dir).dependencies).toEqual({})
  expect(ctx.pluginPackages.packageOf('addon-plugin', parentURL)).toBeUndefined()
  expect(entry()).toBeUndefined()
  expect(existsSync(evaluationPath)).toBe(false)
})

it('publishes a newly installed bundle without HMR and leaves its activation to the restart', async () => {
  const { ctx, dir, trace, published, manager, parentURL, evaluationPath, entry } = await fixture({ live: false })
  mockPnpm(dir, trace, () => { installFiles(dir, 1) })

  expect(await manager.installBundle('addon', { enabled: true })).toMatchObject({ application: 'restart-required', changed: true })
  expect(published).toHaveBeenCalledOnce()
  expect(trace).toEqual(['start:sibling', 'pnpm:add', 'publish'])
  expect(ctx.pluginPackages.packageOf('addon', parentURL)?.version).toBe('1.0.0')
  expect(entry()).toBeUndefined()
  expect(ctx.get('addonVersion')).toBeUndefined()
  expect(existsSync(evaluationPath)).toBe(false)
})
