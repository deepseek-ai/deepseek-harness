/** The review page's list and count streams, which read the forge registry only while some reader streams them. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ChangeRequestSummary, ForgeFailure, ForgeViewerFilter, ForgeViewerList, ForgeViewerQuery, ForgeViewerSource,
} from '@deepseek-ai/dsh-experimental-forge/types'
import type { ForgeReviewCountFrame, ForgeReviewFrame } from '../src/types.ts'
import { Reader, ViewerLists, type ViewerListSources, type ViewerListTiming } from '../src/viewer-lists.ts'

const ALL: ReadonlySet<ForgeViewerFilter> = new Set(['review-requested', 'authored', 'involved'])

const timing: ViewerListTiming = { listIntervalMs: 1_000, countIntervalMs: 2_000, maxBackoffMs: 5_000, pageSize: 20 }

function summary(number: number, repository = 'demo'): ChangeRequestSummary {
  return {
    ref: { repository: { forge: 'github', host: 'github.com', owner: 'octo', name: repository }, number },
    url: `https://github.com/octo/${repository}/pull/${number}`,
    title: `Change ${number}`,
    draft: false,
    author: null,
    headSha: 'a'.repeat(40),
    checksRollup: 'none',
    reviewDecision: 'none',
    viewerReview: null,
    viewerRequest: null,
    closingIssues: [],
    closingIssuesTruncated: false,
    updatedAt: '2026-11-10T09:00:00Z',
  }
}

/** A registry fake whose list and count answers each test sets; every call is recorded. */
interface RegistryFake extends ViewerListSources {
  readonly calls: ForgeViewerQuery[]
  readonly counts: string[]
  readonly reported: unknown[]
  answer: (query: ForgeViewerQuery, signal: AbortSignal) => Promise<ForgeViewerList | ForgeFailure>
  answerCount: (host: string) => Promise<ReadonlyMap<ForgeViewerFilter, number> | ForgeFailure>
  sourcesNow: ForgeViewerSource[]
}

function registry(sources: ForgeViewerSource[]): RegistryFake {
  const fake: RegistryFake = {
    calls: [],
    counts: [],
    reported: [],
    sourcesNow: sources,
    answer: async (query: ForgeViewerQuery): Promise<ForgeViewerList | ForgeFailure> =>
      await Promise.resolve({ viewer: 'octo', items: [summary(query.filter === 'authored' ? 2 : 1)], total: 3 }),
    answerCount: async (): Promise<ReadonlyMap<ForgeViewerFilter, number> | ForgeFailure> =>
      await Promise.resolve(new Map([['review-requested', 7]])),
    sources: () => fake.sourcesNow,
    list: async (_forge: string, query: ForgeViewerQuery, signal: AbortSignal) => {
      fake.calls.push(query)
      return await fake.answer(query, signal)
    },
    count: async (_forge: string, host: string) => {
      fake.counts.push(host)
      return await fake.answerCount(host)
    },
    report: (error: unknown) => { fake.reported.push(error) },
  }
  return fake
}

const github: ForgeViewerSource = { forge: 'github', hosts: ['github.com'], filters: ALL, maxItems: 50 }

const hubs: ViewerLists[] = []

afterEach(async () => {
  for (const hub of hubs.splice(0)) await hub.dispose()
  vi.useRealTimers()
})

function hub(sources: ViewerListSources, settings: ViewerListTiming = timing): ViewerLists {
  const created = new ViewerLists(sources, settings)
  hubs.push(created)
  return created
}

/** Read frames of a stream in the background; `next` waits for the frame after those already taken. */
interface Followed<T> {
  readonly frames: T[]
  readonly next: (count?: number) => Promise<T>
  readonly done: Promise<void>
}

function follow<T>(stream: AsyncIterable<T>): Followed<T> {
  const frames: T[] = []
  const waiters: (() => void)[] = []
  const done = (async () => {
    for await (const frame of stream) {
      frames.push(frame)
      for (const waiter of waiters.splice(0)) waiter()
    }
  })()
  const next = async (count = frames.length + 1): Promise<T> => {
    while (frames.length < count) await new Promise<void>((resolve) => { waiters.push(resolve) })
    return frames[count - 1] as T
  }
  return { frames, next, done }
}

/** Wait until the predicate holds for the latest frame. */
async function until<T>(read: Followed<T>, predicate: (frame: T) => boolean): Promise<T> {
  for (;;) {
    const latest = read.frames.at(-1)
    if (latest !== undefined && predicate(latest)) return latest
    await read.next()
  }
}

