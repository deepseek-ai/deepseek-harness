/** Monotonic idle grace, independent window holds, and retryable terminal ownership. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SubprocessTerminalActivity } from '@deepseek-ai/dsh-subprocess'
import { TerminalRetention, type TerminalRetentionPolicy } from '../src/retention.ts'

const owners: TerminalRetention[] = []
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }) })
afterEach(async () => { await Promise.allSettled(owners.splice(0).map(owner => owner.dispose())); vi.useRealTimers() })

function fixture(policy: Partial<TerminalRetentionPolicy> = {}) {
  const inspect = vi.fn(async (): Promise<SubprocessTerminalActivity> => ({ state: 'idle', revision: 1 }))
  const terminate = vi.fn(async () => {})
  const failed = vi.fn()
  const owner = new TerminalRetention(
    { unattendedTimeoutMs: 100, activityPollIntervalMs: 10, cleanupRetryMs: 20, ...policy }, inspect, terminate, failed,
  )
  owners.push(owner)
  return { owner, inspect, terminate, failed }
}

it('starts the whole idle grace at the first positive observation and clears only at its deadline', async () => {
  const h = fixture()
  await vi.advanceTimersByTimeAsync(99)
  expect(h.terminate).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(h.terminate).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1000)
  expect(h.terminate).toHaveBeenCalledOnce()
})

it('retains two independent windows and starts a fresh grace after the last disconnect', async () => {
  const h = fixture()
  const a = new AbortController()
  const b = new AbortController()
  const first = h.owner.retain(a.signal)[Symbol.asyncIterator]()
  const second = h.owner.retain(b.signal)[Symbol.asyncIterator]()
  expect(await first.next()).toMatchObject({ value: { type: 'retained' } })
  await second.next()
  a.abort()
  await vi.advanceTimersByTimeAsync(500)
  expect(h.inspect).not.toHaveBeenCalled()
  b.abort()
  await vi.advanceTimersByTimeAsync(99)
  expect(h.terminate).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(h.terminate).toHaveBeenCalledOnce()
  await first.return?.()
  await second.return?.()
})

it.each(['busy', 'unknown'] as const)('protects %s work for arbitrarily many deadlines, then gives it the full idle grace', async (state) => {
  const h = fixture()
  h.inspect.mockResolvedValue({ state, revision: 2 })
  await vi.advanceTimersByTimeAsync(1000)
  expect(h.terminate).not.toHaveBeenCalled()
  h.inspect.mockResolvedValue({ state: 'idle', revision: 3 })
  await vi.advanceTimersByTimeAsync(109)
  expect(h.terminate).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(h.terminate).toHaveBeenCalledOnce()
})

it('invalidates elapsed grace on failed inspection, input, and intervening shell revisions', async () => {
  const h = fixture()
  await vi.advanceTimersByTimeAsync(90)
  h.inspect.mockRejectedValueOnce(new Error('SSH unavailable'))
  await vi.advanceTimersByTimeAsync(90)
  h.owner.invalidate()
  await vi.advanceTimersByTimeAsync(90)
  h.inspect.mockResolvedValue({ state: 'idle', revision: 2 })
  await vi.advanceTimersByTimeAsync(100)
  expect(h.terminate).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(10)
  expect(h.terminate).toHaveBeenCalledOnce()
})

it('discards an asynchronous observation invalidated by a reconnect and its subsequent disconnect', async () => {
  const h = fixture()
  await vi.advanceTimersByTimeAsync(90)
  const pending = Promise.withResolvers<SubprocessTerminalActivity>()
  h.inspect.mockReturnValueOnce(pending.promise)
  await vi.advanceTimersByTimeAsync(10)
  const abort = new AbortController()
  const stream = h.owner.retain(abort.signal)[Symbol.asyncIterator]()
  await stream.next()
  abort.abort()
  pending.resolve({ state: 'idle', revision: 1 })
  await vi.advanceTimersByTimeAsync(99)
  expect(h.terminate).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(h.terminate).toHaveBeenCalledOnce()
  await stream.return?.()
})

it('keeps failed cleanup closed to new holders and retries once without a new idle grace', async () => {
  const h = fixture()
  h.terminate.mockRejectedValueOnce(new Error('process still alive'))
  await vi.advanceTimersByTimeAsync(100)
  expect(h.failed).toHaveBeenCalledOnce()
  await expect(h.owner.retain(new AbortController().signal)[Symbol.asyncIterator]().next()).rejects.toThrow('unavailable')
  await vi.advanceTimersByTimeAsync(19)
  expect(h.terminate).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1)
  expect(h.terminate).toHaveBeenCalledTimes(2)
})

it('joins explicit cleanup, closes held streams, and cancels timers on disposal', async () => {
  const h = fixture()
  const stream = h.owner.retain(new AbortController().signal)[Symbol.asyncIterator]()
  await stream.next()
  const ended = stream.next()
  const pending = Promise.withResolvers<undefined>()
  h.terminate.mockReturnValueOnce(pending.promise)
  const first = h.owner.close()
  expect(h.owner.close()).toBe(first)
  expect(await ended).toMatchObject({ done: true })
  pending.resolve(undefined)
  await h.owner.dispose()
  expect(vi.getTimerCount()).toBe(0)
  expect(h.terminate).toHaveBeenCalledOnce()
})

it('can disable automatic reclamation while retaining explicit cleanup and cancellation', async () => {
  const h = fixture({ unattendedTimeoutMs: 0 })
  await vi.advanceTimersByTimeAsync(1000)
  expect(h.inspect).not.toHaveBeenCalled()
  const signal = AbortSignal.abort(new Error('disconnected'))
  await expect(h.owner.retain(signal)[Symbol.asyncIterator]().next()).rejects.toThrow('disconnected')
  await h.owner.close()
  expect(h.terminate).toHaveBeenCalledOnce()
})

it('bounds native timers without shortening a configured cleanup retry', async () => {
  const h = fixture({ unattendedTimeoutMs: 0, cleanupRetryMs: 3_000_000_000 })
  h.terminate.mockRejectedValueOnce(new Error('retry'))
  await expect(h.owner.close()).rejects.toThrow('retry')
  await vi.advanceTimersByTimeAsync(2_999_999_999)
  expect(h.terminate).toHaveBeenCalledOnce()
  await vi.advanceTimersByTimeAsync(1)
  expect(h.terminate).toHaveBeenCalledTimes(2)
})

it('does not overlap activity queries when a disconnect schedules work during an outstanding observation', async () => {
  const h = fixture()
  const pending = Promise.withResolvers<SubprocessTerminalActivity>()
  h.inspect.mockReturnValueOnce(pending.promise)
  await vi.advanceTimersByTimeAsync(0)
  const abort = new AbortController()
  const stream = h.owner.retain(abort.signal)[Symbol.asyncIterator]()
  await stream.next()
  abort.abort()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.inspect).toHaveBeenCalledOnce()
  pending.resolve({ state: 'idle', revision: 1 })
  await vi.advanceTimersByTimeAsync(10)
  expect(h.inspect).toHaveBeenCalledTimes(2)
  expect(h.terminate).not.toHaveBeenCalled()
  await stream.return?.()
})

it('waits for the in-flight observation before reporting a disposal cleanup failure', async () => {
  const h = fixture()
  const pending = Promise.withResolvers<SubprocessTerminalActivity>()
  h.inspect.mockReturnValueOnce(pending.promise)
  await vi.advanceTimersByTimeAsync(0)
  const error = new Error('cleanup failed')
  h.terminate.mockRejectedValueOnce(error)
  let settled = false
  const disposed = h.owner.dispose().catch((reason: unknown) => { settled = true; return reason })
  try {
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    pending.resolve({ state: 'unknown', revision: 1 })
    expect(await disposed).toBe(error)
  } finally { pending.resolve({ state: 'unknown', revision: 1 }); await disposed }
})

it('waits for pending cleanup when the observation settles first during disposal', async () => {
  const h = fixture()
  const observed = Promise.withResolvers<SubprocessTerminalActivity>()
  const cleanup = Promise.withResolvers<undefined>()
  h.inspect.mockReturnValueOnce(observed.promise)
  h.terminate.mockReturnValueOnce(cleanup.promise)
  await vi.advanceTimersByTimeAsync(0)
  let settled = false
  const disposed = h.owner.dispose().then(() => { settled = true })
  try {
    observed.resolve({ state: 'unknown', revision: 1 })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    cleanup.resolve(undefined)
    await disposed
    expect(settled).toBe(true)
  } finally { observed.resolve({ state: 'unknown', revision: 1 }); cleanup.resolve(undefined); await disposed }
})
