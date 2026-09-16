/** Profile watches share HMR's queue and readiness barrier without waiting for package installation. */
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { boot, initProfile, readProfileManifest, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { FSWatcher } from 'chokidar'
import { expect, it, onTestFinished, vi } from 'vitest'
import Hmr from '../src/index.ts'

const watchers = vi.hoisted(() => [] as FSWatcher[])
vi.mock('chokidar', async (original) => {
  const native = await original<typeof import('chokidar')>()
  return { ...native, watch: () => {
    const watcher = new native.FSWatcher()
    watchers.push(watcher)
    queueMicrotask(() => watcher.emit('ready'))
    return watcher
  } }
})

async function fixture(beforeWatch?: (profile: ProfileContext) => void) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'hmr-profile-')))
  const dir = join(home, 'profiles', 'test')
  initProfile(dir, [])
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const profile: ProfileContext = {
    name: 'test', dir, patchPath: join(dir, 'cordis.patch.yml'), home, cwd: home,
    installAnchor: join(home, 'package.json'), startedBundles: [], overlays: [], telemetryDisabledEnv: undefined,
  }
  const rows = [{ insert: [
    { id: 'timer', name: 'cordis:timer' },
    { id: 'hmr', name: 'cordis:hmr', config: { root: [] } },
    { id: 'probe', name: 'cordis:probe', config: { value: 'initial' } },
  ] }]
  writeFileSync(profile.patchPath, JSON.stringify(rows))
  let commit: (() => void) | undefined
  const start = watchers.length
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (host) => {
    beforeWatch?.(profile)
    host.provide('profileContext', profile)
    host.provide('appReady', { onReady(listener) { commit = listener; return () => { commit = undefined } } })
    host.loader.builtins.timer = Timer
    host.loader.builtins.hmr = Hmr
    host.loader.builtins.probe = { apply(ctx: Context, config: { value: string }) { ctx.provide('profileProbe', config.value) } }
  })
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  const configWatches = watchers.slice(start, start + 3)
  const emit = (index: number, filename: string) => { configWatches[index]!.emit('change', filename) }
  const drain = () => ctx.hmr.runExclusive(async () => {})
  return { ctx, profile, dir, home, emit, drain, commit: () => commit?.() }
}

it('waits for application readiness and applies profile, home and manifest changes', async () => {
  const f = await fixture()
  const patches = [{ insert: [
    { id: 'timer', name: 'cordis:timer' }, { id: 'hmr', name: 'cordis:hmr', config: { root: [] } },
    { id: 'probe', name: 'cordis:probe', config: { value: 'edited' } },
  ] }]
  writeFileSync(f.profile.patchPath, JSON.stringify(patches))
  f.emit(0, f.profile.patchPath)
  let completed = false
  const drained = f.drain().then(() => { completed = true })
  await Promise.resolve(undefined)
  expect(completed).toBe(false)
  expect(f.ctx.get('profileProbe')).toBe('initial')
  f.commit()
  await drained
  expect(f.ctx.get('profileProbe')).toBe('edited')
  const homePatch = join(f.home, 'cordis.patch.yml')
  writeFileSync(homePatch, '- id: probe\n  config: { value: home }\n')
  f.emit(1, homePatch)
  await f.drain()
  expect(f.ctx.get('profileProbe')).toBe('home')
  rmSync(homePatch)
  const manifest = join(f.dir, 'package.json')
  f.emit(1, homePatch)
  await f.drain()
  expect(f.ctx.get('profileProbe')).toBe('edited')
  f.emit(2, manifest)
  await f.drain()
  expect(f.ctx.get('profileProbe')).toBe('edited')
})

it('applies configuration while a CLI operation holds the package writer lock', async () => {
  const f = await fixture()
  f.commit()
  await withFileLock(join(f.dir, 'package.json'), async () => {
    const original = readFileSync(f.profile.patchPath, 'utf8')
    writeFileSync(f.profile.patchPath, original.replace('initial', 'during-install'))
    f.emit(0, f.profile.patchPath)
    await f.drain()
    expect(f.ctx.get('profileProbe')).toBe('during-install')
  })
})

