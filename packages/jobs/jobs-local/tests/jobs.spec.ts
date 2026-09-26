import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type {
  JobEvent, JobEventFilter, JobHandle, JobHooks, JobKind, JobOutcome, JobOutputSource, JobSpec, JobView,
} from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry, { type Config as JobsConfig } from '@deepseek-ai/dsh-jobs-local'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    workflow: 'workflow'
  }
}

const agentScopeDisposers = new WeakMap<Agent, () => Promise<void>>()

function stubAgent(ctx: Context, rawId: string, presetScope?: ScopeKey): Agent {
  const id = SessionId(rawId)
  const scopeFiber = ctx.plugin(() => {})
  // `presetScope` reproduces what `agentPresets.compose` does: the agent gets
  // its own key parented to the standing mount's, so the registry's chain walk
  // reaches that preset's layer.
  let agentCtx = scopeFiber.ctx
  if (presetScope !== undefined) {
    const key = {}
    bindScopeParent(key, presetScope)
    agentCtx = createScope(scopeFiber.ctx, key).ctx
  }
  const session = Session.create(id)
  const agent = {
    id,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'idle' as const,
    ctx: agentCtx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: <T>(job: (signal: AbortSignal) => Promise<T>) => job(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  } satisfies Agent
  agentScopeDisposers.set(agent, async () => { await scopeFiber.dispose() })
  return agent
}

async function disposeAgentScope(agent: Agent): Promise<void> {
  const dispose = agentScopeDisposers.get(agent)
  if (dispose === undefined) throw new Error(`missing test scope for agent "${agent.id}"`)
  await dispose()
}

/** Register a stub agent so the registry can resolve it as a live owner. */
async function liveAgent(ctx: Context, rawId: string, presetScope?: ScopeKey): Promise<Agent> {
  const agent = stubAgent(ctx, rawId, presetScope)
  await ctx.agents.register(agent)
  return agent
}

type ProducerOverrides = Partial<Pick<JobSpec, 'kind' | 'label' | 'outputLimitBytes' | 'output'> & JobHooks> & {
  owner?: Agent
}

/** A controllable producer spec: settle its `done` on demand, record cancels, expose the handle. */
function producer(overrides: ProducerOverrides = {}) {
  let settle!: (outcome: JobOutcome) => void
  let reject!: (error: unknown) => void
  const cancels: (string | undefined)[] = []
  const { kind = 'bash', label = 'sleep 60', owner, outputLimitBytes, output, ...hookOverrides } = overrides
  const hooks: JobHooks = {
    cancel(reason) { cancels.push(reason) },
    done: new Promise<JobOutcome>((res, rej) => { settle = res; reject = rej }),
    ...hookOverrides,
  }
  let started: JobHandle | undefined
  const spec: JobSpec = {
    kind,
    label,
    ...owner !== undefined ? { owner: owner.id } : {},
    ...outputLimitBytes !== undefined ? { outputLimitBytes } : {},
    ...output !== undefined ? { output } : {},
    run: (job) => {
      started = job
      return hooks
    },
  }
  return {
    spec,
    settle,
    reject,
    cancels,
    job(): JobHandle {
      if (started === undefined) throw new Error('producer not started')
      return started
    },
  }
}

async function harness(config: JobsConfig = {}) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry, config)
  ctx.jobs.attachController('test-controller')
  return ctx
}

/** Collect events matching `filter`; `types` narrows what is recorded. */
function collect(ctx: Context, filter: JobEventFilter = { owners: 'all' }, types?: JobEvent['type'][]): JobEvent[] {
  const seen: JobEvent[] = []
  ctx.jobs.events.subscribe(filter, (event) => {
    if (types === undefined || types.includes(event.type)) seen.push(event)
  })
  return seen
}

/**
 * Attach a job controller the way `tool-jobs` does: from a plugin whose own
 * `inject` resolves `ctx.jobs`, so the service method binds to the REGISTERING
 * context and the controller files into that context's scope layer.
 * @param ctx - the context whose scope should own the controller.
 */
async function attachControllerIn(ctx: Context): Promise<void> {
  await ctx.plugin({
    inject: ['jobs'],
    apply(pluginCtx: Context) { pluginCtx.jobs.attachController('tool-jobs') },
  })
}

/** Let the settlement continuation (a `done.then`) run. */
const tick = () => new Promise<void>(r => setTimeout(r, 0))

/** Inspect the internal resolver registry to pin bounded retention while a job stays live. */
function waitResolverCount(ctx: Context, id: JobId): number {
  const service = ctx.jobs as unknown as { store: Map<JobId, { waitResolvers: Set<() => void> }> }
  const job = service.store.get(id)
  if (job === undefined) throw new Error(`missing test job ${id}`)
  return job.waitResolvers.size
}

/** A scripted pull source: each read shifts the next scripted result. */
function scriptedSource(reads: { text: string; lossy?: boolean }[], channel?: 'stdout' | 'stderr'): JobOutputSource {
  let offset = 0
  return {
    ...channel !== undefined ? { channel } : {},
    read() {
      const next = reads.shift() ?? { text: '' }
      offset += Buffer.byteLength(next.text, 'utf8')
      return { text: next.text, nextOffset: offset, lossy: next.lossy ?? false }
    },
  }
}

