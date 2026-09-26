/**
 * Profile machinery of `dsh-app-boot`: directory resolution and init,
 * manifest round-trips, two-anchor bundle resolution, patch-layer loading,
 * empty-root composition, and runtime package resolution.
 */

import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  composeEntries,
  createRuntimeResolution,
  getDshRuntimeVersion,
  initProfile,
  loadProfile,
  loadProfileDirectory,
  PROFILE_COMPATIBILITY_FILENAME,
  PROFILE_PATCH_FILENAME,
  PROFILE_TEMPLATES,
  readProfileManifest,
  readProfilePatches,
  removeLinkProjections,
  reportSkippedBundles,
  resolveBundleDir,
  resolveProfileDir,
  writeProfileManifest,
  type Profile,
  type RuntimeResolution,
} from '../src/index.ts'
import { installRuntimeInterception } from '../src/profile-resolution/resolver.ts'

const tempRoots: string[] = []
afterAll(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const tmp = (): string => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-profile-')))
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
  return { skippedBundles: [],
    name,
    dir,
    layers: [{
      packageName,
      packageDir: join(bundleAnchor, '..'),
      patchPaths: [join(bundleAnchor, '..', 'cordis.patch.yml')],
      patches: [],
    }],
    patchPath: join(dir, PROFILE_PATCH_FILENAME),
    patches: [],
  }
}

async function importFromResolution(
  resolution: RuntimeResolution, specifier: string,
): Promise<Record<string, unknown>> {
  const addon = createRequire(import.meta.url)('node-addon-require-builtin') as {
    requireBuiltin(id: string): unknown
  }
  const loader = addon.requireBuiltin('internal/modules/esm/loader') as {
    getOrInitializeCascadedLoader(): {
      import(specifier: string, parent: string, attributes: ImportAttributes): Promise<Record<string, unknown>>
    }
  }
  const registration = installRuntimeInterception(resolution)
  try {
    const parent = pathToFileURL(join(resolution.profilesDir, 'entry.mjs')).href
    return await loader.getOrInitializeCascadedLoader().import(specifier, parent, {})
  } finally {
    registration.dispose()
  }
}

describe('isolated profile resolution', () => {
  it('resolves peers from each installation without sharing profile state', async () => {
    const home = tmp()
    const bundleAnchor = stageInstallation({ 'bundle-only': {} }, 'external-bundle')
    const anchorA = stageInstallation({ commander: {}, 'pnpm-owned': {} })
    const anchorB = stageInstallation({ commander: {}, 'pnpm-owned': {} })
    const profileA = stageProfile(home, 'desktop-a', bundleAnchor)
    const profileB = stageProfile(home, 'desktop-b', bundleAnchor)
    const consumerA = join(profileA.dir, 'node_modules', 'custom-plugin', 'index.js')
    const consumerB = join(profileB.dir, 'node_modules', 'custom-plugin', 'index.js')
    for (const consumer of [consumerA, consumerB]) {
      mkdirSync(join(consumer, '..'), { recursive: true })
      writeFileSync(consumer, 'module.exports = require("commander")\n')
      writeFileSync(join(consumer, '..', 'package.json'), JSON.stringify({
        name: 'custom-plugin', peerDependencies: { commander: '*' },
      }))
    }
    const installed = join(profileA.dir, 'node_modules', 'pnpm-owned')
    mkdirSync(installed)
    writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'pnpm-owned', main: 'index.js' }))
    writeFileSync(join(installed, 'index.js'), 'module.exports = "profile-installed"\n')

    const resolutionA = await createRuntimeResolution({ installAnchor: anchorA, profile: profileA, home })
    const resolutionB = await createRuntimeResolution({ installAnchor: anchorB, profile: profileB, home })
    let registration = installRuntimeInterception(resolutionA)
    try {
      expect(realpathSync.native(createRequire(consumerA).resolve('commander')))
        .toBe(realpathSync.native(join(anchorA, '..', 'node_modules', 'commander', 'index.js')))
      registration.dispose()
      registration = installRuntimeInterception(resolutionB)
      expect(realpathSync.native(createRequire(consumerB).resolve('commander')))
        .toBe(realpathSync.native(join(anchorB, '..', 'node_modules', 'commander', 'index.js')))
      registration.dispose()
      registration = installRuntimeInterception(resolutionA)
      expect(realpathSync.native(createRequire(consumerA).resolve('pnpm-owned'))).toBe(realpathSync.native(join(installed, 'index.js')))
      expect(readFileSync(join(installed, 'index.js'), 'utf8')).toContain('profile-installed')
      expect(realpathSync.native(createRequire(consumerA).resolve('bundle-only')))
        .toBe(realpathSync.native(join(bundleAnchor, '..', 'node_modules', 'bundle-only', 'index.js')))
      expect(existsSync(join(home, 'profiles', 'node_modules'))).toBe(false)

      registration.dispose()
      registration = installRuntimeInterception(await createRuntimeResolution({
        installAnchor: anchorA, profile: { ...profileA, layers: [] }, home,
      }))
      expect(() => createRequire(consumerA).resolve('bundle-only')).toThrow(/Cannot find module/u)
      expect(resolutionB.entries.find(entry => entry.name === 'bundle-only')?.packageDir)
        .toBe(realpathSync.native(join(bundleAnchor, '..', 'node_modules', 'bundle-only')))
      expect(realpathSync.native(createRequire(consumerA).resolve('commander')))
        .toBe(realpathSync.native(join(anchorA, '..', 'node_modules', 'commander', 'index.js')))
    } finally {
      registration.dispose()
    }
  })
})

