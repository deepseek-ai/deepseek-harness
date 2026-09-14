import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveDesktopPaths } from '../src/paths.ts'
import { DesktopProjectManager, packageNameFromSpec, type DesktopProjectHooks } from '../src/project-manager.ts'
import { runtimeFixture } from './runtime-fixture.ts'

const roots: string[] = []
const releaseWorkers: Array<() => Promise<void>> = []
function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-test-'))
  roots.push(root)
  return root
}
function writeFakePnpm(root: string): string {
  const path = join(root, 'pnpm.mjs')
  writeFileSync(path, `
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
const project = process.cwd()
const command = args.find(value => ['install', 'add', 'remove', 'rebuild'].includes(value))
appendFileSync(${JSON.stringify(join(root, 'pnpm-log.jsonl'))}, JSON.stringify({args, registry: process.env.NPM_CONFIG_REGISTRY}) + '\\n')
if (command !== 'rebuild') {
  const manifestPath = join(project, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (command === 'add') {
    const spec = args[args.indexOf(command) + 1]
    const index = spec.lastIndexOf('@')
    const name = index > 0 ? spec.slice(0, index) : spec
    manifest.dependencies[name] = index > 0 ? spec.slice(index + 1) : '1.0.0'
  }
  if (command === 'remove') delete manifest.dependencies[args[args.indexOf(command) + 1]]
  writeFileSync(manifestPath, JSON.stringify(manifest))
  rmSync(join(project, 'node_modules'), { recursive: true, force: true })
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    const packageRoot = join(project, 'node_modules', name)
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({name, version,
      peerDependencies: {'@deepseek-ai/cordis': '^1.0.0'}, dsh: {bundle: {patch: './bundle.yml'}}}))
    writeFileSync(join(packageRoot, 'bundle.yml'), '[]\\n')
  }
  writeFileSync(join(project, 'pnpm-lock.yaml'), JSON.stringify(manifest.dependencies))
}
`)
  return path
}
function hooks(overrides: Partial<DesktopProjectHooks> = {}): DesktopProjectHooks {
  return { beforeChange: async () => {}, afterChange: async () => {}, ...overrides }
}
function setup(): { root: string; manager: DesktopProjectManager } {
  const root = temporaryRoot()
  const dsh = join(root, 'resources', 'dsh')
  runtimeFixture(dsh)
  return { root, manager: new DesktopProjectManager(resolveDesktopPaths(join(root, '.dsh')), { node: process.execPath, pnpm: writeFakePnpm(root), dsh }) }
}
function calls(root: string): { args: string[]; registry: string }[] {
  const path = join(root, 'pnpm-log.jsonl')
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as { args: string[]; registry: string }) : []
}
afterEach(async () => {
  const cleanups = releaseWorkers.splice(0)
  const directories = roots.splice(0)
  const results = await Promise.allSettled(cleanups.map(cleanup => cleanup()))
  for (const root of directories) rmSync(root, { recursive: true, force: true })
  const failures: unknown[] = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length > 0) throw new AggregateError(failures, 'desktop worker cleanup failed')
})