describe('LocalJobRegistry.start', () => {
  it('preserves the SessionId brand on public owner projections', () => {
    expectTypeOf<JobView['owner']>().toEqualTypeOf<SessionId | undefined>()
  })

  it('refuses to register while no job controller serves the owner', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalJobRegistry)
    expect(() => ctx.jobs.start(producer().spec))
      .toThrow('background jobs unavailable: no job controller serves this agent (load @deepseek-ai/dsh-tool-jobs in its composition)')
  })

  it('refuses an owner whose own composition attaches no controller', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    // Two standing preset mounts over one registry; only the first loads the
    // job controls. The second must not inherit the first's open gate.
    const withControls = createScope(ctx, {})
    const withoutControls = createScope(ctx, {})
    await attachControllerIn(withControls.ctx)

    const served = await liveAgent(ctx, 'served', scopeOf(withControls.ctx))
    const unserved = await liveAgent(ctx, 'unserved', scopeOf(withoutControls.ctx))

    expect(() => ctx.jobs.start(producer({ owner: served }).spec)).not.toThrow()
    expect(() => ctx.jobs.start(producer({ owner: unserved }).spec))
      .toThrow('no job controller serves this agent')
    // An unowned producer has no chain to walk, so only a global controller serves it.
    expect(() => ctx.jobs.start(producer().spec))
      .toThrow('no job controller serves this agent')
  })

  it('lets a controller attached without a scope serve every owner', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    // The host-plane composition's own controls: no scope, so the global layer
    // holds them and every owner's read includes it.
    await attachControllerIn(ctx)
    const scoped = await liveAgent(ctx, 'scoped', scopeOf(createScope(ctx, {}).ctx))

    expect(() => ctx.jobs.start(producer({ owner: scoped }).spec)).not.toThrow()
    expect(() => ctx.jobs.start(producer().spec)).not.toThrow()
  })

  it('rejects an empty kind, empty label, and invalid output limit', async () => {
    const ctx = await harness()
    expect(() => ctx.jobs.start(producer({ kind: '' as JobKind }).spec)).toThrow('invalid job kind')
    expect(() => ctx.jobs.start(producer({ label: '' }).spec)).toThrow('invalid job label')
    expect(() => ctx.jobs.start(producer({ outputLimitBytes: 0 }).spec)).toThrow('outputLimitBytes')
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid maxConcurrentJobsPerOwner config: %s',
    async (maxConcurrentJobsPerOwner) => {
      const ctx = new Context()
      await expect(ctx.plugin(LocalJobRegistry, { maxConcurrentJobsPerOwner }))
        .rejects.toThrow()
    },
  )

  it('rejects a non-positive pump interval', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(LocalJobRegistry, { pumpPollMs: 0 })).rejects.toThrow()
  })

  it('accepts the largest safe integer limit', async () => {
    const ctx = await harness({ maxConcurrentJobsPerOwner: Number.MAX_SAFE_INTEGER })
    expect(ctx.jobs).toBeInstanceOf(LocalJobRegistry)
  })

  it('defaults each owner bucket to ten active jobs', async () => {
    const ctx = await harness()
    const live = Array.from({ length: 10 }, () => producer())
    for (const job of live) ctx.jobs.start(job.spec)

    const blocked = producer()
    const run = vi.fn((job: JobHandle) => blocked.spec.run(job))
    expect(() => ctx.jobs.start({ ...blocked.spec, run }))
      .toThrow('background job limit reached for this owner (limit: 10)')
    expect(run).not.toHaveBeenCalled()
    for (const job of live) job.settle({ status: 'completed' })
  })

  it('rejects before producer start and id allocation, then admits immediately after settlement', async () => {
    const ctx = await harness({ maxConcurrentJobsPerOwner: 1 })
    const first = producer()
    expect(ctx.jobs.start(first.spec)).toBe('bash-1')

    const blocked = producer()
    const run = vi.fn((job: JobHandle) => blocked.spec.run(job))
    expect(() => ctx.jobs.start({ ...blocked.spec, run }))
      .toThrow('use job_kill to stop an unneeded job, wait for it to finish, then retry')
    expect(run).not.toHaveBeenCalled()

    first.settle({ status: 'completed' })
    await tick()
    expect(ctx.jobs.start(blocked.spec)).toBe('bash-2')
  })

  it('keeps a stopping job in the bucket until producer settlement', async () => {
    const ctx = await harness({ maxConcurrentJobsPerOwner: 1 })
    const first = producer()
    const id = ctx.jobs.start(first.spec)
    expect(ctx.jobs.kill(id)).toBe('requested')

    const replacement = producer()
    expect(() => ctx.jobs.start(replacement.spec)).toThrow('(limit: 1)')

    first.settle({ status: 'killed' })
    await tick()
    expect(ctx.jobs.start(replacement.spec)).toBe('bash-2')
  })

  it.each(['completed', 'killed', 'failed'] as const)(
    'releases the bucket after a %s terminal outcome',
    async (status) => {
      const ctx = await harness({ maxConcurrentJobsPerOwner: 1 })
      const first = producer()
      ctx.jobs.start(first.spec)
      first.settle({ status })
      await tick()
      expect(() => ctx.jobs.start(producer().spec)).not.toThrow()
    },
  )

  it('buckets by exact owner: a same-session replacement and the unowned bucket count separately', async () => {
    const ctx = await harness({ maxConcurrentJobsPerOwner: 1 })
    const oldOwner = stubAgent(ctx, 'shared-session')
    const detachOld = await ctx.agents.register(oldOwner)
    const oldTask = producer({ owner: oldOwner })
    ctx.jobs.start(oldTask.spec)

    await liveAgent(ctx, 'other-session')
    expect(() => ctx.jobs.start({ ...producer().spec, owner: SessionId('other-session') })).not.toThrow()

    // The session id resolves to whichever agent is live now; a replacement
    // instance starts with its own bucket even while the old job runs on.
    await detachOld()
    const replacement = stubAgent(ctx, 'shared-session')
    await ctx.agents.register(replacement)
    expect(() => ctx.jobs.start(producer({ owner: replacement }).spec)).not.toThrow()

    ctx.jobs.start(producer().spec)
    expect(() => ctx.jobs.start(producer().spec)).toThrow('(limit: 1)')

    oldTask.settle({ status: 'completed' })
    await tick()
    await disposeAgentScope(oldOwner)
  })

  it('issues kind-prefixed ids from per-kind counters', async () => {
    const ctx = await harness()
    expect(ctx.jobs.start(producer().spec)).toBe('bash-1')
    expect(ctx.jobs.start(producer().spec)).toBe('bash-2')
    expect(ctx.jobs.start(producer({ kind: 'subagent' }).spec)).toBe('subagent-1')
    expect(ctx.jobs.start(producer({ kind: 'workflow' }).spec)).toBe('workflow-1')
  })
})

describe('LocalJobRegistry reads and settlement', () => {
  it('read consumes the ring from the model cursor and advances it; readAt never moves it', async () => {
    const ctx = await harness()
    const p = producer()
    const id = ctx.jobs.start(p.spec)
    const jobs = ctx.jobs
    p.job().append('first', { channel: 'stdout' })
    p.job().append('err', { channel: 'stderr' })

    const first = jobs.read(id)
    expect(first.chunks).toEqual([{ at: 0, text: 'first', channel: 'stdout' }, { at: 5, text: 'err', channel: 'stderr' }])
    expect(first.lossy).toBe(false)
    expect(first.result).toBeUndefined()
    expect(first.job).toMatchObject({ status: 'running', output: { total: 8, earliest: 0 } })
    expect(jobs.read(id).chunks).toEqual([])

    // A non-consuming read from the head sees everything again, and leaves the cursor alone.
    expect(jobs.readAt(id, 0).chunks).toHaveLength(2)
    p.job().append('rest')
    expect(jobs.read(id).chunks).toEqual([{ at: 8, text: 'rest' }])
  })

  it('hands the producer result out once, on the first read after settlement', async () => {
    const ctx = await harness()
    const p = producer({ kind: 'subagent', label: 'research job' })
    const id = ctx.jobs.start(p.spec)
    const jobs = ctx.jobs
    expect(jobs.read(id)).toMatchObject({ chunks: [], job: { status: 'running' } })

    p.settle({ status: 'completed', result: 'final answer' })
    await tick()
    const read = jobs.read(id)
    expect(read.result).toBe('final answer')
    expect(read.job).toMatchObject({ status: 'completed' })
    expect(read.job.finishedAt).toBeTypeOf('number')
    expect(jobs.read(id).result).toBeUndefined()
  })

  it('a settled job without a result reads as empty', async () => {
    const ctx = await harness()
    const p = producer({ kind: 'subagent' })
    const id = ctx.jobs.start(p.spec)
    p.settle({ status: 'failed', detail: 'max-tokens' })
    await tick()
    expect(ctx.jobs.read(id)).toMatchObject({ chunks: [], job: { status: 'failed', detail: 'max-tokens' } })
  })

  it('projects a producer-owned model output limit into views', async () => {
    const ctx = await harness()
    const p = producer({ outputLimitBytes: 64 })
    const id = ctx.jobs.start(p.spec)
    expect(ctx.jobs.get(id)).toMatchObject({ outputLimitBytes: 64 })
    expect(ctx.jobs.read(id).job).toMatchObject({ outputLimitBytes: 64 })
  })

  it('throws for unknown job ids', async () => {
    const ctx = await harness()
    expect(() => ctx.jobs.read(JobId('bash-99'))).toThrow('unknown job bash-99')
    expect(() => ctx.jobs.get(JobId('bash-99'))).toThrow('unknown job bash-99')
  })

  it('announces settlement once with containment across listeners', async () => {
    const ctx = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.jobs.events.subscribe({ owners: 'all' }, () => { throw new Error('listener boom') })
    const seen = collect(ctx, { owners: 'all' }, ['settled'])

    const p = producer()
    const id = ctx.jobs.start(p.spec)
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    await tick()

    expect(seen).toMatchObject([{ type: 'settled', cause: 'producer', job: { id, status: 'completed', detail: 'exit code: 0' } }])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('listener boom'))
  })

  it("contains rejection from the producer's done promise as a failed outcome (producer contract violation)", async () => {
    const ctx = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const p = producer()
    const id = ctx.jobs.start(p.spec)
    p.reject(new Error('transport exploded'))
    await tick()

    expect(ctx.jobs.get(id)).toMatchObject({ status: 'failed', detail: 'Error: transport exploded' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('producer contract violation'))
  })

  it('unregisters event listeners with the contributing fiber (HMR safety)', async () => {
    const ctx = await harness()
    const seen: string[] = []
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.jobs.events.subscribe({ owners: 'all' }, event => void seen.push(event.type))
    }, { inject: ['jobs'] }))
    await fiber.dispose()
    // The returned disposer detaches too (the non-fiber path).
    const detach = ctx.jobs.events.subscribe({ owners: 'all' }, event => void seen.push(event.type))
    detach()

    const p = producer()
    ctx.jobs.start(p.spec)
    p.settle({ status: 'completed' })
    await tick()
    expect(seen).toEqual([])
  })
})

