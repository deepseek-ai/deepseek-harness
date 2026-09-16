/** Installed metadata and shared bundle activation across profile package operations. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readProfilePlugins, reconcileProfilePlugins, writeProfileBundles, type ProfilePluginLocation } from '../src/profile-plugins.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeManifest(dir: string, value: unknown): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(value))
}

function fixture(): ProfilePluginLocation {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-plugins-'))
  roots.push(root)
  const profileDir = join(root, 'profile')
  const installAnchor = join(root, 'runtime', 'package.json')
  writeManifest(dirname(installAnchor), { name: 'fixture-runtime' })
  writeManifest(profileDir, {})
  return { binName: 'test', profileDir, installAnchor }
}

function installed(location: ProfilePluginLocation, name: string, bundle = true): void {
  writeManifest(join(location.profileDir, 'node_modules', name), {
    name, version: '1.0.0', ...(bundle ? { dsh: { bundle: { patch: 'unbuilt.yml' } } } : {}),
  })
}

describe('profile plugin inventory', () => {
  it('uses dependency alias keys, installed versions, and the loader installation precedence', () => {
    const location = fixture()
    writeManifest(location.profileDir, {
      dependencies: { alias: 'file:../local-package', shared: '^2', library: '^1', missing: 'git+example', unversioned: 'file:../unversioned' },
      dsh: { profile: { bundles: ['shared', 'alias'] } },
    })
    const source = join(location.profileDir, '..', 'local-package')
    writeManifest(source, { name: 'original-name', version: '3.0.0', dsh: { bundle: { patch: 'missing.yml' } } })
    mkdirSync(join(location.profileDir, 'node_modules'))
    symlinkSync(source, join(location.profileDir, 'node_modules', 'alias'), 'junction')
    installed(location, 'shared', false)
    installed(location, 'library', false)
    writeManifest(join(location.profileDir, 'node_modules', 'unversioned'), { name: 'unversioned' })
    writeManifest(join(dirname(location.installAnchor), 'node_modules', 'shared'), {
      name: 'shared', version: '9.0.0', dsh: { bundle: { patch: 'bundle.yml' } },
    })
    expect(readProfilePlugins(location).dependencies).toEqual([
      { name: 'alias', version: '3.0.0', bundle: true, enabled: true },
      { name: 'shared', version: '1.0.0', bundle: true, enabled: true },
      { name: 'library', version: '1.0.0', bundle: false, enabled: false },
      { name: 'missing', version: 'git+example', bundle: false, enabled: false },
      { name: 'unversioned', version: 'file:../unversioned', bundle: false, enabled: false },
    ])
  })

  it('keeps malformed installed metadata visible and accepts an empty profile', () => {
    const location = fixture()
    expect(readProfilePlugins(location)).toEqual({ manifest: {}, dependencies: [] })
    writeManifest(location.profileDir, { dependencies: { broken: '^1', invalid: '^2' } })
    installed(location, 'broken')
    writeFileSync(join(location.profileDir, 'node_modules', 'broken', 'package.json'), '{')
    writeManifest(join(location.profileDir, 'node_modules', 'invalid'), [])
    expect(readProfilePlugins(location).dependencies).toEqual([
      { name: 'broken', version: '^1', bundle: false, enabled: false },
      { name: 'invalid', version: '^2', bundle: false, enabled: false },
    ])
  })
})

describe('profile plugin reconciliation', () => {
  it.each([false, true])('reconciles declarations and removal while preserveDisabled=%s', (preserveDisabled) => {
    const location = fixture()
    const beforeManifest = {
      name: 'custom-profile', private: false, custom: { keep: true },
      dependencies: { active: '^1', disabled: '^1', gaining: '^1', losing: '^1', removed: '^1' },
      dsh: { profile: { bundles: ['template', 'template', 'active', 'losing', 'removed'] } },
    }
    writeManifest(location.profileDir, beforeManifest)
    for (const name of Object.keys(beforeManifest.dependencies)) installed(location, name, name !== 'gaining')
    const before = readProfilePlugins(location)
    writeManifest(location.profileDir, {
      ...beforeManifest,
      dependencies: { active: '^2', disabled: '^2', gaining: '^2', losing: '^2', added: '^1', 'new-library': '^1' },
    })
    installed(location, 'gaining')
    installed(location, 'losing', false)
    installed(location, 'added')
    installed(location, 'new-library', false)
    const result = reconcileProfilePlugins({ ...location, before, preserveDisabled })
    const bundles = ['template', 'template', 'active', ...preserveDisabled ? [] : ['disabled'], 'gaining', 'added']
    expect(result.plugins.manifest.dsh?.profile?.bundles).toEqual(bundles)
    expect(result.plugins.dependencies.filter(dependency => dependency.enabled).map(dependency => dependency.name))
      .toEqual(['active', ...preserveDisabled ? [] : ['disabled'], 'gaining', 'added'])
    expect(result.addedPlainDependencies).toEqual(['new-library'])
    expect(JSON.parse(readFileSync(join(location.profileDir, 'package.json'), 'utf8'))).toMatchObject({
      custom: { keep: true }, private: false, dsh: { profile: { bundles } },
    })
    const bytes = readFileSync(join(location.profileDir, 'package.json'), 'utf8')
    expect(reconcileProfilePlugins({ ...location, before: result.plugins, preserveDisabled }).addedPlainDependencies).toEqual([])
    expect(readFileSync(join(location.profileDir, 'package.json'), 'utf8')).toBe(bytes)
  })

  it('writes newly activated bundles when profile metadata is absent', () => {
    const location = fixture()
    const before = readProfilePlugins(location)
    writeManifest(location.profileDir, { dependencies: { added: '^1' } })
    installed(location, 'added')
    expect(reconcileProfilePlugins({ ...location, before, preserveDisabled: false }).plugins.manifest.dsh?.profile?.bundles)
      .toEqual(['added'])
  })

  it('removes an unresolved dependency layer while preserving custom profile metadata', () => {
    const location = fixture()
    writeManifest(location.profileDir, { dependencies: { missing: '^1' }, dsh: { profile: { bundles: ['missing', 'template'] } } })
    const before = readProfilePlugins(location)
    const reconciled = reconcileProfilePlugins({ ...location, before, preserveDisabled: true })
    expect(reconciled.plugins.manifest.dsh?.profile?.bundles).toEqual(['template'])
    expect(writeProfileBundles(location.profileDir, reconciled.plugins.manifest, ['template', 'manual']).dsh?.profile?.bundles)
      .toEqual(['template', 'manual'])
  })
})
