import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { JobId } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { JobController } from '../src/index.ts'
import { observeJobOutput } from '../src/observe.ts'
import type { ObserveJobOptions } from '../src/observe.ts'
import type { JobFollowFrame } from '../src/types.ts'
import { collect, harness, next, registerAgent, startJob, wait } from './host-harness.ts'

const OBSERVE: ObserveJobOptions = { flushMs: 5, maxFrameBytes: 1024 }

describe('observeJobOutput', () => {
  function observed(ctx: Context, request: { jobId: JobId; sessionId?: SessionId; from?: number }) {
    const abort = new AbortController()
    const frames: JobFollowFrame[] = []
    const stream = observeJobOutput(ctx.jobs, request, OBSERVE, abort.signal)
    const done = (async () => {
      for await (const frame of stream) frames.push(frame)
    })()
    return { abort, frames, done }
  }

  it('anchors, streams coalesced output, and closes with the terminal projection', async () => {
    const ctx = await harness()
    const job = startJob(ctx)
    job.append('early ')
    const { frames, done } = observed(ctx, { jobId: job.id })
    await wait(20)
    job.append('live', { channel: 'stderr' })
    await wait(20)
    await job.settle({ status: 'completed', detail: 'exit code: 0' })
    await done

    expect(frames[0]).toMatchObject({
      type: 'opened',
      from: 0,
      job: { id: job.id, status: 'running', output: { earliest: 0, total: 6 } },
    })
    const outputs = frames.filter(frame => frame.type === 'output')
    const text = outputs.flatMap(frame => frame.chunks.map(chunk => chunk.text)).join('')
    expect(text).toBe('early live')
    expect(outputs.at(-1)?.next).toBe(10)
    expect(outputs.flatMap(frame => frame.chunks).find(chunk => chunk.text === 'live')?.channel).toBe('stderr')
    expect(frames.at(-1)).toMatchObject({
      type: 'status',
      job: { status: 'completed', detail: 'exit code: 0', output: { total: 10 } },
    })
  })

  it('resumes from an explicit offset and flags an evicted resume lossy', async () => {
    const ctx = await harness()
    const job = startJob(ctx, { label: 'spam' })
    job.append('a'.repeat(60))
    job.append('b'.repeat(60))
    await job.settle({ status: 'completed' })

    const fresh = observed(ctx, { jobId: job.id, from: 0 })
    await fresh.done
    const output = fresh.frames.find(frame => frame.type === 'output')
    expect(output?.lossy).toBe(true)
    expect(output?.chunks.map(chunk => chunk.text).join('')).toBe('b'.repeat(60))

    const resumed = observed(ctx, { jobId: job.id, from: 120 })
    await resumed.done
    expect(resumed.frames.some(frame => frame.type === 'output')).toBe(false)
    expect(resumed.frames.at(-1)?.type).toBe('status')
  })

  it('splits oversized reads along the frame budget', async () => {
    const ctx = await harness()
    const job = startJob(ctx, { label: 'wide' })
    job.append('x'.repeat(30))
    job.append('y'.repeat(30))
    await job.settle({ status: 'completed' })
    const abort = new AbortController()
    const frames = await collect<JobFollowFrame>(
      observeJobOutput(ctx.jobs, { jobId: job.id }, { flushMs: 5, maxFrameBytes: 30 }, abort.signal),
      5,
      abort,
    )
    const outputs = frames.filter(frame => frame.type === 'output')
    expect(outputs).toHaveLength(2)
    expect(outputs[0]?.next).toBe(30)
    expect(outputs[1]?.next).toBe(60)
  })

  it('carries the lossy flag on the first frame of a split evicted read', async () => {
    const ctx = await harness()
    const job = startJob(ctx, { label: 'evicted split' })
    job.append('a'.repeat(40))
    job.append('b'.repeat(40))
    job.append('c'.repeat(40))
    await job.settle({ status: 'completed' })
    const abort = new AbortController()
    const frames = await collect<JobFollowFrame>(
      observeJobOutput(ctx.jobs, { jobId: job.id, from: 0 }, { flushMs: 5, maxFrameBytes: 40 }, abort.signal),
      5,
      abort,
    )
    const outputs = frames.filter(frame => frame.type === 'output')
    expect(outputs[0]?.lossy).toBe(true)
    expect(outputs[1]?.lossy).toBeUndefined()
  })

  it('reads owned output through the request session and rejects foreign, bad, and unknown input', async () => {
    const ctx = await harness()
    const owner = await registerAgent(ctx, 'alice')
    const job = startJob(ctx, { label: 'secret', owner: owner.id })
    job.append('classified')
    await job.settle({ status: 'completed' })

    const { frames, done } = observed(ctx, { jobId: job.id, sessionId: owner.id })
    await done
    expect(frames.some(frame => frame.type === 'output'
      && frame.chunks.some(chunk => chunk.text === 'classified'))).toBe(true)

    const foreign = new AbortController()
    await expect(collect(
      observeJobOutput(ctx.jobs, { jobId: job.id }, OBSERVE, foreign.signal),
      1,
      foreign,
    )).rejects.toThrow(/belongs to another session/)

    const abort = new AbortController()
    await expect(collect(
      observeJobOutput(ctx.jobs, { jobId: job.id, sessionId: owner.id, from: -1 }, OBSERVE, abort.signal),
      1,
      abort,
    )).rejects.toThrow(/invalid observe offset/)

    const abortUnknown = new AbortController()
    await expect(collect(
      observeJobOutput(ctx.jobs, { jobId: JobId('bash-999') }, OBSERVE, abortUnknown.signal),
      1,
      abortUnknown,
    )).rejects.toThrow(/unknown job/)
  })

  it('anchors with the live progress and takes the fast wait path for a wake that lands mid-yield', async () => {
    const ctx = await harness()
    const job = startJob(ctx)
    job.progress('3/10')
    const abort = new AbortController()
    const iterator = observeJobOutput(ctx.jobs, { jobId: job.id }, OBSERVE, abort.signal)[Symbol.asyncIterator]()

    const anchor = await iterator.next()
    expect(anchor.value).toMatchObject({ type: 'opened', job: { progress: '3/10' } })
    // Both chunks land while the generator is suspended on a yield, so each
    // wake precedes the loop's wait(): draining the first chunk must pass
    // through the already-woken fast path to read the second.
    job.append('woken')
    const first = await iterator.next()
    expect(first.value).toMatchObject({ type: 'output' })
    job.append('again')
    const second = await iterator.next()
    expect(second.value).toMatchObject({ type: 'output' })
    const pending = iterator.next()
    await job.settle({ status: 'completed' })
    const status = await pending
    expect(status.value).toMatchObject({ type: 'status', job: { status: 'completed' } })
    expect((await iterator.next()).done).toBe(true)
  })

  it('ignores output signals for other jobs while waiting', async () => {
    const ctx = await harness()
    const watched = startJob(ctx, { label: 'watched' })
    const noisy = startJob(ctx, { label: 'noisy' })
    const { abort, frames, done } = observed(ctx, { jobId: watched.id })
    await wait(15)
    noisy.append('unrelated')
    await wait(15)
    await watched.settle({ status: 'completed' })
    await done
    abort.abort()
    expect(frames.filter(frame => frame.type === 'output')).toEqual([])
    await noisy.settle({ status: 'completed' })
  })

  it("closes with the removed job's terminal projection when the owner's teardown drops it mid-observation", async () => {
    const ctx = await harness()
    const owner = await registerAgent(ctx, 'observer-owner')
    const job = startJob(ctx, { label: 'torn down', owner: owner.id })
    job.append('partial')
    const { frames, done } = observed(ctx, { jobId: job.id, sessionId: owner.id })
    await wait(20)
    // Teardown cancels, settles, and removes the record within one microtask
    // chain; the generation wakes on the removal and closes without a read.
    await owner.disposeScope()
    await done
    expect(frames.map(frame => frame.type)).toEqual(['opened', 'output', 'status'])
    expect(frames.at(-1)).toMatchObject({ type: 'status', job: { id: job.id, status: 'killed' } })
    expect(() => ctx.jobs.get(job.id, owner.id)).toThrow(/unknown job/)
  })

  it('stops cleanly on abort while waiting for output', async () => {
    const ctx = await harness()
    const job = startJob(ctx, { label: 'idle' })
    const { abort, frames, done } = observed(ctx, { jobId: job.id })
    await wait(20)
    abort.abort()
    await done
    expect(frames[0]?.type).toBe('opened')
    expect(frames.at(-1)?.type).not.toBe('status')
    await job.settle({ status: 'completed' })
  })
})

