/** Runtime profile resolution uses one eager generation for ESM and CommonJS. */

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
  installProfileResolution,
  registerWorkerResolution,
  type ProfileResolutionRegistration,
} from '../src/profile-resolution/resolver.ts'
import {
  createProfileResolutionGeneration,
  healProfilesModuleFallback,
  type Profile,
  type ProfileResolutionGeneration,
} from '../src/profile.ts'

const roots: string[] = []
const registrations: ProfileResolutionRegistration[] = []

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

function fixture(name = 'resolution-lib'): {
  root: string
  installAnchor: string
  installed: string
  profile: Profile
} {
  // macOS exposes tmpdir through /var while Node returns resolved module paths through /private/var.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-profile-generation-')))
  roots.push(root)
  const installDir = join(root, 'install')
  const installed = join(installDir, 'node_modules', name)
  const installAnchor = pkg(installDir, 'test-app', 0, { [name]: '*' })
  pkg(installed, name, 1)
  const profileDir = join(root, 'profiles', 'test')
  file(join(profileDir, 'package.json'), JSON.stringify({
    name: 'test-profile', private: true, dependencies: { 'missing-local': '*' },
  }))
  return {
    root,
    installAnchor,
    installed,
    profile: {
      name: 'test',
      dir: profileDir,
      layers: [],
      patchPath: join(profileDir, 'cordis.patch.yml'),
      patches: [],
    },
  }
}

async function generationOf(f: ReturnType<typeof fixture>): Promise<ProfileResolutionGeneration> {
  return await healProfilesModuleFallback({
    installAnchor: f.installAnchor,
    profile: f.profile,
    home: f.root,
    materialize: false,
  })
}

