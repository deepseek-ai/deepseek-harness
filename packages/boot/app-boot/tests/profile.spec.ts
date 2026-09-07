/**
 * Profile machinery of `dsh-app-boot`: directory resolution and init,
 * manifest round-trips, two-anchor bundle resolution, patch-layer loading,
 * empty-root composition, and the installation module-fallback healing.
 */

import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync,
  unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { afterAll, describe, expect, it } from 'vitest'
import {
  composeEntries,
  healProfilesModuleFallback,
  initProfile,
  loadProfile,
  loadProfileDirectory,
  PROFILE_PATCH_FILENAME,
  PROFILE_TEMPLATES,
  readProfileManifest,
  resolveBundleDir,
  resolveProfileDir,
  writeProfileManifest,
  type Profile,
} from '../src/index.ts'

const tempRoots: string[] = []
afterAll(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-'))
  tempRoots.push(dir)
  return dir
}

/** Stage a fake installed app: package.json with deps and a node_modules holding bundles. */
function stageInstallation(
  bundles: Record<string, { patch?: string; deps?: Record<string, string> }>,
  appName = 'dsh-app',
): string {
  const root = tmp()
  const appDir = join(root, 'app')
  mkdirSync(join(appDir, 'node_modules'), { recursive: true })
  const appDeps: Record<string, string> = {}
  for (const [name, spec] of Object.entries(bundles)) {
    appDeps[name] = '0.0.0'
    const dir = join(appDir, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name,
      version: '0.0.0',
      type: 'module',
      main: './index.js',
      dependencies: spec.deps ?? {},
      ...spec.patch === undefined ? {} : { dsh: { bundle: { patch: './cordis.patch.yml' } } },
    }))
    writeFileSync(join(dir, 'index.js'), `export const packageName = ${JSON.stringify(name)}\n`)
    if (spec.patch !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), spec.patch)
  }
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({
    name: appName, version: '0.0.0', type: 'module', main: './index.js', dependencies: appDeps,
  }))
  writeFileSync(join(appDir, 'index.js'), `export const packageName = ${JSON.stringify(appName)}\n`)
  return join(appDir, 'package.json')
}

/** Represent one resolved external bundle as a loaded profile layer. */
function stageProfile(home: string, name: string, bundleAnchor: string): Profile {
  const dir = resolveProfileDir(name, home)
  mkdirSync(dir, { recursive: true })
  const packageName = (JSON.parse(readFileSync(bundleAnchor, 'utf8')) as { name: string }).name
  return {
    name,
    dir,
    layers: [{
      packageName,
      packageDir: join(bundleAnchor, '..'),
      patchPath: join(bundleAnchor, '..', 'cordis.patch.yml'),
      patches: [],
    }],
    patchPath: join(dir, PROFILE_PATCH_FILENAME),
    patches: [],
    patchReload: 'live',
  }
}

describe('resolveProfileDir', () => {
  it('joins the home and rejects traversal-shaped names', () => {
    const home = tmp()
    expect(resolveProfileDir('tui', home)).toBe(join(home, 'profiles', 'tui'))
    for (const bad of ['', '.', '..', 'a/b', 'a\\b']) {
      expect(() => resolveProfileDir(bad, home)).toThrow('invalid profile name')
    }
  })
})

