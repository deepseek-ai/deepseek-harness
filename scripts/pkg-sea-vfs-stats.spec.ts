/** Execute the shipped SEA VFS stat conversion that serves `{ bigint: true }` callers such as dsh-fs-local. */

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const pkgRoot = dirname(require.resolve('@yao-pkg/pkg/package.json'))
const bundle = readFileSync(join(pkgRoot, 'prelude/sea-bootstrap.bundle.js'), 'utf8')

function declaration(source: string, kind: 'variable' | 'function', name: string): string {
  const parsed = ts.createSourceFile('prelude.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  let text: string | undefined
  const visit = (node: ts.Node): void => {
    if (kind === 'variable' && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) {
      text = node.initializer?.getText(parsed)
    }
    if (kind === 'function' && ts.isFunctionDeclaration(node) && node.name?.text === name) text = node.getText(parsed)
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  if (text === undefined) throw new Error(`pkg prelude is missing ${name}`)
  return text
}

function commonJs(callbacks: Record<string, (exports: object, module: { exports: unknown }) => void>) {
  return () => {
    const exports = {}
    const module: { exports: unknown } = { exports }
    Object.values(callbacks)[0]!(exports, module)
    return module.exports
  }
}

const workerSource: unknown = runInNewContext(`(${declaration(bundle, 'variable', 'require_worker_bootstrap_string')})()`, { __commonJS: commonJs })
if (typeof workerSource !== 'string') throw new Error('pkg worker bootstrap must be JavaScript text')

/** The numeric fields every pkg VirtualStats carries. */
interface NumberStats {
  dev: number
  mode: number
  nlink: number
  uid: number
  gid: number
  rdev: number
  blksize: number
  ino: number
  size: number
  blocks: number
  atimeMs: number
  mtimeMs: number
  ctimeMs: number
  birthtimeMs: number
  isFile(): boolean
  isDirectory(): boolean
}

type Convert = (stats: NumberStats, options?: unknown) => Record<string, unknown> & { isFile(): boolean; isDirectory(): boolean }

function numberStats(): NumberStats {
  return {
    dev: 7, mode: 0o100644, nlink: 1, uid: 501, gid: 20, rdev: 0, blksize: 4096, ino: 9, size: 42, blocks: 1,
    atimeMs: 1_700_000_000_000, mtimeMs: 1_700_000_000_123.5, ctimeMs: 1_700_000_000_456, birthtimeMs: 1_700_000_000_000,
    isFile: () => true, isDirectory: () => false,
  }
}

// The main bundle also embeds the worker bootstrap text, so it carries both copies of the six hooks.
describe.each([['main', bundle, 12], ['worker', workerSource, 6]] as const)('pkg VFS stats in %s', (_name, source, hooks) => {
  const convert = runInNewContext(`(${declaration(source, 'function', 'vfsStatsForOptions')})`, { BigInt, Math }) as Convert

  it('serves BigIntStats fields to bigint callers', () => {
    const stats = convert(numberStats(), { bigint: true })
    expect(stats).toMatchObject({
      dev: 7n, mode: 0o100644n, ino: 9n, size: 42n, mtimeMs: 1_700_000_000_123n, mtimeNs: 1_700_000_000_123_500_000n,
    })
    expect((stats.mode as bigint) & 0o777n).toBe(0o644n)
    expect(stats.isFile()).toBe(true)
    expect(stats.isDirectory()).toBe(false)
  })

  it.each([undefined, {}, 'utf8'])('returns the VFS stats unchanged for options %j', (options) => {
    const stats = numberStats()
    expect(convert(stats, options)).toBe(stats)
  })

  it('routes every path stat hook through the conversion', () => {
    expect(source).not.toMatch(/return vfsResult\.stats;|null, vfsResult\.stats\)/)
    expect(source.match(/vfsStatsForOptions\(vfsResult\.stats, options\)/g)).toHaveLength(hooks)
  })
})
