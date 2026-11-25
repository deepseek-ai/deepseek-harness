/** The bundle each plugin row of a profile is bound to, and which requests resolve again from that bundle. */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ModuleLoader } from '@deepseek-ai/cordis-plugin-loader'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { installRuntimeInterception, type RuntimeInterception } from '../src/profile-resolution/resolver.ts'
import {
  createRuntimeResolution, initProfile, loadProfileDirectory, reportBundlePluginWarnings,
  type Profile, type ProfileLayer, type RuntimeResolution,
} from '../src/profile.ts'

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

/** Write a dual-format package whose exports carry `marker`, and return its manifest path. */
function pkg(dir: string, name: string, marker: number, manifest: Record<string, unknown> = {}): string {
  file(join(dir, 'package.json'), JSON.stringify({
    name, version: `${String(marker)}.0.0`, type: 'module',
    exports: { '.': { import: './index.js', require: './index.cjs' }, './feature': './feature.js' },
    ...manifest,
  }))
  file(join(dir, 'index.js'), `export const marker = ${String(marker)}\n`)
  file(join(dir, 'index.cjs'), `module.exports = { marker: ${String(marker)} }\n`)
  file(join(dir, 'feature.js'), `export const feature = ${String(marker)}\n`)
  return join(dir, 'package.json')
}

function link(target: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

/** Resolve an ESM request the way the Loader resolves a plugin row. */
function resolveFrom(specifier: string, parentURL: string): string {
  const loader = ModuleLoader.fromInternal()
  if (loader === undefined) throw new Error('the test needs the Node module loader')
  return loader.version === 'v2'
    ? loader.resolveSync(parentURL, { specifier, attributes: {} }).url
    : loader.resolveSync(specifier, parentURL, {}).url
}

function thrownCode(callback: () => unknown): string | undefined {
  try {
    callback()
  } catch (error) {
    return (error as NodeJS.ErrnoException).code
  }
  return undefined
}

/**
 * An installation whose `@deepseek-ai/dsh-base` bundle depends on `storage`, and an empty profile named `web`.
 * `root` stands for the Harness home; the installation lies outside the profiles tree.
 */
function world() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-bundle-plugins-')))
  roots.push(root)
  const installDir = join(root, 'install')
  const installAnchor = pkg(installDir, '@deepseek-ai/dsh', 0, { dependencies: { '@deepseek-ai/dsh-base': '*' } })
  const baseDir = join(installDir, 'node_modules', '@deepseek-ai', 'dsh-base')
  pkg(baseDir, '@deepseek-ai/dsh-base', 1, { dependencies: { storage: '*' } })
  const installedStorage = join(installDir, 'node_modules', 'storage')
  pkg(installedStorage, 'storage', 1)
  const profileDir = join(root, 'profiles', 'web')
  file(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }))
  const profile: Profile = {
    name: 'web', dir: profileDir, layers: [], skippedBundles: [],
    patchPath: join(profileDir, 'cordis.patch.yml'), patches: [],
  }
  /** A bundle layer inserting one row per name. */
  const layer = (packageName: string, packageDir: string, ...names: string[]): ProfileLayer => ({
    packageName, packageDir, patchPaths: [],
    patches: [{ insert: names.map((name, index) => ({ id: `${packageName}:${String(index)}`, name })) }],
  })
  /** A bundle installed in the profile's node_modules, with these dependencies. */
  const profileBundle = (name: string, dependencies: Record<string, string> = {}): string => {
    const dir = join(profileDir, 'node_modules', name)
    pkg(dir, name, 5, { dependencies })
    return dir
  }
  const compute = async (layers: ProfileLayer[]) => await createRuntimeResolution({
    installAnchor, home: root, profile: { ...profile, layers },
  })
  return {
    root, installDir, installAnchor, baseDir, installedStorage, profileDir, profile, layer, profileBundle, compute,
    base: layer('@deepseek-ai/dsh-base', baseDir, 'storage'),
    /** The URL the root config tree requests its rows from. */
    tree: pathToFileURL(profileDir).href + '/',
  }
}

function install(resolution: RuntimeResolution): RuntimeInterception {
  const registration = installRuntimeInterception(resolution)
  registrations.push(registration)
  return registration
}

/** The package directory a row of the config tree loads under a resolution. */
function rowDir(resolution: RuntimeResolution, tree: string, name: string): string | undefined {
  const registration = installRuntimeInterception(resolution)
  try {
    return registration.packageDir(name, tree)
  } finally {
    registration.dispose()
  }
}

/** The same table without its bundle plugins, which routes every request as a resolution without bindings does. */
function withoutSelection(resolution: RuntimeResolution): RuntimeResolution {
  const { profilesDir, profileDir, localPackageNames, entries, linkedRoots } = resolution
  return { profilesDir, profileDir, localPackageNames, entries, linkedRoots }
}

