/** Persistent manager behavior through a real profile Include and Loader. */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { once } from 'node:events'
import { createServer } from 'node:http'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execa } from 'execa'
import type { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import {
  boot, composeEntries, initProfile, loadProfileDirectory, readProfilePatches, readProfileManifest,
  reconcileProfilePatches, OPTIONAL_BUNDLES, PluginPackages, readPluginMeta, getDshRuntimeVersion,
  type ProfileContext, type RuntimeResolution,
} from '@deepseek-ai/dsh-app-boot'
import PluginManager, { type Config, type PluginChange, type PluginInstallLogChunk, type PluginInstallProgress, type PluginInstallRequestId } from '../src/index.ts'
import Hmr from '@deepseek-ai/dsh-hmr'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { Group } from '@deepseek-ai/cordis-plugin-loader'
import * as operations from '../src/operations.ts'
import * as githubConnection from '../src/github-connection.ts'
import { parse, parseDocument } from 'yaml'

async function fixture(reload: 'live' | 'startup' = 'live', overlay = false, prepare?: (ctx: Context) => void, config: Config = {}, packageManager?: ProfileContext['packageManager'], prepareFiles?: (dir: string) => void) {
  const temporaryHome = mkdtempSync(join(tmpdir(), 'plugin-manager-'))
  let owner: Context | undefined
  onTestFinished(async () => { await owner?.fiber.dispose(); rmSync(temporaryHome, { recursive: true, force: true }) })
  // pnpm resolves workspace roots through native realpath, including Windows 8.3 aliases.
  const home = await realpath(temporaryHome)
  const dir = join(home, 'profiles', 'test')
  const anchor = join(home, 'package.json')
  writeFileSync(anchor, '{"name":"installation","dependencies":{}}\n')
  initProfile(dir, ['core', 'extra'])
  const bundle = (name: string, rows: unknown[]) => {
    const path = join(dir, 'node_modules', name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(path, 'cordis.patch.yml'), JSON.stringify([{ insert: rows }]))
    writeFileSync(join(path, 'plugin.mjs'), 'export function apply(ctx, config) { if (config?.fail) throw new Error("test activation failed"); ctx.provide(config?.service ?? "managedProbe", true) }\n')
  }
  bundle('core', [{ id: 'manager', name: 'cordis:manager', config }])
  bundle('extra', [{ id: 'managed', name: './plugin.mjs' }])
  const manifest = readProfileManifest('test', dir)
  manifest.dependencies = { extra: '1.0.0' }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  prepareFiles?.(dir)
  const overlays: PatchOptions[] = overlay ? [{ id: 'managed', disabled: true }] : []
  const profile: ProfileContext = {
    name: 'test',
    ...(packageManager === undefined ? {} : { packageManager }),
    startedBundles: loadProfileDirectory('test', dir, anchor).layers.map(layer => layer.packageName),
    dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: anchor, cwd: home, home,
    overlays, telemetryDisabledEnv: undefined,
  }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    owner = ctx
    ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    prepare?.(ctx)
    ctx.provide('profileContext', profile)
    ctx.loader.builtins.manager = PluginManager
  })
  // What pnpm's own configuration names is read from pnpm before every registry plan; the fixture answers npm's own registry.
  const registry = vi.spyOn(operations, 'readProfileRegistry').mockResolvedValue('https://registry.npmjs.org/')
  const connection = vi.spyOn(githubConnection, 'checkGithubConnection').mockResolvedValue(undefined)
  onTestFinished(() => { registry.mockRestore(); connection.mockRestore() })
  let stopHmr = async () => {}
  if (reload === 'live') {
    await ctx.plugin(Timer)
    const owner = await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    stopHmr = () => owner.dispose()
    await ctx.hmr.runExclusive(async () => {})
  }
  return { ctx, dir, manager: ctx.pluginManager, bundle, profile, stopHmr, overlays, connection }
}

it.each(['network', 'timeout'] as const)('stops a GitHub %s before pnpm and attributes it to the repository', async (kind) => {
  const { manager, dir, connection } = await fixture()
  const before = readFileSync(join(dir, 'package.json'), 'utf8')
  const failure = { exitCode: 1, output: 'GitHub check failed', truncated: false, logPath: join(dir, 'git.log'), kind }
  connection.mockResolvedValue(failure)
  const pnpm = vi.spyOn(operations, 'runProfilePnpm')
  onTestFinished(() => { pnpm.mockRestore() })
  expect(await manager.installBundle('https://github.com/acme/dsh-plugin.git')).toMatchObject({
    application: 'failed', changed: false, stage: 'install', failedAt: 'spec-host', packageResult: failure,
  })
  expect(pnpm).not.toHaveBeenCalled()
  expect(connection).toHaveBeenCalledWith(expect.objectContaining({ host: 'github.com' }), dir, expect.objectContaining({ timeoutMs: 5000 }))
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
})

it('leaves non-network GitHub errors to pnpm and forwards profile Git environment and deadline', async () => {
  const env = { GIT_CONFIG_GLOBAL: '/application/git.config' }
  const { manager, connection } = await fixture('live', false, undefined, { githubConnectionTimeoutMs: 8000 }, { command: 'pnpm', args: [], env })
  connection.mockResolvedValue({ exitCode: 128, output: 'fatal: Authentication failed', truncated: false, logPath: 'git.log', kind: 'unknown' })
  const failure = { exitCode: 1, output: 'pnpm owns authentication', truncated: false, logPath: 'pnpm.log', kind: 'unknown' as const }
  const pnpm = vi.spyOn(operations, 'runProfilePnpm').mockResolvedValue(failure)
  onTestFinished(() => { pnpm.mockRestore() })
  const result = await manager.installBundle('github:acme/private-plugin')
  expect(result.application).toBe('failed')
  expect(result.packageResult).toEqual(failure)
  expect(pnpm).toHaveBeenCalledOnce()
  expect(result.failedAt).toBeUndefined()
  expect(connection).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ timeoutMs: 8000, env }))
})

it('cancels an active GitHub check before starting pnpm', async () => {
  const { manager, connection } = await fixture()
  const entered = Promise.withResolvers<undefined>()
  connection.mockImplementation(async (_spec, _dir, options) => {
    entered.resolve(undefined)
    await new Promise<void>((resolve) => { options.signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    return { exitCode: 1, output: 'cancelled', truncated: false, logPath: 'git.log', kind: 'unknown' }
  })
  const pnpm = vi.spyOn(operations, 'runProfilePnpm')
  onTestFinished(() => { pnpm.mockRestore() })
  const requestId = '824103ec-bc45-489d-bb85-5b4fe0aefc78' as PluginInstallRequestId
  const installing = manager.installBundle('github:acme/dsh-plugin', { requestId })
  await entered.promise
  expect(await manager.cancelInstall(requestId)).toEqual({ status: 'cancelled' })
  expect(await installing).toMatchObject({ application: 'cancelled', changed: false })
  expect(pnpm).not.toHaveBeenCalled()
})

it('waits for the GitHub check before installing and activating the bundle', async () => {
  const { manager, dir, bundle, connection } = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  connection.mockImplementation(async () => { entered.resolve(undefined); await release.promise; return undefined })
  const pnpm = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    bundle('addon', [])
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, addon: '1.0.0' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: 'installed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  const installing = manager.installBundle('github:acme/addon')
  onTestFinished(async () => { release.resolve(undefined); await installing; pnpm.mockRestore() })
  await entered.promise
  expect(pnpm).not.toHaveBeenCalled()
  release.resolve(undefined)
  expect(await installing).toMatchObject({ application: 'applied', changed: true, bundle: 'addon' })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toContain('addon')
})

it('disposal waits for an active GitHub check to stop', async () => {
  const { ctx, manager, connection } = await fixture('startup')
  const entered = Promise.withResolvers<undefined>()
  const released = Promise.withResolvers<undefined>()
  connection.mockImplementation(async (_spec, _dir, options) => {
    entered.resolve(undefined)
    await new Promise<void>((resolve) => { options.signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    released.resolve(undefined)
    return { exitCode: 1, output: 'cancelled', truncated: false, logPath: 'git.log', kind: 'unknown' }
  })
  const pnpm = vi.spyOn(operations, 'runProfilePnpm')
  onTestFinished(() => { pnpm.mockRestore() })
  const installing = manager.installBundle('github:acme/addon')
  await entered.promise
  await ctx.fiber.dispose()
  await released.promise
  expect(await installing).toMatchObject({ application: 'cancelled', changed: false })
  expect(pnpm).not.toHaveBeenCalled()
})

it.each(['github:acme/connected', 'https://github.com/acme/connected.git', 'git+ssh://git@github.com/acme/connected.git'])(
  'installs %s through real Git and pnpm with private repository SSH fallback', async (spec) => {
    const pnpm = fileURLToPath(new URL('../../../../apps/desktop/node_modules/pnpm/bin/pnpm.mjs', import.meta.url))
    const env = { GIT_CONFIG_GLOBAL: '', GIT_CONFIG_NOSYSTEM: '1' }
    const { manager, dir, connection } = await fixture('startup', false, undefined, {}, {
      command: process.execPath, args: ['--expose-internals', pnpm], env,
    })
    connection.mockRestore()
    const repository = join(dir, 'repository')
    mkdirSync(repository)
    env.GIT_CONFIG_GLOBAL = join(dir, 'git.config')
    writeFileSync(env.GIT_CONFIG_GLOBAL, '')
    const git = (args: string[]) => execa('git', args, { cwd: repository, env })
    await git(['init', '--initial-branch=main'])
    const name = '@test/github-connected'
    writeFileSync(join(repository, 'package.json'), JSON.stringify({ name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(repository, 'cordis.patch.yml'), '[]\n')
    await git(['add', '.'])
    await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture bundle'])
    const requests: string[] = []
    const sockets = new Set<Socket>()
    const proxy = createServer((_request, response) => {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' })
      response.end()
    })
    proxy.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => { sockets.delete(socket) })
    })
    proxy.on('connect', (request, socket) => {
      requests.push(request.url ?? '')
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    })
    onTestFinished(async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => { proxy.close((error) => { if (error) reject(error); else resolve() }) })
    })
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    const address = proxy.address()
    if (address === null || typeof address === 'string') throw new Error('proxy did not bind a TCP port')
    const proxyUrl = `http://127.0.0.1:${String(address.port)}`
    writeFileSync(env.GIT_CONFIG_GLOBAL, `[url "${pathToFileURL(repository).href}"]\n insteadOf = ssh://git@github.com/acme/connected.git\n insteadOf = git@github.com:acme/connected.git\n[url "${proxyUrl}/"]\n insteadOf = https://github.com/\n[http]\n proxy =\n`)
    // pnpm probes HTTPS with Node before falling back to SSH, even for an SSH spec.
    // Route that HTTP request to our proxy too; Git's URL rewrite alone cannot isolate it.
    const manifest = readProfileManifest('test', dir)
    delete manifest.dependencies
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    writeFileSync(join(dir, '.npmrc'), `store-dir=${join(dir, 'store').replaceAll('\\', '/')}\nhttps-proxy=${proxyUrl}\nproxy=${proxyUrl}\nnoproxy=\n`)
    const result = await manager.installBundle(spec, { enabled: false })
    expect(result.error).toBeUndefined()
    expect(result).toMatchObject({ changed: true, bundle: name, packageResult: { exitCode: 0 } })
    expect(readProfileManifest('test', dir).dependencies).toHaveProperty(name)
    expect(requests).toContain('github.com:443')
  },
)

it.each(['missing package', 'invalid manifest', 'not a bundle', 'missing patch', 'invalid patch'])(
  'boots with %s, lists its error, and permits deselection without enabling the broken bundle', async (failure) => {
    const { manager, dir, ctx } = await fixture('live', false, undefined, {}, undefined, (dir) => {
      const path = join(dir, 'node_modules', 'extra')
      if (failure === 'missing package') rmSync(path, { recursive: true })
      if (failure === 'invalid manifest') writeFileSync(join(path, 'package.json'), '{')
      if (failure === 'not a bundle') writeFileSync(join(path, 'package.json'), '{}')
      if (failure === 'missing patch') rmSync(join(path, 'cordis.patch.yml'))
      if (failure === 'invalid patch') writeFileSync(join(path, 'cordis.patch.yml'), '[invalid')
    })
    expect([...ctx.loader.entries()].some(entry => entry.id === 'include:managed')).toBe(false)
    expect((await manager.listBundles()).find(row => row.name === 'extra')).toMatchObject({
      enabled: true, error: { code: failure === 'not a bundle' ? 'not-bundle' : 'operation-error' }, rows: [],
    })
    expect(await manager.setBundleEnabled('extra', false)).toMatchObject({ changed: true, application: 'applied' })
    expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['core'])
    expect(await manager.setBundleEnabled('extra', true)).toMatchObject({ changed: false, application: 'failed' })
  },
)

