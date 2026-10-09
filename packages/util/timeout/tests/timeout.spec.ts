import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clampTimeout,
  deadline,
  idleWatchdog,
  MAX_TIMER_DELAY_MS,
  timeoutOf,
  TimeoutReason,
} from '@deepseek-ai/dsh-timeout'

describe('TimeoutReason', () => {
  it('is an Error carrying the code and elapsed ms', () => {
    const reason = new TimeoutReason('BASH_TIMEOUT', 100)
    expect(reason).toBeInstanceOf(Error)
    expect(reason.name).toBe('TimeoutReason')
    expect(reason.code).toBe('BASH_TIMEOUT')
    expect(reason.timeoutMs).toBe(100)
    expect(reason.message).toBe('BASH_TIMEOUT after 100ms')
  })
})

describe('clampTimeout', () => {
  it('fills the default when the hint is absent', () => {
    expect(clampTimeout(undefined, 120_000, 600_000)).toBe(120_000)
  })

  it('caps the hint at max', () => {
    expect(clampTimeout(999_999, 120_000, 600_000)).toBe(600_000)
  })

  it('keeps a valid hint under the cap', () => {
    expect(clampTimeout(5_000, 120_000, 600_000)).toBe(5_000)
  })

  it('caps the default itself when the default exceeds max', () => {
    // min(def, max) applies even with no hint — a misconfigured backend never
    // exceeds its own cap.
    expect(clampTimeout(undefined, 900_000, 600_000)).toBe(600_000)
  })

  it('rejects a non-finite hint with the caller-provided name', () => {
    expect(() => clampTimeout(Number.NaN, 100, 200, 'bash-local: request.timeoutMs'))
      .toThrow(/bash-local: request\.timeoutMs must be a positive finite number/)
    expect(() => clampTimeout(Number.POSITIVE_INFINITY, 100, 200))
      .toThrow(/timeoutMs must be a positive finite number/)
  })

  it('rejects a non-positive hint', () => {
    expect(() => clampTimeout(0, 100, 200)).toThrow(/must be a positive finite number/)
    expect(() => clampTimeout(-1, 100, 200)).toThrow(/must be a positive finite number/)
  })
})

describe('deadline — timeout arm', () => {
  afterEach(() => { vi.useRealTimers() })

  it('aborts on timeout with a TimeoutReason after the elapsed ms', () => {
    vi.useFakeTimers()
    using d = deadline(undefined, 100, 'BASH_TIMEOUT')
    expect(d.signal.aborted).toBe(false)
    vi.advanceTimersByTime(100)
    expect(d.signal.aborted).toBe(true)
    const reason = timeoutOf(d.signal)
    expect(reason).toBeInstanceOf(TimeoutReason)
    expect(reason?.code).toBe('BASH_TIMEOUT')
    expect(reason?.timeoutMs).toBe(100)
  })

  it('[Symbol.dispose] clears the timer so no abort fires afterward', () => {
    vi.useFakeTimers()
    const d = deadline(undefined, 100, 'BASH_TIMEOUT')
    d[Symbol.dispose]()
    vi.advanceTimersByTime(1_000)
    expect(d.signal.aborted).toBe(false)
    expect(timeoutOf(d.signal)).toBeUndefined()
  })

  it('rejects delays that Node would clamp to one millisecond', () => {
    expect(() => deadline(undefined, MAX_TIMER_DELAY_MS + 1, 'BASH_TIMEOUT'))
      .toThrow(`no greater than ${MAX_TIMER_DELAY_MS}`)
    expect(() => deadline(undefined, Number.POSITIVE_INFINITY, 'BASH_TIMEOUT'))
      .toThrow(`no greater than ${MAX_TIMER_DELAY_MS}`)
  })
})

