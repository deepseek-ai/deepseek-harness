/** Package metadata queries share the active profile resolution generation. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getEnvironmentData } from 'node:worker_threads'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginPackages } from '../src/profile-resolution/service.ts'
import type { ProfileResolutionGeneration } from '../src/profile.ts'

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const context of contexts.splice(0).reverse()) await context.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function file(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function pkg(dir: string, version: string, name = 'metadata-lib'): string {
  file(join(dir, 'package.json'), JSON.stringify({
    name,
    version,
    type: 'module',
    exports: { import: './index.js', require: './index.cjs' },
  }))
  file(join(dir, 'index.js'), `export const version = ${JSON.stringify(version)}\n`)
  file(join(dir, 'index.cjs'), `exports.version = ${JSON.stringify(version)}\n`)
  return join(dir, 'package.json')
}

function generation(
  profilesDir: string, profileDir: string, packageDir: string, declarer: string, version: string,
): ProfileResolutionGeneration {
  return {
    profilesDir,
    profileDir,
    localPackageNames: [],
    entries: [{ name: 'metadata-lib', packageDir, version, declarer, scope: 'installation' }],
  }
}

describe('profile package metadata service', () => {
  it('resolves module URLs and package metadata through the current generation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-profile-package-service-'))
    roots.push(root)
    const profilesDir = join(root, 'profiles')
    const profileDir = join(profilesDir, 'test')
    const first = join(root, 'first')
    const firstAnchor = pkg(first, '1.0.0')
    file(join(profileDir, 'entry.mjs'), '')
    const parentURL = pathToFileURL(join(profileDir, 'entry.mjs')).href

    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = pathToFileURL(profileDir).href + '/'
    await ctx.plugin(PluginPackages, {
      generation: generation(profilesDir, profileDir, first, firstAnchor, '1.0.0'),
    })

    expect(ctx.pluginPackages.packageOf('metadata-lib/private', parentURL)).toMatchObject({
      name: 'metadata-lib',
      version: '1.0.0',
      dir: first,
    })
    const require = createRequire(join(profileDir, 'entry.cjs'))
    expect(require.resolve('metadata-lib')).toBe(realpathSync(join(first, 'index.cjs')))
    expect(ctx.pluginPackages.packageOf('node:fs', parentURL)).toBeUndefined()
    expect(ctx.pluginPackages.packageOf('./local.js', parentURL)).toBeUndefined()

    await ctx.fiber.dispose()
    contexts.pop()
    expect(() => { require.resolve('metadata-lib') }).toThrow(/Cannot find module/u)
  })

  it('uses native package lookup without a registration and caches parsed metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-native-package-service-'))
    roots.push(root)
    const packageDir = join(root, 'node_modules', '@scope', 'metadata')
    file(join(packageDir, 'package.json'), JSON.stringify({ name: '@scope/metadata' }))
    const parentURL = pathToFileURL(join(root, 'entry.mjs')).href
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(PluginPackages)

    const first = ctx.pluginPackages.packageOf('@scope/metadata/subpath', parentURL)
    expect(first).toMatchObject({ name: '@scope/metadata', version: undefined, dir: packageDir })
    expect(ctx.pluginPackages.packageOf('@scope/metadata', parentURL)).toBe(first)
    expect(ctx.pluginPackages.packageOf('missing-package', parentURL)).toBeUndefined()
    expect(ctx.pluginPackages.packageOf('@scope', parentURL)).toBeUndefined()
    expect(() => { ctx.pluginPackages.replace({
      profilesDir: join(root, 'profiles'), profileDir: undefined, localPackageNames: [], entries: [],
    }) }).toThrow(/runtime resolution is not installed/u)
  })

  it('rejects malformed package metadata selected by the resolver', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-invalid-package-service-'))
    roots.push(root)
    const anonymous = join(root, 'node_modules', 'anonymous')
    file(join(anonymous, 'package.json'), '{}')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(PluginPackages)
    const parentURL = pathToFileURL(join(root, 'entry.mjs')).href
    expect(ctx.pluginPackages.packageOf('missing', parentURL)).toBeUndefined()
    expect(ctx.pluginPackages.packageOf('anonymous', parentURL)).toMatchObject({
      name: 'anonymous',
      version: undefined,
      dir: anonymous,
    })
  })

  it('returns undefined when a selected package directory has no manifest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-missing-package-service-'))
    roots.push(root)
    const profilesDir = join(root, 'profiles')
    const profileDir = join(profilesDir, 'test')
    const missing = join(root, 'missing')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(PluginPackages, {
      generation: generation(profilesDir, profileDir, missing, join(root, 'owner.json'), '1.0.0'),
    })
    expect(ctx.pluginPackages.packageOf(
      'metadata-lib', pathToFileURL(join(profileDir, 'entry.mjs')).href,
    )).toBeUndefined()
  })

  it('does not revive a stale disk fallback after the runtime generation misses', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-stale-package-service-'))
    roots.push(root)
    const profilesDir = join(root, 'profiles')
    const profileDir = join(profilesDir, 'test')
    pkg(join(profilesDir, 'node_modules', 'stale-metadata'), '0.9.0', 'stale-metadata')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(PluginPackages, {
      generation: { profilesDir, profileDir, localPackageNames: [], entries: [] },
    })

    expect(ctx.pluginPackages.packageOf(
      'stale-metadata', pathToFileURL(join(profileDir, 'entry.mjs')).href,
    )).toBeUndefined()
  })

  it('publishes additive generations to the process and future Workers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-package-service-generation-'))
    roots.push(root)
    const profilesDir = join(root, 'profiles')
    const profileDir = join(profilesDir, 'test')
    const first = join(root, 'first')
    const firstAnchor = pkg(first, '1.0.0')
    const initial = generation(profilesDir, profileDir, first, firstAnchor, '1.0.0')
    mkdirSync(join(profilesDir, 'node_modules'), { recursive: true })
    symlinkSync(
      first,
      join(profilesDir, 'node_modules', 'metadata-lib'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const key = '@deepseek-ai/dsh-app-boot/profile-resolution'
    const previous = getEnvironmentData(key)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(PluginPackages, { generation: initial, behavior: 'verify' })
    const initialWorkerData = getEnvironmentData(key) as {
      generation: ProfileResolutionGeneration
      behavior: string
    }
    expect(initialWorkerData).toEqual({ generation: initial, behavior: 'verify' })

    const added = join(root, 'added')
    const addedAnchor = pkg(added, '2.0.0', 'added-metadata')
    symlinkSync(
      added,
      join(profilesDir, 'node_modules', 'added-metadata'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const next = {
      ...initial,
      entries: [...initial.entries, {
        name: 'added-metadata', packageDir: added, version: '2.0.0',
        declarer: addedAnchor, scope: 'installation' as const,
      }],
    }
    ctx.pluginPackages.replace(next)
    expect(getEnvironmentData(key)).toEqual({
      generation: next,
      behavior: 'verify',
    })
    expect(ctx.pluginPackages.packageOf(
      'added-metadata', pathToFileURL(join(profileDir, 'entry.mjs')).href,
    )).toMatchObject({ name: 'added-metadata', version: '2.0.0', dir: added })

    await ctx.fiber.dispose()
    contexts.pop()
    expect(getEnvironmentData(key)).toBe(previous)
  })
})