it.each(['missing files', 'missing declaration'])('keeps a running management bundle protected with %s', async (failure) => {
  const { manager, dir } = await fixture()
  if (failure === 'missing files') rmSync(join(dir, 'node_modules', 'core'), { recursive: true })
  else writeFileSync(join(dir, 'node_modules', 'core', 'package.json'), '{}')
  expect((await manager.listBundles()).find(row => row.name === 'core')).toMatchObject({
    enabled: true, readOnlyReason: 'management-required', removable: false, error: { code: failure === 'missing files' ? 'operation-error' : 'not-bundle' },
  })
  expect(await manager.setBundleEnabled('core', false)).toMatchObject({
    changed: false, application: 'failed', error: { code: 'management-required' },
  })
})

it.each(['live', 'startup'] as const)('removes a bundle skipped at startup in a %s profile', async (mode) => {
  const { manager, dir } = await fixture(mode, false, undefined, {}, undefined, (dir) => {
    rmSync(join(dir, 'node_modules', 'extra'), { recursive: true })
  })
  const remove = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    const manifest = readProfileManifest('test', dir)
    expect(manifest.dsh?.profile?.bundles).toEqual(['core'])
    delete manifest.dependencies?.extra
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: 'removed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  onTestFinished(() => { remove.mockRestore() })
  expect(await manager.removeBundle('extra')).toMatchObject({ changed: true, application: mode === 'live' ? 'applied' : 'restart-required' })
  expect((await manager.listBundles()).some(row => row.name === 'extra')).toBe(false)
})

it('recomposes the remaining layers while another bundle is broken and mounts it after repair', async () => {
  const { manager, dir, bundle, ctx } = await fixture()
  writeFileSync(join(dir, 'node_modules', 'extra', 'cordis.patch.yml'), '[invalid')
  bundle('another', [])
  expect(await manager.setBundleEnabled('another', true)).toMatchObject({ application: 'applied' })
  expect([...ctx.loader.entries()].some(entry => entry.id === 'include:managed')).toBe(false)
  bundle('extra', [{ id: 'managed', name: './plugin.mjs' }])
  expect(await manager.setBundleEnabled('another', false)).toMatchObject({ application: 'applied' })
  expect([...ctx.loader.entries()].find(entry => entry.id === 'include:managed')?.fiber?.state).toBe(2)
  expect((await manager.listBundles()).find(row => row.name === 'extra')?.error).toBeUndefined()
})

it('lists bundle versions and current-profile plugin targets', async () => {
  const { manager, dir } = await fixture()
  const plugins = await manager.listPlugins()
  expect(plugins.find(row => row.entryId === 'include:managed')).toMatchObject({ patchId: 'managed', enabled: true })
  expect(plugins.find(row => row.entryId === 'include:manager')?.readOnlyReason).toBe('management-required')
  expect(await manager.listBundles()).toEqual([
    {
      name: 'core', version: '1.0.0', enabled: true, installed: false, optional: false, removable: false, readOnlyReason: 'management-required',
      meta: { title: 'core' },
      rows: [{ rowId: 'manager', moduleName: 'cordis:manager', entryId: 'include:manager' }], overrides: [],
    },
    {
      name: 'extra', version: '1.0.0', enabled: true, installed: true, optional: false, removable: true,
      meta: { title: 'extra' },
      rows: [{ rowId: 'managed', moduleName: pathToFileURL(join(dir, 'node_modules', 'extra', 'plugin.mjs')).href, entryId: 'include:managed' }], overrides: [],
    },
  ])
})

it('describes a bundle by its manifest and patch: one-liner, rows without a live entry, and the built-in rows it changes', async () => {
  const { manager, dir, bundle } = await fixture()
  bundle('described', [{ id: 'described-row', name: './plugin.mjs' }])
  writeFileSync(join(dir, 'node_modules', 'described', 'package.json'), JSON.stringify({
    name: 'described', version: '2.0.0', description: 'Describes itself.', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  // An anonymous row is not addressable and is left out of the rows.
  writeFileSync(join(dir, 'node_modules', 'described', 'cordis.patch.yml'), JSON.stringify([
    { insert: [{ id: 'described-row', name: './plugin.mjs' }, { name: './plugin.mjs' }] }, { id: 'managed', disabled: true }, { id: 'described-row', config: {} },
  ]))
  const manifest = readProfileManifest('test', dir)
  manifest.dependencies = { ...manifest.dependencies, described: '2.0.0' }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  const moduleName = pathToFileURL(join(dir, 'node_modules', 'described', 'plugin.mjs')).href
  expect((await manager.listBundles()).find(row => row.name === 'described')).toEqual({
    name: 'described', version: '2.0.0', description: 'Describes itself.', enabled: false, installed: true, optional: false, removable: true,
    meta: { title: 'described', description: 'Describes itself.' },
    rows: [{ rowId: 'described-row', moduleName }], overrides: ['managed'],
  })
  await manager.setBundleEnabled('described', true)
  expect((await manager.listBundles()).find(row => row.name === 'described')?.rows).toEqual([
    { rowId: 'described-row', moduleName, entryId: 'include:described-row' },
  ])
  // Off again, the rows lose their entries.
  await manager.setBundleEnabled('described', false)
  expect((await manager.listBundles()).find(row => row.name === 'described')?.rows).toEqual([{ rowId: 'described-row', moduleName }])
})

it.each(['native', 'runtime'] as const)('reads a disabled bundle and its independent exported plugins without running them with %s resolution', async (mode) => {
  const { ctx, manager, dir, bundle, profile } = await fixture('startup')
  bundle('localized', [{ id: 'first', name: 'local-child/first' }, { id: 'second', name: 'local-child/second' }])
  const root = join(dir, 'node_modules', 'localized')
  const child = mode === 'runtime'
    ? join(profile.home, 'installation', 'node_modules', 'local-child')
    : join(root, 'node_modules', 'local-child')
  mkdirSync(join(root, 'locale'), { recursive: true })
  mkdirSync(join(child, 'first-locale'), { recursive: true })
  mkdirSync(join(child, 'second-locale'), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'localized',
    exports: { './locale/*.json': './locale/*.json' }, dsh: {
      bundle: { patch: './cordis.patch.yml' },
    } }))
  writeFileSync(join(root, 'locale', 'en.json'), '{"meta":{"title":"Local bundle"}}')
  writeFileSync(join(root, 'locale', 'zh.json'), '{"meta":{"title":"本地组合包"}}')
  writeFileSync(join(child, 'package.json'), JSON.stringify({ name: 'local-child', exports: {
    './first': './index.js', './second': './index.js',
    './first/locale/*.json': './first-locale/*.json', './second/locale/*.json': './second-locale/*.json',
  } }))
  writeFileSync(join(child, 'index.js'), 'throw new Error("must not execute")\n')
  writeFileSync(join(child, 'first-locale', 'en.json'), '{"meta":{"title":"First plugin"}}')
  writeFileSync(join(child, 'second-locale', 'en.json'), '{"meta":{"title":"Second plugin"}}')
  const manifest = readProfileManifest('test', dir)
  manifest.dependencies = { ...manifest.dependencies, localized: '1.0.0' }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  const parentURL = pathToFileURL(join(root, 'package.json')).href
  const readChildren = () => ['first', 'second'].map(part => readPluginMeta(`local-child/${part}`, parentURL))
  const expectUnlinked = () => {
    expect(lstatSync(child).isDirectory()).toBe(true)
    for (const path of [
      join(root, 'node_modules'), join(dir, 'node_modules', 'local-child'),
      join(profile.home, 'profiles', 'node_modules'), join(profile.home, 'node_modules'),
      join(dir, '.dsh-module-fallback'),
    ]) expect(lstatSync(path, { throwIfNoEntry: false }), path).toBeUndefined()
  }
  const resolution: RuntimeResolution = {
    profilesDir: join(profile.home, 'profiles'), profileDir: dir,
    localPackageNames: Object.keys(manifest.dependencies),
    linkedRoots: [],
    entries: [{ name: 'local-child', packageDir: child, version: undefined,
      declarer: join(child, 'package.json'), scope: 'installation' }],
  }
  if (mode === 'runtime') {
    expectUnlinked()
    expect(readChildren()).toEqual([undefined, undefined])
  }
  await ctx.plugin(PluginPackages, mode === 'runtime' ? { resolution } : {})
  const result = (await manager.listBundles()).find(row => row.name === 'localized')
  expect(result).toMatchObject({ enabled: false, meta: { title: { en: 'Local bundle', zh: '本地组合包' } }, rows: [
    { rowId: 'first', moduleName: 'local-child/first', meta: { title: { en: 'First plugin' } } },
    { rowId: 'second', moduleName: 'local-child/second', meta: { title: { en: 'Second plugin' } } },
  ] })
  expect(result?.rows[0]?.entryId).toBeUndefined()
  expect(readPluginMeta('local-child/private', parentURL)).toBeUndefined()
  if (mode === 'runtime') {
    expectUnlinked()
    await ctx.fiber.dispose()
    expect(readChildren()).toEqual([undefined, undefined])
    expectUnlinked()
  }
})

it.each([
  { resources: 'exported', exports: { './locale/*.json': './locale/*.json' }, expected: { meta: { title: { en: 'Nameless bundle' } } } },
  { resources: 'private', exports: {}, expected: {} },
])('lists a bundle without a manifest name with $resources locale resources', async ({ exports, expected }) => {
  const { manager, dir, bundle } = await fixture('startup')
  bundle('unnamed', [])
  const root = join(dir, 'node_modules', 'unnamed')
  mkdirSync(join(root, 'locale'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    version: '1.0.0', exports, dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(root, 'locale', 'en.json'), '{"meta":{"title":"Nameless bundle"}}')
  const manifest = readProfileManifest('test', dir)
  manifest.dependencies = { ...manifest.dependencies, unnamed: '1.0.0' }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))

  expect((await manager.listBundles()).find(row => row.name === 'unnamed')).toEqual({
    name: 'unnamed', version: '1.0.0', enabled: false, installed: true, optional: false, removable: true,
    rows: [], overrides: [], ...expected,
  })
})

