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
import type { JobAppendOptions, JobHandle, JobHooks, JobOutcome, JobOutputSource, JobSpec, JobView } from '@deepseek-ai/dsh-jobs'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import { publicJob, renderModelDelta, statusLine } from '../src/render.ts'

const testToolSignal = new AbortController().signal

const agentRegistryDisposers = new WeakMap<Agent, () => Promise<void>>()
const agentScopeFibers = new WeakMap<Agent, { dispose: () => Promise<void> }>()

/** Registry knobs a test may narrow; every producer here pushes, so the pump stays idle. */
interface RegistryConfig {
  retainBytes?: number
}

async function setup(config: ToolJobs.Config = {}, registry: RegistryConfig = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const agentsFiber = await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry, registry)
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

/**
 * A controllable producer spec: pushes output and progress through the handle
 * the registry hands its starter, settles `done` on demand, records cancels.
 */
function producer(overrides: Partial<Omit<JobSpec, 'run' | 'output'> & JobHooks> = {}) {
  let settle!: (outcome: JobOutcome) => void
  let handle: JobHandle | undefined
  const cancels: (string | undefined)[] = []
  const { kind = 'bash', label = 'sleep 60', owner, outputLimitBytes, ...hookOverrides } = overrides
  const hooks: JobHooks = {
    cancel(reason) { cancels.push(reason) },
    done: new Promise<JobOutcome>((res) => { settle = res }),
    ...hookOverrides,
  }
  const spec: JobSpec = {
    kind,
    label,
    ...owner !== undefined ? { owner } : {},
    ...outputLimitBytes !== undefined ? { outputLimitBytes } : {},
    run: (job) => { handle = job; return hooks },
  }
  const started = (): JobHandle => {
    if (handle === undefined) throw new Error('producer not started')
    return handle
  }
  return {
    spec,
    settle,
    cancels,
    append: (text: string, options?: JobAppendOptions) => { started().append(text, options) },
    progress: (line: string) => { started().updateProgress(line) },
  }
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
    const p = producer({ owner: owner.id })
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

  it('serves unowned jobs in a composition without an agent registry', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(ToolJobs)
    const p = producer()
    ctx.jobs.start(p.spec)
    p.append('open\n')
    expect(text(await call(ctx, 'job_output', { job_id: 'bash-1' }))).toBe('open\n[status: running]')
    p.settle({ status: 'completed' })
    await tick()
    expect(text(await call(ctx, 'job_list', {}))).toBe('bash-1 [bash] completed — sleep 60')
  })

  it('rejects a config whose default wait exceeds the cap', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    await expect(ctx.plugin(ToolJobs, { waitTimeoutMs: 100, maxWaitTimeoutMs: 50 }))
      .rejects.toThrow('waitTimeoutMs (100) exceeds maxWaitTimeoutMs (50)')
  })

  it('defaults delivery to unbounded wakeup and rejects an unknown lane', () => {
    expect(ToolJobs.Config({}).completionDelivery).toBe('wakeup')
    expect(ToolJobs.Config({}).maxConsecutiveWakes).toBeUndefined()
    expect(() => ToolJobs.Config({ completionDelivery: 'loud' as never })).toThrow()
    expect(() => ToolJobs.Config({ maxConsecutiveWakes: 0 })).toThrow()
  })

  it('rejects a wake budget that cannot bound anything', async () => {
    // Reports the load outcome as text: a resolved fiber is not safely printable.
    const loadWith = async (maxConsecutiveWakes: number): Promise<string> => {
      const ctx = new Context()
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(LocalJobRegistry)
      try {
        await ctx.plugin(ToolJobs, { maxConsecutiveWakes })
        return 'loaded'
      } catch (error: unknown) {
        return String(error)
      }
    }

    // The field exists to bound runaway waking; a fractional budget counts
    // nothing and an infinite one is spelled by omitting the field.
    expect(await loadWith(Number.POSITIVE_INFINITY)).toContain('maxConsecutiveWakes')
    expect(await loadWith(2.5)).toContain('maxConsecutiveWakes')
    expect(await loadWith(1)).toBe('loaded')
  })

  it('renders status lines with and without producer detail', () => {
    expect(statusLine({ status: 'running' })).toBe('[status: running]')
    expect(statusLine({ status: 'completed', detail: 'exit code: 0' })).toBe('[status: completed, exit code: 0]')
  })

  it('projects the public job: live progress or terminal detail, never ownership or offsets', () => {
    const live: JobView = {
      id: JobId('bash-1'), kind: 'bash', label: 'x', owner: SessionId('sess-1'), outputLimitBytes: 8,
      status: 'running', progress: '3/10 files', startedAt: 5, output: { total: 12, earliest: 0 },
    }
    expect(publicJob(live)).toEqual({ id: 'bash-1', kind: 'bash', label: 'x', status: 'running', detail: '3/10 files', startedAt: 5 })
    const settled: JobView = {
      id: JobId('bash-1'), kind: 'bash', label: 'x', status: 'completed', detail: 'exit code: 0',
      startedAt: 5, finishedAt: 9, output: { total: 12, earliest: 0 },
    }
    expect(publicJob(settled)).toEqual({ id: 'bash-1', kind: 'bash', label: 'x', status: 'completed', detail: 'exit code: 0', startedAt: 5, finishedAt: 9 })
  })

  it('renders a model delta as stdout, one stderr section, and a dropped-output notice', () => {
    expect(renderModelDelta([], false, [])).toBe('')
    expect(renderModelDelta([], true, [])).toBe('[some output was dropped from memory; full output: (unavailable)]')
    expect(renderModelDelta([
      { at: 0, text: 'a' },
      { at: 1, text: 'e1\n', channel: 'stderr' },
      { at: 4, text: 'narration', channel: 'log' },
      { at: 13, text: 'b', channel: 'stdout' },
      { at: 14, text: 'e2', channel: 'stderr' },
    ], false, [])).toBe('ab\n[stderr]\ne1\ne2')
    expect(renderModelDelta([{ at: 0, text: 'tail' }], true, [])).toBe('tail\n[some output was dropped from memory; full output: (unavailable)]')
    expect(renderModelDelta([{ at: 0, text: 'line\n' }], true, [])).toBe('line\n[some output was dropped from memory; full output: (unavailable)]')
    // Ring eviction names the files the job's sources keep, whether or not a retained chunk carries a gap.
    expect(renderModelDelta([{ at: 8, text: 'tail' }], true, ['/spill/out.log', '/spill/err.log']))
      .toBe('tail\n[some output was dropped from memory; full output: /spill/out.log, /spill/err.log]')
  })

  it('reports a producer-side gap as dropped output and names the spill files the job advertises', () => {
    // The ring itself lost nothing (`lossy: false`); the source did, between two pumps.
    expect(renderModelDelta([{ at: 0, text: 'head' }, { at: 4, text: 'tail', gapBefore: true }], false, ['/spill/out.log']))
      .toBe('headtail\n[some output was dropped from memory; full output: /spill/out.log]')
    expect(renderModelDelta([
      { at: 0, text: 'o', gapBefore: true },
      { at: 1, text: 'e', channel: 'stderr', gapBefore: true },
    ], false, ['/spill/out.log', '/spill/err.log'])).toBe('o\n[stderr]\ne\n[some output was dropped from memory; full output: /spill/out.log, /spill/err.log]')
    // A gap while no source keeps a file yields the generic notice.
    expect(renderModelDelta([{ at: 0, text: 'tail', gapBefore: true }], false, []))
      .toBe('tail\n[some output was dropped from memory; full output: (unavailable)]')
    // A gap on observer-only narration never reaches the model.
    expect(renderModelDelta([{ at: 0, text: 'phase', channel: 'log', gapBefore: true }], false, ['/spill/log'])).toBe('')
  })

  it('names the spill file when the ring evicted output the model never read', async () => {
    const { ctx } = await setup({}, { retainBytes: 8 })
    const owner = await fakeAgent(ctx, 'sess-1')
    let settle!: (outcome: JobOutcome) => void
    // The source never reads lossy: the pump keeps up, and only the ring's live cap drops bytes.
    const source: JobOutputSource = {
      channel: 'stdout',
      read: from => from === 0
        ? { text: 'x'.repeat(32), nextOffset: 32, lossy: false, spillPath: '/spill/out.log' }
        : { text: '', nextOffset: from, lossy: false, spillPath: '/spill/out.log' },
    }
    ctx.jobs.start({
      kind: 'bash',
      label: 'noisy',
      owner: owner.id,
      output: [source],
      run: () => ({ cancel() {}, done: new Promise<JobOutcome>((resolve) => { settle = resolve }) }),
    })

    expect(text(await call(ctx, 'job_output', { job_id: 'bash-1' }, owner)))
      .toBe(`${'x'.repeat(8)}\n[some output was dropped from memory; full output: /spill/out.log]\n[status: running]`)
    settle({ status: 'completed' })
    await tick()
  })

  it('applies the built-in wait bounds when apply() receives a bare config', async () => {
    // Bypasses the schemastery defaults on purpose: apply() must stand on its
    // own `??` fallbacks when embedded programmatically without the schema.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    ToolJobs.apply(ctx, {})
    expect(ctx.tools.get('job_output')).toBeDefined()
    expect(() => ctx.jobs.start(producer().spec)).not.toThrow()
  })
})

