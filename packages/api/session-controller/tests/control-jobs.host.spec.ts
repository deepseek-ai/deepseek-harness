import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it } from 'vitest'
import { SessionControlController } from '../src/control.ts'
import type { SessionControlFrame } from '../src/types.ts'

type BaselineFrame = Extract<SessionControlFrame, { type: 'baseline' }>
type JobFrame = Extract<SessionControlFrame, { type: 'jobs' }>

function producer(label = 'sleep 60') {
  let settle!: (outcome: JobOutcome) => void
  const reads = { count: 0 }
  const spec = {
    kind: 'bash' as const,
    label,
    run: () => ({
      cancel: () => {},
      done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
      readOutput: () => { reads.count += 1; return 'stolen output' },
    }),
  }
  return { spec, reads, settle: (outcome: JobOutcome) => { settle(outcome) } }
}

async function harness(withJobs: boolean): Promise<{
  ctx: Context
  session: Session
  agent: Agent
  control: SessionControlController
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  if (withJobs) {
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('session-controller-test')
  }
  const session = ctx.sessions.create()
  const agent = {
    id: session.id,
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx,
  } as Agent
  ctx.agents.register(agent)
  const control = new SessionControlController(ctx)
  await new Promise(resolve => setTimeout(resolve, 0))
  return { ctx, session, agent, control }
}

async function baseline(control: SessionControlController): Promise<BaselineFrame> {
  const abort = new AbortController()
  const iterator = control.control(abort.signal)[Symbol.asyncIterator]()
  const first = await iterator.next()
  abort.abort()
  await iterator.next()
  if (first.done || first.value.type !== 'baseline') throw new Error('missing control baseline')
  return first.value
}

async function collectJobs(
  iterable: AsyncIterable<SessionControlFrame>,
  count: number,
  abort: AbortController,
): Promise<JobFrame[]> {
  const jobs: JobFrame[] = []
  for await (const frame of iterable) {
    if (frame.type !== 'jobs') continue
    jobs.push(frame)
    if (jobs.length >= count) abort.abort()
  }
  return jobs
}

describe('Session control jobs baseline', () => {
  it('represents an attached session with no jobs as an empty set', async () => {
    const { session, control } = await harness(true)
    const frame = await baseline(control)
    expect(frame.value.jobs[session.id]).toEqual([])
  })

  it('carries the visible set when the stream opens', async () => {
    const { ctx, session, agent, control } = await harness(true)
    ctx.jobs.start({ ...producer('pnpm run build').spec, owner: agent })
    const frame = await baseline(control)
    const jobs = frame.value.jobs[session.id]
    expect(jobs).toHaveLength(1)
    const [job] = jobs ?? []
    expect(job?.startedAt).toBeTypeOf('number')
    expect({ ...job, startedAt: 0 }).toEqual({
      id: 'bash-1',
      kind: 'bash',
      label: 'pnpm run build',
      status: 'running',
      startedAt: 0,
    })
  })
})

describe('Session control jobs updates', () => {
  it('publishes existing unowned jobs when a Session attaches after the stream opens', async () => {
    const { ctx, control } = await harness(true)
    const abort = new AbortController()
    const iterator = control.control(abort.signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'baseline' } })
    const task = producer('already running')
    const id = ctx.jobs.start(task.spec)
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'jobs' } })

    const created = ctx.sessions.create(SessionId('late-session'))
    await expect(iterator.next()).resolves.toMatchObject({
      value: {
        type: 'jobs',
        sessionId: created.id,
        jobs: [expect.objectContaining({ id, label: 'already running' })],
      },
    })

    task.settle({ status: 'completed' })
    abort.abort()
    await iterator.return?.()
  })

  it('pushes the owner whole set on registration, stopping, and settlement', async () => {
    const { ctx, session, agent, control } = await harness(true)
    const abort = new AbortController()
    const collected = collectJobs(control.control(abort.signal), 3, abort)

    const task = producer()
    const id = ctx.jobs.start({ ...task.spec, owner: agent })
    ctx.jobs.kill(id, agent, 'test')
    task.settle({ status: 'killed', detail: 'signal: SIGTERM' })

    const frames = await collected
    expect(frames.map(frame => frame.sessionId)).toEqual([session.id, session.id, session.id])
    expect(frames.map(frame => frame.jobs[0]?.status)).toEqual(['running', 'stopping', 'killed'])
    expect(frames[2]?.jobs[0]?.detail).toBe('signal: SIGTERM')
    expect(frames[2]?.jobs[0]?.finishedAt).toBeTypeOf('number')
  })

  it('drops internal registry fields from the browser view', async () => {
    const { ctx, agent, control } = await harness(true)
    const abort = new AbortController()
    const collected = collectJobs(control.control(abort.signal), 1, abort)
    ctx.jobs.start({ ...producer().spec, owner: agent, outputLimitBytes: 1_024 })

    const [frame] = await collected
    expect(Object.keys(frame?.jobs[0] ?? {}).sort()).toEqual([
      'id',
      'kind',
      'label',
      'startedAt',
      'status',
    ])
  })

  it('fans an unowned change out to every attached session', async () => {
    const { ctx, control } = await harness(true)
    const second = ctx.sessions.create()
    const abort = new AbortController()
    const collected = collectJobs(control.control(abort.signal), 2, abort)

    ctx.jobs.start(producer('open to every caller').spec)

    const frames = await collected
    expect(new Set(frames.map(frame => frame.sessionId)).size).toBe(2)
    expect(frames.some(frame => frame.sessionId === second.id)).toBe(true)
    for (const frame of frames) expect(frame.jobs[0]?.label).toBe('open to every caller')
  })

  it('does not resume persisted sessions while projecting an unowned change', async () => {
    const { ctx, control } = await harness(true)
    const coldId = SessionId('session-cold-tasks')
    let loaded = false
    ctx.provide('sessionPersistence', {
      list: async () => [{ version: SESSION_FORMAT_VERSION, id: coldId, createdAt: 5, cwd: '/tmp' }],
      locate: () => undefined,
      load: () => { loaded = true; throw new Error('job projection must not load a cold log') },
    } as never)
    const abort = new AbortController()
    const collected = collectJobs(control.control(abort.signal), 1, abort)

    ctx.jobs.start(producer().spec)
    await collected
    expect(loaded).toBe(false)
    expect(ctx.agents.get(coldId)).toBeUndefined()
  })

  it('reports empty sets when no jobs registry is composed', async () => {
    const { session, control } = await harness(false)
    const frame = await baseline(control)
    expect(frame.value.jobs[session.id]).toEqual([])
  })

  it('never consumes model output while projecting a lifecycle', async () => {
    const { ctx, agent, control } = await harness(true)
    const abort = new AbortController()
    const collected = collectJobs(control.control(abort.signal), 3, abort)

    const task = producer()
    const id = ctx.jobs.start({ ...task.spec, owner: agent })
    ctx.jobs.kill(id, agent, 'test')
    task.settle({ status: 'killed', detail: 'signal: SIGTERM' })
    await collected

    expect(task.reads.count).toBe(0)
  })

  it('never consumes model output while producing a baseline', async () => {
    const { ctx, agent, control } = await harness(true)
    const task = producer()
    ctx.jobs.start({ ...task.spec, owner: agent })

    const frame = await baseline(control)

    expect(frame.value.jobs[agent.id]).toHaveLength(1)
    expect(task.reads.count).toBe(0)
  })

})
