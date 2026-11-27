import { describe, expect, it } from 'vitest'
import { relativeTime } from '@deepseek-ai/dsh-client-ui-primitives/client'

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const now = 1_800_000_000_000

describe('relativeTime', () => {
  it('buckets each distance and reports its magnitude', () => {
    expect(relativeTime(now, now)).toEqual({ unit: 'now', n: 0 })
    expect(relativeTime(now - 5 * MIN, now)).toEqual({ unit: 'minutes', n: 5 })
    expect(relativeTime(now - 3 * HOUR, now)).toEqual({ unit: 'hours', n: 3 })
    expect(relativeTime(now - 2 * DAY, now)).toEqual({ unit: 'days', n: 2 })
    expect(relativeTime(now - 60 * DAY, now)).toEqual({ unit: 'months', n: 2 })
    expect(relativeTime(now - 400 * DAY, now)).toEqual({ unit: 'years', n: 1 })
  })

  it('reports the coarser bucket at each boundary', () => {
    expect(relativeTime(now - MIN, now)).toEqual({ unit: 'minutes', n: 1 })
    expect(relativeTime(now - HOUR, now)).toEqual({ unit: 'hours', n: 1 })
    expect(relativeTime(now - DAY, now)).toEqual({ unit: 'days', n: 1 })
    expect(relativeTime(now - 30 * DAY, now)).toEqual({ unit: 'months', n: 1 })
    expect(relativeTime(now - 365 * DAY, now)).toEqual({ unit: 'years', n: 1 })
  })

  it('reads a future moment as the present rather than a negative distance', () => {
    expect(relativeTime(now + DAY, now)).toEqual({ unit: 'now', n: 0 })
  })
})
