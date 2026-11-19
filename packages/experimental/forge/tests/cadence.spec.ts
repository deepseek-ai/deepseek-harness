/**
 * When polls run: which change requests one fetch reads together, how an unknown mergeability and an announced change
 * are paced, and when a refresh reads.
 */
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { changeRequestKey } from '../src/index.ts'
import type { ChangeRequestKey, ChangeRequestRef, ChangeRequestUpdate } from '../src/types.ts'
import { brief, BriefProvider, FakeProvider, forgeContext, provide, ref, snapshot } from './fake-provider.ts'

const config = { activeIntervalMs: 1_000, idleIntervalMs: 4_000, maxBackoffMs: 16_000, fetchTimeoutMs: 500 }
const START = 1_000_000
const key = changeRequestKey(ref(1))
const ignore = (): void => undefined

let ctx: Context | undefined

beforeEach(() => {
  vi.useFakeTimers({ now: START })
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  vi.useRealTimers()
})

async function setup(provider: FakeProvider, overrides: typeof config | Record<string, never> = config): Promise<Context> {
  ctx = await forgeContext(overrides)
  await provide(ctx, provider)
  return ctx
}

/** A provider that reads briefs, holding an open snapshot whose checks passed for each numbered change request. */
function briefProvider(...numbers: number[]): BriefProvider {
  const provider = new BriefProvider()
  for (const number of numbers) provider.results.set(changeRequestKey(ref(number)), snapshot(ref(number)))
  return provider
}

/** Make every read of `provider` at one level stay pending until released or until its signal aborts. */
function hold(provider: BriefProvider, level: 'brief' | 'snapshot'): () => void {
  const releases: (() => void)[] = []
  const pending = <T>(result: (target: ChangeRequestRef) => T) => (refs: readonly ChangeRequestRef[], signal: AbortSignal) =>
    new Promise<ReadonlyMap<ChangeRequestKey, T>>((resolve, reject) => {
      signal.addEventListener('abort', () => { reject(signal.reason as Error) })
      releases.push(() => { resolve(new Map(refs.map(target => [changeRequestKey(target), result(target)] as const))) })
    })
  if (level === 'brief') provider.briefImpl = pending(target => brief(snapshot(target)))
  else provider.fetchImpl = pending(target => snapshot(target))
  return () => {
    for (const release of releases.splice(0)) release()
  }
}

