/** Timer iterator ordering and cancellation on the vendored Cordis lifecycle. */
import { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'

describe('Cordis Timer', () => {
  let ctx: Context

  beforeEach(async () => {
    vi.useFakeTimers()
    ctx = new Context()
    await ctx.plugin(Timer)
  })

  afterEach(async () => {
    try {
      await ctx.fiber.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('completes concurrent interval reads in order, one per tick', async () => {
    const iterator = ctx.interval(10)
    const completed: number[] = []
    const reads = [0, 1, 2].map(index => iterator.next().then(
      (value) => { completed.push(index); return value },
      () => undefined,
    ))
    for (let index = 0; index < reads.length; index++) {
      await vi.advanceTimersByTimeAsync(10)
      expect(completed).toEqual(Array.from({ length: index + 1 }, (_, i) => i))
    }
    expect(await Promise.all(reads)).toEqual(Array(3).fill({ done: false, value: undefined }))
    await iterator.return!()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['return', 'throw', 'dispose'] as const)('settles all pending interval reads on %s', async (operation) => {
    const iterator = ctx.interval<string>(10)
    const completed: PromiseSettledResult<IteratorResult<void, string>>[] = []
    for (let index = 0; index < 3; index++) {
      void iterator.next().then(
        value => completed.push({ status: 'fulfilled', value }),
        (reason: unknown) => completed.push({ status: 'rejected', reason }),
      )
    }
    const error = new Error('stopped')
    if (operation === 'return') await iterator.return!('finished')
    else if (operation === 'throw') await iterator.throw!(error)
    else await ctx.fiber.dispose()
    await vi.advanceTimersByTimeAsync(0)
    expect(completed).toHaveLength(3)
    if (operation === 'return') {
      expect(completed).toEqual(Array(3).fill({ status: 'fulfilled', value: { done: true, value: 'finished' } }))
      await expect(iterator.next()).resolves.toEqual({ done: true, value: 'finished' })
    } else {
      const reason = operation === 'throw' ? error : new Error('Context has been disposed')
      expect(completed).toEqual(Array(3).fill({ status: 'rejected', reason }))
      await expect(iterator.next()).rejects.toThrow(reason.message)
    }
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])('stops throttle calls and trailing work after disposal (noTrailing=%s)', async (noTrailing) => {
    const callback = vi.fn((value: string) => value.length)
    const throttled = ctx.throttle(callback, 10, noTrailing)
    expectTypeOf(throttled).parameters.toEqualTypeOf<[string]>()
    expectTypeOf(throttled).returns.toBeVoid()
    throttled('first')
    throttled('second')
    await vi.advanceTimersByTimeAsync(10)
    expect(callback.mock.calls).toEqual(noTrailing ? [['first']] : [['first'], ['second']])
    throttled('before disposal')
    const calls = callback.mock.calls.length
    throttled.dispose()
    await vi.advanceTimersByTimeAsync(20)
    throttled('after disposal')
    expect(callback).toHaveBeenCalledTimes(calls)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels debounce work and makes both wrappers inert after owner disposal', async () => {
    const callback = vi.fn((value: string) => value.length)
    const debounced = ctx.debounce(callback, 10)
    const throttled = ctx.throttle(callback, 10)
    expectTypeOf(debounced).parameters.toEqualTypeOf<[string]>()
    expectTypeOf(debounced).returns.toBeVoid()
    debounced('first')
    debounced('last')
    await vi.advanceTimersByTimeAsync(10)
    expect(callback).toHaveBeenCalledExactlyOnceWith('last')
    debounced('pending')
    await ctx.fiber.dispose()
    debounced('disposed')
    throttled('disposed')
    await vi.advanceTimersByTimeAsync(10)
    expect(callback).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
