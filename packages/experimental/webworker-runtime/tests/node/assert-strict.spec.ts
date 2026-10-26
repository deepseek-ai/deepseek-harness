/** Strict assertion resolution and execution through the Worker image loader. */
import { describe, expect, it } from 'vitest'
import { lowerModuleSource } from '../../src/compile/transform.ts'
import { MODULE_PROXIES } from '../../src/module-proxies.ts'
import { WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { createNodeBuiltins } from '../../src/node/builtins.ts'
import assert, { ok } from '../../src/node/builtin_modules/implemented/assert/strict.ts'
import { isBuiltin } from '../../src/node/builtin_modules/implemented/module.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'

describe('Worker strict assertions', () => {
  it.each([true, 1, 'present', {}, []])('accepts truthy value %j', (value) => {
    expect(() => { assert(value) }).not.toThrow()
  })

  it.each([false, 0, '', null, undefined, NaN])('rejects falsy value %j with assertion fields', (value) => {
    expect(() => { assert(value, 'HMR pending module is missing') }).toThrow(expect.objectContaining({
      name: 'AssertionError',
      code: 'ERR_ASSERTION',
      message: 'HMR pending module is missing',
      actual: value,
      expected: true,
      operator: '==',
      generatedMessage: false,
    }))
  })

  it('generates a message when none is supplied', () => {
    expect(() => { assert(false) }).toThrow(expect.objectContaining({
      message: 'The expression evaluated to a falsy value.',
      generatedMessage: true,
    }))
  })

  it('preserves an explicitly empty message', () => {
    expect(() => { assert(false, '') }).toThrow(expect.objectContaining({ message: '', generatedMessage: false }))
  })

  it('throws a supplied Error unchanged', () => {
    const error = new Error('missing module')
    expect.assertions(2)
    try {
      assert(false, error)
    } catch (reason) {
      expect(reason).toBe(error)
    }
    expect(() => { assert(true, error) }).not.toThrow()
  })

  it('shares the callable default and ok exports', () => {
    expect(assert).toBe(ok)
    expect(assert.ok).toBe(ok)
  })

  it.each(['node:assert/strict', 'assert/strict'])('resolves and executes a lowered default import from %s', (specifier) => {
    const vfs = new MemoryVfs()
    vfs.seedDirectory('/dsh')
    const loader = new WorkerModuleLoader({ vfs, root: '/dsh', staticModules: createNodeBuiltins() })
    const transformed = lowerModuleSource({
      filename: '/dsh/probe.js',
      source: `import assert, { ok } from '${specifier}';
        assert({ getNamespace() {} }, 'HMR pending module is missing');
        ok(true);
        export const same = assert === ok && assert.ok === ok;
        export function reject() { assert(undefined, 'HMR pending module is missing'); }`,
    })
    expect(transformed.moduleRequests).toContain(specifier)
    expect(loader.resolve(specifier, '/dsh')).toMatchObject({ kind: 'static' })
    expect(isBuiltin(specifier)).toBe(true)
    expect(MODULE_PROXIES[specifier]).toBe('./node/builtin_modules/implemented/assert/strict.ts')
    vfs.writeFileSync('/dsh/probe.js', transformed.code)
    const require = loader.createRequire('/dsh/')
    expect(require('assert/strict')).toBe(require('node:assert/strict'))
    const probe = require('./probe.js') as { same: boolean; reject: () => void }
    expect(probe.same).toBe(true)
    expect(probe.reject).toThrow(expect.objectContaining({ code: 'ERR_ASSERTION', message: 'HMR pending module is missing' }))
  })
})
