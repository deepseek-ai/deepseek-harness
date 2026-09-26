import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { JobId } from '@deepseek-ai/dsh-jobs/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ClientJobsModel } from '../src/client/model.ts'
import { ClientJobs } from '../src/client/service.ts'
import type { JobFollowFrame, JobListFrame, JobView } from '../src/types.ts'

const ID = 'bash-1' as JobId
const S1 = 'alice' as SessionId
const S2 = 'bob' as SessionId

function view(over: Partial<JobView> = {}): JobView {
  return {
    id: ID, kind: 'bash', label: 'pnpm run build', status: 'running', startedAt: 5,
    output: { total: 0, earliest: 0 },
    ...over,
  }
}

function opened(model: ClientJobsModel, over: Partial<{ from: number; earliest: number; total: number }> = {}): void {
  model.observeOpened(ID, {
    type: 'opened',
    job: view({ output: { total: over.total ?? 0, earliest: over.earliest ?? 0 } }),
    from: over.from ?? 0,
  })
}

describe('ClientJobsModel rows', () => {
  it('replaces a session roster whole, stores an empty set as absence, and drops on release', () => {
    const model = new ClientJobsModel()
    let notified = 0
    model.subscribe(() => { notified += 1 })
    model.rowsReplaced(S1, [view()])
    model.rowsReplaced(S2, [view({ id: 'pwsh-1' as JobId, label: 'other' })])
    expect(model.getSnapshot().rows[S1]).toEqual([view()])
    expect(model.getSnapshot().rows[S2]?.[0]?.label).toBe('other')

    // Last-wins: the newer whole set replaces, it does not merge.
    model.rowsReplaced(S1, [view({ status: 'completed' })])
    expect(model.getSnapshot().rows[S1]).toEqual([view({ status: 'completed' })])
    expect(notified).toBe(3)

    model.rowsReplaced(S1, [])
    expect(S1 in model.getSnapshot().rows).toBe(false)
    // An empty set over an absent key changes nothing.
    model.rowsReplaced(S1, [])
    expect(notified).toBe(4)

    model.rowsDropped(S2)
    expect(model.getSnapshot().rows).toEqual({})
    model.rowsDropped(S2)
    expect(notified).toBe(5)
  })
})

