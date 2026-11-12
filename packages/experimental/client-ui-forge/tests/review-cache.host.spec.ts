import { describe, expect, it } from 'vitest'
import { Buffer } from 'node:buffer'
import type { ChangeRequestKey, ForgeReviewData } from '@deepseek-ai/dsh-experimental-forge'
import { ReviewCache } from '../src/review-cache.ts'

const a = 'fake:a#1' as ChangeRequestKey
const b = 'fake:b#2' as ChangeRequestKey
const c = 'fake:c#3' as ChangeRequestKey

/** A read with no threads, told apart by its head, whose length sets its size. */
function review(head: string): ForgeReviewData {
  return { headSha: head, viewer: null, threads: [], truncated: false, pendingReview: null, viewerCanReview: false }
}

const size = Buffer.byteLength(JSON.stringify(review('x')))

describe('ReviewCache', () => {
  it('returns threads kept at the same version until they reach the age limit', () => {
    const cache = new ReviewCache(size * 4, 100)
    cache.set(a, 'v1', review('x'), 1_000, cache.token())

    expect(cache.get(a, 'v1', 1_099)).toEqual(review('x'))
    expect(cache.get(a, 'v2', 1_050)).toBeUndefined()
    expect(cache.get(b, 'v1', 1_050)).toBeUndefined()
    expect(cache.get(a, 'v1', 1_100)).toBeUndefined()
  })

  it('replaces a change request\'s earlier read and drops the least recently read reads past the byte limit', () => {
    const cache = new ReviewCache(size * 2, 100)
    cache.set(a, 'v1', review('x'), 0, cache.token())
    cache.set(a, 'v2', review('y'), 0, cache.token())
    cache.set(b, 'v1', review('z'), 0, cache.token())
    expect(cache.get(a, 'v1', 0)).toBeUndefined()
    expect(cache.get(a, 'v2', 0)).toEqual(review('y'))

    cache.set(c, 'v1', review('w'), 0, cache.token())
    expect(cache.get(b, 'v1', 0)).toBeUndefined()
    expect(cache.get(a, 'v2', 0)).toEqual(review('y'))
    expect(cache.get(c, 'v1', 0)).toEqual(review('w'))
  })

  it('forgets a dropped change request and keeps no read that started before any drop', () => {
    const cache = new ReviewCache(size * 4, 100)
    const early = cache.token()
    cache.set(a, 'v1', review('x'), 0, early)
    cache.set(b, 'v1', review('y'), 0, early)
    cache.drop(a)
    cache.drop(c)

    expect(cache.get(a, 'v1', 0)).toBeUndefined()
    expect(cache.get(b, 'v1', 0)).toEqual(review('y'))
    cache.set(a, 'v1', review('z'), 0, early)
    expect(cache.get(a, 'v1', 0)).toBeUndefined()
    cache.set(a, 'v1', review('z'), 0, cache.token())
    expect(cache.get(a, 'v1', 0)).toEqual(review('z'))
    cache.set(a, 'v2', review('much longer than the others'), 0, cache.token())
    cache.set(c, 'v1', review('w'), 0, cache.token())
    expect(cache.get(c, 'v1', 0)).toEqual(review('w'))
  })

  it('keeps no read larger than the byte limit and forgets the read it replaced', () => {
    const cache = new ReviewCache(size, 100)
    cache.set(a, 'v1', review('x'), 0, cache.token())
    cache.set(a, 'v2', review('longer'), 0, cache.token())

    expect(cache.get(a, 'v1', 0)).toBeUndefined()
    expect(cache.get(a, 'v2', 0)).toBeUndefined()
    cache.set(b, 'v1', review('x'), 0, cache.token())
    expect(cache.get(b, 'v1', 0)).toEqual(review('x'))
  })
})
