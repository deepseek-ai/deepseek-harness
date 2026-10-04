/** Package configuration read by Node's resolver follows an invalidated manifest on disk. */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import NodeModule, { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, toNamespacedPath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ModuleLoader } from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, describe, expect, it } from 'vitest'
import { PackageManifests } from '../src/package-manifest.ts'

const require = createRequire(import.meta.url)
const addon = require('node-addon-require-builtin') as { requireBuiltin(id: string): unknown }
const reader = addon.requireBuiltin('internal/modules/package_json_reader') as {
  read: (path: string, options?: { isESM: boolean; base: string; specifier: string }) => { exists: boolean; type: string }
  getPackageScopeConfig: (url: string) => { exists: boolean; type: string; pjsonPath: string }
  getNearestParentPackageJSON: (path: string) => { data: { type: string }; path: string } | undefined
}
const formats = addon.requireBuiltin('internal/modules/esm/get_format') as {
  defaultGetFormatWithoutErrors(url: URL, context?: object): string | null
}
const binding = (addon.requireBuiltin('internal/bootstrap/realm') as {
  internalBinding(id: 'modules'): Record<string, unknown>
}).internalBinding('modules')

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

function file(path: string, source: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, source)
}

function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-hmr-manifest-')))
  cleanup.push(() => { rmSync(root, { recursive: true, force: true }) })
  const dir = join(root, 'packages', 'pkg')
  const manifest = join(dir, 'package.json')
  const importer = join(root, 'importer', 'entry.mjs')
  file(join(root, 'importer', 'package.json'), '{"type":"module","dependencies":{"pkg":"*"}}')
  file(importer, 'export {}')
  // A workspace-style link: the importer resolves `pkg` from its own node_modules to the source directory.
  mkdirSync(join(root, 'importer', 'node_modules'), { recursive: true })
  const link = join(root, 'importer', 'node_modules', 'pkg')
  symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir')
  for (const name of ['a', 'b']) {
    file(join(dir, `${name}.mjs`), `export const marker = '${name}'`)
    file(join(dir, `${name}.cjs`), `module.exports = { marker: '${name}' }`)
  }
  const manifests = new PackageManifests()
  cleanup.push(() => { manifests.dispose() })
  const invalidate = (path: string) => Promise.resolve().then(manifests.invalidate.bind(manifests, path))
  return { root, dir, manifest, importer, importerURL: pathToFileURL(importer).href, manifests, invalidate }
}

function resolveEsm(specifier: string, parentURL: string): string {
  const loader = ModuleLoader.fromInternal()!
  return (loader.version === 'v2'
    ? loader.resolveSync(parentURL, { specifier, attributes: {} })
    : loader.resolveSync(specifier, parentURL, {})).url
}