describe('desktop external plugin profile', () => {
  it('reuses plugin files without scanning manifests and can disable or reset them', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    const manifest = join(manager.paths.profile, 'node_modules/plugin/package.json')
    writeFileSync(manifest, '{broken')
    await expect(manager.applyRelease()).resolves.toBe(false)
    await manager.mutate({ type: 'plugins-disable-all' }, hooks())
    await expect(manager.applyRelease()).resolves.toBe(false)
    expect(readFileSync(manifest, 'utf8')).toBe('{broken')
    await manager.resetConfiguration(hooks())
    expect(existsSync(manifest)).toBe(false)
    await expect(manager.applyRelease()).resolves.toBe(false)
  })

  it('disables every third-party bundle without reading a broken plugin patch declaration', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    const patch = join(manager.paths.profile, 'node_modules/plugin/bundle.yml')
    unlinkSync(patch)
    await manager.mutate({ type: 'plugins-disable-all' }, hooks({ afterChange: async () => {
      expect((JSON.parse(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8')) as {
        dsh: { profile: { bundles: string[] } }
      }).dsh.profile.bundles).not.toContain('plugin')
    } }))
    expect((JSON.parse(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }).dsh.profile.bundles).not.toContain('plugin')
    expect(existsSync(join(manager.paths.profile, 'node_modules/plugin/package.json'))).toBe(true)
    expect(calls(root)).toHaveLength(2)
    await expect(manager.applyRelease()).resolves.toBe(false)
  })

  it('resets the entire profile without backups while retaining its lock and shared data', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    const profile = manager.paths.profile
    expect(manager.paths.lock).toBe(join(profile, 'lock'))
    const task = join(root, '.dsh', 'task-sentinel')
    const homeEnvironment = join(root, '.dsh', '.env')
    writeFileSync(homeEnvironment, 'HOME_SETTING=retained')
    writeFileSync(task, 'retained task')
    writeFileSync(join(profile, 'desktop-runtime-state.json'), '{broken')
    writeFileSync(join(profile, 'cordis.patch.yml'), ': broken')
    writeFileSync(join(profile, '.env'), 'NODE_OPTIONS=--bad')
    mkdirSync(join(profile, '.extra'))
    writeFileSync(join(profile, '.extra', 'custom-file'), 'remove')
    const shared = join(root, 'shared-data')
    mkdirSync(shared)
    writeFileSync(join(shared, 'sentinel'), 'preserve')
    symlinkSync(shared, join(profile, 'external-link'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(manager.applyRelease()).rejects.toThrow()
    await manager.resetConfiguration(hooks({
      beforeChange: async () => { expect(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')).toBe(': broken') },
      afterChange: async () => {
        manager.assertProfileRuntime(profile)
        expect(readFileSync(manager.paths.lock, 'utf8').trim()).toBe(String(process.pid))
        await expect(manager.applyRelease()).rejects.toThrow('another package transaction is active')
      },
    }))
    expect(manager.listPlugins()).toEqual([])
    expect(existsSync(join(profile, 'node_modules/plugin'))).toBe(false)
    expect(existsSync(join(profile, 'cordis.patch.yml'))).toBe(false)
    expect(existsSync(join(profile, '.env'))).toBe(false)
    expect(existsSync(join(profile, '.extra'))).toBe(false)
    expect(existsSync(join(profile, 'external-link'))).toBe(false)
    expect(readFileSync(join(shared, 'sentinel'), 'utf8')).toBe('preserve')
    expect(readFileSync(task, 'utf8')).toBe('retained task')
    expect(readFileSync(homeEnvironment, 'utf8')).toBe('HOME_SETTING=retained')
    expect(readdirSync(profile).some(name => name.includes('backup'))).toBe(false)
    expect(calls(root)).toHaveLength(2)
    await expect(manager.applyRelease()).resolves.toBe(false)
    expect(existsSync(homeEnvironment)).toBe(true)
  })

  it('reports damaged application metadata as a reinstall failure', async () => {
    const { manager } = setup()
    writeFileSync(join(manager.runtime.dsh, 'desktop-runtime.json'), '{broken')
    await expect(manager.applyRelease()).rejects.toThrow()
    expect(manager.canRecoverProfile()).toBe(false)
  })

  it('accepts registry names and tags but rejects alternate sources and flags', () => {
    expect(packageNameFromSpec('@scope/plugin@1.2.3')).toBe('@scope/plugin')
    expect(packageNameFromSpec('plugin@next')).toBe('plugin')
    for (const spec of ['file:../plugin', '--registry=evil', 'https://example.test/plugin.tgz']) {
      expect(() => packageNameFromSpec(spec)).toThrow(/unsupported npm package spec/u)
    }
  })

  it('retries installation after an interrupted runtime rebuild removed plugin files', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    const dsh = join(root, 'new-node')
    runtimeFixture(dsh, '1.1.0', '24.18.0')
    const failing = join(root, 'fail-install.mjs')
    writeFileSync(failing, 'process.exitCode = 1')
    const worker = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh, pnpm: failing })
    await expect(worker.applyRelease()).rejects.toThrow('pnpm exited with 1')
    expect(existsSync(join(manager.paths.profile, 'node_modules/plugin'))).toBe(false)
    const retry = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh })
    await expect(retry.applyRelease()).resolves.toBe(true)
    expect(retry.listPlugins()).toEqual([{ name: 'plugin', version: '1.0.0', enabled: true }])
    await expect(retry.applyRelease()).resolves.toBe(false)
  })

  it('preserves unknown files when initializing a profile', async () => {
    const { manager } = setup()
    mkdirSync(manager.paths.profile, { recursive: true })
    writeFileSync(join(manager.paths.profile, '.DS_Store'), 'metadata')
    writeFileSync(join(manager.paths.profile, 'user-file'), 'retain')
    await expect(manager.applyRelease()).resolves.toBe(true)
    expect(readFileSync(join(manager.paths.profile, '.DS_Store'), 'utf8')).toBe('metadata')
    expect(readFileSync(join(manager.paths.profile, 'user-file'), 'utf8')).toBe('retain')
  })

  it.each(['plugin-add', 'runtime-change'] as const)('retries failed rebuild after %s across manager instances', async (operation) => {
    const { root, manager } = setup()
    await manager.applyRelease()
    let dsh = manager.runtime.dsh
    if (operation === 'runtime-change') {
      await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
      dsh = join(root, 'new-node')
      runtimeFixture(dsh, '1.1.0', '24.18.0')
    }
    const failing = join(root, 'fail-rebuild.mjs')
    writeFileSync(failing, `await import(${JSON.stringify(pathToFileURL(manager.runtime.pnpm).href)}); if (process.argv.includes('rebuild')) process.exitCode = 1`)
    const worker = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh, pnpm: failing })
    if (operation === 'plugin-add') {
      await worker.applyRelease()
      await expect(worker.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())).rejects.toThrow('pnpm exited with 1')
    } else await expect(worker.applyRelease()).rejects.toThrow('pnpm exited with 1')
    expect(() => { worker.assertProfileRuntime(worker.paths.profile) }).toThrow('package preparation is incomplete')
    const count = calls(root).length
    const retry = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh })
    await expect(retry.applyRelease()).resolves.toBe(true)
    expect(calls(root).slice(count).map(call => call.args.find(arg => !arg.startsWith('--config.')))).toEqual(['install', 'rebuild'])
    await expect(retry.applyRelease()).resolves.toBe(false)
    expect(calls(root)).toHaveLength(count + 2)
  })

  it('initializes and restarts offline without executing pnpm', async () => {
    const { root, manager } = setup()
    await expect(manager.applyRelease()).resolves.toBe(true)
    await expect(manager.applyRelease()).resolves.toBe(false)
    expect(manager.listPlugins()).toEqual([])
    expect(calls(root)).toEqual([])
    expect(existsSync(manager.paths.pnpm.store)).toBe(false)
    expect(realpathSync(join(manager.paths.profile, 'node_modules/@deepseek-ai/cordis'))).toBe(realpathSync(join(manager.runtime.dsh, 'node_modules/@deepseek-ai/cordis')))
    expect(JSON.parse(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8'))).toMatchObject({ dependencies: {} })
  })

  it('repairs a removed managed link without running pnpm', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    unlinkSync(join(manager.paths.profile, 'node_modules/@deepseek-ai/cordis'))
    await expect(manager.applyRelease()).resolves.toBe(true)
    expect(calls(root)).toEqual([])
  })

  it.skipIf(process.platform !== 'win32')('reuses the profile when the launch path changes only Windows letter casing', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    const relaunched = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh: manager.runtime.dsh.toUpperCase() })
    await expect(relaunched.applyRelease()).resolves.toBe(false)
  })

  it.each(['changed', 'same-size', 'extra', 'missing'])('starts and reuses a profile without checking %s runtime bytes', async (operation) => {
    const { root, manager } = setup()
    if (operation === 'changed') writeFileSync(join(manager.runtime.dsh, 'package.json'), '{}')
    if (operation === 'same-size') writeFileSync(join(manager.runtime.dsh, 'package.json'), '{"type":"Module"}\n')
    if (operation === 'extra') writeFileSync(join(manager.runtime.dsh, 'extra'), '')
    if (operation === 'missing') unlinkSync(join(manager.runtime.dsh, 'package.json'))
    await expect(manager.applyRelease()).resolves.toBe(true)
    const relaunched = new DesktopProjectManager(manager.paths, manager.runtime)
    await expect(relaunched.applyRelease()).resolves.toBe(false)
    expect(existsSync(manager.paths.profile)).toBe(true)
    expect(calls(root)).toEqual([])
  })

  it('installs only plugins and checks the graph before running lifecycle scripts', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: '@scope/plugin@2.0.0' }, hooks())
    expect(manager.listPlugins()).toEqual([{ name: '@scope/plugin', version: '2.0.0', enabled: true }])
    expect(calls(root).map(call => call.args.filter(arg => !arg.startsWith('--config.')))).toEqual([
      ['add', '@scope/plugin@2.0.0', '--save-exact', '--ignore-scripts'], ['rebuild', '--pending'],
    ])
    expect(calls(root).every(call => call.registry === 'https://registry.npmjs.org/')).toBe(true)
    expect(JSON.parse(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8'))).toMatchObject({ dependencies: { '@scope/plugin': '2.0.0' } })
    await expect(manager.mutate({ type: 'plugin-add', spec: '@deepseek-ai/cordis' }, hooks())).rejects.toThrow(/host-owned/u)
    await expect(manager.applyRelease()).resolves.toBe(false)
    expect(calls(root)).toHaveLength(2)
  })

  it('retains disabled plugin versions through updates and enables them explicitly', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    await manager.mutate({ type: 'plugins-disable-all' }, hooks())
    expect(calls(root)).toHaveLength(2)
    expect(manager.listPlugins()).toEqual([{ name: 'plugin', version: '1.0.0', enabled: false }])
    await manager.mutate({ type: 'plugin-update', name: 'plugin', version: '1.1.0' }, hooks())
    expect(manager.listPlugins()).toEqual([{ name: 'plugin', version: '1.1.0', enabled: false }])
    await manager.mutate({ type: 'plugin-toggle', name: 'plugin', enabled: true }, hooks())
    expect(manager.listPlugins()[0]?.enabled).toBe(true)
    await manager.mutate({ type: 'plugin-remove', name: 'plugin' }, hooks())
    expect(manager.listPlugins()).toEqual([])
  })

  it('keeps plugin files and patches through a compatible release and application relocation', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    writeFileSync(join(manager.paths.profile, 'cordis.patch.yml'), '[]\n')
    const nextRoot = join(root, 'relocated', 'dsh')
    runtimeFixture(nextRoot, '1.1.0')
    const next = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh: nextRoot })
    await expect(next.applyRelease()).resolves.toBe(true)
    expect(next.listPlugins()).toEqual(manager.listPlugins())
    expect(next.releaseVersion()).toBe('1.1.0')
    expect(readFileSync(join(manager.paths.profile, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
    expect(calls(root)).toHaveLength(2)
    expect(realpathSync(join(manager.paths.profile, 'node_modules/@deepseek-ai/cordis'))).toBe(realpathSync(join(nextRoot, 'node_modules/@deepseek-ai/cordis')))
    expect(readFileSync(join(manager.paths.profile, 'node_modules/plugin/bundle.yml'), 'utf8')).toBe('[]\n')
  })

  it('reinstalls the locked plugin graph when bundled Node changes', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    const dsh = join(root, 'new-node')
    runtimeFixture(dsh, '1.1.0', '24.18.0')
    const next = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh })
    await next.applyRelease()
    expect(calls(root).slice(2).map(call => call.args.filter(arg => !arg.startsWith('--config.')))).toEqual([
      ['install', '--frozen-lockfile', '--ignore-scripts'], ['rebuild', '--pending'],
    ])
    expect(next.listPlugins()).toEqual([{ name: 'plugin', version: '1.0.0', enabled: true }])
  })

  it('allows incompatible plugins to be disabled in recovery without deleting them', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    const dsh = join(root, 'next-major')
    runtimeFixture(dsh, '2.0.0')
    const next = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh })
    await expect(next.applyRelease()).rejects.toThrow(/requires @deepseek-ai\/cordis/u)
    expect(next.releaseVersion()).toBe('2.0.0')
    await next.mutate({ type: 'plugins-disable-all' }, hooks())
    expect(next.releaseVersion()).toBe('2.0.0')
    expect(next.listPlugins()).toEqual([{ name: 'plugin', version: '1.0.0', enabled: false }])
  })

  it.each(['before', 'after'] as const)('retains direct writes when the %s change hook fails', async (phase) => {
    const { manager } = setup()
    await manager.applyRelease()
    let starts = 0
    await expect(manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks({
      beforeChange: async () => {
        expect(manager.listPlugins()).toEqual([])
        if (phase === 'before') throw new Error('before failed')
      },
      afterChange: async () => { starts++; throw new Error('after failed') },
    }))).rejects.toThrow(`${phase} failed`)
    expect(manager.listPlugins()).toEqual(phase === 'before' ? [] : [{ name: 'plugin', version: '1.0.0', enabled: true }])
    expect(starts).toBe(phase === 'before' ? 0 : 1)
    expect(existsSync(join(manager.paths.root, 'staging'))).toBe(false)
    expect(existsSync(join(manager.paths.root, 'rollback'))).toBe(false)
    expect(existsSync(join(manager.paths.root, 'pending.json'))).toBe(false)
  })

  it('keeps partial package changes and restores host links after pnpm fails', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    const failingPnpm = join(root, 'failing.mjs')
    writeFileSync(failingPnpm, `await import(${JSON.stringify(pathToFileURL(manager.runtime.pnpm).href)}); process.exitCode = 1`)
    const worker = new DesktopProjectManager(manager.paths, { ...manager.runtime, pnpm: failingPnpm })
    await worker.applyRelease()
    let starts = 0
    await expect(worker.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks({
      afterChange: async () => { starts++ },
    }))).rejects.toThrow(/pnpm exited with 1/u)
    expect(worker.listPlugins()).toEqual([{ name: 'plugin', version: '1.0.0', enabled: false }])
    expect(starts).toBe(0)
    expect(existsSync(manager.paths.lock)).toBe(false)
    expect(realpathSync(join(manager.paths.profile, 'node_modules/@deepseek-ai/cordis')))
      .toBe(realpathSync(join(manager.runtime.dsh, 'node_modules/@deepseek-ai/cordis')))
    await manager.mutate({ type: 'plugin-remove', name: 'plugin' }, hooks())
    expect(manager.listPlugins()).toEqual([])
  })

  it('holds the transaction lock until the pnpm worker exits', async ({ task, signal }) => {
    const { root, manager } = setup()
    await manager.applyRelease()
    const ready = join(root, 'ready')
    const release = join(root, 'release')
    const blocker = join(root, 'blocking.mjs')
    writeFileSync(blocker, `import {existsSync, writeFileSync} from 'node:fs'; import {setTimeout as sleep} from 'node:timers/promises'; writeFileSync(${JSON.stringify(ready)}, String(process.pid)); while (!existsSync(${JSON.stringify(release)})) await sleep(10); await import(${JSON.stringify(pathToFileURL(manager.runtime.pnpm).href)})`)
    const worker = new DesktopProjectManager(manager.paths, { ...manager.runtime, pnpm: blocker })
    await worker.applyRelease()
    const pending = worker.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    // Teardown observes failures even if the runner has abandoned the test body.
    const completed = pending.then(value => ({ value }), (error: unknown) => ({ error }))
    releaseWorkers.push(async () => {
      writeFileSync(release, 'continue')
      const outcome = await completed
      if ('error' in outcome) throw outcome.error
    })
    try {
      // Child startup shares the test budget; an aborted poll must not resume ownership assertions.
      await expect.poll(() => {
        signal.throwIfAborted()
        return existsSync(ready)
      }, { timeout: task.timeout }).toBe(true)
      signal.throwIfAborted()
      expect(readFileSync(manager.paths.lock, 'utf8').trim()).toBe(readFileSync(ready, 'utf8'))
      await expect(manager.applyRelease()).rejects.toThrow(/another package transaction/u)
    } finally {
      writeFileSync(release, 'continue')
      await pending
    }
    expect(existsSync(manager.paths.lock)).toBe(false)
  })
})
