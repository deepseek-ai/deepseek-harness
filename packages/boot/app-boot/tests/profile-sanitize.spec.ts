/** Recovery preserves user files while removing them from profile startup. */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { initProfile, PROFILE_PATCH_FILENAME, PROFILE_TEMPLATES, readProfileManifest, sanitizeProfile } from '../src/index.ts'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(renameSync).mockClear()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-sanitize-'))
  roots.push(root)
  const dir = join(root, 'profiles', 'web')
  const bundles = PROFILE_TEMPLATES.web!.bundles
  initProfile(dir, [...bundles, 'broken-plugin'])
  const manifestPath = join(dir, 'package.json')
  const manifest = { ...readProfileManifest('test', dir), dependencies: { 'broken-plugin': '1.2.3' }, custom: 'retained' }
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const patch = join(dir, PROFILE_PATCH_FILENAME)
  writeFileSync(patch, ': broken YAML')
  return { root, dir, bundles, manifest, manifestPath, patch }
}

it('recovers a profile without loading its broken plugins or patch', () => {
  const { dir, bundles, manifest, patch } = fixture()
  const packageDir = join(dir, 'node_modules', 'broken-plugin')
  mkdirSync(packageDir, { recursive: true })
  const pluginManifest = join(packageDir, 'package.json')
  writeFileSync(pluginManifest, '{broken')
  const backup = sanitizeProfile('test', dir, bundles)
  expect(backup).toMatch(/cordis\.patch\.yml\.bak-\d{13}$/u)
  expect(existsSync(patch)).toBe(false)
  expect(readFileSync(backup!, 'utf8')).toBe(': broken YAML')
  expect(readFileSync(pluginManifest, 'utf8')).toBe('{broken')
  expect(readProfileManifest('test', dir)).toEqual({ ...manifest, dsh: { profile: { bundles } } })
  initProfile(dir, bundles)
  expect(readFileSync(patch, 'utf8')).toContain('[]')
})

it('preserves previous backups across retries and later recovery actions', () => {
  const timestamp = 1_789_555_200_000
  vi.spyOn(Date, 'now').mockReturnValue(timestamp)
  const { dir, bundles, patch } = fixture()
  const first = sanitizeProfile('test', dir, bundles)!
  expect(sanitizeProfile('test', dir, bundles)).toBeUndefined()
  writeFileSync(patch, 'second patch')
  const second = sanitizeProfile('test', dir, bundles)!
  expect(first).toBe(`${patch}.bak-${timestamp}`)
  expect(second).toBe(`${patch}.bak-${timestamp}-1`)
  writeFileSync(patch, 'third patch')
  expect(sanitizeProfile('test', dir, bundles)).toBe(`${patch}.bak-${timestamp}-2`)
  expect(readFileSync(first, 'utf8')).toBe(': broken YAML')
  expect(readFileSync(second, 'utf8')).toBe('second patch')
  expect(readFileSync(`${patch}.bak-${timestamp}-2`, 'utf8')).toBe('third patch')
})

it('does not create an absent profile and backs up a patch even without a manifest', () => {
  const { root, bundles } = fixture()
  const dir = join(root, 'missing')
  expect(sanitizeProfile('test', dir, bundles)).toBeUndefined()
  expect(existsSync(dir)).toBe(false)
  mkdirSync(dir)
  writeFileSync(join(dir, PROFILE_PATCH_FILENAME), 'orphan patch')
  const backup = sanitizeProfile('test', dir, bundles)!
  expect(readFileSync(backup, 'utf8')).toBe('orphan patch')
  expect(existsSync(join(dir, 'package.json'))).toBe(false)
})

it('leaves the patch untouched when profile JSON is invalid', () => {
  const { dir, bundles, manifestPath, patch } = fixture()
  writeFileSync(manifestPath, '{broken')
  expect(() => sanitizeProfile('test', dir, bundles)).toThrow()
  expect(readFileSync(patch, 'utf8')).toBe(': broken YAML')
  expect(readdirSync(dir).some(name => name.includes('.bak-'))).toBe(false)
})

it('propagates backup failures before changing activation', () => {
  const { dir, bundles, manifest, patch } = fixture()
  const error = Object.assign(new Error('patch rename denied'), { code: 'EACCES' })
  vi.mocked(renameSync).mockImplementationOnce(() => { throw error })
  expect(() => sanitizeProfile('test', dir, bundles)).toThrow(error)
  expect(readFileSync(patch, 'utf8')).toBe(': broken YAML')
  expect(readProfileManifest('test', dir)).toEqual(manifest)
})