it('turns a plugin off and on without duplicating patch overrides', async () => {
  const { manager, dir } = await fixture()
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  expect(await manager.setPluginEnabled(id, false)).toMatchObject({ changed: true, application: 'applied' })
  expect((await manager.listPlugins()).find(row => row.entryId === id)?.enabled).toBe(false)
  expect(await manager.setPluginEnabled(id, false)).toMatchObject({ changed: false, application: 'applied' })
  expect(await manager.setPluginEnabled(id, true)).toMatchObject({ changed: true, application: 'applied' })
  expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8').match(/id: managed/g)).toHaveLength(1)
})

it('retains installed dependencies when toggling a bundle and appends it when re-enabled', async () => {
  const { manager, dir, bundle } = await fixture()
  bundle('third', [])
  await manager.setBundleEnabled('third', true)
  expect(await manager.setBundleEnabled('extra', false)).toMatchObject({ changed: true, application: 'applied' })
  expect(await manager.setBundleEnabled('extra', false)).toMatchObject({ changed: false, application: 'applied' })
  expect(readProfileManifest('test', dir).dependencies).toEqual({ extra: '1.0.0' })
  expect((await manager.listPlugins()).some(row => row.patchId === 'managed')).toBe(false)
  await manager.setBundleEnabled('extra', true)
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['core', 'third', 'extra'])
})

it('reports an overlay overriding a saved plugin toggle', async () => {
  const { manager } = await fixture('live', true)
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  expect(await manager.setPluginEnabled(id, true)).toMatchObject({ changed: true, application: 'overridden' })
})

it('saves startup-only toggles and refuses removal of currently used packages', async () => {
  const { manager } = await fixture('startup')
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  expect(await manager.setPluginEnabled(id, false)).toMatchObject({ application: 'restart-required' })
  expect((await manager.listPlugins()).find(row => row.entryId === id)?.enabled).toBe(true)
  await manager.setBundleEnabled('extra', false)
  expect(await manager.removeBundle('extra')).toMatchObject({ changed: false, application: 'failed', error: { code: 'stop-profile' } })
})

it('refuses self-disable, unknown entries and removal of installation-owned bundles', async () => {
  const { manager } = await fixture()
  const id = (await manager.listPlugins()).find(row => row.entryId === 'include:manager')!.entryId
  expect(await manager.setPluginEnabled(id, false)).toMatchObject({ changed: false, application: 'failed', error: { code: 'management-required' } })
  expect(await manager.setPluginEnabled('missing' as typeof id, true)).toMatchObject({ changed: false, application: 'failed', error: { code: 'unknown-plugin' } })
  expect(await manager.removeBundle('core')).toMatchObject({ changed: false, application: 'failed', error: { code: 'not-removable' } })
  // A name no bundle directory answers to fails with the resolver's own diagnostic.
  expect(await manager.setBundleEnabled('unknown', true)).toMatchObject({ changed: false, application: 'failed', error: { code: 'operation-error' } })
})

it('installs only valid bundle declarations and honors installation without activation', async () => {
  const { manager, dir, bundle } = await fixture()
  const initial = readProfileManifest('test', dir)
  delete initial.dependencies
  writeFileSync(join(dir, 'package.json'), JSON.stringify(initial))
  const install = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async (_context, args) => {
    const name = String(args[1])
    bundle(name, [{ id: name, name: './plugin.mjs', config: { service: name } }])
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, [name]: '1.0.0' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: 'installed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  onTestFinished(() => { install.mockRestore() })
  expect(await manager.installBundle('new-bundle', { enabled: false })).toMatchObject({
    changed: true, application: 'applied', stage: 'enable', target: 'new-bundle', bundle: 'new-bundle', packageResult: { exitCode: 0 },
  })
  expect((await manager.listBundles()).find(row => row.name === 'new-bundle')?.enabled).toBe(false)
  expect(await manager.setBundleEnabled('new-bundle', true)).toMatchObject({ application: 'applied' })
  expect((await manager.listPlugins()).find(row => row.patchId === 'new-bundle')?.fiberPhase).toBe('active')
  expect(await manager.installBundle('another-bundle')).toMatchObject({ application: 'applied' })
  expect((await manager.listBundles()).find(row => row.name === 'another-bundle')?.enabled).toBe(true)
})

it('reports blocked scripts after a failed installation and retries only after explicit profile build approval', async () => {
  const { manager, dir, bundle } = await fixture()
  const policy = join(dir, 'pnpm-workspace.yaml')
  const run = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    const manifest = readProfileManifest('test', dir)
    const completion = { exitCode: 0, output: '', truncated: false, logPath: join(dir, 'pnpm.log') }
    manifest.dependencies = { ...manifest.dependencies, addon: '1.0.0' }
    if (run.mock.calls.length === 1) {
      writeFileSync(policy, 'allowBuilds:\n  native: set this to true or false\n  denied: false\n')
      completion.exitCode = 1
      completion.output = 'ERR_PNPM_IGNORED_BUILDS'
    } else {
      expect(parse(readFileSync(policy, 'utf8'))).toEqual({ allowBuilds: { native: true, denied: false } })
      bundle('addon', [])
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return completion
  })
  onTestFinished(() => { run.mockRestore() })
  // The failed run's manifest change is put back; the policy pnpm wrote stays, so its undecided names can be offered.
  expect(await manager.installBundle('addon')).toMatchObject({ application: 'failed', pendingBuilds: ['native'] })
  expect(readProfileManifest('test', dir).dependencies).not.toHaveProperty('addon')
  expect(parse(readFileSync(policy, 'utf8'))).toMatchObject({ allowBuilds: { native: 'set this to true or false' } })
  expect(await manager.installBundle('addon', { approvedBuilds: ['denied'] })).toMatchObject({ application: 'failed', changed: false, error: { code: 'stale-approval' } })
  expect(run).toHaveBeenCalledTimes(1)
  expect(await manager.installBundle('addon', { approvedBuilds: ['native'], enabled: false })).toMatchObject({
    application: 'applied', changed: true, approvedBuilds: ['native'],
  })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).not.toContain('addon')
})

it('retains approved policy and reports it as changed when the registry fails before adding a dependency', async () => {
  const { manager, dir } = await fixture()
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'allowBuilds:\n  native: set this to true or false\n')
  const run = vi.spyOn(operations, 'runProfilePnpm').mockResolvedValue({ exitCode: 1, output: 'registry unavailable', truncated: false, logPath: '/log' })
  onTestFinished(() => { run.mockRestore() })
  expect(await manager.installBundle('addon', { approvedBuilds: ['native'] })).toMatchObject({
    changed: true, application: 'failed', pendingBuilds: [], approvedBuilds: ['native'], error: { diagnostic: 'registry unavailable' },
  })
  expect(parse(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'))).toEqual({ allowBuilds: { native: true } })
})

it('runs a real pnpm dependency script only after approval and retry', async () => {
  const { manager, dir, profile } = await fixture('startup')
  const addon = join(profile.cwd, 'addon')
  mkdirSync(addon)
  writeFileSync(join(addon, 'package.json'), JSON.stringify({ name: 'approval-fixture-addon', version: '1.0.0',
    scripts: { install: 'node build.cjs' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(addon, 'build.cjs'), 'require("node:fs").writeFileSync("built.txt", "built")\n')
  writeFileSync(join(addon, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(dir, 'package.json'), '{"name":"approval-fixture","private":true}\n')
  const policy = parseDocument(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'))
  policy.set('offline', true)
  policy.set('storeDir', join(profile.cwd, 'store'))
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), String(policy))
  const blocked = await manager.installBundle('file:./addon', { enabled: false })
  expect(blocked, JSON.stringify(blocked)).toMatchObject({ application: 'failed', packageResult: { kind: 'build-blocked' } })
  expect(blocked.pendingBuilds).toHaveLength(1)
  const built = join(dir, 'node_modules', 'approval-fixture-addon', 'built.txt')
  expect(existsSync(built)).toBe(false)
  expect(readProfileManifest('test', dir).dependencies?.['approval-fixture-addon']).toBeUndefined()
  const allowed = await manager.installBundle('file:./addon', { enabled: false, approvedBuilds: blocked.pendingBuilds! })
  expect(allowed, JSON.stringify(allowed)).toMatchObject({ application: 'restart-required', packageResult: { exitCode: 0 } })
  expect(readFileSync(built, 'utf8')).toBe('built')
})

it.each(['[', 'allowBuilds: false\n'])('preserves pnpm diagnostics when pending approvals cannot be read: %s', async (policy) => {
  const { manager, dir } = await fixture()
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), policy)
  const run = vi.spyOn(operations, 'runProfilePnpm').mockResolvedValue({ exitCode: 1, output: 'original pnpm failure', truncated: false, logPath: '/log' })
  onTestFinished(() => { run.mockRestore() })
  expect(await manager.installBundle('addon')).toMatchObject({ application: 'failed', error: { diagnostic: 'original pnpm failure' } })
})

it('unloads before removing packages and retries inactive dependencies whose files are missing', async () => {
  const { manager, dir, ctx } = await fixture()
  const remove = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    await ctx.hmr.runExclusive(async () => {
      expect([...ctx.loader.entries()].some(row => row.id === 'include:managed')).toBe(false)
    })
    return { exitCode: 1, output: 'removal failed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  onTestFinished(() => { remove.mockRestore() })
  expect(await manager.removeBundle('extra')).toMatchObject({ changed: true, application: 'failed', packageResult: { exitCode: 1 } })
  expect(readProfileManifest('test', dir).dependencies).toEqual({ extra: '1.0.0' })
  expect((await manager.listBundles()).find(row => row.name === 'extra')?.enabled).toBe(false)
  rmSync(join(dir, 'node_modules', 'extra'), { recursive: true })
  remove.mockImplementationOnce(async () => {
    const manifest = readProfileManifest('test', dir)
    delete manifest.dependencies?.extra
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: 'removed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  expect(await manager.removeBundle('extra')).toMatchObject({ changed: true, application: 'applied' })
  expect((await manager.listBundles()).some(row => row.name === 'extra')).toBe(false)
})

it('treats a terminated run that trapped the signal and exited zero as a failure', async () => {
  const { manager, dir } = await fixture()
  const install = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    // pnpm rewrote the manifest before it trapped the manager's signal.
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, half: '1.0.0' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: 'installing\n', truncated: false, logPath: join(dir, 'pnpm.log'), timedOut: true }
  })
  onTestFinished(() => { install.mockRestore() })
  const result = await manager.installBundle('half', { enabled: false })
  expect(result).toMatchObject({ application: 'failed', packageResult: { exitCode: 0, timedOut: true, kind: 'timeout' } })
  // The half-written dependency goes back, and nothing is activated.
  expect(readProfileManifest('test', dir).dependencies).toEqual({ extra: '1.0.0' })
  expect((await manager.listBundles()).some(row => row.name === 'half')).toBe(false)
})

it('reports a terminated removal as failed even when pnpm exited zero', async () => {
  const { manager, dir } = await fixture()
  const remove = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    // The unload already happened, so the removal is reported through its own run.
    const manifest = readProfileManifest('test', dir)
    delete manifest.dependencies?.extra
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: 'removing\n', truncated: false, logPath: join(dir, 'pnpm.log'), timedOut: true }
  })
  onTestFinished(() => { remove.mockRestore() })
  expect(await manager.removeBundle('extra')).toMatchObject({
    application: 'failed', packageResult: { exitCode: 0, timedOut: true, kind: 'timeout' },
  })
})

