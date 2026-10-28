/** Change request patches kept for later reads: versions, recency, and the size bound. */

import { describe, expect, it } from 'vitest'
import { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import type { ChangeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import { PatchCache } from '../src/patch-cache.ts'

function key(number: number): ChangeRequestKey {
  return changeRequestKey({ repository: { forge: 'fake', host: 'fake.test', owner: 'octo', name: 'demo' }, number })
}

describe('PatchCache', () => {
  it('answers only for the version a patch was read at, keeping one version per change request', () => {
    const cache = new PatchCache(100)
    expect(cache.get(key(1), 'v1')).toBeUndefined()

    cache.set(key(1), 'v1', 'one')
    expect(cache.get(key(1), 'v1')).toBe('one')
    expect(cache.get(key(1), 'v2')).toBeUndefined()
    cache.set(key(1), 'v2', 'two')
    expect(cache.get(key(1), 'v1')).toBeUndefined()
    expect(cache.get(key(1), 'v2')).toBe('two')
  })

  it('drops the least recently read patches once the kept patches exceed the bound in UTF-8 bytes', () => {
    const cache = new PatchCache(10)
    cache.set(key(1), 'v', 'aaaa')
    cache.set(key(2), 'v', 'bbb')
    expect(cache.get(key(1), 'v')).toBe('aaaa')

    // Two three-byte characters bring the total to 13 bytes, so #2, read least recently, leaves.
    cache.set(key(3), 'v', '变更')
    expect(cache.get(key(2), 'v')).toBeUndefined()
    expect(cache.get(key(1), 'v')).toBe('aaaa')
    expect(cache.get(key(3), 'v')).toBe('变更')
  })

  it('keeps no patch over the bound, dropping the earlier version all the same', () => {
    const cache = new PatchCache(4)
    cache.set(key(1), 'v1', 'one')
    cache.set(key(1), 'v2', 'large')
    expect(cache.get(key(1), 'v1')).toBeUndefined()
    expect(cache.get(key(1), 'v2')).toBeUndefined()

    cache.set(key(1), 'v3', 'four')
    expect(cache.get(key(1), 'v3')).toBe('four')
  })
})
