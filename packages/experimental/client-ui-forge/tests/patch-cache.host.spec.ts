/** Change request patches kept for later reads: versions, recency, and the size bound. */

import { describe, expect, it } from 'vitest'
import { changeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import type { ChangeRequestKey } from '@deepseek-ai/dsh-experimental-forge'
import { PatchCache } from '../src/patch-cache.ts'

/** A patch without attributes. */
function entry(patch: string): { readonly patch: string; readonly attributes: string } {
  return { patch, attributes: '' }
}

function key(number: number): ChangeRequestKey {
  return changeRequestKey({ repository: { forge: 'fake', host: 'fake.test', owner: 'octo', name: 'demo' }, number })
}

describe('PatchCache', () => {
  it('answers only for the version a patch was read at, keeping one version per change request', () => {
    const cache = new PatchCache(100)
    expect(cache.get(key(1), 'v1')).toBeUndefined()

    cache.set(key(1), 'v1', entry('one'))
    expect(cache.get(key(1), 'v1')).toEqual(entry('one'))
    expect(cache.get(key(1), 'v2')).toBeUndefined()
    cache.set(key(1), 'v2', entry('two'))
    expect(cache.get(key(1), 'v1')).toBeUndefined()
    expect(cache.get(key(1), 'v2')).toEqual(entry('two'))
  })

  it('drops the least recently read patches once the kept patches exceed the bound in UTF-8 bytes', () => {
    const cache = new PatchCache(10)
    cache.set(key(1), 'v', entry('aaaa'))
    cache.set(key(2), 'v', entry('bbb'))
    expect(cache.get(key(1), 'v')).toEqual(entry('aaaa'))

    // Two three-byte characters bring the total to 13 bytes, so #2, read least recently, leaves.
    cache.set(key(3), 'v', entry('变更'))
    expect(cache.get(key(2), 'v')).toBeUndefined()
    expect(cache.get(key(1), 'v')).toEqual(entry('aaaa'))
    expect(cache.get(key(3), 'v')).toEqual(entry('变更'))
  })

  it('counts the attributes kept beside a patch toward the bound', () => {
    const cache = new PatchCache(6)
    cache.set(key(1), 'v', { patch: 'aaa', attributes: 'bbbb' })
    expect(cache.get(key(1), 'v')).toBeUndefined()
    cache.set(key(1), 'v', { patch: 'aaa', attributes: 'bbb' })
    expect(cache.get(key(1), 'v')).toEqual({ patch: 'aaa', attributes: 'bbb' })
  })

  it('keeps no patch over the bound, dropping the earlier version all the same', () => {
    const cache = new PatchCache(4)
    cache.set(key(1), 'v1', entry('one'))
    cache.set(key(1), 'v2', entry('large'))
    expect(cache.get(key(1), 'v1')).toBeUndefined()
    expect(cache.get(key(1), 'v2')).toBeUndefined()

    cache.set(key(1), 'v3', entry('four'))
    expect(cache.get(key(1), 'v3')).toEqual(entry('four'))
  })
})
