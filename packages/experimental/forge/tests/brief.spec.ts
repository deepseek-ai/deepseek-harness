/** Brief watches: what a poll reads for them, when it runs, and what each kind of watcher receives. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { changeRequestKey } from '../src/index.ts'
import type {
  ChangeRequestBriefUpdate, ChangeRequestKey, ChangeRequestKnownState, ChangeRequestRef, ChangeRequestUpdate, ChangeRequestWatchOptions,
  ForgeFailure,
} from '../src/types.ts'
import { brief, BriefProvider, FakeProvider, forgeContext, provide, ref, snapshot } from './fake-provider.ts'

const config = { activeIntervalMs: 1_000, idleIntervalMs: 5_000, maxBackoffMs: 6_000, fetchTimeoutMs: 500 }
const START = 1_000_000
const key = changeRequestKey(ref(1))
const missing: ForgeFailure = { code: 'not-found', message: 'missing' }

let ctx: Context | undefined

beforeEach(() => {
  vi.useFakeTimers({ now: START })
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  vi.useRealTimers()
})

async function setup(provider: FakeProvider): Promise<Context> {
  ctx = await forgeContext(config)
  await provide(ctx, provider)
  return ctx
}

/** A provider that reads briefs, holding an open snapshot whose checks passed for each numbered change request. */
function briefProvider(...numbers: number[]): BriefProvider {
  const provider = new BriefProvider()
  for (const number of numbers) provider.results.set(changeRequestKey(ref(number)), snapshot(ref(number)))
  return provider
}

function briefs(
  context: Context, target: ChangeRequestRef = ref(1), known?: ChangeRequestKnownState,
): { updates: ChangeRequestBriefUpdate[]; unwatch: () => void } {
  const updates: ChangeRequestBriefUpdate[] = []
  const unwatch = context.forge.watchBrief(target, (update) => { updates.push(update) }, known)
  return { updates, unwatch }
}

function snapshots(
  context: Context, target: ChangeRequestRef = ref(1), options?: ChangeRequestWatchOptions,
): { updates: ChangeRequestUpdate[]; unwatch: () => void } {
  const updates: ChangeRequestUpdate[] = []
  const unwatch = context.forge.watch(target, (update) => { updates.push(update) }, options)
  return { updates, unwatch }
}

/** A read that stays pending until released or until its signal aborts. */
function hold<T>(result: (target: ChangeRequestRef) => T): {
  readonly read: (refs: readonly ChangeRequestRef[], signal: AbortSignal) => Promise<ReadonlyMap<ChangeRequestKey, T>>
  readonly release: () => void
} {
  const releases: (() => void)[] = []
  return {
    read: (refs, signal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { reject(signal.reason as Error) })
      releases.push(() => { resolve(new Map(refs.map(target => [changeRequestKey(target), result(target)] as const))) })
    }),
    release: () => {
      for (const release of releases.splice(0)) release()
    },
  }
}

