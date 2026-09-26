import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { describe, expect, it } from 'vitest'
import { JobController } from '../src/index.ts'

function producer(label = 'sleep 60') {
  let settle!: (outcome: JobOutcome) => void
  const cancels: (string | undefined)[] = []
  const spec = {
    kind: 'bash' as const,
    label,
    run: () => ({
      cancel: (reason?: string) => { cancels.push(reason) },
      done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
    }),
  }
  return { spec, cancels, settle: (outcome: JobOutcome) => { settle(outcome) } }
}

async function registerAgent(ctx: Context, session: Session): Promise<Agent> {
  const agent = {
    id: session.id,
    session,
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx,
  } as Agent
  await ctx.agents.register(agent)
  return agent
}

async function harness(): Promise<{
  ctx: Context
  session: Session
  agent: Agent
  controller: JobController
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('kill-test')
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(JobController, {})
  const session = ctx.sessions.create()
  const agent = await registerAgent(ctx, session)
  return { ctx, session, agent, controller: ctx.jobController }
}

function failureCode(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    const failure = remoteErrorOf(error)
    if (failure !== undefined) return failure.code
    throw error
  }
  throw new Error('expected a RemoteError failure')
}

describe('JobController.kill', () => {
  it('kills an owned running job without claiming the terminal report', async () => {
    const { ctx, session, agent, controller } = await harness()
    const task = producer('pnpm run watch')
    const id = ctx.jobs.start({ ...task.spec, owner: agent.id })

    expect(controller.kill({ sessionId: session.id, jobId: id })).toEqual({ outcome: 'requested' })
    expect(task.cancels).toEqual(['cancelled by the user'])
    // The kill reason is recorded for the killed detail; the notice ledger
    // lives in tool-jobs, which never learns of this kill, so the completion
    // notice stays due.
    expect(ctx.jobs.get(id, agent.id)).toMatchObject({ status: 'stopping' })
  })

  it('reports an already-finished job instead of failing', async () => {
    const { ctx, session, agent, controller } = await harness()
    const task = producer()
    const id = ctx.jobs.start({ ...task.spec, owner: agent.id })
    task.settle({ status: 'completed', detail: 'exit code: 0' })
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(controller.kill({ sessionId: session.id, jobId: id })).toEqual({ outcome: 'already-finished' })
    expect(ctx.jobs.get(id, agent.id).status).toBe('completed')
  })

  it('kills an unowned job from a session without a live agent', async () => {
    const { ctx, controller } = await harness()
    const task = producer('unowned work')
    const id = ctx.jobs.start(task.spec)
    const cold = ctx.sessions.create()

    expect(controller.kill({ sessionId: cold.id, jobId: id })).toEqual({ outcome: 'requested' })
  })

  it('rejects an unknown job id as job/not-found', async () => {
    const { session, controller } = await harness()
    expect(failureCode(() => controller.kill({ sessionId: session.id, jobId: 'bash-99' as JobId })))
      .toBe('job/not-found')
  })

  it('rejects a foreign session\'s job as job/not-found', async () => {
    const { ctx, agent, controller } = await harness()
    const task = producer()
    const id = ctx.jobs.start({ ...task.spec, owner: agent.id })
    // The other session cannot see the owned job.
    const other = ctx.sessions.create()

    expect(failureCode(() => controller.kill({ sessionId: other.id, jobId: id })))
      .toBe('job/not-found')
    expect(ctx.jobs.get(id, agent.id).status).toBe('running')
  })

  it('propagates a producer cancel throw instead of masking it as job/not-found', async () => {
    const { ctx, session, agent, controller } = await harness()
    const id = ctx.jobs.start({
      kind: 'bash',
      label: 'flaky cancel',
      owner: agent.id,
      run: () => ({
        cancel: () => { throw new Error('cancel boom') },
        done: new Promise(() => {}),
      }),
    })
    // The registry contract: a producer throw propagates with job state
    // unchanged — the Remote must not rewrite it into a lookup failure.
    expect(() => controller.kill({ sessionId: session.id, jobId: id })).toThrow('cancel boom')
    expect(ctx.jobs.get(id, agent.id).status).toBe('running')
  })

  it('kills a child session\'s own job from its list: the owner fence is the only access rule', async () => {
    const { ctx, controller } = await harness()
    const child = ctx.sessions.create(undefined, { meta: { origin: 'subagent' } })
    const childAgent = await registerAgent(ctx, child)
    const task = producer('child work')
    const id = ctx.jobs.start({ ...task.spec, owner: childAgent.id })

    expect(controller.kill({ sessionId: child.id, jobId: id })).toEqual({ outcome: 'requested' })
    expect(task.cancels).toEqual(['cancelled by the user'])
    expect(ctx.jobs.get(id, childAgent.id).status).toBe('stopping')
  })
})
