import { describe, expect, expectTypeOf, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobHooks, JobKind, JobOutcome, JobSnapshot, JobStart } from '@deepseek-ai/dsh-jobs'
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

/** A controllable producer start-spec: settle its `done` on demand, record cancels. */
function producer(overrides: Partial<Omit<JobStart, 'run'> & JobHooks> = {}) {
  let settle!: (outcome: JobOutcome) => void
  let reject!: (error: unknown) => void
  const cancels: (string | undefined)[] = []
  const { kind = 'bash', label = 'sleep 60', owner, outputLimitBytes, ...hookOverrides } = overrides
  const hooks: JobHooks = {
    cancel(reason) { cancels.push(reason) },
    done: new Promise<JobOutcome>((res, rej) => { settle = res; reject = rej }),
    ...hookOverrides,
  }
  const spec: JobStart = {
    kind,
    label,
    ...owner !== undefined ? { owner } : {},
    ...outputLimitBytes !== undefined ? { outputLimitBytes } : {},
    run: () => hooks,
  }
  return { spec, settle, reject, cancels }
}

async function harness(config: JobsConfig = {}) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry, config)
  ctx.jobs.attachController('test-controller')
  return ctx
}

/**
 * Attach a job controller the way `tool-jobs` does: from a plugin whose own
 * `inject` resolves `ctx.jobs`, so the service method binds to the REGISTERING
 * context and the controller files into that context's scope layer. Reading the
 * service off a bare scoped context instead throws `cannot get property "jobs"
 * without inject`, which is the same rule the shipped plugin obeys.
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

describe('LocalJobRegistry.start', () => {
  it('preserves the SessionId brand on public owner snapshots', () => {
    expectTypeOf<JobSnapshot['ownerSession']>().toEqualTypeOf<SessionId | undefined>()
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

    const served = stubAgent(ctx, 'served', scopeOf(withControls.ctx))
    const unserved = stubAgent(ctx, 'unserved', scopeOf(withoutControls.ctx))
    ctx.agents.register(served)
    ctx.agents.register(unserved)

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
    const scoped = stubAgent(ctx, 'scoped', scopeOf(createScope(ctx, {}).ctx))
    ctx.agents.register(scoped)

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

  it('accepts the largest safe integer limit', async () => {
    const ctx = await harness({ maxConcurrentJobsPerOwner: Number.MAX_SAFE_INTEGER })
    expect(ctx.jobs).toBeInstanceOf(LocalJobRegistry)
  })

  it('defaults each owner bucket to ten active jobs', async () => {
    const ctx = await harness()
    const live = Array.from({ length: 10 }, () => producer())
    for (const job of live) ctx.jobs.start(job.spec)

    const blocked = producer()
    const run = vi.fn(() => blocked.spec.run())
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
    const run = vi.fn(() => blocked.spec.run())
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

  it('isolates exact owners, replacement objects with the same session id, and the unowned bucket', async () => {
    const ctx = await harness({ maxConcurrentJobsPerOwner: 1 })
    const oldOwner = stubAgent(ctx, 'shared-session')
    const detachOld = ctx.agents.register(oldOwner)
    const oldTask = producer({ owner: oldOwner })
    ctx.jobs.start(oldTask.spec)

    const otherOwner = stubAgent(ctx, 'other-session')
    ctx.agents.register(otherOwner)
    expect(() => ctx.jobs.start(producer({ owner: otherOwner }).spec)).not.toThrow()

    detachOld()
    const replacement = stubAgent(ctx, 'shared-session')
    ctx.agents.register(replacement)
    expect(() => ctx.jobs.start(producer({ owner: replacement }).spec)).not.toThrow()

    ctx.jobs.start(producer().spec)
    expect(() => ctx.jobs.start(producer().spec)).toThrow('(limit: 1)')
    expect(() => ctx.jobs.start(producer({ owner: oldOwner }).spec))
      .toThrow('is not the registered agent instance')

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
  it('stream kinds read a consuming delta; terminal reads mark reported', async () => {
    const ctx = await harness()
    const chunks = ['first', '', 'rest']
    const p = producer({ readOutput: () => chunks.shift() ?? '' })
    const id = ctx.jobs.start(p.spec)

    expect(ctx.jobs.read(id)).toMatchObject({ text: 'first', snapshot: { status: 'running', reported: false } })
    expect(ctx.jobs.read(id).text).toBe('')

    p.settle({ status: 'completed', detail: 'exit code: 0' })
    await tick()
    const read = ctx.jobs.read(id)
    expect(read.text).toBe('rest')
    expect(read.snapshot).toMatchObject({ status: 'completed', detail: 'exit code: 0', reported: true })
    expect(read.snapshot.finishedAt).toBeTypeOf('number')
  })

  it('projects a producer-owned model output limit into reads and snapshots', async () => {
    const ctx = await harness()
    const p = producer({ outputLimitBytes: 64, readOutput: () => 'delta' })
    const id = ctx.jobs.start(p.spec)
    expect(ctx.jobs.read(id)).toMatchObject({
      text: 'delta', snapshot: { outputLimitBytes: 64 },
    })
    expect(ctx.jobs.get(id)).toMatchObject({ outputLimitBytes: 64 })
  })

  it('final-output kinds read empty while live, the outcome output idempotently once settled', async () => {
    const ctx = await harness()
    const p = producer({ kind: 'subagent', label: 'research job' })
    const id = ctx.jobs.start(p.spec)

    expect(ctx.jobs.read(id)).toMatchObject({ text: '', snapshot: { status: 'running' } })

    p.settle({ status: 'completed', output: 'final answer' })
    await tick()
    expect(ctx.jobs.read(id).text).toBe('final answer')
    expect(ctx.jobs.read(id).text).toBe('final answer') // idempotent, not consumed
  })

  it('a settled job without output reads as empty text', async () => {
    const ctx = await harness()
    const p = producer({ kind: 'subagent' })
    const id = ctx.jobs.start(p.spec)
    p.settle({ status: 'failed', detail: 'max-tokens' })
    await tick()
    expect(ctx.jobs.read(id)).toMatchObject({ text: '', snapshot: { status: 'failed', detail: 'max-tokens' } })
  })

  it('throws for unknown job ids', async () => {
    const ctx = await harness()
    expect(() => ctx.jobs.read(JobId('bash-99'))).toThrow('unknown job bash-99')
  })

  it('notifies onJobDone once per job with containment across listeners', async () => {
    const ctx = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const seen: JobSnapshot[] = []
    ctx.jobs.onJobDone(() => { throw new Error('listener boom') })
    ctx.jobs.onJobDone(snapshot => void seen.push(snapshot))

    const p = producer()
    const id = ctx.jobs.start(p.spec)
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    await tick()

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ id, status: 'completed', reported: false })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('listener boom'))
  })

  it('contains a rejecting onJobDone listener without starving later listeners', async () => {
    const ctx = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const seen: JobId[] = []
    ctx.jobs.onJobDone(async () => { throw new Error('async listener boom') })
    ctx.jobs.onJobDone(snapshot => void seen.push(snapshot.id))

    const p = producer()
    const id = ctx.jobs.start(p.spec)
    p.settle({ status: 'completed' })
    await tick()

    expect(seen).toEqual([id])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('onJobDone listener rejected'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('async listener boom'))
  })

  it("contains rejection from the producer's done promise as a failed outcome (producer contract violation)", async () => {
    const ctx = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const p = producer()
    const id = ctx.jobs.start(p.spec)
    p.reject(new Error('transport exploded'))
    await tick()

    expect(ctx.jobs.read(id).snapshot).toMatchObject({ status: 'failed', detail: 'Error: transport exploded' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('producer contract violation'))
  })

  it('unregisters onJobDone listeners with the contributing fiber (HMR safety)', async () => {
    const ctx = await harness()
    const seen: string[] = []
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.jobs.onJobDone(snapshot => void seen.push(snapshot.id))
    }, { inject: ['jobs'] }))
    await fiber.dispose()
    // The returned disposer detaches too (the non-fiber path).
    const detach = ctx.jobs.onJobDone(snapshot => void seen.push(snapshot.id))
    detach()

    const p = producer()
    ctx.jobs.start(p.spec)
    p.settle({ status: 'completed' })
    await tick()
    expect(seen).toEqual([])
  })
})

describe('LocalJobRegistry.kill', () => {
  it('cancels a live job with the forwarded reason and suppresses the notice', async () => {
    const ctx = await harness()
    const seen: JobSnapshot[] = []
    ctx.jobs.onJobDone(snapshot => void seen.push(snapshot))
    const p = producer()
    const id = ctx.jobs.start(p.spec)

    expect(ctx.jobs.kill(id, undefined, 'no longer needed')).toBe('requested')
    expect(p.cancels).toEqual(['no longer needed'])
    expect(ctx.jobs.list()[0]).toMatchObject({ status: 'stopping', reported: true })

    p.settle({ status: 'killed' })
    await tick()
    // The listener still fires (telemetry may care), but carries reported: true
    // so the notice path suppresses its redundant "finished".
    expect(seen[0]).toMatchObject({ id, status: 'killed', reported: true })
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
    const seen: JobSnapshot[] = []
    ctx.jobs.onJobDone(snapshot => void seen.push(snapshot))
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
    // The failed kill mutated NOTHING: still running, notice not suppressed,
    // and a later (successful) kill still works.
    expect(ctx.jobs.get(id)).toMatchObject({ status: 'running', reported: false })
    settle({ status: 'completed' })
    await tick()
    expect(seen[0]).toMatchObject({ id, reported: false }) // notice would still fire

    broken = false
    expect(ctx.jobs.kill(id)).toBe('already-finished')
  })
})

describe('LocalJobRegistry.wait', () => {
  it('resolves with the terminal snapshot when the job settles, marked reported', async () => {
    const ctx = await harness()
    const seen: JobSnapshot[] = []
    ctx.jobs.onJobDone(snapshot => void seen.push(snapshot))
    const p = producer()
    const id = ctx.jobs.start(p.spec)

    const wait = ctx.jobs.wait(id, 5_000)
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    expect(await wait).toMatchObject({ status: 'completed', reported: true })
    // A waiting reader claims delivery before completion listeners inspect the snapshot.
    expect(seen[0]).toMatchObject({ id, reported: true })
  })

  it('returns the live snapshot on timeout without marking reported', async () => {
    const ctx = await harness()
    const id = ctx.jobs.start(producer().spec)
    expect(await ctx.jobs.wait(id, 5)).toMatchObject({ status: 'running', reported: false })
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
    expect(await ctx.jobs.wait(id, 5_000)).toMatchObject({ status: 'completed', reported: true })
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

  it('an abort racing settlement in the same tick does not swallow the notice', async () => {
    const ctx = await harness()
    const seen: JobSnapshot[] = []
    ctx.jobs.onJobDone(snapshot => void seen.push(snapshot))
    const p = producer()
    const id = ctx.jobs.start(p.spec)

    const controller = new AbortController()
    const wait = ctx.jobs.wait(id, 5_000, undefined, controller.signal)
    // Settlement is queued first, so abort must remove the waiter synchronously;
    // otherwise settlement suppresses the notice for a reader that receives nothing.
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    controller.abort()
    await expect(wait).rejects.toThrow('wait aborted')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ id, status: 'completed', reported: false })
  })

  it('an abort landing after settlement still delivers the terminal snapshot it owes', async () => {
    const ctx = await harness()
    const controller = new AbortController()
    const seen: JobSnapshot[] = []
    // The listener aborts after settlement released this waiter but before its
    // resolve microtask runs. Releasing waiters ahead of the announcement is
    // what makes that abort harmless; this is the guard on that ordering.
    ctx.jobs.onJobDone((snapshot) => {
      seen.push(snapshot)
      controller.abort()
    })
    const p = producer()
    const id = ctx.jobs.start(p.spec)

    const wait = ctx.jobs.wait(id, 5_000, undefined, controller.signal)
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    await expect(wait).resolves.toMatchObject({ status: 'completed', reported: true })
    expect(seen[0]).toMatchObject({ id, reported: true }) // suppression stays honest: the wait delivered
  })
})

describe('LocalJobRegistry owner isolation', () => {
  it('fences read/kill/wait to the owning session and keeps unowned jobs open', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)
    const other = stubAgent(ctx, 'other')

    const owned = ctx.jobs.start(producer({ owner }).spec)
    const open = ctx.jobs.start(producer().spec)

    // The owner and the unowned job are reachable.
    expect(ctx.jobs.read(owned, owner).snapshot.id).toBe(owned)
    expect(ctx.jobs.read(open, other).snapshot.id).toBe(open)

    // A different session and a no-agent caller are rejected.
    expect(() => ctx.jobs.read(owned, other)).toThrow(`job ${owned} belongs to another session`)
    expect(() => ctx.jobs.kill(owned, other)).toThrow('belongs to another session')
    await expect(ctx.jobs.wait(owned, 10, other)).rejects.toThrow('belongs to another session')
    expect(() => ctx.jobs.read(owned)).toThrow('belongs to another session')
  })

  it('list() shows only caller-owned plus unowned jobs', async () => {
    const ctx = await harness()
    const alice = stubAgent(ctx, 'alice')
    const bob = stubAgent(ctx, 'bob')
    ctx.agents.register(alice)
    ctx.agents.register(bob)

    const aliceTask = ctx.jobs.start(producer({ owner: alice }).spec)
    const bobTask = ctx.jobs.start(producer({ owner: bob }).spec)
    const openTask = ctx.jobs.start(producer({ kind: 'subagent' }).spec)

    expect(ctx.jobs.list(alice).map(t => t.id)).toEqual([aliceTask, openTask])
    expect(ctx.jobs.list(bob).map(t => t.id)).toEqual([bobTask, openTask])
    expect(ctx.jobs.list().map(t => t.id)).toEqual([openTask])
  })

  it('rejects an owned registration when no agent registry is mounted', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('test-controller')
    expect(() => ctx.jobs.start(producer({ owner: stubAgent(ctx, 'a') }).spec))
      .toThrow('background job ownership requires the agent registry')
    // The failed registration mutated nothing: no stored job, counter untouched.
    expect(ctx.jobs.list()).toEqual([])
    expect(ctx.jobs.start(producer().spec)).toBe('bash-1')
  })

  it('a failed owner-cleanup attach leaves the registry unchanged and does not poison the owner', async () => {
    const ctx = await harness()
    const ghost = stubAgent(ctx, 'ghost') // never registered in ctx.agents

    // Exact-instance validation precedes registry mutation and cleanup attachment.
    expect(() => ctx.jobs.start(producer({ owner: ghost }).spec))
      .toThrow('is not the registered agent instance')
    expect(ctx.jobs.list(ghost)).toEqual([])

    // A later valid registration must still attach cleanup for the same object.
    ctx.agents.register(ghost)
    const cancels: (string | undefined)[] = []
    let settle!: (outcome: JobOutcome) => void
    const id = ctx.jobs.start({
      kind: 'bash',
      label: 'after retry',
      owner: ghost,
      run: () => ({
        cancel(reason) { cancels.push(reason); settle({ status: 'killed' }) },
        done: new Promise<JobOutcome>((res) => { settle = res }),
      }),
    })
    expect(id).toBe('bash-1') // the failed attempt burned no counter
    await disposeAgentScope(ghost)
    expect(cancels).toEqual(['owner disposed'])
    expect(ctx.jobs.list(ghost)).toEqual([])
  })

  it('rejects a stale owner instance after another agent reuses its id', async () => {
    const ctx = await harness()
    const staleOwner = stubAgent(ctx, 'owner')
    const unregisterStale = ctx.agents.register(staleOwner)
    unregisterStale()

    const currentOwner = stubAgent(ctx, 'owner')
    ctx.agents.register(currentOwner)
    const current = producer({ owner: currentOwner })
    ctx.jobs.start(current.spec) // Attach the current owner's cleanup first.

    const stale = producer({ owner: staleOwner })
    const staleRun = vi.fn(() => stale.spec.run())
    expect(() => ctx.jobs.start({ ...stale.spec, run: staleRun }))
      .toThrow('is not the registered agent instance')
    expect(staleRun).not.toHaveBeenCalled()
    // Access is keyed by the unified session id, so a reconnect carrying the
    // same identity can observe the current job even though stale ownership
    // registration is rejected by exact-instance validation.
    expect(ctx.jobs.list(staleOwner)).toHaveLength(1)
    expect(ctx.jobs.list(currentOwner)).toHaveLength(1)

    current.settle({ status: 'completed' })
    await tick()
    await disposeAgentScope(currentOwner)
  })
})

describe('LocalJobRegistry owner cleanup', () => {
  it('drains the owner: cancels live jobs, awaits settlement, drops snapshots', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)

    // The producer settles only when cancelled — models a child that stops on request.
    let settle!: (outcome: JobOutcome) => void
    const cancels: (string | undefined)[] = []
    ctx.jobs.start({
      kind: 'subagent',
      label: 'long research',
      owner,
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
    // Snapshots dropped: nothing of the owner's remains, listing is empty.
    expect(ctx.jobs.list(owner)).toEqual([])
  })

  it('publishes the settled visible set before announcing completion', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)
    const p = producer({ owner })
    ctx.jobs.start(p.spec)
    // Registered after start so only the settlement's notifications are ordered.
    const order: string[] = []
    ctx.jobs.onJobsChanged(() => void order.push('changed'))
    ctx.jobs.onJobDone(() => void order.push('done'))

    p.settle({ status: 'completed' })
    await tick()

    // A completion reporter may open a turn synchronously. Announcing before
    // the visible set is published would let a client render that turn while
    // its job row still reads `running`.
    expect(order).toEqual(['changed', 'done'])
  })

  it('reports a teardown-cancelled record so completion reporters stay quiet', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)
    const seen: JobSnapshot[] = []
    ctx.jobs.onJobDone(snapshot => void seen.push(snapshot))

    let settle!: (outcome: JobOutcome) => void
    ctx.jobs.start({
      kind: 'subagent',
      label: 'long research',
      owner,
      run: () => ({
        cancel() { settle({ status: 'killed' }) },
        done: new Promise<JobOutcome>((res) => { settle = res }),
      }),
    })

    // Observers still receive the terminal record; the report bit is what
    // keeps a notice reporter from addressing an owner being destroyed.
    await disposeAgentScope(owner)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.reported).toBe(true)
  })

  it('attaches one cleanup per owner and drains all owned jobs with the scope', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)

    const first = producer({ owner })
    const second = producer({ owner })
    ctx.jobs.start(first.spec)
    ctx.jobs.start(second.spec)
    first.settle({ status: 'completed' })
    second.settle({ status: 'completed' })
    await tick()
    expect(owner.ctx.fiber.getEffects().filter(effect => effect.label === 'jobs.ownerCleanup()')).toHaveLength(1)
    await disposeAgentScope(owner)
    expect(ctx.jobs.list(owner)).toEqual([])
  })

  it('does not let an old scope cleanup cancel a same-id/session replacement job', async () => {
    const ctx = await harness()
    const oldOwner = stubAgent(ctx, 'owner')
    const detachOld = ctx.agents.register(oldOwner)
    const cancels: string[] = []

    function start(owner: Agent, label: string): JobId {
      let settle!: (outcome: JobOutcome) => void
      return ctx.jobs.start({
        kind: 'bash',
        label,
        owner,
        run: () => ({
          cancel() { cancels.push(label); settle({ status: 'killed' }) },
          done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
        }),
      })
    }

    start(oldOwner, 'old job')
    detachOld()
    const replacement = stubAgent(ctx, 'owner')
    ctx.agents.register(replacement)
    const replacementId = start(replacement, 'replacement job')

    await disposeAgentScope(oldOwner)
    expect(cancels).toEqual(['old job'])
    expect(ctx.jobs.list(replacement).map(job => job.id)).toEqual([replacementId])

    await disposeAgentScope(replacement)
    expect(cancels).toEqual(['old job', 'replacement job'])
  })

  it('registers owner cleanup on the agent scope rather than the jobs fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const tasksFiber = await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('test-controller')
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)
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
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)
    const seen: JobSnapshot[] = []
    ctx.jobs.onJobDone(snapshot => void seen.push(snapshot))

    let settle!: (outcome: JobOutcome) => void
    ctx.jobs.start({
      kind: 'bash',
      label: 'broken producer',
      owner,
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
    expect(seen[0]?.status).toBe('failed')
    expect(seen[0]?.detail).toContain('cancel threw during teardown')
    expect(ctx.jobs.list(owner)).toEqual([])
  })
})

describe('LocalJobRegistry disposal', () => {
  it('cancels live jobs, awaits settlement, and silences listeners', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(LocalJobRegistry)
    const controller = await ctx.plugin(Object.assign((inner: Context) => {
      inner.jobs.attachController('test-controller')
    }, { inject: ['jobs'] }))
    void controller

    const seen: string[] = []
    ctx.jobs.onJobDone(snapshot => void seen.push(snapshot.id))
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
    // The teardown kill settles AFTER the listener registry closed: silent.
    expect(seen).toEqual([])
  })

  it('force-fails a throwing cancel so service disposal does not await producer done', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('test-controller')
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const seen: JobSnapshot[] = []
    ctx.jobs.onJobDone(snapshot => void seen.push(snapshot))

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
    expect(seen).toEqual([])
  })

  it('detaches owner effects from still-live agent scopes when the service unloads', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const tasksFiber = await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('test-controller')
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)
    let settle!: (outcome: JobOutcome) => void
    ctx.jobs.start({
      kind: 'bash',
      label: 'owned work',
      owner,
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
        pluginCtx.jobs.onJobDone(() => {})
      },
    })
    const owner = stubAgent(ctx, 'joined', scopeOf(standing.ctx))
    ctx.agents.register(owner)
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

describe('LocalJobRegistry.onJobsChanged', () => {
  it('fires after registration, the stopping transition, and settlement', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'alice')
    ctx.agents.register(owner)
    const seen: (string | undefined)[] = []
    ctx.jobs.onJobsChanged(changed => void seen.push(changed?.id))

    const p = producer({ owner })
    const id = ctx.jobs.start(p.spec)
    // Registration is announced only once the record is readable.
    expect(seen).toEqual(['alice'])
    expect(ctx.jobs.list(owner)).toHaveLength(1)

    expect(ctx.jobs.kill(id, owner)).toBe('requested')
    expect(seen).toEqual(['alice', 'alice'])
    expect(ctx.jobs.get(id, owner).status).toBe('stopping')

    p.settle({ status: 'killed' })
    await tick()
    expect(seen).toEqual(['alice', 'alice', 'alice'])
    expect(ctx.jobs.get(id, owner).status).toBe('killed')
    await disposeAgentScope(owner)
  })

  it('reports an unowned change as undefined, since every caller can see it', async () => {
    const ctx = await harness()
    const seen: (string | undefined)[] = []
    ctx.jobs.onJobsChanged(changed => void seen.push(changed?.id))

    ctx.jobs.start(producer().spec)
    expect(seen).toEqual([undefined])
  })

  it('announces the owner-disposal removal, and stays silent when that owner had none', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'alice')
    const bystander = stubAgent(ctx, 'bob')
    ctx.agents.register(owner)
    ctx.agents.register(bystander)
    const p = producer({ owner })
    ctx.jobs.start(p.spec)

    const seen: (string | undefined)[] = []
    ctx.jobs.onJobsChanged(changed => void seen.push(changed?.id))
    p.settle({ status: 'completed' })
    await tick()
    expect(seen).toEqual(['alice'])

    // Disposing an owner with no records changes no visible set.
    await disposeAgentScope(bystander)
    expect(seen).toEqual(['alice'])

    await disposeAgentScope(owner)
    expect(seen).toEqual(['alice', 'alice'])
    expect(ctx.jobs.list(owner)).toEqual([])
  })

  it('contains a throwing listener so the lifecycle commit still stands', async () => {
    const ctx = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const seen: (string | undefined)[] = []
    ctx.jobs.onJobsChanged(() => { throw new Error('observer boom') })
    ctx.jobs.onJobsChanged(changed => void seen.push(changed?.id))

    const id = ctx.jobs.start(producer().spec)
    expect(id).toBe('bash-1')
    expect(seen).toEqual([undefined])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('onJobsChanged listener threw'))
  })

  it('unregisters through its disposer and with its fiber (HMR safety)', async () => {
    const ctx = await harness()
    const seen: number[] = []
    const detach = ctx.jobs.onJobsChanged(() => void seen.push(1))
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      inner.jobs.onJobsChanged(() => void seen.push(2))
    }, { inject: ['jobs'] }))

    ctx.jobs.start(producer().spec)
    expect(seen).toEqual([1, 2])

    detach()
    detach() // second call of the same disposer is a no-op
    ctx.jobs.start(producer().spec)
    expect(seen).toEqual([1, 2, 2])

    await fiber.dispose()
    ctx.jobs.start(producer().spec)
    expect(seen).toEqual([1, 2, 2])
  })
})

describe('LocalJobRegistry teardown change notifications', () => {
  it('announces the stopping transition during owner teardown, before settlement', async () => {
    const ctx = await harness()
    const owner = stubAgent(ctx, 'alice')
    ctx.agents.register(owner)
    const p = producer({ owner })
    const id = ctx.jobs.start(p.spec)

    const statuses: (string | undefined)[] = []
    ctx.jobs.onJobsChanged((changed) => {
      statuses.push(changed === undefined ? undefined : ctx.jobs.list(changed)[0]?.status)
    })

    // A slow producer keeps teardown parked between cancel and settlement;
    // an observer must not be left showing `running` for that whole window.
    const disposal = disposeAgentScope(owner)
    await tick()
    expect(statuses).toEqual(['stopping'])

    p.settle({ status: 'killed' })
    await disposal
    // Settlement, then the removal that empties the visible set.
    expect(statuses).toEqual(['stopping', 'killed', undefined])
    expect(ctx.jobs.list(owner)).toEqual([])
    void id
  })

  it('announces the emptied set to a listener registered outside this service (reload safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(LocalJobRegistry)
    ctx.jobs.attachController('test-controller')

    // The api-proxy carrier registers from its own stream context, not the
    // registry's fiber, so it is still listening when the registry unloads.
    const seen: (string | undefined)[] = []
    ctx.jobs.onJobsChanged(changed => void seen.push(changed?.id))
    let settle!: (outcome: JobOutcome) => void
    ctx.jobs.start({
      kind: 'bash',
      label: 'sleep 600',
      run: () => ({
        cancel() { settle({ status: 'killed' }) },
        done: new Promise<JobOutcome>((resolve) => { settle = resolve }),
      }),
    })
    seen.length = 0

    await fiber.dispose()
    // stopping (teardown cancel), settlement, then the final empty set.
    expect(seen).toEqual([undefined, undefined, undefined])
  })
})