describe('resolveProfileDir', () => {
  it('joins the home and rejects traversal-shaped names', () => {
    const home = tmp()
    expect(resolveProfileDir('tui', home)).toBe(join(home, 'profiles', 'tui'))
    for (const bad of ['', '.', '..', 'a/b', 'a\\b']) {
      expect(() => resolveProfileDir(bad, home)).toThrow('invalid profile name')
    }
  })
})

it('composes current files from profile data and retains launch overlay and telemetry precedence', () => {
  const home = tmp()
  const installAnchor = stageInstallation({ base: { patch: '- insert:\n  - id: session-telemetry-otel\n    name: telemetry\n' } })
  const dir = resolveProfileDir('test', home)
  initProfile(dir, ['base'])
  const patchPath = join(dir, 'application.patch.yml')
  writeFileSync(patchPath, '- id: session-telemetry-otel\n  disabled: true\n')
  writeFileSync(join(home, PROFILE_PATCH_FILENAME), '- id: session-telemetry-otel\n  disabled: false\n')
  const context = {
    name: 'test', dir, patchPath, installAnchor, home, cwd: home,
    startedBundles: ['base'],
    overlays: [{ id: 'session-telemetry-otel', disabled: false }], telemetryDisabledEnv: 'false',
  }
  expect(composeEntries([readProfilePatches('test', context)])[0]?.disabled).toBe(true)
  const enabled = { ...context, telemetryDisabledEnv: undefined }
  expect(composeEntries([readProfilePatches('test', enabled)])[0]?.disabled).toBe(false)
  const patches = readProfilePatches('test', enabled)
  patches.at(-1)!.disabled = true
  expect(context.overlays[0]?.disabled).toBe(false)
  writeFileSync(join(home, PROFILE_PATCH_FILENAME), '- id: session-telemetry-otel\n  disabled: true\n')
  expect(composeEntries([readProfilePatches('test', { ...enabled, overlays: [] })])[0]?.disabled).toBe(true)
  writeFileSync(join(home, PROFILE_PATCH_FILENAME), '[]\n')
  expect(composeEntries([readProfilePatches('test', { ...enabled, overlays: [] })])[0]?.disabled).toBe(true)
  writeFileSync(patchPath, '- id: session-telemetry-otel\n  disabled: false\n')
  expect(composeEntries([readProfilePatches('test', { ...enabled, overlays: [] })])[0]?.disabled).toBe(false)
})