describe('deadline — fuse with upstream', () => {
  it('aborts on upstream cancellation, classified as NOT a timeout', () => {
    const upstream = new AbortController()
    using d = deadline(upstream.signal, 60_000, 'BASH_TIMEOUT')
    upstream.abort('user cancelled')
    expect(d.signal.aborted).toBe(true)
    expect(timeoutOf(d.signal)).toBeUndefined()
  })

  it('cancel wins when it fires before the timeout', () => {
    vi.useFakeTimers()
    try {
      const upstream = new AbortController()
      using d = deadline(upstream.signal, 100, 'BASH_TIMEOUT')
      upstream.abort('user cancelled') // fires first, before the 100ms timer
      vi.advanceTimersByTime(200)
      expect(d.signal.aborted).toBe(true)
      // AbortSignal.any adopts the FIRST source's reason: cancel won, so no
      // TimeoutReason even though the timer later elapsed.
      expect(timeoutOf(d.signal)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('timeout wins when it fires before upstream cancellation', () => {
    vi.useFakeTimers()
    try {
      const upstream = new AbortController()
      using d = deadline(upstream.signal, 100, 'WEB_FETCH_TIMEOUT')
      vi.advanceTimersByTime(150) // past the 100ms deadline: the timer fires first
      expect(d.signal.aborted).toBe(true)
      expect(timeoutOf(d.signal)?.code).toBe('WEB_FETCH_TIMEOUT')
      // A later upstream abort is a no-op on the already-aborted fused signal:
      // AbortSignal.any keeps the FIRST cause, so the timeout classification stands.
      upstream.abort('too late')
      expect(timeoutOf(d.signal)?.code).toBe('WEB_FETCH_TIMEOUT')
    } finally {
      vi.useRealTimers()
    }
  })

  it('forwards a pre-aborted upstream signal immediately', () => {
    const upstream = new AbortController()
    upstream.abort('already gone')
    using d = deadline(upstream.signal, 60_000, 'BASH_TIMEOUT')
    expect(d.signal.aborted).toBe(true)
    expect(timeoutOf(d.signal)).toBeUndefined()
  })
})

describe('deadline — timeoutMs <= 0 (no-timeout sentinel)', () => {
  afterEach(() => { vi.useRealTimers() })

  it('arms no timer and forwards only the upstream signal', () => {
    vi.useFakeTimers()
    const upstream = new AbortController()
    using d = deadline(upstream.signal, 0, 'BASH_TIMEOUT')
    vi.advanceTimersByTime(1_000_000)
    expect(d.signal.aborted).toBe(false) // no timer ever armed
    upstream.abort('kill')
    expect(d.signal.aborted).toBe(true)
    expect(timeoutOf(d.signal)).toBeUndefined() // never a timeout
  })

  it('returns a never-aborting signal with a no-op disposer when there is no upstream', () => {
    vi.useFakeTimers()
    const d = deadline(undefined, 0, 'BASH_TIMEOUT')
    expect(() => { d[Symbol.dispose]() }).not.toThrow()
    vi.advanceTimersByTime(1_000_000)
    expect(d.signal.aborted).toBe(false)
    expect(timeoutOf(d.signal)).toBeUndefined()
  })

  it('treats a negative timeout the same as zero', () => {
    const d = deadline(undefined, -5, 'BASH_TIMEOUT')
    expect(d.signal.aborted).toBe(false)
    d[Symbol.dispose]()
  })
})

describe('timeoutOf', () => {
  it('classifies a bare reason carrier that holds a TimeoutReason', () => {
    const reason = new TimeoutReason('WEB_FETCH_TIMEOUT', 50)
    expect(timeoutOf({ reason })).toBe(reason)
  })

  it('returns undefined for a non-timeout reason', () => {
    expect(timeoutOf({ reason: new Error('other') })).toBeUndefined()
    expect(timeoutOf({ reason: 'user cancelled' })).toBeUndefined()
    expect(timeoutOf({})).toBeUndefined()
  })

  it('matches only the requested code when one is given', () => {
    const reason = new TimeoutReason('BASH_TIMEOUT', 100)
    expect(timeoutOf({ reason }, 'BASH_TIMEOUT')).toBe(reason)
    expect(timeoutOf({ reason }, 'WEB_FETCH_TIMEOUT')).toBeUndefined()
  })
})

describe('deadline — nested deadlines', () => {
  it("does not misclassify an outer deadline's timeout as the inner code", () => {
    // The upstream handed to the inner deadline is ITSELF a deadline that has already timed out
    // (outer). `AbortSignal.any` preserves that reason, but scoping `timeoutOf` to the inner code
    // must classify it as upstream cancellation rather than the inner capability's timeout.
    const outer = new AbortController()
    outer.abort(new TimeoutReason('OUTER_TIMEOUT', 30))
    using inner = deadline(outer.signal, 60_000, 'BASH_TIMEOUT')
    expect(inner.signal.aborted).toBe(true)
    expect(timeoutOf(inner.signal, 'BASH_TIMEOUT')).toBeUndefined() // not ours → upstream-cancel path
    expect(timeoutOf(inner.signal)?.code).toBe('OUTER_TIMEOUT') // but IS a timeout, unscoped
  })
})

describe('idleWatchdog', () => {
  afterEach(() => { vi.useRealTimers() })

  it('arms only while next is outstanding and rearms the same signal for later demand', async () => {
    vi.useFakeTimers()
    const first = Promise.withResolvers<IteratorResult<number>>()
    const second = Promise.withResolvers<IteratorResult<number>>()
    const iterator: AsyncIterator<number> = {
      next: vi.fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => second.promise),
    }
    using watchdog = idleWatchdog(undefined, 100, 'LLM_STREAM_IDLE_TIMEOUT')
    const stableSignal = watchdog.signal

    const firstNext = watchdog.next(iterator)
    await vi.advanceTimersByTimeAsync(99)
    expect(stableSignal.aborted).toBe(false)
    first.resolve({ done: false, value: 1 })
    await expect(firstNext).resolves.toEqual({ done: false, value: 1 })

    await vi.advanceTimersByTimeAsync(10_000)
    expect(stableSignal.aborted).toBe(false)
    expect(watchdog.signal).toBe(stableSignal)

    const secondNext = watchdog.next(iterator)
    // Observe before advancing: the deadline rejects an iterator that never settles.
    const secondOutcome = secondNext.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    expect(timeoutOf(stableSignal, 'LLM_STREAM_IDLE_TIMEOUT')).toMatchObject({ timeoutMs: 100 })
    second.reject(stableSignal.reason)
    expect(await secondOutcome).toBe(stableSignal.reason)
  })

  it('rearms outstanding demand on an out-of-band activity pulse', async () => {
    vi.useFakeTimers()
    const pending = Promise.withResolvers<IteratorResult<number>>()
    const watchdog = idleWatchdog(undefined, 100, 'LLM_STREAM_IDLE_TIMEOUT')
    watchdog.pulse()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(watchdog.signal.aborted).toBe(false)

    const next = watchdog.next({ next: () => pending.promise })
    const outcome = next.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(99)
    watchdog.pulse()
    await vi.advanceTimersByTimeAsync(99)
    expect(watchdog.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')).toMatchObject({ timeoutMs: 100 })
    pending.reject(watchdog.signal.reason)
    expect(await outcome).toBe(watchdog.signal.reason)

    watchdog[Symbol.dispose]()
    watchdog.pulse()
  })

  it('keeps an earlier upstream abort distinct from its own timeout', async () => {
    vi.useFakeTimers()
    const upstream = new AbortController()
    using watchdog = idleWatchdog(upstream.signal, 100, 'LLM_STREAM_IDLE_TIMEOUT')
    upstream.abort('caller cancelled')
    expect(watchdog.signal.aborted).toBe(true)
    expect(timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(watchdog.signal.reason).toBe('caller cancelled')
  })

  it('clears an outstanding arm on disposal', async () => {
    vi.useFakeTimers()
    const pending = Promise.withResolvers<IteratorResult<number>>()
    const watchdog = idleWatchdog(undefined, 100, 'LLM_STREAM_IDLE_TIMEOUT')
    void watchdog.next({ next: () => pending.promise })
    watchdog[Symbol.dispose]()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(watchdog.signal.aborted).toBe(false)
    pending.resolve({ done: true, value: undefined })
    await expect(watchdog.next({ next: () => Promise.resolve({ done: true, value: undefined }) }))
      .rejects.toThrow(/disposed/)
    watchdog[Symbol.dispose]()
  })

  it('rejects an outstanding demand the iterator never settles', async () => {
    vi.useFakeTimers()
    using watchdog = idleWatchdog(undefined, 100, 'LLM_STREAM_IDLE_TIMEOUT')
    // A transport can leave an aborted read pending forever; the deadline, not the
    // iterator, decides when this demand ends.
    const next = watchdog.next({ next: () => new Promise<IteratorResult<number>>(() => {}) })
    const outcome = next.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(100)
    expect(await outcome).toBe(watchdog.signal.reason)
    expect(timeoutOf(watchdog.signal, 'LLM_STREAM_IDLE_TIMEOUT')).toMatchObject({ timeoutMs: 100 })
  })

  it('rejects invalid bounds and concurrent iterator demand', async () => {
    expect(() => idleWatchdog(undefined, 0, 'IDLE')).toThrow(/positive finite/)
    expect(() => idleWatchdog(undefined, Number.NaN, 'IDLE')).toThrow(/positive finite/)
    expect(() => idleWatchdog(undefined, MAX_TIMER_DELAY_MS + 1, 'IDLE'))
      .toThrow(`no greater than ${MAX_TIMER_DELAY_MS}`)
    const pending = Promise.withResolvers<IteratorResult<number>>()
    using watchdog = idleWatchdog(undefined, 100, 'IDLE')
    const iterator = { next: () => pending.promise }
    void watchdog.next(iterator)
    await expect(watchdog.next(iterator)).rejects.toThrow(/already outstanding/)
    pending.resolve({ done: true, value: undefined })
  })
})
