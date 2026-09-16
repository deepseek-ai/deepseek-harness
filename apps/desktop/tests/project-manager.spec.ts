import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDesktopPaths } from '../src/paths.ts'
import { DesktopProjectManager, type DesktopProjectHooks } from '../src/project-manager.ts'
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
appendFileSync(${JSON.stringify(join(root, 'pnpm-log.jsonl'))}, JSON.stringify({args, registry: process.env.NPM_CONFIG_REGISTRY, userconfig: process.env.NPM_CONFIG_USERCONFIG, pnpmHome: process.env.PNPM_HOME, configHome: process.env.XDG_CONFIG_HOME}) + '\\n')
if (command !== 'rebuild') {
  const manifestPath = join(project, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (command === 'add') {
    const spec = args.includes('--') ? args[args.indexOf('--') + 1] : args[args.indexOf(command) + 1]
    const index = spec.lastIndexOf('@')
    const name = index > 0 ? spec.slice(0, index) : spec
    manifest.dependencies[name] = index > 0 ? spec.slice(index + 1) : '1.0.0'
  }
  if (command === 'remove') delete manifest.dependencies[args[args.indexOf('--') + 1]]
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
  vi.unstubAllEnvs()
  const failures: unknown[] = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length > 0) throw new AggregateError(failures, 'desktop worker cleanup failed')
})

