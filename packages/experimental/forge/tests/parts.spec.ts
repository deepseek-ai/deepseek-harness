/**
 * Fetches of a provider that names a batch size: which change requests one call reads, when a call starts and
 * settles, and what a call that fails or outlives its deadline affects.
 */
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { changeRequestKey } from '../src/index.ts'
import type { ChangeRequestBriefUpdate, ChangeRequestKey, ChangeRequestRef, ChangeRequestUpdate, ForgeRepository } from '../src/types.ts'
import { brief, BriefProvider, demo, FakeProvider, forgeContext, provide, ref, snapshot } from './fake-provider.ts'

const config = { activeIntervalMs: 1_000, idleIntervalMs: 4_000, maxBackoffMs: 16_000, fetchTimeoutMs: 500 }
const START = 1_000_000
const second: ForgeRepository = { ...demo, host: 'second.test' }
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

/** A provider of two hosts that reads briefs, holding an open snapshot whose checks passed for the numbered change requests of `demo`. */
function provider(sizes: { readonly snapshotBatchSize?: number; readonly briefBatchSize?: number }, ...numbers: number[]): BriefProvider {
  const created = Object.assign(new BriefProvider('fake', ['fake.test', 'second.test']), sizes)
  for (const number of numbers) created.results.set(changeRequestKey(ref(number)), snapshot(ref(number)))
  return created
}

function snapshots(context: Context, target: ChangeRequestRef): { updates: ChangeRequestUpdate[]; unwatch: () => void } {
  const updates: ChangeRequestUpdate[] = []
  return { updates, unwatch: context.forge.watch(target, (update) => { updates.push(update) }) }
}

function briefs(context: Context, target: ChangeRequestRef): { updates: ChangeRequestBriefUpdate[]; unwatch: () => void } {
  const updates: ChangeRequestBriefUpdate[] = []
  return { updates, unwatch: context.forge.watchBrief(target, (update) => { updates.push(update) }) }
}

/** Make every call of `target` at one level stay pending until released or until its signal aborts. */
function hold(target: BriefProvider, level: 'brief' | 'snapshot'): () => void {
  const releases: (() => void)[] = []
  const pending = <T>(result: (read: ChangeRequestRef) => T) => (refs: readonly ChangeRequestRef[], signal: AbortSignal) =>
    new Promise<ReadonlyMap<ChangeRequestKey, T>>((resolve, reject) => {
      signal.addEventListener('abort', () => { reject(signal.reason as Error) })
      releases.push(() => { resolve(new Map(refs.map(read => [changeRequestKey(read), result(read)] as const))) })
    })
  if (level === 'brief') target.briefImpl = pending(read => brief(snapshot(read)))
  else target.fetchImpl = pending(read => snapshot(read))
  return () => {
    for (const release of releases.splice(0)) release()
  }
}

/** Run every microtask that is ready, without running a timer. */
async function microtasks(): Promise<void> {
  for (let turn = 0; turn < 50; turn++) await Promise.resolve()
}

const numbers = (calls: readonly (readonly ChangeRequestRef[])[]): number[][] => calls.map(refs => refs.map(read => read.number))

