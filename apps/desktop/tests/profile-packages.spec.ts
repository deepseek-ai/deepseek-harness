import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DESKTOP_PROFILE_STATE, migrateDesktopProfileLinks } from '../src/profile-packages.ts'

const roots: string[] = []
const symlinks: string[] = []

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'desktop-profile-migration-'))
  roots.push(root)
  const profile = join(root, 'profile')
  const target = join(root, 'runtime-package')
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  mkdirSync(target)
  return { root, profile, target }
}

function link(target: string, path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
  symlinks.push(path)
}

function writeState(profile: string, links: unknown): void {
  writeFileSync(join(profile, DESKTOP_PROFILE_STATE), JSON.stringify({
    schemaVersion: 'obsolete', runtimeId: null, version: 8, lockHash: false, links,
  }))
}

afterEach(() => {
  for (const path of symlinks.splice(0).reverse()) {
    try {
      if (lstatSync(path).isSymbolicLink()) unlinkSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('removes recorded links and state without interpreting obsolete runtime fields', () => {
  const { profile, target } = fixture()
  const packagePath = join(profile, 'node_modules', '@deepseek-ai/cordis')
  link(target, packagePath)
  writeFileSync(join(target, 'package.json'), '{"name":"@deepseek-ai/cordis"}')
  writeState(profile, [{ name: '@deepseek-ai/cordis', target }])
  migrateDesktopProfileLinks(profile)
  expect(existsSync(packagePath)).toBe(false)
  expect(existsSync(join(profile, DESKTOP_PROFILE_STATE))).toBe(false)
  expect(readFileSync(join(target, 'package.json'), 'utf8')).toContain('@deepseek-ai/cordis')
  expect(() => { migrateDesktopProfileLinks(profile) }).not.toThrow()
})

it('removes an owned broken link without following its target', () => {
  const { profile, target } = fixture()
  const packagePath = join(profile, 'node_modules', 'plugin')
  link(target, packagePath)
  writeState(profile, [{ name: 'plugin', target }])
  rmdirSync(target)
  migrateDesktopProfileLinks(profile)
  expect(() => lstatSync(packagePath)).toThrow()
  expect(existsSync(join(profile, DESKTOP_PROFILE_STATE))).toBe(false)
})

it('preserves a pnpm-installed directory replacing a recorded link', () => {
  const { profile, target } = fixture()
  const packagePath = join(profile, 'node_modules', 'plugin')
  mkdirSync(packagePath)
  writeFileSync(join(packagePath, 'package.json'), '{"name":"plugin","version":"2.0.0"}')
  writeState(profile, [{ name: 'plugin', target }])
  migrateDesktopProfileLinks(profile)
  expect(readFileSync(join(packagePath, 'package.json'), 'utf8')).toContain('2.0.0')
  expect(existsSync(join(profile, DESKTOP_PROFILE_STATE))).toBe(false)
})

it('preserves changed and unrecorded package links', () => {
  const { root, profile, target } = fixture()
  const replacement = join(root, 'user-package')
  mkdirSync(replacement)
  const changed = join(profile, 'node_modules', 'changed')
  const unrecorded = join(profile, 'node_modules', 'unrecorded')
  link(replacement, changed)
  link(target, unrecorded)
  const changedTarget = readlinkSync(changed)
  const unrecordedTarget = readlinkSync(unrecorded)
  writeState(profile, [{ name: 'changed', target }])
  migrateDesktopProfileLinks(profile)
  expect(readlinkSync(changed)).toBe(changedTarget)
  expect(readlinkSync(unrecorded)).toBe(unrecordedTarget)
})

it('leaves an uninitialized profile untouched', () => {
  const { root } = fixture()
  const missingProfile = join(root, 'absent-profile')
  migrateDesktopProfileLinks(missingProfile)
  expect(existsSync(missingProfile)).toBe(false)
})

it.each(['../../outside', '../outside', '@scope/../../outside', '..\\outside'])('rejects escaping package name %s before removing any links', (name) => {
  const { root, profile, target } = fixture()
  const packagePath = join(profile, 'node_modules', 'owned')
  const outside = join(root, 'outside')
  link(target, packagePath)
  link(target, outside)
  writeState(profile, [{ name: 'owned', target }, { name, target }])
  expect(() => { migrateDesktopProfileLinks(profile) }).toThrow('invalid legacy package link')
  expect(lstatSync(packagePath).isSymbolicLink()).toBe(true)
  expect(lstatSync(outside).isSymbolicLink()).toBe(true)
  expect(existsSync(join(profile, DESKTOP_PROFILE_STATE))).toBe(true)
})

it.each(['node_modules', 'node_modules/@scope'])('preserves package links beneath redirected %s', (parent) => {
  const { root, profile, target } = fixture()
  const external = join(root, 'external')
  mkdirSync(external)
  const packagePath = join(external, 'plugin')
  link(target, packagePath)
  if (parent === 'node_modules') rmdirSync(join(profile, 'node_modules'))
  link(external, join(profile, parent))
  writeState(profile, [{ name: parent === 'node_modules' ? 'plugin' : '@scope/plugin', target }])
  migrateDesktopProfileLinks(profile)
  expect(lstatSync(packagePath).isSymbolicLink()).toBe(true)
  expect(existsSync(join(profile, DESKTOP_PROFILE_STATE))).toBe(false)
})