describe('LocalJobRegistry.kill', () => {
  it('cancels a live job with the forwarded reason and settles with cause kill', async () => {
    const ctx = await harness()
    const seen = collect(ctx, { owners: 'all' }, ['stopping', 'settled'])
    const p = producer()
    const id = ctx.jobs.start(p.spec)

    expect(ctx.jobs.kill(id, undefined, 'no longer needed')).toBe('requested')
    expect(p.cancels).toEqual(['no longer needed'])
    expect(ctx.jobs.list()[0]).toMatchObject({ status: 'stopping' })
    expect(seen).toMatchObject([{ type: 'stopping', job: { id, status: 'stopping' } }])

    p.settle({ status: 'killed', detail: 'signal: SIGTERM' })
    await tick()
    expect(seen[1]).toMatchObject({
      type: 'settled',
      cause: 'kill',
      job: { id, status: 'killed', detail: 'signal: SIGTERM; no longer needed' },
    })
  })

  it('merges a reason without producer detail and keeps producer detail alone when the job outran the kill', async () => {
    const ctx = await harness()
    const killed = producer()
    const killedId = ctx.jobs.start(killed.spec)
    ctx.jobs.kill(killedId, undefined, 'cancelled by the user')
    killed.settle({ status: 'killed' })
    const outran = producer()
    const outranId = ctx.jobs.start(outran.spec)
    ctx.jobs.kill(outranId, undefined, 'too late')
    outran.settle({ status: 'completed', detail: 'exit code: 0' })
    await tick()
    expect(ctx.jobs.get(killedId).detail).toBe('cancelled by the user')
    expect(ctx.jobs.get(outranId).detail).toBe('exit code: 0')
  })

  it('reports an already-finished job instead of failing', async () => {
    const ctx = await harness()
    const p = producer()
    const id = ctx.jobs.start(p.spec)
    p.settle({ status: 'completed' })
    await tick()
    expect(ctx.jobs.kill(id)).toBe('already-finished')
  })

  it('propagates a throwing producer cancel and leaves the job untouched', async () => {
    const ctx = await harness()
    const seen = collect(ctx, { owners: 'all' }, ['stopping', 'settled'])
    let broken = true
    let settle!: (outcome: JobOutcome) => void
    const id = ctx.jobs.start({
      kind: 'bash',
      label: 'flaky cancel',
      run: () => ({
        cancel() { if (broken) throw new Error('cancel boom') },
        done: new Promise<JobOutcome>((res) => { settle = res }),
      }),
    })
    expect(() => ctx.jobs.kill(id)).toThrow('cancel boom')
    // The failed kill mutated NOTHING: still running, and the settlement
    // still reports the producer as its cause.
    expect(ctx.jobs.get(id)).toMatchObject({ status: 'running' })
    expect(seen).toEqual([])
    settle({ status: 'completed' })
    await tick()
    expect(seen).toMatchObject([{ type: 'settled', cause: 'producer', job: { id } }])

    broken = false
    expect(ctx.jobs.kill(id)).toBe('already-finished')
  })
})

describe('LocalJobRegistry.wait', () => {
  it('resolves with the terminal projection when the job settles, before the settled event', async () => {
    const ctx = await harness()
    const order: string[] = []
    ctx.jobs.events.subscribe({ owners: 'all' }, (event) => { if (event.type === 'settled') order.push('event') })
    const p = producer()
    const id = ctx.jobs.start(p.spec)

    const wait = ctx.jobs.wait(id, 5_000).then((view) => { order.push('wait'); return view })
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    expect(await wait).toMatchObject({ status: 'completed' })
    // Waiters are released synchronously inside the settlement, ahead of the
    // event; their continuations run afterwards, which is why a claim made
    // when the wait starts (not when it returns) is what stays ordered.
    expect(order).toEqual(['event', 'wait'])
  })

  it('returns the live projection on timeout', async () => {
    const ctx = await harness()
    const id = ctx.jobs.start(producer().spec)
    expect(await ctx.jobs.wait(id, 5)).toMatchObject({ status: 'running' })
  })

  it('unregisters timed-out and aborted wait resolvers while the job remains live', async () => {
    const ctx = await harness()
    const id = ctx.jobs.start(producer().spec)

    for (let index = 0; index < 3; index += 1) {
      const wait = ctx.jobs.wait(id, 5)
      expect(waitResolverCount(ctx, id)).toBe(1)
      await expect(wait).resolves.toMatchObject({ status: 'running' })
      expect(waitResolverCount(ctx, id)).toBe(0)
    }

    const controller = new AbortController()
    const wait = ctx.jobs.wait(id, 5_000, undefined, controller.signal)
    expect(waitResolverCount(ctx, id)).toBe(1)
    controller.abort()
    await expect(wait).rejects.toThrow('wait aborted')
    expect(waitResolverCount(ctx, id)).toBe(0)
    expect(ctx.jobs.get(id).status).toBe('running')
  })

  it('returns immediately for an already-finished job', async () => {
    const ctx = await harness()
    const p = producer()
    const id = ctx.jobs.start(p.spec)
    p.settle({ status: 'completed' })
    await tick()
    expect(await ctx.jobs.wait(id, 5_000)).toMatchObject({ status: 'completed' })
  })

  it('rejects a non-positive or non-finite timeout', async () => {
    const ctx = await harness()
    const id = ctx.jobs.start(producer().spec)
    await expect(ctx.jobs.wait(id, 0)).rejects.toThrow('invalid wait timeout')
    await expect(ctx.jobs.wait(id, Number.NaN)).rejects.toThrow('invalid wait timeout')
  })

  it('an aborted signal rejects the wait only — the job stays alive', async () => {
    const ctx = await harness()
    const id = ctx.jobs.start(producer().spec)

    const controller = new AbortController()
    const wait = ctx.jobs.wait(id, 5_000, undefined, controller.signal)
    controller.abort()
    await expect(wait).rejects.toThrow('wait aborted')
    expect(ctx.jobs.list()[0]).toMatchObject({ status: 'running' })

    const preAborted = new AbortController()
    preAborted.abort()
    await expect(ctx.jobs.wait(id, 5_000, undefined, preAborted.signal)).rejects.toThrow('wait aborted')
  })

  it('an abort racing settlement in the same tick rejects the wait and leaves the settlement intact', async () => {
    const ctx = await harness()
    const seen = collect(ctx, { owners: 'all' }, ['settled'])
    const p = producer()
    const id = ctx.jobs.start(p.spec)

    const controller = new AbortController()
    const wait = ctx.jobs.wait(id, 5_000, undefined, controller.signal)
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    controller.abort()
    await expect(wait).rejects.toThrow('wait aborted')
    expect(seen).toMatchObject([{ type: 'settled', cause: 'producer', job: { id, status: 'completed' } }])
  })

  it('an abort landing after settlement still delivers the terminal projection it owes', async () => {
    const ctx = await harness()
    const controller = new AbortController()
    // The listener aborts after settlement released this waiter but before its
    // resolve microtask runs. Releasing waiters ahead of the announcement is
    // what makes that abort harmless; this is the guard on that ordering.
    ctx.jobs.events.subscribe({ owners: 'all' }, (event) => { if (event.type === 'settled') controller.abort() })
    const p = producer()
    const id = ctx.jobs.start(p.spec)

    const wait = ctx.jobs.wait(id, 5_000, undefined, controller.signal)
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    await expect(wait).resolves.toMatchObject({ status: 'completed' })
  })
})

