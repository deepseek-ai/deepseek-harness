import { afterEach, beforeEach, expect, expectTypeOf, it, vi } from 'vitest'
import { SourceInput } from '../src/source-protocol.ts'
import { MAX_TIMER_DELAY_MS, TimeSource } from '../src/time-source.ts'

const sources: TimeSource[] = []
const inputs: SourceInput<number>[] = []
const releases: Array<() => void> = []
const START = Date.parse('2026-09-16T00:00:00.000Z')

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(START) })
afterEach(async () => {
  try {
    for (const release of releases.splice(0)) release()
    await Promise.all(sources.splice(0).map(source => source.dispose()))
    await Promise.all(inputs.splice(0).map(input => input.dispose()))
  } finally {
    vi.restoreAllMocks()
    vi.useRealTimers()
  }
})

function setup(reportFailure = vi.fn<(error: unknown) => void>()) {
  const source = new TimeSource(reportFailure)
  sources.push(source)
  return { source, reportFailure }
}

function connect(source: TimeSource, receive: (value: number) => Promise<void>) {
  const input = new SourceInput(receive)
  inputs.push(input)
  return input.connect(source.output)
}

function gate() {
  const release = Promise.withResolvers<undefined>()
  releases.push(() => { release.resolve(undefined) })
  return release
}

it('broadcasts the current wall time through shared input connections and leaves detached receivers untouched', async () => {
  const { source, reportFailure } = setup()
  source.request()
  await vi.advanceTimersByTimeAsync(0)
  const first = vi.fn(async (value: number) => { expectTypeOf(value).toEqualTypeOf<number>() })
  const second = vi.fn(async (_value: number) => {})
  const connection = connect(source, first)
  connect(source, second)
  vi.setSystemTime(START + 100)
  source.request()
  await vi.advanceTimersByTimeAsync(0)
  expect(first).toHaveBeenCalledExactlyOnceWith(START + 100)
  expect(second).toHaveBeenCalledExactlyOnceWith(START + 100)
  await connection.dispose()
  source.request()
  await vi.advanceTimersByTimeAsync(0)
  expect(first).toHaveBeenCalledOnce()
  expect(second).toHaveBeenCalledTimes(2)
  expect(reportFailure).not.toHaveBeenCalled()
})

it('replaces or cancels its one armed timer and leaves no automatic recurrence', async () => {
  const { source } = setup()
  const receive = vi.fn(async (_value: number) => {})
  connect(source, receive)
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

it('emits at each long-wait segment and lets its receiver recompute the deadline after clock rollback', async () => {
  const { source } = setup()
  const deadline = START + MAX_TIMER_DELAY_MS + 2_000
  const received: number[] = []
  connect(source, async (now) => {
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

it('waits for accepted input before coalesced requests produce the next signal', async () => {
  const { source } = setup()
  const entered = Promise.withResolvers<undefined>()
  const release = gate()
  let calls = 0
  connect(source, async () => {
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

it('reports a failed receiver with its cause without arming a retry', async () => {
  const { source, reportFailure } = setup()
  const failure = new Error('time input failed')
  const receive = vi.fn(async () => { throw failure })
  connect(source, receive)
  source.arm(START + 1)
  await vi.advanceTimersByTimeAsync(1)
  expect(reportFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
    code: 'SOURCE_DELIVERY_FAILED', cause: expect.objectContaining({ errors: [failure] }),
  }))
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(86_400_000)
  expect(receive).toHaveBeenCalledOnce()
})

it('retains an explicit request made while the failed broadcast is being reported', async () => {
  const reportFailure = vi.fn(() => { source.request() })
  const { source } = setup(reportFailure)
  let calls = 0
  connect(source, async () => { if (++calls === 1) throw new Error('first input failed') })
  source.request()
  await vi.advanceTimersByTimeAsync(0)
  expect(calls).toBe(2)
  expect(reportFailure).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
})

it('closes admission immediately and drains accepted input without emitting its queued request', async () => {
  const { source, reportFailure } = setup()
  const entered = Promise.withResolvers<undefined>()
  const release = gate()
  const receive = vi.fn(async () => { entered.resolve(undefined); await release.promise })
  const connection = connect(source, receive)
  source.request()
  await entered.promise
  source.request()
  source.arm(START + 1_000)
  const closing = source.dispose()
  expect(source.dispose()).toBe(closing)
  expect(vi.getTimerCount()).toBe(0)
  await expect(connection.send(START)).rejects.toMatchObject({ code: 'SOURCE_CONNECTION_CLOSED' })
  await expect(source.output.emit(START)).rejects.toMatchObject({ code: 'SOURCE_CLOSED' })
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
  const { source } = setup()
  const receive = vi.fn(async (_value: number) => {})
  connect(source, receive)
  source.arm(START + MAX_TIMER_DELAY_MS)
  await source.dispose()
  await vi.advanceTimersByTimeAsync(MAX_TIMER_DELAY_MS)
  expect(receive).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