describe('ViewerLists', () => {
  it('starts with empty lists, then reads every list of every host and reports each read', async () => {
    const fake = registry([github, { forge: 'gitlab', hosts: ['gitlab.example'], filters: new Set(['authored']), maxItems: 10 }])
    const controller = new AbortController()
    const read = follow(hub(fake).lists(null, controller.signal))
    const first = await read.next(1)
    expect(first.hosts.map(host => [host.forge, host.host, Object.keys(host.lists)])).toEqual([
      ['github', 'github.com', ['review-requested', 'authored', 'involved']],
      ['gitlab', 'gitlab.example', ['authored']],
    ])
    expect(first.hosts[0]?.lists['review-requested']).toEqual({ items: null, total: 0, fetchedAt: null, failure: null })
    const settled = await until(read, frame => !frame.reading && frame.hosts.every(host => host.viewer !== null))
    expect(settled.hosts[0]?.lists.authored).toEqual(expect.objectContaining({ items: [summary(2)], total: 3, failure: null }))
    expect(fake.calls).toEqual([
      { host: 'github.com', filter: 'review-requested', repository: null, limit: 20 },
      { host: 'gitlab.example', filter: 'authored', repository: null, limit: 10 },
      { host: 'github.com', filter: 'authored', repository: null, limit: 20 },
      { host: 'github.com', filter: 'involved', repository: null, limit: 20 },
    ])
    controller.abort()
    await read.done
  })

  it('keeps the previous items when a read fails and reads no further lists of a host that refuses the viewer', async () => {
    const fake = registry([github])
    const lists = hub(fake, { ...timing, listIntervalMs: 60_000 })
    const controller = new AbortController()
    const read = follow(lists.lists({ owner: 'octo', name: 'demo' }, controller.signal))
    await until(read, frame => !frame.reading && frame.hosts[0]?.lists.involved?.items !== null)
    fake.answer = async () => await Promise.resolve({ code: 'unauthenticated', message: 'sign in' })
    fake.calls.length = 0
    lists.refresh()
    const failed = await until(read, frame => (frame.hosts[0]?.lists.involved?.failure ?? null) !== null)
    expect(fake.calls).toEqual([{ host: 'github.com', filter: 'review-requested', repository: { owner: 'octo', name: 'demo' }, limit: 20 }])
    expect(failed.hosts[0]?.lists.involved).toEqual(expect.objectContaining({ items: [summary(1)], failure: { code: 'unauthenticated', message: 'sign in' } }))
    controller.abort()
    await read.done
  })

  it('turns a rejected read into an unavailable failure and reports it', async () => {
    const fake = registry([github])
    fake.answer = async () => await Promise.reject(new Error('boom'))
    const lists = hub(fake)
    const controller = new AbortController()
    const read = follow(lists.lists(null, controller.signal))
    const failed = await until(read, frame => frame.hosts[0]?.lists['review-requested']?.failure !== null)
    expect(failed.hosts[0]?.lists['review-requested']?.failure).toEqual({ code: 'unavailable', message: 'boom' })
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a provider's read may reject with a value that is not an Error
    fake.answer = async () => await Promise.reject('text')
    lists.refresh()
    await until(read, frame => frame.hosts[0]?.lists['review-requested']?.failure?.message === 'text')
    expect(fake.reported).toEqual([new Error('boom'), 'text'])
    controller.abort()
    await read.done
  })

  it('reports no read that rejects once the last stream of its scope ended', async () => {
    const fake = registry([github])
    fake.answer = async (_query, signal) => {
      await new Promise((resolve) => { signal.addEventListener('abort', resolve, { once: true }) })
      throw new Error('read aborted')
    }
    const controller = new AbortController()
    const read = follow(hub(fake).lists(null, controller.signal))
    await vi.waitFor(() => { expect(fake.calls).toHaveLength(1) })
    controller.abort()
    await read.done
    expect(fake.reported).toEqual([])
  })

  it('adds a list that a provider starts offering on a host it already lists', async () => {
    const fake = registry([{ ...github, filters: new Set(['authored']) }])
    const lists = hub(fake)
    const controller = new AbortController()
    const read = follow(lists.lists(null, controller.signal))
    const first = await until(read, frame => !frame.reading && frame.hosts[0]?.viewer !== null)
    expect(Object.keys(first.hosts[0]?.lists ?? {})).toEqual(['authored'])
    fake.sourcesNow = [github]
    lists.sourcesChanged()
    const grown = await until(read, frame => !frame.reading && (frame.hosts[0]?.lists.involved?.items ?? null) !== null)
    expect(grown.hosts[0]?.lists['review-requested']).toEqual(expect.objectContaining({ items: [summary(1)], total: 3, failure: null }))
    controller.abort()
    await read.done
  })

  it('shares one reader per repository scope, waits between rounds, backs off after failures, and stops with its last stream', async () => {
    vi.useFakeTimers()
    const fake = registry([github])
    fake.answer = async () => await Promise.resolve({ code: 'not-found', message: 'gone' })
    const lists = hub(fake)
    const first = new AbortController()
    const second = new AbortController()
    const one = follow(lists.lists(null, first.signal))
    const two = follow(lists.lists(null, second.signal))
    await vi.advanceTimersByTimeAsync(0)
    expect(fake.calls).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1_999)
    expect(fake.calls).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.calls).toHaveLength(6)
    await vi.advanceTimersByTimeAsync(4_000)
    expect(fake.calls).toHaveLength(9)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fake.calls).toHaveLength(12)
    first.abort()
    await one.done
    await vi.advanceTimersByTimeAsync(5_000)
    expect(fake.calls).toHaveLength(15)
    second.abort()
    await two.done
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fake.calls).toHaveLength(15)
  })

  it('counts review requests from its own reads and from lists of every repository', async () => {
    vi.useFakeTimers()
    const fake = registry([github, { forge: 'other', hosts: ['other.example'], filters: new Set(['authored']), maxItems: 5 }])
    const lists = hub(fake)
    const controller = new AbortController()
    const counts = follow<ForgeReviewCountFrame>(lists.count(controller.signal))
    await vi.advanceTimersByTimeAsync(0)
    expect(counts.frames).toEqual([{ reviewRequested: null }, { reviewRequested: 7 }])
    expect(fake.counts).toEqual(['github.com'])
    const listing = new AbortController()
    const read = follow<ForgeReviewFrame>(lists.lists(null, listing.signal))
    await vi.advanceTimersByTimeAsync(0)
    expect(counts.frames.at(-1)).toEqual({ reviewRequested: 3 })
    fake.answerCount = async () => await Promise.resolve({ code: 'unavailable', message: 'down' })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(fake.counts).toEqual(['github.com', 'github.com'])
    await vi.advanceTimersByTimeAsync(3_999)
    expect(fake.counts).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(fake.counts).toHaveLength(3)
    listing.abort()
    controller.abort()
    await Promise.all([read.done, counts.done])
  })

  it('keeps reading the count while another count stream lasts, and counts a host without review requests as zero', async () => {
    vi.useFakeTimers()
    const fake = registry([github])
    fake.answerCount = async () => await Promise.resolve(new Map<ForgeViewerFilter, number>([['authored', 2]]))
    const lists = hub(fake)
    const first = new AbortController()
    const second = new AbortController()
    const one = follow<ForgeReviewCountFrame>(lists.count(first.signal))
    const two = follow<ForgeReviewCountFrame>(lists.count(second.signal))
    await vi.advanceTimersByTimeAsync(0)
    expect(two.frames.at(-1)).toEqual({ reviewRequested: 0 })
    first.abort()
    await one.done
    await vi.advanceTimersByTimeAsync(2_000)
    expect(fake.counts).toEqual(['github.com', 'github.com'])
    second.abort()
    await two.done
  })

  it('forgets hosts whose provider left, publishes that, and reads the hosts that remain', async () => {
    const fake = registry([github, { forge: 'gitlab', hosts: ['gitlab.example'], filters: ALL, maxItems: 10 }])
    const lists = hub(fake)
    const controller = new AbortController()
    const read = follow(lists.lists(null, controller.signal))
    const counting = new AbortController()
    const counts = follow(lists.count(counting.signal))
    await until(read, frame => !frame.reading && frame.hosts.every(host => host.viewer !== null))
    await until(counts, frame => frame.reviewRequested === 6)
    fake.sourcesNow = [github]
    lists.sourcesChanged()
    const changed = await until(read, frame => frame.hosts.length === 1)
    expect(changed.hosts[0]?.host).toBe('github.com')
    await until(counts, frame => frame.reviewRequested === 3)
    controller.abort()
    counting.abort()
    await Promise.all([read.done, counts.done])
  })

  it('ends every stream when disposed and opens none afterwards', async () => {
    const lists = new ViewerLists(registry([github]), timing)
    const read = follow(lists.lists(null, new AbortController().signal))
    const counts = follow(lists.count(new AbortController().signal))
    await read.next(1)
    await lists.dispose()
    await Promise.all([read.done, counts.done])
    const after = follow(lists.lists(null, new AbortController().signal))
    const afterCounts = follow(lists.count(new AbortController().signal))
    await Promise.all([after.done, afterCounts.done])
    expect([after.frames, afterCounts.frames]).toEqual([[], []])
  })

  it('refuses a stream whose signal already aborted', async () => {
    const lists = hub(registry([github]))
    const signal = AbortSignal.abort(new Error('closed'))
    await expect(follow(lists.lists(null, signal)).done).rejects.toThrow('closed')
    await expect(follow(lists.count(signal)).done).rejects.toThrow('closed')
  })
})

describe('Reader', () => {
  it('keeps only the latest frame the reader has not taken and ends on abort', async () => {
    const controller = new AbortController()
    const reader = new Reader<number>(controller.signal)
    reader.push(1)
    reader.push(2)
    const iterator = reader.frames()[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ done: false, value: 2 })
    const pending = iterator.next()
    controller.abort()
    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    reader.push(3)
    reader.dispose()
  })
})