it('restores the manifest and lockfile after a failed package run, classifying the failure', async () => {
  const { manager, dir } = await fixture()
  const lockPath = join(dir, 'pnpm-lock.yaml')
  const install = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, partial: '1' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    writeFileSync(lockPath, 'partial lockfile\n')
    return { exitCode: 42, output: 'ERR_PNPM_META_FETCH_FAIL  GET https://registry/partial: ENOTFOUND', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  onTestFinished(() => { install.mockRestore() })
  const before = readFileSync(join(dir, 'package.json'), 'utf8')
  // A registry that does not answer sends the installation on to the configured fallback; the failure reported is the last one's.
  expect(await manager.installBundle('partial')).toMatchObject({
    changed: false, application: 'failed', stage: 'install', target: 'partial',
    error: { code: 'operation-error', diagnostic: expect.stringContaining('ENOTFOUND') as string },
    packageResult: { exitCode: 42, kind: 'network' }, registries: [null, MIRROR],
  })
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
  // A lockfile the run created is removed; one that existed is put back.
  expect(existsSync(lockPath)).toBe(false)
  writeFileSync(lockPath, 'original lockfile\n')
  expect(await manager.installBundle('partial')).toMatchObject({ changed: false, application: 'failed' })
  expect(readFileSync(lockPath, 'utf8')).toBe('original lockfile\n')
  expect((await manager.listBundles()).some(row => row.name === 'partial')).toBe(false)
  expect(install).toHaveBeenCalledTimes(4)
})

it('keeps saved changes after activation failure and allows a corrected configuration to retry', async () => {
  const { manager, dir } = await fixture()
  writeFileSync(join(dir, 'cordis.patch.yml'), '- id: managed\n  disabled: true\n  config: { fail: true }\n')
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  expect(await manager.setPluginEnabled(id, true)).toMatchObject({ changed: true, application: 'failed' })
  expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toContain('disabled: false')
  writeFileSync(join(dir, 'cordis.patch.yml'), '- id: managed\n  disabled: true\n  config: { fail: false }\n')
  const result = await manager.setPluginEnabled(id, true)
  expect(result, JSON.stringify(result)).toMatchObject({ application: 'applied' })
})


it('reports a selected plain dependency as a problem, omits an unselected one, and reports missing versions', async () => {
  const { manager, dir, profile } = await fixture()
  writeFileSync(profile.installAnchor, '{}')
  writeFileSync(join(dir, 'node_modules', 'extra', 'package.json'), '{"name":"extra"}')
  expect((await manager.listBundles()).find(row => row.name === 'extra')).toMatchObject({ enabled: true, error: { code: 'not-bundle' } })
  expect(await manager.setBundleEnabled('extra', false)).toMatchObject({ application: 'applied' })
  // Switched off, a dependency without a bundle patch is a library the page has no business with.
  expect((await manager.listBundles()).some(row => row.name === 'extra')).toBe(false)
  expect(await manager.setBundleEnabled('extra', true)).toMatchObject({ changed: false, application: 'failed' })
  writeFileSync(join(dir, 'node_modules', 'core', 'package.json'), '{"name":"core","dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}')
  expect((await manager.listBundles())[0]?.version).toBeUndefined()
  writeFileSync(join(dir, 'package.json'), '{}')
  expect(await manager.listBundles()).toEqual([])
  expect(await manager.setBundleEnabled('unknown', false)).toMatchObject({ application: 'failed' })
  writeFileSync(profile.installAnchor, '{"dependencies":{"missing-builtin":"1"}}')
  expect(await manager.listBundles()).toEqual([])
})

it('refuses management bundle disablement and permits repeated bundle selections', async () => {
  const { manager } = await fixture()
  expect(await manager.setBundleEnabled('core', false)).toMatchObject({ application: 'failed', changed: false })
  expect(await manager.setBundleEnabled('extra', true)).toMatchObject({ application: 'applied', changed: false })
})

it.each([
  '@deepseek-ai/dsh-host-plugin-inventory',
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-api-remotes',
])('protects the management dependency %s and its containing bundle', async (name) => {
  const { ctx, manager, bundle, profile, dir } = await fixture('startup')
  bundle('extra', [{ id: 'dependency', name, disabled: true }])
  await reconcileProfilePatches(ctx, readProfilePatches('test', profile), 'test')
  const entry = (await manager.listPlugins()).find(row => row.moduleName === name)!
  expect(entry).toMatchObject({ readOnlyReason: 'management-required' })
  const manifest = readFileSync(join(dir, 'package.json'), 'utf8')
  const patch = readFileSync(profile.patchPath, 'utf8')
  expect(await manager.setPluginEnabled(entry.entryId, false)).toMatchObject({
    changed: false, application: 'failed', error: { code: 'management-required' },
  })
  expect((await manager.listBundles()).find(row => row.name === 'extra')).toMatchObject({
    removable: false, readOnlyReason: 'management-required',
  })
  expect(await manager.setBundleEnabled('extra', false)).toMatchObject({
    changed: false, application: 'failed', error: { code: 'management-required' },
  })
  expect(await manager.removeBundle('extra')).toMatchObject({
    changed: false, application: 'failed', error: { code: 'not-removable' },
  })
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(manifest)
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(patch)
})

it('addresses children inside profile groups and marks ambiguous ids read-only', async () => {
  const { manager, bundle, profile } = await fixture('live', false, (ctx) => { ctx.loader.builtins.group = Group })
  bundle('grouped', [{ id: 'group', name: 'cordis:group', group: true,
    config: [{ id: 'child', name: './plugin.mjs', config: { service: 'child' } }] }])
  expect(await manager.setBundleEnabled('grouped', true)).toMatchObject({ application: 'applied' })
  expect((await manager.listPlugins()).find(row => row.patchId === 'child')).toBeDefined()
  const entries = composeEntries([readProfilePatches('test', profile)])
  const duplicate = entries.find(row => row.id === 'managed')!
  writeFileSync(profile.patchPath, JSON.stringify([{ insert: [duplicate] }]))
  expect((await manager.listPlugins()).find(row => row.entryId === 'include:managed')?.readOnlyReason).toBe('unaddressable')
})

it.each(['', '-g'])('rejects an invalid installation spec before calling pnpm: %j', async (spec) => {
  const { manager } = await fixture()
  expect(await manager.installBundle(spec)).toMatchObject({ changed: false, application: 'failed', error: { code: 'invalid-spec' } })
})

it('restores the manifest when the package pnpm added declares no bundle', async () => {
  const { manager, dir, bundle } = await fixture()
  const install = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    bundle('plain', [])
    writeFileSync(join(dir, 'node_modules', 'plain', 'package.json'), '{"name":"plain"}')
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, plain: '1' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: 'installed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  onTestFinished(() => { install.mockRestore() })
  expect(await manager.installBundle('plain')).toMatchObject({
    changed: false, application: 'failed', stage: 'install', error: { code: 'not-bundle' }, packageResult: { exitCode: 0 },
  })
  // The manifest is put back rather than cleaned through another pnpm run.
  expect(install).toHaveBeenCalledOnce()
  expect(readProfileManifest('test', dir)).toMatchObject({ dependencies: { extra: '1.0.0' }, dsh: { profile: { bundles: ['core', 'extra'] } } })
  expect((await manager.listBundles()).some(row => row.name === 'plain')).toBe(false)
})

it('never removes an existing dependency after installation validation fails', async () => {
  const { manager, dir } = await fixture()
  writeFileSync(join(dir, 'node_modules', 'extra', 'package.json'), '{"name":"extra"}')
  const install = vi.spyOn(operations, 'runProfilePnpm').mockResolvedValue({ exitCode: 0, output: '', truncated: false, logPath: '/operation.log' })
  onTestFinished(() => { install.mockRestore() })
  const result = await manager.installBundle('extra')
  expect(result).toMatchObject({ application: 'failed', stage: 'install', error: { code: 'not-bundle' } })
  expect(install).toHaveBeenCalledOnce()
  expect(readProfileManifest('test', dir).dependencies).toEqual({ extra: '1.0.0' })
})

it('keeps a valid installed bundle when its subsequent activation fails', async () => {
  const { manager, dir, bundle } = await fixture()
  const install = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    bundle('broken', [{ id: 'broken', name: './plugin.mjs', config: { fail: true } }])
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, broken: '1' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: '', truncated: false, logPath: '/operation.log' }
  })
  onTestFinished(() => { install.mockRestore() })
  const result = await manager.installBundle('broken')
  expect(result).toMatchObject({ application: 'failed', stage: 'enable', target: 'broken', bundle: 'broken', packageResult: { exitCode: 0 } })
  expect(install).toHaveBeenCalledOnce()
  expect((await manager.listBundles()).find(row => row.name === 'broken')).toMatchObject({ enabled: true, removable: true })
})

