import { describe, expect, it } from 'vitest'
import { assignWeightedShards, parseShardShares } from './web-snapshot-sequencer.ts'

describe('web snapshot shard assignment', () => {
  const files = [
    { key: 'a.e2e.ts', weight: 90 },
    { key: 'b.e2e.ts', weight: 60 },
    { key: 'c.e2e.ts', weight: 50 },
    { key: 'd.e2e.ts', weight: 30 },
    { key: 'e.e2e.ts', weight: 20 },
  ]

  it('partitions every file exactly once and balances load longest-first', () => {
    const shards = assignWeightedShards(files, [1, 1])

    expect(shards.flat().sort()).toEqual(files.map(file => file.key))
    expect(shards).toEqual([['a.e2e.ts', 'd.e2e.ts'], ['b.e2e.ts', 'c.e2e.ts', 'e.e2e.ts']])
  })

  it('gives a larger share proportionally more weight', () => {
    const shards = assignWeightedShards(files, [1, 3])
    const load = (keys: readonly string[]) => keys.reduce((sum, key) => sum + (files.find(file => file.key === key)?.weight ?? 0), 0)

    expect(load(shards[0] ?? [])).toBeLessThan(load(shards[1] ?? []))
  })

  it('places the slice specs of one file as separate weights', () => {
    const slices = [1, 2, 3].map(slice => ({ key: `web-slice:long:${String(slice)}:long.e2e.ts`, weight: 40 }))
    const shards = assignWeightedShards([...slices, { key: 'web:a.e2e.ts', weight: 60 }], [1, 1])

    expect(shards).toEqual([['web:a.e2e.ts', 'web-slice:long:3:long.e2e.ts'], ['web-slice:long:1:long.e2e.ts', 'web-slice:long:2:long.e2e.ts']])
  })

  it('returns the same assignment for any input order', () => {
    expect(assignWeightedShards([...files].reverse(), [1, 1])).toEqual(assignWeightedShards(files, [1, 1]))
  })

  it('defaults to equal shares and rejects a malformed share list', () => {
    expect(parseShardShares(undefined, 3)).toEqual([1, 1, 1])
    expect(parseShardShares('0.45, 0.55', 2)).toEqual([0.45, 0.55])
    expect(() => parseShardShares('1', 2)).toThrow(/must list 2 positive numbers/)
    expect(() => parseShardShares('1,0', 2)).toThrow(/must list 2 positive numbers/)
  })
})