describe('LocalJobRegistry settled event awaited flag', () => {
  it('reports a settlement that released a live wait as awaited', async () => {
    const ctx = await harness()
    const seen = collect(ctx, { owners: 'all' }, ['settled'])
    const p = producer()
    const id = ctx.jobs.start(p.spec)
    const wait = ctx.jobs.wait(id, 5_000)
    p.settle({ status: 'completed' })
    await wait
    expect(seen).toMatchObject([{ type: 'settled', awaited: true }])
  })

  it('reports a settlement nobody waited on, or whose waits timed out or aborted, as not awaited', async () => {
    const ctx = await harness()
    const seen = collect(ctx, { owners: 'all' }, ['settled'])
    const unwatched = producer()
    const unwatchedId = ctx.jobs.start(unwatched.spec)
    unwatched.settle({ status: 'completed' })
    await tick()

    const abandoned = producer()
    const abandonedId = ctx.jobs.start(abandoned.spec)
    await ctx.jobs.wait(abandonedId, 5)
    const controller = new AbortController()
    const aborted = ctx.jobs.wait(abandonedId, 5_000, undefined, controller.signal)
    controller.abort()
    await expect(aborted).rejects.toThrow('wait aborted')
    abandoned.settle({ status: 'completed' })
    await tick()
    expect(seen).toMatchObject([
      { type: 'settled', job: { id: unwatchedId }, awaited: false },
      { type: 'settled', job: { id: abandonedId }, awaited: false },
    ])
  })

  it('counts a wait still owed the projection even when another wait on the job timed out', async () => {
    const ctx = await harness()
    const seen = collect(ctx, { owners: 'all' }, ['settled'])
    const p = producer()
    const id = ctx.jobs.start(p.spec)
    const patient = ctx.jobs.wait(id, 5_000)
    await ctx.jobs.wait(id, 5)
    p.settle({ status: 'completed' })
    await patient
    expect(seen).toMatchObject([{ type: 'settled', awaited: true }])
  })
})

describe('LocalJobRegistry.remove', () => {
  it('drops a settled record from the visible set and announces the removal', async () => {
    const ctx = await harness()
    const seen = collect(ctx, { owners: 'all' }, ['removed'])
    const p = producer()
    const id = ctx.jobs.start(p.spec)
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    await tick()
    ctx.jobs.remove(id)
    expect(ctx.jobs.list()).toEqual([])
    expect(() => ctx.jobs.get(id)).toThrow(`unknown job ${id}`)
    expect(seen).toMatchObject([{ type: 'removed', job: { id, status: 'completed', detail: 'exit code: 0' } }])
  })

  it('refuses a live job, an unknown id, and a foreign caller', async () => {
    const ctx = await harness()
    const owner = await liveAgent(ctx, 'owner')
    const p = producer({ owner })
    const id = ctx.jobs.start(p.spec)
    expect(() => { ctx.jobs.remove(id, owner.id) }).toThrow(`job ${id} is still running`)
    expect(() => { ctx.jobs.remove(id) }).toThrow('belongs to another session')
    expect(() => { ctx.jobs.remove(JobId('bash-99'), owner.id) }).toThrow('unknown job bash-99')
    p.settle({ status: 'completed' })
    await tick()
    ctx.jobs.remove(id, owner.id)
    expect(ctx.jobs.list(owner.id)).toEqual([])
  })
})

describe('LocalJobRegistry owner isolation', () => {
  it('fences every view operation to the owning session and keeps unowned jobs open', async () => {
    const ctx = await harness()
    const owner = await liveAgent(ctx, 'owner')
    const other = stubAgent(ctx, 'other')

    const owned = ctx.jobs.start(producer({ owner }).spec)
    const open = ctx.jobs.start(producer().spec)

    // The owner and the unowned job are reachable.
    expect(ctx.jobs.read(owned, owner.id).job.id).toBe(owned)
    expect(ctx.jobs.read(open, other.id).job.id).toBe(open)

    // A different session and an anonymous caller are rejected.
    const foreign = ctx.jobs
    expect(() => foreign.read(owned, other.id)).toThrow(`job ${owned} belongs to another session`)
    expect(() => foreign.get(owned, other.id)).toThrow('belongs to another session')
    expect(() => foreign.readAt(owned, 0, other.id)).toThrow('belongs to another session')
    expect(() => foreign.kill(owned, other.id)).toThrow('belongs to another session')
    await expect(foreign.wait(owned, 10, other.id)).rejects.toThrow('belongs to another session')
    expect(() => ctx.jobs.read(owned)).toThrow('belongs to another session')
  })

  it('list() shows only caller-owned plus unowned jobs', async () => {
    const ctx = await harness()
    const alice = await liveAgent(ctx, 'alice')
    const bob = await liveAgent(ctx, 'bob')

    const aliceTask = ctx.jobs.start(producer({ owner: alice }).spec)
    const bobTask = ctx.jobs.start(producer({ owner: bob }).spec)
    const openTask = ctx.jobs.start(producer({ kind: 'subagent' }).spec)

    expect(ctx.jobs.list(alice.id).map(t => t.id)).toEqual([aliceTask, openTask])
    expect(ctx.jobs.list(bob.id).map(t => t.id)).toEqual([bobTask, openTask])
    expect(ctx.jobs.list().map(t => t.id)).toEqual([openTask])
  })

  it('rejects an owned registration when no agent registry is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('test-controller')
    expect(() => ctx.jobs.start({ ...producer().spec, owner: SessionId('a') }))
      .toThrow('background job ownership requires the agent registry')
    // The failed registration mutated nothing: no stored job, counter untouched.
    expect(ctx.jobs.list()).toEqual([])
    expect(ctx.jobs.start(producer().spec)).toBe('bash-1')
  })

  it('rejects a session without a live agent and attaches cleanup once it has one', async () => {
    const ctx = await harness()
    const ghost = stubAgent(ctx, 'ghost') // never registered in ctx.agents

    // Owner resolution precedes registry mutation and cleanup attachment.
    expect(() => ctx.jobs.start(producer({ owner: ghost }).spec))
      .toThrow('has no live agent')
    expect(ctx.jobs.list(ghost.id)).toEqual([])

    // A later valid registration must still attach cleanup for the live instance.
    await ctx.agents.register(ghost)
    const cancels: (string | undefined)[] = []
    let settle!: (outcome: JobOutcome) => void
    const id = ctx.jobs.start({
      kind: 'bash',
      label: 'after retry',
      owner: ghost.id,
      run: () => ({
        cancel(reason) { cancels.push(reason); settle({ status: 'killed' }) },
        done: new Promise<JobOutcome>((res) => { settle = res }),
      }),
    })
    expect(id).toBe('bash-1') // the failed attempt burned no counter
    await disposeAgentScope(ghost)
    expect(cancels).toEqual(['owner disposed'])
    expect(ctx.jobs.list(ghost.id)).toEqual([])
  })

  it('binds a session id to the agent that is live now, and reads stay keyed by that id', async () => {
    const ctx = await harness()
    const staleOwner = stubAgent(ctx, 'owner')
    const unregisterStale = await ctx.agents.register(staleOwner)
    await unregisterStale()
    const currentOwner = stubAgent(ctx, 'owner')
    await ctx.agents.register(currentOwner)

    const current = producer({ owner: currentOwner })
    const id = ctx.jobs.start(current.spec)
    // The stale instance shares the id, so the fence lets it read; ownership
    // (and therefore teardown) belongs to the live instance.
    expect(ctx.jobs.get(id, staleOwner.id).owner).toBe(currentOwner.id)
    await disposeAgentScope(staleOwner)
    expect(ctx.jobs.list(currentOwner.id)).toHaveLength(1)

    current.settle({ status: 'completed' })
    await tick()
    await disposeAgentScope(currentOwner)
    expect(ctx.jobs.list(currentOwner.id)).toEqual([])
  })
})