it('returns unchanged failures as warnings while toggling and removing another bundle', async () => {
  const { manager, dir, bundle, ctx } = await fixture()
  bundle('broken', [
    { id: 'broken', name: './plugin.mjs', config: { fail: true } },
    { id: 'missing', name: './missing.mjs' },
    { id: 'pending', name: './pending.mjs' },
  ])
  writeFileSync(join(dir, 'node_modules/broken/pending.mjs'), 'export const inject = ["unavailable"]; export function apply() {}')
  expect(await manager.setBundleEnabled('broken', true)).toMatchObject({ application: 'failed' })
  const brokenId = (await manager.listPlugins()).find(row => row.patchId === 'broken')!.entryId
  expect(await manager.setPluginEnabled(brokenId, true)).toMatchObject({ application: 'failed' })
  expect(await manager.setBundleEnabled('broken', true)).toMatchObject({ application: 'failed' })
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  const changed = await manager.setPluginEnabled(id, false)
  expect(changed).toMatchObject({ application: 'applied' })
  expect(changed.warnings).toHaveLength(3)
  expect(await manager.setPluginEnabled(id, true)).toMatchObject({ application: 'applied' })
  const remove = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    expect([...ctx.loader.entries()].some(row => row.id === 'include:managed')).toBe(false)
    const manifest = readProfileManifest('test', dir)
    delete manifest.dependencies?.extra
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: '', truncated: false, logPath: '/operation.log' }
  })
  onTestFinished(() => { remove.mockRestore() })
  const removed = await manager.removeBundle('extra')
  expect(removed.application).toBe('applied')
  expect(removed.warnings).toHaveLength(3)
  expect(remove).toHaveBeenCalledOnce()
})