describe('ClientJobsModel observation', () => {
  it('accumulates output, advances the resume cursor, and closes on settlement', () => {
    const model = new ClientJobsModel()
    opened(model)
    expect(model.cursorOf(ID)).toBe(0)
    model.observeOutput(ID, { type: 'output', chunks: [{ at: 0, text: 'a' }, { at: 1, text: 'b' }], next: 2 })
    model.observeOutput(ID, { type: 'output', chunks: [{ at: 2, text: 'c' }], next: 3 })
    expect(model.cursorOf(ID)).toBe(3)
    const live = model.getSnapshot().observed[String(ID)]
    expect(live?.text).toBe('abc')
    expect(live?.streaming).toBe(true)
    model.observeSettled(ID)
    expect(model.getSnapshot().observed[String(ID)]?.streaming).toBe(false)
  })

  it('keeps snapshot identity stable between changes and notifies subscribers', () => {
    const model = new ClientJobsModel()
    let notified = 0
    const unsubscribe = model.subscribe(() => { notified += 1 })
    const before = model.getSnapshot()
    expect(model.getSnapshot()).toBe(before)
    opened(model)
    expect(notified).toBe(1)
    expect(model.getSnapshot()).not.toBe(before)
    unsubscribe()
    model.observeStopped(ID)
    expect(notified).toBe(1)
  })

  it('marks gaps from lossy frames, gap chunks, and a resume behind the retained head', () => {
    const model = new ClientJobsModel()
    opened(model, { from: 4, earliest: 8, total: 10 })
    expect(model.getSnapshot().observed[String(ID)]?.gapBefore).toBe(true)

    const clean = new ClientJobsModel()
    opened(clean)
    clean.observeOutput(ID, { type: 'output', chunks: [{ at: 0, text: 'x', gapBefore: true }], next: 1 })
    expect(clean.getSnapshot().observed[String(ID)]?.gapBefore).toBe(true)

    const lossy = new ClientJobsModel()
    opened(lossy)
    lossy.observeOutput(ID, { type: 'output', chunks: [], next: 5, lossy: true })
    expect(lossy.getSnapshot().observed[String(ID)]?.gapBefore).toBe(true)
  })

  it('marks a fresh observation anchored past the evicted head', () => {
    // Fresh observations anchor at the registry's earliest retained byte, so
    // from === earliest > 0 means the head was already discarded.
    const fresh = new ClientJobsModel()
    opened(fresh, { from: 60_240, earliest: 60_240, total: 321_328 })
    expect(fresh.getSnapshot().observed[String(ID)]?.gapBefore).toBe(true)

    // A retry that accumulated no text yet earns the mark the same way.
    const retried = new ClientJobsModel()
    opened(retried)
    expect(retried.getSnapshot().observed[String(ID)]?.gapBefore).toBe(false)
    opened(retried, { from: 6, earliest: 6, total: 6 })
    expect(retried.getSnapshot().observed[String(ID)]?.gapBefore).toBe(true)
  })

  it('bounds the render tail without splitting a surrogate pair', () => {
    const model = new ClientJobsModel()
    opened(model)
    const emoji = '😀'.repeat((64 * 1024) + 8)
    model.observeOutput(ID, { type: 'output', chunks: [{ at: 0, text: emoji }], next: emoji.length * 2 })
    const live = model.getSnapshot().observed[String(ID)]
    expect(live?.gapBefore).toBe(true)
    expect(live!.text.length).toBeLessThanOrEqual(128 * 1024)
    // The bound landed between pairs: the surviving text still round-trips.
    expect(/^(?:😀)+$/u.test(live!.text)).toBe(true)
  })

  it('trims a plain-ASCII tail without a boundary shift', () => {
    const model = new ClientJobsModel()
    opened(model)
    const long = 'x'.repeat((128 * 1024) + 5)
    model.observeOutput(ID, { type: 'output', chunks: [{ at: 0, text: long }], next: long.length })
    const live = model.getSnapshot().observed[String(ID)]
    expect(live?.text.length).toBe(128 * 1024)
    expect(live?.gapBefore).toBe(true)
  })

  it('advances the cut past a low surrogate landing exactly on the bound', () => {
    const model = new ClientJobsModel()
    opened(model)
    // 'z' + one emoji + odd ASCII tail puts a low surrogate exactly at the cut index.
    const text = 'z😀' + 'a'.repeat((128 * 1024) - 1)
    model.observeOutput(ID, { type: 'output', chunks: [{ at: 0, text }], next: text.length })
    const live = model.getSnapshot().observed[String(ID)]
    expect(live?.text.length).toBe((128 * 1024) - 1)
    expect(live?.text.startsWith('a')).toBe(true)
  })

  it('preserves accumulated text across a reconnect anchor and clears on stop', () => {
    const model = new ClientJobsModel()
    opened(model)
    model.observeOutput(ID, { type: 'output', chunks: [{ at: 0, text: 'kept' }], next: 4 })
    opened(model, { from: 4, earliest: 0, total: 4 })
    expect(model.getSnapshot().observed[String(ID)]?.text).toBe('kept')
    model.observeStopped(ID)
    expect(model.getSnapshot().observed[String(ID)]).toBeUndefined()
    expect(model.cursorOf(ID)).toBeUndefined()
    // A second stop is inert.
    model.observeStopped(ID)
  })

  it('records a terminal stream failure on the live view, or on a fresh view before the anchor', () => {
    const model = new ClientJobsModel()
    opened(model)
    model.observeFailed(ID, new Error('carrier gone'))
    const live = model.getSnapshot().observed[String(ID)]
    expect(live?.streaming).toBe(false)
    expect(live?.error).toContain('carrier gone')
    // A failure before any anchor still surfaces: the panel gets the notice on
    // an empty, non-streaming view, and a retry anchors from no cursor.
    model.observeFailed('bash-9' as JobId, new Error('ended before its anchor'))
    const early = model.getSnapshot().observed['bash-9']
    expect(early).toMatchObject({ jobId: 'bash-9', text: '', gapBefore: false, streaming: false })
    expect(early?.error).toContain('ended before its anchor')
    expect(model.cursorOf('bash-9' as JobId)).toBeUndefined()
  })
})

/** One scripted logical stream: frames are pushed by the test, never reopened. */
class FakeStream<Frame> {
  disposed = false
  /** Model a carrier whose disposal surfaces as an iterator throw. */
  throwOnDispose = false
  /** Hold the dispose promise open until {@link releaseDispose}. */
  deferDispose = false
  private disposeRelease: (() => void) | undefined
  private disposePending: Promise<void> | undefined
  private readonly frames: Frame[] = []
  private waiter: (() => void) | undefined
  private failure: Error | undefined
  readonly accepts: number[] = []

  push(frame: Frame): void {
    this.frames.push(frame)
    this.waiter?.()
  }

  poison(error: Error): void {
    this.failure = error
    this.waiter?.()
  }