describe('LocalJobRegistry owner cleanup', () => {
  it('drains the owner: cancels live jobs, awaits settlement, removes the rows', async () => {
    const ctx = await harness()
    const owner = await liveAgent(ctx, 'owner')
    const seen = collect(ctx, { owner: owner.id }, ['removed'])

    // The producer settles only when cancelled — models a child that stops on request.
    let settle!: (outcome: JobOutcome) => void
    const cancels: (string | undefined)[] = []
    ctx.jobs.start({
      kind: 'subagent',
      label: 'long research',
      owner: owner.id,
      run: () => ({
        cancel(reason) { cancels.push(reason); settle({ status: 'killed' }) },
        done: new Promise<JobOutcome>((res) => { settle = res }),
      }),
    })
    const terminal = producer({ owner })
    ctx.jobs.start(terminal.spec)
    terminal.settle({ status: 'completed' })
    await tick()

    await disposeAgentScope(owner)
    expect(cancels).toEqual(['owner disposed'])
    expect(ctx.jobs.list(owner.id)).toEqual([])
    expect(seen.map(event => event.type === 'removed' ? event.job.id : undefined)).toEqual(['subagent-1', 'bash-1'])
  })

  it('announces teardown settlements with cause teardown', async () => {
    const ctx = await harness()
    const owner = await liveAgent(ctx, 'owner')
    const seen = collect(ctx, { owners: 'all' }, ['settled'])

    let settle!: (outcome: JobOutcome) => void
    ctx.jobs.start({
      kind: 'subagent',
      label: 'long research',
      owner: owner.id,
      run: () => ({
        cancel() { settle({ status: 'killed' }) },
        done: new Promise<JobOutcome>((res) => { settle = res }),
      }),
    })

    await disposeAgentScope(owner)
    expect(seen).toMatchObject([{ type: 'settled', cause: 'teardown', job: { status: 'killed' } }])
  })

  it('attaches one cleanup per owner and drains all owned jobs with the scope', async () => {
    const ctx = await harness()
    const owner = await liveAgent(ctx, 'owner')

    const first = producer({ owner })
    const second = producer({ owner })
    ctx.jobs.start(first.spec)
    ctx.jobs.start(second.spec)
    first.settle({ status: 'completed' })
    second.settle({ status: 'completed' })
    await tick()
    expect(owner.ctx.fiber.getEffects().filter(effect => effect.label === 'jobs.ownerCleanup()')).toHaveLength(1)
    await disposeAgentScope(owner)
    expect(ctx.jobs.list(owner.id)).toEqual([])
  })

  it('does not let an old scope cleanup cancel a same-session replacement job', async () => {
    const ctx = await harness()
    const oldOwner = stubAgent(ctx, 'owner')
    const detachOld = await ctx.agents.register(oldOwner)
    const cancels: string[] = []

    function start(label: string): JobId {
      let settle!: (outcome: JobOutcome) => void
      return ctx.jobs.start({
        kind: 'bash',
        label,
        owner: SessionId('owner'),
        run: () => ({
          cancel() { cancels.push(label); settle({ status: 'killed' }) },
          done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
        }),
      })
    }

    start('old job')
    await detachOld()
    const replacement = stubAgent(ctx, 'owner')
    await ctx.agents.register(replacement)
    const replacementId = start('replacement job')

    await disposeAgentScope(oldOwner)
    expect(cancels).toEqual(['old job'])
    expect(ctx.jobs.list(replacement.id).map(job => job.id)).toEqual([replacementId])

    await disposeAgentScope(replacement)
    expect(cancels).toEqual(['old job', 'replacement job'])
  })

  it('registers owner cleanup on the agent scope rather than the jobs fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const tasksFiber = await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('test-controller')
    const owner = await liveAgent(ctx, 'owner')
    const ownerCleanupEffects = () => owner.ctx.fiber.getEffects()
      .filter(effect => effect.label === 'jobs.ownerCleanup()')

    const first = producer({ owner })
    ctx.jobs.start(first.spec)
    expect(ownerCleanupEffects()).toHaveLength(1)
    first.settle({ status: 'completed' })
    await tick()
    expect(tasksFiber.getEffects().some(effect => effect.label === 'jobs.ownerCleanup()')).toBe(false)
    await disposeAgentScope(owner)

    // Only the owner registration is released; the long-lived jobs service
    // and its own teardown effect remain active.
    expect(ownerCleanupEffects()).toHaveLength(0)
    expect(ctx.get('jobs')).toBeDefined()
    expect(tasksFiber.getEffects().some(effect => effect.label === 'jobs teardown')).toBe(true)
  })

  it('force-fails a throwing teardown cancel without awaiting producer done, first outcome wins', async () => {
    const ctx = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const owner = await liveAgent(ctx, 'owner')
    const seen = collect(ctx, { owners: 'all' }, ['settled'])

    let settle!: (outcome: JobOutcome) => void
    ctx.jobs.start({
      kind: 'bash',
      label: 'broken producer',
      owner: owner.id,
      run: () => ({
        cancel() { throw new Error('cancel boom') },
        done: new Promise<JobOutcome>((res) => { settle = res }),
      }),
    })

    const drain = disposeAgentScope(owner)
    let drained = false
    void drain.then(() => { drained = true })
    await tick()
    const drainedWithoutProducerDone = drained
    if (!drainedWithoutProducerDone) {
      // Release the producer if the assertion fails so the test can finish.
      settle({ status: 'completed' })
      await drain
    } else {
      // A late producer completion must not replace the failure or notify twice.
      settle({ status: 'completed' })
      await tick()
    }

    expect(drainedWithoutProducerDone).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('work may be orphaned'))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ cause: 'teardown', job: { status: 'failed' } })
    expect((seen[0] as { job: JobView }).job.detail).toContain('cancel threw during teardown')
    expect(ctx.jobs.list(owner.id)).toEqual([])
  })
})