describe('profile resolution generation', { concurrent: false }, () => {
  it('computes the old fallback graph without materializing it', async () => {
    const f = fixture()
    const generation = await generationOf(f)
    expect(generation.entries.find(entry => entry.name === 'resolution-lib')).toMatchObject({
      packageDir: f.installed,
      version: '1.0.0',
      declarer: f.installAnchor,
      scope: 'installation',
    })
    expect(existsSync(join(generation.profilesDir, 'node_modules'))).toBe(false)
    expect(existsSync(join(f.profile.dir, '.dsh-module-fallback'))).toBe(false)
    expect(Object.isFrozen(generation)).toBe(true)
    expect(Object.isFrozen(generation.entries)).toBe(true)
    expect(generation.entries.every(Object.isFrozen)).toBe(true)

    const installationOnly = await createProfileResolutionGeneration({
      installAnchor: f.installAnchor,
      home: join(f.root, 'installation-only-home'),
    })
    expect(installationOnly.profileDir).toBeUndefined()
    expect(installationOnly.localPackageNames).toEqual([])
    const registration = installProfileResolution(installationOnly)
    registrations.push(registration)
    expect(createRequire(join(installationOnly.profilesDir, 'entry.cjs'))('resolution-lib'))
      .toEqual({ marker: 1 })
  })

  it('fails generation construction before writing when the profile manifest is malformed', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'package.json'), '{')
    await expect(generationOf(f)).rejects.toThrow(SyntaxError)
    expect(existsSync(join(f.root, 'profiles', 'node_modules'))).toBe(false)
  })

  it('materializes exactly the package targets in the computed generation', async () => {
    const f = fixture()
    const computed = await generationOf(f)
    const materialized = await healProfilesModuleFallback({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    expect(materialized).toEqual(computed)
    for (const entry of computed.entries) {
      const projected = entry.scope === 'installation'
        ? join(computed.profilesDir, 'node_modules', entry.name)
        : join(f.profile.dir, '.dsh-module-fallback', 'node_modules', entry.name)
      expect(realpathSync(projected)).toBe(realpathSync(entry.packageDir))
    }
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
      patchPath: join(bundleDir, 'cordis.patch.yml'),
      patches: [],
    }, {
      packageName: 'later-bundle',
      packageDir: laterBundle,
      patchPath: join(laterBundle, 'cordis.patch.yml'),
      patches: [],
    })

    const generation = await generationOf(f)
    expect(generation.entries.find(entry => entry.name === 'ordered-choice')).toMatchObject({
      packageDir: installationChoice,
      scope: 'installation',
    })
    const bundleChoice = generation.entries.find(entry => entry.name === 'bundle-choice')
    if (bundleChoice === undefined) throw new Error('generation omitted bundle-choice')
    expect(bundleChoice).toMatchObject({ scope: 'profile' })
    expect(realpathSync.native(bundleChoice.packageDir)).toBe(realpathSync.native(firstBundleChoice))
    expect(generation.entries.find(entry => entry.name === 'peer-choice')).toMatchObject({
      packageDir: peerChoice,
      scope: 'installation',
    })
  })

  it('routes ESM and CommonJS through the same installation entry', async () => {
    const f = fixture()
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require('resolution-lib')).toEqual({ marker: 1 })
    expect(require.resolve('resolution-lib')).toBe(join(f.installed, 'index.cjs'))
    const parent = pathToFileURL(join(f.profile.dir, 'entry.mjs')).href
    expect(resolveFrom('resolution-lib', parent)).toBe(pathToFileURL(join(f.installed, 'index.js')).href)
    expect(resolveFrom('resolution-lib', parent, { type: 'javascript' }))
      .toBe(pathToFileURL(join(f.installed, 'index.js')).href)
    expect(resolveFrom('resolution-lib', parent)).toBe(pathToFileURL(join(f.installed, 'index.js')).href)
    expect(import.meta.resolve('resolution-lib', parent)).toBe(pathToFileURL(join(f.installed, 'index.js')).href)
    expect(await importFrom('resolution-lib', parent)).toMatchObject({ marker: 1 })
  })

  it('routes a scoped CommonJS package through its containing node_modules directory', async () => {
    const f = fixture('@scope/resolution-lib')
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))

    expect(require('@scope/resolution-lib')).toEqual({ marker: 1 })
    expect(require.resolve('@scope/resolution-lib')).toBe(join(f.installed, 'index.cjs'))
  })

  it('routes a CommonJS npm alias through its declaring package', async () => {
    const f = fixture('aliased-lib')
    const target = join(f.root, 'store', 'real-lib')
    pkg(target, 'real-lib', 5)
    rmSync(f.installed, { recursive: true })
    symlinkSync(target, f.installed, process.platform === 'win32' ? 'junction' : 'dir')
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)

    expect(createRequire(join(f.profile.dir, 'entry.cjs'))('aliased-lib')).toEqual({ marker: 5 })
  })

  it('verifies a materialized scoped CommonJS package against the generation', async () => {
    const f = fixture('@scope/resolution-lib')
    const generation = await healProfilesModuleFallback({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    const registration = installProfileResolution(generation, 'verify')
    registrations.push(registration)

    expect(createRequire(join(f.profile.dir, 'dual-entry.cjs')).resolve('@scope/resolution-lib'))
      .toBe(realpathSync(join(f.installed, 'index.cjs')))
  })

  it('routes an application-owned profile outside the shared profiles directory', async () => {
    const f = fixture()
    const profileDir = join(f.root, 'application-profile')
    file(join(profileDir, 'package.json'), JSON.stringify({ name: 'application-profile', private: true }))
    const profile = {
      ...f.profile,
      dir: profileDir,
      patchPath: join(profileDir, 'cordis.patch.yml'),
    }
    const generation = await healProfilesModuleFallback({
      installAnchor: f.installAnchor,
      profile,
      home: f.root,
      materialize: false,
    })
    const registration = installProfileResolution(generation)
    registrations.push(registration)
    const require = createRequire(join(profileDir, 'entry.cjs'))
    expect(require('resolution-lib')).toEqual({ marker: 1 })
    const parent = pathToFileURL(join(profileDir, 'entry.mjs')).href
    expect(resolveFrom('resolution-lib', parent)).toBe(pathToFileURL(join(f.installed, 'index.js')).href)
    expect(await importFrom('resolution-lib', parent)).toMatchObject({ marker: 1 })
    expect(() => { createRequire(join(f.root, 'outside.cjs'))('resolution-lib') }).toThrow(/Cannot find module/u)
  })

  it('does not reuse a default route for explicit CommonJS paths', async () => {
    const f = fixture()
    const alternative = join(f.root, 'alternative')
    const alternativePackage = join(alternative, 'node_modules', 'resolution-lib')
    pkg(alternativePackage, 'resolution-lib', 2)
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require.resolve('resolution-lib')).toBe(join(f.installed, 'index.cjs'))
    expect(require.resolve('resolution-lib', { paths: [alternative] })).toBe(join(alternativePackage, 'index.cjs'))
    expect(require.resolve('resolution-lib', { paths: [f.profile.dir] })).toBe(join(f.installed, 'index.cjs'))
    expect(require.resolve('resolution-lib', { paths: [join(f.root, 'missing'), f.profile.dir] }))
      .toBe(join(f.installed, 'index.cjs'))
    const relative = join(f.profile.dir, 'relative.cjs')
    file(relative, '')
    expect(require.resolve('./relative.cjs', { paths: [f.profile.dir] })).toBe(relative)
    const invalid = join(f.root, 'invalid')
    file(join(invalid, 'node_modules', 'resolution-lib', 'package.json'), '{')
    expect(() => { require.resolve('resolution-lib', { paths: [invalid, f.profile.dir] }) })
      .toThrow(/Invalid package config/u)
  })

  it('keeps earlier explicit CommonJS paths ahead of a managed local failure', async () => {
    const f = fixture()
    const generation = await healProfilesModuleFallback({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    const local = join(f.profile.dir, 'node_modules', 'resolution-lib')
    file(join(local, 'package.json'), JSON.stringify({
      name: 'resolution-lib', version: '2.0.0', exports: './missing.cjs',
    }))
    const alternative = join(f.root, 'alternative')
    const selected = join(alternative, 'node_modules', 'resolution-lib', 'index.cjs')
    pkg(dirname(selected), 'resolution-lib', 3)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    const paths = [alternative, f.profile.dir]
    expect(require.resolve('resolution-lib', { paths })).toBe(selected)
    unlinkSync(join(generation.profilesDir, 'node_modules', 'resolution-lib'))

    const registration = installProfileResolution(generation)
    registrations.push(registration)
    expect(require.resolve('resolution-lib', { paths })).toBe(selected)
  })

  it('keeps a missing legacy main before a managed explicit CommonJS path', async () => {
    const f = fixture()
    const invalid = join(f.root, 'invalid')
    const selected = join(invalid, 'node_modules', 'resolution-lib')
    file(join(selected, 'package.json'), JSON.stringify({ name: 'resolution-lib', main: './missing.cjs' }))
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    const paths = [invalid, f.profile.dir]
    const linkError = thrownError(() => require.resolve('resolution-lib', { paths }))
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    const runtimeError = thrownError(() => require.resolve('resolution-lib', { paths }))

    expect(runtimeError).toMatchObject({
      code: linkError.code,
      path: linkError.path,
      requestPath: linkError.requestPath,
    })
    expect(runtimeError.message).toBe(linkError.message)
  })

  it('keeps a missing fallback legacy main before later explicit CommonJS paths', async () => {
    const f = fixture()
    const name = 'fallback-invalid-main'
    const selected = join(f.root, 'node_modules', name)
    file(join(selected, 'package.json'), JSON.stringify({ name, main: './missing.cjs' }))
    const alternative = join(f.root, 'alternative')
    pkg(join(alternative, 'node_modules', name), name, 2)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    const paths = [f.profile.dir, alternative]
    const linkError = thrownError(() => require.resolve(name, { paths }))
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    const runtimeError = thrownError(() => require.resolve(name, { paths }))

    expect(runtimeError).toMatchObject({
      code: linkError.code,
      path: linkError.path,
      requestPath: linkError.requestPath,
    })
    expect(runtimeError.message).toBe(linkError.message)
  })

  it('keeps a missing fallback legacy main after a generation miss', async () => {
    const f = fixture()
    const selected = join(f.root, 'node_modules', 'resolution-lib')
    file(join(selected, 'package.json'), JSON.stringify({ name: 'resolution-lib', main: './missing.cjs' }))
    const alternative = join(f.root, 'alternative')
    pkg(join(alternative, 'node_modules', 'resolution-lib'), 'resolution-lib', 2)
    const generation = await generationOf(f)
    rmSync(f.installed, { recursive: true })
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    const paths = [f.profile.dir, alternative]
    const linkError = thrownError(() => require.resolve('resolution-lib', { paths }))
    const registration = installProfileResolution(generation)
    registrations.push(registration)
    const runtimeError = thrownError(() => require.resolve('resolution-lib', { paths }))

    expect(runtimeError).toMatchObject({
      code: linkError.code,
      path: linkError.path,
      requestPath: linkError.requestPath,
    })
    expect(runtimeError.message).toBe(linkError.message)
  })

  it('keeps a profile-local package ahead of the generation', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'test-profile',
      private: true,
      dependencies: { 'resolution-lib': '*', 'linked-local': '*' },
    }))
    const localResolution = join(f.profile.dir, 'node_modules', 'resolution-lib')
    pkg(localResolution, 'resolution-lib', 2)
    const linkedLocal = join(f.root, 'linked-local')
    pkg(linkedLocal, 'linked-local', 3)
    symlinkSync(
      linkedLocal,
      join(f.profile.dir, 'node_modules', 'linked-local'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    const generation = await generationOf(f)
    expect(generation.localPackageNames).toEqual(['resolution-lib', 'linked-local'])
    const registration = installProfileResolution(generation)
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require('resolution-lib')).toEqual({ marker: 2 })
    expect(require.resolve('resolution-lib', { paths: [f.profile.dir] }))
      .toBe(join(localResolution, 'index.cjs'))
    const parent = pathToFileURL(join(f.profile.dir, 'entry.mjs')).href
    expect(resolveFrom('resolution-lib', parent)).toBe(
      pathToFileURL(join(f.profile.dir, 'node_modules', 'resolution-lib', 'index.js')).href,
    )
  })

  it('preserves an npm alias package self-reference', async () => {
    const f = fixture()
    file(f.installAnchor, JSON.stringify({
      name: 'test-app',
      version: '0.0.0',
      type: 'module',
      exports: { import: './index.js', require: './index.cjs' },
      dependencies: { 'resolution-lib': '*', 'real-name': '*' },
    }))
    const installedRealName = join(dirname(f.installAnchor), 'node_modules', 'real-name')
    pkg(installedRealName, 'real-name', 7)
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'test-profile',
      private: true,
      dependencies: { alias: 'npm:real-name' },
    }))
    const alias = join(f.profile.dir, 'node_modules', 'alias')
    pkg(alias, 'real-name', 6)
    const generation = await healProfilesModuleFallback({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    expect(generation.localPackageNames).toEqual(['alias'])
    const require = createRequire(join(alias, 'inside.cjs'))
    expect(require.resolve('real-name')).toBe(join(alias, 'index.cjs'))
    expect(require.resolve('real-name', { paths: [f.profile.dir] })).toBe(join(alias, 'index.cjs'))
    expect(resolveFrom('real-name', pathToFileURL(join(alias, 'inside-link.mjs')).href)).toBe(
      pathToFileURL(join(alias, 'index.js')).href,
    )
    const invalidScope = join(f.profile.dir, 'node_modules', 'invalid-scope')
    file(join(invalidScope, 'package.json'), '{')
    expect(() => createRequire(join(invalidScope, 'inside.cjs')).resolve('resolution-lib'))
      .toThrow(/Invalid package config/u)
    expect(() => resolveFrom('resolution-lib', pathToFileURL(join(invalidScope, 'inside.mjs')).href))
      .toThrow(/Invalid package config/u)
    unlinkSync(join(generation.profilesDir, 'node_modules', 'resolution-lib'))
    unlinkSync(join(generation.profilesDir, 'node_modules', 'real-name'))

    const registration = installProfileResolution(generation)
    registrations.push(registration)
    expect(require.resolve('real-name')).toBe(join(alias, 'index.cjs'))
    expect(require.resolve('real-name', { paths: [f.profile.dir] })).toBe(join(alias, 'index.cjs'))
    expect(resolveFrom('real-name', pathToFileURL(join(alias, 'inside-runtime.mjs')).href)).toBe(
      pathToFileURL(join(alias, 'index.js')).href,
    )
    expect(() => createRequire(join(invalidScope, 'inside.cjs')).resolve('resolution-lib'))
      .toThrow(/Invalid package config/u)
    expect(() => resolveFrom('resolution-lib', pathToFileURL(join(invalidScope, 'inside.mjs')).href))
      .toThrow(/Invalid package config/u)
  })

  it('keeps package imports aliases on the generation route', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'test-profile',
      private: true,
      imports: { '#resolution-lib': 'resolution-lib' },
    }))
    const generation = await healProfilesModuleFallback({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    const nested = join(f.profile.dir, 'nested')
    const require = createRequire(join(nested, 'entry.cjs'))
    const linkParent = pathToFileURL(join(nested, 'entry-link.mjs')).href
    expect(require.resolve('#resolution-lib')).toBe(join(f.installed, 'index.cjs'))
    expect(resolveFrom('#resolution-lib', linkParent)).toBe(pathToFileURL(join(f.installed, 'index.js')).href)
    unlinkSync(join(generation.profilesDir, 'node_modules', 'resolution-lib'))

    const registration = installProfileResolution(generation)
    registrations.push(registration)
    const runtimeParent = pathToFileURL(join(nested, 'entry-runtime.mjs')).href
    expect(require.resolve('#resolution-lib')).toBe(join(f.installed, 'index.cjs'))
    expect(resolveFrom('#resolution-lib', runtimeParent)).toBe(pathToFileURL(join(f.installed, 'index.js')).href)
  })

  it('verifies package imports aliases against the generation', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'test-profile',
      private: true,
      imports: { '#resolution-lib': 'resolution-lib' },
    }))
    const generation = await healProfilesModuleFallback({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    const registration = installProfileResolution(generation, 'verify')
    registrations.push(registration)

    expect(createRequire(join(f.profile.dir, 'entry.cjs')).resolve('#resolution-lib'))
      .toBe(realpathSync(join(f.installed, 'index.cjs')))
    expect(resolveFrom(
      '#resolution-lib', pathToFileURL(join(f.profile.dir, 'entry-dual.mjs')).href,
    )).toBe(pathToFileURL(realpathSync(join(f.installed, 'index.js'))).href)
  })

  it('ignores a stale package imports projection and detects it in dual mode', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'test-profile',
      private: true,
      imports: { '#resolution-lib': 'resolution-lib' },
    }))
    const generation = await healProfilesModuleFallback({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    const projection = join(generation.profilesDir, 'node_modules', 'resolution-lib')
    unlinkSync(projection)
    const stale = join(f.root, 'stale', 'resolution-lib')
    pkg(stale, 'resolution-lib', 9)
    symlinkSync(stale, projection, process.platform === 'win32' ? 'junction' : 'dir')
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))

    const runtime = installProfileResolution(generation)
    expect(require.resolve('#resolution-lib')).toBe(join(f.installed, 'index.cjs'))
    expect(require.resolve('resolution-lib')).toBe(join(f.installed, 'index.cjs'))
    expect(resolveFrom(
      '#resolution-lib', pathToFileURL(join(f.profile.dir, 'runtime.mjs')).href,
    )).toBe(pathToFileURL(join(f.installed, 'index.js')).href)
    runtime.dispose()

    const dual = installProfileResolution(generation, 'verify')
    registrations.push(dual)
    expect(() => require.resolve('#resolution-lib')).toThrow(/profile resolution mismatch/u)
    expect(() => resolveFrom(
      '#resolution-lib', pathToFileURL(join(f.profile.dir, 'dual-stale.mjs')).href,
    )).toThrow(/profile resolution mismatch/u)
  })

  it('leaves relative package imports targets and their diagnostics to Node', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'test-profile',
      private: true,
      imports: { '#missing-relative': './missing.cjs' },
    }))
    const generation = await healProfilesModuleFallback({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    const parent = pathToFileURL(join(f.profile.dir, 'entry.mjs')).href
    const cjsMessage = thrownMessage(() => require.resolve('#missing-relative'))
    const esmMessage = thrownMessage(() => resolveFrom('#missing-relative', parent))
    unlinkSync(join(generation.profilesDir, 'node_modules', 'resolution-lib'))

    const registration = installProfileResolution(generation)
    registrations.push(registration)
    expect(thrownMessage(() => require.resolve('#missing-relative'))).toBe(cjsMessage)
    expect(thrownMessage(() => resolveFrom('#missing-relative', parent))).toBe(esmMessage)
  })

  it('keeps local and after-fallback package imports targets in native order', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'test-profile',
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

    const registration = installProfileResolution(await generationOf(f))
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
    const linkMessage = thrownMessage(() => require.resolve('#missing'))
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)

    expect(thrownMessage(() => require.resolve('#missing'))).toBe(linkMessage)
  })

  it('does not inherit package imports across node_modules', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'test-profile', private: true, imports: { '#resolution-lib': 'resolution-lib' },
    }))
    const nested = join(f.profile.dir, 'node_modules', 'manifestless', 'entry.cjs')
    file(nested, '')
    const require = createRequire(nested)
    const linkMessage = thrownMessage(() => require.resolve('#resolution-lib'))
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)

    expect(thrownMessage(() => require.resolve('#resolution-lib'))).toBe(linkMessage)
  })

  it('falls through a missing local CommonJS subpath to the generation', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'test-profile',
      private: true,
      dependencies: { 'resolution-lib': '*' },
    }))
    file(join(f.installed, 'package.json'), JSON.stringify({
      name: 'resolution-lib', version: '1.0.0', type: 'module', main: './index.cjs',
    }))
    file(join(f.installed, 'only-install.cjs'), 'module.exports = { marker: 8 }\n')
    file(join(f.installed, 'legacy-install.cjs'), 'module.exports = { marker: 9 }\n')
    const local = join(f.profile.dir, 'node_modules', 'resolution-lib')
    file(join(local, 'package.json'), JSON.stringify({
      name: 'resolution-lib', version: '2.0.0', type: 'module', main: './index.cjs',
    }))
    file(join(local, 'index.cjs'), 'module.exports = { marker: 2 }\n')
    const generation = await generationOf(f)
    expect(generation.localPackageNames).toEqual(['resolution-lib'])
    const registration = installProfileResolution(generation)
    registrations.push(registration)

    expect(createRequire(join(f.profile.dir, 'entry.cjs')).resolve('resolution-lib/only-install.cjs'))
      .toBe(join(f.installed, 'only-install.cjs'))
    rmSync(join(local, 'package.json'))
    expect(createRequire(join(f.profile.dir, 'entry.cjs')).resolve('resolution-lib/legacy-install.cjs'))
      .toBe(join(f.installed, 'legacy-install.cjs'))
  })

  it('treats null exports as legacy CommonJS package resolution', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'package.json'), JSON.stringify({
      name: 'test-profile',
      private: true,
      dependencies: { 'resolution-lib': '*' },
    }))
    file(join(f.installed, 'package.json'), JSON.stringify({
      name: 'resolution-lib', version: '1.0.0', type: 'module', exports: null,
    }))
    const installedSubpath = join(f.installed, 'only-install.cjs')
    file(installedSubpath, 'module.exports = { marker: 8 }\n')
    const local = join(f.profile.dir, 'node_modules', 'resolution-lib')
    file(join(local, 'package.json'), JSON.stringify({
      name: 'resolution-lib', version: '2.0.0', type: 'module', exports: null,
    }))
    const generation = await healProfilesModuleFallback({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    const require = createRequire(join(local, 'entry.cjs'))
    expect(require.resolve('resolution-lib/only-install.cjs')).toBe(installedSubpath)
    unlinkSync(join(generation.profilesDir, 'node_modules', 'resolution-lib'))

    const registration = installProfileResolution(generation)
    registrations.push(registration)
    expect(require.resolve('resolution-lib/only-install.cjs')).toBe(installedSubpath)
  })

  it('stops a local CommonJS probe before the generation fallback position', async () => {
    const f = fixture()
    file(join(f.installed, 'package.json'), JSON.stringify({
      name: 'resolution-lib', version: '1.0.0', type: 'module', main: './index.cjs',
    }))
    const installedSubpath = join(f.installed, 'only-install.cjs')
    file(installedSubpath, 'module.exports = { marker: 8 }\n')
    const generation = await healProfilesModuleFallback({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    file(join(f.profile.dir, 'node_modules', 'resolution-lib', 'package.json'), JSON.stringify({
      name: 'resolution-lib', version: '2.0.0', main: './index.cjs',
    }))
    file(join(f.profile.dir, 'node_modules', 'resolution-lib', 'index.cjs'), 'module.exports = {}\n')
    file(join(f.root, 'node_modules', 'resolution-lib', 'package.json'), JSON.stringify({
      name: 'resolution-lib', version: '3.0.0', exports: './index.cjs',
    }))
    file(join(f.root, 'node_modules', 'resolution-lib', 'index.cjs'), 'module.exports = {}\n')
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require.resolve('resolution-lib/only-install.cjs')).toBe(installedSubpath)
    unlinkSync(join(generation.profilesDir, 'node_modules', 'resolution-lib'))

    const registration = installProfileResolution(generation)
    registrations.push(registration)
    expect(require.resolve('resolution-lib/only-install.cjs')).toBe(installedSubpath)
  })

  it('observes a profile-local package installed after an earlier miss', async () => {
    const f = fixture()
    const registration = installProfileResolution(await generationOf(f))
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
    const registration = installProfileResolution(await generationOf(f))
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

  it('keeps a legacy CommonJS package without a manifest ahead of the generation', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'node_modules', 'resolution-lib', 'index.js'), 'module.exports = { marker: 2 }\n')
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    expect(createRequire(join(f.profile.dir, 'entry.cjs'))('resolution-lib')).toEqual({ marker: 2 })
  })

  it('keeps a manifestless local CommonJS subpath ahead of the generation', async () => {
    const f = fixture()
    const localSubpath = join(f.profile.dir, 'node_modules', 'resolution-lib', 'sub.cjs')
    file(localSubpath, 'module.exports = { marker: 2 }\n')
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require.resolve('resolution-lib/sub.cjs')).toBe(localSubpath)

    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    expect(require.resolve('resolution-lib/sub.cjs')).toBe(localSubpath)
  })

  it('keeps a local extensionless CommonJS package ahead of the generation', async () => {
    const f = fixture()
    const local = join(f.profile.dir, 'node_modules', 'resolution-lib')
    file(local, 'module.exports = { marker: 2 }\n')
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require.resolve('resolution-lib')).toBe(local)

    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    expect(require.resolve('resolution-lib')).toBe(local)
  })

  it('keeps a local legacy main outside its package directory ahead of the generation', async () => {
    const f = fixture()
    const local = join(f.profile.dir, 'node_modules', 'resolution-lib')
    const outside = join(f.profile.dir, 'node_modules', 'outside.cjs')
    file(join(local, 'package.json'), JSON.stringify({ name: 'resolution-lib', main: '../outside.cjs' }))
    file(outside, 'module.exports = { marker: 2 }\n')
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require.resolve('resolution-lib')).toBe(outside)

    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    expect(require.resolve('resolution-lib')).toBe(outside)
  })

  it('keeps a missing local legacy main error ahead of the generation', async () => {
    const f = fixture()
    const local = join(f.profile.dir, 'node_modules', 'resolution-lib')
    file(join(local, 'package.json'), JSON.stringify({ name: 'resolution-lib', main: './missing.cjs' }))
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    const linkError = thrownError(() => require.resolve('resolution-lib'))
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    const runtimeError = thrownError(() => require.resolve('resolution-lib'))

    expect(runtimeError).toMatchObject({
      code: linkError.code,
      path: linkError.path,
      requestPath: linkError.requestPath,
    })
    expect(runtimeError.message).toBe(linkError.message)
  })

  it('keeps a profile-local CommonJS package file ahead of the generation', async () => {
    const f = fixture()
    file(join(f.profile.dir, 'node_modules', 'resolution-lib.js'), 'module.exports = { marker: 2 }\n')
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    expect(createRequire(join(f.profile.dir, 'entry.cjs'))('resolution-lib')).toEqual({ marker: 2 })
    expect(resolveFrom('resolution-lib', pathToFileURL(join(f.profile.dir, 'entry.mjs')).href)).toBe(
      pathToFileURL(join(f.installed, 'index.js')).href,
    )
  })

  it('preserves the ESM and CommonJS behavior of an empty local package directory', async () => {
    const f = fixture()
    mkdirSync(join(f.profile.dir, 'node_modules', 'resolution-lib'), { recursive: true })
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    expect(createRequire(join(f.profile.dir, 'entry.cjs'))('resolution-lib')).toEqual({ marker: 1 })
    expect(() => resolveFrom(
      'resolution-lib', pathToFileURL(join(f.profile.dir, 'entry.mjs')).href,
    )).toThrow(/Cannot find/u)
  })

  it('limits bundle-only entries to the active profile', async () => {
    const f = fixture()
    const bundleDir = join(f.root, 'bundle')
    pkg(bundleDir, 'test-bundle', 0, { 'bundle-only': '*' })
    const bundleOnly = join(bundleDir, 'node_modules', 'bundle-only')
    pkg(bundleOnly, 'bundle-only', 4)
    f.profile.layers.push({
      packageName: 'test-bundle',
      packageDir: bundleDir,
      patchPath: join(bundleDir, 'cordis.patch.yml'),
      patches: [],
    })
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    expect(createRequire(join(f.profile.dir, 'entry.cjs'))('bundle-only')).toEqual({ marker: 4 })
    const other = join(f.root, 'profiles', 'other', 'entry.cjs')
    expect(() => { createRequire(other)('bundle-only') }).toThrow(/Cannot find module/u)
    const resolvedBundleOnly = createRequire(other).resolve('bundle-only', {
      paths: [dirname(other), f.profile.dir],
    })
    expect(realpathSync.native(resolvedBundleOnly)).toBe(realpathSync.native(join(bundleOnly, 'index.cjs')))
    expect(() => createRequire(other).resolve('bundle-only', { paths: [dirname(other)] }))
      .toThrow(/Cannot find module/u)
    expect(() => createRequire(other).resolve('missing-explicit', { paths: [dirname(other)] }))
      .toThrow(/Cannot find module/u)
    file(join(f.root, 'node_modules', 'invalid-after-fallback', 'package.json'), '{')
    expect(() => createRequire(other).resolve('invalid-after-fallback', {
      paths: [dirname(other), f.profile.dir],
    })).toThrow(/Invalid package config/u)
    file(join(f.root, 'node_modules', 'invalid-explicit', 'package.json'), '{')
    expect(() => createRequire(other).resolve('invalid-explicit', {
      paths: [dirname(other), f.profile.dir],
    })).toThrow(/Invalid package config/u)
  })

  it('keeps the generation ahead of packages above the shared fallback position', async () => {
    const f = fixture()
    pkg(join(f.root, 'node_modules', 'resolution-lib'), 'resolution-lib', 2)
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require('resolution-lib')).toEqual({ marker: 1 })
    expect(await importFrom('resolution-lib', pathToFileURL(join(f.profile.dir, 'entry.mjs')).href))
      .toMatchObject({ marker: 1 })
  })

  it('continues the original ancestor lookup after a generation subpath miss', async () => {
    const f = fixture()
    const home = join(f.root, 'home')
    const profileDir = join(home, 'profiles', 'test')
    const profile = {
      ...f.profile,
      dir: profileDir,
      patchPath: join(profileDir, 'cordis.patch.yml'),
    }
    file(join(profileDir, 'package.json'), JSON.stringify({ name: 'test-profile', private: true }))
    file(join(profileDir, 'node_modules', 'resolution-lib', 'package.json'), JSON.stringify({
      name: 'resolution-lib', version: '2.0.0',
    }))
    file(join(f.installed, 'package.json'), JSON.stringify({
      name: 'resolution-lib', version: '1.0.0', type: 'module', main: './index.cjs',
    }))
    const ancestorSubpath = join(home, 'node_modules', 'resolution-lib', 'sub.cjs')
    file(ancestorSubpath, 'module.exports = { marker: 3 }\n')
    const generation = await healProfilesModuleFallback({
      installAnchor: f.installAnchor,
      profile,
      home,
    })
    const require = createRequire(join(profileDir, 'entry.cjs'))
    expect(require.resolve('resolution-lib')).toBe(join(f.installed, 'index.cjs'))
    expect(require.resolve('resolution-lib/sub.cjs')).toBe(ancestorSubpath)
    unlinkSync(join(generation.profilesDir, 'node_modules', 'resolution-lib'))

    const registration = installProfileResolution(generation)
    registrations.push(registration)
    expect(require.resolve('resolution-lib')).toBe(join(f.installed, 'index.cjs'))
    expect(require.resolve('resolution-lib/sub.cjs')).toBe(ancestorSubpath)
  })

  it('continues explicit CommonJS paths after a generation subpath miss', async () => {
    const f = fixture()
    file(join(f.installed, 'package.json'), JSON.stringify({
      name: 'resolution-lib', version: '1.0.0', type: 'module', main: './index.cjs',
    }))
    const alternative = join(f.root, 'alternative')
    const alternativeSubpath = join(alternative, 'node_modules', 'resolution-lib', 'sub.cjs')
    file(alternativeSubpath, 'module.exports = { marker: 4 }\n')
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)

    expect(createRequire(join(f.profile.dir, 'entry.cjs')).resolve('resolution-lib/sub.cjs', {
      paths: [f.profile.dir, alternative],
    })).toBe(alternativeSubpath)
  })

  it('skips stale shared and profile-owned fallback entries when the generation misses', async () => {
    const f = fixture()
    pkg(join(f.root, 'profiles', 'node_modules', 'stale-shared'), 'stale-shared', 9)
    pkg(join(f.root, 'node_modules', 'stale-shared'), 'stale-shared', 3)
    const target = join(f.root, 'stale-private-target')
    const owned = join(f.profile.dir, '.dsh-module-fallback', 'node_modules', 'stale-private')
    const projected = join(f.profile.dir, 'node_modules', 'stale-private')
    pkg(target, 'stale-private', 9)
    mkdirSync(dirname(owned), { recursive: true })
    symlinkSync(target, owned, process.platform === 'win32' ? 'junction' : 'dir')
    mkdirSync(dirname(projected), { recursive: true })
    symlinkSync(owned, projected, process.platform === 'win32' ? 'junction' : 'dir')
    pkg(join(f.root, 'node_modules', 'stale-private'), 'stale-private', 3)
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    for (const name of ['stale-shared', 'stale-private']) {
      expect(require(name)).toEqual({ marker: 3 })
      expect(require.resolve(name, { paths: [f.profile.dir] })).toBe(join(f.root, 'node_modules', name, 'index.cjs'))
      expect(await importFrom(name, pathToFileURL(join(f.profile.dir, `${name}.mjs`)).href))
        .toMatchObject({ marker: 3 })
    }
  })

  it('continues after a canonicalized profiles directory from the matching parent tree', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-profile-generation-symlink-')))
    roots.push(root)
    const carrier = join(root, 'carrier')
    const profilesDir = join(root, 'home', 'profiles')
    const realProfilesDir = join(carrier, 'profiles')
    const realProfileDir = join(realProfilesDir, 'test')
    mkdirSync(realProfileDir, { recursive: true })
    mkdirSync(dirname(profilesDir), { recursive: true })
    symlinkSync(realProfilesDir, profilesDir, process.platform === 'win32' ? 'junction' : 'dir')
    pkg(join(realProfilesDir, 'node_modules', 'stale-only'), 'stale-only', 9)
    pkg(join(carrier, 'node_modules', 'stale-only'), 'stale-only', 3)
    pkg(join(root, 'home', 'node_modules', 'stale-only'), 'stale-only', 4)
    const registration = installProfileResolution({
      profilesDir,
      profileDir: join(profilesDir, 'test'),
      localPackageNames: [],
      entries: [],
    })
    registrations.push(registration)
    expect(createRequire(join(realProfileDir, 'entry.cjs'))('stale-only')).toEqual({ marker: 3 })
  })

  it('leaves conditional exports to Node', async () => {
    const f = fixture('conditional-lib')
    conditionalPkg(f.installed, 'conditional-lib', 11, 12)
    const local = join(f.profile.dir, 'node_modules', 'conditional-lib')
    conditionalPkg(local, 'conditional-lib', 21, 22)
    const registration = installProfileResolution(await generationOf(f))
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

  it('passes explicit CommonJS conditions to the generation target', async () => {
    const f = fixture('conditional-lib')
    conditionalPkg(f.installed, 'conditional-lib', 11, 12)
    const registration = installProfileResolution(await generationOf(f))
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
    const registration = installProfileResolution(await generationOf(f))
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

    expect(internal.Module._resolveFilename('resolution-lib', parent, false)).toBe(join(f.installed, 'index.cjs'))
    expect(parent.children).toEqual(originalChildren)
  })

  it('reports routed CommonJS failures with the native require stack', async () => {
    const f = fixture()
    file(join(f.installed, 'package.json'), JSON.stringify({
      name: 'resolution-lib', version: '1.0.0', type: 'module', main: './index.cjs',
    }))
    const generation = await healProfilesModuleFallback({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    const linkRequire = createRequire(join(f.profile.dir, 'entry-link.cjs'))
    const linkError = thrownError(() => linkRequire.resolve('resolution-lib/missing.cjs'))
    unlinkSync(join(generation.profilesDir, 'node_modules', 'resolution-lib'))
    const registration = installProfileResolution(generation)
    registrations.push(registration)
    const runtimeRequire = createRequire(join(f.profile.dir, 'entry-runtime.cjs'))
    const runtimeError = thrownError(() => runtimeRequire.resolve('resolution-lib/missing.cjs'))

    expect(runtimeError.requireStack).toEqual([
      join(f.profile.dir, 'entry-runtime.cjs'),
    ])
    expect(runtimeError.message).not.toContain(f.installAnchor)
    expect(linkError.requireStack).toEqual([join(f.profile.dir, 'entry-link.cjs')])
  })

  it('reports routed ESM failures from the original importer', async () => {
    const f = fixture()
    const parent = pathToFileURL(join(f.profile.dir, 'entry.mjs')).href
    const linkMessage = thrownMessage(() => resolveFrom('unavailable-lib', parent))
    const generation = await healProfilesModuleFallback({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    unlinkSync(join(generation.profilesDir, 'node_modules', 'resolution-lib'))
    const registration = installProfileResolution(generation)
    registrations.push(registration)

    expect(thrownMessage(() => resolveFrom('unavailable-lib', parent))).toBe(linkMessage)
    expect(thrownMessage(() => resolveFrom('resolution-lib/private', parent)))
      .toContain(` imported from ${fileURLToPath(parent)}`)
  })

  it('leaves an invalid generation manifest error to Node', async () => {
    const f = fixture()
    const generation = await healProfilesModuleFallback({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    file(join(f.installed, 'package.json'), '{')
    const parent = pathToFileURL(join(f.profile.dir, 'entry.mjs')).href
    expect(() => resolveFrom('resolution-lib', parent)).toThrow(/Invalid package config/u)
    unlinkSync(join(generation.profilesDir, 'node_modules', 'resolution-lib'))
    const registration = installProfileResolution(generation)
    registrations.push(registration)

    expect(() => resolveFrom('resolution-lib', parent)).toThrow(/Invalid package config/u)
  })

  it('does not fall back after Node selects a broken profile-local package', async () => {
    const f = fixture('broken-lib')
    file(join(f.profile.dir, 'node_modules', 'broken-lib', 'package.json'), JSON.stringify({
      name: 'broken-lib',
      exports: './missing.js',
    }))
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(() => { require('broken-lib') }).toThrow(/Cannot find module|could not find/u)
    await expect(importFrom(
      'broken-lib', pathToFileURL(join(f.profile.dir, 'broken-entry.mjs')).href,
    )).rejects.toThrow(/Cannot find module|Cannot find package/u)
  })

  it('does not fall back after the generation selects a missing exports target', async () => {
    const f = fixture()
    file(join(f.installed, 'package.json'), JSON.stringify({
      name: 'resolution-lib', version: '1.0.0', type: 'module', exports: './missing.cjs',
    }))
    pkg(join(f.root, 'node_modules', 'resolution-lib'), 'resolution-lib', 2)
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)

    expect(() => createRequire(join(f.profile.dir, 'entry.cjs')).resolve('resolution-lib'))
      .toThrow(/Cannot find module/u)
  })

  it('does not fall back after the generation selects a missing legacy main', async () => {
    const f = fixture()
    file(join(f.installed, 'package.json'), JSON.stringify({
      name: 'resolution-lib', version: '1.0.0', type: 'module', main: './missing.cjs',
    }))
    unlinkSync(join(f.installed, 'index.cjs'))
    unlinkSync(join(f.installed, 'index.js'))
    pkg(join(f.root, 'node_modules', 'resolution-lib'), 'resolution-lib', 2)
    const registration = installProfileResolution(await generationOf(f))
    registrations.push(registration)

    expect(() => createRequire(join(f.profile.dir, 'entry.cjs')).resolve('resolution-lib'))
      .toThrow(/valid "main" entry/u)
  })

  it('detects a dual-mode mismatch instead of accepting another package', async () => {
    const f = fixture()
    const disk = await healProfilesModuleFallback({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    const second = join(f.root, 'second')
    pkg(second, 'resolution-lib', 2)
    const mismatched = {
      ...disk,
      entries: disk.entries.map(entry => entry.name === 'resolution-lib'
        ? { ...entry, packageDir: second, declarer: join(second, 'package.json') }
        : entry),
    }
    const registration = installProfileResolution(mismatched, 'verify')
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(() => { require.resolve('resolution-lib') }).toThrow(/profile resolution mismatch/u)
    await expect(importFrom(
      'resolution-lib', pathToFileURL(join(f.profile.dir, 'entry.mjs')).href,
    )).rejects.toThrow(/profile resolution mismatch/u)
  })

  it('detects a dual-mode package metadata mismatch before import', async () => {
    const f = fixture()
    const disk = await healProfilesModuleFallback({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    const second = join(f.root, 'second')
    pkg(second, 'resolution-lib', 2)
    const mismatched = {
      ...disk,
      entries: disk.entries.map(entry => entry.name === 'resolution-lib'
        ? { ...entry, packageDir: second, declarer: join(second, 'package.json') }
        : entry),
    }
    const registration = installProfileResolution(mismatched, 'verify')
    registrations.push(registration)

    expect(() => registration.packageDir(
      'resolution-lib', pathToFileURL(join(f.profile.dir, 'metadata.mjs')).href,
    )).toThrow(/profile resolution mismatch/u)
  })

  it('detects a dual-mode package metadata hit present on only one backend', async () => {
    const f = fixture()
    const generation = await generationOf(f)
    const registration = installProfileResolution(generation, 'verify')
    registrations.push(registration)

    expect(() => registration.packageDir(
      'resolution-lib', pathToFileURL(join(f.profile.dir, 'metadata.mjs')).href,
    )).toThrow(/disk selected nothing, generation selected/u)
  })

  it('detects package metadata present only in the dual-mode disk backend', async () => {
    const f = fixture()
    const disk = await healProfilesModuleFallback({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    const registration = installProfileResolution({
      ...disk,
      entries: disk.entries.filter(entry => entry.name !== 'resolution-lib'),
    }, 'verify')
    registrations.push(registration)

    expect(() => registration.packageDir(
      'resolution-lib', pathToFileURL(join(f.profile.dir, 'metadata.mjs')).href,
    )).toThrow(/disk selected .*generation selected nothing/u)
  })

  it('reports a missing dual-mode generation target from the original importer', async () => {
    const f = fixture()
    const disk = await healProfilesModuleFallback({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    const missing = join(f.root, 'missing')
    const mismatched = {
      ...disk,
      entries: disk.entries.map(entry => entry.name === 'resolution-lib'
        ? { ...entry, packageDir: missing, declarer: join(missing, 'package.json') }
        : entry),
    }
    const registration = installProfileResolution(mismatched, 'verify')
    registrations.push(registration)
    const parent = pathToFileURL(join(f.profile.dir, 'entry.mjs')).href

    expect(thrownMessage(() => resolveFrom('resolution-lib', parent))).toContain(fileURLToPath(parent))
  })

  it('accepts matching disk and generation targets in dual mode', async () => {
    const f = fixture()
    const generation = await healProfilesModuleFallback({
      installAnchor: f.installAnchor,
      profile: f.profile,
      home: f.root,
    })
    const registration = installProfileResolution(generation, 'verify')
    registrations.push(registration)
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require.resolve('resolution-lib')).toBe(join(f.installed, 'index.cjs'))
    expect(await importFrom('resolution-lib', pathToFileURL(join(f.profile.dir, 'entry.mjs')).href))
      .toMatchObject({ marker: 1 })
    const parent = pathToFileURL(join(f.profile.dir, 'metadata.mjs')).href
    expect(registration.packageDir('resolution-lib', parent)).toBe(f.installed)
    expect(registration.packageDir('missing-metadata', parent)).toBeUndefined()
    expect(registration.packageDir('node:fs', parent)).toBeUndefined()
    expect(registration.packageDir(
      'missing-metadata', `${pathToFileURL(f.profile.dir).href}/%ZZ`,
    )).toBeUndefined()
  })

  it('publishes an additive generation and replaces its miss cache atomically', async () => {
    const f = fixture()
    const added = join(f.root, 'added')
    pkg(added, 'added-lib', 2)
    const first = await generationOf(f)
    const registration = installProfileResolution(first)
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
    pkg(second, 'resolution-lib', 2)
    const first = await generationOf(f)
    const registration = installProfileResolution(first)
    registrations.push(registration)
    const alias = join(f.root, 'resolution-lib-alias')
    symlinkSync(f.installed, alias, process.platform === 'win32' ? 'junction' : 'dir')
    registration.replace({
      ...first,
      entries: first.entries.map(entry => entry.name === 'resolution-lib'
        ? { ...entry, packageDir: alias }
        : entry),
    })
    const changed = {
      ...first,
      entries: first.entries.map(entry => entry.name === 'resolution-lib'
        ? { ...entry, packageDir: second, version: '2.0.0', declarer: join(second, 'package.json') }
        : entry),
    }
    expect(() => { registration.replace(changed) }).toThrow(/requires a process restart/u)
    expect(() => {
      registration.replace({
        ...first,
        entries: first.entries.map(entry => entry.name === 'resolution-lib'
          ? { ...entry, version: '9.0.0' }
          : entry),
      })
    }).toThrow(/requires a process restart/u)
    expect(() => {
      registration.replace({ ...first, localPackageNames: ['resolution-lib'] })
    }).toThrow(/requires a process restart/u)
    expect(() => {
      registration.replace({ ...first, entries: first.entries.filter(entry => entry.name !== 'resolution-lib') })
    }).toThrow(/requires a process restart/u)
    expect(() => {
      registration.replace({ ...first, profilesDir: join(f.root, 'other-profiles') })
    }).toThrow(/cannot change its profile scope/u)
    registration.replace({ ...first, localPackageNames: ['new-local'] })
    registration.replace({ ...first, localPackageNames: ['new-local'] })
    expect(() => { registration.replace(first) }).toThrow(/removing local package/u)
    expect(registration.packageDir(
      'resolution-lib', pathToFileURL(join(f.profile.dir, 'entry.mjs')).href,
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
    const registration = installProfileResolution(await generationOf(f))
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
    expect(registration.packageDir('resolution-lib/private', profileParent)).toBe(f.installed)
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

  it('leaves the published generation intact when successor construction fails', async () => {
    const f = fixture()
    const first = await generationOf(f)
    const registration = installProfileResolution(first)
    registrations.push(registration)
    await expect(createProfileResolutionGeneration({
      installAnchor: join(f.root, 'missing', 'package.json'),
      profile: f.profile,
      home: f.root,
    })).rejects.toThrow()
    expect(registration.packageDir(
      'resolution-lib', pathToFileURL(join(f.profile.dir, 'entry.mjs')).href,
    )).toBe(f.installed)
  })

  it('publishes and restores the generation inherited by owned Workers', async () => {
    const f = fixture()
    const generation = await generationOf(f)
    const key = '@deepseek-ai/dsh-app-boot/profile-resolution'
    const previous = getEnvironmentData(key)
    const dispose = registerWorkerResolution(generation, 'verify')
    try {
      expect(getEnvironmentData(key)).toEqual({ generation, behavior: 'verify' })
    } finally {
      dispose()
    }
    expect(getEnvironmentData(key)).toBe(previous)
  })

  it('restores CommonJS resolution when the registration is disposed', async () => {
    const f = fixture()
    const registration = installProfileResolution(await generationOf(f))
    const require = createRequire(join(f.profile.dir, 'entry.cjs'))
    expect(require.resolve('resolution-lib')).toBe(join(f.installed, 'index.cjs'))
    registration.dispose()
    expect(() => { require.resolve('resolution-lib') }).toThrow(/Cannot find module/u)
  })
})