  dispose(): Promise<void> {
    if (this.throwOnDispose && this.failure === undefined) {
      this.failure = new Error('carrier tore down')
    } else {
      this.disposed = true
    }
    this.waiter?.()
    if (this.deferDispose) {
      // Repeat disposals (releaser plus the consumer's finally) share one
      // deferred promise, so releaseDispose resumes every waiter.
      this.disposePending ??= new Promise((resolve) => { this.disposeRelease = resolve })
      return this.disposePending
    }
    return Promise.resolve()
  }

  releaseDispose(): void {
    this.disposeRelease?.()
  }

  async *[Symbol.asyncIterator]() {
    let generation = 1
    while (!this.disposed) {
      if (this.failure !== undefined) throw this.failure
      const frame = this.frames.shift()
      if (frame === undefined) {
        await new Promise<void>((resolve) => { this.waiter = resolve })
        continue
      }
      yield {
        generation,
        value: frame,
        signal: new AbortController().signal,
        accept: () => { this.accepts.push(generation) },
      }
      generation = 1
    }
  }
}

interface StreamOptions {
  name: string
  open: (signal: AbortSignal) => unknown
  ended: (accepted: boolean) => Error
}

function bench() {
  const ctx = new Context()
  const model = new ClientJobsModel()
  const streams: { options: StreamOptions; stream: FakeStream<JobFollowFrame> & FakeStream<JobListFrame> }[] = []
  const observeCalls: unknown[] = []
  const rowsCalls: unknown[] = []
  const killCalls: unknown[] = []
  const remote = {
    $stream: (options: StreamOptions) => {
      const stream = new FakeStream<never>()
      streams.push({ options, stream })
      return stream
    },
    job: {
      follow: (request: unknown) => {
        observeCalls.push(request)
        return { [Symbol.asyncIterator]: async function* () { /* never yields */ } }
      },
      list: (request: unknown) => {
        rowsCalls.push(request)
        return { [Symbol.asyncIterator]: async function* () { /* never yields */ } }
      },
      kill: async (request: unknown) => {
        killCalls.push(request)
        return { ok: false as const, error: { code: 'job/not-found', message: 'gone' } }
      },
    },
  }
  const jobs = new ClientJobs(ctx, remote as never, model)
  return { ctx, model, jobs, streams, observeCalls, rowsCalls, killCalls }
}

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0))
const anchor = (): JobFollowFrame => ({ type: 'opened', job: view(), from: 0 })

describe('ClientJobs roster streams', () => {
  it('forwards a kill to the job namespace and returns the Remote verdict', async () => {
    const { jobs, killCalls } = bench()
    await expect(jobs.kill(S1, ID)).resolves.toMatchObject({ ok: false })
    expect(killCalls).toEqual([{ sessionId: 'alice', jobId: ID }])
  })

  it('shares one roster stream per session and drops the rows after the last release', async () => {
    const { model, jobs, streams, rowsCalls } = bench()
    const first = jobs.watchRows(S1)
    const second = jobs.watchRows(S1)
    jobs.watchRows(S2)
    expect(streams.map(entry => entry.options.name)).toEqual(['job rows alice', 'job rows bob'])
    streams[0]!.options.open(new AbortController().signal)
    expect(rowsCalls.at(-1)).toEqual({ sessionId: 'alice' })

    const { stream } = streams[0]!
    stream.push({ type: 'rows', jobs: [view()] })
    await tick()
    expect(model.getSnapshot().rows[S1]).toEqual([view()])
    expect(stream.accepts).toHaveLength(1)
    stream.push({ type: 'rows', jobs: [view({ status: 'completed' })] })
    await tick()
    expect(model.getSnapshot().rows[S1]?.[0]?.status).toBe('completed')

    first()
    first()
    expect(stream.disposed).toBe(false)
    second()
    await tick()
    expect(stream.disposed).toBe(true)
    expect(S1 in model.getSnapshot().rows).toBe(false)
    expect(streams[1]!.stream.disposed).toBe(false)
  })

  it('classifies a roster end as retryable only after the first frame', () => {
    const { jobs, streams } = bench()
    jobs.watchRows(S1)
    const { options } = streams[0]!
    expect(options.ended(true).name).toBe('RemoteStreamCarrierError')
    expect(options.ended(false).name).toBe('Error')
  })

  it('drops the roster on a terminal stream failure', async () => {
    const { model, jobs, streams } = bench()
    jobs.watchRows(S1)
    const { stream } = streams[0]!
    stream.push({ type: 'rows', jobs: [view()] })
    await tick()
    expect(model.getSnapshot().rows[S1]).toBeDefined()
    stream.poison(new Error('frame decode broke'))
    await tick()
    expect(S1 in model.getSnapshot().rows).toBe(false)
  })

  it('stays silent when the carrier teardown itself throws after the last release', async () => {
    const { model, jobs, streams } = bench()
    const stop = jobs.watchRows(S1)
    const { stream } = streams[0]!
    stream.throwOnDispose = true
    stream.push({ type: 'rows', jobs: [view()] })
    await tick()
    // The releaser drops the rows and marks the entry stopped, then its
    // dispose surfaces as an iterator throw — which the consumer swallows for
    // a stopped entry instead of dropping twice or failing loud.
    stop()
    await tick()
    expect(model.getSnapshot().rows).toEqual({})
  })

  it('a re-watch inside the dispose round-trip keeps its fresh rows', async () => {
    const { model, jobs, streams } = bench()
    const stop = jobs.watchRows(S1)
    const first = streams[0]!.stream
    first.deferDispose = true
    first.push({ type: 'rows', jobs: [view()] })
    await tick()

    stop()
    // Re-watch while the previous generation's dispose is still in flight.
    jobs.watchRows(S1)
    const second = streams[1]!.stream
    second.push({ type: 'rows', jobs: [view({ label: 'fresh' })] })
    await tick()

    first.releaseDispose()
    await tick()
    // The stale post-dispose clear must not blank the successor's rows.
    expect(model.getSnapshot().rows[S1]?.[0]?.label).toBe('fresh')
  })
})