describe('job_output', () => {
  it('reads a consuming delta with a trailing status line', async () => {
    const { ctx } = await setup()
    const p = producer()
    ctx.jobs.start(p.spec)
    p.append('line one\n')

    // A body already ending in a newline gets no doubled separator.
    const first = await call(ctx, 'job_output', { job_id: 'bash-1' })
    if (first.isError) throw new Error('expected job_output success')
    const firstValue = first.value as { text: string; job: Record<string, unknown> }
    expect(firstValue).toMatchObject({
      text: 'line one\n',
      job: { id: 'bash-1', kind: 'bash', label: 'sleep 60', status: 'running' },
    })
    expect(firstValue.job).not.toHaveProperty('owner')
    expect(firstValue.job).not.toHaveProperty('output')
    expect(text(first)).toBe('line one\n[status: running]')
    expect(text(await call(ctx, 'job_output', { job_id: 'bash-1' }))).toBe('(no new output)\n[status: running]')
  })

  it('renders stderr in a trailing section and never shows log narration', async () => {
    const { ctx } = await setup()
    const p = producer()
    ctx.jobs.start(p.spec)
    p.append('out\n')
    p.append('warn\n', { channel: 'stderr' })
    p.append('observer-only narration', { channel: 'log' })
    expect(text(await call(ctx, 'job_output', { job_id: 'bash-1' }))).toBe('out\n[stderr]\nwarn\n[status: running]')
    expect(text(await call(ctx, 'job_output', { job_id: 'bash-1' }))).toBe('(no new output)\n[status: running]')
  })

  it('shows live progress beside the status until settlement replaces it with the terminal detail', async () => {
    const { ctx } = await setup()
    const p = producer()
    ctx.jobs.start(p.spec)
    p.progress('3/10 files')
    expect(text(await call(ctx, 'job_output', { job_id: 'bash-1' }))).toBe('(no new output)\n[status: running, 3/10 files]')
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    await tick()
    expect(text(await call(ctx, 'job_output', { job_id: 'bash-1' }))).toBe('(no new output)\n[status: completed, exit code: 0]')
  })

  it('flags a read whose cursor fell behind the ring', async () => {
    const { ctx } = await setup({}, { retainBytes: 16 })
    const p = producer()
    ctx.jobs.start(p.spec)
    p.append('x'.repeat(40))
    const first = text(await call(ctx, 'job_output', { job_id: 'bash-1' }))
    expect(first).toContain('[some output was dropped from memory; full output: (unavailable)]')
    expect(first).toContain('[status: running]')
    expect(first).not.toContain('x'.repeat(17))
    // The cursor now sits at the ring's end: the next read is clean.
    expect(text(await call(ctx, 'job_output', { job_id: 'bash-1' }))).toBe('(no new output)\n[status: running]')
  })

  it('returns the result of a settled job exactly once, after the pending delta', async () => {
    const { ctx } = await setup()
    const p = producer({ kind: 'subagent', label: 'research' })
    ctx.jobs.start(p.spec)
    expect(text(await call(ctx, 'job_output', { job_id: 'subagent-1' }))).toBe('(no new output)\n[status: running]')

    p.append('partial')
    p.settle({ status: 'completed', detail: 'completed', result: 'the answer' })
    await tick()
    expect(text(await call(ctx, 'job_output', { job_id: 'subagent-1' }))).toBe('partial\nthe answer\n[status: completed, completed]')
    expect(text(await call(ctx, 'job_output', { job_id: 'subagent-1' }))).toBe('(no new output)\n[status: completed, completed]')
  })

  it('keeps a newline-terminated delta and the result on separate lines', async () => {
    const { ctx } = await setup()
    const p = producer({ kind: 'subagent', label: 'research' })
    ctx.jobs.start(p.spec)
    p.append('progress log\n')
    p.settle({ status: 'completed', result: 'the answer' })
    await tick()
    expect(text(await call(ctx, 'job_output', { job_id: 'subagent-1' }))).toBe('progress log\nthe answer\n[status: completed]')
  })

  it('applies a producer limit to the complete body and status result', async () => {
    const { ctx } = await setup()
    const p = producer({ outputLimitBytes: 48 })
    ctx.jobs.start(p.spec)
    p.append('界'.repeat(100))

    const output = text(await call(ctx, 'job_output', { job_id: 'bash-1' }))
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(48)
    expect(output).toContain('[status: running]')
  })

  it('preserves empty and newline-terminated output under a producer limit', async () => {
    const { ctx } = await setup()
    const p = producer({ outputLimitBytes: 64 })
    ctx.jobs.start(p.spec)

    expect(text(await call(ctx, 'job_output', { job_id: 'bash-1' })))
      .toBe('(no new output)\n[status: running]')
    p.append('line\n')
    expect(text(await call(ctx, 'job_output', { job_id: 'bash-1' })))
      .toBe('line\n[status: running]')
  })

  it('bounds post-policy output without restoring the canonical status rendering', async () => {
    const { ctx } = await setup()
    const p = producer({ outputLimitBytes: 64 })
    ctx.jobs.start(p.spec)
    p.append('canonical output')
    ctx.on('tools/post-execute', (exec, _result, next) => {
      if (exec.name !== 'job_output') return next()
      return Promise.resolve({ kind: 'accept', content: [{ type: 'text', text: 'p'.repeat(1_000) }] })
    })

    const result = await call(ctx, 'job_output', { job_id: 'bash-1' })
    expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(64)
    expect(text(result)).toContain('[result truncated]')
    expect(text(result)).not.toContain('[status: running]')
  })

  it('does not double a truncation marker a policy already appended', async () => {
    const { ctx } = await setup()
    ctx.jobs.start(producer({ outputLimitBytes: 64 }).spec)
    ctx.on('tools/post-execute', (exec, _result, next) => {
      if (exec.name !== 'job_output') return next()
      return Promise.resolve({ kind: 'accept', content: [{ type: 'text', text: `${'z'.repeat(1_000)}\n[result truncated]` }] })
    })

    const result = await call(ctx, 'job_output', { job_id: 'bash-1' })
    expect(Buffer.byteLength(text(result))).toBeLessThanOrEqual(64)
    expect(text(result).match(/\[result truncated\]/g)).toHaveLength(1)
  })

  it('refuses a job owned by another session as an errored result', async () => {
    const { ctx } = await setup()
    const alice = await fakeAgent(ctx, 'sess-alice')
    ctx.jobs.start(producer({ owner: alice.id }).spec)
    const bob = await fakeAgent(ctx, 'sess-bob')

    const result = await call(ctx, 'job_output', { job_id: 'bash-1' }, bob)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('belongs to another session')
    expect((await call(ctx, 'job_output', { job_id: 'bash-1' })).isError).toBe(true)
    expect((await call(ctx, 'job_output', { job_id: 'bash-1' }, alice)).isError).toBe(false)
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
    p.settle({ status: 'completed', result: 'done deal' })
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
    ctx.jobs.start(producer({ owner: alice.id, label: 'pnpm test' }).spec)
    ctx.jobs.start(producer({ kind: 'subagent', label: 'open research' }).spec)
    const p = producer({ owner: alice.id, label: 'build' })
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
      expect(job).not.toHaveProperty('owner')
      expect(job).not.toHaveProperty('output')
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
    expect(killValue.job).not.toHaveProperty('owner')
    expect(killValue.job).not.toHaveProperty('output')
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
    expect(ctx.jobs.get(JobId('bash-1')).status).toBe('running')
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
    const p = producer()
    ctx.jobs.start(p.spec)
    p.append('unread tail')
    p.settle({ status: 'completed', detail: 'exit code: 0' })
    await tick()

    const killed = await call(ctx, 'job_kill', { job_id: 'bash-1' })
    if (killed.isError) throw new Error('expected job_kill success')
    expect(killed.value).toMatchObject({
      outcome: 'already-finished',
      job: { id: 'bash-1', kind: 'bash', label: 'sleep 60', status: 'completed', detail: 'exit code: 0' },
    })
    expect(text(killed)).toBe('job bash-1 had already finished [status: completed, exit code: 0]')
    // The kill described the job via a non-consuming projection: the delta is intact.
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
   * subscribes with `{ owners: 'scope' }`, which the registry files into the
   * mount's own scope layer and reaches along the owner's scope chain. Only
   * the mount whose scope the owner belongs to sees the settlement.
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
      const p = producer({ owner: owner.id, label: 'pnpm test' })
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
    const p = producer({ owner: owner.id, label: 'pnpm test' })
    ctx.jobs.start(p.spec)

    p.settle({ status: 'completed', detail: 'exit code: 0' })
    await tick()
    expect(followup).toHaveBeenCalledTimes(1)
    expect(inject).not.toHaveBeenCalled()
  })

  it('delivers the completion notice for a human kill, reason included', async () => {
    const { ctx } = await setup()
    const inject = vi.fn()
    const owner = await fakeAgent(ctx, 'sess-1', { inject })
    const p = producer({ owner: owner.id, label: 'pnpm run watch' })
    const id = ctx.jobs.start(p.spec)

    // A kill outside the model's own job_kill (the web client's stop button)
    // claims nothing in the ledger, so the notice stays due.
    ctx.jobs.kill(id, owner.id, 'cancelled by the user')
    p.settle({ status: 'killed', detail: 'signal: SIGTERM' })
    await tick()
    expect(inject).toHaveBeenCalledTimes(1)
    const message = inject.mock.calls[0]![0] as { content: readonly { type: string; text: string }[] }
    expect(message.content[0]!.text).toBe(
      'background job bash-1 (bash: pnpm run watch) finished '
      + '[status: killed, signal: SIGTERM; cancelled by the user]. Read its output with job_output.',
    )
  })

  it('never wakes an idle owner under quiet delivery', async () => {
    const { ctx } = await setup({ completionDelivery: 'quiet' })
    const inject = vi.fn()
    const followup = vi.fn()
    const owner = await fakeAgent(ctx, 'sess-1', { inject, followup, status: 'idle' })
    const p = producer({ owner: owner.id })
    ctx.jobs.start(p.spec)

    p.settle({ status: 'completed' })
    await tick()
    expect(inject).toHaveBeenCalledTimes(1)
    expect(followup).not.toHaveBeenCalled()
  })

  it('wakes an idle owner for every completion when no wake budget is set', async () => {
    const { ctx } = await setup()
    const inject = vi.fn()
    const followup = vi.fn()
    const owner = await fakeAgent(ctx, 'sess-1', { inject, followup, status: 'idle' })

    // Four unattended completions in a row must each open a turn; no
    // user input arrives in between to refill anything.
    await settleTasks(ctx, owner, 4)
    expect(followup).toHaveBeenCalledTimes(4)
    expect(inject).not.toHaveBeenCalled()
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
      owner: owner.id,
      run: () => ({
        cancel() { settle({ status: 'killed' }) },
        done: new Promise<JobOutcome>((res) => { settle = res }),
      }),
    })

    // Disposal cancels and settles the owned job with a teardown cause. Waking
    // here would spend a model request on an agent the host is destroying.
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
      owner: owner.id,
      run: () => ({
        cancel() { throw new Error('cancel boom') },
        done: new Promise<JobOutcome>(() => {}),
      }),
    })

    // The registry force-fails the record instead of deadlocking. That
    // settlement also announces a teardown cause, so a throwing producer is
    // not enough to spend a model request on an owner being destroyed.
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
        source: { kind: 'tool-jobs', form: 'notice', summary: 'bash' },
      }),
      turn: 1,
    })
    await settleTasks(ctx, owner, 1)
    expect(followup).toHaveBeenCalledTimes(1)
  })
})

