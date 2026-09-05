/**
 * Shared `/` menu ranker: case-insensitive ordered-subsequence matching,
 * prefix hits first, alignment score next, source order for ties.
 */
import { describe, expect, it } from 'vitest'
import { rankByName } from '@deepseek-ai/dsh-client-ui-primitives'

const named = (...names: string[]) => names.map(name => ({ name }))
const names = (items: readonly { name: string }[]) => items.map(item => item.name)

describe('rankByName', () => {
  it('returns the input list itself for an empty query', () => {
    const items = named('b', 'a')
    expect(rankByName(items, '')).toBe(items)
  })

  it('matches case-insensitive subsequences and ranks prefixes, boundaries, adjacency, gaps, then source order', () => {
    const items = named('q-xylophone', 'qx-long', 'fabulous', 'foo-bar', 'zuv', 'zu1v', 'yu1v', 'zu12v')
    expect(names(rankByName(items, 'QX'))).toEqual(['qx-long', 'q-xylophone'])
    expect(names(rankByName(items, 'fb'))).toEqual(['foo-bar', 'fabulous'])
    expect(names(rankByName(items, 'uv'))).toEqual(['zuv', 'zu1v', 'yu1v', 'zu12v'])
    expect(names(rankByName(items, 'zzz'))).toEqual([])
    expect(names(rankByName(items, 'query-longer-than-every-name'))).toEqual([])
  })

  it('a prefix hit outranks a stronger non-prefix alignment', () => {
    // 'z_a_b' aligns both characters on separator boundaries and outscores
    // every non-prefix rival; a name that starts with the query still wins.
    expect(names(rankByName(named('z_a_b', 'xabc'), 'ab'))).toEqual(['z_a_b', 'xabc'])
    expect(names(rankByName(named('z_a_b', 'abc'), 'ab'))).toEqual(['abc', 'z_a_b'])
  })

  it('takes the stronger of an adjacent and a gapped alignment for the same character', () => {
    expect(names(rankByName(named('aab', 'ab'), 'ab'))).toEqual(['ab', 'aab'])
  })

  it('returns the ranked items with their payload intact', () => {
    const items = [{ name: 'goal', description: 'g' }, { name: 'plan', description: 'p' }]
    expect(rankByName(items, 'pl')).toEqual([{ name: 'plan', description: 'p' }])
  })
})