it('ignores dependency-only manifest changes and reloads a changed bundle list', async () => {
  const f = await fixture()
  f.commit()
  const include = [...f.ctx.loader.entries()].find(entry => entry.id === 'include')!
  const update = vi.spyOn(include, 'update')
  onTestFinished(() => { update.mockRestore() })
  const manifestPath = join(f.dir, 'package.json')
  const manifest = readProfileManifest('test', f.dir)
  manifest.dependencies = { added: '1.0.0' }
  delete manifest.dsh!.profile!.bundles
  writeFileSync(manifestPath, JSON.stringify(manifest))
  f.emit(2, manifestPath)
  await f.drain()
  expect(update).not.toHaveBeenCalled()
  const packageDir = join(f.dir, 'node_modules', 'added')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'added', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(packageDir, 'cordis.patch.yml'), '- insert:\n    - id: bundled\n      name: cordis:probe\n      disabled: true\n')
  manifest.dsh!.profile!.bundles = ['added']
  writeFileSync(manifestPath, JSON.stringify(manifest))
  f.emit(2, manifestPath)
  await f.drain()
  expect(update).toHaveBeenCalledOnce()
  f.emit(0, f.profile.patchPath)
  await f.drain()
  expect(update).toHaveBeenCalledOnce()
  expect([...f.ctx.loader.entries()].some(entry => entry.id === 'include:bundled')).toBe(true)
})

it('cancels queued reloads when the application exits before readiness', async () => {
  const f = await fixture()
  f.emit(0, f.profile.patchPath)
  await f.ctx.fiber.dispose()
  f.commit()
  expect(f.ctx.get('hmr')).toBeUndefined()
})

it('reports unreadable inputs and recovers after the file is corrected', async () => {
  const f = await fixture()
  f.commit()
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })
  const original = readFileSync(f.profile.patchPath, 'utf8')
  rmSync(f.profile.patchPath)
  mkdirSync(f.profile.patchPath)
  f.emit(0, f.profile.patchPath)
  await f.drain()
  expect(warn).toHaveBeenCalled()
  rmSync(f.profile.patchPath, { recursive: true })
  writeFileSync(f.profile.patchPath, original)
  f.emit(0, f.profile.patchPath)
  await f.drain()
  expect(readFileSync(f.profile.patchPath, 'utf8')).toBe(original)
})

it('rejects a profile launcher that omits application readiness', async () => {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(process.cwd() + '/').href
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(Loader)
  await ctx.plugin(Timer)
  ctx.provide('profileContext', {} as ProfileContext)
  await expect(ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })).rejects.toThrow('Profile HMR requires application readiness')
})

it('cancels a queued module notification when startup is interrupted', async () => {
  const f = await fixture()
  const queued = Promise.withResolvers<undefined>()
  const hmr = f.ctx.hmr
  const run = hmr.runExclusive.bind(hmr)
  vi.spyOn(hmr, 'runExclusive').mockImplementation((operation) => { queued.resolve(undefined); return run(operation) })
  watchers.at(-1)!.emit('change', 'pending.mjs')
  await queued.promise
  await f.ctx.fiber.dispose()
  expect(f.ctx.get('hmr')).toBeUndefined()
})

it('logs unchanged inactive entries while applying an unrelated file edit', async () => {
  const f = await fixture()
  f.commit()
  const warn = vi.spyOn(f.ctx.logger, 'warn').mockImplementation(() => {})
  onTestFinished(() => { warn.mockRestore() })
  const initial = readFileSync(f.profile.patchPath, 'utf8')
  const rows = JSON.parse(initial) as { insert: { id: string; name: string }[] }[]
  rows[0]!.insert.push({ id: 'missing', name: './missing.mjs' })
  writeFileSync(f.profile.patchPath, JSON.stringify(rows))
  f.emit(0, f.profile.patchPath)
  await f.drain()
  warn.mockClear()
  writeFileSync(f.profile.patchPath, JSON.stringify(rows).replace('initial', 'edited'))
  f.emit(0, f.profile.patchPath)
  await f.drain()
  expect(f.ctx.get('profileProbe')).toBe('edited')
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('missing ('))
})

it('applies a patch edited after boot parsing but before watcher registration', async () => {
  const f = await fixture((profile) => {
    const original = readFileSync(profile.patchPath, 'utf8')
    writeFileSync(profile.patchPath, original.replace('initial', 'edited-during-boot'))
  })
  expect(f.ctx.get('profileProbe')).toBe('initial')
  f.commit()
  f.emit(0, f.profile.patchPath)
  await f.drain()
  expect(f.ctx.get('profileProbe')).toBe('edited-during-boot')
})