describe('binding bundle plugins', () => {
  const insert = (...rows: object[]): PatchOptions[] => [{ insert: rows }] as PatchOptions[]
  // Every case reads its patches from a profile bundle that declares `plain`, `@scope/pkg`, `inner`, and `absent` as
  // dependencies. All but `absent` are installed.
  it.each<[string, (root: string) => PatchOptions[], string[]]>([
    ['a row named by a bare package', () => insert({ id: 'a', name: 'plain' }), ['plain']],
    ['a row named by a scoped package', () => insert({ id: 'a', name: '@scope/pkg' }), ['@scope/pkg']],
    ['a row named by a package subpath', () => insert({ id: 'a', name: '@scope/pkg/feature' }), ['@scope/pkg']],
    ['a Loader builtin', () => insert({ id: 'a', name: 'cordis:group' }), []],
    ['a Node builtin', () => insert({ id: 'a', name: 'fs' }), []],
    ['a relative path', () => insert({ id: 'a', name: './plain' }), []],
    ['a package import specifier', () => insert({ id: 'a', name: '#plain' }), []],
    ['a file URL', root => insert({ id: 'a', name: pathToFileURL(join(root, 'local.mjs')).href }), []],
    ['an absolute path', root => insert({ id: 'a', name: join(root, 'local.mjs') }), []],
    ['a package that is not installed', () => insert({ id: 'a', name: 'absent' }), ['absent']],
    ['rows whose name is missing or is not a string', () => insert(
      { id: 'a' }, { id: 'b', name: 123 }, { id: 'c', name: true }, { id: 'd', name: ['plain'] }, { id: 'e', name: { plain: 1 } },
    ), []],
    ['the rows of an inserted group', () => insert({
      id: 'g', name: 'cordis:group', group: true,
      config: [{ id: 'a', name: 'plain' }, { id: 'h', name: 'cordis:group', group: true, config: [{ id: 'b', name: 'inner' }] }],
    }), ['plain', 'inner']],
    ['rows inserted into an existing group', () => [{ id: 'existing', insert: [{ id: 'a', name: 'plain' }] }] as PatchOptions[], ['plain']],
    ['a patch that targets a row by id and states its name', () => [{ id: 'a', name: 'plain' }] as PatchOptions[], []],
    ['a patch that replaces the rows of a group by id', () => [
      { id: 'g', config: [{ id: 'a', name: 'plain' }] },
    ] as PatchOptions[], []],
    // An agent preset lists its rows under `config.plugins`; `absent` stands for the preset plugin.
    ['the rows an inserted row lists under config.plugins', () => insert({
      id: 'preset', name: 'absent', config: { id: 'standard', plugins: [
        { id: 'a', name: 'plain' },
        { id: 'g', name: 'cordis:group', group: true, config: [{ id: 'b', name: 'inner' }] },
        { id: 'nested', name: 'absent', config: { plugins: [{ id: 'c', name: '@scope/pkg/feature' }] } },
      ] },
    }), ['absent', 'plain', 'inner', '@scope/pkg']],
    ['a preset row inside an inserted group', () => insert({
      id: 'g', name: 'cordis:group', group: true,
      config: [{ id: 'preset', name: 'absent', config: { plugins: [{ id: 'a', name: 'plain' }] } }],
    }), ['absent', 'plain']],
    ['a plugins list whose members are not rows', () => insert({
      id: 'preset', name: 'absent',
      config: { plugins: [null, 'plain', 7, ['plain'], { id: 'a' }, { id: 'b', name: 123 }, { id: 'c', name: 'inner' }] },
    }), ['absent', 'inner']],
    ['configurations that hold no plugins list', () => insert(
      { id: 'a', name: 'absent', config: { plugins: { id: 'b', name: 'plain' } } },
      { id: 'c', name: 'absent', config: { plugins: 'plain' } },
      { id: 'd', name: 'absent', config: 'plain' },
      { id: 'e', name: 'absent', config: null },
      { id: 'f', name: 'absent', config: { rows: [{ id: 'g', name: 'plain' }] } },
    ), ['absent']],
    ['a plugins list in the configuration of a group', () => insert({
      id: 'g', name: 'cordis:group', group: true, config: { plugins: [{ id: 'a', name: 'plain' }] },
    }), []],
    ['a patch that replaces the plugins list of a row by id', () => [
      { id: 'preset', config: { plugins: [{ id: 'a', name: 'plain' }] } },
    ] as PatchOptions[], []],
    ['the rows of a group that is named without the group marker', () => insert(
      { id: 'g', name: 'cordis:group', config: [{ id: 'a', name: 'plain' }] },
      { id: 'h', name: '@deepseek-ai/cordis-plugin-group', config: [{ id: 'b', name: 'inner' }] },
    ), ['plain', 'inner']],
    ['an array configuration of a row that is not a group', () => insert({
      id: 'a', name: 'absent', config: [{ id: 'b', name: 'plain' }],
    }), ['absent']],
    ['a disabled row', () => insert({ id: 'a', name: 'plain', disabled: true }), ['plain']],
    ['the same name in several rows and patches', () => [
      { insert: [{ id: 'a', name: 'plain' }, { id: 'b', name: 'plain' }] }, { insert: [{ id: 'c', name: 'plain/feature' }] },
    ] as PatchOptions[], ['plain']],
    ['a patch with no insert list', () => [{ id: 'a', disabled: true }] as PatchOptions[], []],
  ])('reads %s', async (_title, patches, expected) => {
    const w = world()
    const bundleDir = w.profileBundle('third-bundle', { plain: '*', '@scope/pkg': '*', inner: '*', absent: '*' })
    for (const [name, marker] of [['plain', 2], ['@scope/pkg', 3], ['inner', 4]] as const) {
      pkg(join(w.profileDir, 'node_modules', name), name, marker)
    }
    const resolution = await w.compute([{
      packageName: 'third-bundle', packageDir: bundleDir, patchPaths: [], patches: patches(w.profileDir),
    }])
    expect(resolution.bundlePlugins.map(plugin => plugin.name)).toEqual(expected)
  })

  it('binds a package name to the directory of the bundle that inserts its rows and declares the package', async () => {
    const w = world()
    const resolution = await w.compute([w.base])
    expect(resolution.bundlePlugins).toEqual([{ name: 'storage', bundleDir: w.baseDir }])
    expect(resolution.bundlePluginWarnings).toEqual([])
    expect(Object.isFrozen(resolution.bundlePlugins)).toBe(true)
    expect(Object.isFrozen(resolution.bundlePlugins[0])).toBe(true)
    expect(Object.isFrozen(resolution.bundlePluginWarnings)).toBe(true)
  })

  it('binds nothing without a profile, without layers, and from the rows of the profile patch file', async () => {
    const w = world()
    const withoutProfile = await createRuntimeResolution({ installAnchor: w.installAnchor, home: w.root })
    expect(withoutProfile.bundlePlugins).toEqual([])
    expect((await w.compute([])).bundlePlugins).toEqual([])
    // The user's own patch layer is not a bundle layer.
    pkg(join(w.profileDir, 'node_modules', 'storage'), 'storage', 2)
    const userRows = await createRuntimeResolution({
      installAnchor: w.installAnchor, home: w.root,
      profile: { ...w.profile, patches: [{ insert: [{ id: 'mine', name: 'storage' }] }] },
    })
    expect(userRows.bundlePlugins).toEqual([])
  })

  it('binds for a profile whose directory does not exist', async () => {
    const w = world()
    rmSync(w.profileDir, { recursive: true })
    expect(rowDir(await w.compute([w.base]), w.tree, 'storage')).toBe(w.installedStorage)
  })

  it('leaves the dependency tables as they are without bindings', async () => {
    const w = world()
    const third = w.profileBundle('third-bundle', { storage: '*', helper: '*' })
    pkg(join(w.profileDir, 'node_modules', 'storage'), 'storage', 2)
    pkg(join(w.profileDir, 'node_modules', 'helper'), 'helper', 3)
    pkg(join(w.root, 'work', 'linked'), 'linked', 4)
    link(join(w.root, 'work', 'linked'), join(w.profileDir, 'node_modules', 'linked'))
    file(join(w.profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', private: true, dependencies: { 'third-bundle': '*', linked: '*' },
    }))
    const rows = await w.compute([w.base, w.layer('third-bundle', third, 'storage', 'helper')])
    const bare = await w.compute([
      { ...w.base, patches: [] }, { packageName: 'third-bundle', packageDir: third, patchPaths: [], patches: [] },
    ])
    expect(rows.bundlePlugins.map(plugin => plugin.name)).toEqual(['storage', 'helper'])
    expect(bare.bundlePlugins).toEqual([])
    expect(rows.entries).toEqual(bare.entries)
    expect(rows.localPackageNames).toEqual(bare.localPackageNames)
    expect(rows.linkedRoots).toEqual(bare.linkedRoots)
    expect(rows.linkedRoots.map(root => root.name)).toEqual(['linked'])
  })

  describe('several layers naming one package', () => {
    /**
     * Profile bundles that declare another range of `storage` than the base bundle does: `own` carries its own copy,
     * `shared` reaches the installed one.
     */
    function layers() {
      const w = world()
      const own = w.profileBundle('own-bundle', { storage: '2.0.0' })
      const ownStorage = join(own, 'node_modules', 'storage')
      pkg(ownStorage, 'storage', 2)
      const shared = w.profileBundle('shared-bundle', { storage: '^1.0.0' })
      link(w.installedStorage, join(shared, 'node_modules', 'storage'))
      const absent = w.profileBundle('absent-bundle', { 'missing-plugin': '*' })
      return {
        ...w, ownStorage,
        own: w.layer('own-bundle', own, 'storage'),
        shared: w.layer('shared-bundle', shared, 'storage'),
        absent: w.layer('absent-bundle', absent, 'missing-plugin'),
        warning: (later: string, laterCopy: string, first: string, firstCopy: string, firstDir: string) =>
          `bundle "${later}" resolves plugin "storage" to ${laterCopy}, but bundle "${first}" already resolved it to `
          + `${firstCopy}; every "storage" row loads ${firstDir}`,
      }
    }

    it('loads every row of a name from the bundle listed first, and describes the copy a later bundle reaches', async () => {
      const w = layers()
      const resolution = await w.compute([w.base, w.own])
      expect(rowDir(resolution, w.tree, 'storage')).toBe(w.installedStorage)
      expect(resolution.bundlePluginWarnings).toEqual([w.warning(
        'own-bundle', `${w.ownStorage} (version 2.0.0)`, '@deepseek-ai/dsh-base', `${w.installedStorage} (version 1.0.0)`, w.installedStorage,
      )])
    })

    it('records no warning for a later bundle that reaches the same real directory, or for a name one bundle inserts', async () => {
      const w = layers()
      expect((await w.compute([w.base, w.shared])).bundlePluginWarnings).toEqual([])
      expect((await w.compute([w.own, w.absent])).bundlePluginWarnings).toEqual([])
    })

    it('follows the layer order, whichever bundle the installation supplies', async () => {
      const w = layers()
      const resolution = await w.compute([w.own, w.base])
      expect(resolution.bundlePlugins)
        .toEqual([{ name: 'storage', bundleDir: join(w.profileDir, 'node_modules', 'own-bundle') }])
      expect(rowDir(resolution, w.tree, 'storage')).toBe(w.ownStorage)
      expect(resolution.bundlePluginWarnings).toEqual([w.warning(
        '@deepseek-ai/dsh-base', `${w.installedStorage} (version 1.0.0)`, 'own-bundle', `${w.ownStorage} (version 2.0.0)`, w.ownStorage,
      )])
    })

    it('loads the copy the first bundle reaches through a link', async () => {
      const w = layers()
      const resolution = await w.compute([w.shared, w.base, w.own])
      expect(rowDir(resolution, w.tree, 'storage'))
        .toBe(join(w.profileDir, 'node_modules', 'shared-bundle', 'node_modules', 'storage'))
    })

    it('resolves a row from the bundle it is bound to, even where that bundle does not reach the package', async () => {
      const w = layers()
      // The base bundle declares a dependency that the installation does not hold. The profile holds a copy.
      pkg(w.baseDir, '@deepseek-ai/dsh-base', 1, { dependencies: { storage: '*', 'extra-plugin': '*' } })
      const found = join(w.profileDir, 'node_modules', 'extra-plugin')
      pkg(found, 'extra-plugin', 7)
      const resolution = await w.compute([w.layer('@deepseek-ai/dsh-base', w.baseDir, 'extra-plugin')])
      expect(resolution.bundlePlugins).toEqual([{ name: 'extra-plugin', bundleDir: w.baseDir }])
      expect(rowDir(withoutSelection(resolution), w.tree, 'extra-plugin')).toBe(found)
      expect(rowDir(resolution, w.tree, 'extra-plugin')).toBeUndefined()
      install(resolution)
      expect(thrownCode(() => resolveFrom('extra-plugin', w.tree))).toBe('ERR_MODULE_NOT_FOUND')
    })

    it('leaves a name to a later bundle when an earlier bundle inserts the row without declaring the package', async () => {
      const w = layers()
      const undeclared = w.profileBundle('undeclared-bundle')
      const resolution = await w.compute([w.layer('undeclared-bundle', undeclared, 'storage'), w.own])
      expect(resolution.bundlePlugins).toEqual([{ name: 'storage', bundleDir: join(w.profileDir, 'node_modules', 'own-bundle') }])
      expect(rowDir(resolution, w.tree, 'storage')).toBe(w.ownStorage)
      expect(resolution.bundlePluginWarnings).toEqual([])
    })

    it('records one warning per later bundle that binds the name, and none where a bundle reaches no copy', async () => {
      const w = layers()
      const second = w.profileBundle('second-bundle', { storage: '3.0.0' })
      const secondStorage = join(second, 'node_modules', 'storage')
      pkg(secondStorage, 'storage', 3)
      const resolution = await w.compute([w.base, w.own, w.layer('second-bundle', second, 'storage', 'storage/feature')])
      const first = `${w.installedStorage} (version 1.0.0)`
      expect(resolution.bundlePluginWarnings).toEqual([
        w.warning('own-bundle', `${w.ownStorage} (version 2.0.0)`, '@deepseek-ai/dsh-base', first, w.installedStorage),
        w.warning('second-bundle', `${secondStorage} (version 3.0.0)`, '@deepseek-ai/dsh-base', first, w.installedStorage),
      ])
      // Two bundles declare different ranges of a package that neither reaches, or that only one of them reaches.
      const other = w.profileBundle('other-bundle', { 'missing-plugin': '^1.0.0', storage: '^1.0.0' })
      expect((await w.compute([w.absent, w.layer('other-bundle', other, 'missing-plugin')])).bundlePluginWarnings).toEqual([])
      expect((await w.compute([w.base, w.layer('other-bundle', other, 'storage')])).bundlePluginWarnings).toEqual([])
    })

    it('prints each warning once through the launcher report, and nothing without a conflict', async () => {
      const w = layers()
      const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
      onTestFinished(() => { write.mockRestore() })
      const printed = () => write.mock.calls.map(([chunk]) => String(chunk)).filter(text => text.startsWith('t: '))
      const resolution = await w.compute([w.base, w.own])
      expect(resolution.bundlePluginWarnings).toHaveLength(1)
      // Computing a resolution only records the warning.
      expect(printed()).toEqual([])
      reportBundlePluginWarnings('t', resolution)
      expect(printed()).toEqual([`t: warning: ${resolution.bundlePluginWarnings[0]}\n`])
      reportBundlePluginWarnings('t', await w.compute([w.base]))
      expect(printed()).toHaveLength(1)
    })

    it('does not compare the copies of bundles that declare the same range', async () => {
      const w = layers()
      // The same declaration as the base bundle, and another copy in the bundle's own node_modules.
      const same = w.profileBundle('same-bundle', { storage: '*' })
      pkg(join(same, 'node_modules', 'storage'), 'storage', 4)
      const resolution = await w.compute([w.base, w.layer('same-bundle', same, 'storage')])
      expect(resolution.bundlePluginWarnings).toEqual([])
      expect(rowDir(resolution, w.tree, 'storage')).toBe(w.installedStorage)
    })

    it('lists the bound names in the order they are first bound', async () => {
      const w = layers()
      const third = w.profileBundle('third-bundle', { beta: '*' })
      const fourth = w.profileBundle('fourth-bundle', { alpha: '*', beta: '*' })
      pkg(join(w.profileDir, 'node_modules', 'alpha'), 'alpha', 2)
      pkg(join(w.profileDir, 'node_modules', 'beta'), 'beta', 3)
      const resolution = await w.compute([
        w.layer('third-bundle', third, 'beta'), w.base, w.layer('fourth-bundle', fourth, 'alpha', 'beta'),
      ])
      expect(resolution.bundlePlugins.map(plugin => plugin.name)).toEqual(['beta', 'storage', 'alpha'])
    })
  })

  describe('where a bound row resolves', () => {
    it('loads a copy nested in the bundle before a hoisted one', async () => {
      const w = world()
      const bundle = w.profileBundle('third-bundle', { storage: '2.0.0' })
      const nested = join(bundle, 'node_modules', 'storage')
      pkg(nested, 'storage', 2)
      pkg(join(w.profileDir, 'node_modules', 'storage'), 'storage', 3)
      expect(rowDir(await w.compute([w.layer('third-bundle', bundle, 'storage')]), w.tree, 'storage')).toBe(nested)
    })

    // Two profile bundles depend on different versions of `extra`, which the installation does not ship. One version
    // is hoisted into the profile and the other stays in its bundle; `b-bundle` inserts the row.
    it.each<[string, boolean]>([
      ['hoisted, beside a version nested in an earlier bundle', true],
      ['nested, beside a hoisted version of an earlier bundle', false],
    ])('loads the version of the inserting bundle when it is %s', async (_title, hoistsItsOwn) => {
      const w = world()
      const a = w.profileBundle('a-bundle', { extra: '1.0.0' })
      const b = w.profileBundle('b-bundle', { extra: '2.0.0' })
      const top = join(w.profileDir, 'node_modules', 'extra')
      const ofA = hoistsItsOwn ? join(a, 'node_modules', 'extra') : top
      const ofB = hoistsItsOwn ? top : join(b, 'node_modules', 'extra')
      pkg(ofA, 'extra', 1)
      pkg(ofB, 'extra', 2)
      const resolution = await w.compute([w.layer('a-bundle', a), w.layer('b-bundle', b, 'extra')])
      const from = (parent: string) => dirname(fileURLToPath(resolveFrom('extra', parent)))
      const registration = install(withoutSelection(resolution))
      // Without the binding, the row loads the hoisted version, whichever bundle depends on it.
      expect(from(w.tree)).toBe(top)
      registration.replace(resolution)
      expect(from(w.tree)).toBe(ofB)
      // The imports of each bundle keep the version that bundle depends on.
      expect(from(pathToFileURL(join(a, 'index.js')).href)).toBe(ofA)
      expect(from(pathToFileURL(join(b, 'index.js')).href)).toBe(ofB)
    })

    it('resolves a row of a bundle linked into the profile from the real directory of that bundle', async () => {
      const w = world()
      const target = join(w.root, 'work', 'linked-bundle')
      pkg(target, 'linked-bundle', 5, { dependencies: { storage: '2.0.0' } })
      const own = join(target, 'node_modules', 'storage')
      pkg(own, 'storage', 2)
      pkg(join(w.profileDir, 'node_modules', 'storage'), 'storage', 3)
      const linkPath = join(w.profileDir, 'node_modules', 'linked-bundle')
      link(target, linkPath)
      const resolution = await w.compute([w.layer('linked-bundle', linkPath, 'storage')])
      // The binding keeps the directory as the layer spells it; the row is requested from the real directory.
      expect(resolution.bundlePlugins).toEqual([{ name: 'storage', bundleDir: linkPath }])
      expect(rowDir(resolution, w.tree, 'storage')).toBe(own)
      install(resolution)
      expect(fileURLToPath(resolveFrom('storage', w.tree))).toBe(join(own, 'index.js'))
    })

    it('loads the installation package for a profile bundle that declares a package only the installation holds', async () => {
      const w = world()
      const bundle = w.profileBundle('template-bundle', { storage: '*' })
      // A directory at the position that the installation's entry occupies, as an earlier release could leave.
      pkg(join(w.root, 'profiles', 'node_modules', 'storage'), 'storage', 9)
      const resolution = await w.compute([w.layer('template-bundle', bundle, 'storage')])
      expect(resolution.bundlePlugins).toEqual([{ name: 'storage', bundleDir: bundle }])
      expect(rowDir(resolution, w.tree, 'storage')).toBe(w.installedStorage)
    })
  })

  describe('which names a bundle binds', () => {
    /** A profile bundle with this manifest that inserts a `storage` row, beside a copy of `storage` hoisted into the profile. */
    function declaring(manifest: Record<string, unknown>) {
      const w = world()
      const dir = join(w.profileDir, 'node_modules', 'some-bundle')
      pkg(dir, 'some-bundle', 5, manifest)
      const hoisted = join(w.profileDir, 'node_modules', 'storage')
      pkg(hoisted, 'storage', 2)
      return { ...w, dir, hoisted, bundle: w.layer('some-bundle', dir, 'storage') }
    }

    it.each<[string, Record<string, unknown>]>([
      ['as a dependency', { dependencies: { storage: '2.0.0' } }],
      ['as an optional dependency', { optionalDependencies: { storage: '2.0.0' } }],
      ['as a dependency and as a peer', { dependencies: { storage: '2.0.0' }, peerDependencies: { storage: '*' } }],
    ])('binds a package the bundle declares %s', async (_title, manifest) => {
      const w = declaring(manifest)
      const resolution = await w.compute([w.bundle])
      expect(resolution.bundlePlugins).toEqual([{ name: 'storage', bundleDir: w.dir }])
      expect(rowDir(resolution, w.tree, 'storage')).toBe(w.hoisted)
    })

    it.each<[string, Record<string, unknown>]>([
      ['only as a peer', { peerDependencies: { storage: '*' } }],
      ['as a peer and a development dependency', { peerDependencies: { storage: '*' }, devDependencies: { storage: '*' } }],
      ['only as a development dependency', { devDependencies: { storage: '2.0.0' } }],
      ['under no dependency field', {}],
      ['in a dependency field that is null', { dependencies: null }],
      ['for another package only', { dependencies: { other: '*' } }],
    ])('does not bind a package the bundle declares %s, and the row keeps the lookup of the profile directory', async (_title, manifest) => {
      const w = declaring(manifest)
      // A copy the bundle keeps for its own development is not what its row loads.
      pkg(join(w.dir, 'node_modules', 'storage'), 'storage', 3)
      const resolution = await w.compute([w.bundle])
      expect(resolution.bundlePlugins).toEqual([])
      // The profile directory reaches the copy another plugin hoisted before the package the installation ships.
      expect(rowDir(resolution, w.tree, 'storage')).toBe(w.hoisted)
      rmSync(w.hoisted, { recursive: true })
      expect(rowDir(resolution, w.tree, 'storage')).toBe(w.installedStorage)
    })

    it('does not bind a row named like a member that every object inherits', async () => {
      const w = declaring({ dependencies: { storage: '2.0.0' } })
      const resolution = await w.compute([w.layer('some-bundle', w.dir, 'constructor', 'toString')])
      expect(resolution.bundlePlugins).toEqual([])
    })

    it('does not bind the name of the bundle itself, and its own row keeps the lookup of the profile directory', async () => {
      const w = world()
      const bundle = w.profileBundle('self-bundle')
      const resolution = await w.compute([w.layer('self-bundle', bundle, 'self-bundle')])
      expect(resolution.bundlePlugins).toEqual([])
      expect(rowDir(resolution, w.tree, 'self-bundle')).toBe(bundle)
    })

    it('does not bind a host package for a development bundle linked into the profile that declares it as a peer', async () => {
      const w = world()
      const target = join(w.root, 'work', 'linked-bundle')
      pkg(target, 'linked-bundle', 5, { peerDependencies: { storage: '*' }, devDependencies: { storage: '*' } })
      pkg(join(target, 'node_modules', 'storage'), 'storage', 2)
      const linkPath = join(w.profileDir, 'node_modules', 'linked-bundle')
      link(target, linkPath)
      const resolution = await w.compute([w.layer('linked-bundle', linkPath, 'storage')])
      expect(resolution.bundlePlugins).toEqual([])
      expect(rowDir(resolution, w.tree, 'storage')).toBe(w.installedStorage)
    })

    it('reads the dependencies of each bundle from its own manifest', async () => {
      const w = declaring({ dependencies: { storage: '2.0.0' } })
      const other = w.profileBundle('other-bundle', { helper: '*' })
      pkg(join(w.profileDir, 'node_modules', 'helper'), 'helper', 4)
      const resolution = await w.compute([w.layer('other-bundle', other, 'helper', 'storage'), w.layer('some-bundle', w.dir, 'storage', 'helper')])
      expect(resolution.bundlePlugins).toEqual([{ name: 'helper', bundleDir: other }, { name: 'storage', bundleDir: w.dir }])
      expect(resolution.bundlePluginWarnings).toEqual([])
    })

    it('leaves the name to another bundle that declares it, in either order, without a warning', async () => {
      const w = declaring({ peerDependencies: { storage: '*' } })
      for (const layers of [[w.base, w.bundle], [w.bundle, w.base]]) {
        const resolution = await w.compute(layers)
        expect(resolution.bundlePlugins).toEqual([{ name: 'storage', bundleDir: w.baseDir }])
        expect(rowDir(resolution, w.tree, 'storage')).toBe(w.installedStorage)
        expect(resolution.bundlePluginWarnings).toEqual([])
      }
    })
  })
})