describe('forge brief watch', () => {
  it('reads a change request that only brief watchers watch through fetchBriefs', async () => {
    const provider = briefProvider(1)
    const context = await setup(provider)
    const { updates } = briefs(context)

    await vi.advanceTimersByTimeAsync(0)

    expect(provider.briefFetches).toEqual([[ref(1)]])
    expect(provider.fetches).toEqual([])
    expect(updates).toEqual([{ key, fetchedAt: START, brief: brief(snapshot(ref(1))) }])
    expect(context.forge.latest(ref(1))).toBeUndefined()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(provider.briefFetches).toEqual([[ref(1)], [ref(1)]])
  })

  it('reads snapshots for brief watchers when the provider reads no briefs', async () => {
    const provider = new FakeProvider()
    provider.results.set(key, snapshot(ref(1)))
    const context = await setup(provider)
    const { updates } = briefs(context)

    await vi.advanceTimersByTimeAsync(0)

    expect(provider.fetches).toEqual([[ref(1)]])
    expect(updates).toEqual([{ key, fetchedAt: START, brief: snapshot(ref(1)) }])
    expect(context.forge.latest(ref(1))).toEqual({ key, fetchedAt: START, snapshot: snapshot(ref(1)) })
  })

  it('reads the snapshot while a snapshot watcher remains, delivers its brief, and reads the brief again once it left', async () => {
    const provider = briefProvider()
    const running = snapshot(ref(1), { checksRollup: 'pending' })
    provider.results.set(key, running)
    const context = await setup(provider)
    const list = briefs(context)
    await vi.advanceTimersByTimeAsync(0)

    const panel = snapshots(context)
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.fetches).toEqual([[ref(1)]])
    expect(panel.updates).toEqual([{ key, fetchedAt: START, snapshot: running }])
    expect(list.updates).toEqual([{ key, fetchedAt: START, brief: brief(running) }, { key, fetchedAt: START, brief: running }])

    await vi.advanceTimersByTimeAsync(1_000)
    expect(provider.fetches).toHaveLength(2)
    expect(provider.briefFetches).toHaveLength(1)

    panel.unwatch()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(provider.fetches).toHaveLength(2)
    expect(provider.briefFetches).toHaveLength(2)
    expect(list.updates.at(-1)).toEqual({ key, fetchedAt: START + 2_000, brief: brief(running) })
    expect(context.forge.latest(ref(1))).toEqual({ key, fetchedAt: START + 1_000, snapshot: running })
  })

  it('reads at once for a later snapshot watcher only when the latest result is older than its maxAgeMs', async () => {
    const provider = briefProvider(1)
    const context = await setup(provider)
    snapshots(context)
    await vi.advanceTimersByTimeAsync(300)

    snapshots(context)
    snapshots(context, ref(1), { maxAgeMs: 500 })
    await vi.advanceTimersByTimeAsync(300)
    expect(provider.fetches).toHaveLength(1)

    const fresh = snapshots(context, ref(1), { maxAgeMs: 500 })
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.fetches).toHaveLength(2)
    expect(fresh.updates).toEqual([{ key, fetchedAt: START + 600, snapshot: snapshot(ref(1)) }])
  })

  it('keeps the latest snapshot for a watcher that joins a brief watch, and reads a newer one when it asks', async () => {
    const provider = briefProvider(1)
    const context = await setup(provider)
    briefs(context)
    snapshots(context).unwatch()
    const first = snapshots(context)
    await vi.advanceTimersByTimeAsync(0)
    first.unwatch()
    await vi.advanceTimersByTimeAsync(2_000)

    const waiting = snapshots(context)
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.fetches).toHaveLength(1)
    expect(context.forge.latest(ref(1))).toEqual({ key, fetchedAt: START, snapshot: snapshot(ref(1)) })
    waiting.unwatch()

    const fresh = snapshots(context, ref(1), { maxAgeMs: 1_000 })
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.fetches).toHaveLength(2)
    expect(fresh.updates).toEqual([{ key, fetchedAt: START + 2_000, snapshot: snapshot(ref(1)) }])
  })

  it('runs one snapshot fetch and one brief fetch of a forge side by side', async () => {
    const provider = briefProvider()
    const snapshotReads = hold(target => snapshot(target))
    const briefReads = hold(target => brief(snapshot(target)))
    provider.fetchImpl = snapshotReads.read
    provider.briefImpl = briefReads.read
    const context = await setup(provider)
    briefs(context, ref(1))
    snapshots(context, ref(2))
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.briefFetches).toEqual([[ref(1)]])
    expect(provider.fetches).toEqual([[ref(2)]])

    briefs(context, ref(3))
    snapshots(context, ref(4))
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.briefFetches).toHaveLength(1)
    expect(provider.fetches).toHaveLength(1)

    snapshotReads.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.fetches).toEqual([[ref(2)], [ref(4)]])
    expect(provider.briefFetches).toHaveLength(1)

    briefReads.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.briefFetches).toEqual([[ref(1)], [ref(3)]])
  })

  it('times the first poll of a brief watch from the state its watcher knows', async () => {
    const provider = briefProvider(1, 2, 3)
    const context = await setup(provider)
    briefs(context, ref(1), { state: 'merged', mergeability: 'unknown', checksRollup: 'none', fetchedAt: 0 })
    briefs(context, ref(2), { state: 'open', mergeability: 'mergeable', checksRollup: 'success', fetchedAt: START - 2_000 })
    briefs(context, ref(3), { state: 'open', mergeability: 'mergeable', checksRollup: 'pending', fetchedAt: START - 2_000 })

    await vi.advanceTimersByTimeAsync(2_999)
    expect(provider.briefFetches).toEqual([[ref(3)]])
    // The third one, read 3 of its 5 seconds ago, rides along.
    await vi.advanceTimersByTimeAsync(1)
    expect(provider.briefFetches).toEqual([[ref(3)], [ref(2), ref(3)]])

    await vi.advanceTimersByTimeAsync(60_000)
    expect(provider.briefFetches.flat()).not.toContainEqual(ref(1))
    context.forge.refresh(ref(1))
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.briefFetches.at(-1)).toEqual([ref(1)])
  })

  it('ignores the known state of a change request that already has a watcher', async () => {
    const provider = briefProvider(1)
    const context = await setup(provider)
    briefs(context)
    briefs(context, ref(1), { state: 'merged', mergeability: 'unknown', checksRollup: 'none', fetchedAt: 0 })

    await vi.advanceTimersByTimeAsync(0)

    expect(provider.briefFetches).toEqual([[ref(1)]])
  })

  it('delivers a failed brief read to brief watchers only, keeps the latest snapshot, and backs off', async () => {
    const provider = briefProvider(1)
    const context = await setup(provider)
    const list = briefs(context)
    const panel = snapshots(context)
    await vi.advanceTimersByTimeAsync(0)
    panel.unwatch()
    provider.results.set(key, missing)

    await vi.advanceTimersByTimeAsync(5_000)

    expect(list.updates.at(-1)).toEqual({ key, fetchedAt: START + 5_000, failure: missing })
    expect(panel.updates).toHaveLength(1)
    expect(context.forge.latest(ref(1))).toEqual({ key, fetchedAt: START, snapshot: snapshot(ref(1)) })
    await vi.advanceTimersByTimeAsync(1_999)
    expect(provider.briefFetches).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(provider.briefFetches).toHaveLength(2)
  })

  it('delivers a failed snapshot read to both kinds of watchers', async () => {
    const provider = briefProvider()
    const context = await setup(provider)
    const list = briefs(context)
    const panel = snapshots(context)

    await vi.advanceTimersByTimeAsync(0)

    expect(panel.updates).toEqual([{ key, fetchedAt: START, failure: missing }])
    expect(list.updates).toEqual([{ key, fetchedAt: START, failure: missing }])
    expect(context.forge.latest(ref(1))).toEqual({ key, fetchedAt: START, failure: missing })
  })

  it('reports a brief read that names no result for a change request, and one that rejects', async () => {
    const provider = briefProvider(1)
    provider.briefImpl = async () => new Map()
    const context = await setup(provider)
    const list = briefs(context)
    await vi.advanceTimersByTimeAsync(0)
    expect(list.updates).toEqual([{ key, fetchedAt: START, failure: { code: 'unavailable', message: `provider returned no result for ${key}` } }])

    provider.briefImpl = async () => { throw new Error('briefs down') }
    await vi.advanceTimersByTimeAsync(2_000)
    expect(list.updates.at(-1)).toEqual({ key, fetchedAt: START + 2_000, failure: { code: 'unavailable', message: 'briefs down' } })
  })

  it('fails the watches of a withdrawn provider at the level each is read at', async () => {
    const provider = briefProvider(1, 2)
    ctx = await forgeContext(config)
    const fiber = await provide(ctx, provider)
    const list = briefs(ctx, ref(1))
    const panel = snapshots(ctx, ref(2))
    await vi.advanceTimersByTimeAsync(0)

    await fiber.dispose()

    const failure = { code: 'unavailable', message: 'no provider is registered for "fake"' }
    expect(list.updates.at(-1)).toEqual({ key, fetchedAt: START, failure })
    expect(panel.updates.at(-1)).toEqual({ key: changeRequestKey(ref(2)), fetchedAt: START, failure })
    expect(ctx.forge.latest(ref(1))).toBeUndefined()
    expect(ctx.forge.latest(ref(2))).toEqual({ key: changeRequestKey(ref(2)), fetchedAt: START, failure })
  })

  it('keeps polling until the last watcher of either kind left', async () => {
    const provider = briefProvider(1)
    const context = await setup(provider)
    const list = briefs(context)
    const panel = snapshots(context)
    await vi.advanceTimersByTimeAsync(0)

    list.unwatch()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(provider.fetches).toHaveLength(2)

    panel.unwatch()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(provider.fetches).toHaveLength(2)
    expect(provider.briefFetches).toEqual([])
    expect(context.forge.latest(ref(1))).toBeUndefined()
  })

  it('skips a brief listener that throws', async () => {
    const provider = briefProvider(1)
    const context = await setup(provider)
    context.forge.watchBrief(ref(1), () => { throw new Error('listener failed') })
    const list = briefs(context)

    await vi.advanceTimersByTimeAsync(0)

    expect(list.updates).toHaveLength(1)
  })

  it('stops a brief watch when the fiber that started it is disposed', async () => {
    const provider = briefProvider(1)
    const context = await setup(provider)
    const fiber = context.plugin({
      inject: ['forge'],
      apply(child: Context) {
        child.forge.watchBrief(ref(1), () => {})
      },
    })
    await fiber
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.briefFetches).toHaveLength(1)

    await fiber.dispose()
    await vi.advanceTimersByTimeAsync(60_000)

    expect(provider.briefFetches).toHaveLength(1)
  })
})
