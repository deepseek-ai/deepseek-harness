import { describe, expect, it, vi } from 'vitest'
import {
  RemoteJournalStream,
  RemoteStream,
  RemoteStreamCarrierError,
  type RemoteJournalChange,
  type RemoteJournalFrame,
  type RemoteStreamFactory,
  type RemoteStreamItem,
  type RemoteStreamOptions,
} from '../src/client/index.ts'

interface Entry {
  readonly seq: number
  readonly lastSeq?: number
}

interface Page {
  readonly entries: readonly Entry[]
  readonly hasMore: boolean
  readonly marker: string
}

interface PageRequest {
  readonly before?: number
  readonly limit?: number
}

type JournalFrame = RemoteJournalFrame<Entry, number, Page, string>
type ScriptedFrame = JournalFrame

interface Generation {
  readonly frames: readonly (
    ScriptedFrame | Promise<ScriptedFrame>
  )[]
  readonly terminal?: Error
  readonly hold?: boolean
  readonly waitAfterFrames?: Promise<void>
  readonly afterFrame?: (index: number) => void
}

type PageSource = Page | Promise<Page> | ((signal: AbortSignal) => Promise<Page>)

const AVAILABLE_CONNECTION = {
  generation: {
    getSnapshot: () => ({ id: 1, host: { home: '/home/fixture' } }),
    subscribe: () => () => {},
  },
}

const entries = (...seqs: number[]): Entry[] => seqs.map(seq => ({ seq }))

const rangedEntry = (first: number, last: number): Entry => ({ seq: first, lastSeq: last })

const page = (marker: string, seqs: number[], hasMore = false): Page => ({
  entries: entries(...seqs),
  hasMore,
  marker,
})

const rangedPage = (marker: string, values: Entry[], hasMore = false): Page => ({
  entries: values,
  hasMore,
  marker,
})

const STREAM_FACTORY = {
  $stream<Item>(options: RemoteStreamOptions<Item>): RemoteStream<Item> {
    return new RemoteStream(AVAILABLE_CONNECTION, options)
  },
}

class FixtureJournal extends RemoteJournalStream<Page, Entry, number, PageRequest, string> {
  constructor(
    private readonly generations: Generation[],
    private readonly pages: PageSource[],
    private readonly calls: string[],
    private readonly pageRequests: PageRequest[],
    private readonly pageCursors: number[],
    private readonly followRequests: PageRequest[],
    changes: RemoteJournalChange<Page, Entry, string>[],
    failed: (error: unknown) => void,
    factory: RemoteStreamFactory = STREAM_FACTORY,
  ) {
    super(factory, {
      name: 'fixture journal',
      emptyCursor: -1,
      entries: value => value.entries,
      hasMore: value => value.hasMore,
      first: entry => entry.seq,
      last: entry => entry.lastSeq ?? entry.seq,
      compare: (left, right) => left - right,
      follows: (left, right) => right === left + 1,
      publish: (change) => { changes.push(change) },
      failed,
    })
  }

