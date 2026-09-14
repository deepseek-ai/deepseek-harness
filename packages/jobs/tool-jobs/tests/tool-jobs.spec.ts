import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { emitAgentEvent } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { JobId } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import type { JobHooks, JobOutcome, JobSnapshot, JobStart } from '@deepseek-ai/dsh-jobs'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import { statusLine } from '@deepseek-ai/dsh-tool-jobs'

const testToolSignal = new AbortController().signal

const agentRegistryDisposers = new WeakMap<Agent, () => Promise<void>>()
const agentScopeFibers = new WeakMap<Agent, { dispose: () => Promise<void> }>()

async function setup(config: ToolJobs.Config = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const agentsFiber = await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  const toolsFiber = await ctx.plugin(ToolJobs, config)
  return { ctx, agentsFiber, toolsFiber }
}

/** The delivery surface a completion notice may reach on a fake owner. */
interface FakeDelivery {
  inject?: (...args: unknown[]) => void
  followup?: (...args: unknown[]) => void
  /** Defaults to `running`, the lane that never wakes, so notice-content tests pin one lane. */
  status?: 'idle' | 'running'
}

/**
 * A fake agent with the shared agent/session identity, registered in
 * `ctx.agents` with a dedicated lifecycle scope.
 */
async function fakeAgent(ctx: Context, sessionId: string, delivery: FakeDelivery = {}): Promise<Agent> {
  const scopeFiber = ctx.plugin(() => {})
  const id = SessionId(sessionId)
  const agent = {
    id,
    ctx: scopeFiber.ctx,
    inject: delivery.inject ?? (() => {}),
    followup: delivery.followup ?? (() => {}),
    status: delivery.status ?? 'running',
    session: { id, header: { version: 0, id, createdAt: 0 } },
  } as unknown as Agent
  agentRegistryDisposers.set(agent, await ctx.agents.register(agent))
  agentScopeFibers.set(agent, scopeFiber)
  return agent
}

async function detachAgent(agent: Agent): Promise<void> {
  const dispose = agentRegistryDisposers.get(agent)
  if (dispose === undefined) throw new Error(`missing registry disposer for agent "${agent.id}"`)
  await dispose()
}

/** Dispose the agent's own lifecycle scope, which is what drains its owned jobs. */
async function disposeAgentScope(agent: Agent): Promise<void> {
  const fiber = agentScopeFibers.get(agent)
  if (fiber === undefined) throw new Error(`missing scope fiber for agent "${agent.id}"`)
  await fiber.dispose()
}

/** A controllable producer start-spec (settle `done` on demand, record cancels). */
function producer(overrides: Partial<Omit<JobStart, 'run'> & JobHooks> = {}) {
  let settle!: (outcome: JobOutcome) => void
  const cancels: (string | undefined)[] = []
  const { kind = 'bash', label = 'sleep 60', owner, outputLimitBytes, ...hookOverrides } = overrides
  const hooks: JobHooks = {
    cancel(reason) { cancels.push(reason) },
    done: new Promise<JobOutcome>((res) => { settle = res }),
    ...hookOverrides,
  }
  const spec: JobStart = {
    kind,
    label,
    ...owner !== undefined ? { owner } : {},
    ...outputLimitBytes !== undefined ? { outputLimitBytes } : {},
    run: () => hooks,
  }
  return { spec, settle, cancels }
}

let callCounter = 0
function call(ctx: Context, name: string, args: unknown, agent?: Agent) {
  return ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId(`call-${++callCounter}`), name, arguments: args, ...agent ? { agent } : {} })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

const tick = () => new Promise<void>(r => setTimeout(r, 0))

/** Start and settle `count` owned jobs one at a time, letting each notice land. */
async function settleTasks(ctx: Context, owner: Agent, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const p = producer({ owner })
    ctx.jobs.start(p.spec)
    p.settle({ status: 'completed' })
    await tick()
  }
}

