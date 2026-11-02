import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ForgeService, { changeRequestKey } from '../src/index.ts'
import type { ChangeRequestKey, ChangeRequestRef, ChangeRequestSnapshot, ChangeRequestUpdate, ForgeFailure, ForgeRepository } from '../src/types.ts'
import { FakeProvider, forgeContext, provide, ref, snapshot } from './fake-provider.ts'

const config = { activeIntervalMs: 1_000, idleIntervalMs: 5_000, maxBackoffMs: 6_000, fetchTimeoutMs: 500 }
const other: ForgeRepository = { forge: 'other', host: 'other.test', owner: 'o', name: 'r' }
const key = changeRequestKey(ref(1))

let ctx: Context | undefined

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 })
})

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  vi.useRealTimers()
})

async function setup(...providers: FakeProvider[]): Promise<Context> {
  ctx = await forgeContext(config)
  for (const provider of providers) await provide(ctx, provider)
  return ctx
}

function collect(context: Context, target: ChangeRequestRef = ref(1)): { updates: ChangeRequestUpdate[]; unwatch: () => void } {
  const updates: ChangeRequestUpdate[] = []
  const unwatch = context.forge.watch(target, (update) => {
    updates.push(update)
  })
  return { updates, unwatch }
}

/** A fetch that stays pending until released or until its signal aborts. */
function held(provider: FakeProvider, result: (target: ChangeRequestRef) => ChangeRequestSnapshot | ForgeFailure): () => void {
  const releases: (() => void)[] = []
  type Results = ReadonlyMap<ChangeRequestKey, ChangeRequestSnapshot | ForgeFailure>
  provider.fetchImpl = (refs, signal) => new Promise<Results>((resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(signal.reason as Error)
    })
    releases.push(() => {
      resolve(new Map(refs.map(target => [changeRequestKey(target), result(target)] as const)))
    })
  })
  return () => {
    for (const release of releases.splice(0)) release()
  }
}