it('reports repeated installs as requiring restart and ambiguous package changes as failures', async () => {
  const { manager, dir } = await fixture()
  const install = vi.spyOn(operations, 'runProfilePnpm').mockResolvedValue({ exitCode: 0, output: '', truncated: false, logPath: join(dir, 'pnpm.log') })
  onTestFinished(() => { install.mockRestore() })
  expect(await manager.installBundle('extra')).toMatchObject({ changed: false, application: 'restart-required' })
  expect(await manager.installBundle('extra@1')).toMatchObject({ changed: false, application: 'restart-required' })
  expect(await manager.installBundle('extra-long@1')).toMatchObject({ changed: false, application: 'failed', error: { code: 'ambiguous-install' } })
  install.mockImplementationOnce(async () => {
    writeFileSync(join(dir, 'package.json'), '{}')
    return { exitCode: 0, output: '', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  expect(await manager.installBundle('unknown')).toMatchObject({ changed: false, application: 'failed', error: { code: 'ambiguous-install' } })
  expect(readProfileManifest('test', dir).dependencies).toEqual({ extra: '1.0.0' })
})

it('streams pnpm output, reports the installation phases, and names the installed bundle', async () => {
  const { ctx, manager, dir, bundle } = await fixture()
  const chunks: PluginInstallLogChunk[] = []
  const phases: PluginInstallProgress[] = []
  const changes: PluginChange[] = []
  ctx.on('plugin-manager/install-log', (chunk) => { chunks.push(chunk) })
  ctx.on('plugin-manager/install-state', (progress) => { phases.push(progress) })
  ctx.on('plugin-manager/changed', (change) => { changes.push(change) })
  const install = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async (_context, args, options) => {
    options.onOutput?.('Progress: resolved 1\n', 'stdout')
    options.onOutput?.('warning\n', 'stderr')
    const name = String(args[1])
    bundle(name, [{ id: name, name: './plugin.mjs', config: { service: name } }])
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, [name]: '1.0.0' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: 'installed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  onTestFinished(() => { install.mockRestore() })
  const requestId = 'f2340b6d-40bb-46b7-8b94-217bdf5010bd' as PluginInstallRequestId
  expect(await manager.installBundle('streamed', { enabled: false, requestId })).toMatchObject({ application: 'applied', changed: true, bundle: 'streamed' })
  expect(install).toHaveBeenCalledWith(expect.objectContaining({ profile: 'test' }), ['add', 'streamed'],
    expect.objectContaining({ command: 'pnpm', execution: 'service' }))
  const jobId = chunks[0]?.jobId
  expect(chunks).toEqual([
    { requestId, jobId, argv: ['pnpm', 'add', 'streamed'], cwd: dir, stream: 'stdout', text: 'Progress: resolved 1\n' },
    { requestId, jobId, argv: ['pnpm', 'add', 'streamed'], cwd: dir, stream: 'stderr', text: 'warning\n' },
    { requestId, jobId, argv: ['pnpm', 'add', 'streamed'], cwd: dir, stream: 'stdout', text: '', exitCode: 0 },
  ])
  expect(phases).toEqual([{ requestId, phase: 'installing', attempt: { registry: null, index: 1, total: 2 } }, { requestId, phase: 'applying' }])
  expect(changes).toEqual([{ reason: 'install' }])
  // A run without a request id streams too, unidentified.
  await manager.removeBundle('streamed')
  expect(chunks.at(-1)).toMatchObject({ argv: ['pnpm', 'remove', 'streamed'], stream: 'stdout', exitCode: 0 })
  expect(chunks.at(-1)).not.toHaveProperty('requestId')
  expect(changes).toEqual([{ reason: 'install' }, { reason: 'remove' }])
})

it('stops a run on request, restores the files, and answers not-running or too-late otherwise', async () => {
  const { ctx, manager, dir, bundle } = await fixture()
  const phases: PluginInstallProgress[] = []
  ctx.on('plugin-manager/install-state', (progress) => { phases.push(progress) })
  const started = Promise.withResolvers<undefined>()
  const install = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async (_context, _args, options) => {
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, slow: '1' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    started.resolve(undefined)
    await new Promise<undefined>((resolve) => { options.signal?.addEventListener('abort', () => { resolve(undefined) }, { once: true }) })
    return { exitCode: 1, output: 'killed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  onTestFinished(() => { install.mockRestore() })
  const requestId = 'f2340b6d-40bb-46b7-8b94-217bdf5010bd' as PluginInstallRequestId
  const before = readFileSync(join(dir, 'package.json'), 'utf8')
  const run = manager.installBundle('slow', { requestId })
  await started.promise
  const recoveredCancellation = manager.waitForInstall(requestId)
  expect(await manager.waitForInstall('missing' as PluginInstallRequestId)).toBeNull()
  expect(await manager.cancelInstall('00000000-0000-4000-8000-000000000000' as PluginInstallRequestId)).toEqual({ status: 'not-running' })
  expect(await manager.cancelInstall(requestId)).toEqual({ status: 'cancelled' })
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
  const cancelled = await run
  expect(await recoveredCancellation).toEqual(cancelled)
  expect(await manager.waitForInstall(requestId)).toBeNull()
  expect(cancelled).toMatchObject({ application: 'cancelled', changed: false, stage: 'install', packageResult: { exitCode: 1 } })
  expect(cancelled.error).toBeUndefined()
  expect(phases).toEqual([{ requestId, phase: 'installing', attempt: { registry: null, index: 1, total: 2 } }, { requestId, phase: 'cancelling' }])
  expect(await manager.cancelInstall(requestId)).toEqual({ status: 'not-running' })
  // Once pnpm has exited and the bundle is being applied, the run cannot be stopped.
  install.mockImplementation(async (_context, args) => {
    const name = String(args[1])
    bundle(name, [{ id: name, name: './plugin.mjs', config: { service: name } }])
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, [name]: '1.0.0' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: 'installed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  let tooLate: Promise<unknown> | undefined
  let recoveredApplication: Promise<unknown> | undefined
  ctx.on('plugin-manager/install-state', (progress) => {
    if (progress.phase !== 'applying') return
    tooLate = manager.cancelInstall(progress.requestId)
    recoveredApplication = manager.waitForInstall(progress.requestId)
  })
  expect(await manager.installBundle('late', { requestId })).toMatchObject({ application: 'applied', bundle: 'late' })
  expect(await tooLate).toEqual({ status: 'too-late' })
  expect(await recoveredApplication).toMatchObject({ application: 'applied', bundle: 'late' })
  // A request aborted before its turn under the lock never starts pnpm.
  const early = manager.installBundle('never', { requestId })
  const queued = manager.installBundle('after', { requestId: '11111111-1111-4111-8111-111111111111' as PluginInstallRequestId })
  expect(await manager.cancelInstall('11111111-1111-4111-8111-111111111111' as PluginInstallRequestId)).toEqual({ status: 'cancelled' })
  await early
  expect(await queued).toMatchObject({ application: 'cancelled', changed: false })
})

it('reads what a spec names before installing it', async () => {
  const { manager, dir, profile } = await fixture(undefined, false, undefined, { inspectTimeoutMs: 1000, pnpmCommand: 'pnpm-test', fallbackRegistries: [] })
  const view = vi.spyOn(operations, 'viewProfilePackage')
  onTestFinished(() => { view.mockRestore() })
  const answers = (stdout: string) => view.mockResolvedValueOnce({ exitCode: 0, stdout, stderr: '', timedOut: false })
  answers(JSON.stringify({ name: 'dsh-x', version: '1.4.2', description: 'A sidebar.', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  expect(await manager.inspect('dsh-x')).toEqual({
    status: 'accepted', kind: 'registry', name: 'dsh-x', version: '1.4.2', description: 'A sidebar.', bundle: true, registry: null,
  })
  expect(view).toHaveBeenCalledWith(dir, 'dsh-x', { command: 'pnpm-test', timeoutMs: 1000, registry: null })
  const signal = AbortSignal.abort()
  answers(JSON.stringify([{ name: 'dsh-lib', version: '1.0.0', dsh: { bundle: {} } }, { name: 'dsh-lib', version: '1.1.0', dsh: null }]))
  expect(await manager.inspect('dsh-lib@^1', undefined, signal)).toEqual({ status: 'refused', problem: 'not-a-bundle', reason: 'dsh-lib declares no dsh.bundle', registries: [null] })
  expect(view).toHaveBeenLastCalledWith(dir, 'dsh-lib@^1', { command: 'pnpm-test', timeoutMs: 1000, signal, registry: null })
  // An answer that names no package keeps the name the spec gave; colour escapes around the JSON are dropped.
  answers('\x1b[36m' + JSON.stringify({ version: '0.0.1', description: '', dsh: { bundle: { patch: './p.yml' } } }) + '\x1b[39m\n')
  expect(await manager.inspect('dsh-bare')).toEqual({ status: 'accepted', kind: 'registry', name: 'dsh-bare', version: '0.0.1', bundle: true, registry: null })
  const failure = (stderr: string, exitCode: number | null = 1, more: Partial<operations.PackageViewResult> = {}) =>
    view.mockResolvedValueOnce({ exitCode, stdout: '', stderr, timedOut: false, ...more })
  failure('npm error code E404\nnpm error 404 Not Found - GET https://registry/nope\n')
  expect(await manager.inspect('nope')).toMatchObject({ status: 'refused', problem: 'not-found', reason: expect.stringContaining('E404') as string })
  failure('ERR_PNPM_NO_MATCHING_VERSION  No matching version found for old@9\n')
  expect(await manager.inspect('old@9')).toMatchObject({ status: 'refused', problem: 'not-found' })
  failure('ERR_PNPM_META_FETCH_FAIL  request failed, reason: getaddrinfo ENOTFOUND registry\n')
  expect(await manager.inspect('far')).toMatchObject({ status: 'refused', problem: 'network' })
  view.mockResolvedValueOnce({ exitCode: 3, stdout: 'plain text\n', stderr: '', timedOut: false })
  expect(await manager.inspect('odd')).toEqual({ status: 'refused', problem: 'unknown', reason: 'plain text', registries: [null] })
  failure('', 4)
  expect(await manager.inspect('quiet')).toEqual({ status: 'refused', problem: 'unknown', reason: 'pnpm view exited with 4', registries: [null] })
  failure('', null, { timedOut: true })
  // A registry that never answered within the bound is unreachable.
  expect(await manager.inspect('slow')).toEqual({ status: 'refused', problem: 'network', reason: 'pnpm view timed out after 1000ms', registries: [null] })
  failure('', null, { cause: Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' }) })
  expect(await manager.inspect('gone')).toMatchObject({ status: 'refused', problem: 'unknown', reason: expect.stringContaining('ENOENT') as string })
  answers('not json')
  expect(await manager.inspect('garbled')).toMatchObject({ status: 'refused', problem: 'unknown', reason: expect.stringContaining('unreadable pnpm view output') as string })
  answers('"just a string"')
  expect(await manager.inspect('scalar')).toEqual({ status: 'refused', problem: 'unknown', reason: 'pnpm view answered no package', registries: [null] })
  answers('')
  expect(await manager.inspect('silent')).toEqual({ status: 'refused', problem: 'unknown', reason: 'pnpm view answered no package', registries: [null] })
  // What is installed, or supplied by the installation, is refused before the registry is asked.
  expect(await manager.inspect('extra')).toEqual({ status: 'refused', problem: 'already-installed', reason: 'extra is already installed' })
  expect(await manager.inspect('./relative')).toEqual({ status: 'refused', problem: 'invalid-spec', reason: 'a local path must be absolute' })
  expect(await manager.inspect('github:acme/dsh-remote')).toEqual({ status: 'accepted', kind: 'git', bundle: null, registry: null, host: 'github.com' })
  const tarball = join(profile.home, 'pack.tgz')
  expect(await manager.inspect(tarball)).toEqual({ status: 'refused', problem: 'not-a-package', reason: 'the tarball does not exist' })
  writeFileSync(tarball, '')
  expect(await manager.inspect(tarball)).toEqual({ status: 'accepted', kind: 'tarball', bundle: null, registry: null })
  expect(await manager.inspect('https://cdn.example.com/x/y/z/dsh-x-1.0.0.tgz')).toEqual({ status: 'accepted', kind: 'tarball', bundle: null, registry: null, host: 'cdn.example.com' })
  // A directory answers from its own manifest.
  const local = join(profile.home, 'dev', 'dsh-local')
  mkdirSync(local, { recursive: true })
  expect(await manager.inspect(join(profile.home, 'dev', 'missing'))).toEqual({ status: 'refused', problem: 'not-a-package', reason: 'the path does not exist' })
  expect(await manager.inspect(local)).toMatchObject({ status: 'refused', problem: 'not-a-package', reason: expect.stringContaining('no readable package.json') as string })
  writeFileSync(join(local, 'package.json'), '{"version":"1.0.0"}')
  expect(await manager.inspect(local)).toEqual({ status: 'refused', problem: 'not-a-package', reason: 'the package.json names no package' })
  writeFileSync(join(local, 'package.json'), JSON.stringify({ name: 'dsh-local', version: '0.1.0', description: 'Local.' }))
  expect(await manager.inspect(local)).toEqual({ status: 'refused', problem: 'not-a-bundle', reason: 'dsh-local declares no dsh.bundle' })
  writeFileSync(join(local, 'package.json'), JSON.stringify({ name: 'dsh-local', version: '0.1.0', description: 'Local.', dsh: { bundle: { patch: './p.yml' } } }))
  expect(await manager.inspect(`file:${local}`)).toEqual({ status: 'accepted', kind: 'path', name: 'dsh-local', version: '0.1.0', description: 'Local.', bundle: true, registry: null })
  writeFileSync(join(local, 'package.json'), JSON.stringify({ name: 'core', dsh: { bundle: { patch: './p.yml' } } }))
  expect(await manager.inspect(local)).toEqual({ status: 'refused', problem: 'already-installed', reason: 'core is already installed' })
  // A profile and an installation that list nothing know nothing.
  writeFileSync(join(dir, 'package.json'), '{}')
  writeFileSync(profile.installAnchor, '{}')
  expect(await manager.inspect(local)).toEqual({ status: 'accepted', kind: 'path', name: 'core', bundle: true, registry: null })
  expect(view).toHaveBeenCalledTimes(13)
})

it('announces each manager operation as a change, and a patch generation applied outside it not at all', async () => {
  const { ctx, manager, profile } = await fixture('startup')
  const changes: PluginChange[] = []
  ctx.on('plugin-manager/changed', (change) => { changes.push(change) })
  await reconcileProfilePatches(ctx, readProfilePatches('test', profile), 'test')
  expect(changes).toEqual([])
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  await manager.setPluginEnabled(id, false)
  expect(changes).toEqual([{ reason: 'plugin' }])
  await manager.setBundleEnabled('extra', false)
  expect(changes).toEqual([{ reason: 'plugin' }, { reason: 'bundle' }])
})

it('handles missing patch files and retains non-Error package diagnostics', async () => {
  const { manager, dir } = await fixture()
  rmSync(join(dir, 'cordis.patch.yml'))
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  expect(await manager.setPluginEnabled(id, false)).toMatchObject({ changed: true, application: 'applied' })
  const install = vi.spyOn(operations, 'runProfilePnpm').mockRejectedValueOnce('pnpm rejected operation')
  onTestFinished(() => { install.mockRestore() })
  expect(await manager.installBundle('new')).toMatchObject({ changed: false, application: 'failed', error: { code: 'operation-error', diagnostic: 'pnpm rejected operation' } })
  rmSync(join(dir, 'cordis.patch.yml'))
  mkdirSync(join(dir, 'cordis.patch.yml'))
  await expect(manager.setPluginEnabled(id, true)).rejects.toThrow()
})

it('applies a manager change through the active HMR service', async () => {
  const { manager } = await fixture()
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  expect(await manager.setPluginEnabled(id, false)).toMatchObject({ changed: true, application: 'applied' })
  expect((await manager.listPlugins()).find(row => row.entryId === id)?.enabled).toBe(false)
})

it('refuses removal of a hot-installed bundle after HMR is disabled', async () => {
  const { ctx, manager, dir, bundle, stopHmr } = await fixture()
  bundle('later', [{ id: 'later', name: './plugin.mjs', config: { service: 'laterProbe' } }])
  const manifest = readProfileManifest('test', dir)
  manifest.dependencies = { ...manifest.dependencies, later: '1' }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  expect(await manager.setBundleEnabled('later', true)).toMatchObject({ application: 'applied' })
  await stopHmr()
  expect(ctx.get('hmr')).toBeUndefined()
  expect(await manager.setBundleEnabled('later', false)).toMatchObject({ application: 'restart-required' })
  expect(ctx.get('laterProbe')).toBe(true)
  expect(await manager.removeBundle('later')).toMatchObject({ changed: false, application: 'failed' })
})

it('offers the launcher\'s optional bundles switched off and never removable', async () => {
  const { manager, profile } = await fixture()
  // The launcher names the bundles the installation ships; the fixture supplies one of them from the
  // installation's own node_modules, which the resolver consults before the profile's and before the repository's.
  const offered = OPTIONAL_BUNDLES[0]!
  const supplied = join(profile.home, 'node_modules', offered)
  mkdirSync(supplied, { recursive: true })
  writeFileSync(join(supplied, 'package.json'), JSON.stringify({
    name: offered, version: '3.0.0', description: 'Package one-liner.', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(supplied, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'offered-row', name: './plugin.mjs', config: { service: 'offeredProbe' } }] }]))
  writeFileSync(join(supplied, 'plugin.mjs'), 'export function apply(ctx, config) { ctx.provide(config?.service ?? "offeredProbe", true) }\n')
  writeFileSync(profile.installAnchor, JSON.stringify({ name: 'installation', dependencies: { [offered]: '3.0.0' } }))
  expect((await manager.listBundles()).find(row => row.name === offered)).toEqual({
    name: offered, version: '3.0.0', description: 'Package one-liner.',
    meta: { title: offered, description: 'Package one-liner.' },
    enabled: false, installed: false, optional: true, removable: false,
    rows: [{ rowId: 'offered-row', moduleName: pathToFileURL(join(supplied, 'plugin.mjs')).href }], overrides: [],
  })
  expect(await manager.setBundleEnabled(offered, true)).toMatchObject({ application: 'applied' })
  expect((await manager.listBundles()).find(row => row.name === offered)).toMatchObject({ enabled: true, optional: true, removable: false })
  expect(await manager.removeBundle(offered)).toMatchObject({ changed: false, application: 'failed' })
})

it('omits installation-owned plain packages from the bundle inventory', async () => {
  const { manager, dir, profile, bundle } = await fixture()
  bundle('installation-plain', [])
  writeFileSync(join(dir, 'node_modules/installation-plain/package.json'), '{"name":"installation-plain"}')
  writeFileSync(profile.installAnchor, '{"dependencies":{"installation-plain":"1"}}')
  expect((await manager.listBundles()).some(row => row.name === 'installation-plain')).toBe(false)
})

it('does not delete a bundle retained by a higher-priority overlay', async () => {
  const { ctx, manager, overlays, dir } = await fixture()
  const entry = [...ctx.loader.entries()].find(row => row.id === 'include:managed')!
  overlays.push({ insert: [{ ...entry.options }] })
  const remove = vi.spyOn(operations, 'runProfilePnpm')
  onTestFinished(() => { remove.mockRestore() })
  expect(await manager.removeBundle('extra')).toMatchObject({ changed: true, application: 'failed', error: { code: 'bundle-in-use' } })
  expect(await manager.removeBundle('extra')).toMatchObject({ changed: false, application: 'failed', error: { code: 'bundle-in-use' } })
  expect(remove).not.toHaveBeenCalled()
  expect(readProfileManifest('test', dir).dependencies).toEqual({ extra: '1.0.0' })
  expect(ctx.get('managedProbe')).toBe(true)
})

it('applies watched configuration while pnpm installation is still running', async () => {
  const { ctx, manager, dir, profile, bundle } = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const pnpm = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    entered.resolve(undefined)
    await release.promise
    bundle('new-bundle', [])
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, 'new-bundle': '1.0.0' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: 'installed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  const installing = manager.installBundle('new-bundle')
  onTestFinished(async () => { release.resolve(undefined); await installing; pnpm.mockRestore() })
  await entered.promise
  writeFileSync(profile.patchPath, '- id: managed\n  disabled: true\n')
  await vi.waitFor(() => { expect(ctx.get('managedProbe')).toBeUndefined() }, { timeout: 10000 })
  expect(pnpm).toHaveBeenCalledOnce()
  release.resolve(undefined)
  expect(await installing).toMatchObject({ application: 'applied', changed: true })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['core', 'extra', 'new-bundle'])
  expect(ctx.get('managedProbe')).toBeUndefined()
})

it('installs and removes with the bundled pnpm when PATH contains no pnpm', async () => {
  const pnpm = fileURLToPath(new URL('../../../../apps/desktop/node_modules/pnpm/bin/pnpm.mjs', import.meta.url))
  const { manager, dir } = await fixture('startup', false, undefined, { pnpmCommand: 'must-not-be-used' }, {
    command: process.execPath, args: ['--expose-internals', pnpm], env: { PATH: '', ELECTRON_RUN_AS_NODE: '1' },
  })
  const target = join(dir, 'local-bundle')
  mkdirSync(target)
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: '@test/desktop-manager', version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(target, 'cordis.patch.yml'), '[]\n')
  // Fixture-only packages need no registry resolution during this local install.
  const manifest = readProfileManifest('test', dir)
  delete manifest.dependencies
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  const installed = await manager.installBundle(target)
  expect(installed.error).toBeUndefined()
  expect(installed.packageResult?.exitCode).toBe(0)
  expect(readProfileManifest('test', dir).dependencies).toHaveProperty('@test/desktop-manager')
  const removed = await manager.removeBundle('@test/desktop-manager')
  expect(removed.error).toBeUndefined()
  expect(removed.packageResult?.exitCode).toBe(0)
  expect(readProfileManifest('test', dir).dependencies ?? {}).not.toHaveProperty('@test/desktop-manager')
})

const MIRROR = 'https://registry.npmmirror.com/'
const OFFICIAL = 'https://registry.npmjs.org/'

/** What pnpm's own configuration names in the profile, for the tests that need something other than npm's own registry. */
function pnpmNames(url: string | null = OFFICIAL) {
  return vi.spyOn(operations, 'readProfileRegistry').mockResolvedValue(url)
}

it('asks the registries in turn while one is unreachable or stale, and names the one that answered', async () => {
  const { manager, dir } = await fixture(undefined, false, undefined, { inspectTimeoutMs: 1000, fallbackRegistries: ['https://REGISTRY.npmmirror.com'] })
  const read = pnpmNames()
  const view = vi.spyOn(operations, 'viewProfilePackage')
  onTestFinished(() => { view.mockRestore() })
  const failure = (stderr: string, exitCode = 1) => view.mockResolvedValueOnce({ exitCode, stdout: '', stderr, timedOut: false })
  const answers = (stdout: string) => view.mockResolvedValueOnce({ exitCode: 0, stdout, stderr: '', timedOut: false })
  const asked = (from: number) => view.mock.calls.slice(from).map(call => call[2].registry)
  const manifest = JSON.stringify({ name: 'dsh-x', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } })
  // pnpm's own registry is unreachable; the mirror answers and the install is told to start there.
  failure('ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/dsh-x: ETIMEDOUT\n')
  answers(manifest)
  expect(await manager.inspect('dsh-x')).toEqual({ status: 'accepted', kind: 'registry', name: 'dsh-x', version: '1.0.0', bundle: true, registry: MIRROR })
  expect(asked(0)).toEqual([null, MIRROR])
  expect(read).toHaveBeenCalledWith(dir, { command: 'pnpm', timeoutMs: 1000 })
  expect(view).toHaveBeenLastCalledWith(expect.any(String), 'dsh-x', { command: 'pnpm', timeoutMs: 1000, registry: MIRROR })
  // pnpm prints a refusal as JSON on stdout with nothing on stderr: it is read the same way, and the reason is its message.
  view.mockResolvedValueOnce({ exitCode: 1, stdout: '{\n  "error": {\n    "code": "ERR_PNPM_META_FETCH_FAIL",\n    "message": "GET https://registry.npmjs.org/dsh-x: fetch failed"\n  }\n}\n', stderr: '', timedOut: false })
  answers(manifest)
  expect(await manager.inspect('dsh-x')).toMatchObject({ status: 'accepted', registry: MIRROR })
  expect(asked(2)).toEqual([null, MIRROR])
  // A requested registry goes first. A mirror's 404 may be a copy not yet synced, so the lookup goes on; every registry's 404 is not-found.
  view.mockResolvedValueOnce({ exitCode: 1, stdout: '{"error":{"code":"ERR_PNPM_FETCH_404","message":"GET https://registry.npmmirror.com/dsh-x: Not Found - 404"}}', stderr: '', timedOut: false })
  failure('ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/dsh-x: Not Found - 404\n')
  expect(await manager.inspect('dsh-x', { registry: MIRROR })).toMatchObject({
    status: 'refused', problem: 'not-found', reason: 'ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/dsh-x: Not Found - 404', registries: [MIRROR, null],
  })
  expect(asked(4)).toEqual([MIRROR, null])
  // A registry outside the configured set is asked alone.
  failure('ERR_PNPM_META_FETCH_FAIL  GET https://npm.corp.example/dsh-x: ECONNREFUSED\n')
  expect(await manager.inspect('dsh-x', { registry: 'https://npm.corp.example' })).toMatchObject({ status: 'refused', problem: 'network', registries: ['https://npm.corp.example/'] })
  expect(asked(6)).toEqual(['https://npm.corp.example/'])
  // A failure no registry changes ends the round at once.
  failure('', 4)
  expect(await manager.inspect('dsh-x')).toMatchObject({ status: 'refused', problem: 'unknown', registries: [null] })
  expect(asked(7)).toEqual([null])
  // A registry that never answered is unreachable, like one that refused the connection: the round goes on, and the
  // refusal is a network one.
  view.mockResolvedValueOnce({ exitCode: null, stdout: '', stderr: '', timedOut: true })
  view.mockResolvedValueOnce({ exitCode: null, stdout: '', stderr: '', timedOut: true })
  expect(await manager.inspect('dsh-x')).toEqual({ status: 'refused', problem: 'network', reason: 'pnpm view timed out after 1000ms', registries: [null, MIRROR] })
  expect(asked(8)).toEqual([null, MIRROR])
  // A lookup the caller dropped is not carried to the next registry.
  const controller = new AbortController()
  view.mockImplementationOnce(async () => { controller.abort(); return { exitCode: 1, stdout: '', stderr: 'ECONNRESET\n', timedOut: false } })
  expect(await manager.inspect('dsh-x', {}, controller.signal)).toMatchObject({ status: 'refused', problem: 'network', registries: [null] })
  expect(asked(10)).toEqual([null])
  // The other forms ask no registry and carry the one the install starts with.
  expect(await manager.inspect('github:acme/dsh-remote', { registry: MIRROR })).toEqual({ status: 'accepted', kind: 'git', bundle: null, registry: MIRROR, host: 'github.com' })
  expect(await manager.inspect('github:acme/dsh-remote')).toEqual({ status: 'accepted', kind: 'git', bundle: null, registry: null, host: 'github.com' })
  expect(view).toHaveBeenCalledTimes(11)
})

it('keeps pnpm\'s own registry alone when it names a private one, or cannot be read', async () => {
  const { manager } = await fixture(undefined, false, undefined, { inspectTimeoutMs: 1000 })
  const read = pnpmNames('https://npm.corp.example/')
  const view = vi.spyOn(operations, 'viewProfilePackage')
  onTestFinished(() => { view.mockRestore() })
  view.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'ERR_PNPM_META_FETCH_FAIL  GET https://npm.corp.example/dsh-x: ETIMEDOUT\n', timedOut: false })
  expect(await manager.inspect('dsh-x')).toMatchObject({ status: 'refused', problem: 'network', registries: [null] })
  expect(await manager.inspect('dsh-x', { registry: MIRROR })).toMatchObject({ status: 'refused', problem: 'network', registries: [MIRROR] })
  read.mockResolvedValue(null)
  expect(await manager.inspect('dsh-x')).toMatchObject({ status: 'refused', problem: 'network', registries: [null] })
  expect(await manager.registries()).toEqual({ registry: null, fallbackRegistries: [MIRROR], resolved: null })
  expect(view).toHaveBeenCalledTimes(3)
})

it('installs from the next registry after one is unreachable, restoring the files between attempts', async () => {
  const { ctx, manager, dir, bundle } = await fixture()
  const phases: PluginInstallProgress[] = []
  const chunks: PluginInstallLogChunk[] = []
  ctx.on('plugin-manager/install-state', (progress) => { phases.push(progress) })
  ctx.on('plugin-manager/install-log', (chunk) => { chunks.push(chunk) })
  const lockPath = join(dir, 'pnpm-lock.yaml')
  const install = vi.spyOn(operations, 'runProfilePnpm')
    .mockImplementationOnce(async () => {
      writeFileSync(lockPath, 'partial lockfile\n')
      return { exitCode: 1, output: 'ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/fallen: ETIMEDOUT', truncated: false, logPath: join(dir, 'pnpm.log') }
    })
    .mockImplementationOnce(async (_context, args) => {
      // The failed attempt's lockfile is gone before the next registry is asked.
      expect(existsSync(lockPath)).toBe(false)
      const name = String(args[1])
      bundle(name, [{ id: name, name: './plugin.mjs', config: { service: name } }])
      const manifest = readProfileManifest('test', dir)
      manifest.dependencies = { ...manifest.dependencies, [name]: '1.0.0' }
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
      return { exitCode: 0, output: 'installed', truncated: false, logPath: join(dir, 'pnpm.log') }
    })
  onTestFinished(() => { install.mockRestore() })
  const requestId = 'f2340b6d-40bb-46b7-8b94-217bdf5010bd' as PluginInstallRequestId
  const result = await manager.installBundle('fallen', { enabled: false, requestId })
  expect(result).toMatchObject({ application: 'applied', bundle: 'fallen', registries: [null, MIRROR], packageResult: { exitCode: 0 } })
  expect(result.failedAt).toBeUndefined()
  expect(install.mock.calls.map(call => call[1])).toEqual([['add', 'fallen'], ['add', 'fallen', `--registry=${MIRROR}`]])
  expect(phases).toEqual([
    { requestId, phase: 'installing', attempt: { registry: null, index: 1, total: 2 } },
    { requestId, phase: 'installing', attempt: { registry: MIRROR, index: 2, total: 2 } },
    { requestId, phase: 'applying' },
  ])
  // Each attempt streams as its own run, the command line naming the registry it asked.
  expect(new Set(chunks.map(chunk => chunk.jobId)).size).toBe(2)
  expect(chunks.at(-1)).toMatchObject({ requestId, argv: ['pnpm', 'add', 'fallen', `--registry=${MIRROR}`], exitCode: 0 })
})

it('does not ask the next registry after the manager terminated a silent run', async () => {
  const { manager } = await fixture()
  const install = vi.spyOn(operations, 'runProfilePnpm').mockResolvedValue({
    exitCode: 1, output: 'installing\ndsh: pnpm printed nothing for 600000ms and was terminated\n',
    truncated: false, logPath: '/dev/null', timedOut: true,
  })
  onTestFinished(() => { install.mockRestore() })
  const stalled = await manager.installBundle('silent')
  expect(stalled).toMatchObject({ application: 'failed', registries: [null], packageResult: { kind: 'timeout', timedOut: true } })
  expect(stalled.failedAt).toBeUndefined()
  expect(install).toHaveBeenCalledTimes(1)
})

it('drops the earlier registry failure once a later attempt is terminated for silence', async () => {
  const { manager } = await fixture()
  const install = vi.spyOn(operations, 'runProfilePnpm')
    .mockResolvedValueOnce({
      exitCode: 1, output: 'ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/flaky: ETIMEDOUT',
      truncated: false, logPath: '/dev/null',
    })
    .mockResolvedValueOnce({
      exitCode: 1, output: 'installing\ndsh: pnpm printed nothing for 600000ms and was terminated\n',
      truncated: false, logPath: '/dev/null', timedOut: true,
    })
  onTestFinished(() => { install.mockRestore() })
  const stalled = await manager.installBundle('flaky')
  expect(stalled).toMatchObject({ application: 'failed', registries: [null, MIRROR], packageResult: { kind: 'timeout', timedOut: true } })
  expect(stalled.failedAt).toBeUndefined()
  expect(install).toHaveBeenCalledTimes(2)
})

it('bounds each package run with the configured silence timeout', async () => {
  const { manager } = await fixture('live', false, undefined, { idleTimeoutMs: 1234 })
  const install = vi.spyOn(operations, 'runProfilePnpm')
    .mockResolvedValue({ exitCode: 1, output: 'plain failure', truncated: false, logPath: '/dev/null' })
  onTestFinished(() => { install.mockRestore() })
  await manager.installBundle('quiet')
  expect(install.mock.calls[0]?.[2]).toMatchObject({ idleTimeoutMs: 1234 })
})

it('stops at a failure no registry changes, at a host the spec itself is fetched from, and after a registry outside the configured set', async () => {
  const { manager } = await fixture()
  const failing = (output: string) => ({ exitCode: 1, output, truncated: false, logPath: '/dev/null' })
  const install = vi.spyOn(operations, 'runProfilePnpm').mockResolvedValue(failing('ERR_PNPM_IGNORED_BUILDS  Ignored build scripts: native'))
  onTestFinished(() => { install.mockRestore() })
  const blocked = await manager.installBundle('blocked')
  expect(blocked).toMatchObject({ application: 'failed', registries: [null], packageResult: { kind: 'build-blocked' } })
  expect(blocked.failedAt).toBeUndefined()
  expect(install).toHaveBeenCalledTimes(1)
  install.mockResolvedValue(failing('fatal: unable to access \'https://github.com/acme/dsh-x/\': Could not resolve host: github.com'))
  expect(await manager.installBundle('github:acme/dsh-x')).toMatchObject({ application: 'failed', registries: [null], failedAt: 'spec-host', packageResult: { kind: 'network' } })
  expect(install).toHaveBeenCalledTimes(2)
  install.mockResolvedValue(failing('ERR_PNPM_META_FETCH_FAIL  GET https://npm.corp.example/dsh-x: ECONNREFUSED'))
  expect(await manager.installBundle('dsh-x', { registry: 'https://npm.corp.example' })).toMatchObject({
    application: 'failed', registries: ['https://npm.corp.example/'], failedAt: 'registry', packageResult: { kind: 'network' },
  })
  expect(install).toHaveBeenCalledTimes(3)
  expect(install).toHaveBeenLastCalledWith(expect.anything(), ['add', 'dsh-x', '--registry=https://npm.corp.example/'], expect.anything())
  // Every configured registry unreachable: the failure is the last attempt's, and all of them are named.
  install.mockResolvedValue(failing('ERR_PNPM_META_FETCH_FAIL  GET https://registry/dsh-x: ETIMEDOUT'))
  expect(await manager.installBundle('dsh-x')).toMatchObject({ application: 'failed', registries: [null, MIRROR], failedAt: 'registry', packageResult: { kind: 'network' } })
  expect(install).toHaveBeenCalledTimes(5)
})

it('reports a stop that lands before a run starts, while the registries are read, as cancelled', async () => {
  const { manager } = await fixture()
  const requestId = 'f2340b6d-40bb-46b7-8b94-217bdf5010bd' as PluginInstallRequestId
  // The stop lands while the plan is being read: the run after it must not start on a dead signal.
  const read = vi.spyOn(operations, 'readProfileRegistry').mockImplementation(async () => {
    void manager.cancelInstall(requestId)
    await Promise.resolve()
    return OFFICIAL
  })
  const install = vi.spyOn(operations, 'runProfilePnpm')
  onTestFinished(() => { read.mockRestore(); install.mockRestore() })
  const result = await manager.installBundle('dsh-x', { requestId })
  expect(result).toMatchObject({ application: 'cancelled', registries: [] })
  expect(result.error).toBeUndefined()
  expect(install).not.toHaveBeenCalled()
})

it('answers the configured registries in pnpm\'s comparison form with what pnpm names, and refuses one that is not an http(s) URL at load', async () => {
  expect(await (await fixture()).manager.registries()).toEqual({ registry: null, fallbackRegistries: [MIRROR], resolved: OFFICIAL })
  const { manager } = await fixture(undefined, false, undefined, { registry: 'https://NPM.corp.example', fallbackRegistries: [] })
  expect(await manager.registries()).toEqual({ registry: 'https://npm.corp.example/', fallbackRegistries: [], resolved: OFFICIAL })
  expect(() => PluginManager.Config({ registry: 'npm.corp.example' })).toThrow()
  expect(() => PluginManager.Config({ fallbackRegistries: ['ftp://npm.corp.example/'] })).toThrow()
})

it.each(['live', 'startup'] as const)('requires exact risk acknowledgement and preserves exemptions in a %s profile', async (mode) => {
  const { manager, dir, ctx } = await fixture(mode, false, undefined, {}, undefined, (dir) => {
    const file = join(dir, 'node_modules', 'extra', 'package.json')
    const metadata = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    writeFileSync(file, JSON.stringify({ ...metadata, peerDependencies: { '@deepseek-ai/dsh': '999.0.0' } }))
  })
  const runtime = getDshRuntimeVersion()
  const managed = () => [...ctx.loader.entries()].find(entry => entry.id === 'include:managed')
  // The bundle's own peers are incompatible, so its whole layer is skipped and contributes no row.
  expect(managed()).toBeUndefined()
  expect((await manager.listBundles()).find(bundle => bundle.name === 'extra')?.error).toEqual({
    code: 'incompatible-version',
    incompatible: [{ name: 'extra', version: '1.0.0', runtimeVersion: runtime, peers: { '@deepseek-ai/dsh': '999.0.0' } }],
  })
  expect(await manager.setBundleEnabled('extra', true)).toMatchObject({ changed: false, application: 'failed' })
  expect(await manager.setVersionExemption('extra@1.0.0', runtime, true)).toMatchObject({ changed: false, application: 'failed' })
  expect(manager.listVersionExemptions()).toEqual({ exemptions: {}, warnings: [] })
  expect(existsSync(join(dir, 'compatibility.json'))).toBe(false)
  expect(await manager.setVersionExemption('extra@1.0.0', runtime, true, true)).toMatchObject({
    changed: true, application: mode === 'live' ? 'applied' : 'restart-required',
  })
  expect(manager.listVersionExemptions()).toEqual({ exemptions: { 'extra@1.0.0': [runtime] }, warnings: [] })
  // The grant is persisted only in the profile's compatibility file, never in its package manifest.
  expect(JSON.parse(readFileSync(join(dir, 'compatibility.json'), 'utf8'))).toEqual({ 'extra@1.0.0': [runtime] })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['core', 'extra'])
  // `setVersionExemption` reconciles the profile itself, so a live tree re-admits the bundle here;
  // no manifest watch or Loader instrumentation participates. A startup-only profile keeps it out until restart.
  if (mode === 'live') expect(managed()?.fiber?.state).toBe(2)
  else expect(managed()).toBeUndefined()
  expect(await manager.setVersionExemption('extra@1.0.0', runtime, false)).toMatchObject({ changed: true })
  expect(manager.listVersionExemptions()).toEqual({ exemptions: {}, warnings: [] })
  expect(JSON.parse(readFileSync(join(dir, 'compatibility.json'), 'utf8'))).toEqual({})
  if (mode === 'live') expect(managed()).toBeUndefined()
})

it('reports a package run refused for compatibility as a typed refusal', async () => {
  const { manager } = await fixture()
  const incompatible = [{ name: 'dsh-x', version: '2.0.0', runtimeVersion: getDshRuntimeVersion(), peers: { '@deepseek-ai/dsh': '999.0.0' } }]
  const install = vi.spyOn(operations, 'runProfilePnpm').mockResolvedValue({
    exitCode: 1, output: 'dsh: installation rejected', truncated: false, logPath: 'pnpm.log', kind: 'unknown', incompatible,
  })
  onTestFinished(() => { install.mockRestore() })
  const result = await manager.installBundle('dsh-x')
  expect(result).toMatchObject({ application: 'failed', changed: false, error: { code: 'incompatible-version', incompatible } })
  expect(install).toHaveBeenCalledTimes(1)
})

it.each([false, true])('rechecks installed bundle peers before accepting a disabled installation (exempted=%s)', async (exempted) => {
  const { manager, dir, bundle } = await fixture()
  if (exempted) await manager.setVersionExemption('incompatible@1.0.0', getDshRuntimeVersion(), true, true)
  const before = readFileSync(join(dir, 'package.json'), 'utf8')
  const install = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    bundle('incompatible', [])
    const file = join(dir, 'node_modules', 'incompatible', 'package.json')
    const metadata = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    writeFileSync(file, JSON.stringify({ ...metadata, peerDependencies: { '@deepseek-ai/dsh': '<0.0.0' } }))
    const profile = readProfileManifest('test', dir)
    profile.dependencies = { ...profile.dependencies, incompatible: '1.0.0' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(profile))
    return { exitCode: 0, output: 'installed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  onTestFinished(() => { install.mockRestore() })
  const result = await manager.installBundle('incompatible', { enabled: false })
  expect(result).toMatchObject({ application: exempted ? 'applied' : 'failed', changed: exempted })
  if (!exempted) {
    expect(result.error).toMatchObject({ code: 'incompatible-version', incompatible: [{ name: 'incompatible', version: '1.0.0' }] })
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
  }
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['core', 'extra'])
})
