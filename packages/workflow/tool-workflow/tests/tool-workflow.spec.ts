import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult, ToolExecutionToken } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { WorkflowRunId, WorkflowEngine } from '@deepseek-ai/dsh-workflow'
import type {
  WorkflowAgentEndInfo, WorkflowAgentInfo, WorkflowResult, WorkflowRun,
  WorkflowRunId as WorkflowRunIdType, WorkflowStartRequest,
} from '@deepseek-ai/dsh-workflow'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolTasks from '@deepseek-ai/dsh-tool-jobs'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import PtcWorkflowEngine from '@deepseek-ai/dsh-workflow-ptc'
import { mountWorkflowRuntime } from '../../workflow-ptc/tests/setup.ts'
import * as toolWorkflow from '../src/index.ts'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

const testToolSignal = new AbortController().signal

/** A controllable engine standing in behind ctx.workflowEngine (the tool's only seam). */
class StubEngine extends WorkflowEngine {
  requests: WorkflowStartRequest[] = []
  cancels: string[] = []
  disposed = 0
  disposeBarrier: Promise<void> | undefined
  disposeError: Error | undefined
  settle!: (result: WorkflowResult) => void
  readonly settlements = new Map<WorkflowRunIdType, (result: WorkflowResult) => void>()
  startError: Error | undefined

  start(request: WorkflowStartRequest): WorkflowRun {
    if (this.startError) throw this.startError
    this.requests.push(request)
    const id = WorkflowRunId(`run-${this.requests.length}`)
    const result = new Promise<WorkflowResult>((resolve) => { this.settle = resolve })
    this.settlements.set(id, this.settle)
    request.signal?.addEventListener('abort', () => {
      this.settle({ value: null, stopReason: 'cancelled', error: 'signal', agentsStarted: 0 })
    }, { once: true })
    return {
      id,
      meta: request.meta,
      result,
      cancel: (reason?: string) => {
        this.cancels.push(reason ?? 'cancelled')
        this.settle({ value: null, stopReason: 'cancelled', ...reason !== undefined ? { error: reason } : {}, agentsStarted: 0 })
      },
      dispose: async () => {
        this.disposed += 1
        await this.disposeBarrier
        this.settlements.delete(id)
        if (this.disposeError) throw this.disposeError
      },
    }
  }

  settleRun(id: WorkflowRunIdType, result: WorkflowResult): void {
    const settle = this.settlements.get(id)
    if (settle === undefined) throw new Error(`unknown stub workflow ${id}`)
    settle(result)
  }

  agentStart(id: WorkflowRunIdType, agent: WorkflowAgentInfo): void {
    this.emitWorkflowEvent('workflow/agent-start', {
      id,
      meta: this.requests[Number(String(id).slice(4)) - 1]!.meta,
    }, agent)
  }

  agentEnd(id: WorkflowRunIdType, agent: WorkflowAgentEndInfo): void {
    this.emitWorkflowEvent('workflow/agent-end', {
      id,
      meta: this.requests[Number(String(id).slice(4)) - 1]!.meta,
    }, agent)
  }

  phase(id: WorkflowRunIdType, title: string): void {
    this.emitWorkflowEvent('workflow/phase', {
      id,
      meta: this.requests[Number(String(id).slice(4)) - 1]!.meta,
    }, title)
  }

  logLine(id: WorkflowRunIdType, message: string): void {
    this.emitWorkflowEvent('workflow/log', {
      id,
      meta: this.requests[Number(String(id).slice(4)) - 1]!.meta,
    }, message)
  }
}

async function setup(config?: { toolName?: string; maxResultChars?: number }) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(StubEngine)
  await ctx.plugin(toolWorkflow, config ?? {})
  const engine = ctx.workflowEngine as StubEngine
  const session = Session.create(SessionId('caller'))
  const parent = { id: session.id, options: {}, session } as unknown as Agent
  return { ctx, engine, parent, session }
}

