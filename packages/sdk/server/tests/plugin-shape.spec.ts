import { describe, expect, it } from 'vitest'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as jsonrpc from '../src/index.ts'

/**
 * Run the real namespace export through `Loader.unwrapExports`; a stray
 * default would discard `name`, `inject`, `Config`, and `apply`.
 */
describe('dsh-sdk-jsonrpc-server plugin export shape', () => {
  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/Config/apply', () => {
    expect('default' in jsonrpc).toBe(false)
    expect(typeof jsonrpc.apply).toBe('function')

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(jsonrpc) as Record<string, unknown>
    expect(unwrapped).toBe(jsonrpc)
    expect(unwrapped.name).toBe('sdk-jsonrpc-server')
    expect(unwrapped.inject).toEqual(['agents', 'workingDirectory'])
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')
  })
})