describe('forge watch', () => {
  it('fetches a new watch at once and keeps the latest result', async () => {
    const provider = new FakeProvider()
    provider.results.set(key, snapshot(ref(1)))
    const context = await setup(provider)
    const { updates } = collect(context)

    await vi.advanceTimersByTimeAsync(0)

    expect(provider.fetches).toEqual([[ref(1)]])
    expect(updates).toEqual([{ key, fetchedAt: 1_000_000, snapshot: snapshot(ref(1)) }])
    expect(context.forge.latest(ref(1))).toEqual(updates[0])
    expect(context.forge.latest(ref(2))).toBeUndefined()
  })

  it('keeps polling a change request watched through ctx.forge for many rounds', async () => {
    // A round that ran on the previous round's receiver would nest one more shadow each time,
    // and such a chain overflows the stack within a few hundred rounds.
    ctx = await forgeContext({ activeIntervalMs: 1, idleIntervalMs: 1, maxBackoffMs: 1, fetchTimeoutMs: 500 })
    const provider = new FakeProvider()
    provider.results.set(key, snapshot(ref(1)))
    await provide(ctx, provider)
    const { updates } = collect(ctx)

    for (let step = 0; step < 300 && updates.length < 1_000; step++) await vi.advanceTimersByTimeAsync(10)

    expect(updates.length).toBeGreaterThanOrEqual(1_000)
    expect(updates.at(-1)).toMatchObject({ key, snapshot: snapshot(ref(1)) })
  })

  it('batches due change requests of one forge into one fetch', async () => {
    const provider = new FakeProvider()
    const context = await setup(provider)
    collect(context, ref(1))
    collect(context, ref(2))

    await vi.advanceTimersByTimeAsync(0)

    expect(provider.fetches).toEqual([[ref(1), ref(2)]])
  })

  it('polls pending work at the active interval, settled work at the idle interval, and stops at a terminal state', async () => {
    const provider = new FakeProvider()
    provider.results.set(key, snapshot(ref(1), { checksRollup: 'pending' }))
    const context = await setup(provider)
    collect(context)

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(999)
    expect(provider.fetches).toHaveLength(1)
    provider.results.set(key, snapshot(ref(1)))
    await vi.advanceTimersByTimeAsync(1)
    expect(provider.fetches).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(provider.fetches).toHaveLength(2)
    provider.results.set(key, snapshot(ref(1), { state: 'merged' }))
    await vi.advanceTimersByTimeAsync(1)
    expect(provider.fetches).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(provider.fetches).toHaveLength(3)
    await context.forge.submitReview(ref(1), { kind: 'review', headSha: 'a'.repeat(40), event: 'comment', body: 'Summary', comments: [] }, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.fetches).toHaveLength(4)
  })

  it('treats unknown mergeability as active work', async () => {
    const provider = new FakeProvider()
    provider.results.set(key, snapshot(ref(1), { mergeability: 'unknown' }))
    const context = await setup(provider)
    collect(context)

    await vi.advanceTimersByTimeAsync(1_000)

    expect(provider.fetches).toHaveLength(2)
  })

  it('backs off after consecutive failures up to the cap and resets after success', async () => {
    const provider = new FakeProvider()
    const context = await setup(provider)
    const { updates } = collect(context)

    await vi.advanceTimersByTimeAsync(0)
    expect(updates[0]).toEqual({ key, fetchedAt: 1_000_000, failure: { code: 'not-found', message: 'missing' } })
    await vi.advanceTimersByTimeAsync(config.activeIntervalMs * 2 - 1)
    expect(provider.fetches).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(provider.fetches).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(3_999)
    expect(provider.fetches).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(provider.fetches).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(5_999)
    expect(provider.fetches).toHaveLength(3)
    provider.results.set(key, snapshot(ref(1), { checksRollup: 'pending' }))
    await vi.advanceTimersByTimeAsync(1)
    expect(provider.fetches).toHaveLength(4)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(provider.fetches).toHaveLength(5)
  })

  it('runs one fetch per forge at a time while another forge proceeds', async () => {
    const slow = new FakeProvider('fake')
    const quick = new FakeProvider('other')
    const release = held(slow, target => snapshot(target, { checksRollup: 'pending' }))
    quick.results.set(changeRequestKey(ref(5, other)), snapshot(ref(5, other)))
    const context = await setup(slow, quick)
    collect(context, ref(1))
    await vi.advanceTimersByTimeAsync(0)

    collect(context, ref(2))
    collect(context, ref(5, other))
    await vi.advanceTimersByTimeAsync(0)
    expect(slow.fetches).toEqual([[ref(1)]])
    expect(quick.fetches).toEqual([[ref(5, other)]])

    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(slow.fetches).toEqual([[ref(1)], [ref(2)]])
  })

  it('stops polling a change request after its last listener leaves', async () => {
    const provider = new FakeProvider()
    provider.results.set(key, snapshot(ref(1), { checksRollup: 'pending' }))
    const context = await setup(provider)
    const first = collect(context)
    const second = collect(context)
    await vi.advanceTimersByTimeAsync(0)

    first.unwatch()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(provider.fetches).toHaveLength(2)
    expect(first.updates).toHaveLength(1)
    second.unwatch()
    second.unwatch()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(provider.fetches).toHaveLength(2)
    expect(context.forge.latest(ref(1))).toBeUndefined()
  })

  it('refreshes a watched change request at once, including after a terminal state', async () => {
    const provider = new FakeProvider()
    provider.results.set(key, snapshot(ref(1), { state: 'merged' }))
    const context = await setup(provider)
    collect(context)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(provider.fetches).toHaveLength(1)

    context.forge.refresh(ref(1))
    context.forge.refresh(ref(9))
    await vi.advanceTimersByTimeAsync(0)

    expect(provider.fetches).toEqual([[ref(1)], [ref(1)]])
  })

  it('polls a watched change request at once after an action settles, whatever its outcome', async () => {
    const provider = new FakeProvider()
    provider.results.set(key, snapshot(ref(1), { draft: true }))
    const context = await setup(provider)
    collect(context)
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.fetches).toHaveLength(1)

    await context.forge.markReady(ref(1), new AbortController().signal)
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.fetches).toHaveLength(2)

    provider.actionResult = { code: 'failed', message: 'Pull Request is not mergeable' }
    await context.forge.merge(ref(1), { method: 'merge', headSha: 'a'.repeat(40) }, new AbortController().signal)
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.fetches).toHaveLength(3)
  })

  it('coalesces refreshes during a fetch into one immediate subsequent fetch', async () => {
    const provider = new FakeProvider()
    const release = held(provider, target => snapshot(target))
    const context = await setup(provider)
    const { updates } = collect(context)
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.fetches).toHaveLength(1)

    context.forge.refresh(ref(1))
    context.forge.refresh(ref(1))
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.fetches).toHaveLength(1)
    release()
    await vi.advanceTimersByTimeAsync(0)

    expect(updates).toHaveLength(1)
    expect(provider.fetches).toHaveLength(2)
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(updates).toHaveLength(2)
    expect(provider.fetches).toHaveLength(2)
  })

  it.each(['ready', 'merge'] as const)('fetches again after %s when an older poll is still pending', async (action) => {
    const provider = new FakeProvider()
    const release = held(provider, target => snapshot(target, { draft: true }))
    const context = await setup(provider)
    const { updates } = collect(context)
    await vi.advanceTimersByTimeAsync(0)

    const signal = new AbortController().signal
    if (action === 'ready') await context.forge.markReady(ref(1), signal)
    else await context.forge.merge(ref(1), { method: 'merge', headSha: 'a'.repeat(40) }, signal)
    provider.fetchImpl = undefined
    provider.results.set(key, snapshot(ref(1), { draft: false, state: action === 'merge' ? 'merged' : 'open' }))
    release()
    await vi.advanceTimersByTimeAsync(0)

    expect(provider.fetches).toHaveLength(2)
    expect(updates.at(-1)).toMatchObject({ snapshot: { draft: false, state: action === 'merge' ? 'merged' : 'open' } })
  })

  it('keeps notifying other listeners when one listener throws', async () => {
    const provider = new FakeProvider()
    provider.results.set(key, snapshot(ref(1)))
    const context = await setup(provider)
    const warn = vi.spyOn(context.logger, 'warn').mockImplementation(() => {})
    context.forge.watch(ref(1), () => {
      throw new Error('listener failed')
    })
    const { updates } = collect(context)

    await vi.advanceTimersByTimeAsync(0)

    expect(updates).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('listener failed'))
  })

  it('reports unavailable when the provider throws, omits a result, or is removed', async () => {
    const provider = new FakeProvider()
    provider.fetchImpl = async () => {
      throw new Error('network down')
    }
    ctx = await forgeContext(config)
    const fiber = await provide(ctx, provider)
    const { updates } = collect(ctx)

    await vi.advanceTimersByTimeAsync(0)
    expect(updates.at(-1)).toMatchObject({ failure: { code: 'unavailable', message: 'network down' } })
    provider.fetchImpl = async () => {
      throw 'plain failure'
    }
    await vi.advanceTimersByTimeAsync(2_000)
    expect(updates.at(-1)).toMatchObject({ failure: { code: 'unavailable', message: 'plain failure' } })
    provider.fetchImpl = async () => new Map()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(updates.at(-1)).toMatchObject({ failure: { code: 'unavailable', message: `provider returned no result for ${key}` } })

    await fiber.dispose()
    expect(updates.at(-1)).toMatchObject({ failure: { code: 'unavailable', message: 'no provider is registered for "fake"' } })
    await vi.advanceTimersByTimeAsync(6_000)
    expect(updates).toHaveLength(5)
    expect(updates.at(-1)).toMatchObject({ failure: { code: 'unavailable', message: 'no provider is registered for "fake"' } })
  })

  it('notifies only the watches of the forge whose provider left', async () => {
    const leaving = new FakeProvider('fake')
    const staying = new FakeProvider('other')
    leaving.results.set(key, snapshot(ref(1)))
    staying.results.set(changeRequestKey(ref(5, other)), snapshot(ref(5, other)))
    ctx = await forgeContext(config)
    const fiber = await provide(ctx, leaving)
    await provide(ctx, staying)
    const affected = collect(ctx, ref(1))
    const unaffected = collect(ctx, ref(5, other))
    await vi.advanceTimersByTimeAsync(0)

    await fiber.dispose()

    expect(affected.updates.at(-1)).toMatchObject({ failure: { code: 'unavailable' } })
    expect(unaffected.updates).toHaveLength(1)
  })

  it('drops the result of a fetch whose watch ended while it was in flight', async () => {
    const provider = new FakeProvider()
    const release = held(provider, target => snapshot(target))
    const context = await setup(provider)
    const { updates, unwatch } = collect(context)
    await vi.advanceTimersByTimeAsync(0)

    unwatch()
    release()
    await vi.advanceTimersByTimeAsync(0)

    expect(updates).toEqual([])
    expect(context.forge.latest(ref(1))).toBeUndefined()
  })

  it('arms no timer when a watch ends after the service stopped', async () => {
    ctx = new Context()
    const service = ctx.plugin(ForgeService, config)
    await service
    const unwatch = ctx.forge.watch(ref(1), () => {})

    await service.dispose()
    unwatch()

    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts a fetch that outlives fetchTimeoutMs', async () => {
    const provider = new FakeProvider()
    held(provider, target => snapshot(target))
    const context = await setup(provider)
    const { updates } = collect(context)

    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(500)

    expect(provider.signals[0]?.aborted).toBe(true)
    expect(updates).toEqual([{ key, fetchedAt: 1_000_500, failure: { code: 'unavailable', message: 'FORGE_FETCH_TIMEOUT after 500ms' } }])
  })

  it('cancels fetches and timers without notifying when the service is disposed', async () => {
    const provider = new FakeProvider()
    held(provider, target => snapshot(target))
    const context = await setup(provider)
    const { updates } = collect(context)
    await vi.advanceTimersByTimeAsync(0)

    await context.fiber.dispose()
    ctx = undefined

    expect(provider.signals[0]?.aborted).toBe(true)
    expect(updates).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  // Cordis disposes a provider plugin that injects `forge` before the service,
  // so only a registration owned outside the service's dependents can still
  // be serving when the service itself stops.
  it('discards a fetch that settles after the service is disposed', async () => {
    const provider = new FakeProvider()
    const release = held(provider, target => snapshot(target))
    ctx = new Context()
    const service = ctx.plugin(ForgeService, config)
    await service
    ctx.get('forge')!.register(provider)
    const { updates } = collect(ctx)
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.signals).toHaveLength(1)

    const disposal = service.dispose()
    release()
    await disposal

    expect(updates).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases a watch when the subscribing fiber is disposed', async () => {
    const provider = new FakeProvider()
    provider.results.set(key, snapshot(ref(1), { checksRollup: 'pending' }))
    const context = await setup(provider)
    const fiber = context.plugin({
      inject: ['forge'],
      apply(child: Context) {
        child.forge.watch(ref(1), () => {})
      },
    })
    await fiber
    await vi.advanceTimersByTimeAsync(0)

    await fiber.dispose()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(provider.fetches).toHaveLength(1)
  })
  it('polls closed requests at the idle cadence and publishes reopening', async () => {
    const provider = new FakeProvider()
    provider.results.set(key, snapshot(ref(1), { state: 'closed' }))
    const context = await setup(provider)
    const { updates } = collect(context)
    await vi.advanceTimersByTimeAsync(0)
    expect(updates.at(-1)).toMatchObject({ snapshot: { state: 'closed' } })
    provider.results.set(key, snapshot(ref(1), { state: 'open' }))
    await vi.advanceTimersByTimeAsync(config.idleIntervalMs - 1)
    expect(provider.fetches).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(updates.at(-1)).toMatchObject({ snapshot: { state: 'open' } })
    expect(provider.fetches).toHaveLength(2)
  })

})
