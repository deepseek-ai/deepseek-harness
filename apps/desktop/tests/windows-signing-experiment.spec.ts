import { expect, it, vi } from 'vitest'
import { runSigningExperimentBatch } from './helpers/windows-signing-experiment.ts'

function barrier() {
  const pending = Promise.withResolvers<undefined>()
  return { promise: pending.promise, resolve: () => { pending.resolve(undefined) } }
}
const observe = (operation: Promise<void>) => operation.then(
  () => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }),
)

it('drains four issued hardware calls after failure without dispatching a fifth', async () => {
  const allStarted = barrier()
  const release = barrier()
  const failed = barrier()
  const started: number[] = []
  const finished: number[] = []
  const outcome = observe(runSigningExperimentBatch([1, 2, 3, 4, 5, 6], {
    jobs: 4, hardwareConcurrency: 4,
    sign: async (item) => {
      started.push(item)
      if (started.length === 4) allStarted.resolve()
      await allStarted.promise
      if (item === 1) { failed.resolve(); throw new Error('hardware failure') }
      await release.promise
      finished.push(item)
    },
    complete: async (item, sign) => { await sign(`staged-${item}`) },
  }))
  let settled = false
  void outcome.then(() => { settled = true })
  try {
    await failed.promise
    expect(started).toEqual([1, 2, 3, 4])
    expect(settled).toBe(false)
  } finally { release.resolve() }
  expect(await outcome).toEqual({ ok: false, error: new Error('hardware failure') })
  expect(finished.sort()).toEqual([2, 3, 4])
  expect(started).toEqual([1, 2, 3, 4])
})

it('finishes each item before beginning the next in serial mode', async () => {
  const events: string[] = []
  await runSigningExperimentBatch([1, 2], {
    jobs: 1, hardwareConcurrency: 1,
    sign: async (item, path) => { expect(path).toBe(`staged-${item}`); events.push(`sign ${item}`) },
    complete: async (item, sign) => {
      events.push(`start ${item}`)
      await sign(`staged-${item}`)
      events.push(`complete ${item}`)
    },
  })
  expect(events).toEqual(['start 1', 'sign 1', 'complete 1', 'start 2', 'sign 2', 'complete 2'])
})

it('overlaps completion with the next signature while keeping hardware concurrency at one', async () => {
  const firstSigning = barrier()
  const releaseFirstSignature = barrier()
  const secondStarted = barrier()
  const firstPost = barrier()
  const secondSigned = barrier()
  const releaseCompletion = barrier()
  const started: number[] = []
  let active = 0
  let peak = 0
  const outcome = observe(runSigningExperimentBatch([1, 2, 3], {
    jobs: 2, hardwareConcurrency: 1,
    sign: async (item) => {
      active++
      peak = Math.max(peak, active)
      try {
        if (item === 1) { firstSigning.resolve(); await releaseFirstSignature.promise }
        if (item === 2) secondSigned.resolve()
      } finally { active-- }
    },
    complete: async (item, sign) => {
      started.push(item)
      if (item === 2) secondStarted.resolve()
      await sign(`staged-${item}`)
      if (item === 1) firstPost.resolve()
      await releaseCompletion.promise
    },
  }))
  try {
    await Promise.all([firstSigning.promise, secondStarted.promise])
    expect(active).toBe(1)
    releaseFirstSignature.resolve()
    await Promise.all([firstPost.promise, secondSigned.promise])
    expect(started).toEqual([1, 2])
    expect(peak).toBe(1)
  } finally {
    releaseFirstSignature.resolve()
    releaseCompletion.resolve()
    expect(await outcome).toEqual({ ok: true })
  }
  expect(started).toEqual([1, 2, 3])
})

it.each([2, 4] as const)('allows %i hardware requests but keeps later items queued until a job completes', async (limit) => {
  const bothSigning = barrier()
  const release = barrier()
  const started: number[] = []
  let active = 0
  let peak = 0
  const outcome = observe(runSigningExperimentBatch(Array.from({ length: limit + 1 }, (_, index) => index + 1), {
    jobs: limit, hardwareConcurrency: limit,
    sign: async () => {
      active++
      peak = Math.max(peak, active)
      if (active === limit) bothSigning.resolve()
      try { await release.promise } finally { active-- }
    },
    complete: async (item, sign) => { started.push(item); await sign(`staged-${item}`) },
  }))
  try {
    await bothSigning.promise
    expect(started).toEqual(Array.from({ length: limit }, (_, index) => index + 1))
    expect(active).toBe(limit)
  } finally { release.resolve(); expect(await outcome).toEqual({ ok: true }) }
  expect(peak).toBe(limit)
  expect(active).toBe(0)
})

it.each([new Error('hardware failed'), undefined])('stops queued signatures and new items after a hardware rejection (%s)', async (failure) => {
  const secondStarted = barrier()
  const sign = vi.fn(async () => { await secondStarted.promise; throw failure })
  const started: number[] = []
  const result = await observe(runSigningExperimentBatch([1, 2, 3], {
    jobs: 2, hardwareConcurrency: 1, sign,
    complete: async (item, request) => {
      started.push(item)
      if (item === 2) secondStarted.resolve()
      await request(`staged-${item}`)
    },
  }))
  expect(result).toEqual({ ok: false, error: failure })
  expect(sign).toHaveBeenCalledTimes(1)
  expect(started).toEqual([1, 2])
})

