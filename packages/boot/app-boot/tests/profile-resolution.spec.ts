/** Runtime profile resolution uses one eager resolution for ESM and CommonJS. */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getEnvironmentData } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import {
  installRuntimeInterception,
  registerWorkerResolution,
  type RuntimeInterception,
} from '../src/profile-resolution/resolver.ts'
import {
  createRuntimeResolution,
  loadProfile,
  type Profile,
  type RuntimeResolution,
} from '../src/profile.ts'
import { registerHooksThreadStacks } from './hooks-thread-stack.ts'

const roots: string[] = []
const registrations: RuntimeInterception[] = []

afterEach(() => {
  for (const registration of registrations.splice(0).reverse()) registration.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function file(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function pkg(
  dir: string,
  name: string,
  marker: number,
  dependencies: Record<string, string> = {},
  peerDependencies: Record<string, string> = {},
): string {
  file(join(dir, 'package.json'), JSON.stringify({
    name,
    version: `${String(marker)}.0.0`,
    type: 'module',
    exports: { import: './index.js', require: './index.cjs' },
    dependencies,
    peerDependencies,
  }))
  file(join(dir, 'index.js'), `export const marker = ${String(marker)}\n`)
  file(join(dir, 'index.cjs'), `module.exports = { marker: ${String(marker)} }\n`)
  return join(dir, 'package.json')
}

function conditionalPkg(dir: string, name: string, importMarker: number, requireMarker: number): string {
  file(join(dir, 'package.json'), JSON.stringify({
    name,
    version: '1.0.0',
    type: 'module',
    exports: { custom: './custom.cjs', import: './import.js', require: './require.cjs' },
  }))
  file(join(dir, 'import.js'), `export const marker = ${String(importMarker)}\n`)
  file(join(dir, 'require.cjs'), `module.exports = { marker: ${String(requireMarker)} }\n`)
  file(join(dir, 'custom.cjs'), 'module.exports = { marker: 13 }\n')
  return join(dir, 'package.json')
}

async function importFrom(specifier: string, parent: string): Promise<Record<string, unknown>> {
  const addon = createRequire(import.meta.url)('node-addon-require-builtin') as {
    requireBuiltin(id: string): unknown
  }
  const loader = addon.requireBuiltin('internal/modules/esm/loader') as {
    getOrInitializeCascadedLoader(): {
      import(specifier: string, parent: string, attributes: ImportAttributes): Promise<Record<string, unknown>>
    }
  }
  return await loader.getOrInitializeCascadedLoader().import(specifier, parent, {})
}

function resolveFrom(
  specifier: string, parent: string | undefined, attributes: ImportAttributes = {}, skipSyncHooks = false,
): string {
  const addon = createRequire(import.meta.url)('node-addon-require-builtin') as {
    requireBuiltin(id: string): unknown
  }
  const loader = addon.requireBuiltin('internal/modules/esm/loader') as {
    getOrInitializeCascadedLoader(): {
      getOrCreateModuleJob?: unknown
      resolveSync(
        first: string | undefined,
        second: string | undefined | { specifier: string; attributes: ImportAttributes },
        third?: ImportAttributes | boolean,
      ): { url: string }
    }
  }
  const internal = loader.getOrInitializeCascadedLoader()
  if (!('getOrCreateModuleJob' in internal)) return internal.resolveSync(specifier, parent, attributes).url
  return skipSyncHooks
    ? internal.resolveSync(parent, { specifier, attributes }, true).url
    : internal.resolveSync(parent, { specifier, attributes }).url
}

function thrownMessage(callback: () => unknown): string {
  try {
    callback()
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('expected callback to throw')
}

function thrownError(callback: () => unknown): Error & {
  code?: string
  path?: string
  requestPath?: string
  requireStack?: string[]
} {
  try {
    callback()
  } catch (error) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('expected callback to throw')
}

function fixture(name = '@deepseek-ai/dsh-core'): {
  root: string
  installAnchor: string
  installed: string
  profile: Profile
} {
  // root plays $DSH_HOME; the running dsh lives in a global install outside the profiles tree.
  // Node reports resolved module paths through the native realpath: /private/var for a macOS tmpdir under /var,
  // and the long directory name for a Windows tmpdir spelled with an 8.3 short name.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-profile-resolution-')))
  roots.push(root)
  const installDir = join(root, 'global', 'node_modules', '@deepseek-ai', 'dsh')
  const installed = join(installDir, 'node_modules', name)
  const installAnchor = pkg(installDir, '@deepseek-ai/dsh', 0, { [name]: '*' })
  pkg(installed, name, 1)
  const profileDir = join(root, 'profiles', 'web')
  file(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web', private: true, dependencies: { 'missing-local': '*' },
  }))
  return {
    root,
    installAnchor,
    installed,
    profile: { skippedBundles: [],
      name: 'web',
      dir: profileDir,
      layers: [],
      patchPath: join(profileDir, 'cordis.patch.yml'),
      patches: [],
    },
  }
}

async function resolutionOf(f: ReturnType<typeof fixture>): Promise<RuntimeResolution> {
  return await createRuntimeResolution({
    installAnchor: f.installAnchor,
    profile: f.profile,
    home: f.root,
  })
}

/**
 * Ancestor node_modules layers of a profile importer, innermost first:
 * private (plugin-private), profile (profile node_modules), shared
 * (profiles/node_modules, the interception layer), home (Harness home).
 */
type LookupLayer = 'private' | 'profile' | 'shared' | 'home'
const LOOKUP_LAYERS: readonly LookupLayer[] = ['private', 'profile', 'shared', 'home']
const LOOKUP_MARKERS: Record<LookupLayer, number> = { private: 11, profile: 12, shared: 13, home: 14 }

interface LookupCase {
  title: string
  importer: 'profile' | 'plugin'
  kind: 'installation' | 'bundle' | 'unlisted'
  layers: readonly LookupLayer[]
  form: 'directory' | 'symlink'
}

/** Every combination of importer, package kind, present layers, and on-disk form of the profile and shared layers. */
function lookupMatrix(): LookupCase[] {
  const cases: LookupCase[] = []
  for (const importer of ['profile', 'plugin'] as const) {
    const available = importer === 'plugin' ? LOOKUP_LAYERS : LOOKUP_LAYERS.filter(layer => layer !== 'private')
    for (let mask = 0; mask < 1 << available.length; mask++) {
      const layers = available.filter((_, index) => (mask & (1 << index)) !== 0)
      const forms = layers.some(layer => layer === 'profile' || layer === 'shared')
        ? ['directory', 'symlink'] as const
        : ['directory'] as const
      for (const kind of ['installation', 'bundle', 'unlisted'] as const) {
        for (const form of forms) {
          cases.push({
            title: `resolves ${kind} package from ${importer} importer with [${layers.join(', ')}] as ${form}`,
            importer, kind, layers, form,
          })
        }
      }
    }
  }
  return cases
}

/** The lookup order: profile-internal layers, then the resolution at the interception layer, then the remaining ancestors. */
function lookupWinner(matrixCase: LookupCase): LookupLayer | 'interception' | 'missing' {
  if (matrixCase.importer === 'plugin' && matrixCase.layers.includes('private')) return 'private'
  if (matrixCase.layers.includes('profile')) return 'profile'
  if (matrixCase.kind !== 'unlisted') return 'interception'
  if (matrixCase.layers.includes('shared')) return 'shared'
  if (matrixCase.layers.includes('home')) return 'home'
  return 'missing'
}

describe('runtime resolution', { concurrent: false }, () => {
  it('computes an immutable runtime resolution without writing profile packages', async () => {
    const f = fixture()
    const resolution = await resolutionOf(f)
    expect(resolution.entries.find(entry => entry.name === '@deepseek-ai/dsh-core')).toMatchObject({
      packageDir: f.installed,
      version: '1.0.0',
      declarer: f.installAnchor,
      scope: 'installation',
    })
    expect(existsSync(join(resolution.profilesDir, 'node_modules'))).toBe(false)
    expect(existsSync(join(f.profile.dir, 'node_modules'))).toBe(false)
    expect(Object.isFrozen(resolution)).toBe(true)
    expect(Object.isFrozen(resolution.entries)).toBe(true)
    expect(resolution.entries.every(Object.isFrozen)).toBe(true)

    const installationOnly = await createRuntimeResolution({
      installAnchor: f.installAnchor,
      home: join(f.root, 'installation-only-home'),
    })
    expect(installationOnly.profileDir).toBeUndefined()
    expect(installationOnly.localPackageNames).toEqual([])
    const registration = installRuntimeInterception(installationOnly)
    registrations.push(registration)
    expect(createRequire(join(installationOnly.profilesDir, 'entry.cjs'))('@deepseek-ai/dsh-core'))
      .toEqual({ marker: 1 })
  })

  it('fails resolution construction before writing when the profile manifest is malformed', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'package.json'), '{')
    await expect(resolutionOf(f)).rejects.toThrow(SyntaxError)
    expect(existsSync(join(f.root, 'profiles', 'node_modules'))).toBe(false)
  })

  it.each([
    ['installation', 'symlink'],
    ['installation', 'directory'],
    ['bundle', 'symlink'],
    ['bundle', 'directory'],
  ] as const)('canonicalizes transitive %s import anchors (%s packages)', async (origin, layout) => {
    const f = fixture('bridge')
    const linked = layout === 'symlink'
    const workspace = join(f.root, 'workspace')
    const bridge = linked ? join(workspace, 'bridge') : f.installed
    const middle = linked ? join(workspace, 'middle') : join(bridge, 'node_modules', 'middle')
    pkg(bridge, 'bridge', 1, { middle: '*' })
    pkg(middle, 'middle', 2, { leaf: '*' })
    const logicalLeaf = join(bridge, 'node_modules', 'leaf')
    const workspaceLeaf = join(workspace, 'node_modules', 'leaf')
    pkg(logicalLeaf, 'leaf', 1)
    pkg(workspaceLeaf, 'leaf', 2)
    const installAnchor = linked ? join(f.root, 'install-link', 'package.json') : f.installAnchor
    if (linked) {
      rmSync(f.installed, { recursive: true })
      symlinkSync(bridge, f.installed, 'junction')
      symlinkSync(middle, join(bridge, 'node_modules', 'middle'), 'junction')
      symlinkSync(dirname(f.installAnchor), dirname(installAnchor), 'junction')
    }
    if (origin === 'bundle') {
      pkg(dirname(f.installAnchor), '@deepseek-ai/dsh', 0)
      f.profile.layers.push({
        packageName: 'bridge', packageDir: f.installed,
        patchPaths: [join(f.installed, 'cordis.patch.yml')], patches: [],
      })
    }
    expect(createRequire(join(bridge, 'node_modules', 'middle', 'package.json'))('leaf')).toEqual({ marker: 1 })
    const resolution = await createRuntimeResolution({
      installAnchor, profile: f.profile, home: f.root,
    })
    expect(resolution.entries.find(entry => entry.name === '@deepseek-ai/dsh')?.declarer).toBe(f.installAnchor)
    expect(resolution.entries.find(entry => entry.name === 'middle')?.declarer)
      .toBe(join(bridge, 'package.json'))
    expect(resolution.entries.find(entry => entry.name === 'leaf')).toMatchObject({
      packageDir: linked ? workspaceLeaf : logicalLeaf,
      declarer: join(middle, 'package.json'),
      version: linked ? '2.0.0' : '1.0.0',
    })
  })

  it('keeps each earlier root complete before considering a later root', async () => {
    const f = fixture('installation-bridge')
    const installedBridge = f.installed
    const installationChoice = join(installedBridge, 'node_modules', 'ordered-choice')
    pkg(installedBridge, 'installation-bridge', 1, { 'ordered-choice': '*' }, { 'peer-choice': '*' })
    pkg(installationChoice, 'ordered-choice', 1)
    const peerChoice = join(installedBridge, 'node_modules', 'peer-choice')
    pkg(peerChoice, 'peer-choice', 3)
    const bundleDir = join(f.root, 'bundle')
    pkg(bundleDir, 'test-bundle', 0, { 'ordered-choice': '*', 'bundle-bridge': '*' })
    pkg(join(bundleDir, 'node_modules', 'ordered-choice'), 'ordered-choice', 2)
    const bundleBridge = join(bundleDir, 'node_modules', 'bundle-bridge')
    pkg(bundleBridge, 'bundle-bridge', 0, { 'bundle-choice': '*' })
    const firstBundleChoice = join(bundleBridge, 'node_modules', 'bundle-choice')
    pkg(firstBundleChoice, 'bundle-choice', 1)
    const laterBundle = join(f.root, 'later-bundle')
    pkg(laterBundle, 'later-bundle', 0, { 'bundle-choice': '*' })
    pkg(join(laterBundle, 'node_modules', 'bundle-choice'), 'bundle-choice', 2)
    f.profile.layers.push({
      packageName: 'test-bundle',
      packageDir: bundleDir,
      patchPaths: [join(bundleDir, 'cordis.patch.yml')],
      patches: [],
    }, {
      packageName: 'later-bundle',
      packageDir: laterBundle,
      patchPaths: [join(laterBundle, 'cordis.patch.yml')],
      patches: [],
    })

    const resolution = await resolutionOf(f)
    expect(resolution.entries.find(entry => entry.name === 'ordered-choice')).toMatchObject({
      packageDir: installationChoice,
      scope: 'installation',
    })
    const bundleChoice = resolution.entries.find(entry => entry.name === 'bundle-choice')
    if (bundleChoice === undefined) throw new Error('resolution omitted bundle-choice')
    expect(bundleChoice).toMatchObject({ scope: 'profile' })
    expect(realpathSync.native(bundleChoice.packageDir)).toBe(realpathSync.native(firstBundleChoice))
    expect(resolution.entries.find(entry => entry.name === 'peer-choice')).toMatchObject({
      packageDir: peerChoice,
      scope: 'installation',
    })
  })

  it('routes ESM and CommonJS through the same installation entry', async () => {
    const f = fixture()
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require('@deepseek-ai/dsh-core')).toEqual({ marker: 1 })
    expect(require.resolve('@deepseek-ai/dsh-core')).toBe(join(f.installed, 'index.cjs'))
    const parent = pathToFileURL(join(f.profile.dir, 'entry.mjs')).href
    expect(resolveFrom('@deepseek-ai/dsh-core', parent)).toBe(pathToFileURL(join(f.installed, 'index.js')).href)
    expect(resolveFrom('@deepseek-ai/dsh-core', parent, { type: 'javascript' }))
      .toBe(pathToFileURL(join(f.installed, 'index.js')).href)
    expect(resolveFrom('@deepseek-ai/dsh-core', parent)).toBe(pathToFileURL(join(f.installed, 'index.js')).href)
    expect(import.meta.resolve('@deepseek-ai/dsh-core', parent)).toBe(pathToFileURL(join(f.installed, 'index.js')).href)
    expect(await importFrom('@deepseek-ai/dsh-core', parent)).toMatchObject({ marker: 1 })
  })

  it('routes a scoped CommonJS package through its containing node_modules directory', async () => {
    const f = fixture('@scope/tools')
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))

    expect(require('@scope/tools')).toEqual({ marker: 1 })
    expect(require.resolve('@scope/tools')).toBe(join(f.installed, 'index.cjs'))
  })

  it('routes a CommonJS npm alias through its declaring package', async () => {
    const f = fixture('aliased-lib')
    const target = join(f.root, 'store', 'real-lib')
    pkg(target, 'real-lib', 5)
    rmSync(f.installed, { recursive: true })
    symlinkSync(target, f.installed, process.platform === 'win32' ? 'junction' : 'dir')
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)

    expect(createRequire(join(f.profile.dir, 'entry.cjs'))('aliased-lib')).toEqual({ marker: 5 })
  })

  it('intercepts directly above an application-owned profile outside the shared profiles directory', async () => {
    const f = fixture()
    const profileDir = join(f.root, 'application-profile')
    file(join(profileDir, 'package.json'), JSON.stringify({ name: 'application-profile', private: true }))
    // The first ancestor node_modules above the profile directory is the interception layer.
    pkg(join(f.root, 'node_modules', '@deepseek-ai/dsh-core'), '@deepseek-ai/dsh-core', 2)
    const profile = {
      ...f.profile,
      dir: profileDir,
      patchPath: join(profileDir, 'cordis.patch.yml'),
    }
    const resolution = await createRuntimeResolution({
      installAnchor: f.installAnchor,
      profile,
      home: f.root,
    })
    const registration = installRuntimeInterception(resolution)
    registrations.push(registration)
    const require = createRequire(join(profileDir, 'entry.cjs'))
    expect(require('@deepseek-ai/dsh-core')).toEqual({ marker: 1 })
    expect(require.resolve('@deepseek-ai/dsh-core', { paths: [profileDir] }))
      .toBe(join(f.root, 'node_modules', '@deepseek-ai/dsh-core', 'index.cjs'))
    const parent = pathToFileURL(join(profileDir, 'entry.mjs')).href
    expect(resolveFrom('@deepseek-ai/dsh-core', parent)).toBe(pathToFileURL(join(f.installed, 'index.js')).href)
    expect(await importFrom('@deepseek-ai/dsh-core', parent)).toMatchObject({ marker: 1 })
    expect(registration.packageDir('@deepseek-ai/dsh-core', parent)).toBe(f.installed)
    expect(createRequire(join(f.root, 'outside.cjs'))('@deepseek-ai/dsh-core')).toEqual({ marker: 2 })
  })

  it('does not reuse a default route for explicit CommonJS paths', async () => {
    const f = fixture()
    const alternative = join(f.root, 'alternative')
    const alternativePackage = join(alternative, 'node_modules', '@deepseek-ai/dsh-core')
    pkg(alternativePackage, '@deepseek-ai/dsh-core', 2)
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require.resolve('@deepseek-ai/dsh-core')).toBe(join(f.installed, 'index.cjs'))
    expect(require.resolve('@deepseek-ai/dsh-core', { paths: [alternative] })).toBe(join(alternativePackage, 'index.cjs'))
    expect(thrownError(() => require.resolve('@deepseek-ai/dsh-core', { paths: [f.profile.dir] })))
      .toMatchObject({ code: 'MODULE_NOT_FOUND' })
    expect(thrownError(() => require.resolve('@deepseek-ai/dsh-core', {
      paths: [join(f.root, 'missing'), f.profile.dir],
    }))).toMatchObject({ code: 'MODULE_NOT_FOUND' })
    const relative = join(f.profile.dir, 'relative.cjs')
    file(relative, '')
    expect(require.resolve('./relative.cjs', { paths: [f.profile.dir] })).toBe(relative)
    const invalid = join(f.root, 'invalid')
    file(join(invalid, 'node_modules', '@deepseek-ai/dsh-core', 'package.json'), '{')
    expect(() => { require.resolve('@deepseek-ai/dsh-core', { paths: [invalid, f.profile.dir] }) })
      .toThrow(/Invalid package config/u)
    expect(require.resolve('@deepseek-ai/dsh-core')).toBe(join(f.installed, 'index.cjs'))
  })

  it('keeps earlier explicit CommonJS paths ahead of a profile-local failure', async () => {
    const f = fixture()
    const resolution = await createRuntimeResolution({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    const local = join(f.profile.dir, 'node_modules', '@deepseek-ai/dsh-core')
    file(join(local, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-core', version: '2.0.0', exports: './missing.cjs',
    }))
    const alternative = join(f.root, 'alternative')
    const selected = join(alternative, 'node_modules', '@deepseek-ai/dsh-core', 'index.cjs')
    pkg(dirname(selected), '@deepseek-ai/dsh-core', 3)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    const paths = [alternative, f.profile.dir]
    expect(require.resolve('@deepseek-ai/dsh-core', { paths })).toBe(selected)

    const registration = installRuntimeInterception(resolution)
    registrations.push(registration)
    expect(require.resolve('@deepseek-ai/dsh-core', { paths })).toBe(selected)
  })

  it('preserves a missing legacy main error before an explicit profile path', async () => {
    const f = fixture()
    const invalid = join(f.root, 'invalid')
    const selected = join(invalid, 'node_modules', '@deepseek-ai/dsh-core')
    file(join(selected, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-core', main: './missing.cjs' }))
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    const paths = [invalid, f.profile.dir]
    const nativeError = thrownError(() => require.resolve('@deepseek-ai/dsh-core', { paths }))
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    const runtimeError = thrownError(() => require.resolve('@deepseek-ai/dsh-core', { paths }))

    expect(runtimeError).toMatchObject({
      code: nativeError.code,
      path: nativeError.path,
      requestPath: nativeError.requestPath,
    })
    expect(runtimeError.message).toBe(nativeError.message)
  })

  it('preserves a missing ancestor legacy main error before later explicit CommonJS paths', async () => {
    const f = fixture()
    const name = 'fallback-invalid-main'
    const selected = join(f.root, 'node_modules', name)
    file(join(selected, 'package.json'), JSON.stringify({ name, main: './missing.cjs' }))
    const alternative = join(f.root, 'alternative')
    pkg(join(alternative, 'node_modules', name), name, 2)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    const paths = [f.profile.dir, alternative]
    const nativeError = thrownError(() => require.resolve(name, { paths }))
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    const runtimeError = thrownError(() => require.resolve(name, { paths }))

    expect(runtimeError).toMatchObject({
      code: nativeError.code,
      path: nativeError.path,
      requestPath: nativeError.requestPath,
    })
    expect(runtimeError.message).toBe(nativeError.message)
  })

  it('preserves a missing legacy main error for explicit paths when a runtime entry is unavailable', async () => {
    const f = fixture()
    const selected = join(f.root, 'node_modules', '@deepseek-ai/dsh-core')
    file(join(selected, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-core', main: './missing.cjs' }))
    const alternative = join(f.root, 'alternative')
    pkg(join(alternative, 'node_modules', '@deepseek-ai/dsh-core'), '@deepseek-ai/dsh-core', 2)
    const resolution = await resolutionOf(f)
    rmSync(f.installed, { recursive: true })
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    const paths = [f.profile.dir, alternative]
    const nativeError = thrownError(() => require.resolve('@deepseek-ai/dsh-core', { paths }))
    const registration = installRuntimeInterception(resolution)
    registrations.push(registration)
    const runtimeError = thrownError(() => require.resolve('@deepseek-ai/dsh-core', { paths }))

    expect(runtimeError).toMatchObject({
      code: nativeError.code,
      path: nativeError.path,
      requestPath: nativeError.requestPath,
    })
    expect(runtimeError.message).toBe(nativeError.message)
  })

  it('keeps a profile-local package ahead of the resolution', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: { '@deepseek-ai/dsh-core': '*', 'linked-local': '*' },
    }))
    const localResolution = join(f.profile.dir, 'node_modules', '@deepseek-ai/dsh-core')
    pkg(localResolution, '@deepseek-ai/dsh-core', 2)
    const linkedLocal = join(f.root, 'linked-local')
    pkg(linkedLocal, 'linked-local', 3)
    symlinkSync(
      linkedLocal,
      join(f.profile.dir, 'node_modules', 'linked-local'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const resolution = await resolutionOf(f)
    expect(resolution.localPackageNames).toEqual(['@deepseek-ai/dsh-core', 'linked-local'])
    const registration = installRuntimeInterception(resolution)
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require('@deepseek-ai/dsh-core')).toEqual({ marker: 2 })
    expect(require.resolve('@deepseek-ai/dsh-core', { paths: [f.profile.dir] }))
      .toBe(join(localResolution, 'index.cjs'))
    const parent = pathToFileURL(join(f.profile.dir, 'entry.mjs')).href
    expect(resolveFrom('@deepseek-ai/dsh-core', parent)).toBe(
      pathToFileURL(join(f.profile.dir, 'node_modules', '@deepseek-ai/dsh-core', 'index.js')).href,
    )
  })

  it('preserves an npm alias package self-reference', async () => {
    const f = fixture()
    file(f.installAnchor, JSON.stringify({
      name: '@deepseek-ai/dsh',
      version: '0.0.0',
      type: 'module',
      exports: { import: './index.js', require: './index.cjs' },
      dependencies: { '@deepseek-ai/dsh-core': '*', 'real-name': '*' },
    }))
    const installedRealName = join(dirname(f.installAnchor), 'node_modules', 'real-name')
    pkg(installedRealName, 'real-name', 7)
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: { alias: 'npm:real-name' },
    }))
    const alias = join(f.profile.dir, 'node_modules', 'alias')
    pkg(alias, 'real-name', 6)
    const resolution = await createRuntimeResolution({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    expect(resolution.localPackageNames).toEqual(['alias'])
    const require = createRequire(join(alias, 'inside.cjs'))
    expect(require.resolve('real-name')).toBe(join(alias, 'index.cjs'))
    expect(require.resolve('real-name', { paths: [f.profile.dir] })).toBe(join(alias, 'index.cjs'))
    expect(resolveFrom('real-name', pathToFileURL(join(alias, 'inside-native.mjs')).href)).toBe(
      pathToFileURL(join(alias, 'index.js')).href,
    )
    const invalidScope = join(f.profile.dir, 'node_modules', 'invalid-scope')
    file(join(invalidScope, 'package.json'), '{')
    expect(() => createRequire(join(invalidScope, 'inside.cjs')).resolve('@deepseek-ai/dsh-core'))
      .toThrow(/Invalid package config/u)
    expect(() => resolveFrom('@deepseek-ai/dsh-core', pathToFileURL(join(invalidScope, 'inside.mjs')).href))
      .toThrow(/Invalid package config/u)

    const registration = installRuntimeInterception(resolution)
    registrations.push(registration)
    expect(require.resolve('real-name')).toBe(join(alias, 'index.cjs'))
    expect(require.resolve('real-name', { paths: [f.profile.dir] })).toBe(join(alias, 'index.cjs'))
    expect(resolveFrom('real-name', pathToFileURL(join(alias, 'inside-runtime.mjs')).href)).toBe(
      pathToFileURL(join(alias, 'index.js')).href,
    )
    expect(() => createRequire(join(invalidScope, 'inside.cjs')).resolve('@deepseek-ai/dsh-core'))
      .toThrow(/Invalid package config/u)
    expect(() => resolveFrom('@deepseek-ai/dsh-core', pathToFileURL(join(invalidScope, 'inside.mjs')).href))
      .toThrow(/Invalid package config/u)
  })

  it('keeps package imports aliases on the resolution route', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      imports: { '#@deepseek-ai/dsh-core': '@deepseek-ai/dsh-core' },
    }))
    const resolution = await createRuntimeResolution({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    const nested = join(f.profile.dir, 'nested')
    const require = createRequire(join(nested, 'entry.cjs'))
    const nativeParent = pathToFileURL(join(nested, 'entry-native.mjs')).href
    expect(() => require.resolve('#@deepseek-ai/dsh-core')).toThrow(/Cannot find module/u)
    expect(() => resolveFrom('#@deepseek-ai/dsh-core', nativeParent)).toThrow(/Cannot find package/u)

    const registration = installRuntimeInterception(resolution)
    registrations.push(registration)
    const runtimeParent = pathToFileURL(join(nested, 'entry-runtime.mjs')).href
    expect(require.resolve('#@deepseek-ai/dsh-core')).toBe(join(f.installed, 'index.cjs'))
    expect(resolveFrom('#@deepseek-ai/dsh-core', runtimeParent)).toBe(pathToFileURL(join(f.installed, 'index.js')).href)
  })

  it('imports package aliases through the resolution and reports the original importer', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      imports: { '#library': '@deepseek-ai/dsh-core', '#missing': '@deepseek-ai/dsh-core/missing' },
    }))
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    const parent = pathToFileURL(join(f.profile.dir, 'entry.mjs')).href
    await expect(importFrom('#library', parent)).resolves.toMatchObject({ marker: 1 })
    await expect(importFrom('#missing', parent)).rejects.toMatchObject({
      code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
      message: expect.stringContaining(fileURLToPath(parent)) as unknown as string,
    })
  })

  it('leaves relative package imports targets and their diagnostics to Node', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      imports: { '#missing-relative': './missing.cjs' },
    }))
    const resolution = await createRuntimeResolution({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    const parent = pathToFileURL(join(f.profile.dir, 'entry.mjs')).href
    const cjsMessage = thrownMessage(() => require.resolve('#missing-relative'))
    const esmMessage = thrownMessage(() => resolveFrom('#missing-relative', parent))

    const registration = installRuntimeInterception(resolution)
    registrations.push(registration)
    expect(thrownMessage(() => require.resolve('#missing-relative'))).toBe(cjsMessage)
    expect(thrownMessage(() => resolveFrom('#missing-relative', parent))).toBe(esmMessage)
  })

  it('keeps local and native-after-resolution package imports targets in native order', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      imports: { '#local': 'local-import', '#ancestor': 'ancestor-import' },
    }))
    const local = join(f.profile.dir, 'node_modules', 'local-import')
    const ancestor = join(f.root, 'node_modules', 'ancestor-import')
    pkg(local, 'local-import', 4)
    pkg(ancestor, 'ancestor-import', 5)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require.resolve('#local')).toBe(join(local, 'index.cjs'))
    expect(require.resolve('#ancestor')).toBe(join(ancestor, 'index.cjs'))

    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    expect(require.resolve('#local')).toBe(join(local, 'index.cjs'))
    expect(require.resolve('#ancestor')).toBe(join(ancestor, 'index.cjs'))
  })

  it('leaves package imports outside the profile scope to Node', async () => {
    const f = fixture()
    const outside = join(f.root, 'outside')
    file(join(outside, 'package.json'), JSON.stringify({
      name: 'outside', private: true, imports: { '#missing': 'missing-target' },
    }))
    const require = createRequire(join(outside, 'entry.cjs'))
    const nativeMessage = thrownMessage(() => require.resolve('#missing'))
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)

    expect(thrownMessage(() => require.resolve('#missing'))).toBe(nativeMessage)
  })

  it('does not inherit package imports across node_modules', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', private: true, imports: { '#@deepseek-ai/dsh-core': '@deepseek-ai/dsh-core' },
    }))
    const nested = join(f.profile.dir, 'node_modules', 'manifestless', 'entry.cjs')
    file(nested, '')
    const require = createRequire(nested)
    const nativeMessage = thrownMessage(() => require.resolve('#@deepseek-ai/dsh-core'))
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)

    expect(thrownMessage(() => require.resolve('#@deepseek-ai/dsh-core'))).toBe(nativeMessage)
  })

  it('falls through a missing local CommonJS subpath to the resolution', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: { '@deepseek-ai/dsh-core': '*' },
    }))
    file(join(f.installed, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-core', version: '1.0.0', type: 'module', main: './index.cjs',
    }))
    file(join(f.installed, 'only-install.cjs'), 'module.exports = { marker: 8 }\n')
    file(join(f.installed, 'legacy-install.cjs'), 'module.exports = { marker: 9 }\n')
    const local = join(f.profile.dir, 'node_modules', '@deepseek-ai/dsh-core')
    file(join(local, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-core', version: '2.0.0', type: 'module', main: './index.cjs',
    }))
    file(join(local, 'index.cjs'), 'module.exports = { marker: 2 }\n')
    const resolution = await resolutionOf(f)
    expect(resolution.localPackageNames).toEqual(['@deepseek-ai/dsh-core'])
    const registration = installRuntimeInterception(resolution)
    registrations.push(registration)

    expect(createRequire(join(f.profile.dir, 'entry.cjs')).resolve('@deepseek-ai/dsh-core/only-install.cjs'))
      .toBe(join(f.installed, 'only-install.cjs'))
    rmSync(join(local, 'package.json'))
    expect(createRequire(join(f.profile.dir, 'entry.cjs')).resolve('@deepseek-ai/dsh-core/legacy-install.cjs'))
      .toBe(join(f.installed, 'legacy-install.cjs'))
  })

  it('treats null exports as legacy CommonJS package resolution', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: { '@deepseek-ai/dsh-core': '*' },
    }))
    file(join(f.installed, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-core', version: '1.0.0', type: 'module', exports: null,
    }))
    const installedSubpath = join(f.installed, 'only-install.cjs')
    file(installedSubpath, 'module.exports = { marker: 8 }\n')
    const local = join(f.profile.dir, 'node_modules', '@deepseek-ai/dsh-core')
    file(join(local, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-core', version: '2.0.0', type: 'module', exports: null,
    }))
    const resolution = await createRuntimeResolution({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    const require = createRequire(join(local, 'entry.cjs'))
    expect(() => require.resolve('@deepseek-ai/dsh-core/only-install.cjs')).toThrow(/Cannot find module/u)

    const registration = installRuntimeInterception(resolution)
    registrations.push(registration)
    expect(require.resolve('@deepseek-ai/dsh-core/only-install.cjs')).toBe(installedSubpath)
  })

  it('stops a local CommonJS probe before the resolution fallback position', async () => {
    const f = fixture()
    file(join(f.installed, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-core', version: '1.0.0', type: 'module', main: './index.cjs',
    }))
    const installedSubpath = join(f.installed, 'only-install.cjs')
    file(installedSubpath, 'module.exports = { marker: 8 }\n')
    const resolution = await createRuntimeResolution({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    file(join(f.profile.dir, 'node_modules', '@deepseek-ai/dsh-core', 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-core', version: '2.0.0', main: './index.cjs',
    }))
    file(join(f.profile.dir, 'node_modules', '@deepseek-ai/dsh-core', 'index.cjs'), 'module.exports = {}\n')
    file(join(f.root, 'node_modules', '@deepseek-ai/dsh-core', 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-core', version: '3.0.0', exports: './index.cjs',
    }))
    file(join(f.root, 'node_modules', '@deepseek-ai/dsh-core', 'index.cjs'), 'module.exports = {}\n')
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(thrownError(() => require.resolve('@deepseek-ai/dsh-core/only-install.cjs')))
      .toMatchObject({ code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })

    const registration = installRuntimeInterception(resolution)
    registrations.push(registration)
    expect(require.resolve('@deepseek-ai/dsh-core/only-install.cjs')).toBe(installedSubpath)
  })

  it('observes a profile-local package installed after an earlier miss', async () => {
    const f = fixture()
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    const parent = pathToFileURL(join(f.profile.dir, 'entry.mjs')).href
    expect(() => { require.resolve('missing-local') }).toThrow(/Cannot find module/u)
    expect(() => resolveFrom('missing-local', parent)).toThrow(/Cannot find/u)
    file(join(f.profile.dir, 'node_modules', 'legacy-missing', 'index.js'), 'module.exports = {}\n')
    expect(() => { require.resolve('legacy-missing/subpath') }).toThrow(/Cannot find module/u)

    const local = join(f.profile.dir, 'node_modules', 'missing-local')
    pkg(local, 'missing-local', 7)
    expect(require.resolve('missing-local')).toBe(join(local, 'index.cjs'))
    expect(resolveFrom('missing-local', parent)).toBe(pathToFileURL(join(local, 'index.js')).href)
  })

  it('delegates undeclared local packages and non-package specifiers to Node', async () => {
    const f = fixture()
    pkg(join(f.profile.dir, 'node_modules', 'undeclared-local'), 'undeclared-local', 6)
    file(join(f.profile.dir, 'relative.cjs'), 'module.exports = 7\n')
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require('undeclared-local')).toEqual({ marker: 6 })
    expect(require('./relative.cjs')).toBe(7)
    expect(require('node:path')).toHaveProperty('join')
    expect(require('path')).toHaveProperty('join')
    const parent = pathToFileURL(join(f.profile.dir, 'undeclared-entry.mjs')).href
    expect(registration.packageDir('undeclared-local', parent))
      .toBe(join(f.profile.dir, 'node_modules', 'undeclared-local'))
    expect(registration.packageDir('undeclared-local', parent))
      .toBe(join(f.profile.dir, 'node_modules', 'undeclared-local'))
    expect(resolveFrom('undeclared-local', parent)).toBe(
      pathToFileURL(join(f.profile.dir, 'node_modules', 'undeclared-local', 'index.js')).href,
    )
    expect(await importFrom('undeclared-local', parent)).toMatchObject({ marker: 6 })
    expect(resolveFrom('node:path', undefined)).toBe('node:path')
    expect(resolveFrom('fs', parent)).toBe('node:fs')
    expect(resolveFrom('node:path', pathToFileURL(join(f.root, 'outside.mjs')).href, {}, true)).toBe('node:path')

    const addon = createRequire(import.meta.url)('node-addon-require-builtin') as { requireBuiltin(id: string): unknown }
    const internal = addon.requireBuiltin('internal/modules/cjs/loader') as {
      Module: {
        _resolveFilename(
          request: string, parent: { filename?: string } | undefined, isMain: boolean,
        ): string
      }
    }
    expect(internal.Module._resolveFilename('node:path', undefined, false)).toBe('node:path')
  })

  it('keeps a legacy CommonJS package without a manifest ahead of the resolution', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'node_modules', '@deepseek-ai/dsh-core', 'index.js'), 'module.exports = { marker: 2 }\n')
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    expect(createRequire(join(f.profile.dir, 'entry.cjs'))('@deepseek-ai/dsh-core')).toEqual({ marker: 2 })
  })

  it('keeps a manifestless local CommonJS subpath ahead of the resolution', async () => {
    const f = fixture()
    const localSubpath = join(f.profile.dir, 'node_modules', '@deepseek-ai/dsh-core', 'sub.cjs')
    file(localSubpath, 'module.exports = { marker: 2 }\n')
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require.resolve('@deepseek-ai/dsh-core/sub.cjs')).toBe(localSubpath)

    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    expect(require.resolve('@deepseek-ai/dsh-core/sub.cjs')).toBe(localSubpath)
  })

  it('keeps a local extensionless CommonJS package ahead of the resolution', async () => {
    const f = fixture()
    const local = join(f.profile.dir, 'node_modules', '@deepseek-ai/dsh-core')
    file(local, 'module.exports = { marker: 2 }\n')
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require.resolve('@deepseek-ai/dsh-core')).toBe(local)

    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    expect(require.resolve('@deepseek-ai/dsh-core')).toBe(local)
  })

  it('keeps a local legacy main outside its package directory ahead of the resolution', async () => {
    const f = fixture()
    const local = join(f.profile.dir, 'node_modules', '@deepseek-ai/dsh-core')
    const outside = join(f.profile.dir, 'node_modules', '@deepseek-ai', 'outside.cjs')
    file(join(local, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-core', main: '../outside.cjs' }))
    file(outside, 'module.exports = { marker: 2 }\n')
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require.resolve('@deepseek-ai/dsh-core')).toBe(outside)

    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    expect(require.resolve('@deepseek-ai/dsh-core')).toBe(outside)
  })

  it('keeps a missing local legacy main error ahead of the resolution', async () => {
    const f = fixture()
    const local = join(f.profile.dir, 'node_modules', '@deepseek-ai/dsh-core')
    file(join(local, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-core', main: './missing.cjs' }))
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    const nativeError = thrownError(() => require.resolve('@deepseek-ai/dsh-core'))
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    const runtimeError = thrownError(() => require.resolve('@deepseek-ai/dsh-core'))

    expect(runtimeError).toMatchObject({
      code: nativeError.code,
      path: nativeError.path,
      requestPath: nativeError.requestPath,
    })
    expect(runtimeError.message).toBe(nativeError.message)
  })

  it('keeps a profile-local CommonJS package file ahead of the resolution', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'node_modules', '@deepseek-ai/dsh-core.js'), 'module.exports = { marker: 2 }\n')
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    expect(createRequire(join(f.profile.dir, 'entry.cjs'))('@deepseek-ai/dsh-core')).toEqual({ marker: 2 })
    expect(resolveFrom('@deepseek-ai/dsh-core', pathToFileURL(join(f.profile.dir, 'entry.mjs')).href)).toBe(
      pathToFileURL(join(f.installed, 'index.js')).href,
    )
  })

  it('preserves the ESM and CommonJS behavior of an empty local package directory', async () => {
    const f = fixture()
    mkdirSync(join(f.profile.dir, 'node_modules', '@deepseek-ai/dsh-core'), { recursive: true })
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    expect(createRequire(join(f.profile.dir, 'entry.cjs'))('@deepseek-ai/dsh-core')).toEqual({ marker: 1 })
    expect(() => resolveFrom(
      '@deepseek-ai/dsh-core', pathToFileURL(join(f.profile.dir, 'entry.mjs')).href,
    )).toThrow(/Cannot find/u)
  })

  it('limits bundle-only interception to ordinary lookup in the active profile', async () => {
    const f = fixture()
    const bundleDir = join(f.root, 'bundle')
    pkg(bundleDir, 'test-bundle', 0, { 'bundle-only': '*' })
    const bundleOnly = join(bundleDir, 'node_modules', 'bundle-only')
    pkg(bundleOnly, 'bundle-only', 4)
    f.profile.layers.push({
      packageName: 'test-bundle',
      packageDir: bundleDir,
      patchPaths: [join(bundleDir, 'cordis.patch.yml')],
      patches: [],
    })
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    expect(createRequire(join(f.profile.dir, 'entry.cjs'))('bundle-only')).toEqual({ marker: 4 })
    const other = join(f.root, 'profiles', 'other', 'entry.cjs')
    expect(() => { createRequire(other)('bundle-only') }).toThrow(/Cannot find module/u)
    expect(thrownError(() => createRequire(other).resolve('bundle-only', {
      paths: [dirname(other), f.profile.dir],
    }))).toMatchObject({ code: 'MODULE_NOT_FOUND' })
    expect(() => createRequire(other).resolve('bundle-only', { paths: [dirname(other)] }))
      .toThrow(/Cannot find module/u)
    expect(() => createRequire(other).resolve('missing-explicit', { paths: [dirname(other)] }))
      .toThrow(/Cannot find module/u)
    file(join(f.root, 'node_modules', 'invalid-after-resolution', 'package.json'), '{')
    expect(() => createRequire(other).resolve('invalid-after-resolution', {
      paths: [dirname(other), f.profile.dir],
    })).toThrow(/Invalid package config/u)
    file(join(f.root, 'node_modules', 'invalid-explicit', 'package.json'), '{')
    expect(() => createRequire(other).resolve('invalid-explicit', {
      paths: [dirname(other), f.profile.dir],
    })).toThrow(/Invalid package config/u)
  })

  it('keeps the resolution ahead of packages above the shared fallback position', async () => {
    const f = fixture()
    pkg(join(f.root, 'node_modules', '@deepseek-ai/dsh-core'), '@deepseek-ai/dsh-core', 2)
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require('@deepseek-ai/dsh-core')).toEqual({ marker: 1 })
    expect(await importFrom('@deepseek-ai/dsh-core', pathToFileURL(join(f.profile.dir, 'entry.mjs')).href))
      .toMatchObject({ marker: 1 })
  })

  it('continues the original ancestor lookup after a resolution subpath miss', async () => {
    const f = fixture()
    const home = join(f.root, 'home')
    const profileDir = join(home, 'profiles', 'web')
    const profile = {
      ...f.profile,
      dir: profileDir,
      patchPath: join(profileDir, 'cordis.patch.yml'),
    }
    file(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }))
    file(join(profileDir, 'node_modules', '@deepseek-ai/dsh-core', 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-core', version: '2.0.0',
    }))
    file(join(f.installed, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-core', version: '1.0.0', type: 'module', main: './index.cjs',
    }))
    const ancestorSubpath = join(home, 'node_modules', '@deepseek-ai/dsh-core', 'sub.cjs')
    file(ancestorSubpath, 'module.exports = { marker: 3 }\n')
    const resolution = await createRuntimeResolution({
      installAnchor: f.installAnchor,
      profile,
      home,
    })
    const require = createRequire(join(profileDir, 'entry.cjs'))
    expect(() => require.resolve('@deepseek-ai/dsh-core')).toThrow(/Cannot find module/u)
    expect(require.resolve('@deepseek-ai/dsh-core/sub.cjs')).toBe(ancestorSubpath)

    const registration = installRuntimeInterception(resolution)
    registrations.push(registration)
    expect(require.resolve('@deepseek-ai/dsh-core')).toBe(join(f.installed, 'index.cjs'))
    expect(require.resolve('@deepseek-ai/dsh-core/sub.cjs')).toBe(ancestorSubpath)
  })

  it('uses later explicit CommonJS paths when the profile has no matching package', async () => {
    const f = fixture()
    file(join(f.installed, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-core', version: '1.0.0', type: 'module', main: './index.cjs',
    }))
    const alternative = join(f.root, 'alternative')
    const alternativeSubpath = join(alternative, 'node_modules', '@deepseek-ai/dsh-core', 'sub.cjs')
    file(alternativeSubpath, 'module.exports = { marker: 4 }\n')
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)

    expect(createRequire(join(f.profile.dir, 'entry.cjs')).resolve('@deepseek-ai/dsh-core/sub.cjs', {
      paths: [f.profile.dir, alternative],
    })).toBe(alternativeSubpath)
  })

  it('occupies the interception layer package directory for a resolution hit and continues above it on a CommonJS subpath miss', async () => {
    const f = fixture()
    file(join(f.installed, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-core', version: '1.0.0', main: './index.cjs',
    }))
    // Ordinary profile lookup replaces the shared copy with the runtime entry; explicit paths still read the shared copy.
    const shared = join(f.root, 'profiles', 'node_modules', '@deepseek-ai/dsh-core')
    file(join(shared, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-core', version: '9.0.0' }))
    file(join(shared, 'sub.cjs'), 'module.exports = { marker: 9 }\n')
    file(join(shared, 'sub.js'), 'module.exports = { marker: 9 }\n')
    const home = join(f.root, 'node_modules', '@deepseek-ai/dsh-core')
    file(join(home, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-core', version: '3.0.0' }))
    file(join(home, 'sub.cjs'), 'module.exports = { marker: 3 }\n')
    // A name without an entry sees the physical directory at the same layer.
    pkg(join(f.root, 'profiles', 'node_modules', 'left-pad'), 'left-pad', 9)
    pkg(join(f.root, 'node_modules', 'left-pad'), 'left-pad', 3)
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require.resolve('@deepseek-ai/dsh-core')).toBe(join(f.installed, 'index.cjs'))
    expect(require.resolve('@deepseek-ai/dsh-core/sub.cjs')).toBe(join(home, 'sub.cjs'))
    expect(require('@deepseek-ai/dsh-core/sub.cjs')).toEqual({ marker: 3 })
    expect(require.resolve('@deepseek-ai/dsh-core/sub.cjs', { paths: [f.profile.dir] })).toBe(join(shared, 'sub.cjs'))
    expect(require('left-pad')).toEqual({ marker: 9 })
    // ESM resolves the subpath inside the selected package and never consults another copy.
    const parent = pathToFileURL(join(f.profile.dir, 'entry.mjs')).href
    expect(resolveFrom('@deepseek-ai/dsh-core', parent)).toBe(pathToFileURL(join(f.installed, 'index.cjs')).href)
    await expect(importFrom('@deepseek-ai/dsh-core/sub.js', parent)).rejects.toMatchObject({ code: 'ERR_MODULE_NOT_FOUND' })
    expect(await importFrom('left-pad', parent)).toMatchObject({ marker: 9 })
  })

  it.each(['profile', 'plugin'] as const)('uses the installation DSH package from a %s while a stale shared link remains', async (importer) => {
    const name = '@deepseek-ai/dsh-core'
    const f = fixture(name)
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', private: true, dependencies: { [name]: '*' },
      imports: { '#library': name },
    }))
    const parentDir = importer === 'profile' ? f.profile.dir : join(f.profile.dir, 'node_modules', 'my-plugin')
    if (importer === 'plugin') {
      pkg(parentDir, 'my-plugin', 1, { [name]: '*' })
      file(join(parentDir, 'package.json'), JSON.stringify({
        name: 'my-plugin', type: 'module', dependencies: { [name]: '*' }, imports: { '#library': name },
      }))
    }
    const target = join(f.root, 'old-dsh', 'node_modules', name)
    pkg(target, name, 9)
    const shared = join(f.root, 'profiles', 'node_modules', name)
    mkdirSync(dirname(shared), { recursive: true })
    symlinkSync(target, shared, process.platform === 'win32' ? 'junction' : 'dir')
    const resolution = await resolutionOf(f)
    expect(resolution.localPackageNames).toEqual([])
    const registration = installRuntimeInterception(resolution)
    registrations.push(registration)
    const require = createRequire(join(parentDir, 'entry.cjs'))
    const parent = pathToFileURL(join(parentDir, 'entry.mjs')).href
    for (const specifier of [name, '#library']) {
      expect(require(specifier)).toEqual({ marker: 1 })
      expect(require.resolve(specifier)).toBe(join(f.installed, 'index.cjs'))
      expect(resolveFrom(specifier, parent)).toBe(pathToFileURL(join(f.installed, 'index.js')).href)
      expect(await importFrom(specifier, parent))
        .toMatchObject({ marker: 1 })
    }
    expect(registration.packageDir(name, parent)).toBe(f.installed)
    expect(realpathSync(shared)).toBe(target)
  })

  it('treats a profile symlink into .dsh-module-fallback as an ordinary local package', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', private: true, dependencies: { '@deepseek-ai/dsh-core': '*' },
    }))
    const target = join(f.root, 'old-dsh', 'node_modules', '@deepseek-ai', 'dsh-core')
    pkg(target, '@deepseek-ai/dsh-core', 9)
    const owned = join(f.profile.dir, '.dsh-module-fallback', 'node_modules', '@deepseek-ai/dsh-core')
    const projected = join(f.profile.dir, 'node_modules', '@deepseek-ai/dsh-core')
    mkdirSync(dirname(owned), { recursive: true })
    mkdirSync(dirname(projected), { recursive: true })
    symlinkSync(target, owned, process.platform === 'win32' ? 'junction' : 'dir')
    symlinkSync(owned, projected, process.platform === 'win32' ? 'junction' : 'dir')
    const resolution = await resolutionOf(f)
    expect(resolution.localPackageNames).toEqual(['@deepseek-ai/dsh-core'])
    const registration = installRuntimeInterception(resolution)
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    const parent = pathToFileURL(join(f.profile.dir, 'entry.mjs')).href
    expect(require('@deepseek-ai/dsh-core')).toEqual({ marker: 9 })
    expect(require.resolve('@deepseek-ai/dsh-core')).toBe(join(target, 'index.cjs'))
    expect(resolveFrom('@deepseek-ai/dsh-core', parent)).toBe(pathToFileURL(join(target, 'index.js')).href)
    expect(await importFrom('@deepseek-ai/dsh-core', parent)).toMatchObject({ marker: 9 })
    expect(registration.packageDir('@deepseek-ai/dsh-core', parent)).toBe(projected)
    expect(realpathSync(projected)).toBe(target)
  })

  it.each(['directory', 'symlink'] as const)('resolves an unlisted shared %s and its nested dependencies without changing profile files', async (layout) => {
    const f = fixture()
    const plugin = 'my-plugin'
    const dependency = 'external-dependency'
    const middle = 'external-middle'
    const leaf = 'external-leaf'
    const pluginDir = join(f.profile.dir, 'node_modules', plugin)
    const shared = join(f.root, 'profiles', 'node_modules', dependency)
    const selected = layout === 'directory' ? shared : join(f.root, 'workspace', dependency)
    const middleDir = join(selected, 'node_modules', middle)
    const leafDir = join(middleDir, 'node_modules', leaf)
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', private: true, dependencies: { [plugin]: '*' },
    }))
    pkg(pluginDir, plugin, 1, { [dependency]: '*' })
    pkg(selected, dependency, 2, { [middle]: '*' })
    pkg(middleDir, middle, 3, { [leaf]: '*' })
    pkg(leafDir, leaf, 4)
    pkg(join(selected, 'node_modules', leaf), leaf, 8)
    pkg(join(f.root, 'node_modules', dependency), dependency, 9)
    file(join(pluginDir, 'index.js'), `import * as external from '${dependency}'\nexport { external }\n`)
    file(join(pluginDir, 'index.cjs'), `module.exports = { external: require('${dependency}') }\n`)
    for (const [dir, child] of [[selected, middle], [middleDir, leaf]] as const) {
      file(join(dir, 'index.js'), `import * as child from '${child}'\nexport { child }\nexport const url = import.meta.url\n`)
      file(join(dir, 'index.cjs'), `module.exports = { filename: __filename, child: require('${child}') }\n`)
    }
    file(join(leafDir, 'index.js'), 'export const marker = 4\nexport const url = import.meta.url\n')
    file(join(leafDir, 'index.cjs'), 'module.exports = { marker: 4, filename: __filename }\n')
    if (layout === 'symlink') {
      mkdirSync(dirname(shared), { recursive: true })
      symlinkSync(selected, shared, process.platform === 'win32' ? 'junction' : 'dir')
    }
    const resolution = await resolutionOf(f)
    expect(resolution.entries.some(entry => [dependency, middle, leaf].includes(entry.name))).toBe(false)
    const registration = installRuntimeInterception(resolution)
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    const parent = pathToFileURL(join(f.profile.dir, 'entry.mjs')).href
    expect(require(plugin)).toEqual({
      external: { filename: join(selected, 'index.cjs'), child: {
        filename: join(middleDir, 'index.cjs'), child: { marker: 4, filename: join(leafDir, 'index.cjs') },
      } },
    })
    expect(await importFrom(plugin, parent)).toMatchObject({
      external: { url: pathToFileURL(join(selected, 'index.js')).href, child: {
        url: pathToFileURL(join(middleDir, 'index.js')).href,
        child: { marker: 4, url: pathToFileURL(join(leafDir, 'index.js')).href },
      } },
    })
    expect(require.resolve(dependency, { paths: [pluginDir] })).toBe(join(selected, 'index.cjs'))
    expect(registration.packageDir(dependency, pathToFileURL(join(pluginDir, 'index.js')).href)).toBe(shared)
    expect(realpathSync(shared)).toBe(selected)
    expect(existsSync(join(pluginDir, 'package.json'))).toBe(true)
    expect(existsSync(join(leafDir, 'package.json'))).toBe(true)
  })

  it('loads the selected bundle plugin after a link-backend projection of a deselected bundle is removed', async () => {
    const f = fixture()
    const profileDir = join(f.root, 'profiles', 'web')
    const modules = join(profileDir, 'node_modules')
    const plugin = 'shared-plugin'
    for (const [bundle, marker] of [['bundle-a', 1], ['bundle-b', 2]] as const) {
      file(join(modules, bundle, 'package.json'), JSON.stringify({
        name: bundle, version: '1.0.0', dependencies: { [plugin]: '*' }, dsh: { bundle: { patch: './cordis.patch.yml' } },
      }))
      file(join(modules, bundle, 'cordis.patch.yml'), '[]\n')
      pkg(join(modules, bundle, 'node_modules', plugin), plugin, marker)
    }
    // A link-backend launch projected bundle-a's plugin while bundle-a was selected.
    const owned = join(profileDir, '.dsh-module-fallback', 'node_modules', plugin)
    mkdirSync(dirname(owned), { recursive: true })
    symlinkSync(join(modules, 'bundle-a', 'node_modules', plugin), owned, process.platform === 'win32' ? 'junction' : 'dir')
    symlinkSync(owned, join(modules, plugin), process.platform === 'win32' ? 'junction' : 'dir')
    file(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', private: true,
      dependencies: { 'bundle-a': '*', 'bundle-b': '*' },
      dsh: { profile: { bundles: ['bundle-b'] } },
    }))

    const profile = loadProfile('dsh', 'web', f.installAnchor, f.root)
    expect(profile.layers.map(layer => layer.packageName)).toEqual(['bundle-b'])
    expect(existsSync(join(profileDir, '.dsh-module-fallback'))).toBe(false)
    expect(existsSync(join(modules, plugin))).toBe(false)
    const resolution = await createRuntimeResolution({ installAnchor: f.installAnchor, profile, home: f.root })
    expect(resolution.entries.find(entry => entry.name === plugin)).toMatchObject({
      packageDir: join(modules, 'bundle-b', 'node_modules', plugin), version: '2.0.0', scope: 'profile',
    })
    const registration = installRuntimeInterception(resolution)
    registrations.push(registration)
    expect(createRequire(join(profileDir, 'entry.cjs'))(plugin)).toEqual({ marker: 2 })
    expect(await importFrom(plugin, pathToFileURL(join(profileDir, 'entry.mjs')).href)).toMatchObject({ marker: 2 })
    expect(existsSync(join(modules, 'bundle-a', 'node_modules', plugin, 'package.json'))).toBe(true)
  })

  it('follows profile node_modules symlinks during selected bundle dependency traversal', async () => {
    const f = fixture()
    const bundle = join(f.profile.dir, 'node_modules', 'my-bundle')
    pkg(bundle, 'my-bundle', 1, { 'bridge': '*' })
    f.profile.layers.push({
      packageName: 'my-bundle', packageDir: bundle,
      patchPaths: [join(bundle, 'cordis.patch.yml')], patches: [],
    })
    const target = join(f.root, 'old-dsh', 'node_modules', 'bridge')
    const owned = join(f.profile.dir, '.dsh-module-fallback', 'node_modules', 'bridge')
    const projected = join(f.profile.dir, 'node_modules', 'bridge')
    pkg(target, 'bridge', 9)
    mkdirSync(dirname(owned), { recursive: true })
    symlinkSync(target, owned, process.platform === 'win32' ? 'junction' : 'dir')
    symlinkSync(owned, projected, process.platform === 'win32' ? 'junction' : 'dir')
    const ancestor = join(f.root, 'node_modules', 'bridge')
    pkg(ancestor, 'bridge', 3)
    const resolution = await resolutionOf(f)
    expect(resolution.entries.find(entry => entry.name === 'bridge'))
      .toMatchObject({ packageDir: projected, version: '9.0.0', scope: 'profile' })
    expect(realpathSync(projected)).toBe(target)
  })

  it.each(lookupMatrix())('$title', async (matrixCase) => {
    const { importer, kind, layers, form } = matrixCase
    const name = { installation: '@deepseek-ai/dsh-core', bundle: 'bridge', unlisted: 'left-pad' }[kind]
    const f = fixture()
    const pluginDir = join(f.profile.dir, 'node_modules', 'my-plugin')
    pkg(pluginDir, 'my-plugin', 0)
    const bundleDir = join(f.profile.dir, 'node_modules', 'my-bundle')
    pkg(bundleDir, 'my-bundle', 0, { 'bridge': '*' })
    const bundleLib = join(bundleDir, 'node_modules', 'bridge')
    pkg(bundleLib, 'bridge', 2)
    f.profile.layers.push({
      packageName: 'my-bundle', packageDir: bundleDir,
      patchPaths: [join(bundleDir, 'cordis.patch.yml')], patches: [],
    })
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', private: true, dependencies: { 'my-plugin': '*', 'my-bundle': '*' },
    }))
    const logical: Record<LookupLayer, string> = {
      private: join(pluginDir, 'node_modules', name),
      profile: join(f.profile.dir, 'node_modules', name),
      shared: join(f.root, 'profiles', 'node_modules', name),
      home: join(f.root, 'node_modules', name),
    }
    const real = { ...logical }
    for (const layer of layers) {
      if (form === 'symlink' && (layer === 'profile' || layer === 'shared')) {
        real[layer] = join(f.root, 'linked', layer, name)
        pkg(real[layer], name, LOOKUP_MARKERS[layer])
        mkdirSync(dirname(logical[layer]), { recursive: true })
        symlinkSync(real[layer], logical[layer], process.platform === 'win32' ? 'junction' : 'dir')
      } else {
        pkg(logical[layer], name, LOOKUP_MARKERS[layer])
      }
    }
    const resolution = await resolutionOf(f)
    expect(resolution.entries.find(entry => entry.name === name)?.scope)
      .toBe(kind === 'installation' ? 'installation' : kind === 'bundle' ? 'profile' : undefined)
    const registration = installRuntimeInterception(resolution)
    registrations.push(registration)
    const importerDir = importer === 'plugin' ? pluginDir : f.profile.dir
    const require = createRequire(join(importerDir, 'entry.cjs'))
    const parent = pathToFileURL(join(importerDir, 'entry.mjs')).href
    const explicitWinner = LOOKUP_LAYERS.find(layer => (
      layers.includes(layer) && (layer !== 'private' || importer === 'plugin')
    ))
    if (explicitWinner === undefined) {
      expect(thrownError(() => require.resolve(name, { paths: [importerDir] })))
        .toMatchObject({ code: 'MODULE_NOT_FOUND' })
    } else {
      expect(require.resolve(name, { paths: [importerDir] })).toBe(join(real[explicitWinner], 'index.cjs'))
    }
    const winner = lookupWinner(matrixCase)
    if (winner === 'missing') {
      expect(thrownError(() => require(name))).toMatchObject({ code: 'MODULE_NOT_FOUND' })
      await expect(importFrom(name, parent)).rejects.toMatchObject({ code: 'ERR_MODULE_NOT_FOUND' })
      expect(registration.packageDir(name, parent)).toBeUndefined()
      return
    }
    const packageDir = winner === 'interception'
      ? (kind === 'installation' ? f.installed : bundleLib)
      : logical[winner]
    const realDir = winner === 'interception' ? packageDir : real[winner]
    const marker = winner === 'interception' ? (kind === 'installation' ? 1 : 2) : LOOKUP_MARKERS[winner]
    expect(require(name)).toEqual({ marker })
    expect(require.resolve(name)).toBe(join(realDir, 'index.cjs'))
    expect(resolveFrom(name, parent)).toBe(pathToFileURL(join(realDir, 'index.js')).href)
    expect(await importFrom(name, parent)).toMatchObject({ marker })
    expect(registration.packageDir(name, parent)).toBe(packageDir)
  })

  it('uses shared packages in the canonicalized profiles tree before its ancestors', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-profile-resolution-symlink-')))
    roots.push(root)
    const carrier = join(root, 'carrier')
    const profilesDir = join(root, 'home', 'profiles')
    const realProfilesDir = join(carrier, 'profiles')
    const realProfileDir = join(realProfilesDir, 'web')
    mkdirSync(realProfileDir, { recursive: true })
    mkdirSync(dirname(profilesDir), { recursive: true })
    symlinkSync(realProfilesDir, profilesDir, process.platform === 'win32' ? 'junction' : 'dir')
    pkg(join(realProfilesDir, 'node_modules', 'left-pad'), 'left-pad', 9)
    const ancestor = join(carrier, 'node_modules', 'left-pad')
    pkg(ancestor, 'left-pad', 3)
    pkg(join(root, 'home', 'node_modules', 'left-pad'), 'left-pad', 4)
    const registration = installRuntimeInterception({
      profilesDir,
      profileDir: join(profilesDir, 'web'),
      localPackageNames: [],
      linkedRoots: [],
      entries: [],
    })
    registrations.push(registration)
    const require = createRequire(join(realProfileDir, 'entry.cjs'))
    expect(require('left-pad')).toEqual({ marker: 9 })
    const parent = pathToFileURL(join(realProfileDir, 'entry.mjs')).href
    expect(await importFrom('left-pad', parent)).toMatchObject({ marker: 9 })
    expect(registration.packageDir('left-pad', parent)).toBe(join(realProfilesDir, 'node_modules', 'left-pad'))
  })

  it('leaves conditional exports to Node', async () => {
    const f = fixture('conditional-lib')
    conditionalPkg(f.installed, 'conditional-lib', 11, 12)
    const local = join(f.profile.dir, 'node_modules', 'conditional-lib')
    conditionalPkg(local, 'conditional-lib', 21, 22)
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    expect(await importFrom('conditional-lib', pathToFileURL(join(f.profile.dir, 'entry.mjs')).href))
      .toMatchObject({ marker: 21 })
    const addon = createRequire(import.meta.url)('node-addon-require-builtin') as { requireBuiltin(id: string): unknown }
    const internal = addon.requireBuiltin('internal/modules/cjs/loader') as {
      Module: {
        new(id?: string): { filename?: string; paths?: string[] }
        _nodeModulePaths(path: string): string[]
        _resolveFilename(
          request: string,
          parent: { filename?: string; paths?: string[] },
          isMain: boolean,
          options: { conditions: Set<string> },
        ): string
      }
    }
    const parentFile = join(f.profile.dir, 'conditional-entry.cjs')
    const parent = new internal.Module(parentFile)
    parent.filename = parentFile
    parent.paths = internal.Module._nodeModulePaths(f.profile.dir)
    expect(internal.Module._resolveFilename(
      'conditional-lib', parent, false, { conditions: new Set(['node', 'require', 'custom']) },
    )).toBe(join(local, 'custom.cjs'))
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require('conditional-lib')).toEqual({ marker: 22 })
    expect(require.resolve('conditional-lib')).toBe(join(local, 'require.cjs'))
  })

  it('passes explicit CommonJS conditions to the resolution target', async () => {
    const f = fixture('conditional-lib')
    conditionalPkg(f.installed, 'conditional-lib', 11, 12)
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    const addon = createRequire(import.meta.url)('node-addon-require-builtin') as { requireBuiltin(id: string): unknown }
    const internal = addon.requireBuiltin('internal/modules/cjs/loader') as {
      Module: {
        new(id?: string): { filename?: string; paths?: string[] }
        _nodeModulePaths(path: string): string[]
        _resolveFilename(
          request: string,
          parent: { filename?: string; paths?: string[] },
          isMain: boolean,
          options: { conditions: Set<string> },
        ): string
      }
    }
    const parentFile = join(f.profile.dir, 'conditional-entry.cjs')
    const parent = new internal.Module(parentFile)
    parent.filename = parentFile
    parent.paths = internal.Module._nodeModulePaths(f.profile.dir)

    expect(internal.Module._resolveFilename(
      'conditional-lib', parent, false, { conditions: new Set(['node', 'require', 'custom']) },
    )).toBe(join(f.installed, 'custom.cjs'))
  })

  it('does not attach routed CommonJS anchors to the importing module', async () => {
    const f = fixture()
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    const addon = createRequire(import.meta.url)('node-addon-require-builtin') as { requireBuiltin(id: string): unknown }
    const internal = addon.requireBuiltin('internal/modules/cjs/loader') as {
      Module: {
        new(id?: string): { children: unknown[]; filename?: string; paths?: string[] }
        _nodeModulePaths(path: string): string[]
        _resolveFilename(
          request: string,
          parent: { children: unknown[]; filename?: string; paths?: string[] },
          isMain: boolean,
        ): string
      }
    }
    const parentFile = join(f.profile.dir, 'entry.cjs')
    const parent = new internal.Module(parentFile)
    parent.filename = parentFile
    parent.paths = internal.Module._nodeModulePaths(f.profile.dir)
    const originalChildren = [...parent.children]

    expect(internal.Module._resolveFilename('@deepseek-ai/dsh-core', parent, false)).toBe(join(f.installed, 'index.cjs'))
    expect(parent.children).toEqual(originalChildren)
  })

  it('reports routed CommonJS failures with the native require stack', async () => {
    const f = fixture()
    file(join(f.installed, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-core', version: '1.0.0', type: 'module', main: './index.cjs',
    }))
    const resolution = await createRuntimeResolution({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    const nativeRequire = createRequire(join(f.profile.dir, 'entry-native.cjs'))
    const nativeError = thrownError(() => nativeRequire.resolve('@deepseek-ai/dsh-core/missing.cjs'))
    const registration = installRuntimeInterception(resolution)
    registrations.push(registration)
    const runtimeRequire = createRequire(join(f.profile.dir, 'entry-runtime.cjs'))
    const runtimeError = thrownError(() => runtimeRequire.resolve('@deepseek-ai/dsh-core/missing.cjs'))

    expect(runtimeError.requireStack).toEqual([
      join(f.profile.dir, 'entry-runtime.cjs'),
    ])
    expect(runtimeError.message).not.toContain(f.installAnchor)
    expect(nativeError.requireStack).toEqual([join(f.profile.dir, 'entry-native.cjs')])
  })

  it('reports routed ESM failures from the original importer', async () => {
    const f = fixture()
    const parent = pathToFileURL(join(f.profile.dir, 'entry.mjs')).href
    const nativeMessage = thrownMessage(() => resolveFrom('unavailable-lib', parent))
    const resolution = await createRuntimeResolution({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    const registration = installRuntimeInterception(resolution)
    registrations.push(registration)

    expect(thrownMessage(() => resolveFrom('unavailable-lib', parent))).toBe(nativeMessage)
    expect(thrownMessage(() => resolveFrom('@deepseek-ai/dsh-core/private', parent)))
      .toContain(` imported from ${fileURLToPath(parent)}`)
  })

  it('reports routed ESM failures from the original importer when Node returns a read-only stack', async () => {
    const f = fixture()
    const parent = pathToFileURL(join(f.profile.dir, 'entry.mjs')).href
    const nativeMessage = thrownMessage(() => resolveFrom('unavailable-lib', parent))
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    const hooks = registerHooksThreadStacks()
    try {
      const missing = thrownError(() => resolveFrom('unavailable-lib', parent))
      expect(missing).toMatchObject({ code: 'ERR_MODULE_NOT_FOUND', message: nativeMessage })
      expect(missing.stack).toContain(nativeMessage)
      const unexported = thrownError(() => resolveFrom('@deepseek-ai/dsh-core/private', parent))
      expect(unexported.code).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED')
      expect(unexported.message).toContain(` imported from ${fileURLToPath(parent)}`)
      expect(unexported.stack).toContain(unexported.message)
      const imported = importFrom('@deepseek-ai/dsh-core/private', parent)
      await expect(imported).rejects.toMatchObject({ code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
      await expect(imported).rejects.toThrow(` imported from ${fileURLToPath(parent)}`)
    } finally {
      hooks.deregister()
    }
  })

  it('leaves an invalid resolution manifest error to Node', async () => {
    const f = fixture()
    const resolution = await createRuntimeResolution({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    file(join(f.installed, 'package.json'), '{')
    const parent = pathToFileURL(join(f.profile.dir, 'entry.mjs')).href
    expect(() => resolveFrom('@deepseek-ai/dsh-core', pathToFileURL(f.installAnchor).href))
      .toThrow(/Invalid package config/u)
    const registration = installRuntimeInterception(resolution)
    registrations.push(registration)

    expect(() => resolveFrom('@deepseek-ai/dsh-core', parent)).toThrow(/Invalid package config/u)
  })

  it('does not fall back after Node selects a broken profile-local package', async () => {
    const f = fixture('broken-lib')
    file(join(f.profile.dir, 'node_modules', 'broken-lib', 'package.json'), JSON.stringify({
      name: 'broken-lib',
      exports: './missing.js',
    }))
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(() => { require('broken-lib') }).toThrow(/Cannot find module|could not find/u)
    await expect(importFrom(
      'broken-lib', pathToFileURL(join(f.profile.dir, 'broken-entry.mjs')).href,
    )).rejects.toThrow(/Cannot find module|Cannot find package/u)
  })

  it('does not fall back after the resolution selects a missing exports target', async () => {
    const f = fixture()
    file(join(f.installed, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-core', version: '1.0.0', type: 'module', exports: './missing.cjs',
    }))
    pkg(join(f.root, 'node_modules', '@deepseek-ai/dsh-core'), '@deepseek-ai/dsh-core', 2)
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)

    expect(() => createRequire(join(f.profile.dir, 'entry.cjs')).resolve('@deepseek-ai/dsh-core'))
      .toThrow(/Cannot find module/u)
  })

  it('does not fall back after the resolution selects a missing legacy main', async () => {
    const f = fixture()
    file(join(f.installed, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-core', version: '1.0.0', type: 'module', main: './missing.cjs',
    }))
    unlinkSync(join(f.installed, 'index.cjs'))
    unlinkSync(join(f.installed, 'index.js'))
    pkg(join(f.root, 'node_modules', '@deepseek-ai/dsh-core'), '@deepseek-ai/dsh-core', 2)
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)

    expect(() => createRequire(join(f.profile.dir, 'entry.cjs')).resolve('@deepseek-ai/dsh-core'))
      .toThrow(/valid "main" entry/u)
  })

  it('publishes an additive resolution and replaces its miss cache atomically', async () => {
    const f = fixture()
    const added = join(f.root, 'added')
    pkg(added, 'added-lib', 2)
    const first = await resolutionOf(f)
    const registration = installRuntimeInterception(first)
    registrations.push(registration)
    const parent = pathToFileURL(join(f.profile.dir, 'entry.mjs')).href
    expect(registration.packageDir('added-lib', parent)).toBeUndefined()
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    registration.replace({
      ...first,
      entries: [...first.entries, {
        name: 'added-lib', packageDir: added, version: '2.0.0',
        declarer: join(added, 'package.json'), scope: 'installation',
      }],
    })
    expect(registration.packageDir('added-lib', parent)).toBe(added)
    expect(require.resolve('added-lib')).toBe(join(added, 'index.cjs'))
    expect(resolveFrom('added-lib', parent)).toBe(pathToFileURL(join(added, 'index.js')).href)
  })

  it('rejects changing an existing package mapping without publishing it', async () => {
    const f = fixture()
    const second = join(f.root, 'second')
    pkg(second, '@deepseek-ai/dsh-core', 2)
    const first = await resolutionOf(f)
    const registration = installRuntimeInterception(first)
    registrations.push(registration)
    const alias = join(f.root, 'dsh-core-alias')
    symlinkSync(f.installed, alias, process.platform === 'win32' ? 'junction' : 'dir')
    registration.replace({
      ...first,
      entries: first.entries.map(entry => entry.name === '@deepseek-ai/dsh-core'
        ? { ...entry, packageDir: alias }
        : entry),
    })
    const changed = {
      ...first,
      entries: first.entries.map(entry => entry.name === '@deepseek-ai/dsh-core'
        ? { ...entry, packageDir: second, version: '2.0.0', declarer: join(second, 'package.json') }
        : entry),
    }
    expect(() => { registration.replace(changed) }).toThrow(/requires a process restart/u)
    expect(() => {
      registration.replace({
        ...first,
        entries: first.entries.map(entry => entry.name === '@deepseek-ai/dsh-core'
          ? { ...entry, version: '9.0.0' }
          : entry),
      })
    }).toThrow(/requires a process restart/u)
    expect(() => {
      registration.replace({ ...first, localPackageNames: ['@deepseek-ai/dsh-core'] })
    }).toThrow(/requires a process restart/u)
    expect(() => {
      registration.replace({ ...first, entries: first.entries.filter(entry => entry.name !== '@deepseek-ai/dsh-core') })
    }).toThrow(/requires a process restart/u)
    expect(() => {
      registration.replace({ ...first, profilesDir: join(f.root, 'other-profiles') })
    }).toThrow(/cannot change its profile scope/u)
    registration.replace({ ...first, localPackageNames: ['new-local'] })
    registration.replace({ ...first, localPackageNames: ['new-local'] })
    expect(() => { registration.replace(first) }).toThrow(/removing local package/u)
    const linked = { name: 'linked-plugin', realPath: join(f.root, 'work', 'a') }
    const withLocal = { ...first, localPackageNames: ['new-local'] }
    registration.replace({ ...withLocal, linkedRoots: [linked] })
    registration.replace({ ...withLocal, linkedRoots: [] })
    registration.replace({ ...withLocal, linkedRoots: [linked] })
    expect(() => {
      registration.replace({ ...withLocal, linkedRoots: [{ ...linked, realPath: join(f.root, 'work', 'b') }] })
    }).toThrow(/relinking "linked-plugin" requires a process restart/u)
    expect(registration.packageDir(
      '@deepseek-ai/dsh-core', pathToFileURL(join(f.profile.dir, 'entry.mjs')).href,
    )).toBe(f.installed)
  })

  it('leaves non-package and out-of-scope metadata lookups to native resolution', async () => {
    const f = fixture()
    const outside = join(f.root, 'outside')
    const outsidePackage = join(outside, 'node_modules', 'outside-lib')
    pkg(outsidePackage, 'outside-lib', 5)
    const scopedPackage = join(outside, 'node_modules', '@scope', 'outside')
    pkg(scopedPackage, '@scope/outside', 6)
    const ancestorPackage = join(f.root, 'node_modules', 'ancestor-lib')
    pkg(ancestorPackage, 'ancestor-lib', 7)
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    const profileParent = pathToFileURL(join(f.profile.dir, 'entry.mjs')).href
    const outsideParent = pathToFileURL(join(outside, 'entry.mjs')).href
    expect(registration.packageDir('', profileParent)).toBeUndefined()
    expect(registration.packageDir('./local.js', profileParent)).toBeUndefined()
    expect(registration.packageDir('/absolute.js', profileParent)).toBeUndefined()
    expect(registration.packageDir('\\server\\share', profileParent)).toBeUndefined()
    expect(registration.packageDir('#internal', profileParent)).toBeUndefined()
    expect(registration.packageDir('@scope', profileParent)).toBeUndefined()
    expect(registration.packageDir('node:fs', profileParent)).toBeUndefined()
    expect(registration.packageDir('@deepseek-ai/dsh-core/private', profileParent)).toBe(f.installed)
    expect(registration.packageDir('outside-lib', outsideParent)).toBe(outsidePackage)
    expect(registration.packageDir('outside-lib', outsideParent)).toBe(outsidePackage)
    expect(registration.packageDir('@scope/outside', outsideParent)).toBe(scopedPackage)
    expect(registration.packageDir('@scope/outside/private', outsideParent)).toBe(scopedPackage)
    expect(registration.packageDir('ancestor-lib', profileParent)).toBe(ancestorPackage)
    expect(registration.packageDir('ancestor-lib', profileParent)).toBe(ancestorPackage)
    expect(resolveFrom('outside-lib', outsideParent)).toBe(pathToFileURL(join(outsidePackage, 'index.js')).href)
    expect(resolveFrom('outside-lib', outsideParent)).toBe(pathToFileURL(join(outsidePackage, 'index.js')).href)
    expect(registration.packageDir('missing', `${pathToFileURL(f.profile.dir).href}/%ZZ`)).toBeUndefined()
  })

  it('leaves the published resolution intact when successor construction fails', async () => {
    const f = fixture()
    const first = await resolutionOf(f)
    const registration = installRuntimeInterception(first)
    registrations.push(registration)
    await expect(createRuntimeResolution({
      installAnchor: join(f.root, 'missing', 'package.json'),
      profile: f.profile,
      home: f.root,
    })).rejects.toThrow()
    expect(registration.packageDir(
      '@deepseek-ai/dsh-core', pathToFileURL(join(f.profile.dir, 'entry.mjs')).href,
    )).toBe(f.installed)
  })

  it('publishes and restores the resolution inherited by owned Workers', async () => {
    const f = fixture()
    const resolution = await resolutionOf(f)
    const key = '@deepseek-ai/dsh-app-boot/profile-resolution'
    const previous = getEnvironmentData(key)
    const dispose = registerWorkerResolution(resolution)
    try {
      expect(getEnvironmentData(key)).toEqual({ resolution })
    } finally {
      dispose()
    }
    expect(getEnvironmentData(key)).toBe(previous)
  })

  it('records active profile links to external directories with or without manifests', async () => {
    const f = fixture()
    const modules = join(f.profile.dir, 'node_modules')
    const outside = join(f.root, 'work', 'my-plugin')
    pkg(outside, 'my-plugin', 5)
    const scopedOutside = join(f.root, 'work', 'scoped')
    pkg(scopedOutside, '@scope/linked', 6)
    const inside = join(f.root, 'profiles', 'node_modules', 'inside-lib')
    pkg(inside, 'inside-lib', 7)
    const bare = join(f.root, 'work', 'bare')
    mkdirSync(bare, { recursive: true })
    const dangling = join(f.root, 'work', 'dangling')
    mkdirSync(dangling, { recursive: true })
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    mkdirSync(join(modules, '@scope'), { recursive: true })
    symlinkSync(outside, join(modules, 'my-plugin'), linkType)
    symlinkSync(scopedOutside, join(modules, '@scope', 'linked'), linkType)
    symlinkSync(inside, join(modules, 'inside-lib'), linkType)
    symlinkSync(join(f.root, 'profiles'), join(modules, 'profiles-root'), linkType)
    symlinkSync(bare, join(modules, 'bare-dir'), linkType)
    symlinkSync(dangling, join(modules, 'dangling'), linkType)
    rmSync(dangling, { recursive: true })
    pkg(join(modules, 'installed'), 'installed', 8)
    const resolution = await resolutionOf(f)
    expect(resolution.linkedRoots).toEqual([
      { name: '@scope/linked', realPath: scopedOutside },
      { name: 'bare-dir', realPath: bare },
      { name: 'my-plugin', realPath: outside },
    ])
    expect(Object.isFrozen(resolution.linkedRoots)).toBe(true)
    expect(Object.isFrozen(resolution.linkedRoots[0])).toBe(true)
    const withoutProfile = await createRuntimeResolution({ installAnchor: f.installAnchor, home: f.root })
    expect(withoutProfile.linkedRoots).toEqual([])
    const unmaterialized = await createRuntimeResolution({
      installAnchor: f.installAnchor,
      profile: { ...f.profile, dir: join(f.root, 'later', 'profiles', 'web') },
      home: join(f.root, 'later'),
    })
    expect(unmaterialized.linkedRoots).toEqual([])
  })

  it.each([
    { layout: 'directory', sharedTree: 'present' },
    { layout: 'symlink', sharedTree: 'present' },
    { layout: 'directory', sharedTree: 'missing' },
    { layout: 'symlink', sharedTree: 'missing' },
  ])(
    'excludes a $layout application-owned profile and its pnpm packages from linked roots ($sharedTree shared tree)', async ({ layout, sharedTree }) => {
      const f = fixture()
      const realProfile = join(f.root, 'application-profile')
      const profileDir = layout === 'symlink' ? join(f.root, 'application-profile-alias') : realProfile
      file(join(realProfile, 'package.json'), JSON.stringify({ name: 'application-profile', private: true }))
      const local = join(realProfile, 'node_modules', '.pnpm', 'local@1.0.0', 'node_modules', 'local')
      pkg(local, 'local', 2)
      const outside = join(f.root, 'external-plugin')
      pkg(outside, 'external-plugin', 3)
      const shared = join(f.root, 'profiles', 'node_modules', 'shared-package')
      pkg(shared, 'shared-package', 4)
      const linkType = process.platform === 'win32' ? 'junction' : 'dir'
      const links: string[] = []
      try {
        if (layout === 'symlink') {
          symlinkSync(realProfile, profileDir, linkType)
          links.push(profileDir)
        }
        for (const [name, target] of [
          ['local', join(profileDir, 'node_modules', '.pnpm', 'local@1.0.0', 'node_modules', 'local')],
          ['profile-self', profileDir],
          ['profile-real', realProfile],
          ['external-plugin', outside],
          ['shared-package', shared],
        ] as const) {
          const link = join(profileDir, 'node_modules', name)
          symlinkSync(target, link, linkType)
          links.push(link)
        }
        if (sharedTree === 'missing') rmSync(join(f.root, 'profiles'), { recursive: true })
        const resolution = await createRuntimeResolution({
          installAnchor: f.installAnchor,
          profile: { ...f.profile, dir: profileDir, patchPath: join(profileDir, 'cordis.patch.yml') },
          home: f.root,
        })
        expect(resolution.linkedRoots).toEqual([{ name: 'external-plugin', realPath: outside }])
      } finally {
        for (const link of links.reverse()) unlinkSync(link)
      }
    },
  )

  it.each(['unmaterialized', 'empty'] as const)(
    'leaves an %s application-owned profile without linked roots', async (state) => {
      const f = fixture()
      const dir = join(f.root, 'application-profile')
      if (state === 'empty') mkdirSync(join(dir, 'node_modules'), { recursive: true })
      const resolution = await createRuntimeResolution({
        installAnchor: f.installAnchor,
        profile: { ...f.profile, dir, patchPath: join(dir, 'cordis.patch.yml') },
        home: f.root,
      })
      expect(resolution.linkedRoots).toEqual([])
    },
  )

  it('excludes profile symlinks to files from linked roots', async () => {
    const f = fixture()
    const modules = join(f.profile.dir, 'node_modules')
    const target = join(f.root, 'work', 'file.cjs')
    file(target, 'module.exports = { marker: 5 }\n')
    mkdirSync(join(modules, '@scope'), { recursive: true })
    symlinkSync(target, join(modules, 'file-link'), 'file')
    symlinkSync(target, join(modules, '@scope', 'file-link'), 'file')

    const resolution = await resolutionOf(f)
    expect(resolution.linkedRoots).toEqual([])
  })

  it.each(['linked target', 'profiles directory'] as const)(
    'reports a cyclic %s with the original Node error and path', async (location) => {
      const f = fixture()
      const home = location === 'profiles directory' ? join(f.root, 'cycle-home') : f.root
      const modules = join(f.profile.dir, 'node_modules')
      const outside = join(f.root, 'external-directory')
      mkdirSync(outside, { recursive: true })
      mkdirSync(modules, { recursive: true })
      const cycle = location === 'profiles directory' ? join(home, 'profiles') : join(modules, 'cycle')
      mkdirSync(dirname(cycle), { recursive: true })
      const linkType = process.platform === 'win32' ? 'junction' : 'dir'
      const links: string[] = []
      try {
        const ordinaryLink = join(modules, 'external-directory')
        symlinkSync(outside, ordinaryLink, linkType)
        links.push(ordinaryLink)
        symlinkSync(cycle, cycle, linkType)
        links.push(cycle)
        const nativeError = thrownError(() => realpathSync.native(cycle))
        expect(nativeError.code).toBe('ELOOP')
        expect(nativeError.path).toBe(cycle)
        await expect(createRuntimeResolution({
          installAnchor: f.installAnchor, profile: f.profile, home,
        })).rejects.toMatchObject({
          code: 'ELOOP', path: cycle, message: nativeError.message,
        })
      } finally {
        for (const link of links.reverse()) unlinkSync(link)
      }
    },
  )

  /** A plugin repository linked into the profile, with the manifest a plugin developer keeps for type checking. */
  function linkedPluginFixture(peerDependencies: Record<string, string> | undefined = { '@deepseek-ai/dsh-core': '*' }): {
    f: ReturnType<typeof fixture>
    linkedRoot: string
    helper: string
    writeManifest: (peers: Record<string, string> | undefined) => void
  } {
    const f = fixture()
    const installDir = dirname(f.installAnchor)
    pkg(installDir, '@deepseek-ai/dsh', 0, { '@deepseek-ai/dsh-core': '*', '@deepseek-ai/dsh-util': '*' })
    pkg(join(installDir, 'node_modules', '@deepseek-ai', 'dsh-util'), '@deepseek-ai/dsh-util', 2)
    const linkedRoot = join(f.root, 'work', 'my-plugin')
    const writeManifest = (peers: Record<string, string> | undefined): void => {
      file(join(linkedRoot, 'package.json'), JSON.stringify({
        name: 'my-plugin',
        version: '30.0.0',
        type: 'module',
        exports: { import: './index.js', require: './index.cjs' },
        imports: { '#core': '@deepseek-ai/dsh-core' },
        dependencies: { 'zod': '*', '@deepseek-ai/dsh-util': '*', 'helper': '*' },
        ...(peers === undefined ? {} : { peerDependencies: peers }),
        devDependencies: { '@deepseek-ai/dsh-core': '*' },
      }))
    }
    writeManifest(peerDependencies)
    file(join(linkedRoot, 'index.js'), 'export const marker = 30\n')
    file(join(linkedRoot, 'index.cjs'), 'module.exports = { marker: 30 }\n')
    // The devDependency copy a type checker needs, the plugin's own third-party version, and a dsh package
    // declared as a plain dependency.
    pkg(join(linkedRoot, 'node_modules', '@deepseek-ai', 'dsh-core'), '@deepseek-ai/dsh-core', 21)
    pkg(join(linkedRoot, 'node_modules', 'zod'), 'zod', 22)
    pkg(join(linkedRoot, 'node_modules', '@deepseek-ai', 'dsh-util'), '@deepseek-ai/dsh-util', 23)
    pkg(join(f.root, 'work', 'node_modules', 'left-pad'), 'left-pad', 24)
    // A transitive dependency in pnpm's isolated layout, with a sibling of its own.
    const helper = join(linkedRoot, 'node_modules', '.pnpm', 'helper@1.0.0', 'node_modules', 'helper')
    pkg(helper, 'helper', 25, { sibling: '*' }, { '@deepseek-ai/dsh-core': '*' })
    pkg(join(dirname(helper), 'sibling'), 'sibling', 26)
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(helper, join(linkedRoot, 'node_modules', 'helper'), linkType)
    const modules = join(f.profile.dir, 'node_modules')
    mkdirSync(modules, { recursive: true })
    symlinkSync(linkedRoot, join(modules, 'my-plugin'), linkType)
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', private: true, dependencies: { 'my-plugin': '*' },
    }))
    return { f, linkedRoot, helper, writeManifest }
  }

  describe('linked root generations', () => {
    const peer = '@deepseek-ai/dsh-core'

    function unsavedFixture(): ReturnType<typeof linkedPluginFixture> {
      const result = linkedPluginFixture()
      file(join(result.f.profile.dir, 'package.json'), JSON.stringify({
        name: 'dsh-profile-web', private: true, dependencies: {},
      }))
      return result
    }

    function expectPeerLookup(
      registration: RuntimeInterception, require: NodeJS.Require, parent: string, selected: string,
    ): void {
      expect(require.resolve(peer)).toBe(join(selected, 'index.cjs'))
      expect(resolveFrom(peer, parent)).toBe(pathToFileURL(join(selected, 'index.js')).href)
      expect(registration.packageDir(peer, parent)).toBe(selected)
    }

    it('returns an unlinked importer to native lookup without changing its first generation', async () => {
      const { f, linkedRoot } = unsavedFixture()
      const link = join(f.profile.dir, 'node_modules', 'my-plugin')
      const local = join(linkedRoot, 'node_modules', peer)
      const require = createRequire(join(linkedRoot, 'entry.cjs'))
      const parent = pathToFileURL(join(linkedRoot, 'entry.mjs')).href
      const first = await resolutionOf(f)
      expect(first.localPackageNames).toEqual([])
      expect(first.linkedRoots).toEqual([{ name: 'my-plugin', realPath: linkedRoot }])
      const registration = installRuntimeInterception(first)
      registrations.push(registration)
      try {
        expectPeerLookup(registration, require, parent, f.installed)
        unlinkSync(link)
        const second = await resolutionOf(f)
        expect(second.localPackageNames).toEqual([])
        expect(second.linkedRoots).toEqual([])
        registration.replace(second)
        expectPeerLookup(registration, require, parent, local)
        expect(first.linkedRoots).toEqual([{ name: 'my-plugin', realPath: linkedRoot }])
      } finally {
        registration.dispose()
        registrations.pop()
      }
    })

    it('reports native misses after unlinking when no physical peer remains', async () => {
      const { f, linkedRoot } = unsavedFixture()
      rmSync(join(linkedRoot, 'node_modules', peer), { recursive: true })
      const require = createRequire(join(linkedRoot, 'entry.cjs'))
      const parent = pathToFileURL(join(linkedRoot, 'entry.mjs')).href
      const first = await resolutionOf(f)
      expect(first.localPackageNames).toEqual([])
      const registration = installRuntimeInterception(first)
      registrations.push(registration)
      try {
        expectPeerLookup(registration, require, parent, f.installed)
        unlinkSync(join(f.profile.dir, 'node_modules', 'my-plugin'))
        const second = await resolutionOf(f)
        expect(second.linkedRoots).toEqual([])
        registration.replace(second)
        expect(thrownError(() => require.resolve(peer))).toMatchObject({ code: 'MODULE_NOT_FOUND' })
        expect(thrownError(() => require(peer))).toMatchObject({ code: 'MODULE_NOT_FOUND' })
        expect(thrownError(() => resolveFrom(peer, parent))).toMatchObject({ code: 'ERR_MODULE_NOT_FOUND' })
        await expect(importFrom(peer, parent)).rejects.toMatchObject({ code: 'ERR_MODULE_NOT_FOUND' })
        expect(registration.packageDir(peer, parent)).toBeUndefined()
      } finally {
        registration.dispose()
        registrations.pop()
      }
    })

    it('restores the same link target and admits an additional root name', async () => {
      const { f, linkedRoot } = unsavedFixture()
      const link = join(f.profile.dir, 'node_modules', 'my-plugin')
      const require = createRequire(join(linkedRoot, 'entry.cjs'))
      const parent = pathToFileURL(join(linkedRoot, 'entry.mjs')).href
      const first = await resolutionOf(f)
      expect(first.localPackageNames).toEqual([])
      const registration = installRuntimeInterception(first)
      registrations.push(registration)
      try {
        expectPeerLookup(registration, require, parent, f.installed)
        unlinkSync(link)
        registration.replace(await resolutionOf(f))
        expectPeerLookup(registration, require, parent, join(linkedRoot, 'node_modules', peer))
        const linkType = process.platform === 'win32' ? 'junction' : 'dir'
        symlinkSync(linkedRoot, link, linkType)
        registration.replace(await resolutionOf(f))
        expectPeerLookup(registration, require, parent, f.installed)

        const additional = join(f.root, 'work', 'another-plugin')
        pkg(additional, 'another-plugin', 0, {}, { [peer]: '*' })
        pkg(join(additional, 'node_modules', peer), peer, 31)
        symlinkSync(additional, join(f.profile.dir, 'node_modules', 'another-plugin'), linkType)
        const successor = await resolutionOf(f)
        expect(successor.localPackageNames).toEqual([])
        expect(successor.linkedRoots).toEqual([
          { name: 'another-plugin', realPath: additional },
          { name: 'my-plugin', realPath: linkedRoot },
        ])
        registration.replace(successor)
        expectPeerLookup(registration, require, parent, f.installed)
        expectPeerLookup(registration, createRequire(join(additional, 'entry.cjs')),
          pathToFileURL(join(additional, 'entry.mjs')).href, f.installed)
      } finally {
        registration.dispose()
        registrations.pop()
      }
    })

    it.each(['inner', 'outer'] as const)(
      'keeps an overlapping importer proxied after removing the %s root until the last root is removed', async (removed) => {
        const { f, linkedRoot } = unsavedFixture()
        const innerLink = join(f.profile.dir, 'node_modules', 'my-plugin')
        const outer = dirname(linkedRoot)
        const outerLink = join(f.profile.dir, 'node_modules', 'workspace')
        symlinkSync(outer, outerLink, process.platform === 'win32' ? 'junction' : 'dir')
        const require = createRequire(join(linkedRoot, 'entry.cjs'))
        const parent = pathToFileURL(join(linkedRoot, 'entry.mjs')).href
        const first = await resolutionOf(f)
        expect(first.localPackageNames).toEqual([])
        expect(first.linkedRoots).toEqual([
          { name: 'my-plugin', realPath: linkedRoot },
          { name: 'workspace', realPath: outer },
        ])
        const registration = installRuntimeInterception(first)
        registrations.push(registration)
        try {
          expectPeerLookup(registration, require, parent, f.installed)
          unlinkSync(removed === 'inner' ? innerLink : outerLink)
          const second = await resolutionOf(f)
          expect(second.linkedRoots).toEqual(removed === 'inner'
            ? [{ name: 'workspace', realPath: outer }]
            : [{ name: 'my-plugin', realPath: linkedRoot }])
          registration.replace(second)
          expectPeerLookup(registration, require, parent, f.installed)
          unlinkSync(removed === 'inner' ? outerLink : innerLink)
          const third = await resolutionOf(f)
          expect(third.linkedRoots).toEqual([])
          registration.replace(third)
          expectPeerLookup(registration, require, parent, join(linkedRoot, 'node_modules', peer))
        } finally {
          registration.dispose()
          registrations.pop()
        }
      },
    )

    it('uses native fresh subpaths from a loaded caller while held modules keep their values', async () => {
      const { f, linkedRoot } = unsavedFixture()
      const local = join(linkedRoot, 'node_modules', peer)
      for (const [dir, marker] of [[f.installed, 1], [local, 21]] as const) {
        file(join(dir, 'package.json'), JSON.stringify({
          name: peer, version: `${String(marker)}.0.0`, type: 'module',
          exports: {
            '.': { import: './index.js', require: './index.cjs' },
            './fresh': { import: './fresh.js', require: './fresh.cjs' },
          },
        }))
        file(join(dir, 'fresh.js'), `export const marker = ${String(marker)}\n`)
        file(join(dir, 'fresh.cjs'), `module.exports = { marker: ${String(marker)} }\n`)
      }
      // The fresh subpath has no completed Node resolution; root removal does not replace held module references.
      file(join(linkedRoot, 'caller.js'), `import * as held from '${peer}'\nexport { held }\n`
        + `export async function fresh() { return await import('${peer}/fresh') }\n`)
      file(join(linkedRoot, 'caller.cjs'), `module.exports = { held: require('${peer}'), `
        + `fresh: () => require('${peer}/fresh') }\n`)
      const require = createRequire(join(linkedRoot, 'entry.cjs'))
      const parent = pathToFileURL(join(linkedRoot, 'entry.mjs')).href
      const first = await resolutionOf(f)
      expect(first.localPackageNames).toEqual([])
      const registration = installRuntimeInterception(first)
      registrations.push(registration)
      try {
        const cjsCaller = require('./caller.cjs') as { held: { marker: number }; fresh(): { marker: number } }
        const esmCaller = await importFrom('./caller.js', parent) as {
          held: { marker: number }
          fresh(): Promise<{ marker: number }>
        }
        const heldCjs = cjsCaller.held
        const heldEsm = esmCaller.held
        expect(heldCjs).toEqual({ marker: 1 })
        expect(heldEsm).toMatchObject({ marker: 1 })
        unlinkSync(join(f.profile.dir, 'node_modules', 'my-plugin'))
        const second = await resolutionOf(f)
        expect(second.linkedRoots).toEqual([])
        registration.replace(second)
        expect(cjsCaller.fresh()).toEqual({ marker: 21 })
        await expect(esmCaller.fresh()).resolves.toMatchObject({ marker: 21 })
        expect(cjsCaller.held).toBe(heldCjs)
        expect(esmCaller.held).toBe(heldEsm)
        expect(heldCjs).toEqual({ marker: 1 })
        expect(heldEsm).toMatchObject({ marker: 1 })
      } finally {
        registration.dispose()
        registrations.pop()
      }
    })

    it.each(['initial', 'added'] as const)(
      'rejects a removed %s root retarget without reactivating either directory', async (generation) => {
        const { f, linkedRoot } = unsavedFixture()
        const link = join(f.profile.dir, 'node_modules', 'my-plugin')
        const linkType = process.platform === 'win32' ? 'junction' : 'dir'
        const require = createRequire(join(linkedRoot, 'entry.cjs'))
        const parent = pathToFileURL(join(linkedRoot, 'entry.mjs')).href
        if (generation === 'added') unlinkSync(link)
        const first = await resolutionOf(f)
        expect(first.localPackageNames).toEqual([])
        expect(first.linkedRoots).toEqual(generation === 'added'
          ? [] : [{ name: 'my-plugin', realPath: linkedRoot }])
        const registration = installRuntimeInterception(first)
        registrations.push(registration)
        try {
          if (generation === 'added') {
            symlinkSync(linkedRoot, link, linkType)
            registration.replace(await resolutionOf(f))
          }
          expectPeerLookup(registration, require, parent, f.installed)
          unlinkSync(link)
          const removed = await resolutionOf(f)
          expect(removed.linkedRoots).toEqual([])
          registration.replace(removed)
          expectPeerLookup(registration, require, parent, join(linkedRoot, 'node_modules', peer))

          const target = join(f.root, 'work', 'retargeted-plugin')
          pkg(target, 'my-plugin', 0, {}, { [peer]: '*' })
          pkg(join(target, 'node_modules', peer), peer, 22)
          symlinkSync(target, link, linkType)
          const successor = await resolutionOf(f)
          expect(successor.localPackageNames).toEqual([])
          expect(successor.linkedRoots).toEqual([{ name: 'my-plugin', realPath: target }])
          expect(() => { registration.replace(successor) })
            .toThrow(/^profile resolution: relinking "my-plugin" requires a process restart$/u)
          expectPeerLookup(registration, require, parent, join(linkedRoot, 'node_modules', peer))
          expectPeerLookup(registration, createRequire(join(target, 'entry.cjs')),
            pathToFileURL(join(target, 'entry.mjs')).href, join(target, 'node_modules', peer))
        } finally {
          registration.dispose()
          registrations.pop()
        }
      },
    )

    it('does not retain targets from a rejected successor', async () => {
      const { f, linkedRoot } = unsavedFixture()
      const modules = join(f.profile.dir, 'node_modules')
      const originalLink = join(modules, 'my-plugin')
      const newLink = join(modules, 'a-new-plugin')
      const replacement = join(f.root, 'work', 'replacement')
      const rejectedTarget = join(f.root, 'work', 'rejected-target')
      const acceptedTarget = join(f.root, 'work', 'accepted-target')
      for (const [dir, name, marker] of [
        [replacement, 'my-plugin', 22],
        [rejectedTarget, 'a-new-plugin', 31],
        [acceptedTarget, 'a-new-plugin', 32],
      ] as const) {
        pkg(dir, name, 0, {}, { [peer]: '*' })
        pkg(join(dir, 'node_modules', peer), peer, marker)
      }
      const require = createRequire(join(linkedRoot, 'entry.cjs'))
      const parent = pathToFileURL(join(linkedRoot, 'entry.mjs')).href
      const first = await resolutionOf(f)
      expect(first.localPackageNames).toEqual([])
      const registration = installRuntimeInterception(first)
      registrations.push(registration)
      try {
        expectPeerLookup(registration, require, parent, f.installed)
        unlinkSync(originalLink)
        const removed = await resolutionOf(f)
        expect(removed.linkedRoots).toEqual([])
        registration.replace(removed)
        expectPeerLookup(registration, require, parent, join(linkedRoot, 'node_modules', peer))

        const linkType = process.platform === 'win32' ? 'junction' : 'dir'
        symlinkSync(replacement, originalLink, linkType)
        symlinkSync(rejectedTarget, newLink, linkType)
        const rejected = await resolutionOf(f)
        expect(rejected.linkedRoots).toEqual([
          { name: 'a-new-plugin', realPath: rejectedTarget },
          { name: 'my-plugin', realPath: replacement },
        ])
        expect(() => { registration.replace(rejected) })
          .toThrow(/^profile resolution: relinking "my-plugin" requires a process restart$/u)
        expectPeerLookup(registration, require, parent, join(linkedRoot, 'node_modules', peer))
        expectPeerLookup(registration, createRequire(join(rejectedTarget, 'entry.cjs')),
          pathToFileURL(join(rejectedTarget, 'entry.mjs')).href, join(rejectedTarget, 'node_modules', peer))

        unlinkSync(originalLink)
        unlinkSync(newLink)
        symlinkSync(acceptedTarget, newLink, linkType)
        const accepted = await resolutionOf(f)
        expect(accepted.linkedRoots).toEqual([{ name: 'a-new-plugin', realPath: acceptedTarget }])
        registration.replace(accepted)
        expectPeerLookup(registration, createRequire(join(acceptedTarget, 'entry.cjs')),
          pathToFileURL(join(acceptedTarget, 'entry.mjs')).href, f.installed)
        expectPeerLookup(registration, require, parent, join(linkedRoot, 'node_modules', peer))
      } finally {
        registration.dispose()
        registrations.pop()
      }
    })
  })

  it.each(['src', 'dist'] as const)(
    'keeps intermediate %s/node_modules ahead of linked-root peers and ancestor packages', async (directory) => {
      const { f, linkedRoot } = linkedPluginFixture()
      const intermediate = join(linkedRoot, directory)
      const queries = [
        ['@deepseek-ai/dsh-core', 41],
        ['@deepseek-ai/dsh-util', 42],
        ['left-pad', 43],
      ] as const
      for (const [name, marker] of queries) pkg(join(intermediate, 'node_modules', name), name, marker)
      const require = createRequire(join(intermediate, 'nested', 'entry.cjs'))
      const parent = pathToFileURL(join(intermediate, 'nested', 'entry.mjs')).href
      const registration = installRuntimeInterception(await resolutionOf(f))
      registrations.push(registration)
      try {
        for (const [name, marker] of queries) {
          const selected = join(intermediate, 'node_modules', name)
          expect(require.resolve(name), name).toBe(join(selected, 'index.cjs'))
          expect(require(name), name).toEqual({ marker })
          expect(resolveFrom(name, parent), name).toBe(pathToFileURL(join(selected, 'index.js')).href)
          expect(await importFrom(name, parent), name).toMatchObject({ marker })
          expect(registration.packageDir(name, parent), name).toBe(selected)
        }
      } finally {
        registration.dispose()
        registrations.pop()
      }
    },
  )

  it.each([
    { names: 'outer-first', reverse: false },
    { names: 'outer-first', reverse: true },
    { names: 'inner-first', reverse: false },
    { names: 'inner-first', reverse: true },
  ])('resolves overlapping linked roots independently of names and order ($names, reverse=$reverse)', async ({ names, reverse }) => {
    const f = fixture('inner-peer')
    const installDir = dirname(f.installAnchor)
    const outer = join(f.root, 'work', 'repo')
    const inner = join(outer, 'packages', 'plugin')
    pkg(outer, 'outer-repo', 0, {}, { 'shadowed-outer-peer': '*', 'outer-peer': '*' })
    pkg(inner, 'inner-plugin', 0, {}, { 'inner-peer': '*' })
    const queries = [
      {
        name: 'inner-peer', nativeDir: join(inner, 'node_modules', 'inner-peer'), nativeMarker: 11,
        selected: join(installDir, 'node_modules', 'inner-peer'), marker: 1,
      },
      {
        name: 'shadowed-outer-peer', nativeDir: join(inner, 'node_modules', 'shadowed-outer-peer'), nativeMarker: 12,
        selected: join(inner, 'node_modules', 'shadowed-outer-peer'), marker: 12,
      },
      {
        name: 'outer-peer', nativeDir: join(outer, 'node_modules', 'outer-peer'), nativeMarker: 13,
        selected: join(installDir, 'node_modules', 'outer-peer'), marker: 3,
      },
    ]
    pkg(installDir, '@deepseek-ai/dsh', 0, Object.fromEntries(queries.map(({ name }) => [name, '*'])))
    for (const [index, query] of queries.entries()) {
      pkg(join(installDir, 'node_modules', query.name), query.name, index + 1)
      pkg(query.nativeDir, query.name, query.nativeMarker)
    }
    const outerName = names === 'outer-first' ? 'a-repo' : 'z-repo'
    const innerName = names === 'outer-first' ? 'z-plugin' : 'a-plugin'
    const modules = join(f.profile.dir, 'node_modules')
    mkdirSync(modules, { recursive: true })
    const links: string[] = []
    try {
      for (const [name, target] of [[outerName, outer], [innerName, inner]] as const) {
        const link = join(modules, name)
        symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
        links.push(link)
      }
      const resolution = await resolutionOf(f)
      expect(resolution.linkedRoots.map(root => root.realPath))
        .toEqual(names === 'outer-first' ? [outer, inner] : [inner, outer])
      const linkedRoots = reverse ? [...resolution.linkedRoots].reverse() : resolution.linkedRoots
      const require = createRequire(join(inner, 'entry.cjs'))
      const parent = pathToFileURL(join(inner, 'entry.mjs')).href
      for (const query of queries) expect(require.resolve(query.name)).toBe(join(query.nativeDir, 'index.cjs'))
      const registration = installRuntimeInterception({ ...resolution, linkedRoots })
      registrations.push(registration)
      try {
        for (const { name, selected, marker } of queries) {
          expect(require.resolve(name), name).toBe(join(selected, 'index.cjs'))
          expect(require(name), name).toEqual({ marker })
          expect(resolveFrom(name, parent), name).toBe(pathToFileURL(join(selected, 'index.js')).href)
          expect(await importFrom(name, parent), name).toMatchObject({ marker })
          expect(registration.packageDir(name, parent), name).toBe(selected)
        }
      } finally {
        registration.dispose()
        registrations.pop()
      }
      for (const query of queries) expect(require.resolve(query.name)).toBe(join(query.nativeDir, 'index.cjs'))
    } finally {
      for (const link of links.reverse()) unlinkSync(link)
    }
  })

  it.each(['host', 'dependency', 'workspace-logical', 'workspace-real'] as const)(
    'keeps %s importers native inside a wide linked root', async (importer) => {
      const name = '@deepseek-ai/dsh-core'
      const f = fixture(name)
      const installDir = dirname(f.installAnchor)
      pkg(installDir, '@deepseek-ai/dsh', 0, {
        [name]: '*', 'host-consumer': '*', 'workspace-consumer': '*',
      })
      const hostSource = join(installDir, 'src')
      const dependency = join(installDir, 'node_modules', 'host-consumer')
      const workspace = join(f.root, 'workspace-consumer')
      const workspaceLink = join(installDir, 'node_modules', 'workspace-consumer')
      const external = join(f.root, 'external-plugin')
      for (const [dir, packageName, marker] of [
        [hostSource, 'host-source', 11],
        [dependency, 'host-consumer', 21],
        [workspace, 'workspace-consumer', 22],
        [external, 'external-plugin', 31],
      ] as const) {
        pkg(dir, packageName, 0, {}, { [name]: '*' })
        pkg(join(dir, 'node_modules', name), name, marker)
      }
      const linkType = process.platform === 'win32' ? 'junction' : 'dir'
      const wideLink = join(f.profile.dir, 'node_modules', 'wide-workspace')
      mkdirSync(dirname(wideLink), { recursive: true })
      const links: string[] = []
      try {
        symlinkSync(workspace, workspaceLink, linkType)
        links.push(workspaceLink)
        symlinkSync(f.root, wideLink, linkType)
        links.push(wideLink)
        const importers = {
          host: { dir: hostSource, marker: 11 },
          dependency: { dir: dependency, marker: 21 },
          'workspace-logical': { dir: workspaceLink, marker: 22 },
          'workspace-real': { dir: workspace, marker: 22 },
        }
        const { dir, marker } = importers[importer]
        const expectedDir = join(dir, 'node_modules', name)
        const realDir = realpathSync.native(expectedDir)
        const require = createRequire(join(dir, 'entry.cjs'))
        const parent = pathToFileURL(join(dir, 'entry.mjs')).href
        const nativeCjs = require.resolve(name)
        const nativeEsm = resolveFrom(name, parent)
        expect(nativeCjs).toBe(join(realDir, 'index.cjs'))
        expect(nativeEsm).toBe(pathToFileURL(join(realDir, 'index.js')).href)
        const resolution = await resolutionOf(f)
        expect(resolution.entries.find(entry => entry.name === 'workspace-consumer'))
          .toMatchObject({ scope: 'installation', packageDir: workspaceLink })
        expect(resolution.linkedRoots).toEqual([
          { name: 'wide-workspace', realPath: f.root },
        ])
        const registration = installRuntimeInterception(resolution)
        registrations.push(registration)
        try {
          const externalRequire = createRequire(join(external, 'entry.cjs'))
          const externalParent = pathToFileURL(join(external, 'entry.mjs')).href
          expect(externalRequire.resolve(name)).toBe(join(f.installed, 'index.cjs'))
          expect(externalRequire(name)).toEqual({ marker: 1 })
          expect(resolveFrom(name, externalParent)).toBe(pathToFileURL(join(f.installed, 'index.js')).href)
          expect(await importFrom(name, externalParent)).toMatchObject({ marker: 1 })
          expect(registration.packageDir(name, externalParent)).toBe(f.installed)
          expect(require.resolve(name)).toBe(nativeCjs)
          expect(require(name)).toEqual({ marker })
          expect(resolveFrom(name, parent)).toBe(nativeEsm)
          expect(await importFrom(name, parent)).toMatchObject({ marker })
          expect(registration.packageDir(name, parent)).toBe(expectedDir)
        } finally {
          registration.dispose()
          registrations.pop()
        }
      } finally {
        for (const link of links.reverse()) unlinkSync(link)
      }
    },
  )

  it('occupies only the peer names of a linked plugin at its own node_modules', async () => {
    const { f, linkedRoot, helper } = linkedPluginFixture()
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    const require = createRequire(join(linkedRoot, 'entry.cjs'))
    const parent = pathToFileURL(join(linkedRoot, 'entry.mjs')).href
    const expectResolution = async (
      name: string, dir: string, marker: number, from: { require: NodeJS.Require; parent: string } = { require, parent },
    ): Promise<void> => {
      expect(from.require(name), name).toEqual({ marker })
      expect(from.require.resolve(name), name).toBe(join(dir, 'index.cjs'))
      expect(resolveFrom(name, from.parent), name).toBe(pathToFileURL(join(dir, 'index.js')).href)
      expect(await importFrom(name, from.parent), name).toMatchObject({ marker })
      expect(registration.packageDir(name, from.parent), name).toBe(dir)
    }
    // The peer comes from the running installation; its devDependency copy is never read.
    await expectResolution('@deepseek-ai/dsh-core', f.installed, 1)
    // A cache-busting query on the importer, as hot module replacement re-imports it, changes nothing.
    expect(resolveFrom('@deepseek-ai/dsh-core', `${parent}?t=1`)).toBe(pathToFileURL(join(f.installed, 'index.js')).href)
    expect(resolveFrom('zod', `${parent}?t=1`)).toBe(pathToFileURL(join(linkedRoot, 'node_modules', 'zod', 'index.js')).href)
    // Plain dependencies keep the plugin's own copies, including a dsh package declared as one.
    await expectResolution('zod', join(linkedRoot, 'node_modules', 'zod'), 22)
    await expectResolution('@deepseek-ai/dsh-util', join(linkedRoot, 'node_modules', '@deepseek-ai', 'dsh-util'), 23)
    // An undeclared name without an entry follows the real ancestor chain.
    await expectResolution('left-pad', join(f.root, 'work', 'node_modules', 'left-pad'), 24)
    // Package imports and self-references keep their Node semantics inside the linked package.
    expect(require.resolve('#core')).toBe(join(f.installed, 'index.cjs'))
    expect(resolveFrom('#core', parent)).toBe(pathToFileURL(join(f.installed, 'index.js')).href)
    expect(require('my-plugin')).toEqual({ marker: 30 })
    expect(resolveFrom('my-plugin', parent)).toBe(pathToFileURL(join(linkedRoot, 'index.js')).href)
    // A transitive dependency sees its own local layer first and the linked package's peers at the layer above.
    const helperImporter = { require: createRequire(join(helper, 'entry.cjs')), parent: pathToFileURL(join(helper, 'entry.mjs')).href }
    await expectResolution('sibling', join(dirname(helper), 'sibling'), 26, helperImporter)
    await expectResolution('@deepseek-ai/dsh-core', f.installed, 1, helperImporter)
    // The profile still reaches the linked plugin through Node's own symlink handling.
    const profileRequire = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(profileRequire.resolve('my-plugin')).toBe(join(linkedRoot, 'index.cjs'))
    expect(resolveFrom('my-plugin', pathToFileURL(join(f.profile.dir, 'entry.mjs')).href))
      .toBe(pathToFileURL(join(linkedRoot, 'index.js')).href)
  })

  it('continues above a linked plugin after a CommonJS subpath miss in an occupied peer', async () => {
    const { f, linkedRoot } = linkedPluginFixture()
    file(join(f.installed, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-core', version: '1.0.0', main: './index.cjs' }))
    const above = join(f.root, 'work', 'node_modules', '@deepseek-ai', 'dsh-core')
    file(join(above, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-core', version: '3.0.0' }))
    file(join(above, 'sub.cjs'), 'module.exports = { marker: 3 }\n')
    file(join(linkedRoot, 'node_modules', '@deepseek-ai', 'dsh-core', 'sub.cjs'), 'module.exports = { marker: 21 }\n')
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    const require = createRequire(join(linkedRoot, 'entry.cjs'))
    expect(require.resolve('@deepseek-ai/dsh-core')).toBe(join(f.installed, 'index.cjs'))
    // The occupied name never falls back to the devDependency copy at the same layer.
    expect(require.resolve('@deepseek-ai/dsh-core/sub.cjs')).toBe(join(above, 'sub.cjs'))
    expect(require('@deepseek-ai/dsh-core/sub.cjs')).toEqual({ marker: 3 })
  })

  it('preserves the native require stack for a missing linked legacy subpath', async () => {
    const { f, linkedRoot } = linkedPluginFixture()
    const name = '@deepseek-ai/dsh-core'
    file(join(f.installed, 'package.json'), JSON.stringify({
      name, version: '1.0.0', type: 'module', main: './index.cjs',
    }))
    rmSync(join(linkedRoot, 'node_modules', name), { recursive: true })
    const importer = join(linkedRoot, 'entry.cjs')
    const require = createRequire(importer)
    const request = `${name}/missing.cjs`
    const nativeError = thrownError(() => require.resolve(request))
    expect(nativeError.code).toBe('MODULE_NOT_FOUND')
    expect(nativeError.requireStack).toEqual([importer])

    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    try {
      const runtimeError = thrownError(() => require.resolve(request))
      expect(runtimeError.code).toBe(nativeError.code)
      expect(runtimeError.requireStack).toEqual(nativeError.requireStack)
      expect(runtimeError.message).toBe(nativeError.message)
    } finally {
      registration.dispose()
      registrations.pop()
    }
  })

  it('reads a linked plugin manifest at every resolution', async () => {
    const { f, linkedRoot, writeManifest } = linkedPluginFixture({})
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    const devCopy = join(linkedRoot, 'node_modules', '@deepseek-ai', 'dsh-core')
    const require = createRequire(join(linkedRoot, 'entry.cjs'))
    const parent = pathToFileURL(join(linkedRoot, 'entry.mjs')).href
    expect(require.resolve('@deepseek-ai/dsh-core')).toBe(join(devCopy, 'index.cjs'))
    expect(resolveFrom('@deepseek-ai/dsh-core', parent)).toBe(pathToFileURL(join(devCopy, 'index.js')).href)
    expect(registration.packageDir('@deepseek-ai/dsh-core', parent)).toBe(devCopy)

    writeManifest({ '@deepseek-ai/dsh-core': '*' })
    // No memo holds for a linked importer, and the occupied name delegates from the entry's declaring manifest,
    // a parent Node has never resolved this request from.
    expect(require.resolve('@deepseek-ai/dsh-core')).toBe(join(f.installed, 'index.cjs'))
    expect(registration.packageDir('@deepseek-ai/dsh-core', parent)).toBe(f.installed)
    expect(resolveFrom('@deepseek-ai/dsh-core', parent)).toBe(pathToFileURL(join(f.installed, 'index.js')).href)
    expect(await importFrom('@deepseek-ai/dsh-core', parent)).toMatchObject({ marker: 1 })

    writeManifest({})
    expect(require.resolve('@deepseek-ai/dsh-core')).toBe(join(devCopy, 'index.cjs'))
    expect(resolveFrom('@deepseek-ai/dsh-core', parent)).toBe(pathToFileURL(join(devCopy, 'index.js')).href)
    expect(registration.packageDir('@deepseek-ai/dsh-core', parent)).toBe(devCopy)
    writeManifest(undefined)
    expect(require.resolve('@deepseek-ai/dsh-core')).toBe(join(devCopy, 'index.cjs'))
    // Without a manifest the linked package occupies nothing.
    rmSync(join(linkedRoot, 'package.json'))
    expect(require.resolve('@deepseek-ai/dsh-core')).toBe(join(devCopy, 'index.cjs'))
  })

  it('reads ancestor peer declarations at every linked resolution', async () => {
    const { f, linkedRoot } = linkedPluginFixture({})
    const name = '@deepseek-ai/dsh-core'
    rmSync(join(linkedRoot, 'node_modules', name), { recursive: true })
    const ancestor = dirname(linkedRoot)
    const ancestorCopy = join(ancestor, 'node_modules', name)
    pkg(ancestorCopy, name, 31)
    const manifestPath = join(ancestor, 'package.json')
    const manifest = { name: 'plugin-workspace', private: true }
    file(manifestPath, JSON.stringify(manifest))
    const require = createRequire(join(linkedRoot, 'entry.cjs'))
    const parent = pathToFileURL(join(linkedRoot, 'entry.mjs')).href
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    try {
      for (const [peerDependencies, expectedDir] of [
        [undefined, ancestorCopy],
        [{ [name]: '*' }, f.installed],
        [undefined, ancestorCopy],
      ] as const) {
        file(manifestPath, JSON.stringify({ ...manifest, peerDependencies }))
        expect(require.resolve(name)).toBe(join(expectedDir, 'index.cjs'))
        expect(resolveFrom(name, parent)).toBe(pathToFileURL(join(expectedDir, 'index.js')).href)
        expect(registration.packageDir(name, parent)).toBe(expectedDir)
      }
    } finally {
      registration.dispose()
      registrations.pop()
    }
  })

  it('restores CommonJS resolution when the registration is disposed', async () => {
    const f = fixture()
    const registration = installRuntimeInterception(await resolutionOf(f))
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require.resolve('@deepseek-ai/dsh-core')).toBe(join(f.installed, 'index.cjs'))
    registration.dispose()
    registrations.pop()
    expect(() => { require.resolve('@deepseek-ai/dsh-core') }).toThrow(/Cannot find module/u)
  })
})
