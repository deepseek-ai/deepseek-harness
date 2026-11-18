import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobId, JobOutcome } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { remoteErrorOf, remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { InvocationDescriptor, InvocationParameterDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { describe, expect, it } from 'vitest'
import { callResources } from '../../gateway/src/access.ts'
import { resolveSessionResource } from '../../session-controller/src/session-resource.ts'
import { JobController } from '../src/index.ts'

/** The Typert registry {@link callResources} resolves against. */
type Typert = Parameters<typeof callResources>[0]

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
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('kill-test')
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(JobController, {})
  const session = ctx.sessions.create()
  const agent = await registerAgent(ctx, session)
  return { ctx, session, agent, controller: ctx.jobController }
}

/**
 * Install the Session Controller's own `session` resource default with the
 * resolver it registers. Mounting the whole Session Controller would drag its
 * entire dependency web into the job harness, while this registration is the
 * one Host-side step that names the resource; the controller's own suite
 * covers the rest of it.
 * @param ctx - context holding the live Typert registry.
 */
function installSessionResolver(ctx: Context): void {
  ctx.typert.resources.register('session', { resolve: resolveSessionResource })
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

/**
 * The invocation the Gateway holds for one endpoint: these methods are direct
 * and take only JSON arguments, so their wire parameters are the decorated
 * ones in declaration order.
 * @param wires - the method's JSON parameter wires, in order.
 * @returns the invocation and parameters {@link callResources} reads.
 */
function invocationOf(wires: readonly string[]): Pick<InvocationDescriptor, 'invocation' | 'parameters'> {
  return {
    invocation: { kind: 'direct' },
    parameters: wires.map((wire): InvocationParameterDescriptor => ({ name: wire, wire, source: 'json', codec: { mode: 'src-json' } })),
  }
}

/**
 * The resources the Gateway resolves for one call: the readers the live
 * Service declares, the registry they resolve against, and the call's named
 * arguments. `list` and `follow` take their cancellation signal after the
 * request, so the caller passes it as the trailing positional argument.
 * @param service - the mounted Remote Service.
 * @param typert - the registry the Gateway resolves against.
 * @param method - Remote method name.
 * @param wires - the method's JSON parameter wires, in order.
 * @param args - named arguments, the request included, plus the cancellation signal.
 * @returns the resolved resources, or `undefined` when they are invalid.
 */
function resourcesOf(
  service: JobController,
  typert: Typert,
  method: string,
  wires: readonly string[],
  args: Readonly<Record<string, unknown>>,
): ReturnType<typeof callResources> {
  const readers = remoteMethods(service).find(candidate => candidate.exportName === method || candidate.method === method)?.resources
  return callResources(typert, readers, invocationOf(wires), args, NEVER)
}

const NEVER = new AbortController().signal

describe('JobController Remote Session resources', () => {
  const SESSION = { kind: 'session' } as const

  it('names the Session of the request on the roster, the follow stream, and a kill', async () => {
    // The production composition mounts the Session Controller beside this
    // Service, so its default `session` resolver — not a reader on these
    // methods — is the layer that names the resource. The assertions read the
    // resource the Gateway resolves against, so losing that resolver here
    // turns them global and fails them.
    const { ctx, session, controller } = await harness()
    installSessionResolver(ctx)
    const jobId = 'bash-1' as JobId
    const request = { sessionId: session.id, jobId }
    expect(resourcesOf(controller, ctx.typert, 'list', ['request'], { request: { sessionId: session.id }, signal: NEVER }))
      .toEqual([{ kind: SESSION.kind, id: session.id }])
    expect(resourcesOf(controller, ctx.typert, 'follow', ['request'], { request, signal: NEVER }))
      .toEqual([{ kind: SESSION.kind, id: session.id }])
    expect(resourcesOf(controller, ctx.typert, 'kill', ['request'], { request }))
      .toEqual([{ kind: SESSION.kind, id: session.id }])
  })

  it('resolves those endpoints to the global resource without a resolver', async () => {
    // The counterpart above: the endpoints declare no reader of their own, so
    // omitting the Session Controller's resolver leaves every call global.
    const { ctx, session, controller } = await harness()
    const request = { sessionId: session.id, jobId: 'bash-1' as JobId }
    for (const [method, wires] of [['list', ['request']], ['follow', ['request']], ['kill', ['request']]] as const) {
      expect(resourcesOf(controller, ctx.typert, method, wires, method === 'kill' ? { request } : { request, signal: NEVER }))
        .toEqual([{ kind: 'global' }])
    }
  })

  it('falls back to the global resource for a follow of an unowned job', async () => {
    // An unowned job is observer-visible to any caller, so its request names
    // no Session and the resolver has nothing to answer.
    const { ctx, controller } = await harness()
    installSessionResolver(ctx)
    const args = { request: { jobId: 'bash-1' as JobId }, signal: NEVER }
    expect(resourcesOf(controller, ctx.typert, 'follow', ['request'], args)).toEqual([{ kind: 'global' }])
  })
})

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
