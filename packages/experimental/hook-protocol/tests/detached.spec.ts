import { describe, expect, it } from 'vitest'
import { createDetachedRuns } from '@deepseek-ai/dsh-hook-protocol'

/** A promise settled from outside, so a test controls exactly when a tracked run finishes. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('createDetachedRuns', () => {
  it('starts with an unfired signal; drain fires it (so still-running hook processes get killed)', async () => {
    const detached = createDetachedRuns()
    expect(detached.signal.aborted).toBe(false)
    await detached.drain()
    expect(detached.signal.aborted).toBe(true)
    expect(String(detached.signal.reason)).toContain('hook bridge disposed')
  })

  it('drain with nothing tracked resolves immediately', async () => {
    await expect(createDetachedRuns().drain()).resolves.toBeUndefined()
  })

  it('drain waits for a tracked run to settle', async () => {
    const detached = createDetachedRuns()
    const run = deferred()
    detached.track(run.promise)
    let drained = false
    const draining = detached.drain().then(() => { drained = true })
    // Give the drain every chance to (wrongly) resolve before the run settles.
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(drained).toBe(false)
    run.resolve()
    await draining
    expect(drained).toBe(true)
  })

  it('drain waits for a run tracked WHILE a prior wave was settling', async () => {
    const detached = createDetachedRuns()
    const first = deferred()
    const second = deferred()
    detached.track(first.promise)
    // The late run enters the registry from the first run's own continuation —
    // after drain() snapshotted its first wave.
    void first.promise.then(() => { detached.track(second.promise) })
    let drained = false
    const draining = detached.drain().then(() => { drained = true })
    first.resolve()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(drained).toBe(false)
    second.resolve()
    await draining
    expect(drained).toBe(true)
  })

  it('a rejected tracked run is absorbed by the settlement bookkeeping (drain still resolves)', async () => {
    const detached = createDetachedRuns()
    const run = deferred()
    detached.track(run.promise)
    // The caller-side handler every bridge attaches; the tracker's own
    // bookkeeping must not depend on it, but an UNHANDLED rejection would fail
    // the test run, which is exactly the guarantee under test.
    run.promise.catch(() => {})
    run.reject(new Error('hook run boom'))
    await expect(detached.drain()).resolves.toBeUndefined()
  })
})