describe('JobController', () => {
  async function controllerHarness() {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(TypertRegistry)
    ctx.jobs.attachController('job-controller-test')
    await ctx.plugin(JobController, {})
    return ctx
  }

  async function liveOwner(ctx: Context, rawId: string): Promise<Agent> {
    const session = ctx.sessions.create(SessionId(rawId))
    const owner: Agent = {
      id: session.id,
      options: {},
      session,
      inbox: unsupportedInbox(),
      status: 'idle',
      ctx,
      send: () => {},
      followup: () => {},
      steer: () => {},
      inject: () => {},
      cancel: () => {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    await ctx.agents.register(owner)
    return owner
  }

  it('waits for the job registry instead of serving without one', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(TypertRegistry)
    ctx.plugin(JobController, {})
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ctx.get('jobController')).toBeUndefined()
  })

  it('observe reads an owned job through the request session', async () => {
    const ctx = await controllerHarness()
    const owner = await liveOwner(ctx, 'observing-session')
    const job = startJob(ctx, { label: 'owned run', owner: owner.id })
    job.append('hi')
    await job.settle({ status: 'completed' })

    const abort = new AbortController()
    const frames = await collect<JobFollowFrame>(
      ctx.jobController.follow({ sessionId: owner.id, jobId: job.id }, abort.signal),
      3,
      abort,
    )
    expect(frames.map(frame => frame.type)).toEqual(['opened', 'output', 'status'])
  })

  it('observes an unowned job without a request session', async () => {
    const ctx = await controllerHarness()
    const job = startJob(ctx, { label: 'unowned run' })
    job.append('open access')
    await job.settle({ status: 'completed' })

    const abort = new AbortController()
    const frames = await collect<JobFollowFrame>(
      ctx.jobController.follow({ jobId: job.id }, abort.signal),
      3,
      abort,
    )
    expect(frames.map(frame => frame.type)).toEqual(['opened', 'output', 'status'])
  })

  it('rows mirrors the session-visible set and follows a settlement', async () => {
    const ctx = await controllerHarness()
    const owner = await liveOwner(ctx, 'listing-session')
    const owned = startJob(ctx, { label: 'owned', owner: owner.id })
    startJob(ctx, { label: 'shared' })

    const abort = new AbortController()
    const iterator = ctx.jobController.list({ sessionId: owner.id }, abort.signal)[Symbol.asyncIterator]()
    const first = await next(iterator)
    expect(first?.jobs.map(job => job.label)).toEqual(['owned', 'shared'])
    const pending = next(iterator)
    await owned.settle({ status: 'completed', detail: 'exit code: 0' })
    const second = await pending
    expect(second?.jobs.find(job => job.id === owned.id)).toMatchObject({ status: 'completed', detail: 'exit code: 0' })
    abort.abort()
    expect(await next(iterator)).toBeUndefined()
  })
})