const SCRIPT = 'return 1'
const META = { name: 'audit', description: 'd' }

function execute(ctx: Context, args: unknown, extra?: {
  agent?: Agent
  signal?: AbortSignal
  parent?: ToolExecutionToken
}): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId('call-1'),
    name: 'workflow',
    arguments: args,
    ...extra?.agent ? { agent: extra.agent } : {},
    ...extra?.signal ? { signal: extra.signal } : {},
    ...extra?.parent ? { parent: extra.parent } : {},
  })
}

describe('dsh-tool-workflow', () => {
  it('starts a run with the script/args/parent/signal and renders the completed value', async () => {
    const { ctx, engine, parent } = await setup()
    const controller = new AbortController()
    const pending = execute(ctx, { script: SCRIPT, meta: META, args: { files: ['a.ts'] } }, { agent: parent, signal: controller.signal })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    expect(engine.requests[0]).toMatchObject({ script: SCRIPT, meta: META, args: { files: ['a.ts'] }, parent })
    expect(engine.requests[0]!.signal).toBe(controller.signal)
    engine.settle({ value: { findings: [1, 2] }, stopReason: 'completed', agentsStarted: 7 })
    const result = await pending
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected workflow success')
    expect(result.value).toEqual({ kind: 'foreground', runId: 'run-1', agentsStarted: 7, result: { findings: [1, 2] } })
    const rendered = (result.content[0] as { text: string }).text
    expect(rendered).toContain('workflow "audit" completed (7 agents)')
    expect(rendered).toContain('"findings"')
    expect(engine.disposed).toBe(1)
  })

  it('records one top-level run and its members in the calling Session after cleanup', async () => {
    const { ctx, engine, parent, session } = await setup()
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    const runId = WorkflowRunId('run-1')
    engine.agentStart(runId, {
      seq: 1,
      label: '',
      phase: '',
      childId: SessionId('child-1'),
    })
    engine.agentEnd(runId, {
      seq: 1,
      label: '',
      phase: '',
      childId: SessionId('child-1'),
      outcome: 'completed',
    })
    engine.settleRun(runId, { value: 1, stopReason: 'completed', agentsStarted: 1 })
    expect((await pending).isError).toBe(false)
    expect(engine.disposed).toBe(1)
    expect(session.snapshotEvents().map(event => [event.type, event.data])).toEqual([
      ['tool-workflow/run-start', { runId: 'run-1', name: 'audit' }],
      ['tool-workflow/agent-start', {
        runId: 'run-1', seq: 1, label: '', phase: '', childId: 'child-1',
      }],
      ['tool-workflow/agent-end', { runId: 'run-1', seq: 1, outcome: 'completed' }],
      ['tool-workflow/run-end', { runId: 'run-1', stopReason: 'completed' }],
    ])
  })

  it('writes run-end only after run disposal reaches quiescence', async () => {
    const { ctx, engine, parent, session } = await setup()
    const barrier = Promise.withResolvers<undefined>()
    engine.disposeBarrier = barrier.promise
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    engine.settleRun(WorkflowRunId('run-1'), {
      value: null, stopReason: 'completed', agentsStarted: 0,
    })
    await vi.waitFor(() => { expect(engine.disposed).toBe(1) })
    expect(session.snapshotEvents().map(event => event.type)).toEqual(['tool-workflow/run-start'])
    barrier.resolve(undefined)
    expect((await pending).isError).toBe(false)
    expect(session.snapshotEvents().map(event => event.type)).toEqual([
      'tool-workflow/run-start', 'tool-workflow/run-end',
    ])
  })

  it('records zero-member and concurrent runs independently', async () => {
    const { ctx, engine, parent, session } = await setup()
    const first = execute(ctx, { script: SCRIPT, meta: { ...META, name: 'first' } }, { agent: parent })
    const second = execute(ctx, { script: SCRIPT, meta: { ...META, name: 'second' } }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(2) })
    const secondId = WorkflowRunId('run-2')
    engine.agentStart(secondId, {
      seq: 1, label: 'member', childId: SessionId('child-2'),
    })
    engine.agentEnd(secondId, {
      seq: 1, label: 'member', childId: SessionId('child-2'), outcome: 'failed',
    })
    engine.settleRun(WorkflowRunId('run-1'), { value: null, stopReason: 'completed', agentsStarted: 0 })
    engine.settleRun(secondId, { value: null, stopReason: 'error', error: 'child failed', agentsStarted: 1 })
    expect((await first).isError).toBe(false)
    expect((await second).isError).toBe(true)
    expect(session.snapshotEvents().filter(event => event.type === 'tool-workflow/agent-start'))
      .toHaveLength(1)
    expect(session.snapshotEvents().filter(event => event.type === 'tool-workflow/run-end').map(event => event.data))
      .toEqual([
        { runId: 'run-1', stopReason: 'completed' },
        { runId: 'run-2', stopReason: 'error' },
      ])
  })

  it('does not record nested transport executions', async () => {
    const { ctx, engine, parent, session } = await setup()
    const pending = execute(ctx, { script: SCRIPT, meta: META }, {
      agent: parent,
      parent: Symbol('outer') as ToolExecutionToken,
    })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    engine.settleRun(WorkflowRunId('run-1'), { value: null, stopReason: 'completed', agentsStarted: 0 })
    expect((await pending).isError).toBe(false)
    expect(session.snapshotEvents()).toEqual([])
  })

  it.each([
    'tool-workflow/run-start',
    'tool-workflow/agent-start',
    'tool-workflow/agent-end',
    'tool-workflow/run-end',
  ] as const)('isolates a first append failure at %s and preserves a valid prefix', async (failedType) => {
    const { ctx, engine, parent, session } = await setup()
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    const append = session.append.bind(session)
    session.append = ((type: Parameters<Session['append']>[0], data: never) => {
      if (type === failedType) throw new Error(`injected ${failedType} failure`)
      return append(type, data)
    }) as Session['append']

    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    const runId = WorkflowRunId('run-1')
    engine.agentStart(runId, {
      seq: 1, label: 'member', childId: SessionId('child-1'),
    })
    engine.agentEnd(runId, {
      seq: 1, label: 'member', childId: SessionId('child-1'), outcome: 'completed',
    })
    engine.settleRun(runId, { value: null, stopReason: 'completed', agentsStarted: 1 })
    expect((await pending).isError).toBe(false)
    expect(engine.disposed).toBe(1)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(failedType)
    const types = session.snapshotEvents().map(event => event.type)
    const expectedPrefixes = {
      'tool-workflow/run-start': [],
      'tool-workflow/agent-start': ['tool-workflow/run-start'],
      'tool-workflow/agent-end': ['tool-workflow/run-start', 'tool-workflow/agent-start'],
      'tool-workflow/run-end': [
        'tool-workflow/run-start', 'tool-workflow/agent-start', 'tool-workflow/agent-end',
      ],
    } as const
    expect(types).toEqual(expectedPrefixes[failedType])
  })

  it('contains an append failure whose thrown value cannot be rendered', async () => {
    const { ctx, engine, parent, session } = await setup()
    const warnings: string[] = []
    ctx.logger.warn = ((message: unknown) => { warnings.push(String(message)) }) as typeof ctx.logger.warn
    session.append = () => {
      throw { toString: () => { throw new Error('coercion trap') } }
    }
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests).toHaveLength(1) })
    engine.settleRun(WorkflowRunId('run-1'), {
      value: null, stopReason: 'completed', agentsStarted: 0,
    })
    expect((await pending).isError).toBe(false)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('[unrenderable thrown value]')
  })

  it('maps a non-completed stop reason to an isError result (and still disposes)', async () => {
    const { ctx, engine, parent } = await setup()
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    engine.settle({ value: null, stopReason: 'error', error: 'script threw: boom', agentsStarted: 2 })
    const result = await pending
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('workflow run failed: script threw: boom')
    expect(engine.disposed).toBe(1)
  })

  it('reports a cancelled run distinctly (with and without a reason)', async () => {
    const { ctx, engine, parent } = await setup()
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    engine.settle({ value: null, stopReason: 'cancelled', error: 'user', agentsStarted: 0 })
    const result = await pending
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('workflow run was cancelled (user)')

    const bare = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(2) })
    engine.settle({ value: null, stopReason: 'cancelled', agentsStarted: 0 })
    expect(((await bare).content[0] as { text: string }).text.trim().endsWith('cancelled')).toBe(true)
  })

  it('an error result without a message renders the unknown-error fallback', async () => {
    const { ctx, engine, parent } = await setup()
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    engine.settle({ value: null, stopReason: 'error', agentsStarted: 0 })
    expect(((await pending).content[0] as { text: string }).text).toContain('unknown error')
  })

  it('cancels the run when exec.signal aborts MID-FLIGHT (the abort bridge)', async () => {
    const { ctx, engine, parent } = await setup()
    const controller = new AbortController()
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent, signal: controller.signal })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(engine.cancels).toContain('parent step aborted')
    expect(engine.disposed).toBe(1)
  })

  it('a synchronous engine start throw (meta/parse failure) becomes an isError result', async () => {
    const { ctx, engine, parent } = await setup()
    engine.startError = new Error('invalid meta: meta.name must be a non-empty string')
    const result = await execute(ctx, { script: 'nope', meta: { name: '', description: 'd' } }, { agent: parent })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('meta.name must be a non-empty string')
  })

  it('requires a calling agent (fails loud without exec.agent)', async () => {
    const { ctx, engine } = await setup()
    const result = await execute(ctx, { script: SCRIPT, meta: META })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toContain('requires a calling agent')
    expect(engine.requests.length).toBe(0)
  })

  it('validates its own arguments via the schema DSL (missing script)', async () => {
    const { ctx, parent } = await setup()
    const result = await execute(ctx, {}, { agent: parent })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('INVALID_ARGS')
  })

  it('skips workflow startup when exec.signal is already aborted', async () => {
    const { ctx, engine, parent } = await setup()
    const controller = new AbortController()
    controller.abort()
    const result = await execute(ctx, { script: SCRIPT, meta: META }, { agent: parent, signal: controller.signal })
    expect(result.isError).toBe(true)
    expect(result.error).toEqual({
      message: 'tool call aborted before dispatch',
      info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
    })
    expect(engine.requests).toHaveLength(0)
    expect(engine.cancels).toHaveLength(0)
    expect(engine.disposed).toBe(0)
  })

  it('truncates an oversized rendered value with a notice (maxResultChars)', async () => {
    const { ctx, engine, parent } = await setup({ maxResultChars: 40 })
    const pending = execute(ctx, { script: SCRIPT, meta: META }, { agent: parent })
    await vi.waitFor(() => { expect(engine.requests.length).toBe(1) })
    engine.settle({ value: { blob: 'x'.repeat(500) }, stopReason: 'completed', agentsStarted: 1 })
    const result = await pending
    if (result.isError) throw new Error('expected workflow success')
    expect(result.value).toEqual({ kind: 'foreground', runId: 'run-1', agentsStarted: 1, result: { blob: 'x'.repeat(500) } })
    const rendered = (result.content[0] as { text: string }).text
    expect(rendered).toContain('[truncated:')
    expect(rendered.length).toBeLessThan(400)
  })

  it('registers under a configured toolName and unregisters on fiber dispose (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(StubEngine)
    const fiber = await ctx.plugin(toolWorkflow, { toolName: 'orchestrate' })
    expect(ctx.tools.get('orchestrate')).toBeDefined()
    expect(ctx.tools.get('workflow')).toBeUndefined()
    // The usage-policy prompt section rides the same registration: present
    // under the CONFIGURED name (its guidance names the tool it describes)…
    const sections = (await ctx.systemPrompt.assemble()).sections
    const section = sections.find(s => s.name === 'tool:orchestrate')
    expect(section?.text).toContain('orchestrate')
    expect(sections.some(s => s.name === 'tool:workflow')).toBe(false)
    ctx.systemPrompt.section({ name: 'tool:cordis-order-probe', order: 115.5, text: 'Cordis' })
    expect((await ctx.systemPrompt.assemble()).sections
      .filter(s => s.name === 'tool:cordis-order-probe' || s.name === 'tool:orchestrate')
      .map(s => s.name)).toEqual(['tool:cordis-order-probe', 'tool:orchestrate'])
    await fiber.dispose()
    expect(ctx.tools.get('orchestrate')).toBeUndefined()
    // …and gone with the fiber — a reload must not leak a stale section.
    expect((await ctx.systemPrompt.assemble()).sections.some(s => s.name === 'tool:orchestrate')).toBe(false)
  })

  it('presents a generic pending card titled by the meta name, with the script as rawInput', async () => {
    const { ctx } = await setup()
    const tool = ctx.tools.get('workflow')!
    const view = tool.presentCall!({ script: SCRIPT, meta: META })
    expect(view).toMatchObject({ card: 'generic', title: 'workflow: audit', rawInput: SCRIPT })
  })

  it('presentResult keeps the generic card; presentation is pure and replay-safe on malformed args', async () => {
    const { ctx } = await setup()
    const tool = ctx.tools.get('workflow')!
    expect(tool.presentResult!({ script: SCRIPT, meta: META }, { content: [], isError: false })).toEqual({ card: 'generic' })
    // defineTool soft-validates presentation args: a malformed logged shape
    // (wrong fields entirely, or a call missing its meta) falls back to
    // undefined instead of throwing mid-replay.
    expect(tool.presentCall!({ not: 'the schema' })).toBeUndefined()
    expect(tool.presentCall!({ script: SCRIPT })).toBeUndefined()
  })

  it('has the namespace-plugin export shape (no stray default)', () => {
    expect('default' in toolWorkflow).toBe(false)
    expect(toolWorkflow.name).toBe('tool-workflow')
    expect(toolWorkflow.inject).toEqual(['tools', 'workflowEngine', 'systemPrompt'])
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolWorkflow) as Record<string, unknown>
    expect(unwrapped).toBe(toolWorkflow)
    expect(typeof unwrapped.apply).toBe('function')
  })

  describe('run_in_background', () => {
    /** The stub-engine bench plus a live job registry and a registered owner. */
    async function setupBackground(config?: { enableRunInBackground?: boolean }) {
      const ctx = new Context()
      onTestFinished(async () => { await ctx.fiber.dispose() })
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(LocalJobRegistry)
      await ctx.plugin(ToolTasks)
      await ctx.plugin(StubEngine)
      await ctx.plugin(toolWorkflow, config ?? {})
      const engine = ctx.workflowEngine as StubEngine
      const session = Session.create(SessionId('caller'))
      const parent: Agent = {
        id: session.id, options: {}, session, inbox: unsupportedInbox(), status: 'idle', ctx,
        send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel: () => {},
        runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
      }
      await ctx.agents.register(parent)
      return { ctx, engine, parent, session }
    }

    /** The ring's retained text from offset 0, read as the owner. */
    function retained(ctx: Context, jobId: JobId, owner: Agent): string {
      return ctx.jobs.readAt(jobId, 0, owner.id).chunks.map(chunk => chunk.text).join('')
    }

    it('registers an owned job, mirrors progress into its ring, and settles with the rendered value', async () => {
      const { ctx, engine, parent, session } = await setupBackground()
      const result = await execute(ctx, { script: SCRIPT, meta: META, run_in_background: true }, { agent: parent })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected background acceptance')
      expect(result.value).toEqual({ kind: 'background', jobId: 'workflow-1', runId: 'run-1' })
      expect((result.content[0] as { text: string }).text)
        .toContain('workflow "audit" started in the background as job workflow-1')
      // The engine run carries no tool-step signal: the job owns cancellation.
      expect(engine.requests[0]!.signal).toBeUndefined()

      const jobs = ctx.jobs
      const job = jobs.get('workflow-1' as never, parent.id)
      expect(job).toMatchObject({ kind: 'workflow', label: 'audit', status: 'running', owner: parent.id })
      expect(job.output.total).toBe(0)

      const runId = WorkflowRunId('run-1')
      engine.phase(runId, 'Scan')
      engine.logLine(runId, '3/10 found')
      engine.agentStart(runId, { seq: 1, label: 'scan a.ts', phase: 'Scan', childId: SessionId('child-1') })
      engine.agentEnd(runId, { seq: 1, label: 'scan a.ts', phase: 'Scan', childId: SessionId('child-1'), outcome: 'completed' })
      expect(retained(ctx, job.id, parent)).toBe('▸ Scan\n3/10 found\nagent #1 scan a.ts started\nagent #1 completed\n')
      expect(jobs.get(job.id, parent.id).progress).toBe('Scan')
      // Narration is observer-only: every chunk rides the log channel, so the
      // model's job_output before settlement sees status only.
      expect(jobs.readAt(job.id, 0, parent.id).chunks.map(chunk => chunk.channel)).toEqual(['log', 'log', 'log', 'log'])
      const early = await ctx.tools.execute({
        signal: testToolSignal,
        callId: ToolCallId('call-early-read'),
        name: 'job_output',
        arguments: { job_id: 'workflow-1' },
        agent: parent,
      })
      expect((early.content[0] as { text: string }).text).toBe('(no new output)\n[status: running, Scan]')

      engine.settleRun(runId, { value: { findings: 2 }, stopReason: 'completed', agentsStarted: 4 })
      await vi.waitFor(() => { expect(jobs.get(job.id, parent.id).status).toBe('completed') })
      const settled = jobs.get(job.id, parent.id)
      expect(settled.detail).toBe('4 agents')
      expect(settled.progress).toBeUndefined()
      const read = jobs.read(job.id, parent.id)
      expect(read.result).toContain('workflow "audit" completed (4 agents)')
      expect(read.result).toContain('"findings": 2')
      expect(engine.disposed).toBe(1)
      // The durable session record still brackets the background run.
      expect(session.snapshotEvents().map(event => event.type)).toEqual([
        'tool-workflow/run-start', 'tool-workflow/agent-start', 'tool-workflow/agent-end', 'tool-workflow/run-end',
      ])
      // A straggling event after settlement finds no tracked run and is dropped.
      engine.phase(runId, 'Late')
      expect(retained(ctx, job.id, parent)).not.toContain('Late')
    })

    it('a registry kill cancels the run and the reason lands in the killed detail', async () => {
      const { ctx, engine, parent } = await setupBackground()
      const result = await execute(ctx, { script: SCRIPT, meta: META, run_in_background: true }, { agent: parent })
      if (result.isError) throw new Error('expected background acceptance')
      const jobs = ctx.jobs
      const jobId = (result.value as { jobId: string }).jobId as JobId
      expect(jobs.kill(jobId, parent.id, 'operator stop')).toBe('requested')
      expect(engine.cancels).toEqual(['operator stop'])
      await vi.waitFor(() => { expect(jobs.get(jobId, parent.id).status).toBe('killed') })
      expect(jobs.get(jobId, parent.id).detail).toBe('operator stop')
      expect(engine.disposed).toBe(1)

      // A reasonless kill falls back to the producer's default cancel reason.
      const second = await execute(ctx, { script: SCRIPT, meta: META, run_in_background: true }, { agent: parent })
      if (second.isError) throw new Error('expected background acceptance')
      const secondId = (second.value as { jobId: string }).jobId as JobId
      expect(jobs.kill(secondId, parent.id)).toBe('requested')
      expect(engine.cancels).toEqual(['operator stop', 'background workflow job killed'])
      await vi.waitFor(() => { expect(jobs.get(secondId, parent.id).status).toBe('killed') })
    })

    it('a run that stops with an error fails the job with the script failure', async () => {
      const { ctx, engine, parent } = await setupBackground()
      const result = await execute(ctx, { script: SCRIPT, meta: META, args: { files: ['a.ts'] }, run_in_background: true }, { agent: parent })
      if (result.isError) throw new Error('expected background acceptance')
      expect(engine.requests[0]).toMatchObject({ args: { files: ['a.ts'] } })
      engine.settleRun(WorkflowRunId('run-1'), { value: null, stopReason: 'error', error: 'script exploded', agentsStarted: 2 })
      const jobs = ctx.jobs
      await vi.waitFor(() => { expect(jobs.get('workflow-1' as never, parent.id).status).toBe('failed') })
      expect(jobs.get('workflow-1' as never, parent.id).detail).toBe('script exploded')

      // A failure without a message falls back to the unknown-error detail.
      const second = await execute(ctx, { script: SCRIPT, meta: META, run_in_background: true }, { agent: parent })
      if (second.isError) throw new Error('expected background acceptance')
      engine.settleRun(WorkflowRunId('run-2'), { value: null, stopReason: 'error', agentsStarted: 0 })
      await vi.waitFor(() => { expect(jobs.get('workflow-2' as never, parent.id).status).toBe('failed') })
      expect(jobs.get('workflow-2' as never, parent.id).detail).toBe('unknown error')
    })

    it('a nested transport call mirrors the ring but records no session events, and a dispose failure still settles', async () => {
      const { ctx, engine, parent, session } = await setupBackground()
      engine.disposeError = new Error('worker already gone')
      const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
      const result = await execute(
        ctx,
        { script: SCRIPT, meta: META, run_in_background: true },
        { agent: parent, parent: {} as ToolExecutionToken },
      )
      if (result.isError) throw new Error('expected background acceptance')
      engine.settleRun(WorkflowRunId('run-1'), { value: 'ok', stopReason: 'completed', agentsStarted: 1 })
      const jobs = ctx.jobs
      await vi.waitFor(() => { expect(jobs.get('workflow-1' as never, parent.id).status).toBe('completed') })
      expect(jobs.get('workflow-1' as never, parent.id).detail).toBe('1 agent')
      expect(warn.mock.calls.map(args => String(args[0])).join('\n')).toContain('dispose failed')
      expect(session.snapshotEvents()).toEqual([])
    })

    it('a synchronous engine rejection registers no job', async () => {
      const { ctx, engine, parent } = await setupBackground()
      engine.startError = new Error('META_INVALID: name required')
      const result = await execute(ctx, { script: SCRIPT, meta: META, run_in_background: true }, { agent: parent })
      expect(result.isError).toBe(true)
      expect((result.content[0] as { text: string }).text).toContain('META_INVALID')
      expect(ctx.jobs.list(parent.id)).toEqual([])
    })

    it('fails loud without a job registry', async () => {
      const { ctx, parent } = await setup()
      const result = await execute(ctx, { script: SCRIPT, meta: META, run_in_background: true }, { agent: parent })
      expect(result.isError).toBe(true)
      expect((result.content[0] as { text: string }).text)
        .toContain('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
    })

    it('a disabled composition hides the parameter and rejects the call', async () => {
      const { ctx, parent } = await setupBackground({ enableRunInBackground: false })
      const tool = ctx.tools.get('workflow')!
      expect(JSON.stringify(tool.parameters)).not.toContain('run_in_background')
      expect(tool.description).not.toContain('run_in_background')
      const result = await execute(ctx, { script: SCRIPT, meta: META, run_in_background: true }, { agent: parent })
      expect(result.isError).toBe(true)
      expect((result.content[0] as { text: string }).text).toContain('run_in_background is disabled')
    })

    it('advertises the background semantics in the parameter', async () => {
      const { ctx } = await setupBackground()
      const tool = ctx.tools.get('workflow')!
      expect(JSON.stringify(tool.parameters)).toContain('return a job id immediately instead of waiting')
    })
  })

  describe('composition with the sandboxed PTC workflow engine', () => {
    it('an abort releases the tool even when the script parks on a promise no hook owns', async () => {
      const ctx = new Context()
      onTestFinished(async () => { await ctx.fiber.dispose() })
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SubagentRuntime)
      ctx.subagents.registerProvider({
        name: 'spawn',
        capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
        inheritsParentContext: false,
        start: () => Promise.reject(new Error('the parked-script fixture must not start a child')),
      })
      await mountWorkflowRuntime(ctx)
      await ctx.plugin(PtcWorkflowEngine, {})
      await ctx.plugin(toolWorkflow, {})
      const session = Session.create(SessionId('caller'))
      const parent = { id: session.id, options: {}, session } as unknown as Agent
      const controller = new AbortController()
      const ready = Promise.withResolvers<undefined>()
      ctx.on('workflow/log', () => { ready.resolve(undefined) })
      const pending = execute(ctx, {
        script: 'log("ready"); await new Promise(() => {})\nreturn 1',
        meta: { name: 'stuck', description: 'parks forever' },
      }, { agent: parent, signal: controller.signal })
      await ready.promise
      controller.abort('user abort')
      const result = await pending
      expect(result.isError).toBe(true)
      expect((result.content[0] as { text: string }).text).toContain('cancelled')
    })

    it('a background run over the sandboxed PTC engine settles its job with the rendered return value', async () => {
      const ctx = new Context()
      onTestFinished(async () => { await ctx.fiber.dispose() })
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      await ctx.plugin(AgentRegistry)
      await ctx.plugin(LocalJobRegistry)
      await ctx.plugin(ToolTasks)
      await ctx.plugin(SessionProjectionRegistry)
      await ctx.plugin(SubagentRuntime)
      ctx.subagents.registerProvider({
        name: 'spawn',
        capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
        inheritsParentContext: false,
        start: () => Promise.reject(new Error('the scriptonly fixture must not start a child')),
      })
      await mountWorkflowRuntime(ctx)
      await ctx.plugin(PtcWorkflowEngine, {})
      await ctx.plugin(toolWorkflow, {})
      const session = Session.create(SessionId('caller'))
      const parent: Agent = {
        id: session.id, options: {}, session, inbox: unsupportedInbox(), status: 'idle', ctx,
        send: () => {}, followup: () => {}, steer: () => {}, inject: () => {}, cancel: () => {},
        runMaintenance: task => task(new AbortController().signal), whenIdle: () => Promise.resolve(),
      }
      await ctx.agents.register(parent)

      const result = await execute(ctx, {
        script: 'log("halfway")\nreturn { ok: true }',
        meta: { name: 'scriptonly', description: 'returns without agents' },
        run_in_background: true,
      }, { agent: parent })
      expect(result.isError).toBe(false)
      if (result.isError) throw new Error('expected background acceptance')
      const { jobId } = result.value as { jobId: JobId }
      const jobs = ctx.jobs

      await vi.waitFor(() => { expect(jobs.get(jobId, parent.id).status).toBe('completed') }, { timeout: 10_000 })
      expect(jobs.get(jobId, parent.id).detail).toBe('0 agents')
      const ring = jobs.readAt(jobId, 0, parent.id).chunks.map(chunk => chunk.text).join('')
      expect(ring).toContain('halfway')
      expect(jobs.read(jobId, parent.id).result).toContain('"ok": true')
    }, 15_000)
  })
})
