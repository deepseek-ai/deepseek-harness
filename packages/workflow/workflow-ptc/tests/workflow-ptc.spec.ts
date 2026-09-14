import { describe, expect, it, vi } from 'vitest'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import type { SubagentCapabilities, SubagentProvider, SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { WorkflowMeta, WorkflowResult, WorkflowResultInfo, WorkflowRun, WorkflowRunInfo } from '@deepseek-ai/dsh-workflow'
import * as ptcEngineModule from '../src/index.ts'
import PtcWorkflowEngine, { type Config } from '../src/index.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

import { fakeParent, mountPtcRuntime } from './setup.ts'

/** Bound observations of process startup and host callbacks on shared CI runners. */
function waitFor(assertion: () => void, timeout = 60_000): Promise<void> {
  return vi.waitFor(assertion, { timeout, interval: 50 })
}

/** One controllable child run: the test (or auto mode) settles it. */
interface ControlledRun {
  request: SubagentStartRequest
  /** Fulfill the provider's async start with a published child. */
  publish(): void
  /** Reject the provider's async start before ownership transfer. */
  rejectStart(error: unknown): void
  settle(result: SubagentResult): void
  rejectResult(error: unknown): void
  cancelled: string | undefined
  disposed: boolean
  disposeCalls: number
}

/**
 * A scripted in-test provider over the REAL SubagentRuntime registry: `auto`
 * settles each run via the reply function on a microtask; `manual` piles runs
 * up in `runs` for the test to settle. A run aborts (settles `aborted`) when
 * the request signal fires, like the real in-process backends.
 */
class StubProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = {
    agentOptions: true,
    outputSchema: true,
    depthLimit: true,
    toolFilter: true,
    persona: false,
  }
  readonly inheritsParentContext = false
  readonly runs: ControlledRun[] = []

  constructor(
    readonly name: string,
    private readonly reply?: (request: SubagentStartRequest, index: number) => SubagentResult,
    private readonly disposeDelayMs = 0,
    private readonly deferStart = false,
    private readonly onAbortString?: (reason: string | undefined, index: number) => void,
    private readonly onSignalAbort?: (reason: unknown, index: number) => void,
  ) {}

  async start(request: SubagentStartRequest): Promise<SubagentRun> {
    const startGate = Promise.withResolvers<undefined>()
    const terminal = Promise.withResolvers<SubagentResult>()
    terminal.promise.catch(() => { /* provider owns early settlement until publication */ })
    let published = false
    const controlled: ControlledRun = {
      request,
      publish: () => { published = true; startGate.resolve(undefined) },
      rejectStart: (error) => { startGate.reject(error) },
      settle: (result) => { terminal.resolve(result) },
      rejectResult: (error) => { terminal.reject(error) },
      cancelled: undefined,
      disposed: false,
      disposeCalls: 0,
    }
    this.runs.push(controlled)
    const index = this.runs.length - 1
    request.signal.addEventListener('abort', () => {
      controlled.cancelled = String(request.signal.reason ?? 'cancelled')
      this.onAbortString?.(String(request.signal.reason ?? 'cancelled'), index)
      this.onSignalAbort?.(request.signal.reason, index)
      if (published) terminal.resolve({ output: [], stopReason: 'aborted' })
      else startGate.reject(new Error('child start aborted before publication'))
    }, { once: true })
    if (!this.deferStart) controlled.publish()
    if (this.reply) {
      const reply = this.reply
      queueMicrotask(() => { terminal.resolve(reply(request, index)) })
    }
    try {
      await startGate.promise
    } catch (error: unknown) {
      controlled.disposeCalls += 1
      controlled.disposed = true
      throw error
    }
    if (request.signal.aborted) throw new Error('child start aborted before publication')
    return {
      id: SessionId(`stub-child-${index}`),
      localAgent: undefined,
      result: terminal.promise,
      dispose: () => {
        controlled.disposeCalls += 1
        if (this.disposeDelayMs === 0) {
          controlled.disposed = true
          return Promise.resolve()
        }
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            controlled.disposed = true
            resolve()
          }, this.disposeDelayMs)
        })
      },
    }
  }
}

/** Text-reply helper for auto providers. */
function text(reply: string): SubagentResult {
  return { output: [{ type: 'text', text: reply }], stopReason: 'completed' }
}

interface SetupOptions {
  config?: Config
  reply?: (request: SubagentStartRequest, index: number) => SubagentResult
  manual?: boolean
  disposeDelayMs?: number
  deferStart?: boolean
  onChildAbortString?: (reason: string | undefined, index: number) => void
  onChildSignalAbort?: (reason: unknown, index: number) => void
}

async function setup(options?: SetupOptions) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await mountPtcRuntime(ctx)
  await ctx.plugin(SubagentRuntime)
  const provider = new StubProvider(
    'stub',
    options?.manual ? undefined : options?.reply ?? (() => text('stub reply')),
    options?.disposeDelayMs ?? 0,
    options?.deferStart ?? false,
    options?.onChildAbortString,
    options?.onChildSignalAbort,
  )
  ctx.subagents.registerProvider(provider)
  // A fixed concurrency ceiling: the auto-resolved default is machine-derived
  // (cores - 2, floored at 1), so tests that expect N children in flight
  // would wedge on small CI runners.
  const engineFiber = await ctx.plugin(PtcWorkflowEngine, { provider: 'stub', maxConcurrentAgents: 8, ...options?.config })
  return { ctx, provider, parent: fakeParent(ctx), engineFiber }
}

