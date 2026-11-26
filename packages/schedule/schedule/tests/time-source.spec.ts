/** The internal timer drains one coalesced callback sequence. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MAX_TIMER_DELAY_MS, TimeSource } from '../src/time-source.ts'

const sources: TimeSource[] = []
const releases: Array<() => void> = []
const START = Date.parse('2026-09-16T00:00:00.000Z')

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START) })
afterEach(async () => {
  try {
    for (const release of releases.splice(0)) release()
    await Promise.all(sources.splice(0).map(source => source.dispose()))
  } finally {
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})

function setup(
  onTime: () => Promise<void>,
  reportFailure = vi.fn<(error: unknown) => void>(),
) {
  const source = new TimeSource(onTime, reportFailure)
  sources.push(source)
  return { source, reportFailure }
}

function gate() {
  const release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  return release
}

it('notifies the callback without passing a timestamp', async () => {
  const receive = vi.fn(async () => {})
  const { source } = setup(receive)
  source.request()
  await vi.advanceTimersByTimeAsync(0)
  expect(receive).toHaveBeenCalledExactlyOnceWith()
})

it('replaces or cancels its one armed timer and leaves no automatic recurrence', async () => {
  const receive = vi.fn(async () => {})
  const { source } = setup(receive)
  source.arm(START + 10)
  source.arm(START + 20)
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(10)
  expect(receive).not.toHaveBeenCalled()
  source.arm(undefined)
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(10)
  expect(receive).not.toHaveBeenCalled()
  source.arm(START + 5)
  await vi.advanceTimersByTimeAsync(1)
  expect(receive).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('signals each long-wait segment and lets its callback recompute the deadline after clock rollback', async () => {
  const deadline = START + MAX_TIMER_DELAY_MS + 2_000
  const received: number[] = []
  const { source } = setup(async () => {
    const now = Date.now()
    received.push(now)
    source.arm(now < deadline ? deadline : undefined)
  })
  source.arm(deadline)
  await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS)
  expect(received).toEqual([START + MAX_TIMER_DELAY_MS])
  expect(vi.getTimerCount()).toBe(1)
  vi.setSystemTime(START + MAX_TIMER_DELAY_MS - 1_000)
  await vi.advanceTimersByTimeAsync(2_000)
  expect(received).toEqual([START + MAX_TIMER_DELAY_MS, deadline - 1_000])
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(received).toEqual([START + MAX_TIMER_DELAY_MS, deadline - 1_000, deadline])
  expect(vi.getTimerCount()).toBe(0)
})

it('waits for accepted work before coalesced requests produce the next signal', async () => {
  const entered = Promise.withResolvers<undefined>()
  const release = gate()
  let calls = 0
  const { source } = setup(async () => {
    calls++
    if (calls === 1) { entered.resolve(undefined); await release.promise }
    source.arm(START + calls * 1_000)
  })
  source.request()
  await entered.promise
  source.request()
  source.request()
  await vi.advanceTimersByTimeAsync(0)
  expect(calls).toBe(1)
  release.resolve(undefined)
  await vi.advanceTimersByTimeAsync(0)
  expect(calls).toBe(2)
  expect(vi.getTimerCount()).toBe(1)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(calls).toBe(2)
  await vi.advanceTimersByTimeAsync(1_000)
  expect(calls).toBe(3)
})

it.each([false, true])('reports a callback failure directly without arming a retry (synchronous=%s)', async (synchronous) => {
  const failure = new Error('time callback failed')
  const receive = vi.fn(() => {
    if (synchronous) throw failure
    return Promise.reject(failure)
  })
  const { source, reportFailure } = setup(receive)
  source.arm(START + 1)
  await vi.advanceTimersByTimeAsync(1)
  expect(reportFailure).toHaveBeenCalledExactlyOnceWith(failure)
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(86_400_000)
  expect(receive).toHaveBeenCalledOnce()
  source.request()
  await vi.advanceTimersByTimeAsync(0)
  expect(receive).toHaveBeenCalledTimes(2)
})

it('retains an explicit request made while a failed callback is being reported', async () => {
  let calls = 0
  const reportFailure = vi.fn<(error: unknown) => void>(() => { source.request() })
  const { source } = setup(async () => { if (++calls === 1) throw new Error('first callback failed') }, reportFailure)
  source.request()
  await vi.advanceTimersByTimeAsync(0)
  expect(calls).toBe(2)
  expect(reportFailure).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('closes admission immediately and drains accepted work without delivering its queued request', async () => {
  const entered = Promise.withResolvers<undefined>()
  const release = gate()
  const receive = vi.fn(async () => { entered.resolve(undefined); await release.promise })
  const { source, reportFailure } = setup(receive)
  source.request()
  await entered.promise
  source.request()
  source.arm(START + 1_000)
  const closing = source.dispose()
  expect(source.dispose()).toBe(closing)
  expect(vi.getTimerCount()).toBe(0)
  let finished = false
  void closing.then(() => { finished = true })
  source.request()
  source.arm(START + 2_000)
  await vi.advanceTimersByTimeAsync(0)
  expect(finished).toBe(false)
  release.resolve(undefined)
  await closing
  expect(finished).toBe(true)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(receive).toHaveBeenCalledOnce()
  expect(reportFailure).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})

it('disposes an idle source and cancels its future timer', async () => {
  const receive = vi.fn(async () => {})
  const { source } = setup(receive)
  source.arm(START + MAX_TIMER_DELAY_MS)
  await source.dispose()
  await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS)
  expect(receive).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