describe('initProfile', () => {
  it('creates manifest, user patch layer, and pnpm workspace once, never overwriting', () => {
    const home = tmp()
    const dir = resolveProfileDir('tui', home)
    initProfile(dir, ['@deepseek-ai/dsh-base'])
    const manifest = readProfileManifest('t', dir)
    expect(manifest.dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')).toContain('[]')
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('nodeLinker: hoisted')
    // Re-init keeps user edits.
    writeFileSync(join(dir, PROFILE_PATCH_FILENAME), '- id: x\n  config: {}\n')
    initProfile(dir, ['other'])
    expect(readProfileManifest('t', dir).dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])
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
  })

  it('applies a dsh.bundle.patch list in order, anchoring inserted paths beside each file', () => {
    const anchor = stageInstallation({ 'multi': { patch: '[]\n' }, 'broken': { patch: '[]\n' } })
    const bundleDir = join(anchor, '..', 'node_modules', 'multi')
    mkdirSync(join(bundleDir, 'layers'), { recursive: true })
    writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
      name: 'multi', version: '0.0.0', type: 'module', main: './index.js',
      dsh: { bundle: { patch: ['./first.patch.yml', './layers/second.patch.yml'] } },
    }))
    writeFileSync(join(bundleDir, 'first.patch.yml'), '- insert:\n    - id: a\n      name: ./local.js\n      config: { v: 1 }\n')
    writeFileSync(join(bundleDir, 'layers', 'second.patch.yml'), '- id: a\n  config: { v: 2 }\n- insert:\n    - id: b\n      name: ./local.js\n')
    const brokenManifest = join(anchor, '..', 'node_modules', 'broken', 'package.json')
    writeFileSync(brokenManifest, JSON.stringify({ name: 'broken', version: '0.0.0', dsh: { bundle: { patch: [1] } } }))
    const home = tmp()
    const dir = resolveProfileDir('demo', home)
    initProfile(dir, ['multi', 'broken'])
    const profile = loadProfile('t', 'demo', anchor, home)
    expect(profile.layers.map(layer => ({ ...layer, patches: layer.patches.length }))).toEqual([{
      packageName: 'multi',
      packageDir: bundleDir,
      patchPaths: [join(bundleDir, 'first.patch.yml'), join(bundleDir, 'layers', 'second.patch.yml')],
      patches: 3,
    }])
    expect(composeEntries(profile.layers.map(layer => layer.patches))).toEqual([
      { id: 'a', name: pathToFileURL(join(bundleDir, 'local.js')).href, config: { v: 2 } },
      { id: 'b', name: pathToFileURL(join(bundleDir, 'layers', 'local.js')).href },
    ])
    expect(profile.skippedBundles).toEqual([
      { packageName: 'broken', reason: 'Error: dsh.bundle.patch must be a file path or a list of file paths' },
    ])
  })

  it('auto-initializes only shipped templates and fails loud otherwise', () => {
    const anchor = stageInstallation({})
    const home = tmp()
    expect(() => loadProfile('t', 'custom', anchor, home))
      .toThrow('profile "custom" does not exist')
    expect(PROFILE_TEMPLATES.web?.bundles).toContain('@deepseek-ai/dsh-base')
    expect(PROFILE_TEMPLATES.acp).toEqual({
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'],
    })
    expect(PROFILE_TEMPLATES.sdk).toEqual({
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-sdk-app'],
    })
    expect(PROFILE_TEMPLATES['sdk-minimal']).toEqual({
      bundles: ['@deepseek-ai/dsh-sdk-minimal'],
    })
    loadProfile('t', 'web', anchor, home)
    expect(readProfileManifest('t', resolveProfileDir('web', home)).dsh?.profile?.bundles)
      .toEqual([...PROFILE_TEMPLATES.web?.bundles ?? []])
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
    writeProfileManifest(stock, retiredManifest)
    loadProfile('t', 'headless', anchor, home)
    expect(readProfileManifest('t', stock).dsh?.profile).toEqual({
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
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

  it.each(['missing package', 'invalid manifest', 'not a bundle', 'missing patch', 'invalid patch'])(
    'skips a bundle with %s, retains selections, and retries it on reread', async (failure) => {
      const anchor = stageInstallation({
        before: { patch: '- insert: [{ id: a, name: pkg-a }]\n' },
        broken: { patch: '[]\n' },
        after: { patch: '- id: a\n  config: { value: after }\n' },
      })
      const home = tmp()
      const dir = resolveProfileDir('demo', home)
      initProfile(dir, ['before', 'broken', 'after'])
      const bundleDir = join(anchor, '..', 'node_modules', 'broken')
      const manifestPath = join(bundleDir, 'package.json')
      const patchPath = join(bundleDir, 'cordis.patch.yml')
      const original = readFileSync(manifestPath, 'utf8')
      if (failure === 'missing package') rmSync(bundleDir, { recursive: true })
      if (failure === 'invalid manifest') writeFileSync(manifestPath, '{')
      if (failure === 'not a bundle') writeFileSync(manifestPath, '{}')
      if (failure === 'missing patch') rmSync(patchPath)
      if (failure === 'invalid patch') writeFileSync(patchPath, '[invalid')
      const saved = readFileSync(join(dir, 'package.json'), 'utf8')
      const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
      onTestFinished(() => { warn.mockRestore() })

      const profile = loadProfile('t', 'demo', anchor, home)
      // Loading only records the skip; the launcher reports it once per start.
      expect(warn).not.toHaveBeenCalled()
      expect(profile.layers.map(layer => layer.packageName)).toEqual(['before', 'after'])
      expect(composeEntries(profile.layers.map(layer => layer.patches)))
        .toEqual([{ id: 'a', name: 'pkg-a', config: { value: 'after' } }])
      expect(profile.skippedBundles.map(skipped => skipped.packageName)).toEqual(['broken'])
      reportSkippedBundles('t', profile)
      expect(warn.mock.calls).toEqual([[`t: skipping profile bundle "broken": ${profile.skippedBundles[0]?.reason}\n`]])
      expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(saved)
      const resolution = await createRuntimeResolution({ installAnchor: anchor, profile, home })
      const unavailable = failure === 'missing package' || failure === 'invalid manifest'
      expect(resolution.entries.map(entry => entry.name))
        .toEqual(['dsh-app', 'before', ...unavailable ? [] : ['broken'], 'after'])
      mkdirSync(bundleDir, { recursive: true })
      writeFileSync(manifestPath, original)
      writeFileSync(patchPath, '[]\n')
      expect(loadProfileDirectory('t', dir, anchor).layers.map(layer => layer.packageName))
        .toEqual(['before', 'broken', 'after'])
    },
  )

  it('skips a bundle whose own dsh peers are incompatible until the profile exempts that exact pair', () => {
    const anchor = stageInstallation({
      guarded: { patch: '- insert: [{ id: a, name: pkg-a }]\n' },
      kept: { patch: '- insert: [{ id: b, name: pkg-b }]\n' },
    })
    const manifestPath = join(anchor, '..', 'node_modules', 'guarded', 'package.json')
    writeFileSync(manifestPath, JSON.stringify({
      ...JSON.parse(readFileSync(manifestPath, 'utf8')) as object, peerDependencies: { '@deepseek-ai/dsh': '999.0.0' },
    }))
    const dir = resolveProfileDir('demo', tmp())
    initProfile(dir, ['guarded', 'kept'])
    const denied = loadProfileDirectory('dsh', dir, anchor)
    expect(denied.layers.map(layer => layer.packageName)).toEqual(['kept'])
    expect(denied.skippedBundles).toEqual([{ packageName: 'guarded', reason: expect.stringContaining(
      `Error: Plugin guarded@0.0.0 is incompatible with dsh ${getDshRuntimeVersion()}`,
    ) as string }])
    writeFileSync(join(dir, PROFILE_COMPATIBILITY_FILENAME), JSON.stringify({ 'guarded@0.0.0': [getDshRuntimeVersion()] }))
    expect(loadProfileDirectory('dsh', dir, anchor).layers.map(layer => layer.packageName)).toEqual(['guarded', 'kept'])
  })

  it('still rejects invalid profile manifests and user patches', () => {
    const anchor = stageInstallation({})
    const dir = tmp()
    initProfile(dir, [])
    writeFileSync(join(dir, PROFILE_PATCH_FILENAME), '[invalid')
    expect(() => loadProfileDirectory('t', dir, anchor)).toThrow()
    expect(loadProfileDirectory('t', dir, anchor, { userLayer: false }).layers).toEqual([])
    writeFileSync(join(dir, 'package.json'), '{')
    expect(() => loadProfileDirectory('t', dir, anchor)).toThrow()
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

describe('createRuntimeResolution', () => {
  it('collects the app and bundle dependencies without writing profile packages', async () => {
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
    const resolution = await createRuntimeResolution({ installAnchor: anchor, home })
    expect(resolution.entries.map(entry => entry.name)).toEqual(['dsh-app', 'bundle-a', 'plain-lib', 'dep-of-a'])
    expect(resolution.entries.find(entry => entry.name === 'dep-of-a')?.packageDir).toBe(join(modules, 'dep-of-a'))
    expect(existsSync(join(home, 'profiles', 'node_modules'))).toBe(false)
    await expect(createRuntimeResolution({ installAnchor: anchor, home })).resolves.toEqual(resolution)
  })

  it('keeps selected bundle closures profile-local without overriding installation packages', async () => {
    const installationAnchor = stageInstallation({ shared: {} })
    const bundleA = stageInstallation({ shared: {}, '@scope/bundle-only': {} }, 'selected-bundle-a')
    const bundleB = stageInstallation({ shared: {}, '@scope/bundle-only': {} }, 'selected-bundle-b')
    const home = tmp()
    const profileA = stageProfile(home, 'a', bundleA)
    const profileB = stageProfile(home, 'b', bundleB)
    const resolutionA = await createRuntimeResolution({ installAnchor: installationAnchor, profile: profileA, home })
    await expect(createRuntimeResolution({ installAnchor: installationAnchor, profile: profileA, home }))
      .resolves.toEqual(resolutionA)
    const resolutionB = await createRuntimeResolution({ installAnchor: installationAnchor, profile: profileB, home })

    for (const resolution of [resolutionA, resolutionB]) {
      expect(resolution.entries.find(entry => entry.name === 'shared')).toMatchObject({
        packageDir: join(installationAnchor, '..', 'node_modules', 'shared'), scope: 'installation',
      })
    }
    expect(existsSync(join(home, 'profiles', 'node_modules'))).toBe(false)
    expect(existsSync(join(profileA.dir, 'node_modules', 'shared'))).toBe(false)
    expect(existsSync(join(profileB.dir, 'node_modules', 'shared'))).toBe(false)
    expect(resolutionA.entries.find(entry => entry.name === '@scope/bundle-only')).toMatchObject({
      packageDir: realpathSync.native(join(bundleA, '..', 'node_modules', '@scope', 'bundle-only')), scope: 'profile',
    })
    expect(resolutionB.entries.find(entry => entry.name === '@scope/bundle-only')).toMatchObject({
      packageDir: realpathSync.native(join(bundleB, '..', 'node_modules', '@scope', 'bundle-only')), scope: 'profile',
    })

    const withoutBundles = await createRuntimeResolution({
      installAnchor: installationAnchor,
      profile: { ...profileA, layers: [] },
      home,
    })
    expect(withoutBundles.entries.some(entry => entry.name === '@scope/bundle-only')).toBe(false)
    expect(resolutionB.entries.find(entry => entry.name === '@scope/bundle-only')?.packageDir)
      .toBe(realpathSync.native(join(bundleB, '..', 'node_modules', '@scope', 'bundle-only')))
  })

  it.each([false, true])('discovers dependencies beside a symlinked bundle real path (packaged: %s)', async (packaged) => {
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
    const profile: Profile = { skippedBundles: [],
      name: 'symlinked',
      dir,
      layers: [{
        packageName: 'selected-bundle',
        packageDir: bundleLink,
        patchPaths: [join(bundleLink, 'cordis.patch.yml')],
        patches: [],
      }],
      patchPath: join(dir, PROFILE_PATCH_FILENAME),
      patches: [],
    }

    const previous = Object.getOwnPropertyDescriptor(process, 'pkg')
    Object.defineProperty(process, 'pkg', { configurable: true, value: packaged ? {} : undefined })
    try {
      const resolution = await createRuntimeResolution({ installAnchor: installationAnchor, profile, home })
      expect(resolution.entries.find(entry => entry.name === 'bundle-only')?.packageDir)
        .toBe(realpathSync.native(realDependency))
    } finally {
      if (previous === undefined) Reflect.deleteProperty(process, 'pkg')
      else Object.defineProperty(process, 'pkg', previous)
    }
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
    const profile: Profile = { skippedBundles: [],
      name: 'explicit-roots',
      dir,
      layers: ([['bundle-a', bundleA], ['bundle-b', bundleB]] as const).map(([packageName, packageDir]) => ({
        packageName,
        packageDir,
        patchPaths: [join(packageDir, 'cordis.patch.yml')],
        patches: [],
      })),
      patchPath: join(dir, PROFILE_PATCH_FILENAME),
      patches: [],
    }

    const resolution = await createRuntimeResolution({ installAnchor: installationAnchor, profile, home })

    expect(resolution.entries.find(entry => entry.name === 'nested-only')?.packageDir).toBe(realpathSync.native(nestedOnly))
    expect(resolution.entries.find(entry => entry.name === 'explicit-only')?.packageDir).toBe(realpathSync.native(explicitOnly))
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
    writeFileSync(join(nestedDir, 'index.js'), 'export const nested = "selected"\n')
    const home = tmp()
    const resolution = await createRuntimeResolution({ installAnchor: anchor, home })
    await expect(importFromResolution(resolution, 'bundle-a')).resolves.toMatchObject({ packageName: 'bundle-a' })
    await expect(importFromResolution(resolution, 'nested-esm')).resolves.toMatchObject({ nested: 'selected' })
  })

  it('resolves conditional subpath exports through Node', async () => {
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
    const home = tmp()
    const resolution = await createRuntimeResolution({ installAnchor: anchor, home })
    await expect(importFromResolution(resolution, 'bundle-a/mini')).resolves.toMatchObject({ mini: true })
    await expect(importFromResolution(resolution, 'bundle-a/web')).resolves.toMatchObject({ web: true })
  })

  it('uses the legacy index fallback when a package has no exports or main', async () => {
    const anchor = stageInstallation({ 'bundle-a': { patch: '[]\n' } })
    const bundleDir = join(anchor, '..', 'node_modules', 'bundle-a')
    const manifest = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')) as Record<string, unknown>
    delete manifest.main
    writeFileSync(join(bundleDir, 'package.json'), JSON.stringify(manifest))
    const home = tmp()
    const resolution = await createRuntimeResolution({ installAnchor: anchor, home })
    await expect(importFromResolution(resolution, 'bundle-a')).resolves.toMatchObject({ packageName: 'bundle-a' })
  })

  it('uses Node legacy resolution for an extensionless main entry', async () => {
    const anchor = stageInstallation({ 'bundle-a': { patch: '[]\n' } })
    const bundleDir = join(anchor, '..', 'node_modules', 'bundle-a')
    const manifest = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')) as Record<string, unknown>
    manifest.main = './index'
    writeFileSync(join(bundleDir, 'package.json'), JSON.stringify(manifest))
    const home = tmp()
    const resolution = await createRuntimeResolution({ installAnchor: anchor, home })
    await expect(importFromResolution(resolution, 'bundle-a')).resolves.toMatchObject({ packageName: 'bundle-a' })
  })

  it('fails loud on a missing legacy main entry', async () => {
    const anchor = stageInstallation({ 'bundle-a': { patch: '[]\n' } })
    const bundleDir = join(anchor, '..', 'node_modules', 'bundle-a')
    const manifest = JSON.parse(readFileSync(join(bundleDir, 'package.json'), 'utf8')) as Record<string, unknown>
    delete manifest.main
    writeFileSync(join(bundleDir, 'package.json'), JSON.stringify(manifest))
    rmSync(join(bundleDir, 'index.js'))
    const resolution = await createRuntimeResolution({ installAnchor: anchor, home: tmp() })
    await expect(importFromResolution(resolution, 'bundle-a')).rejects.toMatchObject({ code: 'ERR_MODULE_NOT_FOUND' })
  })

  it('preserves native ESM export errors and null-map legacy resolution', async () => {
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
      const home = tmp()
      const resolution = await createRuntimeResolution({ installAnchor: anchor, home })
      if (mode === 'absent-map') {
        await expect(importFromResolution(resolution, 'bundle-a')).resolves.toMatchObject({ packageName: 'bundle-a' })
      } else {
        const specifier = mode === 'null-subpath' ? 'bundle-a/bad' : 'bundle-a'
        const code = mode === 'missing' ? 'ERR_MODULE_NOT_FOUND'
          : mode === 'directory' ? 'ERR_UNSUPPORTED_DIR_IMPORT'
            : mode === 'null' || mode === 'null-subpath' ? 'ERR_PACKAGE_PATH_NOT_EXPORTED'
              : 'ERR_INVALID_PACKAGE_TARGET'
        await expect(importFromResolution(resolution, specifier)).rejects.toMatchObject({ code })
      }
    }
  })
})

describe('removeLinkProjections', () => {
  const link = (target: string, path: string): void => {
    mkdirSync(dirname(path), { recursive: true })
    symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
  }
  const packageAt = (dir: string, name: string, version: string): void => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
  }

  it('removes only the symlinks that point into .dsh-module-fallback and the directory itself', () => {
    const home = tmp()
    const profile = join(home, 'profiles', 'web')
    const modules = join(profile, 'node_modules')
    const owned = join(profile, '.dsh-module-fallback', 'node_modules')
    packageAt(join(modules, 'my-bundle'), 'my-bundle', '1.0.0')
    packageAt(join(modules, 'my-bundle', 'node_modules', 'bridge'), 'bridge', '1.0.0')
    packageAt(join(modules, '@scope', 'helper'), '@scope/helper', '1.0.0')
    const outside = join(home, 'workspace', 'linked-plugin')
    packageAt(outside, 'linked-plugin', '1.0.0')
    link(outside, join(modules, 'linked-plugin'))
    link(join(modules, 'my-bundle', 'node_modules', 'bridge'), join(owned, 'bridge'))
    link(join(owned, 'bridge'), join(modules, 'bridge'))
    link(join(modules, '@scope', 'helper'), join(owned, '@scope', 'tool'))
    link(join(owned, '@scope', 'tool'), join(modules, '@scope', 'tool'))
    link(join(home, 'missing-target'), join(modules, 'dangling'))

    removeLinkProjections(profile)

    expect(existsSync(join(profile, '.dsh-module-fallback'))).toBe(false)
    expect(lstatSync(join(modules, 'bridge'), { throwIfNoEntry: false })).toBeUndefined()
    expect(lstatSync(join(modules, '@scope', 'tool'), { throwIfNoEntry: false })).toBeUndefined()
    expect(lstatSync(join(modules, 'my-bundle')).isDirectory()).toBe(true)
    expect(existsSync(join(modules, 'my-bundle', 'node_modules', 'bridge', 'package.json'))).toBe(true)
    expect(lstatSync(join(modules, '@scope', 'helper')).isDirectory()).toBe(true)
    expect(lstatSync(join(modules, 'linked-plugin')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(modules, 'linked-plugin'))).toBe(outside)
    expect(lstatSync(join(modules, 'dangling')).isSymbolicLink()).toBe(true)
    expect(() => { removeLinkProjections(profile) }).not.toThrow()
  })

  it('removes the directory when the profile has no node_modules and keeps links whose target parent is gone', () => {
    const home = tmp()
    const profile = join(home, 'profiles', 'web')
    mkdirSync(join(profile, '.dsh-module-fallback', 'node_modules'), { recursive: true })
    removeLinkProjections(profile)
    expect(existsSync(join(profile, '.dsh-module-fallback'))).toBe(false)

    const other = join(home, 'profiles', 'other')
    mkdirSync(join(other, '.dsh-module-fallback', 'node_modules'), { recursive: true })
    link(join(home, 'missing-parent', 'pkg'), join(other, 'node_modules', 'orphan'))
    removeLinkProjections(other)
    expect(existsSync(join(other, '.dsh-module-fallback'))).toBe(false)
    expect(lstatSync(join(other, 'node_modules', 'orphan')).isSymbolicLink()).toBe(true)
  })

  it('leaves a profile without the directory untouched', () => {
    const home = tmp()
    const profile = join(home, 'profiles', 'web')
    packageAt(join(profile, 'node_modules', 'my-plugin'), 'my-plugin', '1.0.0')
    removeLinkProjections(profile)
    removeLinkProjections(join(home, 'profiles', 'absent'))
    expect(existsSync(join(profile, 'node_modules', 'my-plugin', 'package.json'))).toBe(true)
  })
})
