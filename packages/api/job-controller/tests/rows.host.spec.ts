import { describe, expect, it } from 'vitest'
import { streamJobRows } from '../src/rows.ts'
import { harness, next, registerAgent, startJob, wait } from './host-harness.ts'

const ROWS = { flushMs: 5 }

describe('streamJobRows', () => {
  it('opens with the visible set and re-sends it after each coalesced lifecycle burst', async () => {
    const ctx = await harness()
    const alice = await registerAgent(ctx, 'alice')
    const bob = await registerAgent(ctx, 'bob')
    startJob(ctx, { label: 'shared' })
    const mine = startJob(ctx, { label: 'mine', owner: alice.id })
    startJob(ctx, { label: 'theirs', owner: bob.id })

    const abort = new AbortController()
    const iterator = streamJobRows(ctx.jobs, { sessionId: alice.id }, ROWS, abort.signal)[Symbol.asyncIterator]()
    const first = await next(iterator)
    expect(first?.jobs.map(job => job.label)).toEqual(['shared', 'mine'])

    // Another owner's lifecycle and this job's own output never wake the roster;
    // the next frame is the one the settlement earns, and it carries the final
    // byte count without a frame per append.
    startJob(ctx, { label: 'theirs too', owner: bob.id })
    mine.append('progress bytes')
    await wait(20)
    const pending = next(iterator)
    await mine.settle({ status: 'completed', detail: 'exit code: 0' })
    const second = await pending
    expect(second?.jobs.map(job => job.label)).toEqual(['shared', 'mine'])
    expect(second?.jobs[1]).toMatchObject({ status: 'completed', detail: 'exit code: 0', output: { total: 14 } })
    abort.abort()
    expect(await next(iterator)).toBeUndefined()
  })

  it('follows progress, stopping, and registration commits', async () => {
    const ctx = await harness()
    const alice = await registerAgent(ctx, 'alice')
    const job = startJob(ctx, { label: 'first', owner: alice.id, slowStop: true })
    const abort = new AbortController()
    const iterator = streamJobRows(ctx.jobs, { sessionId: alice.id }, ROWS, abort.signal)[Symbol.asyncIterator]()
    await next(iterator)

    job.progress('3/10')
    expect((await next(iterator))?.jobs[0]).toMatchObject({ progress: '3/10' })
    ctx.jobs.kill(job.id, alice.id, 'enough')
    expect((await next(iterator))?.jobs[0]).toMatchObject({ status: 'stopping', progress: '3/10' })
    startJob(ctx, { label: 'second', owner: alice.id })
    expect((await next(iterator))?.jobs.map(entry => entry.label)).toEqual(['first', 'second'])
    abort.abort()
    expect(await next(iterator)).toBeUndefined()
    await job.settle({ status: 'killed' })
  })

  it('drops an owner\'s rows when its lifecycle ends, keeping the unowned set', async () => {
    const ctx = await harness()
    const alice = await registerAgent(ctx, 'alice')
    startJob(ctx, { label: 'shared' })
    startJob(ctx, { label: 'mine', owner: alice.id })
    const abort = new AbortController()
    const iterator = streamJobRows(ctx.jobs, { sessionId: alice.id }, ROWS, abort.signal)[Symbol.asyncIterator]()
    expect((await next(iterator))?.jobs).toHaveLength(2)

    await alice.disposeScope()
    // Teardown cancels, settles, and removes the owned job; the frames land in
    // that order, and the last one holds the unowned job alone.
    let frame = await next(iterator)
    while (frame !== undefined && frame.jobs.length !== 1) frame = await next(iterator)
    expect(frame?.jobs.map(job => job.label)).toEqual(['shared'])
    abort.abort()
    expect(await next(iterator)).toBeUndefined()
  })

  it('stops cleanly on abort while idle and refuses an already-aborted signal', async () => {
    const ctx = await harness()
    startJob(ctx, { label: 'idle' })
    const abort = new AbortController()
    const iterator = streamJobRows(ctx.jobs, { sessionId: 'nobody' as never }, ROWS, abort.signal)[Symbol.asyncIterator]()
    expect((await next(iterator))?.jobs.map(job => job.label)).toEqual(['idle'])
    await wait(10)
    abort.abort()
    expect(await next(iterator)).toBeUndefined()

    const aborted = new AbortController()
    aborted.abort()
    const refused = streamJobRows(ctx.jobs, { sessionId: 'nobody' as never }, ROWS, aborted.signal)[Symbol.asyncIterator]()
    await expect(refused.next()).rejects.toThrow()
  })
})
