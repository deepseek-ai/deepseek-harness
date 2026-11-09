import { describe, expect, it } from 'vitest'
import { Buffer } from 'node:buffer'
import type { ChangeRequestKey, ForgeReviewData } from '@deepseek-ai/dsh-experimental-forge'
import { ReviewCache } from '../src/review-cache.ts'

const a = 'fake:a#1' as ChangeRequestKey
const b = 'fake:b#2' as ChangeRequestKey
const c = 'fake:c#3' as ChangeRequestKey

/** A read with no threads, told apart by its head, whose length sets its size. */
function review(head: string): ForgeReviewData {
  return { headSha: head, threads: [], truncated: false }
}

const size = Buffer.byteLength(JSON.stringify(review('x')))

describe('ReviewCache', () => {
  it('returns threads kept at the same version until they reach the age limit', () => {
    const cache = new ReviewCache(size * 4, 100)
    cache.set(a, 'v1', review('x'), 1_000)

    expect(cache.get(a, 'v1', 1_099)).toEqual(review('x'))
    expect(cache.get(a, 'v2', 1_050)).toBeUndefined()
    expect(cache.get(b, 'v1', 1_050)).toBeUndefined()
    expect(cache.get(a, 'v1', 1_100)).toBeUndefined()
  })

  it('replaces a change request\'s earlier read and drops the least recently read reads past the byte limit', () => {
    const cache = new ReviewCache(size * 2, 100)
    cache.set(a, 'v1', review('x'), 0)
    cache.set(a, 'v2', review('y'), 0)
    cache.set(b, 'v1', review('z'), 0)
    expect(cache.get(a, 'v1', 0)).toBeUndefined()
    expect(cache.get(a, 'v2', 0)).toEqual(review('y'))

    cache.set(c, 'v1', review('w'), 0)
    expect(cache.get(b, 'v1', 0)).toBeUndefined()
    expect(cache.get(a, 'v2', 0)).toEqual(review('y'))
    expect(cache.get(c, 'v1', 0)).toEqual(review('w'))
  })

  it('keeps no read larger than the byte limit and forgets the read it replaced', () => {
    const cache = new ReviewCache(size, 100)
    cache.set(a, 'v1', review('x'), 0)
    cache.set(a, 'v2', review('longer'), 0)

    expect(cache.get(a, 'v1', 0)).toBeUndefined()
    expect(cache.get(a, 'v2', 0)).toBeUndefined()
    cache.set(b, 'v1', review('x'), 0)
    expect(cache.get(b, 'v1', 0)).toEqual(review('x'))
  })
})