describe('forge fetches in parts', () => {
  it('calls a provider once per snapshotBatchSize change requests of a host, compared without case, in order', async () => {
    const reader = provider({ snapshotBatchSize: 2 })
    ctx = await forgeContext(config)
    await provide(ctx, reader)
    const refs = [ref(1), ref(2, second), ref(3, { ...demo, host: 'FAKE.test' }), ref(4), ref(5, second), ref(6, second)]
    for (const target of refs) ctx.forge.watch(target, ignore)

    await vi.advanceTimersByTimeAsync(0)

    expect(numbers(reader.fetches)).toEqual([[1, 3], [4], [2, 5], [6]])
  })

  it.each([
    ['briefBatchSize change requests through fetchBriefs', { snapshotBatchSize: 5, briefBatchSize: 2 }, [[1, 2], [3]]],
    ['every due change request through fetchBriefs when only snapshotBatchSize is named', { snapshotBatchSize: 2 }, [[1, 2, 3]]],
  ])('reads briefs in calls of %s', async (_, sizes, calls) => {
    const reader = provider(sizes, 1, 2, 3)
    ctx = await forgeContext(config)
    await provide(ctx, reader)
    for (const number of [1, 2, 3]) ctx.forge.watchBrief(ref(number), ignore)

    await vi.advanceTimersByTimeAsync(0)

    expect(numbers(reader.briefFetches)).toEqual(calls)
    expect(reader.fetches).toEqual([])
  })

  it('reads briefs in calls of snapshotBatchSize through a provider that reads no briefs', async () => {
    const reader = Object.assign(new FakeProvider(), { snapshotBatchSize: 2, briefBatchSize: 1 })
    ctx = await forgeContext(config)
    await provide(ctx, reader)
    for (const number of [1, 2, 3]) ctx.forge.watchBrief(ref(number), ignore)

    await vi.advanceTimersByTimeAsync(0)

    expect(numbers(reader.fetches)).toEqual([[1, 2], [3]])
  })

  it('starts a call once the one before it returned, and settles the results of each call when it returns', async () => {
    const reader = provider({ snapshotBatchSize: 2 })
    const release = hold(reader, 'snapshot')
    ctx = await forgeContext(config)
    await provide(ctx, reader)
    const watched = [1, 2, 3].map(number => snapshots(ctx!, ref(number)))
    await vi.advanceTimersByTimeAsync(100)
    expect(numbers(reader.fetches)).toEqual([[1, 2]])

    release()
    await vi.advanceTimersByTimeAsync(100)
    expect(numbers(reader.fetches)).toEqual([[1, 2], [3]])
    expect(watched.map(watch => watch.updates.map(update => update.fetchedAt))).toEqual([[START + 100], [START + 100], []])

    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(watched[2]?.updates).toEqual([{ key: changeRequestKey(ref(3)), fetchedAt: START + 200, snapshot: snapshot(ref(3)) }])
  })

  it('gives each call its own deadline, so a call that outlives it fails only its own change requests', async () => {
    const reader = provider({ snapshotBatchSize: 2 })
    reader.fetchImpl = (refs, signal) => new Promise((resolve, reject) => {
      if (refs.some(read => read.number === 1)) signal.addEventListener('abort', () => { reject(signal.reason as Error) })
      else resolve(new Map(refs.map(read => [changeRequestKey(read), snapshot(read)] as const)))
    })
    ctx = await forgeContext(config)
    await provide(ctx, reader)
    const watched = [1, 2, 3, 4].map(number => snapshots(ctx!, ref(number)))

    await vi.advanceTimersByTimeAsync(499)
    expect(numbers(reader.fetches)).toEqual([[1, 2]])
    await vi.advanceTimersByTimeAsync(1)

    const late = { code: 'unavailable', message: 'FORGE_FETCH_TIMEOUT after 500ms' }
    expect(numbers(reader.fetches)).toEqual([[1, 2], [3, 4]])
    expect(watched.map(watch => watch.updates)).toEqual([
      [{ key: changeRequestKey(ref(1)), fetchedAt: START + 500, failure: late }],
      [{ key: changeRequestKey(ref(2)), fetchedAt: START + 500, failure: late }],
      [{ key: changeRequestKey(ref(3)), fetchedAt: START + 500, snapshot: snapshot(ref(3)) }],
      [{ key: changeRequestKey(ref(4)), fetchedAt: START + 500, snapshot: snapshot(ref(4)) }],
    ])
  })

  it('fails only the change requests of a call that rejects', async () => {
    const reader = provider({ briefBatchSize: 1 }, 1, 2, 3)
    reader.briefImpl = async (refs) => {
      if (refs[0]?.number === 2) throw new Error('refused')
      return new Map(refs.map(read => [changeRequestKey(read), brief(snapshot(read))] as const))
    }
    ctx = await forgeContext(config)
    await provide(ctx, reader)
    const watched = [1, 2, 3].map(number => briefs(ctx!, ref(number)))

    await vi.advanceTimersByTimeAsync(0)

    expect(watched.map(watch => watch.updates.map(update => 'failure' in update ? update.failure.message : update.brief.title)))
      .toEqual([['Change 1'], ['refused'], ['Change 3']])
  })

  it('calls nothing for a part whose watches all ended while they waited, and frees the forge for the next fetch', async () => {
    const reader = provider({ snapshotBatchSize: 2 })
    const release = hold(reader, 'snapshot')
    ctx = await forgeContext(config)
    await provide(ctx, reader)
    const watched = [1, 2, 3].map(number => snapshots(ctx!, ref(number)))
    await vi.advanceTimersByTimeAsync(0)

    watched[2]?.unwatch()
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(numbers(reader.fetches)).toEqual([[1, 2]])

    ctx.forge.watch(ref(4), ignore)
    await vi.advanceTimersByTimeAsync(0)
    expect(numbers(reader.fetches)).toEqual([[1, 2], [4]])
  })

  it('leaves out of a brief call a change request whose snapshot was read while it waited', async () => {
    const reader = provider({ snapshotBatchSize: 1, briefBatchSize: 1 }, 1, 2)
    const release = hold(reader, 'brief')
    ctx = await forgeContext(config)
    await provide(ctx, reader)
    ctx.forge.watchBrief(ref(1), ignore)
    const list = briefs(ctx, ref(2))
    await vi.advanceTimersByTimeAsync(0)

    // A panel opens on the waiting change request: its snapshot is read at once, beside the brief call in flight.
    ctx.forge.watch(ref(2), ignore)
    await vi.advanceTimersByTimeAsync(0)
    expect(numbers(reader.fetches)).toEqual([[2]])
    expect(list.updates).toHaveLength(1)

    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(numbers(reader.briefFetches)).toEqual([[1]])
    expect(list.updates).toHaveLength(1)
  })

  it('lets the snapshot fetch read a change request that gained a snapshot watcher just before its brief call', async () => {
    const reader = provider({ snapshotBatchSize: 1, briefBatchSize: 1 }, 1, 2)
    const release = hold(reader, 'brief')
    ctx = await forgeContext(config)
    await provide(ctx, reader)
    ctx.forge.watchBrief(ref(1), ignore)
    ctx.forge.watchBrief(ref(2), ignore)
    await vi.advanceTimersByTimeAsync(0)

    // The call before its own returns before the timer of the new watcher runs.
    const panel = snapshots(ctx, ref(2))
    release()
    await microtasks()
    expect(numbers(reader.briefFetches)).toEqual([[1]])
    await vi.advanceTimersByTimeAsync(0)

    expect(numbers(reader.fetches)).toEqual([[2]])
    expect(numbers(reader.briefFetches)).toEqual([[1]])
    expect(panel.updates).toEqual([{ key: changeRequestKey(ref(2)), fetchedAt: START, snapshot: snapshot(ref(2)) }])
  })

  it('lets the brief fetch read a change request that lost its snapshot watchers while it waited for a snapshot call', async () => {
    const reader = provider({ snapshotBatchSize: 1, briefBatchSize: 1 }, 1, 2)
    const release = hold(reader, 'snapshot')
    ctx = await forgeContext(config)
    await provide(ctx, reader)
    ctx.forge.watch(ref(1), ignore)
    const panel = snapshots(ctx, ref(2))
    const list = briefs(ctx, ref(2))
    await vi.advanceTimersByTimeAsync(0)

    panel.unwatch()
    release()
    await vi.advanceTimersByTimeAsync(0)

    expect(numbers(reader.fetches)).toEqual([[1]])
    expect(numbers(reader.briefFetches)).toEqual([[2]])
    expect(list.updates).toEqual([{ key: changeRequestKey(ref(2)), fetchedAt: START, brief: brief(snapshot(ref(2))) }])
  })

  it('answers a refresh asked for while a change request waited with the call that reads it', async () => {
    const reader = provider({ snapshotBatchSize: 1 })
    const release = hold(reader, 'snapshot')
    ctx = await forgeContext(config)
    await provide(ctx, reader)
    ctx.forge.watch(ref(1), ignore)
    ctx.forge.watch(ref(2), ignore)
    await vi.advanceTimersByTimeAsync(0)

    ctx.forge.refresh(ref(2))
    release()
    await vi.advanceTimersByTimeAsync(0)
    release()
    await vi.advanceTimersByTimeAsync(0)

    expect(numbers(reader.fetches)).toEqual([[1], [2]])
  })

  it('calls no further part of a provider that was withdrawn during a call', async () => {
    const reader = provider({ snapshotBatchSize: 2 })
    hold(reader, 'snapshot')
    ctx = await forgeContext(config)
    const fiber = await provide(ctx, reader)
    const watched = [1, 2, 3].map(number => snapshots(ctx!, ref(number)))
    await vi.advanceTimersByTimeAsync(0)

    await fiber.dispose()
    await vi.advanceTimersByTimeAsync(0)

    expect(numbers(reader.fetches)).toEqual([[1, 2]])
    expect(watched.map(watch => watch.updates.map(update => 'failure' in update && update.failure.message)))
      .toEqual(Array.from({ length: 3 }, () => ['no provider is registered for "fake"']))
  })

  it.each([
    ['snapshotBatchSize', 0],
    ['snapshotBatchSize', 2.5],
    ['briefBatchSize', -1],
    ['briefBatchSize', Number.MAX_SAFE_INTEGER + 1],
  ] as const)('refuses a provider whose %s is %s', async (key, size) => {
    ctx = await forgeContext(config)

    await expect(provide(ctx, Object.assign(new FakeProvider(), { [key]: size })))
      .rejects.toThrow(`forge: ${key} of the "fake" provider must be a positive safe integer`)
    expect(ctx.forge.describe('fake')).toBeUndefined()
  })
})
