/** Package metadata queries share the active runtime resolution. */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getEnvironmentData } from 'node:worker_threads'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginPackages } from '../src/profile-resolution/service.ts'
import type { RuntimeResolution } from '../src/profile.ts'

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
    exports: {
      '.': { import: './index.js', require: './index.cjs' },
      './feature': './index.js',
      './feature/locale/*.json': './feature-locale/*.json',
    },
  }))
  file(join(dir, 'index.js'), `export const version = ${JSON.stringify(version)}\n`)
  file(join(dir, 'index.cjs'), `exports.version = ${JSON.stringify(version)}\n`)
  return join(dir, 'package.json')
}

function resolution(
  profilesDir: string, profileDir: string, packageDir: string, declarer: string, version: string,
): RuntimeResolution {
  return {
    profilesDir,
    profileDir,
    localPackageNames: [],
    linkedRoots: [],
    entries: [{ name: 'metadata-lib', packageDir, version, declarer, scope: 'installation' }],
  }
}

describe('profile package metadata service', () => {
  it('reads translated metadata from the selected local package without importing its entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-localized-package-service-'))
    roots.push(root)
    const packageDir = join(root, 'node_modules', 'localized')
    file(join(packageDir, 'package.json'), JSON.stringify({
      name: 'localized', exports: { './private': './index.js', './private/locale/*.json': './locale/*.json' },
    }))
    file(join(packageDir, 'index.js'), 'throw new Error("must not execute")\n')
    file(join(packageDir, 'locale', 'en.json'), '{"meta":{"title":"Local plugin"}}')
    file(join(packageDir, 'locale', 'zh.json'), '{"meta":{"title":"本地插件"}}')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(PluginPackages)
    const parent = pathToFileURL(join(root, 'entry.mjs')).href
    expect(ctx.pluginPackages.metaOf('localized/private', parent)).toEqual({ title: { en: 'Local plugin', zh: '本地插件' } })
    expect(ctx.pluginPackages.metaOf('localized', parent)).toBeUndefined()
    expect(ctx.pluginPackages.metaOf('node:fs', parent)).toBeUndefined()
    file(join(root, 'node_modules', 'invalid', 'package.json'), '{')
    expect(ctx.pluginPackages.metaOf('invalid', parent)?.error).toContain('invalid')
  })

  it('resolves module URLs and package metadata through the current resolution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-profile-package-service-'))
    roots.push(root)
    const profilesDir = join(root, 'profiles')
    const profileDir = join(profilesDir, 'test')
    const first = join(root, 'first')
    const firstAnchor = pkg(first, '1.0.0')
    file(join(first, 'feature-locale', 'en.json'), '{"meta":{"title":"Profile feature"}}')
    file(join(profileDir, 'entry.mjs'), '')
    const parentURL = pathToFileURL(join(profileDir, 'entry.mjs')).href

    const ctx = new Context()
    contexts.push(ctx)
    ctx.baseUrl = pathToFileURL(profileDir).href + '/'
    await ctx.plugin(PluginPackages, {
      resolution: resolution(profilesDir, profileDir, first, firstAnchor, '1.0.0'),
    })

    expect(ctx.pluginPackages.packageOf('metadata-lib/private', parentURL)).toMatchObject({
      name: 'metadata-lib',
      version: '1.0.0',
      dir: first,
    })
    const require = createRequire(join(profileDir, 'entry.cjs'))
    expect(require.resolve('metadata-lib')).toBe(realpathSync(join(first, 'index.cjs')))
    expect(ctx.pluginPackages.metaOf('metadata-lib/feature', parentURL)).toEqual({ title: { en: 'Profile feature' } })
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
      profilesDir: join(root, 'profiles'), profileDir: undefined, localPackageNames: [], linkedRoots: [], entries: [],
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
      resolution: resolution(profilesDir, profileDir, missing, join(root, 'owner.json'), '1.0.0'),
    })
    expect(ctx.pluginPackages.packageOf(
      'metadata-lib', pathToFileURL(join(profileDir, 'entry.mjs')).href,
    )).toBeUndefined()
  })

  it('removes and restores linked roots while rejecting changes to their historical targets', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-linked-package-service-')))
    roots.push(root)
    const profilesDir = join(root, 'profiles')
    const profileDir = join(profilesDir, 'test')
    const runtime = join(root, 'runtime')
    const runtimeAnchor = pkg(runtime, '1.0.0')
    const linkedA = join(root, 'work', 'a')
    const linkedB = join(root, 'work', 'b')
    for (const dir of [linkedA, linkedB]) {
      file(join(dir, 'package.json'), JSON.stringify({
        name: 'linked-plugin', peerDependencies: { 'metadata-lib': '*' },
      }))
    }
    const local = join(linkedA, 'node_modules', 'metadata-lib')
    pkg(local, '2.0.0')
    const parentPath = join(linkedA, 'entry.mjs')
    file(parentPath, '')
    const parentURL = pathToFileURL(parentPath).href
    const require = createRequire(parentURL)
    const linked = { name: 'linked-plugin', realPath: linkedA }
    const initial: RuntimeResolution = {
      ...resolution(profilesDir, profileDir, runtime, runtimeAnchor, '1.0.0'),
      linkedRoots: [linked],
    }
    const removed: RuntimeResolution = { ...initial, linkedRoots: [] }
    const relinked: RuntimeResolution = { ...initial, linkedRoots: [{ ...linked, realPath: linkedB }] }
    const key = '@deepseek-ai/dsh-app-boot/profile-resolution'
    const previous = getEnvironmentData(key)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(PluginPackages, { resolution: initial })

    const expectSelectedPackage = (dir: string, version: string): void => {
      expect(ctx.pluginPackages.packageOf('metadata-lib', parentURL)).toMatchObject({
        name: 'metadata-lib', version, dir,
      })
      expect(require.resolve('metadata-lib')).toBe(realpathSync.native(join(dir, 'index.cjs')))
    }
    expectSelectedPackage(runtime, '1.0.0')
    expect(getEnvironmentData(key)).toEqual({ resolution: initial })

    ctx.pluginPackages.replace(removed)
    expectSelectedPackage(local, '2.0.0')
    expect(getEnvironmentData(key)).toEqual({ resolution: removed })

    ctx.pluginPackages.replace(initial)
    expectSelectedPackage(runtime, '1.0.0')
    expect(getEnvironmentData(key)).toEqual({ resolution: initial })

    ctx.pluginPackages.replace(removed)
    expectSelectedPackage(local, '2.0.0')
    const removedWorkerData = getEnvironmentData(key)
    expect(removedWorkerData).toEqual({ resolution: removed })
    expect(() => { ctx.pluginPackages.replace(relinked) }).toThrow(
      'profile resolution: relinking "linked-plugin" requires a process restart',
    )
    expectSelectedPackage(local, '2.0.0')
    expect(getEnvironmentData(key)).toBe(removedWorkerData)

    await ctx.fiber.dispose()
    contexts.pop()
    expect(getEnvironmentData(key)).toBe(previous)
  })

  it('publishes additive generations to the process and future Workers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-package-service-resolution-'))
    roots.push(root)
    const profilesDir = join(root, 'profiles')
    const profileDir = join(profilesDir, 'test')
    const first = join(root, 'first')
    const firstAnchor = pkg(first, '1.0.0')
    const initial = resolution(profilesDir, profileDir, first, firstAnchor, '1.0.0')
    const key = '@deepseek-ai/dsh-app-boot/profile-resolution'
    const previous = getEnvironmentData(key)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(PluginPackages, { resolution: initial })
    const initialWorkerData = getEnvironmentData(key) as {
      resolution: RuntimeResolution
    }
    expect(initialWorkerData).toEqual({ resolution: initial })

    const added = join(root, 'added')
    const addedAnchor = pkg(added, '2.0.0', 'added-metadata')
    const next = {
      ...initial,
      entries: [...initial.entries, {
        name: 'added-metadata', packageDir: added, version: '2.0.0',
        declarer: addedAnchor, scope: 'installation' as const,
      }],
    }
    ctx.pluginPackages.replace(next)
    expect(getEnvironmentData(key)).toEqual({
      resolution: next,
    })
    expect(ctx.pluginPackages.packageOf(
      'added-metadata', pathToFileURL(join(profileDir, 'entry.mjs')).href,
    )).toMatchObject({ name: 'added-metadata', version: '2.0.0', dir: added })

    await ctx.fiber.dispose()
    contexts.pop()
    expect(getEnvironmentData(key)).toBe(previous)
  })
})