describe('requests that use a bundle plugin', () => {
  /** The base bundle's `storage` row, another copy of `storage` hoisted into the profile, and a package installed there. */
  async function hoisted() {
    const w = world()
    const hoistedStorage = join(w.profileDir, 'node_modules', 'storage')
    pkg(hoistedStorage, 'storage', 2)
    const thirdDir = join(w.profileDir, 'node_modules', 'third')
    pkg(thirdDir, 'third', 5, { dependencies: { storage: '2.0.0' } })
    file(join(w.profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', private: true, dependencies: { third: '*' },
    }))
    const resolution = await w.compute([w.base])
    return { ...w, hoistedStorage, thirdDir, resolution }
  }

  type Copy = 'installed' | 'hoisted' | 'other' | 'none'
  type Hoisted = Awaited<ReturnType<typeof hoisted>>
  const outside = (h: Hoisted, ...segments: string[]) => pathToFileURL(join(h.root, ...segments)).href

  // Each row names the copy of `storage` an importer receives without the selection, then with it.
  it.each<[string, (h: Hoisted) => string, Copy, Copy]>([
    ['the profile directory, as the config tree requests rows', h => h.tree, 'hoisted', 'installed'],
    // Node reads a URL without a trailing slash as a file, here one in the profiles directory.
    ['the profile directory without a trailing slash', h => pathToFileURL(h.profileDir).href, 'installed', 'installed'],
    ['a module file in the profile directory', h => outside(h, 'profiles', 'web', 'local.mjs'), 'hoisted', 'hoisted'],
    ['a module file in a subdirectory of the profile', h => outside(h, 'profiles', 'web', 'plugins', 'local.mjs'), 'hoisted', 'hoisted'],
    ['a subdirectory of the profile', h => outside(h, 'profiles', 'web', 'plugins') + '/', 'hoisted', 'hoisted'],
    ['a package installed in the profile', h => pathToFileURL(join(h.thirdDir, 'index.js')).href, 'hoisted', 'hoisted'],
    ['the node_modules directory of the profile', h => outside(h, 'profiles', 'web', 'node_modules') + '/', 'hoisted', 'hoisted'],
    ['another profile that installs its own copy', h => outside(h, 'profiles', 'other') + '/', 'other', 'other'],
    ['another profile without a copy', h => outside(h, 'profiles', 'bare') + '/', 'installed', 'installed'],
    ['the profiles directory', h => outside(h, 'profiles') + '/', 'installed', 'installed'],
    ['the installation directory', h => pathToFileURL(h.installDir).href + '/', 'installed', 'installed'],
    ['a directory outside the profiles tree and the installation', h => outside(h, 'elsewhere') + '/', 'none', 'none'],
  ])('answers an ESM request from %s', async (_title, importer, before, after) => {
    const h = await hoisted()
    const otherStorage = join(h.root, 'profiles', 'other', 'node_modules', 'storage')
    pkg(otherStorage, 'storage', 9)
    const parent = importer(h)
    const directory = { installed: h.installedStorage, hoisted: h.hoistedStorage, other: otherStorage }
    const expected = (copy: Copy) => copy === 'none'
      ? { module: 'ERR_MODULE_NOT_FOUND', subpath: 'ERR_MODULE_NOT_FOUND', packageDir: undefined }
      : { module: join(directory[copy], 'index.js'), subpath: join(directory[copy], 'feature.js'), packageDir: directory[copy] }
    const resolved = (specifier: string) => {
      try {
        return fileURLToPath(resolveFrom(specifier, parent))
      } catch (error) {
        return (error as NodeJS.ErrnoException).code
      }
    }
    const registration = install(withoutSelection(h.resolution))
    const observed = () => ({
      module: resolved('storage'), subpath: resolved('storage/feature'), packageDir: registration.packageDir('storage', parent),
    })
    expect(observed()).toEqual(expected(before))
    registration.replace(h.resolution)
    expect(observed()).toEqual(expected(after))
  })

  it('imports the module of the selected package for a row the config tree requests', async () => {
    const h = await hoisted()
    install(h.resolution)
    const loader = ModuleLoader.fromInternal()
    await expect(loader?.import('storage', h.tree, {})).resolves.toMatchObject({ marker: 1 })
    await expect(loader?.import('storage/feature', h.tree, {})).resolves.toMatchObject({ feature: 1 })
    await expect(loader?.import('third', h.tree, {})).resolves.toMatchObject({ marker: 5 })
  })

  it('leaves CommonJS requests on the lookup of their importer', async () => {
    const h = await hoisted()
    install(h.resolution)
    for (const filename of [join(h.profileDir, 'entry.cjs'), join(h.profileDir, 'plugins', 'entry.cjs'), join(h.thirdDir, 'index.cjs')]) {
      expect(createRequire(filename).resolve('storage')).toBe(join(h.hoistedStorage, 'index.cjs'))
    }
    // createRequire reads a directory URL as a file inside that directory.
    expect(createRequire(h.tree).resolve('storage')).toBe(join(h.hoistedStorage, 'index.cjs'))
  })

  it('selects the bundle plugin when the profile lists the hoisted copy as its own dependency', async () => {
    const h = await hoisted()
    file(join(h.profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', private: true, dependencies: { third: '*', storage: '2.0.0' },
    }))
    const resolution = await h.compute([h.base])
    expect(resolution.localPackageNames).toContain('storage')
    const registration = install(resolution)
    expect(registration.packageDir('storage', h.tree)).toBe(h.installedStorage)
    expect(registration.packageDir('storage', pathToFileURL(join(h.thirdDir, 'index.js')).href)).toBe(h.hoistedStorage)
  })

  it('keeps Node resolving exports and errors inside the selected package', async () => {
    const h = await hoisted()
    install(h.resolution)
    expect(thrownCode(() => resolveFrom('storage/private', h.tree))).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED')
    // The hoisted copy exports the path the selected package lacks; the request does not fall back to it.
    file(join(h.hoistedStorage, 'package.json'), JSON.stringify({
      name: 'storage', version: '2.0.0', type: 'module', exports: { '.': './index.js', './private': './index.js' },
    }))
    expect(thrownCode(() => resolveFrom('storage/private', h.tree))).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED')
  })

  it('leaves names without a selection, and requests that are not packages, on the existing lookup', async () => {
    const h = await hoisted()
    const before = install(withoutSelection(h.resolution))
    const answers = (registration: RuntimeInterception) => ({
      third: registration.packageDir('third', h.tree),
      base: registration.packageDir('@deepseek-ai/dsh-base', h.tree),
      absent: registration.packageDir('absent', h.tree),
      builtin: registration.packageDir('node:fs', h.tree),
      relative: registration.packageDir('./storage', h.tree),
    })
    const expected = answers(before)
    registrations.pop()?.dispose()
    expect(answers(install(h.resolution))).toEqual(expected)
    expect(expected).toMatchObject({ third: h.thirdDir, base: h.baseDir, absent: undefined, builtin: undefined })
  })

  it('answers a profile directory reached through a link by either spelling', async () => {
    const w = world()
    const realDir = join(w.root, 'elsewhere', 'web')
    file(join(realDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }))
    pkg(join(realDir, 'node_modules', 'storage'), 'storage', 2)
    rmSync(w.profileDir, { recursive: true })
    link(realDir, w.profileDir)
    const registration = install(await w.compute([w.base]))
    for (const dir of [w.profileDir, realDir]) {
      expect(registration.packageDir('storage', pathToFileURL(dir).href + '/')).toBe(w.installedStorage)
    }
  })

  it('answers nothing from a table that omits the selection', async () => {
    const h = await hoisted()
    expect(install(withoutSelection(h.resolution)).packageDir('storage', h.tree)).toBe(h.hoistedStorage)
  })

  it('answers the same from the copy of the table an owned Worker receives', async () => {
    const h = await hoisted()
    // Worker environment data is a structured clone of the published resolution.
    const copy = structuredClone({ resolution: h.resolution }).resolution
    expect(copy.bundlePlugins).toEqual(h.resolution.bundlePlugins)
    expect(install(copy).packageDir('storage', h.tree)).toBe(h.installedStorage)
  })

  it('follows a successor whose selection is added, made by another bundle, or dropped', async () => {
    const h = await hoisted()
    const own = h.profileBundle('own-bundle', { storage: '3.0.0' })
    const ownStorage = join(own, 'node_modules', 'storage')
    pkg(ownStorage, 'storage', 3)
    const withoutRows = await h.compute([])
    const byOwnBundle = await h.compute([h.layer('own-bundle', own, 'storage'), h.base])
    const registration = install(withoutRows)
    const answer = () => [registration.packageDir('storage', h.tree), fileURLToPath(resolveFrom('storage', h.tree))]
    const at = (dir: string) => [dir, join(dir, 'index.js')]
    expect(answer()).toEqual(at(h.hoistedStorage))
    registration.replace(h.resolution)
    expect(answer()).toEqual(at(h.installedStorage))
    registration.replace(byOwnBundle)
    expect(answer()).toEqual(at(ownStorage))
    registration.replace(withoutRows)
    expect(answer()).toEqual(at(h.hoistedStorage))
  })
})