/** The standard test meta plus a body, spread into a start request. */
function scripted(body: string, metaExtra?: Partial<WorkflowMeta>): { script: string; meta: WorkflowMeta } {
  return { script: body, meta: { name: 'test-flow', description: 'a test workflow', ...metaExtra } }
}

/** Start + await one run, disposing on the way out. */
async function run(ctx: Context, parent: Agent, source: { script: string; meta: WorkflowMeta }, args?: unknown): Promise<WorkflowResult> {
  const handle = ctx.workflowEngine.start({ ...source, parent, ...args !== undefined ? { args } : {} })
  try {
    return await handle.result
  } finally {
    await handle.dispose()
  }
}

// The per-test cap leaves room for one generous startup wait plus the tight
// post-event assertions; explicit narrower timeouts inside stay authoritative.
describe('dsh-workflow-ptc', { timeout: 120_000 }, () => {
  describe('script execution through the Node PTC runtime', () => {
    it('captures args at start and isolates subsequent caller and script mutations', async () => {
      const { ctx, parent } = await setup()
      const args = { values: [1] }
      const handle = ctx.workflowEngine.start({
        ...scripted('args.values.push(3); return args.values'),
        parent,
        args,
      })
      args.values[0] = 2
      try {
        expect((await handle.result).value).toEqual([1, 3])
        expect(args.values).toEqual([2])
      } finally { await handle.dispose() }
    })

    it('runs a script end-to-end: agent() text results, phases, log, args, return value, events', async () => {
      const { ctx, parent, provider } = await setup({ reply: (_request, index) => text(`answer-${index}`) })
      const events: [string, unknown[]][] = []
      for (const name of ['workflow/start', 'workflow/phase', 'workflow/log', 'workflow/agent-start', 'workflow/agent-end', 'workflow/end'] as const) {
        ctx.on(name, (...payload: unknown[]) => { events.push([name, payload]) })
      }
      const result = await run(ctx, parent, scripted(`
        phase('Scan')
        log('starting with ' + args.files.length + ' files')
        const answers = await pipeline(args.files, (prev, item) => agent('read ' + item))
        phase('Report')
        return { answers, count: args.files.length }
      `, { phases: [{ title: 'Scan' }, { title: 'Report' }] }), { files: ['a.ts', 'b.ts'] })

      expect(result.stopReason).toBe('completed')
      expect(result.agentsStarted).toBe(2)
      expect(result.value).toEqual({ answers: ['answer-0', 'answer-1'], count: 2 })
      expect(provider.runs.every(r => r.disposed)).toBe(true)

      const names = events.map(([name]) => name)
      expect(names[0]).toBe('workflow/start')
      expect(names).toContain('workflow/phase')
      expect(names).toContain('workflow/log')
      expect(names.at(-1)).toBe('workflow/end')
      const info = events[0]![1][0] as WorkflowRunInfo
      expect(info.meta.name).toBe('test-flow')
      const end = events.at(-1)![1][1] as Record<string, unknown>
      expect(end).toEqual({ stopReason: 'completed', agentsStarted: 2 })
      expect('value' in end).toBe(false)
    })

    it('agent({schema, model}) forwards outputSchema and agentOptions to the provider through PTC bindings', async () => {
      const { ctx, parent, provider } = await setup({
        reply: () => ({ output: [], structured: { files: ['x.ts', 'y.ts'] }, stopReason: 'completed' }),
      })
      const result = await run(ctx, parent, scripted(`
        const found = await agent('list files', { model: 'deepseek-v4-pro', schema: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] } })
        return { first: found.files[0], count: found.files.length }
      `))
      expect(result.stopReason, result.error?.split('\n')[0]).toBe('completed')
      expect(result.value).toEqual({ first: 'x.ts', count: 2 })
      expect(provider.runs[0]!.request.outputSchema).toEqual({
        type: 'object',
        properties: { files: { type: 'array', items: { type: 'string' } } },
        required: ['files'],
      })
      expect(provider.runs[0]!.request.agentOptions).toEqual({ model: 'deepseek-v4-pro' })
      expect(provider.runs[0]!.request.parent).toBeDefined()
    })

    it('agent({provider}) forwards provider-only agentOptions through PTC bindings', async () => {
      const { ctx, parent, provider } = await setup()
      const result = await run(ctx, parent, scripted("return await agent('route me', { provider: 'openai' })"))

      expect(result.value).toBe('stub reply')
      expect(provider.runs[0]!.request.agentOptions).toEqual({ provider: 'openai' })
    })

    it('a start-request provider override selects every child without changing the engine default', async () => {
      const { ctx, parent, provider } = await setup()
      const selected = new StubProvider('selected', () => text('selected reply'))
      ctx.subagents.registerProvider(selected)

      const overridden = ctx.workflowEngine.start({
        ...scripted("return await agent('route this run')"),
        parent,
        subagentProvider: 'selected',
      })
      expect((await overridden.result).value).toBe('selected reply')
      await overridden.dispose()
      expect(selected.runs).toHaveLength(1)
      expect(provider.runs).toHaveLength(0)

      const ordinary = await run(ctx, parent, scripted("return await agent('use the default')"))
      expect(ordinary.value).toBe('stub reply')
      expect(provider.runs).toHaveLength(1)
    })

    it('rejects invalid start-request provider routes before publishing a run', async () => {
      const { ctx, parent } = await setup()
      let starts = 0
      ctx.on('workflow/start', () => { starts += 1 })
      const messages: string[] = []
      for (const subagentProvider of ['', 'missing']) {
        let run: WorkflowRun | undefined
        let thrown: unknown
        try {
          run = ctx.workflowEngine.start({
            ...scripted("return 'must not start'"),
            parent,
            subagentProvider,
          })
        } catch (error: unknown) {
          thrown = error
        }
        await run?.dispose()
        messages.push(thrown instanceof Error ? thrown.message : '')
      }

      expect(messages).toEqual([
        'workflow subagentProvider must be a non-empty normalized string',
        'no subagent provider registered for "missing"',
      ])
      expect(starts).toBe(0)
    })

    it('rejects invalid per-run total-agent caps before publishing a run', async () => {
      const { ctx, parent } = await setup({ config: { maxTotalAgents: 2 } })
      let starts = 0
      ctx.on('workflow/start', () => { starts += 1 })
      const errors: unknown[] = []
      for (const maxTotalAgents of [0, 1.5, Number.NaN, 3]) {
        try {
          const handle = ctx.workflowEngine.start({
            ...scripted("return 'must not start'"),
            parent,
            maxTotalAgents,
          })
          await handle.dispose()
        } catch (error: unknown) {
          errors.push(error)
        }
      }

      expect(errors.slice(0, 3)).toEqual(Array(3).fill(expect.objectContaining({
        code: 'INVALID_ARGUMENT',
        message: 'workflow maxTotalAgents must be a positive safe integer',
      })))
      expect(errors[3]).toMatchObject({
        code: 'INVALID_ARGUMENT',
        message: 'workflow maxTotalAgents 3 exceeds the engine ceiling 2',
      })
      expect(starts).toBe(0)
    })

    it('enforces a per-run total-agent cap below the engine ceiling', async () => {
      const { ctx, parent } = await setup({ config: { maxTotalAgents: 2 } })
      const handle = ctx.workflowEngine.start({
        ...scripted("await agent('first'); await agent('second'); return 'unreachable'"),
        parent,
        maxTotalAgents: 1,
      })
      const result = await handle.result
      expect(result.stopReason).toBe('error')
      expect(result.agentsStarted).toBe(1)
      expect(result.error).toContain('total agent cap (1)')
      await handle.dispose()
    })

    it('a fatal hook error inside the guest kills the script and reports the error', async () => {
      const { ctx, parent } = await setup()
      const result = await run(ctx, parent, scripted("return await parallel([() => agent('x', { isolation: 'worktree' })])"))
      expect(result.stopReason).toBe('error')
      expect(result.error).toContain('"isolation" is deferred')
    })

    it('rejects an unregistered configured provider before publishing a run', async () => {
      const { ctx, parent } = await setup({ config: { provider: 'nonexistent' } })
      let thrown: unknown
      try {
        ctx.workflowEngine.start({ ...scripted("return 'must not start'"), parent })
      } catch (error: unknown) {
        thrown = error
      }
      expect(thrown).toMatchObject({
        code: 'AGENT_START',
        message: 'no subagent provider registered for "nonexistent"',
      })
    })

    it('waits for async provider start before announcing a result that settled early', async () => {
      const { ctx, parent, provider } = await setup({ manual: true, deferStart: true })
      const order: string[] = []
      ctx.on('workflow/agent-start', (_info, agent) => { order.push(`start:${agent.seq}`) })
      ctx.on('workflow/agent-end', (_info, agent) => { order.push(`end:${agent.outcome}`) })
      ctx.on('workflow/end', () => { order.push('run-end') })

      const handle = ctx.workflowEngine.start({ ...scripted("return await agent('p')"), parent })
      await waitFor(() => { expect(provider.runs.length).toBe(1) })
      const early = text('accepted value')
      provider.runs[0]!.settle(early)
      // The provider still owns this early result while start is pending.
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(order).toEqual([])

      provider.runs[0]!.publish()
      const result = await handle.result
      expect(result.value).toBe('accepted value')
      expect(order).toEqual(['start:1', 'end:completed', 'run-end'])
      await handle.dispose()
      expect(provider.runs[0]!.disposeCalls).toBe(1)
    })

    it('announces an asynchronously published child before its early result rejection', async () => {
      const { ctx, parent, provider } = await setup({ manual: true, deferStart: true })
      const lifecycle: string[] = []
      ctx.on('workflow/agent-start', () => { lifecycle.push('start') })
      ctx.on('workflow/agent-end', (_info, agent) => { lifecycle.push(`end:${agent.outcome}`) })
      const handle = ctx.workflowEngine.start({
        ...scripted("try { await agent('p'); return 'unreachable' } catch (e) { return { code: e.code, message: e.message } }"),
        parent,
      })

      await waitFor(() => { expect(provider.runs.length).toBe(1) })
      provider.runs[0]!.rejectResult(new Error('backend failed before publication'))
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(lifecycle).toEqual([])

      provider.runs[0]!.publish()
      const result = await handle.result
      expect(result.value).toMatchObject({ code: 'AGENT_RESULT' })
      expect((result.value as { message: string }).message).toContain('backend failed before publication')
      expect(lifecycle).toEqual(['start', 'end:failed'])
      await handle.dispose()
    })

    it('classifies provider start rejection as AGENT_START, drops an early result, and emits no false lifecycle pair', async () => {
      const { ctx, parent, provider } = await setup({ manual: true, deferStart: true })
      const lifecycle: string[] = []
      ctx.on('workflow/agent-start', () => { lifecycle.push('start') })
      ctx.on('workflow/agent-end', () => { lifecycle.push('end') })

      const handle = ctx.workflowEngine.start({
        ...scripted("try { await agent('p'); return 'unreachable' } catch (e) { return { code: e.code, message: e.message } }"),
        parent,
      })
      await waitFor(() => { expect(provider.runs.length).toBe(1) })
      // ACP-style failure can settle result(error) before its session/publication
      // boundary rejects. Start rejection must dominate that buffered child outcome.
      provider.runs[0]!.settle({ output: [], stopReason: 'error' })
      await new Promise(resolve => setTimeout(resolve, 0))
      provider.runs[0]!.rejectStart(new Error('publication rolled back'))

      const result = await handle.result
      expect(result.value).toMatchObject({ code: 'AGENT_START' })
      expect((result.value as { message: string }).message).toContain('publication rolled back')
      expect(lifecycle).toEqual([])
      await waitFor(() => {
        expect(provider.runs[0]!.disposed).toBe(true)
        expect(provider.runs[0]!.disposeCalls).toBe(1)
      })
      await handle.dispose()
      expect(provider.runs[0]!.disposeCalls).toBe(1)
    })

    it('aborts a pending provider start once without publishing workflow lifecycle', async () => {
      const { ctx, parent, provider } = await setup({ manual: true, deferStart: true })
      const lifecycle: string[] = []
      ctx.on('workflow/agent-start', () => { lifecycle.push('start') })
      ctx.on('workflow/agent-end', () => { lifecycle.push('end') })

      const handle = ctx.workflowEngine.start({ ...scripted("return await agent('pending')"), parent })
      await waitFor(() => { expect(provider.runs.length).toBe(1) })
      const disposal = handle.dispose()
      await waitFor(() => {
        expect(provider.runs[0]!.cancelled).toBe('workflow disposed')
        expect(provider.runs[0]!.disposed).toBe(true)
      })
      // Ensure the host-driven disposal removed the registry entry before the
      // late start rejection; its callback must not invoke dispose again.
      await new Promise(resolve => setTimeout(resolve, 0))
      provider.runs[0]!.rejectStart(new Error('cancelled before publication'))

      const result = await handle.result
      await disposal
      expect(result.stopReason).toBe('cancelled')
      expect(lifecycle).toEqual([])
      expect(provider.runs[0]!.disposeCalls).toBe(1)
    })

    it('a child result REJECTION crosses back as a fatal AGENT_RESULT error (a broken provider is not a failed child)', async () => {
      const ctx = new Context()
      await ctx.plugin(SessionProjectionRegistry)
      await mountPtcRuntime(ctx)
      await ctx.plugin(SubagentRuntime)
      const provider: SubagentProvider = {
        name: 'rejecting',
        capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: false },
        inheritsParentContext: false,
        start: async () => ({
          id: SessionId('reject-child'),
          localAgent: undefined,
          result: Promise.reject(new Error('backend exploded')),
          dispose: () => Promise.resolve(),
        }),
      }
      ctx.subagents.registerProvider(provider)
      await ctx.plugin(PtcWorkflowEngine, { provider: 'rejecting', maxConcurrentAgents: 2 })
      const result = await run(ctx, fakeParent(ctx), scripted(`
        try { await agent('p'); return 'unreachable' } catch (e) { return { name: e.name, code: e.code, fatal: e.fatal, message: e.message } }
      `))
      expect(result.value).toMatchObject({ name: 'WorkflowError', code: 'AGENT_RESULT', fatal: true })
      expect((result.value as { message: string }).message).toContain('backend exploded')
    })

    it('maps a non-JSON ready-child result to fatal AGENT_RESULT instead of wedging the bridge', async () => {
      const { ctx, parent } = await setup({
        reply: () => ({ output: [], structured: () => { /* deliberately outside lossless JSON */ }, stopReason: 'completed' }),
      })
      const result = await run(ctx, parent, scripted(`
        try { await agent('p'); return 'unreachable' } catch (e) { return { code: e.code, message: e.message } }
      `))
      expect(result.value).toMatchObject({ code: 'AGENT_RESULT' })
      expect((result.value as { message: string }).message).toContain('lossless JSON')
    })

    it('contains a non-JSON result even if the injected subagent service violates its normalization contract', async () => {
      // Host callback results cross PTC as lossless JSON.
      const { ctx, parent } = await setup()
      const invalid = {
        output: [],
        structured: () => { /* deliberately outside lossless JSON */ },
        stopReason: 'completed',
      } as unknown as SubagentResult
      const start = vi.spyOn(ctx.subagents, 'start').mockResolvedValue({
        id: SessionId('raw-invalid-child'),
        localAgent: undefined,
        result: Promise.resolve(invalid),
        dispose: () => Promise.resolve(),
      })

      const result = await run(ctx, parent, scripted(`
        try { await agent('p'); return 'unreachable' } catch (e) { return { code: e.code, message: e.message } }
      `))

      expect(start).toHaveBeenCalledOnce()
      expect(result.value).toMatchObject({ code: 'AGENT_RESULT' })
      expect((result.value as { message: string }).message)
        .toContain('lossless JSON')
    })

    it('a child whose dispose() throws synchronously cannot wedge the script (the host acks anyway)', async () => {
      const ctx = new Context()
      await ctx.plugin(SessionProjectionRegistry)
      await mountPtcRuntime(ctx)
      await ctx.plugin(SubagentRuntime)
      const provider: SubagentProvider = {
        name: 'bad-dispose',
        capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: false },
        inheritsParentContext: false,
        start: async () => ({
          id: SessionId('bad-dispose-child'),
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text', text: 'fine' }], stopReason: 'completed' }),
          cancel: () => { /* settled already */ },
          dispose: () => { throw new Error('dispose exploded') },
        }),
      }
      ctx.subagents.registerProvider(provider)
      await ctx.plugin(PtcWorkflowEngine, { provider: 'bad-dispose', maxConcurrentAgents: 2 })
      const result = await run(ctx, fakeParent(ctx), scripted("return await agent('p')"))
      expect(result.stopReason).toBe('completed')
      expect(result.value).toBe('fine')
    })

    it('a child dispose() rejecting an UNRENDERABLE value still acks — the containment warn is total', async () => {
      const ctx = new Context()
      await ctx.plugin(SessionProjectionRegistry)
      await mountPtcRuntime(ctx)
      await ctx.plugin(SubagentRuntime)
      const provider: SubagentProvider = {
        name: 'coercion-trap-dispose',
        capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: false },
        inheritsParentContext: false,
        start: async () => ({
          id: SessionId('trap-child'),
          localAgent: undefined,
          result: Promise.resolve({ output: [{ type: 'text', text: 'fine' }], stopReason: 'completed' }),
          cancel: () => { /* settled already */ },
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- the non-Error rejection IS the scenario under test
          dispose: () => Promise.reject({ toString: () => { throw new Error('coercion trap') } }),
        }),
      }
      ctx.subagents.registerProvider(provider)
      await ctx.plugin(PtcWorkflowEngine, { provider: 'coercion-trap-dispose', maxConcurrentAgents: 2 })
      const result = await run(ctx, fakeParent(ctx), scripted("return await agent('p')"))
      expect(result.stopReason).toBe('completed')
      expect(result.value).toBe('fine')
    })
  })

  describe('lifecycle: parse errors, cancellation, termination, disposal', () => {
    it('start() throws synchronously for invalid meta data or an unparseable body (host-side pre-checks)', async () => {
      const { ctx, parent } = await setup()
      // Meta is DATA — shape violations reject loud, every one named.
      expect(() => ctx.workflowEngine.start({ script: 'return 1', meta: { name: '', description: 'd' }, parent })).toThrow(/meta\.name must be a non-empty string/)
      expect(() => ctx.workflowEngine.start({ script: 'return 1', meta: { name: 'x', description: 'd', extra: 1 } as unknown as WorkflowMeta, parent })).toThrow(/META_INVALID|not a recognized field/)
      expect(() => ctx.workflowEngine.start({ ...scripted('return ((('), parent })).toThrow(/does not parse/)
      // The likeliest authoring slip — a Claude Code-style meta header in the
      // body — gets a pointed message, not a bare SyntaxError.
      expect(() => ctx.workflowEngine.start({ ...scripted("export const meta = { name: 'x', description: 'd' }\nreturn 1"), parent })).toThrow(/meta rides the `meta` request field/)
    })

    it('cancel() aborts in-flight children and settles after their cleanup', async () => {
      const { ctx, parent, provider } = await setup({ manual: true })
      const starts: number[] = []
      ctx.on('workflow/agent-start', (_info, agent) => { starts.push(agent.seq) })
      const ends: unknown[] = []
      ctx.on('workflow/agent-end', (_info, agent) => { ends.push(agent) })
      const runEnds: WorkflowResultInfo[] = []
      ctx.on('workflow/end', (_info, result) => { runEnds.push(result) })
      const handle = ctx.workflowEngine.start({ ...scripted("return await agent('long job')"), parent })
      // Cancellation emits child ends only for starts already observed by the host.
      await waitFor(() => { expect(starts).toHaveLength(1) })
      handle.cancel('user stopped it')
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      expect(result.error).toContain('user stopped it')
      await handle.dispose()
      expect(provider.runs[0]!.disposed).toBe(true)
      expect(ends).toEqual([expect.objectContaining({ seq: 1, outcome: 'cancelled' })])
      // workflow/end is an observer's only death signal: it fires for a
      // cancelled run too, mirroring the settled outcome data.
      expect(runEnds).toEqual([{ stopReason: 'cancelled', error: result.error, agentsStarted: result.agentsStarted }])
    })

    it('an already-aborted request signal prevents script execution', async () => {
      const { ctx, parent, provider } = await setup()
      const controller = new AbortController()
      controller.abort()
      const logs: string[] = []
      ctx.on('workflow/log', (_info, message) => { logs.push(message) })
      const handle = ctx.workflowEngine.start({ ...scripted("log('ran')\nreturn 123"), parent, signal: controller.signal })
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      expect(result.value).toBeNull()
      expect(logs).toEqual([])
      expect(provider.runs.length).toBe(0)
      await handle.dispose()
    })

    it('cancel() right after start() cancels before the body runs; the signal aborting mid-run cancels like cancel()', async () => {
      const { ctx, parent, provider } = await setup({ manual: true })
      const first = ctx.workflowEngine.start({ ...scripted("return await agent('never')"), parent })
      // No-reason cancel: the canonical default reason must ride the result.
      first.cancel()
      const firstResult = await first.result
      expect(firstResult.stopReason).toBe('cancelled')
      expect(firstResult.error).toContain('workflow cancelled')
      expect(provider.runs.length).toBe(0)
      await first.dispose()

      const controller = new AbortController()
      const second = ctx.workflowEngine.start({ ...scripted("return await agent('job')"), parent, signal: controller.signal })
      await waitFor(() => { expect(provider.runs.length).toBe(1) })
      controller.abort()
      expect((await second.result).stopReason).toBe('cancelled')
      await second.dispose()
    })

    it('removes the exact external abort callback on first settlement or teardown', async () => {
      const { ctx, parent } = await setup()
      const settledController = new AbortController()
      const settledAdd = vi.spyOn(settledController.signal, 'addEventListener')
      const settledRemove = vi.spyOn(settledController.signal, 'removeEventListener')
      const completed = ctx.workflowEngine.start({ ...scripted('return 123'), parent, signal: settledController.signal })
      const settledAbort = settledAdd.mock.calls.find(([type]) => type === 'abort')?.[1]
      expect(typeof settledAbort).toBe('function')

      await expect(completed.result).resolves.toMatchObject({ value: 123, stopReason: 'completed' })
      expect(settledRemove).toHaveBeenCalledWith('abort', settledAbort)
      const cancelAfterSettle = vi.spyOn(completed, 'cancel')
      settledController.abort()
      expect(cancelAfterSettle).not.toHaveBeenCalled()
      cancelAfterSettle.mockRestore()
      await completed.dispose()

      const manual = await setup({ manual: true })
      const teardownController = new AbortController()
      const teardownAdd = vi.spyOn(teardownController.signal, 'addEventListener')
      const teardownRemove = vi.spyOn(teardownController.signal, 'removeEventListener')
      const tornDown = manual.ctx.workflowEngine.start({
        ...scripted("return await agent('job')"),
        parent: manual.parent,
        signal: teardownController.signal,
      })
      await waitFor(() => { expect(manual.provider.runs).toHaveLength(1) })
      const teardownAbort = teardownAdd.mock.calls.find(([type]) => type === 'abort')?.[1]
      expect(typeof teardownAbort).toBe('function')

      const disposing = tornDown.dispose()
      await disposing
      expect(teardownRemove).toHaveBeenCalledWith('abort', teardownAbort)
    })

    it('a child-start racing the host cancel is refused: no child starts after cancellation', async () => {
      const { ctx, parent, provider } = await setup({ manual: true })
      ctx.on('workflow/log', () => { handle.cancel('cancelled from the log listener') })
      const handle = ctx.workflowEngine.start({ ...scripted("log('mark')\nreturn await agent('late')"), parent })
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      expect(provider.runs.length).toBe(0)
      await handle.dispose()
    })

    it('post-cancel narration is suppressed host-side, and completion racing a cancel reports cancelled', async () => {
      const { ctx, parent } = await setup()
      const narration: string[] = []
      ctx.on('workflow/log', (_info, message) => { narration.push(message) })
      ctx.on('workflow/phase', (_info, title) => { narration.push(`phase:${title}`) })
      const handle = ctx.workflowEngine.start({
        ...scripted(`
          log('started')
          await new Promise(() => {})
          phase('late phase')
          log('late log')
          return 'done'
        `),
        parent,
      })
      await waitFor(() => { expect(narration).toContain('started') })
      handle.cancel('raced the completion')
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      expect(result.error).toContain('raced the completion')
      expect(narration).toEqual(['started'])
      await handle.dispose()
    }, 90_000)

    it('cancel() stops a script parked on a promise no hook owns', async () => {
      const { ctx, parent } = await setup({ config: { provider: 'stub' } })
      const runEnds: WorkflowResultInfo[] = []
      ctx.on('workflow/end', (_info, result) => { runEnds.push(result) })
      const handle = ctx.workflowEngine.start({
        ...scripted("await new Promise(() => {})\nreturn 'unreachable'"),
        parent,
      })
      handle.cancel('user aborted')
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      expect(result.error).toContain('user aborted')
      expect(runEnds).toEqual([{ stopReason: 'cancelled', error: result.error, agentsStarted: 0 }])
      await handle.dispose()
    })

    it('dispose() stops a stuck script and waits for cancellation', async () => {
      const { ctx, parent } = await setup({ config: { provider: 'stub' } })
      const handle = ctx.workflowEngine.start({
        ...scripted("await new Promise(() => {})\nreturn 'unreachable'"),
        parent,
      })
      await handle.dispose()
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
    })

    it('dispose() is idempotent and settles cleanly after a completed run', async () => {
      const { ctx, parent } = await setup()
      const handle = ctx.workflowEngine.start({ ...scripted('return 1'), parent })
      await handle.result
      await handle.dispose()
      await handle.dispose()
    })

    it('strays: children fired without await are aborted once the script settles, and dispose() waits for their disposal', async () => {
      const { ctx, parent, provider } = await setup({ manual: true, disposeDelayMs: 40 })
      const handle = ctx.workflowEngine.start({
        ...scripted(`
          agent('stray')
          return 'done without awaiting'
        `),
        parent,
      })
      const result = await handle.result
      expect(result.stopReason).toBe('completed')
      await waitFor(() => { expect(provider.runs.length).toBe(1) })
      await handle.dispose()
      // Not a waitFor: by the time dispose() returns, the slow child disposal
      // must already be complete (host-side registry quiescence).
      expect(provider.runs[0]!.disposed).toBe(true)
    })

    it('the settle-reap fires the request signal too: a provider honoring ONLY the signal winds its stray down promptly', async () => {
      const ctx = new Context()
      await ctx.plugin(SessionProjectionRegistry)
      await mountPtcRuntime(ctx)
      await ctx.plugin(SubagentRuntime)
      const aborted: string[] = []
      const provider: SubagentProvider = {
        name: 'signal-only',
        capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: false },
        inheritsParentContext: false,
        start: async (request) => {
          let settle!: (result: SubagentResult) => void
          const result = new Promise<SubagentResult>((resolve) => { settle = resolve })
          request.signal.addEventListener('abort', () => {
            aborted.push(String(request.signal.reason))
            settle({ output: [], stopReason: 'aborted' })
          }, { once: true })
          return {
            id: SessionId('signal-only-child'),
            localAgent: undefined,
            result,
            dispose: () => Promise.resolve(),
          }
        },
      }
      ctx.subagents.registerProvider(provider)
      await ctx.plugin(PtcWorkflowEngine, { provider: 'signal-only', maxConcurrentAgents: 2 })
      const handle = ctx.workflowEngine.start({
        ...scripted(`
          agent('stray, never awaited')
          return 'done'
        `),
        parent: fakeParent(ctx),
      })
      const result = await handle.result
      expect(result.stopReason, result.error).toBe('completed')
      // BEFORE dispose(): the settlement itself must have aborted the signal —
      // without it this child would stay live until dispose's terminate. This
      // is a HOST-PROMPTNESS claim, not a cold-start race — a tight explicit
      // bound (unlike the file default) so a multi-second reap regression
      // cannot pass by outlasting the wait.
      await waitFor(() => { expect(aborted).toEqual(['workflow settled']) }, 1000)
      await handle.dispose()
    })

    it('the settle-reap aborts a pending provider start before workflow/end', async () => {
      const { ctx, parent, provider } = await setup({ manual: true, deferStart: true })
      const childLifecycle: string[] = []
      let cancellationAtWorkflowEnd: string | undefined
      ctx.on('workflow/agent-start', () => { childLifecycle.push('start') })
      ctx.on('workflow/agent-end', () => { childLifecycle.push('end') })
      ctx.on('workflow/end', () => {
        cancellationAtWorkflowEnd = provider.runs[0]?.cancelled
      })
      const handle = ctx.workflowEngine.start({
        ...scripted(`
          agent('start-pending stray')
          return 'done'
        `),
        parent,
      })

      const result = await handle.result

      expect(result.stopReason).toBe('completed')
      expect(provider.runs).toHaveLength(1)
      expect(provider.runs[0]!.request.signal?.aborted).toBe(true)
      expect(provider.runs[0]!.request.signal?.reason).toBe('workflow settled')
      expect(provider.runs[0]!.cancelled).toBe('workflow settled')
      expect(cancellationAtWorkflowEnd).toBe('workflow settled')
      expect(childLifecycle).toEqual([])
      await handle.dispose()
      expect(provider.runs[0]!.disposeCalls).toBe(1)
    })

    it('concurrent child cleanup and handle disposal dispose each child once', async () => {
      const { ctx, parent, provider } = await setup({ manual: true })
      const handle = ctx.workflowEngine.start({
        ...scripted(`
          await agent('long child')
          return 'unreachable'
        `),
        parent,
      })
      await waitFor(() => { expect(provider.runs.length).toBe(1) })
      const handleDispose = handle.dispose()
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      expect(result.error).toContain('workflow disposed')
      await handleDispose
      expect(provider.runs[0]!.disposed).toBe(true)
      expect(provider.runs[0]!.disposeCalls).toBe(1)
    })

    it('cancellation emits exactly one agent-end per observed start before workflow/end', async () => {
      const { ctx, parent } = await setup({ manual: true })
      const starts: number[] = []
      ctx.on('workflow/agent-start', (_info, agent) => { starts.push(agent.seq) })
      const ends: { seq: number; outcome: string }[] = []
      const order: string[] = []
      ctx.on('workflow/agent-end', (_info, agent) => {
        ends.push({ seq: agent.seq, outcome: agent.outcome })
        order.push(`end:${agent.seq}`)
      })
      ctx.on('workflow/end', () => { order.push('run-end') })
      const handle = ctx.workflowEngine.start({
        ...scripted("await parallel([() => agent('a'), () => agent('b')])\nreturn 'unreachable'"),
        parent,
      })
      await waitFor(() => { expect(starts).toHaveLength(2) })
      handle.cancel('user stop')
      const result = await handle.result
      expect(result.stopReason).toBe('cancelled')
      expect(ends.map(end => end.outcome)).toEqual(['cancelled', 'cancelled'])
      expect(new Set(ends.map(end => end.seq)).size).toBe(2)
      expect(order.indexOf('run-end')).toBe(order.length - 1)
      await handle.dispose()
    })
  })

  describe('process failure and pending child cleanup', () => {
    it('waits for a late provider publication to release its file after cancellation', async () => {
      const ctx = new Context()
      const { root } = await mountPtcRuntime(ctx, 'read-only')
      await ctx.plugin(SubagentRuntime)
      const requested = Promise.withResolvers<SubagentStartRequest>()
      const release = Promise.withResolvers<undefined>()
      const resource = join(root, 'provider-resource.txt')
      let disposals = 0
      ctx.subagents.registerProvider({
        name: 'late-publication',
        capabilities: { agentOptions: false, outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
        inheritsParentContext: false,
        start: async (request) => {
          requested.resolve(request)
          await release.promise
          await writeFile(resource, 'owned')
          return {
            id: SessionId('late-published-child'),
            localAgent: undefined,
            result: Promise.resolve({ output: [], stopReason: 'aborted' }),
            dispose: async () => { disposals += 1; await rm(resource) },
          }
        },
      })
      await ctx.plugin(PtcWorkflowEngine, { provider: 'late-publication' })
      const lifecycle: string[] = []
      ctx.on('workflow/agent-start', () => { lifecycle.push('start') })
      ctx.on('workflow/agent-end', () => { lifecycle.push('end') })
      const handle = ctx.workflowEngine.start({ ...scripted("return await agent('pending')"), parent: fakeParent(ctx) })
      try {
        const request = await Promise.race([
          requested.promise,
          handle.result.then((result) => { throw new Error(`workflow settled before child startup: ${JSON.stringify(result)}`) }),
        ])
        handle.cancel('cancel pending startup')
        expect(request.signal.aborted).toBe(true)
        const settled = vi.fn()
        void handle.result.then(settled)
        await Promise.resolve()
        expect(settled).not.toHaveBeenCalled()
        release.resolve(undefined)
        expect((await handle.result).stopReason).toBe('cancelled')
        expect(disposals).toBe(1)
        await expect(readFile(resource)).rejects.toMatchObject({ code: 'ENOENT' })
        expect(lifecycle).toEqual([])
      } finally {
        release.resolve(undefined)
        await handle.dispose()
      }
    })

    it('a process exit closes observed child lifecycles and awaits their disposal', async () => {
      const { ctx, parent, provider } = await setup({ manual: true })
      const starts: number[] = []
      const ends: number[] = []
      const order: string[] = []
      ctx.on('workflow/agent-start', (_info, child) => { starts.push(child.seq) })
      ctx.on('workflow/agent-end', (_info, child) => { ends.push(child.seq); order.push('child-end') })
      ctx.on('workflow/end', () => { order.push('workflow-end') })
      const handle = ctx.workflowEngine.start({
        ...scripted(`agent('slow')
await agent('release')
globalThis.constructor.constructor('return process')().exit(17)`),
        parent,
      })
      try {
        await waitFor(() => { expect(starts).toHaveLength(2) })
        provider.runs[1]!.settle(text('exit now'))
        const result = await handle.result
        expect(result.stopReason).toBe('error')
        expect(result.error).toContain('worker-exit')
        expect(ends.sort()).toEqual(starts.sort())
        expect(new Set(ends).size).toBe(2)
        expect(order.at(-1)).toBe('workflow-end')
        expect(provider.runs.every(child => child.disposed && child.disposeCalls === 1)).toBe(true)
      } finally { await handle.dispose() }
    })

    it('reports an uncaught Node callback exception as a workflow error', async () => {
      const { ctx, parent } = await setup()
      const result = await run(ctx, parent, scripted(`
const proc = globalThis.constructor.constructor('return process')()
proc.nextTick(() => { throw new Error('workflow process failed') })
await new Promise(() => {})`))
      expect(result.stopReason).toBe('error')
      expect(result.error).toContain('worker-exit')
    })
  })

  describe('service API', () => {
    it('run ids are unique and lifecycle meta is the run\'s borrowed immutable value', async () => {
      const { ctx, parent } = await setup()
      let eventMeta: WorkflowRunInfo | undefined
      ctx.on('workflow/start', (info) => { eventMeta = info })
      const first = ctx.workflowEngine.start({ ...scripted('return 1'), parent })
      const second = ctx.workflowEngine.start({ ...scripted('return 2'), parent })
      expect(first.id).not.toBe(second.id)
      expect(eventMeta!.meta).toBe(second.meta)
      expect(second.meta.name).toBe('test-flow')
      await Promise.all([first.result, second.result])
      await first.dispose()
      await second.dispose()
    })

    it('unregisters ctx.workflowEngine when the engine fiber is disposed (HMR safety)', async () => {
      const ctx = new Context()
      await ctx.plugin(SessionProjectionRegistry)
      await mountPtcRuntime(ctx)
      await ctx.plugin(SubagentRuntime)
      const fiber = await ctx.plugin(PtcWorkflowEngine, {})
      expect(ctx.get('workflowEngine')).toBeDefined()
      await fiber.dispose()
      expect(ctx.get('workflowEngine')).toBeUndefined()
    })

    it('keeps a holder-owned run usable when the engine unloads before its child starts', async () => {
      const { ctx, parent, provider, engineFiber } = await setup({ reply: () => text('survived reload') })
      let handle!: ReturnType<typeof ctx.workflowEngine.start>
      const holder = await ctx.plugin(Object.assign((inner: Context) => {
        handle = inner.workflowEngine.start({ ...scripted("return await agent('after reload')"), parent })
      }, { inject: ['workflowEngine'] }))

      try {
        // The holder retains captured dependencies while the engine reloads.
        expect(provider.runs).toHaveLength(0)
        await engineFiber.dispose()
        expect(ctx.get('workflowEngine')).toBeUndefined()

        await expect(handle.result).resolves.toEqual({
          value: 'survived reload',
          stopReason: 'completed',
          agentsStarted: 1,
        })
        expect(provider.runs).toHaveLength(1)
      } finally {
        await handle.dispose()
        await holder.dispose()
        await ctx.fiber.dispose()
      }
    })

    it('has the class-plugin export shape (default = the engine service class)', () => {
      expect(ptcEngineModule.default).toBe(PtcWorkflowEngine)
      expect('PtcWorkflowEngine' in ptcEngineModule).toBe(false)
      const loader = Object.create(Loader.prototype) as Loader
      const unwrapped: unknown = loader.unwrapExports(ptcEngineModule)
      expect(unwrapped).toBe(PtcWorkflowEngine)
    })
  })
})
