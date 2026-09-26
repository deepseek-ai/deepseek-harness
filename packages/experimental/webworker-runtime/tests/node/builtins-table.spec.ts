/**
 * The Node-compatibility table and the module identity it owes its consumers.
 *
 * Two consumers read these specifiers — the worker vite build aliases them for
 * statically bundled code, and the module loader answers `require('node:fs')`
 * from VFS-loaded modules — and both must land on ONE module instance per
 * specifier. Class identity is what depends on it: `instanceof EventEmitter` and
 * `Buffer.isBuffer` compare against a specific copy, so a second instance turns
 * them into silent false answers rather than an error anyone can trace.
 *
 * The table holds factories, so what a table entry defers is the table read. The
 * namespace objects themselves belong to the static graph the worker bundle
 * evaluates at load, which is why nothing here asserts that a factory is
 * unevaluated.
 */
import { describe, expect, it } from 'vitest'
import { createNodeBuiltins, REPLACED_PREFIXES } from '../../src/node/builtins.ts'
import { WorkerModuleLoader, type WorkerRequire } from '../../src/module-system/module-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'

/** A loader over an empty image: every specifier below resolves from the table. */
function loaderRequire(): WorkerRequire {
  const vfs = new MemoryVfs()
  vfs.seedDirectory('/dsh')
  const loader = new WorkerModuleLoader({ vfs, root: '/dsh', staticModules: createNodeBuiltins() })
  return loader.createRequire('/dsh/')
}

describe('the replacement table', () => {
  it('holds a factory for every specifier', () => {
    const table = createNodeBuiltins()
    const notFunctions = Object.entries(table)
      .filter(([, value]) => typeof value !== 'function')
      .map(([specifier]) => specifier)
    // A module object left in the table would be called as a factory and fail at
    // the first require of that specifier, not at assembly.
    expect(notFunctions).toEqual([])
    expect(Object.keys(table).length).toBeGreaterThan(0)
  })

  it('keys every builtin with and without the node: prefix', () => {
    const table = createNodeBuiltins()
    expect(Object.keys(table)).toEqual(expect.arrayContaining(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']))
  })

  it('leaves process out, because the host installs that global itself', () => {
    const table = createNodeBuiltins()
    expect([table['process'], table['node:process']]).toEqual([undefined, undefined])
  })

  it('answers path and path/posix from one module: the worker speaks POSIX only', () => {
    const table = createNodeBuiltins()
    expect(table['path']?.()).toBe(table['path/posix']?.())
  })

  it('answers a prefixed subpath with the module its exact key answers', () => {
    const table = createNodeBuiltins()
    expect(REPLACED_PREFIXES['@earendil-works/pi-ai/']?.()).toBe(table['@earendil-works/pi-ai']?.())
  })
})

describe('module identity through the loader', () => {
  it('exposes async and synchronous resolution through the Cordis internal seam', async () => {
    const vfs = new MemoryVfs()
    vfs.seedDirectory('/dsh/node_modules/example')
    vfs.writeFileSync('/dsh/node_modules/example/package.json', JSON.stringify({ main: 'index.js' }))
    vfs.writeFileSync('/dsh/node_modules/example/index.js', 'module.exports = {}\n')
    const loader = new WorkerModuleLoader({ vfs, root: '/dsh', staticModules: createNodeBuiltins() })

    expect(loader.internal.resolveSync('example', 'file:///dsh/app.js')).toEqual({
      format: 'commonjs',
      url: 'file:///dsh/node_modules/example/index.js',
    })
    await expect(loader.internal.resolve('node:fs', 'file:///dsh/app.js')).resolves.toEqual({
      format: 'builtin',
      url: 'node:fs',
    })
  })

  it('hands the same instance to two requires of one specifier', () => {
    const require = loaderRequire()
    expect(require('node:events')).toBe(require('node:events'))
  })

  it('hands the same instance to the bare and prefixed specifiers', () => {
    const require = loaderRequire()
    expect(require('events')).toBe(require('node:events'))
    expect(require('fs')).toBe(require('node:fs'))
    expect(require('tty')).toBe(require('node:tty'))
  })

  it('shares promise stream helpers and observes completion and errors through the loader', async () => {
    const require = loaderRequire()
    const stream = require('node:stream') as typeof import('node:stream')
    const promises = require('node:stream/promises') as typeof import('node:stream/promises')
    expect(require('stream/promises')).toBe(promises)
    expect(promises.finished).toBe(stream.promises.finished)
    expect(promises.pipeline).toBe(stream.promises.pipeline)

    const output = new stream.Writable({ write(_chunk, _encoding, callback) { callback() } })
    const baseline = output.listenerCount('error')
    const completed = promises.finished(output, { cleanup: true })
    output.end('done')
    await completed
    expect(output.listenerCount('error')).toBe(baseline)

    const failed = new stream.Writable({ write(_chunk, _encoding, callback) { callback(new Error('write failed')) } })
    const rejected = expect(promises.finished(failed, { cleanup: true })).rejects.toThrow('write failed')
    failed.end('broken')
    await rejected
    expect(failed.listenerCount('error')).toBe(0)
  })

  it('reports that worker file descriptors are not terminals', () => {
    const tty = loaderRequire()('tty') as { isatty(fd: number): boolean }
    expect(tty.isatty(2)).toBe(false)
  })

  it('keeps class identity across those specifiers', () => {
    // The consequence the single-instance rule exists for: a second copy would
    // make this comparison answer false with nothing failing.
    const require = loaderRequire()
    const { EventEmitter } = require('events') as { EventEmitter: new () => unknown }
    const prefixed = require('node:events') as { EventEmitter: new () => unknown }
    expect(new EventEmitter() instanceof prefixed.EventEmitter).toBe(true)
  })

  it('refuses a specifier the table does not hold, instead of resolving it empty', () => {
    const require = loaderRequire()
    expect(() => require('node:dns')).toThrow()
  })

  it('exposes the package search paths used by the VFS resolver', () => {
    const require = loaderRequire()
    expect(require.resolve.paths('node:fs')).toBeNull()
    expect(require.resolve.paths('node:dns')).toBeNull()
    expect(require.resolve.paths('workspace-package')).toEqual(['/dsh/node_modules'])
    expect(require.resolve.paths('./local.js')).toEqual(['/dsh'])
  })
})