describe('initProfile', () => {
  it('creates manifest, user patch layer, and pnpm workspace once, never overwriting', () => {
    const home = tmp()
    const dir = resolveProfileDir('tui', home)
    initProfile(dir, ['@deepseek-ai/dsh-base'])
    const manifest = readProfileManifest('t', dir)
    expect(manifest.dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(manifest.dsh?.profile?.patchReload).toBe('live')
    expect(readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')).toContain('[]')
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('nodeLinker: hoisted')
    // Re-init keeps user edits.
    writeFileSync(join(dir, PROFILE_PATCH_FILENAME), '- id: x\n  config: {}\n')
    initProfile(dir, ['other'], 'startup')
    expect(readProfileManifest('t', dir).dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(readProfileManifest('t', dir).dsh?.profile?.patchReload).toBe('live')
    expect(readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')).toContain('- id: x')
  })
})

describe('manifest round-trip', () => {
  it('writes and reads back, and fails loud on a broken manifest', () => {
    const dir = tmp()
    writeProfileManifest(dir, { name: 'p', dsh: { profile: { bundles: ['a'] } } })
    expect(readProfileManifest('t', dir).dsh?.profile?.bundles).toEqual(['a'])
    writeFileSync(join(dir, 'package.json'), '[]')
    expect(() => readProfileManifest('t', dir)).toThrow('must hold a JSON object')
    expect(() => readProfileManifest('t', join(dir, 'nope'))).toThrow('failed to read profile manifest')
  })
})

describe('resolveBundleDir', () => {
  it('prefers the installation anchor, falls back to the profile, and fails loud', () => {
    const anchor = stageInstallation({ 'in-box': { patch: '[]\n' } })
    const profileDir = tmp()
    mkdirSync(join(profileDir, 'node_modules', 'local-only'), { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), '{}')
    writeFileSync(join(profileDir, 'node_modules', 'local-only', 'package.json'), JSON.stringify({ name: 'local-only', version: '0.0.0' }))
    expect(resolveBundleDir('t', 'in-box', anchor, profileDir)).toContain('in-box')
    expect(resolveBundleDir('t', 'local-only', anchor, profileDir)).toContain('local-only')
    expect(() => resolveBundleDir('t', 'absent', anchor, profileDir)).toThrow('cannot resolve profile bundle')
  })

  it('resolves a package whose exports map omits ./package.json', () => {
    // Common on npm: an exports map without "./package.json" makes
    // require.resolve('<pkg>/package.json') throw ERR_PACKAGE_PATH_NOT_EXPORTED;
    // resolution must fall through to the paths probe instead of misreporting
    // the installed package as missing.
    const anchor = stageInstallation({})
    const profileDir = tmp()
    writeFileSync(join(profileDir, 'package.json'), '{}')
    const dir = join(profileDir, 'node_modules', 'sealed-bundle')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'sealed-bundle',
      version: '0.0.0',
      exports: { '.': './index.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    writeFileSync(join(dir, 'index.js'), '')
    writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
    expect(resolveBundleDir('t', 'sealed-bundle', anchor, profileDir)).toBe(dir)
  })
})

describe('loadProfile', () => {
  it('loads an explicitly owned profile directory outside CLI discovery', () => {
    const anchor = stageInstallation({ 'bundle-a': { patch: '[]\n' } })
    const dir = join(tmp(), 'managed', 'desktop')
    initProfile(dir, ['bundle-a'])
    const profile = loadProfileDirectory('managed app', dir, anchor)
    expect(profile.dir).toBe(dir)
    expect(profile.name).toBe('desktop')
    expect(profile.layers.map(layer => layer.packageName)).toEqual(['bundle-a'])
  })

  it('resolves each dsh.profile.bundles entry to its patch layer in order, plus the user layer', () => {
    const anchor = stageInstallation({
      'bundle-a': { patch: '- insert:\n    - id: a\n      name: pkg-a\n' },
      'bundle-b': { patch: '- id: a\n  config:\n    v: 2\n' },
    })
    const home = tmp()
    const dir = resolveProfileDir('demo', home)
    initProfile(dir, ['bundle-a', 'bundle-b'])
    writeFileSync(join(dir, PROFILE_PATCH_FILENAME), '- id: a\n  config:\n    v: 3\n')
    const profile = loadProfile('t', 'demo', anchor, home)
    expect(profile.layers.map(layer => layer.packageName)).toEqual(['bundle-a', 'bundle-b'])
    expect(profile.patches).toHaveLength(1)
    expect(profile.patchReload).toBe('live')
    const entries = composeEntries([
      ...profile.layers.map(layer => layer.patches),
      profile.patches,
    ])
    expect(entries).toEqual([{ id: 'a', name: 'pkg-a', config: { v: 3 } }])
    // A hand-made profile without the user layer file or dsh section: empty layers, no throw.
    rmSync(join(dir, PROFILE_PATCH_FILENAME))
    expect(loadProfile('t', 'demo', anchor, home).patches).toEqual([])
    writeProfileManifest(dir, { name: 'bare' })
    const bare = loadProfile('t', 'demo', anchor, home)
    expect(bare.layers).toEqual([])
    expect(bare.patchReload).toBe('live')
  })

  it('auto-initializes only shipped templates and fails loud otherwise', () => {
    const anchor = stageInstallation({})
    const home = tmp()
    expect(() => loadProfile('t', 'custom', anchor, home))
      .toThrow('profile "custom" does not exist')
    // The web template auto-initializes on first load. Bundle resolution
    // cannot be asserted to fail here: the source-plane test runner resolves
    // @deepseek-ai/* through tsconfig paths regardless of the staged anchor.
    expect(PROFILE_TEMPLATES.web?.bundles).toContain('@deepseek-ai/dsh-base')
    expect(PROFILE_TEMPLATES.web?.patchReload).toBe('live')
    expect(PROFILE_TEMPLATES.headless?.patchReload).toBe('startup')
    expect(PROFILE_TEMPLATES.acp).toEqual({
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
      patchReload: 'startup',
    })
    expect(PROFILE_TEMPLATES.sdk).toEqual({
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'],
      patchReload: 'startup',
    })
    expect(PROFILE_TEMPLATES['sdk-minimal']).toEqual({
      bundles: ['@deepseek-ai/dsh-sdk-minimal'],
      patchReload: 'startup',
    })
    try {
      loadProfile('t', 'web', anchor, home)
    } catch {
      // Resolution failure is the plain-Node outcome for this empty anchor.
    }
    expect(readProfileManifest('t', resolveProfileDir('web', home)).dsh?.profile?.bundles)
      .toEqual([...PROFILE_TEMPLATES.web?.bundles ?? []])
    expect(readProfileManifest('t', resolveProfileDir('web', home)).dsh?.profile?.patchReload)
      .toBe('live')
  })

  it('normalizes only the exact installation-owned headless bundle tuple', () => {
    const anchor = stageInstallation({
      '@deepseek-ai/dsh-base': { patch: '[]\n' },
      '@deepseek-ai/dsh-web-app': { patch: '[]\n' },
      '@deepseek-ai/dsh-headless': { patch: '[]\n' },
      'custom-bundle': { patch: '[]\n' },
    })
    const home = tmp()
    const stock = resolveProfileDir('headless', home)
    initProfile(stock, [
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless',
    ])
    const retiredManifest = readProfileManifest('t', stock)
    delete retiredManifest.dsh!.profile!.patchReload
    writeProfileManifest(stock, retiredManifest)
    loadProfile('t', 'headless', anchor, home)
    expect(readProfileManifest('t', stock).dsh?.profile).toEqual({
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
      patchReload: 'startup',
    })

    const customHome = tmp()
    const custom = resolveProfileDir('headless', customHome)
    initProfile(custom, [
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless', 'custom-bundle',
    ])
    loadProfile('t', 'headless', anchor, customHome)
    expect(readProfileManifest('t', custom).dsh?.profile?.bundles).toEqual([
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless', 'custom-bundle',
    ])
  })

  it('adds a shipped reload default only to an exact stock tuple and preserves explicit choices', () => {
    const anchor = stageInstallation({
      '@deepseek-ai/dsh-base': { patch: '[]\n' },
      '@deepseek-ai/dsh-web-app': { patch: '[]\n' },
    })
    const stockHome = tmp()
    const stock = resolveProfileDir('web', stockHome)
    initProfile(stock, PROFILE_TEMPLATES.web?.bundles ?? [])
    const stockManifest = readProfileManifest('t', stock)
    delete stockManifest.dsh!.profile!.patchReload
    writeProfileManifest(stock, stockManifest)
    expect(loadProfile('t', 'web', anchor, stockHome).patchReload).toBe('live')
    expect(readProfileManifest('t', stock).dsh?.profile?.patchReload).toBe('live')

    const explicitHome = tmp()
    const explicit = resolveProfileDir('web', explicitHome)
    initProfile(explicit, PROFILE_TEMPLATES.web?.bundles ?? [], 'startup')
    expect(loadProfile('t', 'web', anchor, explicitHome).patchReload).toBe('startup')
  })

  it('fails loud on an unknown patch reload value from disk', () => {
    const anchor = stageInstallation({})
    const home = tmp()
    const dir = resolveProfileDir('demo', home)
    initProfile(dir, [])
    const manifest = readProfileManifest('t', dir)
    const rawProfile = manifest.dsh!.profile as { patchReload?: string }
    rawProfile.patchReload = 'sometimes'
    writeProfileManifest(dir, manifest)
    expect(() => loadProfile('t', 'demo', anchor, home)).toThrow('patchReload must be "live" or "startup"')
  })

  it('fails loud when a listed bundle declares no dsh.bundle', () => {
    const anchor = stageInstallation({ 'not-a-bundle': {} })
    const home = tmp()
    const dir = resolveProfileDir('demo', home)
    initProfile(dir, ['not-a-bundle'])
    expect(() => loadProfile('t', 'demo', anchor, home)).toThrow('declares no dsh.bundle')
  })
})

describe('composeEntries', () => {
  it('applies layers over an empty root and reports skipped patches', () => {
    const warnings: string[] = []
    const entries = composeEntries([
      [{ insert: [{ id: 'x', name: 'pkg-x', config: { a: 1 } }] }],
      [{ id: 'x', config: { a: 2 } }, { id: 'missing', config: {} }],
    ], message => warnings.push(message))
    expect(entries).toEqual([{ id: 'x', name: 'pkg-x', config: { a: 2 } }])
    expect(warnings.join('\n')).toContain('"missing"')
    // Default warn sink: skipped patches are silently dropped (boot repeats them).
    expect(composeEntries([[{ id: 'missing', config: {} }]])).toEqual([])
  })
})

describe('healProfilesModuleFallback', () => {
  it('links the app and bundle dependency surface flat under profiles/node_modules', async () => {
    const anchor = stageInstallation({
      'bundle-a': { patch: '[]\n', deps: { 'dep-of-a': '0.0.0', 'ghost-dep': '0.0.0' } },
      'plain-lib': {},
    })
    // An app dependency that is declared but not installed: skipped, not fatal.
    const appManifest = JSON.parse(readFileSync(anchor, 'utf8')) as { dependencies: Record<string, string> }
    appManifest.dependencies['never-installed'] = '0.0.0'
    writeFileSync(anchor, JSON.stringify(appManifest))
    // dep-of-a lives in the installation's node_modules too.
    const modules = join(anchor, '..', 'node_modules')
    mkdirSync(join(modules, 'dep-of-a'), { recursive: true })
    writeFileSync(join(modules, 'dep-of-a', 'package.json'), JSON.stringify({ name: 'dep-of-a', version: '0.0.0' }))
    const home = tmp()
    await healProfilesModuleFallback({ installAnchor: anchor, home })
    const fallback = join(home, 'profiles', 'node_modules')
    // App deps, the bundle's own deps, and the bundle itself are linked; the
    // plain library is linked as an app dep (harmless), the app itself too.
    for (const name of ['bundle-a', 'plain-lib', 'dep-of-a', 'dsh-app']) {
      expect(lstatSync(join(fallback, name)).isSymbolicLink(), name).toBe(true)
    }
    // Idempotent, and a moved target is re-pointed.
    await healProfilesModuleFallback({ installAnchor: anchor, home })
    const before = readlinkSync(join(fallback, 'dep-of-a'))
    expect(before).toContain('dep-of-a')
  })

  it('throws when a fallback entry is a foreign file or directory', async () => {
    const anchor = stageInstallation({})
    for (const kind of ['file', 'directory']) {
      const home = tmp()
      const entry = join(home, 'profiles', 'node_modules', 'dsh-app')
      mkdirSync(join(entry, '..'), { recursive: true })
      if (kind === 'directory') mkdirSync(entry)
      else writeFileSync(entry, '')
      await expect(healProfilesModuleFallback({ installAnchor: anchor, home })).rejects.toThrow('is not a symlink')
    }
  })

  it('keeps selected bundle closures profile-local without overriding installation packages', async () => {
    const installationAnchor = stageInstallation({ shared: {} })
    const bundleA = stageInstallation({ shared: {}, '@scope/bundle-only': {} }, 'selected-bundle-a')
    const bundleB = stageInstallation({ shared: {}, '@scope/bundle-only': {} }, 'selected-bundle-b')
    const home = tmp()
    const profileA = stageProfile(home, 'a', bundleA)
    const profileB = stageProfile(home, 'b', bundleB)
    await healProfilesModuleFallback({ installAnchor: installationAnchor, profile: profileA, home })
    await healProfilesModuleFallback({ installAnchor: installationAnchor, profile: profileA, home })
    await healProfilesModuleFallback({ installAnchor: installationAnchor, profile: profileB, home })
    const sharedFallback = join(home, 'profiles', 'node_modules')
    const ownedA = join(profileA.dir, '.dsh-module-fallback', 'node_modules', '@scope', 'bundle-only')
    const ownedB = join(profileB.dir, '.dsh-module-fallback', 'node_modules', '@scope', 'bundle-only')

    expect(realpathSync.native(readlinkSync(join(sharedFallback, 'shared'))))
      .toBe(realpathSync.native(join(installationAnchor, '..', 'node_modules', 'shared')))
    expect(existsSync(join(sharedFallback, '@scope', 'bundle-only'))).toBe(false)
    expect(existsSync(join(profileA.dir, 'node_modules', 'shared'))).toBe(false)
    expect(existsSync(join(profileB.dir, 'node_modules', 'shared'))).toBe(false)
    expect(readlinkSync(join(profileA.dir, 'node_modules', '@scope', 'bundle-only'))).toBe(ownedA)
    expect(readlinkSync(ownedA))
      .toBe(realpathSync.native(join(bundleA, '..', 'node_modules', '@scope', 'bundle-only')))
    expect(readlinkSync(join(profileB.dir, 'node_modules', '@scope', 'bundle-only'))).toBe(ownedB)
    expect(readlinkSync(ownedB))
      .toBe(realpathSync.native(join(bundleB, '..', 'node_modules', '@scope', 'bundle-only')))

    await healProfilesModuleFallback({
      installAnchor: installationAnchor,
      profile: { ...profileA, layers: [] },
      home,
    })
    expect(existsSync(join(profileA.dir, 'node_modules', '@scope', 'bundle-only'))).toBe(false)
    expect(existsSync(ownedA)).toBe(false)
    expect(existsSync(join(profileB.dir, 'node_modules', '@scope', 'bundle-only'))).toBe(true)
  })

  it('combines packaged installation proxies with profile-local bundle links', async () => {
    const installationAnchor = stageInstallation({ shared: {} })
    const bundleAnchor = stageInstallation({ shared: {}, 'bundle-only': {} }, 'selected-bundle')
    const home = tmp()
    const profile = stageProfile(home, 'packaged', bundleAnchor)
    Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
    try {
      await healProfilesModuleFallback({ installAnchor: installationAnchor, profile, home })
      expect(lstatSync(join(home, 'profiles', 'node_modules', 'shared')).isDirectory()).toBe(true)
      expect(lstatSync(join(profile.dir, 'node_modules', 'bundle-only')).isSymbolicLink()).toBe(true)
    } finally {
      delete (process as NodeJS.Process & { pkg?: unknown }).pkg
    }
  })

  it('discovers dependencies beside a symlinked bundle real path', async () => {
    const installationAnchor = stageInstallation({})
    const home = tmp()
    const dir = resolveProfileDir('symlinked', home)
    const profileModules = join(dir, 'node_modules')
    const storeModules = join(tmp(), 'node_modules', '.pnpm', 'selected-bundle@0.0.0', 'node_modules')
    const realBundle = join(storeModules, 'selected-bundle')
    const realDependency = join(storeModules, 'bundle-only')
    mkdirSync(realBundle, { recursive: true })
    mkdirSync(realDependency)
    writeFileSync(join(realBundle, 'package.json'), JSON.stringify({
      name: 'selected-bundle',
      dependencies: { 'bundle-only': '0.0.0' },
    }))
    writeFileSync(join(realDependency, 'package.json'), JSON.stringify({ name: 'bundle-only' }))
    mkdirSync(profileModules, { recursive: true })
    const bundleLink = join(profileModules, 'selected-bundle')
    symlinkSync(realBundle, bundleLink, 'junction')
    const profile: Profile = {
      name: 'symlinked',
      dir,
      layers: [{
        packageName: 'selected-bundle',
        packageDir: bundleLink,
        patchPath: join(bundleLink, 'cordis.patch.yml'),
        patches: [],
      }],
      patchPath: join(dir, PROFILE_PATCH_FILENAME),
      patches: [],
      patchReload: 'live',
    }

    await healProfilesModuleFallback({ installAnchor: installationAnchor, profile, home })

    expect(readlinkSync(join(dir, '.dsh-module-fallback', 'node_modules', 'bundle-only')))
      .toBe(realpathSync.native(realDependency))
  })

  it('traverses every explicit bundle root even when a nested package has the same name', async () => {
    const installationAnchor = stageInstallation({})
    const home = tmp()
    const root = tmp()
    const bundleA = join(root, 'bundle-a')
    const nestedBundleB = join(bundleA, 'node_modules', 'bundle-b')
    const nestedOnly = join(nestedBundleB, 'node_modules', 'nested-only')
    const bundleB = join(root, 'bundle-b')
    const explicitOnly = join(bundleB, 'node_modules', 'explicit-only')
    for (const dir of [bundleA, nestedBundleB, nestedOnly, bundleB, explicitOnly]) mkdirSync(dir, { recursive: true })
    writeFileSync(join(bundleA, 'package.json'), JSON.stringify({
      name: 'bundle-a',
      dependencies: { 'bundle-b': '0.0.0' },
    }))
    writeFileSync(join(nestedBundleB, 'package.json'), JSON.stringify({
      name: 'bundle-b',
      dependencies: { 'nested-only': '0.0.0' },
    }))
    writeFileSync(join(nestedOnly, 'package.json'), JSON.stringify({ name: 'nested-only' }))
    writeFileSync(join(bundleB, 'package.json'), JSON.stringify({
      name: 'bundle-b',
      dependencies: { 'explicit-only': '0.0.0' },
    }))
    writeFileSync(join(explicitOnly, 'package.json'), JSON.stringify({ name: 'explicit-only' }))
    const dir = resolveProfileDir('explicit-roots', home)
    const profile: Profile = {
      name: 'explicit-roots',
      dir,
      layers: ([['bundle-a', bundleA], ['bundle-b', bundleB]] as const).map(([packageName, packageDir]) => ({
        packageName,
        packageDir,
        patchPath: join(packageDir, 'cordis.patch.yml'),
        patches: [],
      })),
      patchPath: join(dir, PROFILE_PATCH_FILENAME),
      patches: [],
      patchReload: 'live',
    }

    await healProfilesModuleFallback({ installAnchor: installationAnchor, profile, home })

    const ownedModules = join(dir, '.dsh-module-fallback', 'node_modules')
    expect(readlinkSync(join(ownedModules, 'nested-only'))).toBe(realpathSync.native(nestedOnly))
    expect(readlinkSync(join(ownedModules, 'explicit-only'))).toBe(realpathSync.native(explicitOnly))
  })

  it('ignores owned projections while recomputing an ordered bundle closure', async () => {
    const installationAnchor = stageInstallation({})
    const home = tmp()
    const dir = resolveProfileDir('ordered', home)
    const profileModules = join(dir, 'node_modules')
    const bundleA = join(profileModules, 'bundle-a')
    const bundleB = join(profileModules, 'bundle-b')
    const nested = join(bundleB, 'node_modules', 'bundle-only')
    mkdirSync(bundleA, { recursive: true })
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(bundleA, 'package.json'), JSON.stringify({
      name: 'bundle-a',
      peerDependencies: { 'bundle-only': '0.0.0' },
    }))
    writeFileSync(join(bundleB, 'package.json'), JSON.stringify({
      name: 'bundle-b',
      dependencies: { 'bundle-only': '0.0.0' },
    }))
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ name: 'bundle-only' }))
    const profile: Profile = {
      name: 'ordered',
      dir,
      layers: ([['bundle-a', bundleA], ['bundle-b', bundleB]] as const).map(([packageName, packageDir]) => ({
        packageDir,
        packageName,
        patchPath: join(packageDir, 'cordis.patch.yml'),
        patches: [],
      })),
      patchPath: join(dir, PROFILE_PATCH_FILENAME),
      patches: [],
      patchReload: 'live',
    }

    await healProfilesModuleFallback({ installAnchor: installationAnchor, profile, home })
    await healProfilesModuleFallback({ installAnchor: installationAnchor, profile, home })

    const owned = join(dir, '.dsh-module-fallback', 'node_modules', 'bundle-only')
    expect(readlinkSync(owned)).toBe(realpathSync.native(nested))
    expect(JSON.parse(readFileSync(join(profileModules, 'bundle-only', 'package.json'), 'utf8')))
      .toMatchObject({ name: 'bundle-only' })
  })

  it('cleans owned projections without removing profile-managed entries', async () => {
    const installationAnchor = stageInstallation({})
    const bundleAnchor = stageInstallation({ fallback: {}, 'managed-dir': {}, 'managed-link': {} }, 'selected-bundle')
    const home = tmp()
    const profile = stageProfile(home, 'managed', bundleAnchor)
    await healProfilesModuleFallback({ installAnchor: installationAnchor, profile, home })
    const ownedModules = join(profile.dir, '.dsh-module-fallback', 'node_modules')
    const profileModules = join(profile.dir, 'node_modules')
    const foreignTarget = tmp()
    unlinkSync(join(profileModules, 'managed-dir'))
    mkdirSync(join(profileModules, 'managed-dir'))
    unlinkSync(join(profileModules, 'managed-link'))
    symlinkSync(foreignTarget, join(profileModules, 'managed-link'), 'junction')
    mkdirSync(join(ownedModules, 'foreign-directory'))
    mkdirSync(join(ownedModules, '@foreign', 'directory'), { recursive: true })

    await healProfilesModuleFallback({
      installAnchor: installationAnchor,
      profile: { ...profile, layers: [] },
      home,
    })

    expect(existsSync(join(profileModules, 'fallback'))).toBe(false)
    expect(lstatSync(join(profileModules, 'managed-dir')).isDirectory()).toBe(true)
    expect(readlinkSync(join(profileModules, 'managed-link'))).toBe(foreignTarget)
    expect(existsSync(join(ownedModules, 'fallback'))).toBe(false)
    expect(existsSync(join(ownedModules, 'managed-dir'))).toBe(false)
    expect(existsSync(join(ownedModules, 'managed-link'))).toBe(false)
  })

  it('cleans owned projections whose junction target uses a canonical parent path', async () => {
    const installationAnchor = stageInstallation({})
    const realHome = tmp()
    const aliasRoot = tmp()
    const home = join(aliasRoot, 'home')
    symlinkSync(realHome, home, 'junction')
    const bundleAnchor = stageInstallation({ fallback: {} }, 'selected-bundle')
    const profile = stageProfile(home, 'canonical', bundleAnchor)
    await healProfilesModuleFallback({ installAnchor: installationAnchor, profile, home })
    const profileLink = join(profile.dir, 'node_modules', 'fallback')
    const ownedModules = join(profile.dir, '.dsh-module-fallback', 'node_modules')
    unlinkSync(profileLink)
    symlinkSync(join(realpathSync(ownedModules), 'fallback'), profileLink, 'junction')

    await healProfilesModuleFallback({
      installAnchor: installationAnchor,
      profile: { ...profile, layers: [] },
      home,
    })

    expect(existsSync(profileLink)).toBe(false)
    expect(existsSync(join(ownedModules, 'fallback'))).toBe(false)
  })

  it('replaces a wrong symlink', async () => {
    const anchor = stageInstallation({})
    const home = tmp()
    const fallback = join(home, 'profiles', 'node_modules')
    mkdirSync(fallback, { recursive: true })
    symlinkSync(tmp(), join(fallback, 'dsh-app'), 'junction')
    await healProfilesModuleFallback({ installAnchor: anchor, home })
    expect(readlinkSync(join(fallback, 'dsh-app'))).toContain('app')
  })

  it('retains current links while repairing a missing sibling', async () => {
    const anchor = stageInstallation({ 'bundle-a': { patch: '[]\n' } })
    const home = tmp()
    const fallback = join(home, 'profiles', 'node_modules')
    await healProfilesModuleFallback({ installAnchor: anchor, home })
    const appTarget = readlinkSync(join(fallback, 'dsh-app'))
    unlinkSync(join(fallback, 'bundle-a'))

    await healProfilesModuleFallback({ installAnchor: anchor, home })

    expect(readlinkSync(join(fallback, 'dsh-app'))).toBe(appTarget)
    expect(lstatSync(join(fallback, 'bundle-a')).isSymbolicLink()).toBe(true)
  })

  it('serializes concurrent healers and retains the identical link', async () => {
    const anchor = stageInstallation({})
    const home = tmp()
    await Promise.all([
      healProfilesModuleFallback({ installAnchor: anchor, home }),
      healProfilesModuleFallback({ installAnchor: anchor, home }),
    ])
    const fallback = join(home, 'profiles', 'node_modules')
    expect(lstatSync(join(fallback, 'dsh-app')).isSymbolicLink()).toBe(true)
  })

  it('does not acquire the writer lock for a complete generation', async () => {
    const anchor = stageInstallation({})
    const home = tmp()
    const modules = join(home, 'profiles', 'node_modules')
    await healProfilesModuleFallback({ installAnchor: anchor, home })
    let releaseLock: (() => void) | undefined
    let reportLock: (() => void) | undefined
    const lockHeld = new Promise<void>((resolve) => { reportLock = resolve })
    const release = new Promise<void>((resolve) => { releaseLock = resolve })
    const holder = withFileLock(modules, async () => {
      reportLock?.()
      await release
    })
    await lockHeld

    const healer = healProfilesModuleFallback({ installAnchor: anchor, home })
    const outcome = await Promise.race([
      healer.then(() => 'complete' as const),
      new Promise<'blocked'>(resolve => setTimeout(() => { resolve('blocked') }, 100)),
    ])
    releaseLock?.()
    await Promise.all([holder, healer])
    expect(outcome).toBe('complete')
  })

  it('waits for the module-fallback writer lock before publishing entries', async () => {
    const anchor = stageInstallation({})
    const home = tmp()
    const modules = join(home, 'profiles', 'node_modules')
    mkdirSync(modules, { recursive: true })
    let releaseLock: (() => void) | undefined
    let reportLock: (() => void) | undefined
    const lockHeld = new Promise<void>((resolve) => { reportLock = resolve })
    const release = new Promise<void>((resolve) => { releaseLock = resolve })
    const holder = withFileLock(modules, async () => {
      reportLock?.()
      await release
    })
    await lockHeld

    const healer = healProfilesModuleFallback({ installAnchor: anchor, home })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(existsSync(join(modules, 'dsh-app'))).toBe(false)
    releaseLock?.()
    await Promise.all([holder, healer])
    expect(lstatSync(join(modules, 'dsh-app')).isSymbolicLink()).toBe(true)
  })

  it('writes real ESM proxies for a packaged executable', async () => {
    const anchor = stageInstallation({ 'bundle-a': { patch: '[]\n' } })
    const bundleDir = join(anchor, '..', 'node_modules', 'bundle-a')
    const bundleManifest = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')) as Record<string, unknown>
    bundleManifest.exports = {
      '.': './index.js',
      './feature': './feature.js',
      './legacy/': './legacy/',
      './types': { types: './feature.d.ts' },
    }
    writeFileSync(join(bundleDir, 'package.json'), JSON.stringify(bundleManifest))
    writeFileSync(join(bundleDir, 'feature.js'), 'export const feature = "proxied"\n')
    const home = tmp()
    Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
    try {
      await healProfilesModuleFallback({ installAnchor: anchor, home })
      const fallback = join(home, 'profiles', 'node_modules')
      const proxy = join(fallback, 'bundle-a')
      expect(lstatSync(proxy).isDirectory()).toBe(true)
      const proxyManifest = JSON.parse(readFileSync(join(proxy, 'package.json'), 'utf8')) as {
        version: unknown
        exports: unknown
        dsh: { moduleFallback: { targets: Record<string, unknown> } }
      }
      expect(proxyManifest).toMatchObject({
        version: '0.0.0',
        exports: { '.': './entry-0.js', './feature': './entry-1.js' },
      })
      expect(proxyManifest.dsh.moduleFallback.targets['.']).toEqual(expect.stringContaining('/bundle-a/index.js'))
      await expect(import(join(proxy, 'entry-0.js'))).resolves.toMatchObject({ packageName: 'bundle-a' })
      await expect(import(join(proxy, 'entry-1.js'))).resolves.toMatchObject({ feature: 'proxied' })
      await healProfilesModuleFallback({ installAnchor: anchor, home })
    } finally {
      delete (process as NodeJS.Process & { pkg?: unknown }).pkg
    }
  })

  it('resolves import-only exports from each package installation', async () => {
    const anchor = stageInstallation({
      'bundle-a': { patch: '[]\n', deps: { 'nested-esm': '0.0.0' } },
    })
    const bundleDir = join(anchor, '..', 'node_modules', 'bundle-a')
    const bundleManifest = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')) as Record<string, unknown>
    bundleManifest.exports = { '.': { import: './index.js' } }
    writeFileSync(join(bundleDir, 'package.json'), JSON.stringify(bundleManifest))
    const nestedDir = join(bundleDir, 'node_modules', 'nested-esm')
    mkdirSync(nestedDir, { recursive: true })
    writeFileSync(join(nestedDir, 'package.json'), JSON.stringify({
      name: 'nested-esm',
      version: '0.0.0',
      type: 'module',
      exports: { import: './index.js' },
    }))
    writeFileSync(join(nestedDir, 'index.js'), 'export const nested = "proxied"\n')
    const home = tmp()
    Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
    try {
      await healProfilesModuleFallback({ installAnchor: anchor, home })
      const fallback = join(home, 'profiles', 'node_modules')
      await expect(import(join(fallback, 'bundle-a', 'entry-0.js'))).resolves.toMatchObject({ packageName: 'bundle-a' })
      await expect(import(join(fallback, 'nested-esm', 'entry-0.js'))).resolves.toMatchObject({ nested: 'proxied' })
    } finally {
      delete (process as NodeJS.Process & { pkg?: unknown }).pkg
    }
  })

  it('resolves explicit condition targets without filesystem package lookup', async () => {
    const anchor = stageInstallation({ 'bundle-a': { patch: '[]\n' } })
    const bundleDir = join(anchor, '..', 'node_modules', 'bundle-a')
    const manifest = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')) as Record<string, unknown>
    manifest.exports = {
      '.': { import: './index.js', require: './index.cjs' },
      './mini': { types: './mini/index.d.ts', import: './mini/index.js', require: './mini/index.cjs' },
      './web': { types: './dist/web/web.d.ts', import: './dist/web/index.mjs', default: './dist/web/index.mjs' },
    }
    writeFileSync(join(bundleDir, 'package.json'), JSON.stringify(manifest))
    mkdirSync(join(bundleDir, 'mini'))
    writeFileSync(join(bundleDir, 'mini', 'index.js'), 'export const mini = true\n')
    mkdirSync(join(bundleDir, 'dist', 'web'), { recursive: true })
    writeFileSync(join(bundleDir, 'dist', 'web', 'index.mjs'), 'export const web = true\n')
    Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
    try {
      const home = tmp()
      await healProfilesModuleFallback({ installAnchor: anchor, home })
      const proxy = join(home, 'profiles', 'node_modules', 'bundle-a')
      await expect(import(join(proxy, 'entry-1.js'))).resolves.toMatchObject({ mini: true })
      await expect(import(join(proxy, 'entry-2.js'))).resolves.toMatchObject({ web: true })
    } finally {
      delete (process as NodeJS.Process & { pkg?: unknown }).pkg
    }
  })

  it('preserves the installation path while resolving packaged exports', async () => {
    const anchor = stageInstallation({})
    const appDir = join(anchor, '..')
    const physical = tmp()
    writeFileSync(join(physical, 'package.json'), JSON.stringify({
      name: 'linked-esm',
      version: '0.0.0',
      type: 'module',
      exports: { import: './index.js' },
    }))
    writeFileSync(join(physical, 'index.js'), 'export const linked = true\n')
    symlinkSync(physical, join(appDir, 'node_modules', 'linked-esm'), 'junction')
    const appManifest = JSON.parse(readFileSync(anchor, 'utf8')) as { dependencies: Record<string, string> }
    appManifest.dependencies['linked-esm'] = '0.0.0'
    writeFileSync(anchor, JSON.stringify(appManifest))
    Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
    try {
      const home = tmp()
      await healProfilesModuleFallback({ installAnchor: anchor, home })
      const proxyManifest = JSON.parse(readFileSync(
        join(home, 'profiles', 'node_modules', 'linked-esm', 'package.json'),
        'utf8',
      )) as { dsh: { moduleFallback: { targets: Record<string, string> } } }
      expect(proxyManifest.dsh.moduleFallback.targets['.']).toContain('/app/node_modules/linked-esm/index.js')
    } finally {
      delete (process as NodeJS.Process & { pkg?: unknown }).pkg
    }
  })

  it('uses the legacy index fallback when a package has no exports or main', async () => {
    const anchor = stageInstallation({ 'bundle-a': { patch: '[]\n' } })
    const bundleDir = join(anchor, '..', 'node_modules', 'bundle-a')
    const manifest = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')) as Record<string, unknown>
    delete manifest.main
    writeFileSync(join(bundleDir, 'package.json'), JSON.stringify(manifest))
    Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
    try {
      const home = tmp()
      await healProfilesModuleFallback({ installAnchor: anchor, home })
      await expect(import(join(home, 'profiles', 'node_modules', 'bundle-a', 'entry-0.js')))
        .resolves.toMatchObject({ packageName: 'bundle-a' })
    } finally {
      delete (process as NodeJS.Process & { pkg?: unknown }).pkg
    }
  })

  it('uses Node legacy resolution for an extensionless main entry', async () => {
    const anchor = stageInstallation({ 'bundle-a': { patch: '[]\n' } })
    const bundleDir = join(anchor, '..', 'node_modules', 'bundle-a')
    const manifest = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')) as Record<string, unknown>
    manifest.main = './index'
    writeFileSync(join(bundleDir, 'package.json'), JSON.stringify(manifest))
    Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
    try {
      const home = tmp()
      await healProfilesModuleFallback({ installAnchor: anchor, home })
      await expect(import(join(home, 'profiles', 'node_modules', 'bundle-a', 'entry-0.js')))
        .resolves.toMatchObject({ packageName: 'bundle-a' })
    } finally {
      delete (process as NodeJS.Process & { pkg?: unknown }).pkg
    }
  })

  it('skips executable-only and declaration-only packages without import entries', async () => {
    for (const marker of ['bin', 'types', 'typings']) {
      const anchor = stageInstallation({ 'bundle-a': { patch: '[]\n' } })
      const manifest = JSON.parse(readFileSync(anchor, 'utf8')) as Record<string, unknown>
      delete manifest.main
      manifest[marker] = marker === 'bin' ? { dsh: './lib/bin.js' } : './index.d.ts'
      if (marker === 'types') manifest.main = ''
      writeFileSync(anchor, JSON.stringify(manifest))
      rmSync(join(anchor, '..', 'index.js'))
      Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
      try {
        const home = tmp()
        await healProfilesModuleFallback({ installAnchor: anchor, home })
        const fallback = join(home, 'profiles', 'node_modules')
        expect(existsSync(join(fallback, 'dsh-app'))).toBe(false)
        expect(existsSync(join(fallback, 'bundle-a', 'entry-0.js'))).toBe(true)
      } finally {
        delete (process as NodeJS.Process & { pkg?: unknown }).pkg
      }
    }
  })

  it('fails loud on a missing legacy main entry', async () => {
    const anchor = stageInstallation({ 'bundle-a': { patch: '[]\n' } })
    const bundleDir = join(anchor, '..', 'node_modules', 'bundle-a')
    const manifest = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')) as Record<string, unknown>
    delete manifest.main
    writeFileSync(join(bundleDir, 'package.json'), JSON.stringify(manifest))
    rmSync(join(bundleDir, 'index.js'))
    Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
    try {
      await expect(healProfilesModuleFallback({ installAnchor: anchor, home: tmp() })).rejects.toThrow('main entry is missing')
    } finally {
      delete (process as NodeJS.Process & { pkg?: unknown }).pkg
    }
  })

  it('omits unavailable ESM exports and rejects malformed export targets', async () => {
    for (const mode of ['missing', 'directory', 'absent-map', 'invalid', 'escape', 'null', 'null-subpath']) {
      const anchor = stageInstallation({ 'bundle-a': { patch: '[]\n' } })
      const bundleDir = join(anchor, '..', 'node_modules', 'bundle-a')
      const manifest = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')) as Record<string, unknown>
      const target = mode === 'missing' ? './missing.js'
        : mode === 'directory' ? './mini'
          : mode === 'escape' ? './../outside.js'
            : '../outside.js'
      manifest.exports = mode === 'absent-map' ? null
        : mode === 'null-subpath' ? { './bad': null }
          : { '.': mode === 'null' ? null : { import: target } }
      writeFileSync(join(bundleDir, 'package.json'), JSON.stringify(manifest))
      if (mode === 'directory') mkdirSync(join(bundleDir, 'mini'))
      Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
      try {
        const home = tmp()
        if (mode === 'missing' || mode === 'directory' || mode === 'absent-map') {
          await healProfilesModuleFallback({ installAnchor: anchor, home })
          expect(existsSync(join(home, 'profiles', 'node_modules', 'bundle-a'))).toBe(false)
        } else {
          await expect(healProfilesModuleFallback({ installAnchor: anchor, home })).rejects.toThrow(
            mode === 'null' || mode === 'null-subpath'
              ? 'cannot resolve ESM export bundle-a'
              : 'resolves outside its package',
          )
        }
      } finally {
        delete (process as NodeJS.Process & { pkg?: unknown }).pkg
      }
    }
  })

  it('requires a package version before writing a packaged proxy', async () => {
    const anchor = stageInstallation({ 'bundle-a': { patch: '[]\n' } })
    const bundleDir = join(anchor, '..', 'node_modules', 'bundle-a')
    const manifest = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')) as Record<string, unknown>
    manifest.version = ''
    writeFileSync(join(bundleDir, 'package.json'), JSON.stringify(manifest))
    Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
    try {
      await expect(healProfilesModuleFallback({ installAnchor: anchor, home: tmp() })).rejects.toThrow(
        'installed package bundle-a must declare a non-empty version',
      )
    } finally {
      delete (process as NodeJS.Process & { pkg?: unknown }).pkg
    }
  })

  it('replaces plain-node links and stale managed proxies in packaged mode', async () => {
    const anchor = stageInstallation({ 'bundle-a': { patch: '[]\n' } })
    const home = tmp()
    await healProfilesModuleFallback({ installAnchor: anchor, home })
    const proxy = join(home, 'profiles', 'node_modules', 'bundle-a')
    expect(lstatSync(proxy).isSymbolicLink()).toBe(true)

    Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
    try {
      await healProfilesModuleFallback({ installAnchor: anchor, home })
      expect(lstatSync(proxy).isDirectory()).toBe(true)
      const stale = JSON.parse(readFileSync(join(proxy, 'package.json'), 'utf8')) as {
        version: string
      }
      stale.version = 'stale'
      writeFileSync(join(proxy, 'package.json'), JSON.stringify(stale))
      await healProfilesModuleFallback({ installAnchor: anchor, home })
      expect(JSON.parse(readFileSync(join(proxy, 'package.json'), 'utf8'))).toMatchObject({
        version: '0.0.0',
      })
    } finally {
      delete (process as NodeJS.Process & { pkg?: unknown }).pkg
    }
  })

  it('replaces a managed packaged proxy with a plain-node symlink', async () => {
    const anchor = stageInstallation({ 'bundle-a': { patch: '[]\n' } })
    const home = tmp()
    const fallback = join(home, 'profiles', 'node_modules', 'bundle-a')
    Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
    try {
      await healProfilesModuleFallback({ installAnchor: anchor, home })
      expect(lstatSync(fallback).isDirectory()).toBe(true)
    } finally {
      delete (process as NodeJS.Process & { pkg?: unknown }).pkg
    }

    await healProfilesModuleFallback({ installAnchor: anchor, home })
    expect(lstatSync(fallback).isSymbolicLink()).toBe(true)
  })

  it('rejects foreign packaged fallback directories with valid or invalid metadata', async () => {
    const anchor = stageInstallation({ 'bundle-a': { patch: '[]\n' } })
    Object.defineProperty(process, 'pkg', { configurable: true, value: {} })
    try {
      for (const metadata of ['{}', '{']) {
        const home = tmp()
        const proxy = join(home, 'profiles', 'node_modules', 'bundle-a')
        mkdirSync(proxy, { recursive: true })
        writeFileSync(join(proxy, 'package.json'), metadata)
        await expect(healProfilesModuleFallback({ installAnchor: anchor, home })).rejects.toThrow(
          'exists and is not a dsh-managed module proxy',
        )
      }
    } finally {
      delete (process as NodeJS.Process & { pkg?: unknown }).pkg
    }
  })
})