describe('tool-jobs setup', () => {
  it('attaches the job controller on load and detaches it with the fiber', async () => {
    const { ctx, toolsFiber } = await setup()
    expect(() => ctx.jobs.start(producer().spec)).not.toThrow()
    await toolsFiber.dispose()
    expect(() => ctx.jobs.start(producer().spec)).toThrow('no job controller serves this agent')
  })

  it('rejects a config whose default wait exceeds the cap', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalJobRegistry)
    await expect(ctx.plugin(ToolJobs, { waitTimeoutMs: 100, maxWaitTimeoutMs: 50 }))
      .rejects.toThrow('waitTimeoutMs (100) exceeds maxWaitTimeoutMs (50)')
  })

  it('defaults delivery to wakeup and rejects an unknown lane', () => {
    expect(ToolJobs.Config({}).completionDelivery).toBe('wakeup')
    expect(ToolJobs.Config({}).maxConsecutiveWakes).toBe(3)
    expect(() => ToolJobs.Config({ completionDelivery: 'loud' as never })).toThrow()
    expect(() => ToolJobs.Config({ maxConsecutiveWakes: 0 })).toThrow()
  })

  it('rejects a wake budget that cannot bound anything', async () => {
    // Reports the load outcome as text: a resolved fiber is not safely printable.
    const loadWith = async (maxConsecutiveWakes: number): Promise<string> => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(LocalJobRegistry)
      try {
        await ctx.plugin(ToolJobs, { maxConsecutiveWakes })
        return 'loaded'
      } catch (error: unknown) {
        return String(error)
      }
    }

    // The field exists to bound runaway waking; a fractional budget counts
    // nothing and an infinite one removes the bound it was configured for.
    expect(await loadWith(Number.POSITIVE_INFINITY)).toContain('maxConsecutiveWakes')
    expect(await loadWith(2.5)).toContain('maxConsecutiveWakes')
    expect(await loadWith(1)).toBe('loaded')
  })

  it('renders status lines with and without producer detail', () => {
    const base = { id: 'bash-1', kind: 'bash', label: 'x', startedAt: 0, reported: false } as unknown as JobSnapshot
    expect(statusLine({ ...base, status: 'running' })).toBe('[status: running]')
    expect(statusLine({ ...base, status: 'completed', detail: 'exit code: 0' })).toBe('[status: completed, exit code: 0]')
  })

  it('applies the built-in wait bounds when apply() receives a bare config', async () => {
    // Bypasses the schemastery defaults on purpose: apply() must stand on its
    // own `??` fallbacks when embedded programmatically without the schema.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalJobRegistry)
    ToolJobs.apply(ctx, {})
    expect(ctx.tools.get('job_output')).toBeDefined()
    expect(() => ctx.jobs.start(producer().spec)).not.toThrow()
  })
})