  /** @inheritdoc */
  protected override async * follow(
    request: PageRequest,
    signal: AbortSignal,
  ): AsyncIterable<JournalFrame> {
    this.calls.push('follow')
    this.followRequests.push(request)
    const generation = this.generations.shift()
    if (generation === undefined) throw new Error('no scripted journal generation')
    for (const [index, frame] of generation.frames.entries()) {
      yield await frame
      generation.afterFrame?.(index)
    }
    await generation.waitAfterFrames
    if (generation.terminal !== undefined) throw generation.terminal
    if (generation.hold === true && !signal.aborted) {
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
  }

  /** @inheritdoc */
  protected override readPage(
    request: PageRequest,
    through: number,
    signal: AbortSignal,
  ): Promise<Page> {
    this.calls.push('page')
    this.pageRequests.push(request)
    this.pageCursors.push(through)
    const value = this.pages.shift()
    if (value === undefined) throw new Error('no scripted journal page')
    return typeof value === 'function' ? value(signal) : Promise.resolve(value)
  }

  /** @inheritdoc */
  protected override repairRequest(request: PageRequest): PageRequest {
    return request.limit === undefined ? {} : { limit: request.limit }
  }
}

function journalFixture(
  generations: Generation[],
  pages: PageSource[],
  factory: RemoteStreamFactory = STREAM_FACTORY,
): {
  readonly journal: RemoteJournalStream<Page, Entry, number, PageRequest, string>
  readonly changes: RemoteJournalChange<Page, Entry, string>[]
  readonly failed: ReturnType<typeof vi.fn>
  readonly calls: string[]
  readonly pageRequests: PageRequest[]
  readonly pageCursors: number[]
  readonly followRequests: PageRequest[]
} {
  const calls: string[] = []
  const pageRequests: PageRequest[] = []
  const pageCursors: number[] = []
  const followRequests: PageRequest[] = []
  const changes: RemoteJournalChange<Page, Entry, string>[] = []
  const failed = vi.fn()
  const journal = new FixtureJournal(
    generations,
    pages,
    calls,
    pageRequests,
    pageCursors,
    followRequests,
    changes,
    failed,
    factory,
  )
  return { journal, changes, failed, calls, pageRequests, pageCursors, followRequests }
}

function opened(cursor: number, value: Page): JournalFrame {
  return { type: 'opened', cursor, page: value }
}

function remoteItem(
  generation: number,
  value: ScriptedFrame,
  signal: AbortSignal,
): RemoteStreamItem<JournalFrame> {
  return { generation, value, signal, accept: vi.fn() }
}

function controlledFactory(
  next: () => Promise<IteratorResult<RemoteStreamItem<JournalFrame>>>,
): RemoteStreamFactory {
  const lifetime = new AbortController()
  return {
    $stream<Item>(): RemoteStream<Item> {
      const iterator = {
        next,
        return: async () => ({ done: true as const, value: undefined }),
      }
      return {
        signal: lifetime.signal,
        restart: () => {},
        dispose: async () => { lifetime.abort() },
        [Symbol.asyncIterator]: () => iterator,
      } as unknown as RemoteStream<Item>
    },
  }
}

describe('RemoteJournalStream', () => {
  it('publishes cursorless notifications without advancing the durable page cursor', async () => {
    const live = Promise.withResolvers<ScriptedFrame>()
    const fixture = journalFixture(
      [{ frames: [opened(-1, page('empty', [])), { type: 'notification', notification: 'partial' }, live.promise], hold: true }],
      [page('older', [])],
    )

    await fixture.journal.open({})
    await vi.waitFor(() => { expect(fixture.changes).toHaveLength(2) })
    await fixture.journal.prepend({})
    live.resolve({ type: 'entry', entry: { seq: 0 } })
    await vi.waitFor(() => { expect(fixture.changes).toHaveLength(4) })

    expect(fixture.pageCursors).toEqual([-1])
    expect(fixture.changes.map(change => change.type)).toEqual([
      'replace', 'notification', 'prepend', 'append',
    ])
    await fixture.journal.dispose()
  })

  it('defers notifications behind a durable gap until replacement commits', async () => {
    const repair = Promise.withResolvers<Page>()
    const fixture = journalFixture(
      [{
        frames: [
          opened(0, page('initial', [0])),
          { type: 'entry', entry: { seq: 2 } },
          { type: 'notification', notification: 'after-gap' },
        ],
        hold: true,
      }],
      [repair.promise],
    )

    await fixture.journal.open({})
    await vi.waitFor(() => { expect(fixture.pageCursors).toEqual([2]) })
    expect(fixture.changes.map(change => change.type)).toEqual(['replace'])
    repair.resolve(page('repair', [0, 1, 2]))
    await vi.waitFor(() => { expect(fixture.changes).toHaveLength(3) })

    expect(fixture.changes.map(change => change.type)).toEqual([
      'replace', 'replace', 'notification',
    ])
    await fixture.journal.dispose()
  })

  it('replaces from pages whose entries cover contiguous cursor ranges', async () => {
    const snapshot = rangedPage(
      'ranged',
      [rangedEntry(0, 2), rangedEntry(3, 5)],
      true,
    )
    const fixture = journalFixture(
      [{ frames: [opened(5, snapshot)], hold: true }],
      [],
    )

    await fixture.journal.open({})

    expect(fixture.changes).toEqual([{
      type: 'replace',
      page: snapshot,
      entries: snapshot.entries,
      hasMore: true,
    }])
    await fixture.journal.dispose()
  })

  it('rejects an inverted cursor range', async () => {
    const fixture = journalFixture(
      [{ frames: [opened(2, rangedPage('inverted', [rangedEntry(3, 2)]))], hold: true }],
      [],
    )

    await expect(fixture.journal.open({})).rejects.toThrow(
      'fixture journal entry has an inverted cursor range',
    )
    expect(fixture.changes).toEqual([])
  })

  it('opens from the follow snapshot, removes overlap, appends live entries, and prepends history', async () => {
    const fixture = journalFixture(
      [{
        frames: [
          opened(3, page('tail', [2, 3], true)),
          { type: 'entry', entry: { seq: 3 } },
          { type: 'entry', entry: { seq: 4 } },
        ],
        hold: true,
      }],
      [page('older', [0, 1])],
    )

    await fixture.journal.open({ limit: 2 })
    await vi.waitFor(() => { expect(fixture.changes).toHaveLength(2) })
    await fixture.journal.prepend({ before: 2, limit: 2 })

    expect(fixture.calls.slice(0, 2)).toEqual(['follow', 'page'])
    expect(fixture.pageRequests).toEqual([{ before: 2, limit: 2 }])
    expect(fixture.pageCursors).toEqual([4])
    expect(fixture.changes).toEqual([
      { type: 'replace', page: page('tail', [2, 3], true), entries: entries(2, 3), hasMore: true },
      { type: 'append', entry: { seq: 4 } },
      { type: 'prepend', page: page('older', [0, 1]), entries: entries(0, 1), hasMore: false },
    ])
    await fixture.journal.dispose()
    await fixture.journal.dispose()
  })

  it('exposes its shared cancellation signal', async () => {
    const fixture = journalFixture(
      [{ frames: [opened(-1, page('empty', []))], hold: true }],
      [],
    )

    expect(fixture.journal.signal.aborted).toBe(false)
    await fixture.journal.open({})
    await fixture.journal.dispose()
    expect(fixture.journal.signal.aborted).toBe(true)
  })

  it('classifies normal endings before initial and resumed opening cursors', async () => {
    const initial = journalFixture([{ frames: [] }], [])
    await expect(initial.journal.open({})).rejects.toThrow(
      'fixture journal ended before its opening cursor',
    )

    const finish = Promise.withResolvers<undefined>()
    const resumed = journalFixture(
      [
        { frames: [opened(0, page('initial', [0]))], waitAfterFrames: finish.promise },
        { frames: [] },
      ],
      [],
    )
    await resumed.journal.open({})
    finish.resolve(undefined)
    await vi.waitFor(() => { expect(resumed.failed).toHaveBeenCalledOnce() })
    expect(resumed.failed.mock.calls[0]?.[0]).toMatchObject({
      message: 'resumed fixture journal ended before its opening cursor',
    })
    await resumed.journal.dispose()
  })

  it('prepends into an empty window and accepts its first live entry', async () => {
    const empty = journalFixture(
      [{ frames: [opened(-1, page('empty', []))], hold: true }],
      [page('older', [0]), page('oldest', [])],
    )
    await empty.journal.open({})
    await empty.journal.prepend({})
    expect(empty.changes.at(-1)).toEqual({
      type: 'prepend', page: page('older', [0]), entries: entries(0), hasMore: false,
    })
    await empty.journal.prepend({})
    expect(empty.changes.at(-1)).toEqual({
      type: 'prepend', page: page('oldest', []), entries: [], hasMore: false,
    })
    await empty.journal.dispose()

    const live = Promise.withResolvers<ScriptedFrame>()
    const followed = journalFixture(
      [{ frames: [opened(-1, page('empty', [])), live.promise], hold: true }],
      [],
    )
    await followed.journal.open({})
    live.resolve({ type: 'entry', entry: { seq: 0 } })
    await vi.waitFor(() => { expect(followed.changes).toHaveLength(2) })
    expect(followed.changes.at(-1)).toEqual({ type: 'append', entry: { seq: 0 } })
    await followed.journal.dispose()
  })

  it('prepends at the first cursor and rejects a partially overlapping ranged entry', async () => {
    const initial = rangedPage('initial', [rangedEntry(4, 6)], true)
    const older = rangedPage('older', [rangedEntry(0, 3)])
    const fixture = journalFixture(
      [{ frames: [opened(6, initial)], hold: true }],
      [older],
    )

    await fixture.journal.open({})
    await fixture.journal.prepend({ before: 4 })

    expect(fixture.pageCursors).toEqual([6])
    expect(fixture.changes.at(-1)).toEqual({
      type: 'prepend', page: older, entries: older.entries, hasMore: false,
    })
    await fixture.journal.dispose()

    const overlap = rangedPage('overlap', [rangedEntry(0, 4)], true)
    const overlapping = journalFixture(
      [{ frames: [opened(6, initial)], hold: true }],
      [overlap],
    )
    await overlapping.journal.open({})

    await expect(overlapping.journal.prepend({ before: 4 })).rejects.toThrow(
      'history page is discontinuous',
    )
    expect(overlapping.changes.at(-1)).toEqual({
      type: 'prepend', page: overlap, entries: [], hasMore: false,
    })
    await overlapping.journal.dispose()
  })

  it('deduplicates complete ranged entries and rejects partial live overlap', async () => {
    const initial = rangedPage('initial', [rangedEntry(0, 2)])
    const fixture = journalFixture(
      [{
        frames: [
          opened(2, initial),
          { type: 'entry', entry: rangedEntry(0, 2) },
          { type: 'entry', entry: rangedEntry(3, 5) },
          { type: 'entry', entry: rangedEntry(5, 7) },
        ],
        hold: true,
      }],
      [],
    )

    await fixture.journal.open({})
    await vi.waitFor(() => { expect(fixture.failed).toHaveBeenCalledOnce() })

    expect(fixture.changes).toHaveLength(2)
    expect(fixture.changes.at(-1)).toEqual({
      type: 'append', entry: rangedEntry(3, 5),
    })
    expect(fixture.failed.mock.calls[0]?.[0]).toMatchObject({
      message: 'fixture journal emitted a partially overlapping entry',
    })
    await fixture.journal.dispose()
  })

  it('repairs a replacement generation through one tail page and drops replay overlap', async () => {
    const lost = new RemoteStreamCarrierError('carrier lost')
    const fixture = journalFixture(
      [
        {
          frames: [
            opened(1, page('initial', [0, 1])),
            { type: 'entry', entry: { seq: 2 } },
          ],
          terminal: lost,
        },
        {
          frames: [
            opened(4, page('replacement', [0, 1, 2, 3, 4])),
            { type: 'entry', entry: { seq: 3 } },
            { type: 'entry', entry: { seq: 4 } },
          ],
          hold: true,
        },
      ],
      [],
    )

    await fixture.journal.open({ limit: 5 })
    await vi.waitFor(() => { expect(fixture.changes).toHaveLength(3) })

    expect(fixture.changes.map(change => change.type)).toEqual(['replace', 'append', 'replace'])
    expect(fixture.changes[2]).toMatchObject({
      type: 'replace', page: { marker: 'replacement' }, entries: entries(0, 1, 2, 3, 4),
    })
    expect(fixture.followRequests).toEqual([{ limit: 5 }, { limit: 5 }])
    expect(fixture.pageCursors).toEqual([])
    expect(fixture.failed).not.toHaveBeenCalled()
    await fixture.journal.dispose()
  })

  it('restarts a page aborted with its carrier generation', async () => {
    const fixture = journalFixture(
      [
        {
          frames: [
            opened(1, page('initial', [0, 1])),
            { type: 'entry', entry: { seq: 3 } },
          ],
          terminal: new RemoteStreamCarrierError('carrier lost during page'),
        },
        {
          frames: [opened(3, page('replacement', [0, 1, 2, 3]))],
          hold: true,
        },
      ],
      [
        signal => new Promise<Page>((_resolve, reject) => {
          const aborted = (): void => { reject(new Error('page aborted')) }
          signal.addEventListener('abort', aborted, { once: true })
          if (signal.aborted) aborted()
        }),
      ],
    )

    await fixture.journal.open({ limit: 3 })
    await vi.waitFor(() => { expect(fixture.changes).toHaveLength(2) })

    expect(fixture.changes).toEqual([
      {
        type: 'replace',
        page: page('initial', [0, 1]),
        entries: entries(0, 1),
        hasMore: false,
      },
      {
        type: 'replace',
        page: page('replacement', [0, 1, 2, 3]),
        entries: entries(0, 1, 2, 3),
        hasMore: false,
      },
    ])
    expect(fixture.pageCursors).toEqual([3])
    expect(fixture.followRequests).toEqual([{ limit: 3 }, { limit: 3 }])
    expect(fixture.failed).not.toHaveBeenCalled()
    await fixture.journal.dispose()
  })

  it('repairs a live gap before publishing another change', async () => {
    const fixture = journalFixture(
      [{
        frames: [
          opened(1, page('initial', [0, 1])),
          { type: 'entry', entry: { seq: 4 } },
        ],
        hold: true,
      }],
      [page('repair', [0, 1, 2, 3, 4])],
    )

    await fixture.journal.open({})
    await vi.waitFor(() => { expect(fixture.changes).toHaveLength(2) })

    expect(fixture.changes.map(change => change.type)).toEqual(['replace', 'replace'])
    expect(fixture.changes[1]).toMatchObject({ page: { marker: 'repair' } })
    expect(fixture.pageCursors).toEqual([4])
    await fixture.journal.dispose()
  })

  it('reports a page failure during live-gap repair', async () => {
    const fixture = journalFixture(
      [{
        frames: [
          opened(0, page('initial', [0])),
          { type: 'entry', entry: { seq: 2 } },
        ],
        hold: true,
      }],
      [() => Promise.reject(new Error('repair page failed'))],
    )

    await fixture.journal.open({})
    await vi.waitFor(() => { expect(fixture.failed).toHaveBeenCalledOnce() })

    expect(fixture.failed.mock.calls[0]?.[0]).toMatchObject({ message: 'repair page failed' })
    expect(fixture.changes).toHaveLength(1)
    await fixture.journal.dispose()
  })

  it('replaces a superseded live-gap repair with the next generation', async () => {
    const gap = Promise.withResolvers<ScriptedFrame>()
    const fixture = journalFixture(
      [
        {
          frames: [opened(1, page('initial', [0, 1])), gap.promise],
          terminal: new RemoteStreamCarrierError('generation lost'),
        },
        { frames: [opened(4, page('replacement', [0, 1, 2, 3, 4]))], hold: true },
      ],
      [
        () => new Promise<Page>(() => {}),
      ],
    )

    await fixture.journal.open({ limit: 5 })
    gap.resolve({ type: 'entry', entry: { seq: 4 } })
    await vi.waitFor(() => { expect(fixture.changes).toHaveLength(2) })
    expect(fixture.changes.at(-1)).toMatchObject({
      type: 'replace', page: { marker: 'replacement' }, entries: entries(0, 1, 2, 3, 4),
    })
    await fixture.journal.dispose()
  })

  it('replaces a superseded second repair page with the next generation', async () => {
    const firstLive = Promise.withResolvers<ScriptedFrame>()
    const secondLive = Promise.withResolvers<ScriptedFrame>()
    const secondConsumed = Promise.withResolvers<undefined>()
    const firstRepair = Promise.withResolvers<Page>()
    const finish = Promise.withResolvers<undefined>()
    const fixture = journalFixture(
      [
        {
          frames: [
            opened(1, page('initial', [0, 1])),
            firstLive.promise,
            secondLive.promise,
          ],
          waitAfterFrames: finish.promise,
          terminal: new RemoteStreamCarrierError('generation lost'),
          afterFrame: (index) => { if (index === 2) secondConsumed.resolve(undefined) },
        },
        { frames: [opened(5, page('replacement', [0, 1, 2, 3, 4, 5]))], hold: true },
      ],
      [
        firstRepair.promise,
        signal => new Promise<Page>((_resolve, reject) => {
          signal.addEventListener('abort', () => { reject(new Error('page aborted')) }, { once: true })
        }),
      ],
    )

    await fixture.journal.open({})
    firstLive.resolve({ type: 'entry', entry: { seq: 3 } })
    await vi.waitFor(() => { expect(fixture.pageCursors).toEqual([3]) })
    secondLive.resolve({ type: 'entry', entry: { seq: 5 } })
    await secondConsumed.promise
    firstRepair.resolve(page('first-repair', [0, 1, 2, 3]))
    await vi.waitFor(() => { expect(fixture.pageCursors).toEqual([3, 5]) })
    finish.resolve(undefined)
    await vi.waitFor(() => { expect(fixture.changes).toHaveLength(2) })

    expect(fixture.pageCursors).toEqual([3, 5])
    expect(fixture.changes).toEqual([
      {
        type: 'replace',
        page: page('initial', [0, 1]),
        entries: entries(0, 1),
        hasMore: false,
      },
      {
        type: 'replace',
        page: page('replacement', [0, 1, 2, 3, 4, 5]),
        entries: entries(0, 1, 2, 3, 4, 5),
        hasMore: false,
      },
    ])
    await fixture.journal.dispose()
  })

  it('rereads the tail when queued entries advance beyond the first repair page', async () => {
    const firstLive = Promise.withResolvers<ScriptedFrame>()
    const secondLive = Promise.withResolvers<ScriptedFrame>()
    const secondConsumed = Promise.withResolvers<undefined>()
    const firstRepair = Promise.withResolvers<Page>()
    const fixture = journalFixture(
      [{
        frames: [
          opened(1, page('initial', [0, 1])),
          firstLive.promise,
          secondLive.promise,
        ],
        hold: true,
        afterFrame: (index) => { if (index === 2) secondConsumed.resolve(undefined) },
      }],
      [firstRepair.promise, page('repair', [0, 1, 2, 3, 4, 5])],
    )

    await fixture.journal.open({ limit: 4 })
    firstLive.resolve({ type: 'entry', entry: { seq: 3 } })
    await vi.waitFor(() => { expect(fixture.pageCursors).toEqual([3]) })
    secondLive.resolve({ type: 'entry', entry: { seq: 5 } })
    await secondConsumed.promise
    firstRepair.resolve(page('first-repair', [0, 1, 2, 3]))
    await vi.waitFor(() => { expect(fixture.changes).toHaveLength(2) })

    expect(fixture.pageCursors).toEqual([3, 5])
    expect(fixture.changes.at(-1)).toEqual({
      type: 'replace',
      page: page('repair', [0, 1, 2, 3, 4, 5]),
      entries: entries(0, 1, 2, 3, 4, 5),
      hasMore: false,
    })
    await fixture.journal.dispose()
  })

  it('merges contiguous entries that arrive while a replacement page is loading', async () => {
    const firstLive = Promise.withResolvers<ScriptedFrame>()
    const secondLive = Promise.withResolvers<ScriptedFrame>()
    const secondConsumed = Promise.withResolvers<undefined>()
    const repair = Promise.withResolvers<Page>()
    const fixture = journalFixture(
      [{
        frames: [
          opened(1, page('initial', [0, 1])),
          firstLive.promise,
          secondLive.promise,
        ],
        hold: true,
        afterFrame: (index) => { if (index === 2) secondConsumed.resolve(undefined) },
      }],
      [repair.promise],
    )

    await fixture.journal.open({})
    firstLive.resolve({ type: 'entry', entry: { seq: 3 } })
    await vi.waitFor(() => { expect(fixture.pageCursors).toEqual([3]) })
    secondLive.resolve({ type: 'entry', entry: { seq: 4 } })
    await secondConsumed.promise
    repair.resolve(page('repair', [0, 1, 2, 3]))
    await vi.waitFor(() => { expect(fixture.changes).toHaveLength(2) })

    expect(fixture.changes.at(-1)).toEqual({
      type: 'replace',
      page: page('repair', [0, 1, 2, 3]),
      entries: entries(0, 1, 2, 3, 4),
      hasMore: false,
    })
    await fixture.journal.dispose()
  })

  it('rejects a partially overlapping ranged entry queued during repair', async () => {
    const firstLive = Promise.withResolvers<ScriptedFrame>()
    const secondLive = Promise.withResolvers<ScriptedFrame>()
    const secondConsumed = Promise.withResolvers<undefined>()
    const repair = Promise.withResolvers<Page>()
    const fixture = journalFixture(
      [{
        frames: [
          opened(1, page('initial', [0, 1])),
          firstLive.promise,
          secondLive.promise,
        ],
        hold: true,
        afterFrame: (index) => { if (index === 2) secondConsumed.resolve(undefined) },
      }],
      [repair.promise],
    )

    await fixture.journal.open({})
    firstLive.resolve({ type: 'entry', entry: rangedEntry(3, 5) })
    await vi.waitFor(() => { expect(fixture.pageCursors).toEqual([5]) })
    secondLive.resolve({ type: 'entry', entry: rangedEntry(5, 7) })
    await secondConsumed.promise
    repair.resolve(rangedPage('repair', [rangedEntry(0, 2), rangedEntry(3, 5)]))

    await vi.waitFor(() => { expect(fixture.failed).toHaveBeenCalledOnce() })
    expect(fixture.changes).toHaveLength(1)
    expect(fixture.failed.mock.calls[0]?.[0]).toMatchObject({
      message: 'fixture journal replacement contains a partially overlapping entry',
    })
    await fixture.journal.dispose()
  })

  it('rejects when queued entries advance beyond the second repair page', async () => {
    const firstLive = Promise.withResolvers<ScriptedFrame>()
    const secondLive = Promise.withResolvers<ScriptedFrame>()
    const thirdLive = Promise.withResolvers<ScriptedFrame>()
    const secondConsumed = Promise.withResolvers<undefined>()
    const thirdConsumed = Promise.withResolvers<undefined>()
    const firstRepair = Promise.withResolvers<Page>()
    const secondRepair = Promise.withResolvers<Page>()
    const fixture = journalFixture(
      [{
        frames: [
          opened(1, page('initial', [0, 1])),
          firstLive.promise,
          secondLive.promise,
          thirdLive.promise,
        ],
        hold: true,
        afterFrame: (index) => {
          if (index === 2) secondConsumed.resolve(undefined)
          if (index === 3) thirdConsumed.resolve(undefined)
        },
      }],
      [firstRepair.promise, secondRepair.promise],
    )

    await fixture.journal.open({})
    firstLive.resolve({ type: 'entry', entry: { seq: 3 } })
    await vi.waitFor(() => { expect(fixture.pageCursors).toEqual([3]) })
    secondLive.resolve({ type: 'entry', entry: { seq: 5 } })
    await secondConsumed.promise
    firstRepair.resolve(page('first-repair', [0, 1, 2, 3]))
    await vi.waitFor(() => { expect(fixture.pageCursors).toEqual([3, 5]) })
    thirdLive.resolve({ type: 'entry', entry: { seq: 7 } })
    await thirdConsumed.promise
    secondRepair.resolve(page('second-repair', [0, 1, 2, 3, 4, 5]))

    await vi.waitFor(() => { expect(fixture.failed).toHaveBeenCalledOnce() })
    expect(fixture.failed.mock.calls[0]?.[0]).toMatchObject({
      message: 'fixture journal page did not reach its opening cursor',
    })
    await fixture.journal.dispose()
  })

  it('reports a resumed generation that emits an entry before its cursor', async () => {
    const finish = Promise.withResolvers<undefined>()
    const fixture = journalFixture(
      [
        {
          frames: [opened(0, page('initial', [0]))],
          waitAfterFrames: finish.promise,
          terminal: new RemoteStreamCarrierError('lost'),
        },
        { frames: [{ type: 'entry', entry: { seq: 1 } }] },
      ],
      [],
    )

    await fixture.journal.open({})
    finish.resolve(undefined)
    await vi.waitFor(() => { expect(fixture.failed).toHaveBeenCalledOnce() })
    expect(fixture.failed.mock.calls[0]?.[0]).toMatchObject({
      message: 'resumed fixture journal emitted an entry before its opening cursor',
    })
    await fixture.journal.dispose()
  })

  it('reports a duplicate opening cursor after the initial page is published', async () => {
    const duplicate = Promise.withResolvers<ScriptedFrame>()
    const fixture = journalFixture(
      [{ frames: [opened(0, page('initial', [0])), duplicate.promise], hold: true }],
      [],
    )

    await fixture.journal.open({})
    duplicate.resolve(opened(0, page('duplicate', [0])))
    await vi.waitFor(() => { expect(fixture.failed).toHaveBeenCalledOnce() })
    expect(fixture.failed.mock.calls[0]?.[0]).toMatchObject({
      message: 'fixture journal emitted more than one opening cursor',
    })
    await fixture.journal.dispose()
  })

  it('reports a follow failure after publishing its opening snapshot', async () => {
    const failedFollow = journalFixture(
      [{ frames: [opened(0, page('initial', [0]))], terminal: new Error('follow failed') }],
      [],
    )
    await failedFollow.journal.open({})
    await vi.waitFor(() => { expect(failedFollow.failed).toHaveBeenCalledOnce() })
    expect(failedFollow.failed.mock.calls[0]?.[0]).toMatchObject({ message: 'follow failed' })
    expect(failedFollow.changes).toHaveLength(1)
    await failedFollow.journal.dispose()
  })

  it('rejects an iterator that ends before its opening cursor', async () => {
    const factory = controlledFactory(() => Promise.resolve({ done: true, value: undefined }))
    const fixture = journalFixture([], [], factory)

    await expect(fixture.journal.open({})).rejects.toThrow(
      'ended before its opening cursor',
    )
  })

  it('suppresses a consumer failure after disposal begins', async () => {
    const generation = new AbortController()
    const next = Promise.withResolvers<IteratorResult<RemoteStreamItem<JournalFrame>>>()
    const results = [
      Promise.resolve<IteratorResult<RemoteStreamItem<JournalFrame>>>({
        done: false,
        value: remoteItem(1, opened(0, page('initial', [0])), generation.signal),
      }),
      next.promise,
    ]
    const fixture = journalFixture(
      [],
      [],
      controlledFactory(() => results.shift() ?? Promise.resolve({ done: true, value: undefined })),
    )

    await fixture.journal.open({})
    const closing = fixture.journal.dispose()
    next.resolve({
      done: false,
      value: remoteItem(1, opened(0, page('duplicate', [0])), generation.signal),
    })
    await closing
    expect(fixture.failed).not.toHaveBeenCalled()
  })

  it.each([
    { name: 'ends', final: { done: true as const, value: undefined }, message: 'ended while replacing' },
    {
      name: 'emits another opening cursor',
      final: undefined,
      message: 'more than one opening cursor',
    },
  ])('reports when an aborted repair generation $name', async ({ final, message }) => {
    const generation = new AbortController()
    const gap = Promise.withResolvers<IteratorResult<RemoteStreamItem<JournalFrame>>>()
    const replacement = Promise.withResolvers<IteratorResult<RemoteStreamItem<JournalFrame>>>()
    const results = [
      Promise.resolve<IteratorResult<RemoteStreamItem<JournalFrame>>>({
        done: false,
        value: remoteItem(1, opened(0, page('initial', [0])), generation.signal),
      }),
      gap.promise,
      replacement.promise,
    ]
    const fixture = journalFixture(
      [],
      [signal => new Promise<Page>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('page aborted')) }, { once: true })
      })],
      controlledFactory(() => results.shift() ?? Promise.resolve({ done: true, value: undefined })),
    )

    await fixture.journal.open({})
    gap.resolve({
      done: false,
      value: remoteItem(1, { type: 'entry', entry: { seq: 2 } }, generation.signal),
    })
    await vi.waitFor(() => { expect(fixture.pageCursors).toEqual([2]) })
    generation.abort()
    if (final === undefined) {
      replacement.resolve({
        done: false,
        value: remoteItem(1, opened(2, page('duplicate', [0, 1, 2])), generation.signal),
      })
    } else {
      replacement.resolve(final)
    }
    await vi.waitFor(() => { expect(fixture.failed).toHaveBeenCalledOnce() })
    const failure: unknown = fixture.failed.mock.calls[0]?.[0]
    expect(failure).toBeInstanceOf(Error)
    if (!(failure instanceof Error)) throw new Error('journal failure was not an Error')
    expect(failure.message).toContain(message)
    await fixture.journal.dispose()
  })

  it('discards old-generation entries while waiting for the replacement opening', async () => {
    const generation = new AbortController()
    const gap = Promise.withResolvers<IteratorResult<RemoteStreamItem<JournalFrame>>>()
    const stale = Promise.withResolvers<IteratorResult<RemoteStreamItem<JournalFrame>>>()
    const replacement = Promise.withResolvers<IteratorResult<RemoteStreamItem<JournalFrame>>>()
    const results = [
      Promise.resolve<IteratorResult<RemoteStreamItem<JournalFrame>>>({
        done: false,
        value: remoteItem(1, opened(0, page('initial', [0])), generation.signal),
      }),
      gap.promise,
      stale.promise,
      replacement.promise,
    ]
    const fixture = journalFixture(
      [],
      [signal => new Promise<Page>((_resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new Error('page aborted')) }, { once: true })
      })],
      controlledFactory(() => results.shift() ?? Promise.resolve({ done: true, value: undefined })),
    )

    await fixture.journal.open({})
    gap.resolve({
      done: false,
      value: remoteItem(1, { type: 'entry', entry: { seq: 2 } }, generation.signal),
    })
    await vi.waitFor(() => { expect(fixture.pageCursors).toEqual([2]) })
    generation.abort()
    stale.resolve({
      done: false,
      value: remoteItem(1, { type: 'entry', entry: { seq: 1 } }, generation.signal),
    })
    replacement.resolve({
      done: false,
      value: remoteItem(2, opened(2, page('replacement', [0, 1, 2])), new AbortController().signal),
    })

    await vi.waitFor(() => { expect(fixture.changes).toHaveLength(2) })
    expect(fixture.changes.at(-1)).toMatchObject({ page: { marker: 'replacement' } })
    await fixture.journal.dispose()
  })

  it.each([
    {
      name: 'rejects',
      settle: (
        _resolve: (value: IteratorResult<RemoteStreamItem<JournalFrame>>) => void,
        reject: (reason?: unknown) => void,
      ) => { reject(new Error('replacement follow failed')) },
      message: 'replacement follow failed',
    },
    {
      name: 'ends',
      settle: (resolve: (value: IteratorResult<RemoteStreamItem<JournalFrame>>) => void) => {
        resolve({ done: true, value: undefined })
      },
      message: 'ended while reading its replacement page',
    },
    {
      name: 'opens twice',
      settle: (resolve: (value: IteratorResult<RemoteStreamItem<JournalFrame>>) => void) => {
        resolve({
          done: false,
          value: remoteItem(1, opened(2, page('duplicate', [0, 1, 2])), new AbortController().signal),
        })
      },
      message: 'more than one opening cursor',
    },
  ])('reports when a follow $name during live-gap repair', async ({ settle, message }) => {
    const generation = new AbortController()
    const gap = Promise.withResolvers<IteratorResult<RemoteStreamItem<JournalFrame>>>()
    const next = Promise.withResolvers<IteratorResult<RemoteStreamItem<JournalFrame>>>()
    const results = [
      Promise.resolve<IteratorResult<RemoteStreamItem<JournalFrame>>>({
        done: false,
        value: remoteItem(1, opened(0, page('initial', [0])), generation.signal),
      }),
      gap.promise,
      next.promise,
    ]
    const fixture = journalFixture(
      [],
      [() => new Promise<Page>(() => {})],
      controlledFactory(() => results.shift() ?? Promise.resolve({ done: true, value: undefined })),
    )

    await fixture.journal.open({})
    gap.resolve({
      done: false,
      value: remoteItem(1, { type: 'entry', entry: { seq: 2 } }, generation.signal),
    })
    await vi.waitFor(() => { expect(fixture.pageCursors).toEqual([2]) })
    settle(next.resolve, next.reject)

    await vi.waitFor(() => { expect(fixture.failed).toHaveBeenCalledOnce() })
    const failure: unknown = fixture.failed.mock.calls[0]?.[0]
    expect(failure).toBeInstanceOf(Error)
    if (!(failure instanceof Error)) throw new Error('journal failure was not an Error')
    expect(failure.message).toContain(message)
    await fixture.journal.dispose()
  })

  it('rejects malformed opening and page sequences', async () => {
    const beforeOpening = journalFixture(
      [{ frames: [{ type: 'entry', entry: { seq: 0 } }] }],
      [],
    )
    await expect(beforeOpening.journal.open({})).rejects.toThrow('entry before its opening cursor')

    const discontinuousPage = journalFixture(
      [{ frames: [opened(3, page('bad', [0, 2, 3]))], hold: true }],
      [],
    )
    await expect(discontinuousPage.journal.open({})).rejects.toThrow('page contains discontinuous entries')

    const shortPage = journalFixture(
      [{ frames: [opened(3, page('short', [0, 1]))], hold: true }],
      [],
    )
    await expect(shortPage.journal.open({})).rejects.toThrow('page did not end at its requested cursor')

    const longPage = journalFixture(
      [{ frames: [opened(1, page('long', [0, 1, 2]))], hold: true }],
      [],
    )
    await expect(longPage.journal.open({})).rejects.toThrow('page did not end at its requested cursor')
  })

  it('reports duplicate and regressed generation cursors as terminal failures', async () => {
    const duplicate = journalFixture(
      [{
        frames: [
          opened(1, page('initial', [0, 1])),
          opened(1, page('duplicate', [0, 1])),
        ],
      }],
      [],
    )
    await duplicate.journal.open({})
    await vi.waitFor(() => { expect(duplicate.failed).toHaveBeenCalledOnce() })
    const duplicateFailure: unknown = duplicate.failed.mock.calls[0]?.[0]
    expect(duplicateFailure).toBeInstanceOf(Error)
    if (!(duplicateFailure instanceof Error)) throw new Error('expected duplicate-cursor failure')
    expect(duplicateFailure.message).toContain('more than one opening cursor')

    const regressed = journalFixture(
      [
        {
          frames: [opened(1, page('initial', [0, 1])), { type: 'entry', entry: { seq: 2 } }],
          terminal: new RemoteStreamCarrierError('lost'),
        },
        { frames: [opened(1, page('regressed', [0, 1]))] },
      ],
      [],
    )
    await regressed.journal.open({})
    await vi.waitFor(() => { expect(regressed.failed).toHaveBeenCalledOnce() })
    const regressedFailure: unknown = regressed.failed.mock.calls[0]?.[0]
    expect(regressedFailure).toBeInstanceOf(Error)
    if (!(regressedFailure instanceof Error)) throw new Error('expected regressed-cursor failure')
    expect(regressedFailure.message).toContain('behind the last applied entry')
  })

  it('rejects a discontinuous older page after publishing the fail-soft pagination state', async () => {
    const fixture = journalFixture(
      [{ frames: [opened(4, page('initial', [3, 4], true))], hold: true }],
      [page('older', [0, 1], true)],
    )
    await fixture.journal.open({})

    await expect(fixture.journal.prepend({ before: 3 })).rejects.toThrow('history page is discontinuous')
    expect(fixture.changes.at(-1)).toEqual({
      type: 'prepend', page: page('older', [0, 1], true), entries: [], hasMore: false,
    })
    await fixture.journal.dispose()
  })

  it('guards lifecycle operations before and after open', async () => {
    const fixture = journalFixture(
      [{ frames: [opened(-1, page('empty', []))], hold: true }],
      [],
    )

    await expect(fixture.journal.prepend({})).rejects.toThrow('is not open')
    await fixture.journal.open({})
    await expect(fixture.journal.open({})).rejects.toThrow('already opened')
    fixture.journal.restart()
    await fixture.journal.dispose()
    await expect(fixture.journal.prepend({})).rejects.toThrow('is not open')
  })
})
