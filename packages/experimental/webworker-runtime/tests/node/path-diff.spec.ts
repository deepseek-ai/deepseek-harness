/**
 * Differential check of this package's POSIX path shim against Node's
 * `path.posix`.
 *
 * Differential rather than example-based: the shim's contract is "behaves like
 * `node:path/posix`", so Node itself is the oracle and every case is compared
 * rather than asserted against a hand-written expectation. The corpus is the
 * shapes a VFS path actually takes (absolute image paths, `node_modules`
 * specifiers, `.bin` entries) plus edge forms that stress lexical handling
 * (repeated slashes, trailing dots, `..` past the root).
 *
 * Imports go through the package name so the harness and the shim resolve to one
 * module instance (see `../polyfill/als-shim.spec.ts` for why that matters).
 */
import { expect, test } from 'vitest'
import { posix as nodePosix, win32 as nodeWin32 } from 'node:path'
import * as shim from '@deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/path.ts'

const CASES = [
  '', '.', '..', '/', '//', '///', 'a', '/a', 'a/', '/a/', 'a/b', '/a/b/c', 'a//b', '/a//b/',
  './a', '../a', 'a/./b', 'a/../b', '/a/../..', '/../a', 'a/b/../../c', '.hidden', 'a.b.c',
  '/a/b/c.txt', 'c.txt', '.txt', 'a/.txt', 'a/b.', '/a/b/.', '/a/b/..', 'foo/bar/../baz/./qux',
  '/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js', 'node_modules/.bin/x',
]

const JOINS: string[][] = [
  ['a', 'b'], ['/a', 'b'], ['a', '/b'], ['a', '..'], ['a', '../..'], ['', 'b'], ['a', ''],
  ['/dsh', 'config', 'cordis.yml'], ['/dsh/node_modules', '@scope/pkg', 'lib/index.js'],
  ['a/', '/b'], ['.', 'a'], ['..', 'a'], ['/', 'a'], [],
]

const RESOLVES: string[][] = [
  ['a'], ['/a', 'b'], ['/a', '/b'], ['a', '..'], ['/dsh', './config/../config/cordis.yml'],
  ['/a/b', '../c'], ['/'], ['', 'a'], ['/dsh/node_modules/pkg', './lib/../lib/index.js'],
]

const RELATIVES: [string, string][] = [
  ['/a/b', '/a/b/c'], ['/a/b/c', '/a/b'], ['/a', '/b'], ['/a/b', '/a/b'], ['/', '/a'],
  ['/dsh/node_modules/a', '/dsh/node_modules/b/lib/x.js'],
]

const compare = (label: string, actual: unknown, expected: unknown): void => {
  const [shimmed, node] = [JSON.stringify(actual), JSON.stringify(expected)]
  test(label, () => { expect(shimmed).toBe(node) })
}

// resolve() consults process.cwd() on both sides; pin it so they agree, then put
// it back before any case runs so the rest of the run keeps the repository root.
const originalCwd = process.cwd()
process.chdir('/')

for (const value of CASES) {
  for (const fn of ['normalize', 'dirname', 'basename', 'extname', 'isAbsolute', 'parse'] as const) {
    try {
      compare(`${fn}(${JSON.stringify(value)})`, (shim[fn] as (v: string) => unknown)(value), (nodePosix[fn] as (v: string) => unknown)(value))
    } catch (error) {
      const thrown = String(error)
      test(`${fn}(${JSON.stringify(value)}) does not throw`, () => { expect.unreachable(thrown) })
    }
  }
  compare(`basename(${JSON.stringify(value)}, '.txt')`, shim.basename(value, '.txt'), nodePosix.basename(value, '.txt'))
}

for (const parts of JOINS) compare(`join(${JSON.stringify(parts)})`, shim.join(...parts), nodePosix.join(...parts))
for (const parts of RESOLVES) compare(`resolve(${JSON.stringify(parts)})`, shim.resolve(...parts), nodePosix.resolve(...parts))
for (const [from, to] of RELATIVES) compare(`relative(${from}, ${to})`, shim.relative(from, to), nodePosix.relative(from, to))
for (const value of CASES) {
  const parsed = nodePosix.parse(value)
  compare(`format(parse(${JSON.stringify(value)}))`, shim.format(parsed), nodePosix.format(parsed))
}

// Cross-platform callers reject Windows absolute paths with `path.win32.isAbsolute` on any platform.
const WIN32_ABSOLUTES = ['', 'C:', 'C:\\x', 'c:/x', 'C:x', '\\x', '/x', '\\\\server\\share', 'x\\y', './icon.svg', 'icon.svg', '1:\\x']
for (const value of WIN32_ABSOLUTES) {
  try {
    compare(`win32.isAbsolute(${JSON.stringify(value)})`, shim.win32.isAbsolute(value), nodeWin32.isAbsolute(value))
  } catch (error) {
    const thrown = String(error)
    test(`win32.isAbsolute(${JSON.stringify(value)}) does not throw`, () => { expect.unreachable(thrown) })
  }
}

process.chdir(originalCwd)