describe('job_output', () => {
  it('reads a consuming delta with a trailing status line', async () => {
    const { ctx } = await setup()
    const chunks = ['line one\n', '']
    ctx.jobs.start(producer({ readOutput: () => chunks.shift() ?? '' }).spec)

    // A body already ending in a newline gets no doubled separator.
    const first = await call(ctx, 'job_output', { job_id: 'bash-1' })
    if (first.isError) throw new Error('expected job_output success')
    const firstValue = first.value as { text: string; job: Record<string, unknown> }
    expect(firstValue).toMatchObject({
      text: 'line one\n',
      job: { id: 'bash-1', kind: 'bash', label: 'sleep 60', status: 'running' },
    })
    expect(firstValue.job).not.toHaveProperty('ownerSession')
    expect(firstValue.job).not.toHaveProperty('reported')
    expect(text(first)).toBe('line one\n[status: running]')
    expect(text(await call(ctx, 'job_output', { job_id: 'bash-1' }))).toBe('(no new output)\n[status: running]')
  })

  it('returns the final output of a settled final-output job', async () => {
    const { ctx } = await setup()
    const p = producer({ kind: 'subagent', label: 'research' })
    ctx.jobs.start(p.spec)
    expect(text(await call(ctx, 'job_output', { job_id: 'subagent-1' }))).toBe('(no new output)\n[status: running]')

    p.settle({ status: 'completed', detail: 'completed', output: 'the answer' })
    await tick()
    expect(text(await call(ctx, 'job_output', { job_id: 'subagent-1' }))).toBe('the answer\n[status: completed, completed]')
  })

  it('applies a producer limit to the complete body and status result', async () => {
    const { ctx } = await setup()
    ctx.jobs.start(producer({
      outputLimitBytes: 48,
      readOutput: () => '界'.repeat(100),
    }).spec)

    const output = text(await call(ctx, 'job_output', { job_id: 'bash-1' }))
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(48)
    expect(output).toContain('[status: running]')
  })

  it('preserves empty and newline-terminated output under a producer limit', async () => {
    const { ctx } = await setup()
    const chunks = ['', 'line\n']
    ctx.jobs.start(producer({
      outputLimitBytes: 64,
      readOutput: () => chunks.shift() ?? '',
    }).spec)

    expect(text(await call(ctx, 'job_output', { job_id: 'bash-1' })))
      .toBe('(no new output)\n[status: running]')
    expect(text(await call(ctx, 'job_output', { job_id: 'bash-1' })))
      .toBe('line\n[status: running]')
  })

  it('bounds post-policy output without restoring the canonical status rendering', async () => {
    const { ctx } = await setup()
    ctx.jobs.start(producer({
      outputLimitBytes: 64,
      readOutput: () => 'canonical output',
    }).spec)
    ctx.on('tools/post-execute', (exec, _result, next) => {
      if (exec.name !== 'job_output') return next()
      return Promise.resolve({ kind: 'accept', content: [{ type: 'text', text: 'p'.repeat(1_000) }] })
    })

    const result = await call(ctx, 'job_output', { job_id: 'bash-1' })
    expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(64)
    expect(text(result)).toContain('[result truncated]')
    expect(text(result)).not.toContain('[status: running]')
  })

  it('applies a producer limit to a normalized read failure', async () => {
    const { ctx } = await setup()
    ctx.jobs.start(producer({
      outputLimitBytes: 64,
      readOutput: () => { throw new Error('read failed: '.repeat(100)) },
    }).spec)

    const result = await call(ctx, 'job_output', { job_id: 'bash-1' })
    expect(result.isError).toBe(true)
    expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(64)
    expect(text(result)).toContain('[result truncated]')
  })

  it('bounds pre-, around-, and post-execute policy outcomes and failures', async () => {
    const { ctx } = await setup()
    for (let index = 0; index < 5; index += 1) {
      ctx.jobs.start(producer({ outputLimitBytes: 64 }).spec)
    }
    ctx.on('tools/pre-execute', async (exec, next) => {
      const jobId = (exec.arguments as { job_id?: unknown }).job_id
      if (jobId === 'bash-1') return { kind: 'deny', reason: 'd'.repeat(1_000) }
      if (jobId === 'bash-3') throw new Error(`pre failed: ${'p'.repeat(1_000)}`)
      return next()
    })
    ctx.on('tools/execute', async (exec, next) => {
      const jobId = (exec.arguments as { job_id?: unknown }).job_id
      if (jobId === 'bash-2') {
        return {
          content: [],
          isError: false,
          value: {
            text: 'a'.repeat(1_000),
            job: {
              id: 'bash-2', kind: 'bash', label: 'sleep 60', status: 'running', startedAt: 0,
            },
          },
        }
      }
      if (jobId === 'bash-4') throw new Error(`around failed: ${'e'.repeat(1_000)}`)
      return next()
    })
    ctx.on('tools/post-execute', async (exec, _result, next) => {
      const jobId = (exec.arguments as { job_id?: unknown }).job_id
      if (jobId === 'bash-5') throw new Error(`post failed: ${'o'.repeat(1_000)}`)
      return next()
    })

    const denied = await call(ctx, 'job_output', { job_id: 'bash-1' })
    expect(denied.isError).toBe(true)
    expect(Buffer.byteLength(text(denied))).toBeLessThanOrEqual(64)
    expect(text(denied)).toContain('[result truncated]')

    const shortCircuited = await call(ctx, 'job_output', { job_id: 'bash-2' })
    expect(shortCircuited.isError).toBe(false)
    expect(Buffer.byteLength(text(shortCircuited))).toBeLessThanOrEqual(64)
    expect(text(shortCircuited)).toContain('[output truncated]')

    const failures = [
      await call(ctx, 'job_output', { job_id: 'bash-3' }),
      await call(ctx, 'job_output', { job_id: 'bash-4' }),
      await call(ctx, 'job_output', { job_id: 'bash-5' }),
    ]
    for (const failure of failures) {
      expect(failure.isError).toBe(true)
      expect(Buffer.byteLength(text(failure))).toBeLessThanOrEqual(64)
      expect(text(failure)).toContain('[result truncated]')
    }
  })

  it('wait: true blocks until settlement and reports the terminal state', async () => {
    const { ctx } = await setup()
    const p = producer({ kind: 'subagent', label: 'research' })
    ctx.jobs.start(p.spec)

    const pending = call(ctx, 'job_output', { job_id: 'subagent-1', wait: true })
    p.settle({ status: 'completed', output: 'done deal' })
    expect(text(await pending)).toBe('done deal\n[status: completed]')
  })

  it('wait: true times out against the configured cap and leaves the job alive', async () => {
    const { ctx } = await setup({ waitTimeoutMs: 10, maxWaitTimeoutMs: 20 })
    ctx.jobs.start(producer().spec)

    // A model-supplied timeout far above the cap is clamped: this returns
    // promptly (≤ the 20ms cap), not after ten minutes.
    const result = await call(ctx, 'job_output', { job_id: 'bash-1', wait: true, timeout_ms: 600_000 })
    expect(text(result)).toBe('(no new output)\n[status: running]')
  })

  it('rejects an empty or unknown job id as an errored result', async () => {
    const { ctx } = await setup()
    expect((await call(ctx, 'job_output', { job_id: '' })).isError).toBe(true)
    const unknown = await call(ctx, 'job_output', { job_id: 'bash-99' })
    expect(unknown.isError).toBe(true)
    expect(text(unknown)).toContain('unknown job bash-99')
  })
})