describe('desktop external plugin profile', () => {
  it('cleans application packages only when preparing a production launch', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    const name = '@deepseek-ai/dsh-web-app'
    const path = join(manager.paths.profile, 'node_modules', name)
    mkdirSync(path, { recursive: true })
    await manager.applyRelease()
    expect(existsSync(path)).toBe(true)
    await manager.applyRelease(true)
    expect(existsSync(path)).toBe(false)
  })
  it('reuses plugin files without scanning manifests and can disable them', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    const manifest = join(manager.paths.profile, 'node_modules/plugin/package.json')
    writeFileSync(manifest, '{broken')
    await expect(manager.applyRelease()).resolves.toBeUndefined()
    await manager.disableAllPlugins()
    await expect(manager.applyRelease()).resolves.toBeUndefined()
    expect(readFileSync(manifest, 'utf8')).toBe('{broken')
  })

  it('disables every third-party bundle without reading a broken plugin patch declaration', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    const patch = join(manager.paths.profile, 'node_modules/plugin/bundle.yml')
    unlinkSync(patch)
    await manager.disableAllPlugins()
    expect((JSON.parse(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }).dsh.profile.bundles).not.toContain('plugin')
    expect(existsSync(join(manager.paths.profile, 'node_modules/plugin/package.json'))).toBe(true)
    expect(calls(root)).toHaveLength(1)
    await expect(manager.applyRelease()).resolves.toBeUndefined()
  })

  it('disables plugins before runtime initialization and preserves configuration and package files', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    const patch = join(manager.paths.profile, 'cordis.patch.yml')
    writeFileSync(patch, ': broken')
    const uninitialized = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh: 'missing-runtime' })
    await uninitialized.disableAllPlugins()
    expect(readFileSync(patch, 'utf8')).toBe(': broken')
    expect(existsSync(join(manager.paths.profile, 'node_modules/plugin/package.json'))).toBe(true)
    const manifest = JSON.parse(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dependencies.plugin).toBe('1.0.0')
    expect(manifest.dsh.profile.bundles).not.toContain('plugin')
    expect(manifest.dsh.profile.bundles).toContain('@deepseek-ai/dsh-web-app')
  })

  it('needs no runtime or package manifest when no plugins have been installed', async () => {
    const { manager } = setup()
    await manager.disableAllPlugins()
    expect(existsSync(join(manager.paths.profile, 'package.json'))).toBe(false)
    expect(existsSync(manager.paths.lock)).toBe(false)
  })

  it('reports invalid profile JSON without replacing it', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    const path = join(manager.paths.profile, 'package.json')
    writeFileSync(path, '{broken')
    await expect(manager.disableAllPlugins()).rejects.toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{broken')
    expect(existsSync(manager.paths.lock)).toBe(false)
  })

  it.each(['missing', 'malformed', 'unversioned'] as const)('lists, disables, and removes a package with %s metadata', async (damage) => {
    const { manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    const path = join(manager.paths.profile, 'node_modules/plugin/package.json')
    if (damage === 'missing') unlinkSync(path)
    else writeFileSync(path, damage === 'malformed' ? '{broken' : '{}')
    expect(manager.listPlugins()).toEqual([{ name: 'plugin', version: '1.0.0', enabled: true }])
    await manager.mutate({ type: 'plugin-toggle', name: 'plugin', enabled: false }, hooks())
    expect(manager.listPlugins()[0]?.enabled).toBe(false)
    await manager.mutate({ type: 'plugin-remove', name: 'plugin' }, hooks())
    expect(manager.listPlugins()).toEqual([])
  })

  it('preserves custom profile metadata and bundle order during plugin changes', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    const path = join(manager.paths.profile, 'package.json')
    writeFileSync(path, JSON.stringify({ name: 'custom', private: false, custom: true,
      dependencies: {}, dsh: { profile: { bundles: ['custom-bundle', 'custom-bundle'] } } }))
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ name: 'custom', private: false, custom: true,
      dsh: { profile: { bundles: ['custom-bundle', 'custom-bundle', 'plugin'] } } })
    await manager.mutate({ type: 'plugin-remove', name: 'plugin' }, hooks())
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      dsh: { profile: { bundles: ['custom-bundle', 'custom-bundle'] } } })
  })

  it('passes user registry and pnpm configuration through to the bundled executable', async () => {
    const { root, manager } = setup()
    vi.stubEnv('NPM_CONFIG_REGISTRY', 'https://packages.example.test/')
    vi.stubEnv('NPM_CONFIG_USERCONFIG', join(root, 'user.npmrc'))
    vi.stubEnv('PNPM_HOME', join(root, 'user-pnpm'))
    vi.stubEnv('XDG_CONFIG_HOME', join(root, 'user-config'))
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@next' }, hooks())
    expect(calls(root)[0]).toMatchObject({ registry: 'https://packages.example.test/',
      userconfig: join(root, 'user.npmrc'), pnpmHome: join(root, 'user-pnpm'), configHome: join(root, 'user-config'),
      args: ['add', '--', 'plugin@next'] })
  })

  it('initializes the same pnpm settings as a Web profile without a Desktop build allowlist', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    expect(readFileSync(join(manager.paths.profile, 'pnpm-workspace.yaml'), 'utf8'))
      .toBe('packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  })

  it('opens a linked profile and migrates only the generated pnpm defaults', async () => {
    const { root, manager } = setup()
    const target = join(root, 'linked-profile')
    mkdirSync(target)
    mkdirSync(join(manager.paths.profile, '..'), { recursive: true })
    symlinkSync(target, manager.paths.profile, process.platform === 'win32' ? 'junction' : 'dir')
    await manager.applyRelease()
    const path = join(target, 'pnpm-workspace.yaml')
    const defaults = readFileSync(path, 'utf8')
    writeFileSync(path, `${defaults}strictDepBuilds: true\nallowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  "@deepseek-ai/dsh-subprocess-local": true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`)
    await manager.applyRelease()
    expect(readFileSync(path, 'utf8')).toBe(defaults)
    const custom = `${defaults}allowBuilds:\n  my-plugin: true\n`
    writeFileSync(path, custom)
    await manager.applyRelease()
    expect(readFileSync(path, 'utf8')).toBe(custom)
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    expect(manager.listPlugins()[0]?.name).toBe('plugin')
  })

  it('reports damaged application metadata as a reinstall failure', async () => {
    const { manager } = setup()
    writeFileSync(join(manager.runtime.dsh, 'desktop-runtime.json'), '{broken')
    await expect(manager.applyRelease()).rejects.toThrow()
  })

  it('preserves unknown files when initializing a profile', async () => {
    const { manager } = setup()
    mkdirSync(manager.paths.profile, { recursive: true })
    writeFileSync(join(manager.paths.profile, '.DS_Store'), 'metadata')
    writeFileSync(join(manager.paths.profile, 'user-file'), 'retain')
    await expect(manager.applyRelease()).resolves.toBeUndefined()
    expect(readFileSync(join(manager.paths.profile, '.DS_Store'), 'utf8')).toBe('metadata')
    expect(readFileSync(join(manager.paths.profile, 'user-file'), 'utf8')).toBe('retain')
    expect(readFileSync(join(manager.paths.profile, 'cordis.patch.yml'), 'utf8')).toContain('[]')
    expect(existsSync(join(manager.paths.profile, 'desktop-runtime-state.json'))).toBe(false)
  })

  it('initializes and restarts offline without executing pnpm', async () => {
    const { root, manager } = setup()
    await expect(manager.applyRelease()).resolves.toBeUndefined()
    await expect(manager.applyRelease()).resolves.toBeUndefined()
    expect(manager.listPlugins()).toEqual([])
    expect(calls(root)).toEqual([])
    expect(JSON.parse(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8'))).toMatchObject({ dependencies: {} })
  })

  it.skipIf(process.platform !== 'win32')('reuses the profile when the launch path changes only Windows letter casing', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    const relaunched = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh: manager.runtime.dsh.toUpperCase() })
    await expect(relaunched.applyRelease()).resolves.toBeUndefined()
  })

  it.each(['changed', 'same-size', 'extra', 'missing'])('starts and reuses a profile without checking %s runtime bytes', async (operation) => {
    const { root, manager } = setup()
    if (operation === 'changed') writeFileSync(join(manager.runtime.dsh, 'package.json'), '{}')
    if (operation === 'same-size') writeFileSync(join(manager.runtime.dsh, 'package.json'), '{"type":"Module"}\n')
    if (operation === 'extra') writeFileSync(join(manager.runtime.dsh, 'extra'), '')
    if (operation === 'missing') unlinkSync(join(manager.runtime.dsh, 'package.json'))
    await expect(manager.applyRelease()).resolves.toBeUndefined()
    const relaunched = new DesktopProjectManager(manager.paths, manager.runtime)
    await expect(relaunched.applyRelease()).resolves.toBeUndefined()
    expect(existsSync(manager.paths.profile)).toBe(true)
    expect(calls(root)).toEqual([])
  })

  it('installs plugins with pnpm script settings', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: '@scope/plugin@2.0.0' }, hooks())
    expect(manager.listPlugins()).toEqual([{ name: '@scope/plugin', version: '2.0.0', enabled: true }])
    expect(calls(root).map(call => call.args.filter(arg => !arg.startsWith('--config.')))).toEqual([
      ['add', '--', '@scope/plugin@2.0.0'],
    ])
    expect(calls(root).every(call => call.registry === process.env.NPM_CONFIG_REGISTRY)).toBe(true)
    expect(JSON.parse(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8'))).toMatchObject({ dependencies: { '@scope/plugin': '2.0.0' } })
    await expect(manager.applyRelease()).resolves.toBeUndefined()
    expect(calls(root)).toHaveLength(1)
  })

  it('retains pnpm-installed host package copies instead of rejecting their dependency placement', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: '@deepseek-ai/cordis@2.0.0' }, hooks())
    expect(manager.listPlugins()).toEqual([{ name: '@deepseek-ai/cordis', version: '2.0.0', enabled: false }])
    await expect(manager.applyRelease()).resolves.toBeUndefined()
    await manager.mutate({ type: 'plugin-remove', name: '@deepseek-ai/cordis' }, hooks())
  })

  it('retains disabled plugin versions through updates and enables them explicitly', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    await manager.disableAllPlugins()
    expect(calls(root)).toHaveLength(1)
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
    await expect(next.applyRelease()).resolves.toBeUndefined()
    expect(next.listPlugins()).toEqual(manager.listPlugins())
    expect(next.dshVersion()).toBe('1.1.0')
    expect(readFileSync(join(manager.paths.profile, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
    expect(calls(root)).toHaveLength(1)
    expect(readFileSync(join(manager.paths.profile, 'node_modules/plugin/bundle.yml'), 'utf8')).toBe('[]\n')
  })

  it('preserves plugin files without running pnpm when bundled Node changes', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    const dsh = join(root, 'new-node')
    runtimeFixture(dsh, '1.1.0', '24.18.0')
    const next = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh })
    await next.applyRelease()
    expect(calls(root)).toHaveLength(1)
    expect(next.listPlugins()).toEqual([{ name: 'plugin', version: '1.0.0', enabled: true }])
  })

  it('allows peer version mismatches to reach Host startup and remain available for recovery', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    const dsh = join(root, 'next-major')
    runtimeFixture(dsh, '2.0.0')
    const next = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh })
    await expect(next.applyRelease()).resolves.toBeUndefined()
    expect(next.dshVersion()).toBe('2.0.0')
    await next.disableAllPlugins()
    expect(next.dshVersion()).toBe('2.0.0')
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
  })

  it('keeps partial package changes available for recovery after pnpm fails', async () => {
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
    expect(starts).toBe(1)
    expect(existsSync(manager.paths.lock)).toBe(false)
    writeFileSync(join(manager.paths.profile, 'desktop-packages-pending'), '')
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-toggle', name: 'plugin', enabled: false }, hooks({ afterChange: async () => { starts++ } }))
    expect(starts).toBe(2)
    await manager.mutate({ type: 'plugin-remove', name: 'plugin' }, hooks())
    expect(manager.listPlugins()).toEqual([])
  })

  it('retains both package and restart errors when the changed profile cannot start', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    const failingPnpm = join(root, 'failing-restart.mjs')
    writeFileSync(failingPnpm, 'process.exitCode = 1')
    const worker = new DesktopProjectManager(manager.paths, { ...manager.runtime, pnpm: failingPnpm })
    await worker.applyRelease()
    const afterChange = vi.fn(async () => { throw new Error('Host initialization failed') })
    const failure = await worker.mutate({ type: 'plugin-add', spec: 'missing' }, hooks({ afterChange }))
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors.map((error: Error) => error.message))
      .toEqual([expect.stringContaining('pnpm exited with 1'), 'Host initialization failed'])
    expect(afterChange).toHaveBeenCalledOnce()
    expect(existsSync(manager.paths.lock)).toBe(false)
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