describe('LocalJobRegistry disposal', () => {
  it('cancels live jobs, awaits settlement, and announces the teardown to outside subscribers', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(Object.assign((inner: Context) => {
      inner.jobs.attachController('test-controller')
    }, { inject: ['jobs'] }))

    // A subscriber outside the registry's fiber is still listening when the
    // registry unloads: it must see the rows leave, not keep them forever.
    const seen: string[] = []
    ctx.jobs.events.subscribe({ owners: 'all' }, (event) => {
      seen.push(event.type === 'settled' ? `settled:${event.cause}` : event.type)
    })
    let settle!: (outcome: JobOutcome) => void
    const cancels: (string | undefined)[] = []
    ctx.jobs.start({
      kind: 'bash',
      label: 'sleep 600',
      run: () => ({
        cancel(reason) { cancels.push(reason); settle({ status: 'killed' }) },
        done: new Promise<JobOutcome>((res) => { settle = res }),
      }),
    })

    await fiber.dispose()
    expect(cancels).toEqual(['jobs service disposed'])
    expect(seen).toEqual(['registered', 'stopping', 'settled:teardown', 'output', 'removed'])
  })

  it('force-fails a throwing cancel so service disposal does not await producer done', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('test-controller')
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const seen = collect(ctx, { owners: 'all' }, ['settled'])

    let settle!: (outcome: JobOutcome) => void
    ctx.jobs.start({
      kind: 'bash',
      label: 'broken service job',
      run: () => ({
        cancel() { throw new Error('service cancel boom') },
        done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
      }),
    })

    const disposal = fiber.dispose()
    let disposed = false
    void disposal.then(() => { disposed = true })
    await tick()
    const disposedWithoutProducerDone = disposed
    if (!disposedWithoutProducerDone) {
      // Release the producer if the assertion fails so the test can finish.
      settle({ status: 'completed' })
      await disposal
    } else {
      settle({ status: 'completed' })
      await tick()
    }

    expect(disposedWithoutProducerDone).toBe(true)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('work may be orphaned'))
    expect(seen).toMatchObject([{ type: 'settled', cause: 'teardown', job: { status: 'failed' } }])
  })

  it('detaches owner effects from still-live agent scopes when the service unloads', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const tasksFiber = await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('test-controller')
    const owner = await liveAgent(ctx, 'owner')
    let settle!: (outcome: JobOutcome) => void
    ctx.jobs.start({
      kind: 'bash',
      label: 'owned work',
      owner: owner.id,
      run: () => ({
        cancel() { settle({ status: 'killed' }) },
        done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
      }),
    })
    const ownerEffects = () => owner.ctx.fiber.getEffects()
      .filter(effect => effect.label === 'jobs.ownerCleanup()')
    expect(ownerEffects()).toHaveLength(1)

    await tasksFiber.dispose()

    expect(ownerEffects()).toHaveLength(0)
  })

  it('drops a scoped layer when its registrations dispose', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    const standing = createScope(ctx, {})
    // One mount contributes both kinds into the same layer, as `tool-jobs`
    // does; unloading it must leave nothing serving the agents that joined it.
    const mount = await standing.ctx.plugin({
      inject: ['jobs'],
      apply(pluginCtx: Context) {
        pluginCtx.jobs.attachController('tool-jobs')
        pluginCtx.jobs.events.subscribe({ owners: 'scope' }, () => {})
      },
    })
    const owner = await liveAgent(ctx, 'joined', scopeOf(standing.ctx))
    expect(() => ctx.jobs.start(producer({ owner }).spec)).not.toThrow()

    await mount.dispose()

    expect(() => ctx.jobs.start(producer({ owner }).spec))
      .toThrow('no job controller serves this agent')
  })

  it('detaching the last controller re-arms the register fence', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalJobRegistry)
    const detachA1 = ctx.jobs.attachController('a')
    const detachA2 = ctx.jobs.attachController('a') // duplicate name counts independently
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.jobs.attachController('b')
    }, { inject: ['jobs'] }))

    detachA1()
    detachA1() // second call of the same disposer is a no-op
    expect(() => ctx.jobs.start(producer().spec)).not.toThrow() // a ×1 + b remain
    detachA2()
    expect(() => ctx.jobs.start(producer().spec)).not.toThrow() // b remains
    await fiber.dispose() // detaches b with its fiber (HMR safety)
    expect(() => ctx.jobs.start(producer().spec)).toThrow('no job controller serves this agent')
  })
})

describe('LocalJobRegistry events', () => {
  it('announces registration, progress, stopping, and settlement with the committed projection', async () => {
    const ctx = await harness()
    const owner = await liveAgent(ctx, 'alice')
    const seen = collect(ctx, { owner: owner.id }, ['registered', 'progress', 'stopping', 'settled'])

    const p = producer({ owner })
    const id = ctx.jobs.start(p.spec)
    // Registration is announced only once the record is readable.
    expect(seen).toMatchObject([{ type: 'registered', job: { id, owner: 'alice', status: 'running' } }])
    expect(ctx.jobs.list(owner.id)).toHaveLength(1)

    p.job().updateProgress('3/10')
    expect(seen[1]).toMatchObject({ type: 'progress', job: { id, progress: '3/10' } })

    expect(ctx.jobs.kill(id, owner.id)).toBe('requested')
    expect(seen[2]).toMatchObject({ type: 'stopping', job: { id, status: 'stopping', progress: '3/10' } })

    p.settle({ status: 'killed' })
    await tick()
    const settled = seen[3] as { job: JobView }
    expect(seen[3]).toMatchObject({ type: 'settled', cause: 'kill', job: { id, status: 'killed' } })
    expect(settled.job.progress).toBeUndefined()
    await disposeAgentScope(owner)
  })

  it('announces an unowned job to every session filter, since every caller can see it', async () => {
    const ctx = await harness()
    const seen = collect(ctx, { owner: SessionId('anyone') }, ['registered'])
    ctx.jobs.start(producer().spec)
    expect(seen).toMatchObject([{ type: 'registered', job: { id: 'bash-1' } }])
    expect((seen[0] as { job: JobView }).job.owner).toBeUndefined()
  })

  it('announces the owner-disposal removal, and stays silent when that owner had none', async () => {
    const ctx = await harness()
    const owner = await liveAgent(ctx, 'alice')
    const bystander = await liveAgent(ctx, 'bob')
    const p = producer({ owner })
    ctx.jobs.start(p.spec)

    const seen = collect(ctx, { owners: 'all' }, ['settled', 'removed'])
    p.settle({ status: 'completed' })
    await tick()
    expect(seen.map(event => event.type)).toEqual(['settled'])

    // Disposing an owner with no records changes no visible set.
    await disposeAgentScope(bystander)
    expect(seen.map(event => event.type)).toEqual(['settled'])

    await disposeAgentScope(owner)
    expect(seen.map(event => event.type)).toEqual(['settled', 'removed'])
    expect(ctx.jobs.list(owner.id)).toEqual([])
  })

  it('contains a throwing listener so the lifecycle commit still stands', async () => {
    const ctx = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.jobs.events.subscribe({ owners: 'all' }, () => { throw new Error('observer boom') })
    const seen = collect(ctx, { owners: 'all' }, ['registered'])

    const id = ctx.jobs.start(producer().spec)
    expect(id).toBe('bash-1')
    expect(seen).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('event listener threw on registered'))
  })

  it('announces the stopping transition during owner teardown, before settlement', async () => {
    const ctx = await harness()
    const owner = await liveAgent(ctx, 'alice')
    const p = producer({ owner })
    ctx.jobs.start(p.spec)

    const statuses: string[] = []
    ctx.jobs.events.subscribe({ owner: owner.id }, (event) => {
      if (event.type !== 'output') statuses.push(`${event.type}:${event.job.status}`)
    })

    // A slow producer keeps teardown parked between cancel and settlement;
    // an observer must not be left showing `running` for that whole window.
    const disposal = disposeAgentScope(owner)
    await tick()
    expect(statuses).toEqual(['stopping:stopping'])

    p.settle({ status: 'killed' })
    await disposal
    // Settlement, then the removal that empties the visible set.
    expect(statuses).toEqual(['stopping:stopping', 'settled:killed', 'removed:killed'])
    expect(ctx.jobs.list(owner.id)).toEqual([])
  })

  it('delivers scoped subscriptions to the owning composition only', async () => {
    const ctx = await harness()
    const mount = createScope(ctx, {})
    const otherMount = createScope(ctx, {})
    const alice = await liveAgent(ctx, 'alice', scopeOf(mount.ctx))
    const bob = await liveAgent(ctx, 'bob', scopeOf(otherMount.ctx))
    const everyone = collect(ctx, { owners: 'all' }, ['output'])
    const scoped: string[] = []
    await mount.ctx.plugin({
      inject: ['jobs'],
      apply(scopedCtx: Context) {
        scopedCtx.jobs.events.subscribe({ owners: 'scope' }, (event) => {
          if (event.type === 'output') scoped.push(String(event.id))
        })
      },
    })
    const pa = producer({ owner: alice })
    const aliceId = ctx.jobs.start(pa.spec)
    const pb = producer({ owner: bob })
    ctx.jobs.start(pb.spec)
    pa.job().append('for alice observers')
    pb.job().append('for bob observers')
    expect(everyone).toHaveLength(2)
    expect(scoped).toEqual([String(aliceId)])
  })
})