describe('job_list', () => {
  it('lists caller-visible jobs and renders the empty case', async () => {
    const { ctx } = await setup()
    expect(text(await call(ctx, 'job_list', {}))).toBe('(no background jobs)')

    const alice = await fakeAgent(ctx, 'sess-alice')
    ctx.jobs.start(producer({ owner: alice, label: 'pnpm test' }).spec)
    ctx.jobs.start(producer({ kind: 'subagent', label: 'open research' }).spec)
    const p = producer({ owner: alice, label: 'build' })
    ctx.jobs.start(p.spec)
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    await tick()

    const listed = await call(ctx, 'job_list', {}, alice)
    if (listed.isError) throw new Error('expected job_list success')
    const listedValue = listed.value as Array<Record<string, unknown>>
    expect(listedValue).toHaveLength(3)
    expect(listedValue[0]).toMatchObject({ id: 'bash-1', kind: 'bash', label: 'pnpm test', status: 'running' })
    expect(listedValue[2]).toMatchObject({ id: 'bash-2', kind: 'bash', label: 'build', status: 'completed', detail: 'exit code: 0' })
    for (const job of listedValue) {
      expect(job).not.toHaveProperty('ownerSession')
      expect(job).not.toHaveProperty('reported')
    }
    expect(text(listed)).toBe([
      'bash-1 [bash] running — pnpm test',
      'subagent-1 [subagent] running — open research',
      'bash-2 [bash] completed — build',
    ].join('\n'))
    // A different caller sees only the unowned job.
    const bob = await fakeAgent(ctx, 'sess-bob')
    expect(text(await call(ctx, 'job_list', {}, bob))).toBe('subagent-1 [subagent] running — open research')
  })
})

