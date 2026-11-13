import { afterEach, describe, expect, it, vi } from 'vitest'
import { startMinuteClock } from '../src/client/clock.ts'
import { minuteAt } from '../src/policy.ts'

afterEach(() => vi.useRealTimers())
describe('the minute-resolution sidebar clock', () => {
  it('publishes once per minute at the boundary and stops on disposal', async () => {
    vi.useFakeTimers()
    const start = Date.parse('2026-10-22T03:00:19Z')
    vi.setSystemTime(start)
    const update = vi.fn()
    const stop = startMinuteClock(update)
    await vi.advanceTimersByTimeAsync(40999)
    expect(update).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(update.mock.calls).toEqual([[minuteAt(start) + 60000]])
    await vi.advanceTimersByTimeAsync(59999)
    expect(update).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(update.mock.calls.at(-1)).toEqual([minuteAt(start) + 120000])
    stop()
    await vi.advanceTimersByTimeAsync(120000)
    expect(update).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})
