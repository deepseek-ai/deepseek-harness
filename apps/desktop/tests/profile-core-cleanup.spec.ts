import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { load } from 'js-yaml'
import { cleanProfileCorePackages } from '../src/profile-core-cleanup.ts'

const roots: string[] = []
const core = '@deepseek-ai/dsh-web-app'
const extra = '@deepseek-ai/optional-plugin'

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'desktop-core-cleanup-'))
  roots.push(root)
  mkdirSync(join(root, 'node_modules', core), { recursive: true })
  mkdirSync(join(root, 'node_modules', extra), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    dependencies: { [core]: 'file:./desktop-packages/web.tgz', [extra]: '1.0.0' },
    optionalDependencies: { [core]: '1.0.0' },
    pnpm: { overrides: { [core]: '1.0.0', third: '2.0.0' } },
    dsh: { profile: { bundles: [core, extra] } },
  }))
  writeFileSync(join(root, 'pnpm-workspace.yaml'), `nodeLinker: hoisted\noverrides:\n  '${core}': file:./desktop-packages/web.tgz\n  third: 2.0.0\n`)
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'old resolutions\n')
  writeFileSync(join(root, 'cordis.patch.yml'), '[]\n')
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('removes core packages and reinstall declarations while preserving optional plugins and configuration', () => {
  const root = fixture()
  cleanProfileCorePackages(root, [core], true)
  expect(existsSync(join(root, 'node_modules', core))).toBe(false)
  expect(existsSync(join(root, 'node_modules', extra))).toBe(true)
  expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))).toEqual({
    dependencies: { [extra]: '1.0.0' }, optionalDependencies: {},
    pnpm: { overrides: { third: '2.0.0' } }, dsh: { profile: { bundles: [core, extra] } },
  })
  expect(load(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))).toEqual({ nodeLinker: 'hoisted', overrides: { third: '2.0.0' } })
  expect(readFileSync(join(root, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
  expect(existsSync(join(root, 'pnpm-lock.yaml'))).toBe(false)
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'new plugin resolutions\n')
  cleanProfileCorePackages(root, [core], true)
  expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe('new plugin resolutions\n')
})

it('does not clean development profiles', () => {
  const root = fixture()
  const before = readFileSync(join(root, 'package.json'), 'utf8')
  cleanProfileCorePackages(root, [core], false)
  expect(existsSync(join(root, 'node_modules', core))).toBe(true)
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before)
  expect(existsSync(join(root, 'pnpm-lock.yaml'))).toBe(true)
})

it('unlinks development fallbacks without deleting their target, including dangling links', () => {
  const root = fixture()
  const target = join(root, 'development-package')
  mkdirSync(target)
  writeFileSync(join(target, 'sentinel'), 'keep')
  const owned = join(root, '.dsh-module-fallback', 'node_modules', core)
  mkdirSync(join(owned, '..'), { recursive: true })
  symlinkSync(target, owned, 'junction')
  rmSync(join(root, 'node_modules', core), { recursive: true })
  symlinkSync(owned, join(root, 'node_modules', core), 'junction')
  cleanProfileCorePackages(root, [core], true)
  expect(readFileSync(join(target, 'sentinel'), 'utf8')).toBe('keep')
  expect(existsSync(owned)).toBe(false)
  symlinkSync(target, join(root, 'node_modules', core), 'junction')
  rmSync(target, { recursive: true })
  cleanProfileCorePackages(root, [core], true)
  expect(() => lstatSync(join(root, 'node_modules', core))).toThrow()
})

it('uses the old package inventory to remove retired core names', () => {
  const root = fixture()
  const names = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host', core].sort()
  writeFileSync(join(root, 'desktop-packages.json'), JSON.stringify({ schemaVersion: 1, packages: names.map((name, index) => ({
    name, version: '0.1.2', file: `${index}.tgz`, bytes: 1, integrity: 'sha512-YQ==',
  })) }))
  cleanProfileCorePackages(root, [], true)
  expect(existsSync(join(root, 'node_modules', core))).toBe(false)
  expect(existsSync(join(root, 'node_modules', extra))).toBe(true)
})

it('rejects invalid metadata before deleting packages or declarations', () => {
  const root = fixture()
  writeFileSync(join(root, 'desktop-packages.json'), '{"schemaVersion":1,"packages":[{"name":"../../outside"}]}')
  const before = readFileSync(join(root, 'package.json'), 'utf8')
  expect(() => { cleanProfileCorePackages(root, [core], true) }).toThrow('invalid package record')
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before)
  expect(existsSync(join(root, 'node_modules', core))).toBe(true)
})

it('refuses redirected package parents without deleting their contents', () => {
  const root = fixture()
  const target = join(root, 'external-scope')
  mkdirSync(join(target, 'dsh-web-app'), { recursive: true })
  rmSync(join(root, 'node_modules', '@deepseek-ai'), { recursive: true })
  symlinkSync(target, join(root, 'node_modules', '@deepseek-ai'), 'junction')
  expect(() => { cleanProfileCorePackages(root, [core], true) }).toThrow('not a real directory')
  expect(existsSync(join(target, 'dsh-web-app'))).toBe(true)
})