describe('job_kill', () => {
  it('requests cancellation with the forwarded reason', async () => {
    const { ctx } = await setup()
    const p = producer()
    ctx.jobs.start(p.spec)

    const result = await call(ctx, 'job_kill', { job_id: 'bash-1', reason: 'superseded' })
    if (result.isError) throw new Error('expected job_kill success')
    const killValue = result.value as { outcome: string; job: Record<string, unknown> }
    expect(killValue).toMatchObject({
      outcome: 'cancellation-requested',
      job: { id: 'bash-1', kind: 'bash', label: 'sleep 60', status: 'stopping' },
    })
    expect(killValue.job).not.toHaveProperty('ownerSession')
    expect(killValue.job).not.toHaveProperty('reported')
    expect(text(result)).toBe('requested cancellation of job bash-1')
    expect(p.cancels).toEqual(['superseded'])
  })

  it('applies the producer output limit to a cancellation acknowledgement', async () => {
    const { ctx } = await setup()
    const p = producer({ outputLimitBytes: 8 })
    ctx.jobs.start(p.spec)

    const result = await call(ctx, 'job_kill', { job_id: 'bash-1' })
    expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(8)
    expect(p.cancels).toEqual([undefined])
  })

  it('applies the producer output limit to a normalized cancellation failure', async () => {
    const { ctx } = await setup()
    ctx.jobs.start(producer({
      outputLimitBytes: 64,
      cancel: () => { throw new Error('cancel failed: '.repeat(100)) },
    }).spec)

    const result = await call(ctx, 'job_kill', { job_id: 'bash-1' })
    expect(result.isError).toBe(true)
    expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(64)
    expect(text(result)).toContain('[result truncated]')
    expect(ctx.jobs.get(JobId('bash-1'))).toMatchObject({ status: 'running', reported: false })
  })

  it('bounds single-text post policy while preserving structured policy results', async () => {
    const { ctx } = await setup()
    ctx.on('tools/post-execute', (exec, _result, next) => {
      if (exec.name !== 'job_kill') return next()
      const reason = (exec.arguments as { reason?: unknown }).reason
      if (reason === 'replace') {
        return Promise.resolve({ kind: 'accept', content: [{ type: 'text', text: 'r'.repeat(1_000) }] })
      }
      if (reason === 'block') {
        return Promise.resolve({ kind: 'block', feedback: [{ type: 'text', text: 'b'.repeat(1_000) }] })
      }
      if (reason === 'multi') {
        return Promise.resolve({
          kind: 'block',
          feedback: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }],
        })
      }
      if (reason === 'reasoning') {
        return Promise.resolve({ kind: 'block', feedback: [{ type: 'reasoning', text: 'policy detail' }] })
      }
      return next()
    })
    for (let index = 0; index < 4; index += 1) {
      ctx.jobs.start(producer({ outputLimitBytes: 64 }).spec)
    }

    const replaced = await call(ctx, 'job_kill', { job_id: 'bash-1', reason: 'replace' })
    expect(replaced.isError).toBe(false)
    expect(Buffer.byteLength(text(replaced))).toBeLessThanOrEqual(64)
    expect(text(replaced)).toContain('[result truncated]')

    const blocked = await call(ctx, 'job_kill', { job_id: 'bash-2', reason: 'block' })
    expect(blocked.isError).toBe(true)
    expect(Buffer.byteLength(text(blocked))).toBeLessThanOrEqual(64)
    expect(text(blocked)).toContain('[result truncated]')

    const multi = await call(ctx, 'job_kill', { job_id: 'bash-3', reason: 'multi' })
    expect(multi.content).toEqual([{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }])

    const reasoning = await call(ctx, 'job_kill', { job_id: 'bash-4', reason: 'reasoning' })
    expect(reasoning.content).toEqual([{ type: 'reasoning', text: 'policy detail' }])
  })

  it('reports an already-finished job without consuming its pending delta', async () => {
    const { ctx } = await setup()
    let delta = 'unread tail'
    const p = producer({ readOutput: () => { const d = delta; delta = ''; return d } })
    ctx.jobs.start(p.spec)
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    await tick()

    const killed = await call(ctx, 'job_kill', { job_id: 'bash-1' })
    if (killed.isError) throw new Error('expected job_kill success')
    expect(killed.value).toMatchObject({
      outcome: 'already-finished',
      job: { id: 'bash-1', kind: 'bash', label: 'sleep 60', status: 'completed', detail: 'exit code: 0' },
    })
    expect(text(killed)).toBe('job bash-1 had already finished [status: completed, exit code: 0]')
    // The kill described the job via a non-consuming snapshot: the delta is intact.
    expect(text(await call(ctx, 'job_output', { job_id: 'bash-1' }))).toBe('unread tail\n[status: completed, exit code: 0]')
  })

  it('rejects an empty job id as an errored result', async () => {
    const { ctx } = await setup()
    expect((await call(ctx, 'job_kill', { job_id: '' })).isError).toBe(true)
  })
})

describe('tool-owned UI presentation (presentCall)', () => {
  it('renders generic cards for all three control tools', async () => {
    const { ctx } = await setup()
    expect(ctx.tools.get('job_output')?.presentCall?.({ job_id: 'bash-1' }))
      .toEqual({ card: 'generic', title: 'Read output from background job bash-1', kind: 'read', rawInput: 'bash-1' })
    expect(ctx.tools.get('job_list')?.presentCall?.({}))
      .toEqual({ card: 'generic', title: 'List background jobs', kind: 'read' })
    expect(ctx.tools.get('job_kill')?.presentCall?.({ job_id: 'subagent-2' }))
      .toEqual({ card: 'generic', title: 'Kill background job subagent-2', kind: 'execute', rawInput: 'subagent-2' })
  })
})

describe('completion notices across scoped mounts', () => {
  /**
   * Two agent presets mounting `tool-jobs` over ONE host registry: each mount
   * registers its own `onJobDone` listener on the shared service, and
   * `settle()` broadcasts one snapshot to every listener with no scope filter.
   * Only the mount whose scope the owner belongs to may deliver the notice.
   */
  it('delivers one notice from the owning scope when two mounts share the registry', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)

    const standingA = createScope(ctx, {})
    const standingB = createScope(ctx, {})
    await standingA.ctx.plugin(ToolJobs)
    await standingB.ctx.plugin(ToolJobs)

    // The agent joins preset A exactly as `agentPresets.compose` binds it.
    const agentKey = {}
    const agentScope = createScope(ctx, agentKey)
    bindScopeParent(agentKey, scopeOf(standingA.ctx) as object)

    const inject = vi.fn()
    const owner = {
      id: SessionId('sess-scoped'),
      ctx: agentScope.ctx,
      inject,
      session: { id: SessionId('sess-scoped'), header: { version: 0, id: SessionId('sess-scoped'), createdAt: 0 } },
    } as unknown as Agent
    const dispose = await ctx.agents.register(owner)

    try {
      // No waiter: `settle()` leaves `reported` false, which is the only path
      // that reaches the notice listeners at all.
      const p = producer({ owner, label: 'pnpm test' })
      ctx.jobs.start(p.spec)
      p.settle({ status: 'completed', detail: 'exit code: 0' })
      await tick()

      expect(inject).toHaveBeenCalledTimes(1)
    } finally {
      await dispose()
    }
  })
})

