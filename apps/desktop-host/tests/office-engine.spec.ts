import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire, type ModuleHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { installOfficeEngineResolution } from '../src/office-engine.ts'
import { PackageManifests } from '../../../packages/boot/hmr/src/package-manifest.ts'

const roots: string[] = []
const hooks: ModuleHooks[] = []
const disposers: Array<() => void> = []
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  for (const hook of hooks.splice(0)) hook.deregister()
  const cache = createRequire(import.meta.url).cache
  for (const path of Object.keys(cache)) {
    if (roots.some(root => path.startsWith(root + sep))) Reflect.deleteProperty(cache, path)
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(runtimeName = 'dsh') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-office-resolution-')))
  roots.push(root)
  const runtime = join(root, 'app.asar', runtimeName)
  const manifest = 'node_modules/@deepseek-ai/libreoffice-kit-darwin-arm64/package.json'
  for (const base of [runtime, join(root, 'app.asar.unpacked', runtimeName)]) {
    const path = join(base, manifest)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ name: '@deepseek-ai/libreoffice-kit-darwin-arm64', path: realpathSync(dirname(path)) }))
  }
  const api = join(runtime, 'node_modules/@deepseek-ai/libreoffice-kit/package.json')
  mkdirSync(dirname(api), { recursive: true })
  writeFileSync(api, '{"name":"@deepseek-ai/libreoffice-kit"}')
  const require: (specifier: string) => unknown = createRequire(join(runtime, 'package.json'))
  const hook = installOfficeEngineResolution(runtime)!
  hooks.push(hook)
  return { root, runtime, manifest, require }
}

it('resolves engine manifests to physical directories and leaves unrelated modules alone', () => {
  const f = fixture()
  // Node 24.13 require.resolve bypasses hooks; Electron's require.resolve is covered by packaged Office smoke.
  expect(f.require('@deepseek-ai/libreoffice-kit-darwin-arm64/package.json'))
    .toMatchObject({ path: realpathSync(dirname(join(f.root, 'app.asar.unpacked', 'dsh', f.manifest))) })
  expect((f.require('node:fs') as typeof import('node:fs')).realpathSync).toBe(realpathSync)
  expect(f.require('@deepseek-ai/libreoffice-kit/package.json')).toEqual({ name: '@deepseek-ai/libreoffice-kit' })
})

it('resolves an absolute engine manifest to its unpacked copy', () => {
  const f = fixture()
  expect(f.require(join(f.runtime, f.manifest)))
    .toMatchObject({ path: realpathSync(dirname(join(f.root, 'app.asar.unpacked', 'dsh', f.manifest))) })
})

it.each(['exports', 'main'] as const)('refreshes a cached plugin %s while Office resolution stays active', (field) => {
  const f = fixture()
  const packageRoot = join(f.root, 'plugin')
  mkdirSync(packageRoot)
  const manifest = join(packageRoot, 'package.json')
  const a = join(packageRoot, 'a.cjs')
  const b = join(packageRoot, 'b.cjs')
  writeFileSync(manifest, JSON.stringify({ name: 'plugin', [field]: './a.cjs' }))
  writeFileSync(a, 'module.exports = { marker: "a" }')
  writeFileSync(b, 'module.exports = { marker: "b" }')
  symlinkSync(packageRoot, join(f.runtime, 'node_modules', 'plugin'), process.platform === 'win32' ? 'junction' : 'dir')
  const require = createRequire(join(f.runtime, 'package.json'))
  const original: unknown = require('plugin')
  const next: unknown = require(b)
  const originalModule = require.cache[a]
  const nextModule = require.cache[b]
  const engine = f.require('@deepseek-ai/libreoffice-kit-darwin-arm64/package.json')
  expect(original).toEqual({ marker: 'a' })
  expect(next).toEqual({ marker: 'b' })
  expect(require('plugin')).toBe(original)
  const manifests = new PackageManifests()
  disposers.push(() => { manifests.dispose() })
  writeFileSync(manifest, JSON.stringify({ name: 'plugin', [field]: './b.cjs' }))
  manifests.invalidate(manifest)
  expect(require('plugin')).toBe(next)
  expect(require.resolve('plugin')).toBe(b)
  expect(require.cache[a]).toBe(originalModule)
  expect(require.cache[b]).toBe(nextModule)
  expect(require(a)).toBe(original)
  expect(f.require('@deepseek-ai/libreoffice-kit-darwin-arm64/package.json')).toBe(engine)
  expect(f.require(join(f.runtime, f.manifest))).toBe(engine)
})

it('rejects an engine missing from the unpacked tree instead of using its archived copy', () => {
  const f = fixture()
  rmSync(join(f.root, 'app.asar.unpacked'), { recursive: true })
  expect(() => { f.require('@deepseek-ai/libreoffice-kit-darwin-arm64/package.json') }).toThrow()
})

it('leaves a prepared runtime without an archive unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-office-prepared-'))
  roots.push(root)
  expect(installOfficeEngineResolution(join(root, 'dsh'))).toBeUndefined()
})

it('preserves a renamed runtime directory when locating the unpacked engine', () => {
  const f = fixture('alternate-runtime')
  expect(f.require('@deepseek-ai/libreoffice-kit-darwin-arm64/package.json'))
    .toMatchObject({ path: realpathSync(dirname(join(f.root, 'app.asar.unpacked', 'alternate-runtime', f.manifest))) })
})

it('resolves an engine through a directory alias', () => {
  const f = fixture()
  const alias = join(f.root, 'alias')
  symlinkSync(join(f.root, 'app.asar'), alias, 'junction')
  const require: (specifier: string) => unknown = createRequire(join(alias, 'dsh', 'package.json'))
  expect(require('@deepseek-ai/libreoffice-kit-darwin-arm64/package.json'))
    .toMatchObject({ path: realpathSync(dirname(join(f.root, 'app.asar.unpacked', 'dsh', f.manifest))) })
})

it('rejects an engine resolved elsewhere inside the archive', () => {
  const f = fixture()
  const other = join(f.root, 'app.asar', 'other', f.manifest)
  mkdirSync(dirname(other), { recursive: true })
  writeFileSync(other, '{}')
  const require = createRequire(join(f.root, 'app.asar', 'other', 'package.json'))
  expect(() => { require('@deepseek-ai/libreoffice-kit-darwin-arm64/package.json') })
    .toThrow('outside the runtime package directory')
})

it('leaves external engines and the archived WASM engine at their own locations', () => {
  const f = fixture()
  const external = join(f.root, 'external', f.manifest)
  const wasm = join(f.runtime, 'node_modules/@deepseek-ai/libreoffice-kit-wasm/package.json')
  for (const path of [external, wasm]) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ path: realpathSync(dirname(path)) }))
  }
  const require: (specifier: string) => unknown = createRequire(join(f.root, 'external', 'package.json'))
  expect(require('@deepseek-ai/libreoffice-kit-darwin-arm64/package.json'))
    .toMatchObject({ path: realpathSync(dirname(external)) })
  expect(f.require('@deepseek-ai/libreoffice-kit-wasm/package.json'))
    .toMatchObject({ path: realpathSync(dirname(wasm)) })
})
