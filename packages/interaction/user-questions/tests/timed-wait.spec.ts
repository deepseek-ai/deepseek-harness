import { afterEach, describe, expect, it, vi } from 'vitest'
import { TimedQuestionWait } from '../src/timed-wait.ts'

const waits: TimedQuestionWait[] = []
afterEach(() => {
  for (const wait of waits.splice(0)) wait.close(new Error('test ended'))
  vi.useRealTimers()
})

function start(parent?: AbortSignal) {
  vi.useFakeTimers()
  const timeout = new Error('question timed out')
  const wait = new TimedQuestionWait(Date.now() + 5_000, parent, timeout)
  waits.push(wait)
  return { wait, timeout }
}

describe('foreground question claims', () => {
  it('expires with no answer UI and releases its timer', async () => {
    const { wait, timeout } = start()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(wait.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await wait.done
    expect(wait.signal.reason).toBe(timeout)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a claimed wait open beyond the Host deadline and expires after the last claim leaves', async () => {
    const { wait, timeout } = start()
    const first = new AbortController()
    const second = new AbortController()
    const a = wait.attach(first.signal)[Symbol.asyncIterator]()
    const b = wait.attach(second.signal)[Symbol.asyncIterator]()
    expect(await a.next()).toEqual({ done: false, value: { remainingMs: 5_000 } })
    const aEnd = a.next()
    await b.next()
    const bEnd = b.next()
    await vi.advanceTimersByTimeAsync(10_000)
    first.abort()
    await aEnd
    expect(wait.signal.aborted).toBe(false)
    second.abort()
    await bEnd
    await vi.advanceTimersByTimeAsync(0)
    expect(wait.signal.reason).toBe(timeout)
  })

  it('resumes the original remaining duration after a claim disconnects', async () => {
    const { wait } = start()
    const client = new AbortController()
    const stream = wait.attach(client.signal)[Symbol.asyncIterator]()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await stream.next()).toEqual({ done: false, value: { remainingMs: 4_000 } })
    const end = stream.next()
    await vi.advanceTimersByTimeAsync(2_000)
    client.abort()
    await end
    await vi.advanceTimersByTimeAsync(1_999)
    expect(wait.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(wait.signal.aborted).toBe(true)
  })

  it('releases a claim when its consumer returns', async () => {
    const { wait } = start()
    const stream = wait.attach(new AbortController().signal)[Symbol.asyncIterator]()
    await stream.next()
    await stream.return?.()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(wait.signal.aborted).toBe(true)
  })

  it('ends claim streams with the parent cancellation without expiring the parent itself', async () => {
    const parent = new AbortController()
    const { wait } = start(parent.signal)
    const stream = wait.attach(new AbortController().signal)[Symbol.asyncIterator]()
    await stream.next()
    const end = stream.next()
    const reason = new Error('turn ended')
    parent.abort(reason)
    expect(await end).toEqual({ done: true, value: undefined })
    expect(wait.signal.reason).toBe(reason)
    expect(vi.getTimerCount()).toBe(0)

    const otherParent = new AbortController()
    const other = start(otherParent.signal).wait
    await vi.advanceTimersByTimeAsync(5_000)
    expect(other.signal.aborted).toBe(true)
    expect(otherParent.signal.aborted).toBe(false)
  })

  it('does not claim a cancelled or expired wait', async () => {
    const parent = new AbortController()
    parent.abort(new Error('already ended'))
    const { wait } = start(parent.signal)
    expect(await wait.attach(new AbortController().signal)[Symbol.asyncIterator]().next()).toMatchObject({ done: true })
    expect(vi.getTimerCount()).toBe(0)

    const live = start().wait
    const cancelled = new AbortController()
    cancelled.abort()
    expect(await live.attach(cancelled.signal)[Symbol.asyncIterator]().next()).toMatchObject({ done: true })
    vi.setSystemTime(Date.now() + 6_000)
    expect(await live.attach(new AbortController().signal)[Symbol.asyncIterator]().next()).toMatchObject({ done: true })
    expect(live.signal.aborted).toBe(true)
  })
})