describe('completion notice delivery', () => {
  it('opens a turn on an idle owner when a job settles', async () => {
    const { ctx } = await setup()
    const inject = vi.fn()
    const followup = vi.fn()
    const owner = await fakeAgent(ctx, 'sess-1', { inject, followup, status: 'idle' })
    const p = producer({ owner, label: 'pnpm test' })
    ctx.jobs.start(p.spec)

    p.settle({ status: 'completed', detail: 'exit code: 0' })
    await tick()
    expect(followup).toHaveBeenCalledTimes(1)
    expect(inject).not.toHaveBeenCalled()
  })

  it('never wakes an idle owner under quiet delivery', async () => {
    const { ctx } = await setup({ completionDelivery: 'quiet' })
    const inject = vi.fn()
    const followup = vi.fn()
    const owner = await fakeAgent(ctx, 'sess-1', { inject, followup, status: 'idle' })
    const p = producer({ owner })
    ctx.jobs.start(p.spec)

    p.settle({ status: 'completed' })
    await tick()
    expect(inject).toHaveBeenCalledTimes(1)
    expect(followup).not.toHaveBeenCalled()
  })

  it('degrades to injection once the consecutive wake budget is spent', async () => {
    const { ctx } = await setup({ maxConsecutiveWakes: 2 })
    const inject = vi.fn()
    const followup = vi.fn()
    const owner = await fakeAgent(ctx, 'sess-1', { inject, followup, status: 'idle' })

    await settleTasks(ctx, owner, 3)
    // A woken turn that starts another job is the self-exciting case: the
    // budget stops the chain, and the notice still reaches the inbox.
    expect(followup).toHaveBeenCalledTimes(2)
    expect(inject).toHaveBeenCalledTimes(1)
  })

  it('restores the wake budget when the owner claims a user message', async () => {
    const { ctx } = await setup({ maxConsecutiveWakes: 1 })
    const inject = vi.fn()
    const followup = vi.fn()
    const owner = await fakeAgent(ctx, 'sess-1', { inject, followup, status: 'idle' })

    await settleTasks(ctx, owner, 2)
    expect(followup).toHaveBeenCalledTimes(1)

    emitAgentEvent(ctx, owner, 'agent/inbox/claimed', {
      message: createUserMessage({ content: [{ type: 'text', text: 'carry on' }], source: { kind: 'user' } }),
      turn: 1,
    })
    await settleTasks(ctx, owner, 1)
    expect(followup).toHaveBeenCalledTimes(2)
  })

  it('neither wakes nor injects into an owner its own teardown is draining', async () => {
    const { ctx } = await setup()
    const inject = vi.fn()
    const followup = vi.fn()
    const owner = await fakeAgent(ctx, 'sess-1', { inject, followup, status: 'idle' })
    let settle!: (outcome: JobOutcome) => void
    ctx.jobs.start({
      kind: 'bash',
      label: 'sleep 60',
      owner,
      run: () => ({
        cancel() { settle({ status: 'killed' }) },
        done: new Promise<JobOutcome>((res) => { settle = res }),
      }),
    })

    // Disposal cancels and settles the owned job. Waking here would spend a
    // model request on an agent the host is destroying, once per tree layer.
    await disposeAgentScope(owner)
    await tick()
    expect(followup).not.toHaveBeenCalled()
    expect(inject).not.toHaveBeenCalled()
  })

  it('neither wakes nor injects when the teardown cancel itself threw', async () => {
    const { ctx } = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const inject = vi.fn()
    const followup = vi.fn()
    const owner = await fakeAgent(ctx, 'sess-1', { inject, followup, status: 'idle' })
    ctx.jobs.start({
      kind: 'bash',
      label: 'broken producer',
      owner,
      run: () => ({
        cancel() { throw new Error('cancel boom') },
        done: new Promise<JobOutcome>(() => {}),
      }),
    })

    // The registry force-fails the record instead of deadlocking. That path
    // settles the job too, so it must claim the report as the ordinary
    // teardown cancel does — otherwise a throwing producer is all it takes to
    // spend a model request on an owner being destroyed.
    await disposeAgentScope(owner)
    await tick()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('work may be orphaned'))
    expect(followup).not.toHaveBeenCalled()
    expect(inject).not.toHaveBeenCalled()
  })

  it('keeps the budget spent when the owner only claims plugin notices', async () => {
    const { ctx } = await setup({ maxConsecutiveWakes: 1 })
    const followup = vi.fn()
    const owner = await fakeAgent(ctx, 'sess-1', { followup, status: 'idle' })

    await settleTasks(ctx, owner, 1)
    emitAgentEvent(ctx, owner, 'agent/inbox/claimed', {
      message: createUserMessage({
        content: [{ type: 'text', text: 'background job bash-1 finished' }],
        source: { kind: 'plugin', plugin: 'tool-jobs', form: 'notice', summary: 'bash' },
      }),
      turn: 1,
    })
    await settleTasks(ctx, owner, 1)
    expect(followup).toHaveBeenCalledTimes(1)
  })
})