describe('forge poll cadence', () => {
  it('reads a change request past the midpoint of its wait with one that is due, so later polls share one fetch', async () => {
    const provider = briefProvider(1, 2)
    const context = await setup(provider)
    context.forge.watchBrief(ref(1), ignore)
    await vi.advanceTimersByTimeAsync(1_000)
    // The first change request, read 1 of its 4 seconds ago, is left out of the first poll of the second.
    context.forge.watchBrief(ref(2), ignore)
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.briefFetches).toEqual([[ref(1)], [ref(2)]])

    // No poll runs while both are only past their midpoints.
    await vi.advanceTimersByTimeAsync(2_999)
    expect(provider.briefFetches).toHaveLength(2)

    // The second one, read 3 of its 4 seconds ago, rides along with the first.
    await vi.advanceTimersByTimeAsync(1)
    expect(provider.briefFetches.slice(2)).toEqual([[ref(1), ref(2)]])

    await vi.advanceTimersByTimeAsync(8_000)
    expect(provider.briefFetches.slice(3)).toEqual([[ref(1), ref(2)], [ref(1), ref(2)]])
  })

  it('reads the change requests past their midpoints with the first poll of a new watch', async () => {
    const provider = briefProvider(1, 2)
    const context = await setup(provider)
    context.forge.watchBrief(ref(1), ignore)
    await vi.advanceTimersByTimeAsync(2_000)

    context.forge.watchBrief(ref(2), ignore)
    await vi.advanceTimersByTimeAsync(0)

    expect(provider.briefFetches).toEqual([[ref(1)], [ref(1), ref(2)]])
  })

  it('reads a failing change request only when its own backoff ends', async () => {
    const provider = briefProvider(1)
    const context = await setup(provider)
    context.forge.watchBrief(ref(1), ignore)
    context.forge.watchBrief(ref(2), ignore)

    // The second change request fails every read and waits 2, 4, and then 8 seconds; at 10 seconds it is past the
    // midpoint of the 8, and the poll of the first one leaves it out.
    await vi.advanceTimersByTimeAsync(14_000)

    expect(provider.briefFetches).toEqual([[ref(1), ref(2)], [ref(1), ref(2)], [ref(1), ref(2)], [ref(1)], [ref(1), ref(2)]])
  })

  it('takes along only change requests read at the same level', async () => {
    const provider = briefProvider(1, 2)
    const context = await setup(provider)
    context.forge.watch(ref(1), ignore)
    context.forge.watchBrief(ref(2), ignore)
    await vi.advanceTimersByTimeAsync(1_000)
    context.forge.refresh(ref(2))

    // At 4 seconds the brief of the second one is past its midpoint while only the snapshot of the first is due.
    await vi.advanceTimersByTimeAsync(3_000)
    expect(provider.fetches).toEqual([[ref(1)], [ref(1)]])
    expect(provider.briefFetches).toEqual([[ref(2)], [ref(2)]])

    await vi.advanceTimersByTimeAsync(1_000)
    expect(provider.briefFetches).toEqual([[ref(2)], [ref(2)], [ref(2)]])
  })

  it('polls once at the active interval after a status first reports an unknown mergeability, then at the idle interval', async () => {
    const provider = new FakeProvider()
    provider.results.set(key, snapshot(ref(1), { mergeability: 'unknown' }))
    const context = await setup(provider)
    context.forge.watch(ref(1), ignore)

    await vi.advanceTimersByTimeAsync(1_000)
    expect(provider.fetches).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(3_999)
    expect(provider.fetches).toHaveLength(2)
    provider.results.set(key, snapshot(ref(1)))
    await vi.advanceTimersByTimeAsync(1)
    expect(provider.fetches).toHaveLength(3)

    // Unknown again after a known value earns the active interval again.
    provider.results.set(key, snapshot(ref(1), { mergeability: 'unknown' }))
    await vi.advanceTimersByTimeAsync(4_000)
    expect(provider.fetches).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(provider.fetches).toHaveLength(5)
    await vi.advanceTimersByTimeAsync(3_999)
    expect(provider.fetches).toHaveLength(5)
  })

  it('counts an unknown mergeability that the watcher of a brief already knew', async () => {
    const provider = briefProvider()
    provider.results.set(key, snapshot(ref(1), { mergeability: 'unknown' }))
    const context = await setup(provider)
    context.forge.watchBrief(ref(1), ignore, { state: 'open', mergeability: 'unknown', checksRollup: 'success', fetchedAt: START - 1_000 })

    await vi.advanceTimersByTimeAsync(3_999)
    expect(provider.briefFetches).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(provider.briefFetches).toHaveLength(2)
  })

  it('leaves a change request alone when a refresh allows the age of its latest poll', async () => {
    const provider = briefProvider(1)
    const context = await setup(provider)
    context.forge.watchBrief(ref(1), ignore)
    await vi.advanceTimersByTimeAsync(500)

    context.forge.refresh(ref(1), { maxAgeMs: 500 })
    context.forge.refresh(ref(9), { maxAgeMs: 500 })
    await vi.advanceTimersByTimeAsync(1)
    expect(provider.briefFetches).toHaveLength(1)

    context.forge.refresh(ref(1), { maxAgeMs: 500 })
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.briefFetches).toHaveLength(2)
  })

  it('counts the read its watcher knew as the latest poll of a brief watch', async () => {
    const provider = briefProvider(1)
    const context = await setup(provider)
    context.forge.watchBrief(ref(1), ignore, { state: 'open', mergeability: 'mergeable', checksRollup: 'success', fetchedAt: START - 100 })

    context.forge.refresh(ref(1), { maxAgeMs: 500 })
    await vi.advanceTimersByTimeAsync(401)
    expect(provider.briefFetches).toHaveLength(0)

    context.forge.refresh(ref(1), { maxAgeMs: 500 })
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.briefFetches).toEqual([[ref(1)]])
  })

  it('follows a poll in flight with another one for a plain refresh only', async () => {
    const provider = briefProvider(1)
    const release = hold(provider, 'snapshot')
    const context = await setup(provider)
    context.forge.watch(ref(1), ignore)
    await vi.advanceTimersByTimeAsync(0)

    context.forge.refresh(ref(1), { maxAgeMs: 0 })
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.fetches).toHaveLength(1)

    context.forge.refresh(ref(1))
    await vi.advanceTimersByTimeAsync(0)
    context.forge.refresh(ref(1))
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.fetches).toHaveLength(3)
  })

  it('follows a poll in flight that started before the bound of a refresh with another one', async () => {
    const provider = briefProvider(1)
    const release = hold(provider, 'snapshot')
    const context = await setup(provider)
    context.forge.watch(ref(1), ignore)
    await vi.advanceTimersByTimeAsync(300)

    context.forge.refresh(ref(1), { maxAgeMs: 300 })
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.fetches).toHaveLength(1)

    context.forge.refresh(ref(1))
    await vi.advanceTimersByTimeAsync(200)
    context.forge.refresh(ref(1), { maxAgeMs: 199 })
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.fetches).toHaveLength(3)
  })

  it('leaves a merged change request alone for a refresh with a maximum age, and polls it for a plain one', async () => {
    const provider = new FakeProvider()
    provider.results.set(key, snapshot(ref(1), { state: 'merged' }))
    const context = await setup(provider)
    context.forge.watch(ref(1), ignore)
    await vi.advanceTimersByTimeAsync(10_000)

    context.forge.refresh(ref(1), { maxAgeMs: 0 })
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.fetches).toHaveLength(1)

    context.forge.refresh(ref(1))
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.fetches).toHaveLength(2)
  })

  it('polls an announced change at once and at the active interval for one idle interval, then at the regular cadence', async () => {
    const provider = briefProvider(1)
    const context = await setup(provider)
    context.forge.watchBrief(ref(1), ignore)
    await vi.advanceTimersByTimeAsync(500)

    context.forge.expectChange(ref(1))
    context.forge.expectChange(ref(9))
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.briefFetches).toEqual([[ref(1)], [ref(1)]])
    await vi.advanceTimersByTimeAsync(3_999)
    expect(provider.briefFetches).toHaveLength(5)
    // The poll one idle interval after the announcement ends it.
    await vi.advanceTimersByTimeAsync(1)
    expect(provider.briefFetches).toHaveLength(6)
    await vi.advanceTimersByTimeAsync(3_999)
    expect(provider.briefFetches).toHaveLength(6)
    await vi.advanceTimersByTimeAsync(1)
    expect(provider.briefFetches).toHaveLength(7)
  })

  it('ends an announced change once a status reports running checks', async () => {
    const provider = new FakeProvider()
    provider.results.set(key, snapshot(ref(1)))
    const context = await setup(provider)
    context.forge.watch(ref(1), ignore)
    await vi.advanceTimersByTimeAsync(0)

    provider.results.set(key, snapshot(ref(1), { checksRollup: 'pending' }))
    context.forge.expectChange(ref(1))
    await vi.advanceTimersByTimeAsync(0)
    provider.results.set(key, snapshot(ref(1)))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(provider.fetches).toHaveLength(3)

    // Checks that settled within the idle interval of the announcement are followed at the idle interval.
    await vi.advanceTimersByTimeAsync(3_999)
    expect(provider.fetches).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(provider.fetches).toHaveLength(4)
  })

  it.each([
    ['closed', 3],
    ['merged', 2],
  ] as const)('ends an announced change for a %s change request', async (state, fetches) => {
    const provider = new FakeProvider()
    provider.results.set(key, snapshot(ref(1), { state }))
    const context = await setup(provider)
    context.forge.watch(ref(1), ignore)
    await vi.advanceTimersByTimeAsync(0)

    context.forge.expectChange(ref(1))
    await vi.advanceTimersByTimeAsync(3_999)
    expect(provider.fetches).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(provider.fetches).toHaveLength(fetches)
  })

  it('lets a snapshot poll in flight answer a watcher that joins with a maximum age', async () => {
    const provider = briefProvider(1)
    const context = await setup(provider)
    context.forge.watch(ref(1), ignore)
    await vi.advanceTimersByTimeAsync(600)
    const release = hold(provider, 'snapshot')
    context.forge.refresh(ref(1))
    await vi.advanceTimersByTimeAsync(0)

    const updates: ChangeRequestUpdate[] = []
    context.forge.watch(ref(1), (update) => { updates.push(update) }, { maxAgeMs: 500 })
    release()
    await vi.advanceTimersByTimeAsync(0)

    expect(provider.fetches).toHaveLength(2)
    expect(updates).toEqual([{ key, fetchedAt: START + 600, snapshot: snapshot(ref(1)) }])
  })

  it('reads the snapshot for its first watcher while a brief poll is in flight', async () => {
    const provider = briefProvider(1)
    const release = hold(provider, 'brief')
    const context = await setup(provider)
    context.forge.watchBrief(ref(1), ignore)
    await vi.advanceTimersByTimeAsync(0)

    context.forge.watch(ref(1), ignore)
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.fetches).toEqual([[ref(1)]])

    // The brief read that ends later leaves the watch as the snapshot read timed it.
    release()
    await vi.advanceTimersByTimeAsync(3_999)
    expect(provider.fetches).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(provider.fetches).toHaveLength(2)
  })

  it('polls every 15 seconds while checks run and every 60 seconds once they settled, by default', async () => {
    const provider = new FakeProvider()
    provider.results.set(key, snapshot(ref(1), { checksRollup: 'pending' }))
    const context = await setup(provider, {})
    context.forge.watch(ref(1), ignore)

    await vi.advanceTimersByTimeAsync(14_999)
    expect(provider.fetches).toHaveLength(1)
    provider.results.set(key, snapshot(ref(1)))
    await vi.advanceTimersByTimeAsync(1)
    expect(provider.fetches).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(provider.fetches).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(provider.fetches).toHaveLength(3)
  })
})