describe('recomputing the selection', () => {
  it('reads the bundles and patches the profile holds when the latest generation is computed', async () => {
    const w = world()
    file(join(w.baseDir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-base', version: '1.0.0', type: 'module', dependencies: { storage: '*' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    file(join(w.baseDir, 'cordis.patch.yml'), '- insert:\n    - id: storage\n      name: storage\n')
    rmSync(w.profileDir, { recursive: true })
    initProfile(w.profileDir, [])
    const first = await createRuntimeResolution({
      installAnchor: w.installAnchor, home: w.root, profile: loadProfileDirectory('dsh', w.profileDir, w.installAnchor),
    })
    expect(first.bundlePlugins).toEqual([])

    const manifestPath = join(w.profileDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
    manifest.dsh = { profile: { bundles: ['@deepseek-ai/dsh-base'] } }
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const second = await first.computeLatestResolution()
    expect(second.bundlePlugins.map(plugin => plugin.name)).toEqual(['storage'])
    expect(rowDir(second, w.tree, 'storage')).toBe(w.installedStorage)
    // Enabling a bundle the installation supplies changes no dependency table.
    expect(second.entries).toEqual(first.entries)
    expect(second.localPackageNames).toEqual(first.localPackageNames)
    expect(second.linkedRoots).toEqual(first.linkedRoots)
    expect(first.bundlePlugins).toEqual([])
  })

  it('selects nothing from a bundle the profile could not load', async () => {
    const w = world()
    rmSync(w.profileDir, { recursive: true })
    initProfile(w.profileDir, ['broken-bundle'])
    const broken = join(w.profileDir, 'node_modules', 'broken-bundle')
    pkg(broken, 'broken-bundle', 5, { dsh: { bundle: { patch: './cordis.patch.yml' } } })
    file(join(broken, 'cordis.patch.yml'), 'insert: not a patch list\n')
    pkg(join(w.profileDir, 'node_modules', 'storage'), 'storage', 2)
    const profile = loadProfileDirectory('dsh', w.profileDir, w.installAnchor)
    expect(profile.skippedBundles.map(skipped => skipped.packageName)).toEqual(['broken-bundle'])
    const resolution = await createRuntimeResolution({ installAnchor: w.installAnchor, home: w.root, profile })
    expect(resolution.bundlePlugins).toEqual([])
  })
})