it('drains concurrent hardware after the first failure and retains that failure', async () => {
  const secondSigning = barrier()
  const firstFailed = barrier()
  const releaseSecond = barrier()
  const failure = new Error('first hardware failure')
  const calls: number[] = []
  let active = 0
  let settled = false
  const outcome = observe(runSigningExperimentBatch([1, 2, 3], {
    jobs: 2, hardwareConcurrency: 2,
    sign: async (item) => {
      calls.push(item)
      active++
      try {
        if (item === 1) { await secondSigning.promise; throw failure }
        secondSigning.resolve()
        await releaseSecond.promise
        throw new Error('later hardware failure')
      } finally { active-- }
    },
    complete: async (item, sign) => {
      try { await sign(`staged-${item}`) }
      catch (error) { if (item === 1) firstFailed.resolve(); throw error }
    },
  })).then((result) => { settled = true; return result })
  try {
    await firstFailed.promise
    expect(settled).toBe(false)
    expect(active).toBe(1)
    expect(calls).toEqual([1, 2])
  } finally { releaseSecond.resolve(); expect(await outcome).toEqual({ ok: false, error: failure }) }
  expect(active).toBe(0)
  expect(calls).toEqual([1, 2])
})

it('preserves an undefined completion failure and starts no further work', async () => {
  const sign = vi.fn(async () => {})
  const complete = vi.fn(async () => { throw undefined })
  expect(await observe(runSigningExperimentBatch([1, 2], {
    jobs: 1, hardwareConcurrency: 1, complete, sign,
  }))).toEqual({ ok: false, error: undefined })
  expect(complete).toHaveBeenCalledTimes(1)
  expect(sign).not.toHaveBeenCalled()
})

it('prevents a waiting signature when completion fails and drains the issued hardware request', async () => {
  const secondSigning = barrier()
  const releaseSecond = barrier()
  const failureObserved = barrier()
  const failure = new Error('timestamp failed')
  const calls: number[] = []
  let pending: ReturnType<typeof observe> | undefined
  let settled = false
  const outcome = observe(runSigningExperimentBatch([1, 2, 3], {
    jobs: 2, hardwareConcurrency: 1,
    sign: async (item) => {
      calls.push(item)
      if (item === 2) { secondSigning.resolve(); await releaseSecond.promise }
    },
    complete: async (item, sign) => {
      await sign(`staged-${item}`)
      if (item === 1) {
        await secondSigning.promise
        // Failure can interrupt a completion that already owns a queued request.
        const waiting = observe(sign(`staged-retry-${item}`)).then((result) => { failureObserved.resolve(); return result })
        pending = waiting
        throw failure
      }
    },
  })).then((result) => { settled = true; return result })
  try {
    await failureObserved.promise
    expect(settled).toBe(false)
    expect(calls).toEqual([1, 2])
  } finally { releaseSecond.resolve(); expect(await outcome).toEqual({ ok: false, error: failure }) }
  expect(calls).toEqual([1, 2])
  expect(await pending).toEqual({ ok: false, error: failure })
})

it('drains both completion workers after one fails without starting more items', async () => {
  const secondPost = barrier()
  const releaseSecondPost = barrier()
  const failed = barrier()
  const failure = new Error('verification failed')
  const started: number[] = []
  let settled = false
  const outcome = observe(runSigningExperimentBatch([1, 2, 3], {
    jobs: 2, hardwareConcurrency: 2, sign: async () => {},
    complete: async (item, sign) => {
      started.push(item)
      await sign(`staged-${item}`)
      if (item === 1) { await secondPost.promise; failed.resolve(); throw failure }
      secondPost.resolve()
      await releaseSecondPost.promise
    },
  })).then((result) => { settled = true; return result })
  try {
    await failed.promise
    expect(settled).toBe(false)
    expect(started).toEqual([1, 2])
  } finally { releaseSecondPost.resolve(); expect(await outcome).toEqual({ ok: false, error: failure }) }
  expect(started).toEqual([1, 2])
})

it('cancels waiting signatures and new items while waiting for issued hardware to finish', async () => {
  const controller = new AbortController()
  const secondStarted = barrier()
  const release = barrier()
  const waitingRejected = barrier()
  const reason = new Error('operator cancelled')
  const calls: number[] = []
  let active = false
  let settled = false
  const outcome = observe(runSigningExperimentBatch([1, 2, 3], {
    jobs: 2, hardwareConcurrency: 1, signal: controller.signal,
    sign: async (item) => {
      calls.push(item)
      active = true
      try { await release.promise } finally { active = false }
    },
    complete: async (item, sign) => {
      if (item === 2) secondStarted.resolve()
      try { await sign(`staged-${item}`) }
      catch (error) { if (item === 2) waitingRejected.resolve(); throw error }
    },
  })).then((result) => { settled = true; return result })
  try {
    await secondStarted.promise
    controller.abort(reason)
    await waitingRejected.promise
    expect(active).toBe(true)
    expect(settled).toBe(false)
    expect(calls).toEqual([1])
  } finally { release.resolve(); expect(await outcome).toEqual({ ok: false, error: reason }) }
  expect(active).toBe(false)
  expect(calls).toEqual([1])
})

it('does not begin work when cancellation was already requested', async () => {
  const reason = new Error('already cancelled')
  const complete = vi.fn(async () => {})
  const sign = vi.fn(async () => {})
  expect(await observe(runSigningExperimentBatch([1], {
    jobs: 2, hardwareConcurrency: 2, signal: AbortSignal.abort(reason), complete, sign,
  }))).toEqual({ ok: false, error: reason })
  expect(complete).not.toHaveBeenCalled()
  expect(sign).not.toHaveBeenCalled()
})
