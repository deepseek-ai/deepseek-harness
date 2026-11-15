import { describe, expect, it } from 'vitest'
import { TimeScale } from '../src/client/TimeScale.ts'
import { HISTORY_MS, MINUTE_MS } from '../src/policy.ts'

const now = Date.parse('2026-10-27T12:00:00Z')
const hour = 3600000

describe('the wall-clock time scale', () => {
  it('keeps exact conversion and clips at the seven-day boundary', () => {
    const scale = new TimeScale(now, 3600)
    expect(scale.position(now)).toBe(0)
    expect(scale.position(now - hour)).toBeCloseTo(3600)
    expect(scale.time(3600)).toBeCloseTo(now - hour)
    expect(scale.time(-100)).toBe(now)
    expect(scale.time(scale.height + 100)).toBe(now - HISTORY_MS)
    expect(scale.position(now + hour)).toBe(0)
    expect(scale.position(now - HISTORY_MS - hour)).toBe(scale.height)
    for (const time of [now, now - 27, now - 5000, now - hour, now - HISTORY_MS])
      expect(scale.time(scale.position(time))).toBeCloseTo(time, 3)
  })

  it.each([24, 3600, 25200])('preserves real duration ratios at %s pixels per hour', (density) => {
    const scale = new TimeScale(now, density)
    const minute = scale.position(now - MINUTE_MS)
    expect(scale.position(now - 10 * MINUTE_MS) / minute).toBeCloseTo(10)
    expect(scale.position(now - hour) / minute).toBeCloseTo(60)
    const old = now - 4 * hour
    expect(scale.position(old - MINUTE_MS) - scale.position(old)).toBeCloseTo(minute)
    expect(scale.position(now - 5000) / minute).toBeCloseTo(1 / 12)
  })

  it('keeps minute ticks and physical label spacing throughout empty spans', () => {
    const scale = new TimeScale(now, 3600)
    for (const offset of [0, 3600, 4 * 3600]) {
      const ticks = scale.ticks(offset, 500, 40)
      expect(ticks.length).toBeGreaterThan(3)
      expect(ticks.every(tick => Number(tick) % MINUTE_MS === 0)).toBe(true)
      const positions = ticks.map(tick => scale.position(Number(tick)))
      expect(positions.slice(1).every((value, index) => value - (positions[index] ?? 0) >= 26)).toBe(true)
    }
  })
})
