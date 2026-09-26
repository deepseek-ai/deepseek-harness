/** Application-owned profiles share the named profile launch lifecycle. */
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import {
  boot, composeEntries, createRuntimeResolution,
  PluginPackages, type Profile,
} from '@deepseek-ai/dsh-app-boot'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProfile } from '../src/profile-boot.ts'

vi.mock('@deepseek-ai/dsh-app-boot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-app-boot')>()
  return {
    ...actual,
    boot: vi.fn(),
    createRuntimeResolution: vi.fn(actual.createRuntimeResolution),
    installFailLoud: vi.fn(),
  }
})
vi.mock('@deepseek-ai/dsh-http-proxy', () => ({ installProxyFromEnvironment: vi.fn() }))

const homes: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.resetAllMocks()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('runProfile with an application-owned profile', () => {
  it.each(
    ['composition', 'boot', 'watch', 'cleanup', 'tree-cleanup', 'both-cleanups'] as const,
  )('releases startup resources after a %s failure', async (stage) => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-profile-startup-failure-'))
    homes.push(home)
    mkdirSync(join(home, 'runtime'))
    writeFileSync(join(home, 'runtime/package.json'), '{"name":"test-runtime","version":"1.0.0"}')
    writeFileSync(join(home, 'package.json'), '{"name":"test-bundle","version":"1.0.0"}')
    vi.stubEnv('DSH_HOME', home)
    vi.spyOn(process, 'on').mockReturnValue(process)
    const ctx = new Context()
    ctx.provide('loader', { create: vi.fn() })
    ctx.provide('hmr', {})
    const dispose = vi.spyOn(ctx.fiber, 'dispose')
    const failure = new Error('startup failed')
    const cleanupFailure = new Error('proxy cleanup failed')
    const treeCleanupFailure = new Error('tree cleanup failed')
    if (stage === 'tree-cleanup' || stage === 'both-cleanups') dispose.mockRejectedValueOnce(treeCleanupFailure)
    const disposeProxy = vi.fn().mockImplementation(() => stage === 'cleanup' || stage === 'both-cleanups'
      ? Promise.reject(cleanupFailure)
      : Promise.resolve())
    vi.mocked(installProxyFromEnvironment).mockResolvedValue(disposeProxy)
    vi.mocked(boot).mockImplementation(async (_name, _root, _patches, setup) => {
      await setup?.(ctx)
      throw failure
    })
    if (stage === 'composition') vi.mocked(createRuntimeResolution).mockRejectedValueOnce(failure)
    const profile: Profile = { skippedBundles: [],
      name: 'desktop', dir: home, patchPath: join(home, 'cordis.patch.yml'),
      patches: [], layers: [],
    }
    try {
      const application = runProfile({
        environment: createLaunchEnvironmentSnapshot([]), profile: 'desktop', patchFiles: [], args: ['--no-open'],
        resolvedProfile: { profile, installAnchor: join(home, 'runtime/package.json') },
      })
      if (stage === 'both-cleanups') {
        await expect(application).rejects.toMatchObject({ errors: [failure, { errors: [treeCleanupFailure, cleanupFailure] }] })
      } else if (stage === 'tree-cleanup') {
        await expect(application).rejects.toMatchObject({ errors: [failure, treeCleanupFailure] })
      } else if (stage === 'cleanup') {
        await expect(application).rejects.toMatchObject({ errors: [failure, cleanupFailure] })
      } else {
        await expect(application).rejects.toBe(failure)
      }
      expect(disposeProxy).toHaveBeenCalledOnce()
      expect(boot).toHaveBeenCalledTimes(stage === 'composition' ? 0 : 1)
      expect(dispose).toHaveBeenCalledTimes(stage === 'composition' ? 0 : 1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('uses shared layers, runtime resolution, and shutdown', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-resolved-profile-'))
    homes.push(home)
    mkdirSync(join(home, 'runtime'))
    writeFileSync(join(home, 'runtime/package.json'), '{"name":"test-runtime","version":"1.0.0","exports":"./index.cjs"}')
    writeFileSync(join(home, 'runtime/index.cjs'), 'module.exports = "installation"\n')
    writeFileSync(join(home, 'package.json'), '{"name":"test-bundle","version":"1.0.0","dependencies":{"test-local":"*"}}')
    const localPackageDir = join(home, 'node_modules/test-local')
    mkdirSync(localPackageDir, { recursive: true })
    const localManifest = '{"name":"test-local","version":"1.0.0","exports":"./index.cjs"}'
    writeFileSync(join(localPackageDir, 'package.json'), localManifest)
    writeFileSync(join(localPackageDir, 'index.cjs'), 'module.exports = "profile"\n')
    vi.stubEnv('DSH_HOME', home)
    vi.stubEnv('DSH_TELEMETRY_DISABLED', '1')
    vi.spyOn(process, 'on').mockReturnValue(process)
    const oldExitCode = process.exitCode
    const ctx = new Context()
    const plugin = vi.spyOn(ctx, 'plugin')
    // The real context supplies services; this test substitutes tree mounting and filesystem watchers.
    ctx.provide('loader', { create: vi.fn() })
    ctx.provide('hmr', {})
    const dispose = vi.spyOn(ctx.fiber, 'dispose')
    const disposeProxy = vi.fn().mockResolvedValue(undefined)
    vi.mocked(installProxyFromEnvironment).mockResolvedValue(disposeProxy)
    vi.mocked(boot).mockImplementation(async (_name, _root, _patches, setup) => {
      await setup?.(ctx)
      return ctx
    })
    const homePatch = join(home, 'cordis.patch.yml')
    const profilePatch = join(home, 'profile.patch.yml')
    const overlay = join(home, 'desktop.patch.yml')
    writeFileSync(homePatch, '- id: target\n  config: { home: true, priority: home }\n')
    writeFileSync(profilePatch, '- id: target\n  config: { profile: true, priority: profile }\n')
    writeFileSync(overlay, '- id: target\n  config: { overlay: true, priority: overlay }\n')
    writeFileSync(join(home, 'cordis.yml'), '- id: stale\n')
    const profile: Profile = { skippedBundles: [],
      name: 'desktop', dir: home, patchPath: profilePatch,
      patches: [{ id: 'target', config: { profile: true, priority: 'profile' } }],
      layers: [{
        packageName: 'test-bundle', packageDir: home, patchPaths: [join(home, 'bundle.yml')],
        patches: [{ insert: [
          { id: 'target', name: 'target', config: { bundle: true, priority: 'bundle' } },
          { id: 'session-telemetry-otel', name: 'telemetry' },
        ] }],
      }],
    }
    const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: { HTTPS_PROXY: 'http://localhost:8080' } }])
    const runtime = { profile, installAnchor: join(home, 'runtime/package.json') }
    try {
      const { shutdown } = await runProfile({
        environment, profile: 'desktop', resolvedProfile: runtime,
        patchFiles: [overlay], args: ['--port', '0', '--no-open'],
      })
      expect(installProxyFromEnvironment).toHaveBeenCalledWith(environment, expect.any(Function))
      const resolution = vi.mocked(createRuntimeResolution).mock.settledResults
        .find(result => result.type === 'fulfilled')?.value
      expect(resolution?.profileDir).toBe(home)
      expect(plugin).toHaveBeenCalledWith(PluginPackages, { resolution })
      expect(lstatSync(localPackageDir).isDirectory()).toBe(true)
      expect(readFileSync(join(localPackageDir, 'package.json'), 'utf8')).toBe(localManifest)
      const requireFromProfile = createRequire(join(home, 'package.json'))
      expect(requireFromProfile('test-runtime')).toBe('installation')
      expect(requireFromProfile('test-local')).toBe('profile')
      expect(readFileSync(join(home, 'cordis.yml'), 'utf8')).not.toContain('stale')
      expect(ctx.cmdlineArgs!.get()).toEqual(['--port', '0', '--no-open'])
      const ready = vi.fn()
      ctx.appReady!.onReady(ready)
      expect(ready).toHaveBeenCalledOnce()
      const patches = vi.mocked(boot).mock.calls[0]![2]!
      const rows = composeEntries([patches])
      expect(patches.slice(1, 4)).toEqual([
        { id: 'target', config: { profile: true, priority: 'profile' } },
        { id: 'target', config: { home: true, priority: 'home' } },
        { id: 'target', config: { overlay: true, priority: 'overlay' } },
      ])
      expect(rows.find(row => row.id === 'target')?.config).toEqual({ overlay: true, priority: 'overlay' })
      expect(rows.find(row => row.id === 'session-telemetry-otel')?.disabled).toBe(true)
      expect(ctx.profileContext).toMatchObject({ dir: home, patchPath: profilePatch, installAnchor: runtime.installAnchor })
      await shutdown.shutdown(0)
      expect(dispose).toHaveBeenCalledOnce()
      expect(disposeProxy).toHaveBeenCalledOnce()
    } finally {
      await ctx.fiber.dispose()
      process.exitCode = oldExitCode
    }
  })
})