describe('LocalJobRegistry output ring', () => {
  it('appends advance absolute offsets and reach observers as output events', async () => {
    const ctx = await harness()
    const outputs = collect(ctx, { owners: 'all' }, ['output'])
    const p = producer()
    const id = ctx.jobs.start(p.spec)
    p.job().append('hello ')
    p.job().append('world', { channel: 'stderr' })
    const first = ctx.jobs.readAt(id, 0)
    expect(first).toEqual({
      chunks: [{ at: 0, text: 'hello ' }, { at: 6, text: 'world', channel: 'stderr' }],
      next: 11,
      lossy: false,
    })
    // A second identical read proves nothing was consumed.
    expect(ctx.jobs.readAt(id, 0)).toEqual(first)
    // Resuming from `next` yields nothing until more output arrives.
    expect(ctx.jobs.readAt(id, first.next).chunks).toEqual([])
    p.job().append('!')
    expect(ctx.jobs.readAt(id, first.next).chunks).toEqual([{ at: 11, text: '!' }])
    expect(ctx.jobs.get(id).output).toEqual({ total: 12, earliest: 0 })
    expect(outputs).toEqual([
      { type: 'output', id, total: 6 },
      { type: 'output', id, total: 11 },
      { type: 'output', id, total: 12 },
    ])
  })

  it('staged starter writes surface at the registration commit without observer signals', async () => {
    const ctx = await harness()
    const seen = collect(ctx)
    let settle!: (outcome: JobOutcome) => void
    const id = ctx.jobs.start({
      kind: 'bash',
      label: 'staged writes',
      run: (job) => {
        job.append('early ', { channel: 'stdout' })
        job.updateProgress('booting')
        return {
          cancel() {},
          done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
        }
      },
    })
    // Only the registration commit announced anything.
    expect(seen.map(event => event.type)).toEqual(['registered'])
    const view = ctx.jobs.get(id)
    expect(view.progress).toBe('booting')
    expect(view.output.total).toBe(6)
    expect(ctx.jobs.readAt(id, 0).chunks).toEqual([{ at: 0, text: 'early ', channel: 'stdout' }])
    settle({ status: 'completed' })
    await tick()
  })

  it('drops an empty append without waking observers', async () => {
    const ctx = await harness()
    const outputs = collect(ctx, { owners: 'all' }, ['output'])
    const p = producer()
    const id = ctx.jobs.start(p.spec)
    p.job().append('')
    expect(outputs).toEqual([])
    expect(ctx.jobs.get(id).output.total).toBe(0)
  })

  it('rejects a negative or fractional read offset', async () => {
    const ctx = await harness()
    const p = producer()
    const id = ctx.jobs.start(p.spec)
    expect(() => ctx.jobs.readAt(id, -1)).toThrow(/invalid output read offset/)
    expect(() => ctx.jobs.readAt(id, 0.5)).toThrow(/invalid output read offset/)
    expect(() => ctx.jobs.readAt(JobId('bash-99'), 0)).toThrow(/unknown job/)
  })

  it('keeps the spill file each source currently reports as job metadata, beyond any chunk', async () => {
    const ctx = await harness({ retainBytes: 4, pumpPollMs: 5 })
    let withdrawn = false
    const out: JobOutputSource = {
      channel: 'stdout',
      read: from => from === 0
        ? { text: 'abcdefgh', nextOffset: 8, lossy: false, spillPath: '/spill/out.log' }
        : { text: '', nextOffset: from, lossy: false, ...withdrawn ? {} : { spillPath: '/spill/out.log' } },
    }
    const err: JobOutputSource = {
      channel: 'stderr',
      read: from => ({ text: '', nextOffset: from, lossy: false, spillPath: '/spill/err.log' }),
    }
    const p = producer({ output: [out, err] })
    const id = ctx.jobs.start(p.spec)
    // The first drain ran inside start(): the live cap already evicted the head, yet the
    // projection still names the files — no chunk carried them.
    const view = ctx.jobs.get(id)
    expect(view.output).toEqual({ total: 8, earliest: 4, spillPaths: ['/spill/out.log', '/spill/err.log'] })
    expect(ctx.jobs.readAt(id, 0).chunks).toEqual([{ at: 4, text: 'efgh', channel: 'stdout', gapBefore: true }])

    // A source that stops naming its file (a failed seal) withdraws it on the next drain.
    withdrawn = true
    await new Promise<void>(resolve => setTimeout(resolve, 20))
    expect(ctx.jobs.get(id).output.spillPaths).toEqual(['/spill/err.log'])
    p.settle({ status: 'completed' })
    await tick()
  })

  it('announces registration before the pump drains a source that is readable at once', async () => {
    const ctx = await harness({ pumpPollMs: 5 })
    const events = collect(ctx)
    const source: JobOutputSource = {
      read: from => from === 0 ? { text: 'boot', nextOffset: 4, lossy: false } : { text: '', nextOffset: from, lossy: false },
    }
    const p = producer({ output: [source] })
    const id = ctx.jobs.start(p.spec)
    // The pump's first drain runs synchronously inside start(); the job's
    // first event is still its registration.
    expect(events.slice(0, 2).map(event => event.type)).toEqual(['registered', 'output'])
    expect(ctx.jobs.readAt(id, 0).chunks.map(chunk => chunk.text)).toEqual(['boot'])
    p.settle({ status: 'completed' })
    await tick()
  })

  it('evicts whole head chunks past the live cap and flags stale readers lossy', async () => {
    const ctx = await harness({ retainBytes: 8 })
    const p = producer()
    const id = ctx.jobs.start(p.spec)
    p.job().append('aaaa')
    p.job().append('bbbb')
    p.job().append('cccc')
    const read = ctx.jobs.readAt(id, 0)
    expect(read.lossy).toBe(true)
    expect(read.chunks).toEqual([{ at: 4, text: 'bbbb' }, { at: 8, text: 'cccc' }])
    expect(read.next).toBe(12)
    expect(ctx.jobs.get(id).output).toEqual({ total: 12, earliest: 4 })
    // A reader at the retained boundary is not lossy.
    expect(ctx.jobs.readAt(id, 4).lossy).toBe(false)
    // The model cursor is subject to the same eviction.
    expect(ctx.jobs.read(id).lossy).toBe(true)
  })

  it('settlement keeps the unconsumed stream for the model; the terminal read trims to the settled cap, ends the stream, and later writes drop', async () => {
    const ctx = await harness({ retainBytes: 1024, settledRetainBytes: 4 })
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    const outputs = collect(ctx, { owners: 'all' }, ['output'])
    const p = producer()
    const id = ctx.jobs.start(p.spec)
    p.job().append('abcdefgh')
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    await tick()
    expect(outputs.map(event => event.type === 'output' ? event.total : -1)).toEqual([8, 8])
    // Nothing the model has not read is trimmed at settlement: a job that
    // finishes before its first read still hands over everything the live
    // cap retained, and observers see the same bytes.
    expect(ctx.jobs.get(id)).toMatchObject({ status: 'completed', detail: 'exit code: 0', output: { total: 8, earliest: 0 } })
    expect(ctx.jobs.readAt(id, 0)).toMatchObject({ lossy: false, chunks: [{ at: 0, text: 'abcdefgh' }] })
    expect(ctx.jobs.read(id)).toMatchObject({ lossy: false, chunks: [{ at: 0, text: 'abcdefgh' }] })
    // The terminal read consumed the stream: retention drops to the settled cap.
    expect(ctx.jobs.get(id).output).toEqual({ total: 8, earliest: 4 })
    const read = ctx.jobs.readAt(id, 0)
    expect(read.lossy).toBe(true)
    expect(read.chunks).toEqual([{ at: 4, text: 'efgh', gapBefore: true }])
    // The stream ended with the settlement: a trailing flush cannot break teardown.
    p.job().append('late')
    p.job().updateProgress('late progress')
    expect(warn.mock.calls.map(call => String(call[0]))).toEqual([
      expect.stringContaining('append to settled job'),
      expect.stringContaining('progress update on settled job'),
    ])
    expect(outputs).toHaveLength(2)
    expect(ctx.jobs.get(id).progress).toBeUndefined()
  })

  it('a settlement after the model consumed the stream trims to the settled cap at once', async () => {
    const ctx = await harness({ retainBytes: 1024, settledRetainBytes: 4 })
    const p = producer()
    const id = ctx.jobs.start(p.spec)
    p.job().append('abcdefgh')
    expect(ctx.jobs.read(id).chunks).toEqual([{ at: 0, text: 'abcdefgh' }])
    p.settle({ status: 'completed' })
    await tick()
    expect(ctx.jobs.get(id).output).toEqual({ total: 8, earliest: 4 })
    // The cursor sits at the end: nothing new, and nothing lost behind it.
    expect(ctx.jobs.read(id)).toMatchObject({ chunks: [], lossy: false })
  })

  it('settlement clears the progress line; the terminal detail is the outcome alone', async () => {
    const ctx = await harness()
    const p = producer()
    const id = ctx.jobs.start(p.spec)
    p.job().updateProgress('3/10 agents done')
    expect(ctx.jobs.get(id)).toMatchObject({ progress: '3/10 agents done' })
    p.settle({ status: 'completed' })
    await tick()
    const view = ctx.jobs.get(id)
    expect(view.status).toBe('completed')
    expect(view.progress).toBeUndefined()
    expect(view.detail).toBeUndefined()
  })

  it('a teardown-forced settlement also ends the ring', async () => {
    const ctx = await harness()
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    const owner = await liveAgent(ctx, 'owner')
    const p = producer({ owner })
    const id = ctx.jobs.start(p.spec)
    p.job().append('partial')
    const disposal = disposeAgentScope(owner)
    p.settle({ status: 'killed' })
    await disposal
    expect(() => ctx.jobs.readAt(id, 0, owner.id)).toThrow(/unknown job/)
    // The producer face outlives the row; its trailing flush is dropped, not thrown.
    p.job().append('late')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('append to settled job'))
  })

  it('hands out fresh projections, never live registry state', async () => {
    const ctx = await harness()
    const p = producer()
    const id = ctx.jobs.start(p.spec)
    const before = ctx.jobs.get(id)
    p.job().append('grow')
    expect(before.output.total).toBe(0)
    expect(ctx.jobs.get(id).output.total).toBe(4)
  })
})