describe('ClientJobs observation streams', () => {
  it('feeds anchor, output, and terminal frames into the model, then closes', async () => {
    const { model, jobs, streams } = bench()
    jobs.observe(undefined, ID)
    const { stream } = streams[0]!
    expect(streams[0]!.options.name).toBe('job observation bash-1')
    stream.push(anchor())
    stream.push({ type: 'output', chunks: [{ at: 0, text: 'hi' }], next: 2 })
    await tick()
    expect(model.getSnapshot().observed[String(ID)]?.text).toBe('hi')
    expect(stream.accepts).toHaveLength(1)

    stream.push({ type: 'status', job: view({ status: 'completed' }) })
    await tick()
    expect(model.getSnapshot().observed[String(ID)]?.streaming).toBe(false)
    expect(stream.disposed).toBe(true)
  })

  it('shares one stream across observers and stops after the last release', async () => {
    const { model, jobs, streams } = bench()
    const first = jobs.observe(undefined, ID)
    const second = jobs.observe(undefined, ID)
    expect(streams).toHaveLength(1)
    streams[0]!.stream.push(anchor())
    await tick()

    first()
    first()
    expect(streams[0]!.stream.disposed).toBe(false)
    second()
    await tick()
    expect(streams[0]!.stream.disposed).toBe(true)
    expect(model.getSnapshot().observed[String(ID)]).toBeUndefined()
  })

  it('a late release of a superseded observation neither tears down nor clears its successor', async () => {
    const { model, jobs, streams } = bench()
    const firstStop = jobs.observe(undefined, ID)
    const first = streams[0]!.stream
    first.push(anchor())
    first.push({ type: 'status', job: view({ status: 'completed' }) })
    await tick()
    // A successor observation replaces the settled entry while the first
    // observer still holds its releaser.
    const secondStop = jobs.observe(undefined, ID)
    const second = streams[1]!.stream
    second.push(anchor())
    await tick()

    firstStop()
    await tick()
    expect(second.disposed).toBe(false)
    expect(model.getSnapshot().observed[String(ID)]).toBeDefined()

    secondStop()
    await tick()
    expect(second.disposed).toBe(true)
    expect(model.getSnapshot().observed[String(ID)]).toBeUndefined()
  })

  it('a re-observation inside the dispose round-trip keeps its fresh view', async () => {
    const { model, jobs, streams } = bench()
    const stop = jobs.observe(undefined, ID)
    const first = streams[0]!.stream
    first.deferDispose = true
    first.push(anchor())
    await tick()

    stop()
    // Re-expand while the previous generation's dispose is still in flight.
    jobs.observe(undefined, ID)
    const second = streams[1]!.stream
    second.push(anchor())
    await tick()

    first.releaseDispose()
    await tick()
    // The stale post-dispose clear must not blank the successor's view.
    expect(model.getSnapshot().observed[String(ID)]).toBeDefined()
    second.push({ type: 'output', chunks: [{ at: 0, text: 'alive' }], next: 5 })
    await tick()
    expect(model.getSnapshot().observed[String(ID)]?.text).toBe('alive')
  })

  it('opens a fresh stream for a re-observed job and resumes from the model cursor', async () => {
    const { jobs, streams, observeCalls, model } = bench()
    const stop = jobs.observe(S1, ID)
    streams[0]!.stream.push(anchor())
    streams[0]!.stream.push({ type: 'output', chunks: [{ at: 0, text: 'abc' }], next: 3 })
    await tick()
    // The generation opener reads the live cursor at open time and carries the
    // fenced-read session.
    streams[0]!.options.open(new AbortController().signal)
    expect(observeCalls.at(-1)).toEqual({ jobId: ID, sessionId: 'alice', from: 3 })

    stop()
    await tick()
    jobs.observe(undefined, ID)
    expect(streams).toHaveLength(2)
    streams[1]!.options.open(new AbortController().signal)
    // Stopped observation dropped the cursor: the fresh stream starts unanchored.
    expect(observeCalls.at(-1)).toEqual({ jobId: ID })
    expect(model.cursorOf(ID)).toBeUndefined()
  })

  it('classifies a premature end as retryable only after the anchor', () => {
    const { jobs, streams } = bench()
    jobs.observe(undefined, ID)
    const { options } = streams[0]!
    expect(options.ended(true).name).toBe('RemoteStreamCarrierError')
    expect(options.ended(false).name).toBe('Error')
  })

  it('records a consumer failure on the live view', async () => {
    const { model, jobs, streams } = bench()
    jobs.observe(undefined, ID)
    const { stream } = streams[0]!
    stream.push(anchor())
    await tick()
    stream.poison(new Error('frame decode broke'))
    await tick()
    const live = model.getSnapshot().observed[String(ID)]
    expect(live?.error).toContain('frame decode broke')
    expect(live?.streaming).toBe(false)
  })

  it('treats a release after service disposal as inert and stays silent for post-stop failures', async () => {
    const { ctx, model, jobs, streams } = bench()
    const stop = jobs.observe(undefined, ID)
    const { stream } = streams[0]!
    stream.push(anchor())
    await tick()
    // Poison wakes the consumer, but the synchronous stop lands first, so the
    // failure arrives on an already-stopped entry and stays silent.
    stream.poison(new Error('after stop'))
    stop()
    await tick()
    expect(model.getSnapshot().observed[String(ID)]).toBeUndefined()

    const second = jobs.observe(undefined, ID)
    await ctx.fiber.dispose()
    // The disposal path already removed every entry; a live releaser whose
    // entry is gone is inert.
    second()
  })

  it('stays silent when the carrier teardown itself throws after a stop', async () => {
    const { model, jobs, streams } = bench()
    const stop = jobs.observe(undefined, ID)
    const { stream } = streams[0]!
    stream.throwOnDispose = true
    stream.push(anchor())
    await tick()
    // The releaser marks the entry stopped, then its dispose surfaces as an
    // iterator throw — which the consumer swallows for a stopped entry.
    stop()
    await tick()
    expect(model.getSnapshot().observed[String(ID)]?.error).toBeUndefined()
  })

  it('holds service disposal until every open stream reports quiescence', async () => {
    const { ctx, jobs, streams } = bench()
    jobs.watchRows(S1)
    jobs.observe(undefined, ID)
    for (const { stream } of streams) stream.deferDispose = true
    await tick()

    let settled = false
    const disposal = ctx.fiber.dispose().then(() => { settled = true })
    await tick()
    // Both carriers were told to stop, but neither iterator has closed yet:
    // the fiber must still be unloading, or a successor plugin instance could
    // overlap the old generation's iterator.
    expect(streams.every(entry => entry.stream.disposed)).toBe(true)
    expect(settled).toBe(false)

    streams[0]!.stream.releaseDispose()
    await tick()
    expect(settled).toBe(false)
    streams[1]!.stream.releaseDispose()
    await disposal
    expect(settled).toBe(true)
  })

  it('records a terminal stream failure and service disposal closes live streams', async () => {
    const { ctx, model, jobs, streams } = bench()
    jobs.observe(undefined, ID)
    const failing = streams[0]!.stream
    failing.push(anchor())
    await tick()
    // Simulate a terminal consumer failure by disposing the underlying stream:
    // the consumer loop ends without a status frame and cleans up.
    const spy = vi.spyOn(model, 'observeFailed')
    await failing.dispose()
    await tick()

    jobs.observe(undefined, 'bash-2' as JobId)
    await ctx.fiber.dispose()
    expect(streams.every(entry => entry.stream.disposed)).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })
})