describe('package manifest invalidation', { concurrent: false }, () => {
  it('preserves filename-based resolve hooks and node-prefixed builtins after invalidation', async () => {
    const f = fixture()
    file(f.manifest, '{}')
    const importerRequire = createRequire(f.importer)
    const nativeFs = importerRequire('node:fs') as typeof import('node:fs')
    const missingBuiltin = 'node:dsh-hmr-missing'
    const missingFailure = outcome(() => importerRequire(missingBuiltin))
    expect(missingFailure).toHaveProperty('code', 'ERR_UNKNOWN_BUILTIN_MODULE')
    const target = join(f.dir, 'a.cjs')
    const specifier = join(f.dir, 'alias.cjs')
    file(specifier, 'module.exports = { marker: "alias" }')
    cleanup.push(() => { Reflect.deleteProperty(importerRequire.cache, target) })
    let hooks: ReturnType<typeof registerHooks> | undefined = registerHooks({
      resolve(request, context, nextResolve) {
        const resolved = nextResolve(request, context)
        return resolved.url === pathToFileURL(specifier).href ? { ...resolved, url: pathToFileURL(target).href } : resolved
      },
    })
    cleanup.push(() => { hooks?.deregister() })
    try {
      const original = importerRequire(specifier) as { marker: string }
      expect(original).toEqual({ marker: 'a' })
      await f.invalidate(f.manifest)
      expect(importerRequire(specifier)).toBe(original)
    } finally {
      hooks.deregister()
      hooks = undefined
    }

    const descriptor = Object.getOwnPropertyDescriptor(importerRequire.cache, 'fs')
    const restore = () => {
      if (descriptor) Object.defineProperty(importerRequire.cache, 'fs', descriptor)
      else Reflect.deleteProperty(importerRequire.cache, 'fs')
    }
    cleanup.push(restore)
    const fake = new NodeModule('fs')
    const fakeExports = { marker: 'fake fs' }
    fake.exports = fakeExports
    try {
      importerRequire.cache.fs = fake
      expect(importerRequire('fs')).toBe(fakeExports)
      expect(importerRequire('node:fs')).toBe(nativeFs)
      expect(outcome(() => importerRequire(missingBuiltin))).toEqual(missingFailure)
    } finally {
      restore()
    }
  })

  it('loads changed CommonJS exports without evicting previously loaded modules', async () => {
    const f = fixture()
    const a = join(f.dir, 'a.cjs')
    const b = join(f.dir, 'b.cjs')
    const unrelated = join(f.root, 'unrelated.cjs')
    file(unrelated, 'module.exports = { marker: "unrelated" }')
    file(f.manifest, JSON.stringify({ name: 'pkg', exports: './a.cjs' }))
    const importerRequire = createRequire(f.importer)
    cleanup.push(() => {
      for (const path of [a, b, unrelated]) Reflect.deleteProperty(importerRequire.cache, path)
    })
    const original = importerRequire('pkg') as { marker: string }
    const other = importerRequire(unrelated) as { marker: string }
    const originalModule = importerRequire.cache[a]
    const otherModule = importerRequire.cache[unrelated]
    expect(original).toEqual({ marker: 'a' })
    expect(originalModule).toBeDefined()
    expect(otherModule).toBeDefined()

    file(f.manifest, JSON.stringify({ name: 'pkg', exports: './b.cjs' }))
    await f.invalidate(f.manifest)
    expect(importerRequire.resolve('pkg')).toBe(b)
    const current = importerRequire('pkg') as { marker: string }
    expect(importerRequire.cache[a]).toBe(originalModule)
    expect(importerRequire.cache[unrelated]).toBe(otherModule)
    expect(original).toEqual({ marker: 'a' })
    expect(importerRequire(a)).toBe(original)
    expect(importerRequire(unrelated)).toBe(other)
    expect(current).toEqual({ marker: 'b' })
  })

  it.each(['symlink', 'main'] as const)('refreshes a cached external %s entry after its manifest changes', async (entry) => {
    const f = fixture()
    const external = join(f.root, 'packages', 'outside', 'entry.mjs')
    file(external, 'export {}')
    if (entry === 'symlink') {
      symlinkSync(dirname(external), join(f.dir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
      file(f.manifest, JSON.stringify({ name: 'pkg', exports: './linked/entry.mjs' }))
    } else {
      file(f.manifest, JSON.stringify({ name: 'pkg', main: external }))
    }
    const importerRequire = createRequire(f.importer)
    expect(importerRequire.resolve('pkg')).toBe(external)
    expect(resolveEsm('pkg', f.importerURL)).toBe(pathToFileURL(external).href)

    file(f.manifest, JSON.stringify({ name: 'pkg', main: './b.mjs', exports: './b.mjs' }))
    await f.invalidate(f.manifest)
    expect.soft(importerRequire.resolve('pkg')).toBe(join(f.dir, 'b.mjs'))
    expect(resolveEsm('pkg', f.importerURL)).toBe(pathToFileURL(join(f.dir, 'b.mjs')).href)
  })

  it('resolves changed exports and main only after the manifest is invalidated', () => {
    const f = fixture()
    file(f.manifest, JSON.stringify({ name: 'pkg', exports: { import: './a.mjs', require: './a.cjs' } }))
    const importerRequire = createRequire(f.importer)
    expect(resolveEsm('pkg', f.importerURL)).toBe(pathToFileURL(join(f.dir, 'a.mjs')).href)
    expect(importerRequire.resolve('pkg')).toBe(join(f.dir, 'a.cjs'))

    file(f.manifest, JSON.stringify({ name: 'pkg', exports: { import: './b.mjs', require: './b.cjs' } }))
    expect(resolveEsm('pkg', f.importerURL)).toBe(pathToFileURL(join(f.dir, 'a.mjs')).href)
    f.manifests.invalidate(f.manifest)
    expect(resolveEsm('pkg', f.importerURL)).toBe(pathToFileURL(join(f.dir, 'b.mjs')).href)
    expect(importerRequire.resolve('pkg')).toBe(join(f.dir, 'b.cjs'))

    file(f.manifest, JSON.stringify({ name: 'pkg', main: './a.cjs' }))
    f.manifests.invalidate(f.manifest)
    expect(importerRequire.resolve('pkg')).toBe(join(f.dir, 'a.cjs'))
  })

  it('updates package type, scope, and nearest-package reads inside the directory', () => {
    const f = fixture()
    file(f.manifest, JSON.stringify({ name: 'pkg', type: 'commonjs' }))
    const source = join(f.dir, 'lib', 'entry.js')
    file(source, 'export {}')
    expect(formats.defaultGetFormatWithoutErrors(pathToFileURL(source))).toBe('commonjs')
    expect(reader.getNearestParentPackageJSON(source)?.data.type).toBe('commonjs')

    file(f.manifest, JSON.stringify({ name: 'pkg', type: 'module' }))
    f.manifests.invalidate(f.manifest)
    expect(formats.defaultGetFormatWithoutErrors(pathToFileURL(source))).toBe('module')
    expect(reader.getNearestParentPackageJSON(source)?.data.type).toBe('module')
    expect(reader.getPackageScopeConfig(pathToFileURL(source).href)).toMatchObject({
      exists: true, type: 'module', pjsonPath: toNamespacedPath(f.manifest),
    })
  })

  it('resolves changed package imports from inside the directory', () => {
    const f = fixture()
    file(f.manifest, JSON.stringify({ name: 'pkg', type: 'module', imports: { '#target': './a.mjs' } }))
    const parent = pathToFileURL(join(f.dir, 'inside.mjs')).href
    file(join(f.dir, 'inside.mjs'), 'export {}')
    expect(resolveEsm('#target', parent)).toBe(pathToFileURL(join(f.dir, 'a.mjs')).href)
    file(f.manifest, JSON.stringify({ name: 'pkg', type: 'module', imports: { '#target': './b.mjs' } }))
    f.manifests.invalidate(f.manifest)
    expect(resolveEsm('#target', parent)).toBe(pathToFileURL(join(f.dir, 'b.mjs')).href)
  })

  it('reports an invalid manifest with the native error and recovers after it is fixed', () => {
    const f = fixture()
    file(f.manifest, JSON.stringify({ name: 'pkg', exports: './a.mjs' }))
    expect(resolveEsm('pkg', f.importerURL)).toBe(pathToFileURL(join(f.dir, 'a.mjs')).href)
    file(f.manifest, '{')
    f.manifests.invalidate(f.manifest)
    expect(() => reader.read(f.manifest)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_PACKAGE_CONFIG' }))
    file(f.manifest, JSON.stringify({ name: 'pkg', exports: './b.mjs' }))
    f.manifests.invalidate(f.manifest)
    expect(resolveEsm('pkg', f.importerURL)).toBe(pathToFileURL(join(f.dir, 'b.mjs')).href)
  })

  it('leaves other package directories to Node and restores native readers on disposal', () => {
    const f = fixture()
    const other = join(f.root, 'packages', 'other', 'package.json')
    file(other, JSON.stringify({ name: 'other', type: 'commonjs' }))
    file(f.manifest, JSON.stringify({ name: 'pkg', type: 'commonjs' }))
    expect(reader.read(other).type).toBe('commonjs')
    const original = binding.readPackageJSON
    f.manifests.invalidate(f.manifest)
    file(other, JSON.stringify({ name: 'other', type: 'module' }))
    expect(reader.read(other).type).toBe('commonjs')
    expect(binding.readPackageJSON).not.toBe(original)
    f.manifests.dispose()
    expect(binding.readPackageJSON).toBe(original)
  })

  it('reports invalid JSON with its non-file ESM base after invalidation', async () => {
    const f = fixture()
    file(f.manifest, '{')
    await f.invalidate(f.manifest)
    const base = 'data:text/javascript,export{}'
    const failure = outcome(() => reader.read(f.manifest, { isESM: true, base, specifier: 'pkg' }))
    expect(failure).toHaveProperty('code', 'ERR_INVALID_PACKAGE_CONFIG')
    expect(failure).toHaveProperty('message', expect.stringContaining(base))
  })
})

function outcome(run: () => unknown): unknown {
  try { return run() } catch (error) {
    const failure = error as Error & { code?: string }
    return { code: failure.code, message: failure.message }
  }
}

describe('package manifest reader parity', { concurrent: false }, () => {
  it('terminates scope lookup after invalidating the filesystem root without modifying it', async () => {
    const f = fixture()
    const child = spawn(process.execPath, [
      '--expose-internals',
      fileURLToPath(new URL('./fixtures/package-root-scope.mjs', import.meta.url)),
      f.root,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    const completed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => { resolve({ code, signal }) })
    })
    cleanup.push(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill()
      await completed
    })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    const result = await completed
    expect(result.signal, stderr).toBeNull()
    expect(result.code, stderr).toBe(0)
    expect(stdout).toBe('scope traversal completed\n')
  })

  it('reads valid JSON with a non-file ESM base like Node', async () => {
    const f = fixture()
    file(f.manifest, '{}')
    const options = { isESM: true, base: 'data:text/javascript,export{}', specifier: 'pkg' }
    const expected = outcome(() => reader.read(f.manifest, options))
    await f.invalidate(f.manifest)
    expect(outcome(() => reader.read(f.manifest, options))).toEqual(expected)
  })

  it('refreshes a cached real directory after a package link moves', async () => {
    const f = fixture()
    const other = join(f.root, 'packages', 'other')
    const link = join(f.root, 'importer', 'node_modules', 'pkg')
    const linkedManifest = join(link, 'package.json')
    file(f.manifest, '{"type":"commonjs"}')
    file(join(other, 'package.json'), '{"type":"commonjs"}')
    unlinkSync(link)
    symlinkSync(other, link, process.platform === 'win32' ? 'junction' : 'dir')
    await f.invalidate(f.manifest)
    expect(reader.read(linkedManifest).type).toBe('commonjs')

    unlinkSync(link)
    symlinkSync(f.dir, link, process.platform === 'win32' ? 'junction' : 'dir')
    file(f.manifest, '{"type":"module"}')
    await f.invalidate(f.manifest)
    expect(reader.read(linkedManifest).type).toBe('module')
  })

  it.each([
    '{}',
    '{"name":"pkg","main":"./a.cjs","type":"commonjs"}',
    '{"name":"pkg","exports":{"import":"./a.mjs","require":"./a.cjs"}}',
    '{"name":"pkg","exports":false,"main":"./a.cjs"}',
    '{"name":"pkg","imports":{"#item":"./a.mjs"},"type":"module"}',
    '﻿{"name":"pkg","exports":"./a.mjs"}',
    '{', 'null', '[]', '1', '{"name":1}', '{"type":1}', '{"type":"other"}',
    '{"name":"\\ud800"}', '{"main":"\\ud800"}', '{"type":"\\ud800"}', '{"exports":"\\ud800"}',
  ])('reads %s like the native reader', (source) => {
    const f = fixture()
    file(f.manifest, source)
    const expected = outcome(() => reader.read(f.manifest))
    f.manifests.invalidate(f.manifest)
    expect(outcome(() => reader.read(f.manifest))).toEqual(expected)
  })

  it('reports an invalid manifest found while importing like the native resolver', () => {
    const f = fixture()
    const errorOf = (run: () => unknown): Error => {
      try { run() } catch (error) { return error as Error }
      throw new Error('expected the lookup to fail')
    }
    file(f.manifest, '{')
    const expected = errorOf(() => resolveEsm('pkg', f.importerURL))
    f.manifests.invalidate(f.manifest)
    const actual = errorOf(() => resolveEsm('pkg', f.importerURL))
    expect([String(actual), Object.keys(actual)]).toEqual([String(expected), Object.keys(expected)])
    expect(String(errorOf(() => reader.read(f.manifest)))).toBe(String(expected).replace(/ while importing .*(?=\.$)/u, '').replace(join(f.root, 'importer', 'node_modules', 'pkg'), f.dir))
  })

  it('reads invalid UTF-8 like the native reader', () => {
    const f = fixture()
    mkdirSync(f.dir, { recursive: true })
    writeFileSync(f.manifest, Buffer.concat([Buffer.from('{"name":"'), Buffer.from([0xff]), Buffer.from('"}')]))
    const expected = outcome(() => reader.read(f.manifest))
    f.manifests.invalidate(f.manifest)
    expect(outcome(() => reader.read(f.manifest))).toEqual(expected)
  })

  it('refreshes a changed CommonJS main after a cached lookup', () => {
    const f = fixture()
    file(f.manifest, JSON.stringify({ name: 'pkg', main: './a.cjs' }))
    const importerRequire = createRequire(f.importer)
    expect(importerRequire.resolve('pkg')).toBe(join(f.dir, 'a.cjs'))
    file(f.manifest, JSON.stringify({ name: 'pkg', main: './b.cjs' }))
    expect(importerRequire.resolve('pkg')).toBe(join(f.dir, 'a.cjs'))
    f.manifests.invalidate(f.manifest)
    expect(importerRequire.resolve('pkg')).toBe(join(f.dir, 'b.cjs'))
  })

  it('updates the package type of extensionless files', () => {
    const f = fixture()
    file(f.manifest, JSON.stringify({ name: 'pkg', type: 'commonjs' }))
    const extensionless = pathToFileURL(join(f.dir, 'bin', 'tool'))
    file(join(f.dir, 'bin', 'tool'), '')
    const before = formats.defaultGetFormatWithoutErrors(extensionless)
    file(f.manifest, JSON.stringify({ name: 'pkg', type: 'module' }))
    f.manifests.invalidate(f.manifest)
    expect(formats.defaultGetFormatWithoutErrors(extensionless)).not.toBe(before)
    expect(formats.defaultGetFormatWithoutErrors(extensionless)).toBe('module')
  })

  it('continues to the enclosing scope after the manifest is deleted', () => {
    const f = fixture()
    const enclosing = join(f.root, 'packages', 'package.json')
    file(enclosing, JSON.stringify({ name: 'packages', type: 'commonjs' }))
    file(f.manifest, JSON.stringify({ name: 'pkg', type: 'module' }))
    const source = join(f.dir, 'lib', 'entry.js')
    file(source, '')
    expect(reader.getPackageScopeConfig(pathToFileURL(source).href).type).toBe('module')
    rmSync(f.manifest)
    f.manifests.invalidate(f.manifest)
    expect(reader.getPackageScopeConfig(pathToFileURL(source).href)).toMatchObject({
      exists: true, type: 'commonjs', pjsonPath: toNamespacedPath(enclosing),
    })
    expect(formats.defaultGetFormatWithoutErrors(pathToFileURL(join(f.dir, 'bin', 'tool')))).toBe(
      formats.defaultGetFormatWithoutErrors(pathToFileURL(join(f.root, 'packages', 'tool'))),
    )
    expect(reader.getNearestParentPackageJSON(source)?.path).toBe(toNamespacedPath(enclosing))
  })

  it('stops a scope lookup at a node_modules boundary like Node', () => {
    const f = fixture()
    file(f.manifest, JSON.stringify({ name: 'pkg', type: 'module' }))
    const nested = join(f.dir, 'node_modules', 'dep', 'entry.js')
    file(nested, '')
    const expected = [
      outcome(() => reader.getPackageScopeConfig(pathToFileURL(nested).href)),
      outcome(() => reader.getNearestParentPackageJSON(nested)),
    ]
    f.manifests.invalidate(f.manifest)
    expect([
      outcome(() => reader.getPackageScopeConfig(pathToFileURL(nested).href)),
      outcome(() => reader.getNearestParentPackageJSON(nested)),
    ]).toEqual(expected)
  })

  it('answers missing directories and non-file URLs natively', () => {
    const f = fixture()
    file(f.manifest, '{}')
    const missing = join(f.root, 'missing', 'package.json')
    const nativeScope = binding.getPackageScopeConfig as (url: string) => unknown
    const expected = [outcome(() => reader.read(missing)), outcome(() => nativeScope('node:fs'))]
    f.manifests.invalidate(f.manifest)
    expect([outcome(() => reader.read(missing)), outcome(() => (binding.getPackageScopeConfig as (url: string) => unknown)('node:fs'))])
      .toEqual(expected)
  })

  it('falls back to the builtin addon for internals that --expose-internals does not expose', () => {
    const f = fixture()
    file(f.manifest, JSON.stringify({ name: 'pkg', main: './a.cjs' }))
    const importerRequire = createRequire(f.importer)
    expect(importerRequire.resolve('pkg')).toBe(join(f.dir, 'a.cjs'))
    const argv = [...process.execArgv]
    process.execArgv.push('--expose-internals')
    try {
      file(f.manifest, JSON.stringify({ name: 'pkg', main: './b.cjs' }))
      f.manifests.invalidate(f.manifest)
    } finally {
      process.execArgv.splice(0, process.execArgv.length, ...argv)
    }
    expect(importerRequire.resolve('pkg')).toBe(join(f.dir, 'b.cjs'))
  })

  it('keeps readers replaced after installation when disposed', async () => {
    const f = fixture()
    file(f.manifest, '{}')
    const previousRead = binding.readPackageJSON
    const previousScope = binding.getPackageScopeConfig
    const previousType = binding.getPackageType
    const previousNearest = reader.getNearestParentPackageJSON
    try {
      await f.invalidate(f.manifest)
      const later = () => undefined
      binding.readPackageJSON = later
      reader.getNearestParentPackageJSON = later
      f.manifests.dispose()
      expect(binding.readPackageJSON).toBe(later)
      expect(reader.getNearestParentPackageJSON).toBe(later)
      expect(binding.getPackageScopeConfig).toBe(previousScope)
      expect(binding.getPackageType).toBe(previousType)
    } finally {
      f.manifests.dispose()
      binding.readPackageJSON = previousRead
      binding.getPackageScopeConfig = previousScope
      binding.getPackageType = previousType
      reader.getNearestParentPackageJSON = previousNearest
    }
  })
})