describe('LocalJobRegistry pull sources', () => {
  it('pumps the spec sources into the ring and drains them once more before settlement', async () => {
    const ctx = await harness({ pumpPollMs: 1 })
    const out = scriptedSource([{ text: 'a' }, { text: 'bc' }], 'stdout')
    // stderr only becomes readable once the producer has settled: the pump's
    // final drain is the only read that can collect it.
    let finishing = false
    let errOffset = 0
    const err: JobOutputSource = {
      channel: 'stderr',
      read() {
        const text = finishing && errOffset === 0 ? 'E' : ''
        errOffset += text.length
        return { text, nextOffset: errOffset, lossy: false }
      },
    }
    const p = producer({ output: [out, err] })
    const id = ctx.jobs.start(p.spec)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(ctx.jobs.readAt(id, 0).chunks.map(chunk => chunk.text)).toEqual(['a', 'bc'])

    const settled = collect(ctx, { owners: 'all' }, ['settled'])
    finishing = true
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    await new Promise(resolve => setTimeout(resolve, 10))
    // The final drain landed before the settlement announced itself.
    expect(settled).toHaveLength(1)
    expect(ctx.jobs.readAt(id, 0).chunks.map(chunk => chunk.text)).toEqual(['a', 'bc', 'E'])
    expect(ctx.jobs.get(id)).toMatchObject({ status: 'completed', output: { total: 4 } })
  })

  it('contains a throwing source: warns once, keeps the job live, and settles on the producer', async () => {
    const ctx = await harness({ pumpPollMs: 1 })
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    const broken: JobOutputSource = { channel: 'stdout', read() { throw new Error('reader boom') } }
    const healthy = scriptedSource([{ text: 'ok' }], 'stderr')
    const p = producer({ output: [broken, healthy] })
    const id = ctx.jobs.start(p.spec)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(ctx.jobs.get(id).status).toBe('running')
    expect(ctx.jobs.readAt(id, 0).chunks).toEqual([{ at: 0, text: 'ok', channel: 'stderr' }])
    expect(warn.mock.calls.map(call => String(call[0]))).toEqual([expect.stringContaining(`output source for ${id} failed`)])
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(ctx.jobs.get(id)).toMatchObject({ status: 'completed', detail: 'exit code: 0' })
  })

  it('stops pumping silently after a forced settlement', async () => {
    const ctx = await harness({ pumpPollMs: 1 })
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    const owner = await liveAgent(ctx, 'owner')
    const source: JobOutputSource = {
      read: fromByte => ({ text: 'x', nextOffset: fromByte + 1, lossy: false }),
    }
    ctx.jobs.start({
      kind: 'bash',
      label: 'endless',
      owner: owner.id,
      output: [source],
      run: () => ({ cancel() { throw new Error('cancel boom') }, done: new Promise(() => {}) }),
    })
    await new Promise(resolve => setTimeout(resolve, 5))
    await disposeAgentScope(owner)
    await new Promise(resolve => setTimeout(resolve, 5))
    // The forced failure is the only warning: the pump's later drains are silent.
    expect(warn.mock.calls.map(call => String(call[0]))).toEqual([expect.stringContaining('work may be orphaned')])
  })
})