describe('completion notices', () => {
  it('injects a notice into the owning agent when an unreported job settles', async () => {
    const { ctx } = await setup()
    const inject = vi.fn()
    const owner = await fakeAgent(ctx, 'sess-1', { inject })
    const p = producer({ owner, label: 'pnpm test' })
    ctx.jobs.start(p.spec)

    p.settle({ status: 'completed', detail: 'exit code: 0' })
    await tick()
    expect(inject).toHaveBeenCalledTimes(1)
    expect(inject).toHaveBeenCalledWith({
      id: expect.any(String) as unknown,
      role: 'user',
      content: [{ type: 'text', text: 'background job bash-1 (bash: pnpm test) finished [status: completed, exit code: 0]. Read its output with job_output.' }],
      source: {
        kind: 'plugin',
        plugin: 'tool-jobs',
        form: 'notice',
        summary: 'bash pnpm test [status: completed, exit code: 0]',
      },
    })
  })

  it('preserves job ids and collection guidance in bounded completion notices', async () => {
    const { ctx } = await setup()
    const inject = vi.fn()
    const owner = await fakeAgent(ctx, 'sess-1', { inject })
    const first = producer({
      owner,
      kind: 'subagent',
      label: 'x'.repeat(1_000),
      outputLimitBytes: 61,
    })
    ctx.jobs.start(first.spec)
    first.settle({ status: 'completed', detail: 'd'.repeat(1_000) })
    await tick()

    expect(inject).toHaveBeenNthCalledWith(
      1,
      {
        id: expect.any(String) as unknown,
        role: 'user',
        content: [{ type: 'text', text: 'background job subagent-1\nDone; job_output.' }],
        // The label and status detail are unbounded caller text, so the durable
        // one-line account caps itself rather than committing their full length.
        source: {
          kind: 'plugin',
          plugin: 'tool-jobs',
          form: 'notice',
          summary: `subagent ${'x'.repeat(110)}…`,
        },
      },
    )

    const second = producer({
      owner,
      kind: 'subagent',
      label: 'x'.repeat(1_000),
      outputLimitBytes: 80,
    })
    ctx.jobs.start(second.spec)
    second.settle({ status: 'completed', detail: 'd'.repeat(1_000) })
    await tick()

    const content = (inject.mock.calls[1]?.[0] as { content?: Array<{ type: string; text?: string }> } | undefined)?.content
    const notice = content?.[0]?.text ?? ''
    expect(Buffer.byteLength(notice)).toBeLessThanOrEqual(80)
    expect(notice).toContain('background job subagent-2 (subagent: xxxx')
    expect(notice).toContain('[notice truncated]\nDone; job_output.')
  })

  it('keeps the complete PTY job id and collection action at the minimum PTY limit', async () => {
    const { ctx } = await setup()
    for (let index = 0; index < 99; index += 1) {
      const prior = producer({ kind: 'pty-send' })
      ctx.jobs.start(prior.spec)
      prior.settle({ status: 'completed' })
      await tick()
    }
    const inject = vi.fn()
    const owner = await fakeAgent(ctx, 'sess-1', { inject })
    const target = producer({
      owner,
      kind: 'pty-send',
      label: 'x'.repeat(1_000),
      outputLimitBytes: 64,
    })
    ctx.jobs.start(target.spec)

    target.settle({ status: 'completed', detail: 'd'.repeat(1_000) })
    await tick()

    const content = (inject.mock.calls[0]?.[0] as { content?: Array<{ type: string; text?: string }> } | undefined)?.content
    const notice = content?.[0]?.text ?? ''
    expect(Buffer.byteLength(notice)).toBeLessThanOrEqual(64)
    expect(notice).toBe('background job pty-send-100\n[notice truncated]\nDone; job_output.')
  })

  it('reserves the collection-action tail when a producer supplies a smaller budget', async () => {
    const { ctx } = await setup()
    const inject = vi.fn()
    const owner = await fakeAgent(ctx, 'sess-1', { inject })
    const tiny = producer({ owner, kind: 'pty-send', label: 'x'.repeat(100), outputLimitBytes: 8 })
    const short = producer({ owner, kind: 'pty-send', label: 'x'.repeat(100), outputLimitBytes: 32 })
    ctx.jobs.start(tiny.spec)
    ctx.jobs.start(short.spec)

    tiny.settle({ status: 'completed' })
    short.settle({ status: 'completed' })
    await tick()

    const tinyNotice = (inject.mock.calls[0]?.[0] as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text ?? ''
    const shortNotice = (inject.mock.calls[1]?.[0] as { content?: Array<{ text?: string }> } | undefined)?.content?.[0]?.text ?? ''
    expect(Buffer.byteLength(tinyNotice)).toBeLessThanOrEqual(8)
    expect(tinyNotice).toBe('_output.')
    expect(Buffer.byteLength(shortNotice)).toBeLessThanOrEqual(32)
    expect(shortNotice).toBe('background job\nDone; job_output.')
  })

  it('suppresses the notice for a job the model already killed', async () => {
    const { ctx } = await setup()
    const inject = vi.fn()
    const owner = await fakeAgent(ctx, 'sess-1', { inject })
    const p = producer({ owner })
    ctx.jobs.start(p.spec)

    await call(ctx, 'job_kill', { job_id: 'bash-1' }, owner)
    p.settle({ status: 'killed' })
    await tick()
    expect(inject).not.toHaveBeenCalled()
  })

  it('suppresses the notice when a wait returned the terminal state', async () => {
    const { ctx } = await setup()
    const inject = vi.fn()
    const owner = await fakeAgent(ctx, 'sess-1', { inject })
    const p = producer({ owner, kind: 'subagent' })
    ctx.jobs.start(p.spec)

    const pending = call(ctx, 'job_output', { job_id: 'subagent-1', wait: true }, owner)
    p.settle({ status: 'completed', output: 'answer' })
    expect(text(await pending)).toContain('answer')
    expect(inject).not.toHaveBeenCalled()
  })

  it('drops the notice for unowned jobs without throwing', async () => {
    const { ctx } = await setup()
    // Unowned: settles with nobody to notify — nothing throws.
    const unowned = producer()
    ctx.jobs.start(unowned.spec)
    unowned.settle({ status: 'completed' })
    await tick()
  })

  it('does not route an old owner completion notice to a same-session replacement', async () => {
    const { ctx } = await setup()
    // Delivery into a tearing-down owner is a plain inject: the loop has no
    // terminal state, so the notice lands in the old owner's (detached)
    // session instead of throwing or re-routing.
    const oldInject = vi.fn()
    const oldOwner = await fakeAgent(ctx, 'shared', { inject: oldInject })
    const p = producer({ owner: oldOwner })
    ctx.jobs.start(p.spec)

    await detachAgent(oldOwner)
    const replacementInject = vi.fn()
    await fakeAgent(ctx, 'shared', { inject: replacementInject })
    p.settle({ status: 'completed' })
    await tick()

    expect(oldInject).toHaveBeenCalledTimes(1)
    expect(replacementInject).not.toHaveBeenCalled()
  })

  it('surfaces an inject failure through listener containment (a real bug must be visible)', async () => {
    const { ctx } = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const owner = await fakeAgent(ctx, 'sess-1', { inject: () => { throw new Error('unexpected inject bug') } })
    const p = producer({ owner })
    ctx.jobs.start(p.spec)
    p.settle({ status: 'completed' })
    await tick()
    // The throw escapes the notice listener and is contained (logged) by the
    // registry's per-listener containment — visible, not swallowed.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unexpected inject bug'))
  })

  it('keeps using the exact owner after the agent registry is gone', async () => {
    const { ctx, agentsFiber } = await setup()
    const inject = vi.fn()
    const owner = await fakeAgent(ctx, 'sess-1', { inject })

    // Settlement must not depend on a later registry lookup: the exact owner
    // supplied at start remains the destination while its own scope is live.
    const p1 = producer({ owner })
    ctx.jobs.start(p1.spec)
    const p2 = producer({ owner })
    ctx.jobs.start(p2.spec)

    await agentsFiber.dispose()
    p1.settle({ status: 'completed' })
    p2.settle({ status: 'failed' })
    await tick()
    expect(inject).toHaveBeenCalledTimes(2)
  })
})