describe('completion notices', () => {
  it('injects a notice into the owning agent when an uncollected job settles', async () => {
    const { ctx } = await setup()
    const inject = vi.fn()
    const owner = await fakeAgent(ctx, 'sess-1', { inject })
    const p = producer({ owner: owner.id, label: 'pnpm test' })
    ctx.jobs.start(p.spec)

    p.settle({ status: 'completed', detail: 'exit code: 0' })
    await tick()
    expect(inject).toHaveBeenCalledTimes(1)
    expect(inject).toHaveBeenCalledWith({
      id: expect.any(String) as unknown,
      role: 'user',
      content: [{ type: 'text', text: 'background job bash-1 (bash: pnpm test) finished [status: completed, exit code: 0]. Read its output with job_output.' }],
      source: {
        kind: 'tool-jobs',
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
      owner: owner.id,
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
          kind: 'tool-jobs',
          form: 'notice',
          summary: `subagent ${'x'.repeat(110)}…`,
        },
      },
    )

    const second = producer({
      owner: owner.id,
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
      owner: owner.id,
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
    const tiny = producer({ owner: owner.id, kind: 'pty-send', label: 'x'.repeat(100), outputLimitBytes: 8 })
    const short = producer({ owner: owner.id, kind: 'pty-send', label: 'x'.repeat(100), outputLimitBytes: 32 })
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
    const p = producer({ owner: owner.id })
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
    const p = producer({ owner: owner.id, kind: 'subagent' })
    ctx.jobs.start(p.spec)

    const pending = call(ctx, 'job_output', { job_id: 'subagent-1', wait: true }, owner)
    p.settle({ status: 'completed', result: 'answer' })
    expect(text(await pending)).toContain('answer')
    await tick()
    expect(inject).not.toHaveBeenCalled()
  })

  it('a timed-out wait withdraws only its own claim; a concurrent wait keeps the settlement covered', async () => {
    const { ctx } = await setup({ waitTimeoutMs: 10, maxWaitTimeoutMs: 1000 })
    const inject = vi.fn()
    const owner = await fakeAgent(ctx, 'sess-1', { inject })
    const p = producer({ owner: owner.id })
    ctx.jobs.start(p.spec)

    const patient = call(ctx, 'job_output', { job_id: 'bash-1', wait: true, timeout_ms: 1000 }, owner)
    expect(text(await call(ctx, 'job_output', { job_id: 'bash-1', wait: true, timeout_ms: 10 }, owner))).toBe('(no new output)\n[status: running]')
    p.settle({ status: 'completed' })
    expect(text(await patient)).toBe('(no new output)\n[status: completed]')
    await tick()
    expect(inject).not.toHaveBeenCalled()
  })

  it('withdraws the wait claim when the wait times out, so the later settlement still notifies', async () => {
    const { ctx } = await setup({ waitTimeoutMs: 10, maxWaitTimeoutMs: 20 })
    const inject = vi.fn()
    const owner = await fakeAgent(ctx, 'sess-1', { inject })
    const p = producer({ owner: owner.id })
    ctx.jobs.start(p.spec)

    expect(text(await call(ctx, 'job_output', { job_id: 'bash-1', wait: true }, owner))).toBe('(no new output)\n[status: running]')
    p.settle({ status: 'completed' })
    await tick()
    expect(inject).toHaveBeenCalledTimes(1)
  })

  it('withdraws the wait claim when the caller aborts the wait', async () => {
    const { ctx } = await setup()
    const inject = vi.fn()
    const owner = await fakeAgent(ctx, 'sess-1', { inject })
    const p = producer({ owner: owner.id })
    ctx.jobs.start(p.spec)

    const aborter = new AbortController()
    const pending = ctx.tools.execute({
      signal: aborter.signal,
      callId: ToolCallId('call-aborted-wait'),
      name: 'job_output',
      arguments: { job_id: 'bash-1', wait: true },
      agent: owner,
    })
    await tick()
    aborter.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('wait aborted')

    p.settle({ status: 'completed' })
    await tick()
    expect(inject).toHaveBeenCalledTimes(1)
  })

  it('delivers the notice when the wait aborts and the job settles before the rejection lands', async () => {
    const { ctx } = await setup()
    const inject = vi.fn()
    const owner = await fakeAgent(ctx, 'sess-1', { inject })
    const p = producer({ owner: owner.id, kind: 'subagent' })
    ctx.jobs.start(p.spec)

    const aborter = new AbortController()
    const pending = ctx.tools.execute({
      signal: aborter.signal,
      callId: ToolCallId('call-abort-then-settle'),
      name: 'job_output',
      arguments: { job_id: 'subagent-1', wait: true },
      agent: owner,
    })
    await tick()
    // One synchronous span: the registry rejects the aborted wait on a later
    // microtask, and a push producer's settlement lands before that rejection
    // reaches the tool. The tool result carries the abort, not the outcome, so
    // the settlement notice is the model's only completion record.
    aborter.abort()
    p.settle({ status: 'completed', result: 'answer' })
    const result = await pending
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('wait aborted')
    await tick()
    expect(inject).toHaveBeenCalledTimes(1)
  })

  it('keeps a claim on one job while another job settles', async () => {
    const { ctx } = await setup()
    const inject = vi.fn()
    const owner = await fakeAgent(ctx, 'sess-1', { inject })
    const killed = producer({ owner: owner.id })
    const other = producer({ owner: owner.id })
    ctx.jobs.start(killed.spec)
    ctx.jobs.start(other.spec)

    await call(ctx, 'job_kill', { job_id: 'bash-1' }, owner)
    other.settle({ status: 'completed' })
    await tick()
    expect(inject).toHaveBeenCalledTimes(1)
    killed.settle({ status: 'killed' })
    await tick()
    expect(inject).toHaveBeenCalledTimes(1)
  })

  it('drops the notice for unowned jobs without throwing', async () => {
    const { ctx } = await setup()
    // Unowned: settles with nobody to notify — nothing throws.
    const unowned = producer()
    ctx.jobs.start(unowned.spec)
    unowned.settle({ status: 'completed' })
    await tick()
  })

  it('delivers to the agent currently registered for the owner session', async () => {
    const { ctx } = await setup()
    // The settlement names the owner session; the notice goes to whichever
    // agent holds that session when the job settles, which can read the job
    // through the same session id.
    const oldInject = vi.fn()
    const oldOwner = await fakeAgent(ctx, 'shared', { inject: oldInject })
    const p = producer({ owner: oldOwner.id })
    ctx.jobs.start(p.spec)

    await detachAgent(oldOwner)
    const replacementInject = vi.fn()
    const replacement = await fakeAgent(ctx, 'shared', { inject: replacementInject })
    p.settle({ status: 'completed' })
    await tick()

    expect(oldInject).not.toHaveBeenCalled()
    expect(replacementInject).toHaveBeenCalledTimes(1)
    expect(text(await call(ctx, 'job_output', { job_id: 'bash-1' }, replacement))).toBe('(no new output)\n[status: completed]')
  })

  it('drops the notice when the agent registry left before settlement', async () => {
    const { ctx, agentsFiber } = await setup()
    const inject = vi.fn()
    const owner = await fakeAgent(ctx, 'sess-1', { inject })
    const p = producer({ owner: owner.id })
    ctx.jobs.start(p.spec)

    await agentsFiber.dispose()
    p.settle({ status: 'completed' })
    await tick()
    expect(inject).not.toHaveBeenCalled()
  })

  it('drops the notice when the owner session has no live agent at settlement', async () => {
    const { ctx } = await setup()
    const inject = vi.fn()
    const owner = await fakeAgent(ctx, 'sess-1', { inject })
    const p = producer({ owner: owner.id })
    ctx.jobs.start(p.spec)

    await detachAgent(owner)
    p.settle({ status: 'completed' })
    await tick()
    expect(inject).not.toHaveBeenCalled()
  })

  it('surfaces an inject failure through listener containment (a real bug must be visible)', async () => {
    const { ctx } = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const owner = await fakeAgent(ctx, 'sess-1', { inject: () => { throw new Error('unexpected inject bug') } })
    const p = producer({ owner: owner.id })
    ctx.jobs.start(p.spec)
    p.settle({ status: 'completed' })
    await tick()
    // The throw escapes the notice listener and is contained (logged) by the
    // registry's per-listener containment — visible, not swallowed.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unexpected inject bug'))
  })
})
