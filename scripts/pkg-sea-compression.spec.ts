/** Execute both shipped SEA providers against compressed empty-file assets. */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { brotliCompressSync } from 'node:zlib'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const pkgRoot = dirname(require.resolve('@yao-pkg/pkg/package.json'))
const bundle = readFileSync(join(pkgRoot, 'prelude/sea-bootstrap.bundle.js'), 'utf8')

function initializer(source: string, name: string): string {
  const parsed = ts.createSourceFile('prelude.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  let expression: string | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      expression = node.initializer?.getText(parsed)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  if (expression === undefined) throw new Error(`pkg prelude is missing ${name}`)
  return expression
}

function commonJs(callbacks: Record<string, (exports: object, module: { exports: unknown }) => void>) {
  return () => {
    const exports = {}
    const module: { exports: unknown } = { exports }
    Object.values(callbacks)[0]!(exports, module)
    return module.exports
  }
}

const workerSource: unknown = runInNewContext(`(${initializer(bundle, 'require_worker_bootstrap_string')})()`, { __commonJS: commonJs })
if (typeof workerSource !== 'string') throw new Error('pkg worker bootstrap must be JavaScript text')

interface Provider {
  readFileSync(path: string): Buffer
}

function provider(source: string, contents: Buffer, declaredSize = contents.length): Provider {
  const archive = brotliCompressSync(contents)
  const manifest = {
    compression: 2,
    entrypoint: '/fixture', directories: {}, symlinks: {},
    offsets: { '/fixture': [0, archive.length] },
    stats: { '/fixture': { size: declaredSize, isFile: true, isDirectory: false } },
  }
  class MemoryProvider {
    mkdirSync(): void {}
  }
  class VirtualFileSystem {
    mount(): void {}
  }
  const loaded = runInNewContext(`(${initializer(source, 'require_sea_vfs_setup')})()`, {
    __commonJS: commonJs,
    require_bootstrap_shared: (): unknown => require(join(pkgRoot, 'prelude/bootstrap-shared.js')),
    require: (name: string): object => {
      if (name === 'node:sea') return {
        getAsset: () => JSON.stringify(manifest),
        getRawAsset: () => Uint8Array.from(archive).buffer,
      }
      if (name === 'node:vfs') return { MemoryProvider, VirtualFileSystem }
      throw new Error(`unexpected pkg fixture dependency: ${name}`)
    },
    Buffer,
    process: { env: {}, platform: 'linux' },
  }) as { provider: Provider }
  return loaded.provider
}

describe.each([['main', bundle], ['worker', workerSource]] as const)('pkg compressed assets in %s', (_name, source) => {
  it('reads and caches an empty file', () => {
    const subject = provider(source, Buffer.alloc(0))
    expect(subject.readFileSync('/fixture')).toEqual(Buffer.alloc(0))
    expect(subject.readFileSync('/fixture')).toEqual(Buffer.alloc(0))
  })

  it('preserves nonempty bytes and isolates cached data from callers', () => {
    const subject = provider(source, Buffer.from('content'))
    const first = subject.readFileSync('/fixture')
    first.fill(0)
    expect(subject.readFileSync('/fixture')).toEqual(Buffer.from('content'))
  })

  it('rejects nonempty output declared as an empty file', () => {
    expect(() => provider(source, Buffer.from('x'), 0).readFileSync('/fixture'))
      .toThrow('decompressed size does not match stats.size')
  })
})
