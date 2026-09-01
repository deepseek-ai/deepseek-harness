import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage, ToolCallId, HarnessError  } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { RUN_CODE_NAME, defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'

import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { WorkerThreadCodeRuntime } from '@deepseek-ai/dsh-code-runtime-worker-thread'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import * as WorkspaceContext from '@deepseek-ai/dsh-agent-instructions'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolTasks from '@deepseek-ai/dsh-tool-jobs'
import CordisHostRunner from '@deepseek-ai/dsh-cordis-host-runner'
import * as ToolCordis from '@deepseek-ai/dsh-tool-cordis'

/**
 * With-key PTC mode proof: a real model receives only `run_code`, composes two
 * sub-calls, writes a file, and returns curated output while the log records
 * each `tool/code-dispatch`. The keyless Loader smoke is in the sibling test.
 */

const PERSONA = 'You are a coding agent. You work by writing TypeScript programs for run_code: '
  + 'batch related tool work into one program and print or return ONLY the findings that matter.'
const WORKSPACE_PROBE = 'dragonfruit-8675309'

let ctx: Context | undefined
let workdir: string | undefined

afterEach(async () => {
  // Always dispose, even on failure/retry/timeout: agent-loop teardown stops
  // the loop, the executor kills stray processes, and the code runtime's
  // dispose awaits worker exits.
  await ctx?.fiber.dispose()
  ctx = undefined
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

async function ptcModeHarness(cwd: string): Promise<Context> {
  const harness = new Context()
  await harness.plugin(LlmRuntime)
  await harness.plugin(SessionStore)
  await harness.plugin(SessionProjectionRegistry)
  await harness.plugin(SystemPrompt, { persona: PERSONA })
  await harness.plugin(ToolRuntime, { mode: 'ptc' })
  await harness.plugin(AgentRegistry)
  await harness.plugin(AgentLoop, { agents: [] })
  await harness.plugin(LlmDeepSeek)
  await harness.plugin(LocalSubprocessRuntime)
  await harness.plugin(BashEnvPlugin)
  await harness.plugin(LocalBashExecutor, { cwd, timeoutMs: 30_000 })
  await harness.plugin(ToolBash)
  await harness.plugin(WorkerThreadCodeRuntime, {})
  return harness
}

async function workspacePtcModeHarness(): Promise<Context> {
  const harness = new Context()
  await harness.plugin(LlmRuntime)
  await harness.plugin(SessionStore)
  await harness.plugin(SessionProjectionRegistry)
  await harness.plugin(SystemPrompt, { persona: PERSONA })
  await harness.plugin(ToolRuntime, { mode: 'ptc' })
  await harness.plugin(AgentRegistry)
  await harness.plugin(LocalFileSystem, { cwd: '/' })
  await harness.plugin(ToolFs)
  await harness.plugin(WorkspaceContext, { maxBytes: 65536 })
  await harness.plugin(AgentLoop, { agents: [] })
  await harness.plugin(LlmDeepSeek, { models: [{ id: 'deepseek-v4-flash' }] })
  await harness.plugin(WorkerThreadCodeRuntime, {})
  return harness
}

let keylessCall = 0
const testToolSignal = new AbortController().signal

/** Execute one outer PTC mode call through the real registry and worker. */
function runCode(
  harness: Context,
  code: string,
  signal: AbortSignal = testToolSignal,
  agent?: Agent,
): Promise<ToolExecutionResult> {
  return harness.tools.execute({
    callId: ToolCallId(`keyless-code-${++keylessCall}`),
    name: RUN_CODE_NAME,
    arguments: { code, description: 'Run the e2e program' },
    signal,
    ...(agent === undefined ? {} : { agent }),
  })
}

/** Read the optional completion from a successful canonical `run_code` value. */
function completion(result: ToolExecutionResult): unknown {
  if (result.isError) {
    throw new Error(result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'))
  }
  const value = result.value
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid run_code result')
  return value.result
}

/** Keyless real-worker harness for direct typed-binding acceptance tests. */
async function typedPtcModeHarness(): Promise<Context> {
  const harness = new Context()
  await harness.plugin(SystemPrompt)
  await harness.plugin(ToolRuntime, { mode: 'ptc' })
  await harness.plugin(WorkerThreadCodeRuntime, {})
  return harness
}

/** Keyless real-worker harness with the task-owned bash lifecycle. */
async function backgroundPtcModeHarness(cwd: string): Promise<Context> {
  const harness = await typedPtcModeHarness()
  await harness.plugin(LocalJobRegistry)
  await harness.plugin(ToolTasks, {})
  await harness.plugin(LocalSubprocessRuntime)
  await harness.plugin(BashEnvPlugin)
  await harness.plugin(LocalBashExecutor, { cwd, timeoutMs: 30_000 })
  await harness.plugin(ToolBash)
  return harness
}

describe('PTC mode typed values: keyless real-worker contracts', () => {
  it('crosses a large intermediate value intact and exposes only typed tool failure fields', async () => {
    ctx = await typedPtcModeHarness()
    ctx.tools.register(defineTool({
      name: 'large_value',
      description: 'Return a large canonical string.',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: () => Promise.resolve('x'.repeat(100_000)),
    }))
    ctx.tools.register(defineTool({
      name: 'always_fail',
      description: 'Fail for ToolCallError coverage.',
      parameters: {},
      output: { schema: { type: 'null' }, render: () => [] },
      execute: () => Promise.reject(new HarnessError('expected failure', 'EXPECTED_INTERNAL_CODE')),
    }))

    const value = completion(await runCode(ctx, `
      const large = await tools.large_value({});
      let failure;
      try {
        await tools.always_fail({});
      } catch (error) {
        failure = {
          typed: error instanceof ToolCallError,
          name: error.name,
          toolName: error.toolName,
          message: error.message,
          exposesCode: 'code' in error,
          exposesContent: 'content' in error,
          exposesInfo: 'info' in error,
        };
      }
      return { length: large.length, failure };
    `))

    expect(value).toEqual({
      length: 100_000,
      failure: {
        typed: true,
        name: 'ToolCallError',
        toolName: 'always_fail',
        message: 'expected failure',
        exposesCode: false,
        exposesContent: false,
        exposesInfo: false,
      },
    })
  })

  it('returns a background job id, settles the outer run, and polls that id to completion', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'dsh-ptc-background-'))
    ctx = await backgroundPtcModeHarness(workdir)

    const jobId = completion(await runCode(ctx, `
      const started = await tools.bash({
        command: "sleep 0.2; printf 'background-complete\\n'",
        description: 'Run completion marker in background',
        run_in_background: true,
      });
      return started.jobId;
    `))
    expect(jobId).toBe('bash-1')

    const polled = completion(await runCode(ctx, `
      return await tools.job_output({ job_id: ${JSON.stringify(jobId)}, wait: true, timeout_ms: 5000 });
    `))
    if (typeof polled !== 'object' || polled === null || Array.isArray(polled)) throw new Error('invalid job_output completion')
    const taskOutput = polled as Record<string, unknown>
    expect(taskOutput.text).toContain('background-complete')
    expect(taskOutput.job).toMatchObject({ id: jobId, kind: 'bash', status: 'completed' })
  }, 15_000)

  it('pre-abort spawns nothing; post-publication abort leaves job_kill as the cancellation owner', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'dsh-ptc-task-cancel-'))
    ctx = await backgroundPtcModeHarness(workdir)

    const pre = new AbortController()
    pre.abort('pre-aborted')
    const preResult = await runCode(ctx, `
      return await tools.bash({ command: 'sleep 10', description: 'Must never start', run_in_background: true });
    `, pre.signal)
    expect(preResult.isError).toBe(true)
    expect(ctx.jobs.list()).toEqual([])

    const afterPublication = new AbortController()
    const running = runCode(ctx, `
      const started = await tools.bash({ command: 'sleep 10', description: 'Wait for explicit task kill', run_in_background: true });
      console.log(started.jobId);
      await new Promise(() => {});
    `, afterPublication.signal)
    for (let attempt = 0; attempt < 100 && ctx.jobs.list().length === 0; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    const job = ctx.jobs.list()[0]
    expect(job).toMatchObject({ id: 'bash-1', status: 'running' })
    afterPublication.abort('outer-call-cancelled')
    expect((await running).isError).toBe(true)
    expect(ctx.jobs.list()[0]).toMatchObject({ id: job!.id, status: 'running' })

    const killed = completion(await runCode(ctx, `
      return await tools.job_kill({ job_id: ${JSON.stringify(job!.id)}, reason: 'test owns cancellation' });
    `))
    expect(killed).toMatchObject({ outcome: 'cancellation-requested', job: { id: job!.id } })
    const settled = completion(await runCode(ctx, `
      return await tools.job_output({ job_id: ${JSON.stringify(job!.id)}, wait: true, timeout_ms: 5000 });
    `))
    expect(settled).toMatchObject({ job: { id: job!.id, status: 'killed' } })
  }, 15_000)

  it('keeps foreground bash coupled to the outer signal', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'dsh-ptc-foreground-cancel-'))
    ctx = await backgroundPtcModeHarness(workdir)
    const controller = new AbortController()
    const startedAt = Date.now()
    const pending = runCode(ctx, `
      return await tools.bash({ command: 'sleep 10', description: 'Run cancellable foreground command' });
    `, controller.signal)
    setTimeout(() => { controller.abort('stop-foreground') }, 200)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
    expect(ctx.jobs.list()).toEqual([])
  }, 15_000)

  it('uses versioned Cordis DTO ids directly for running and pending Plugins, then confirms removal', async () => {
    ctx = await typedPtcModeHarness()
    await ctx.plugin(CordisHostRunner)
    await ctx.plugin(ToolCordis)
    const agent = {
      id: SessionId('ptc-cordis'),
      session: { append: vi.fn() },
    } as unknown as Agent

    const value = completion(await runCode(ctx, `
      const activeDefinition = await tools.cordis_define({
        plugin: { kind: 'new', idPrefix: 'active' },
        name: 'active-ptc-plugin',
        purpose: 'prove an active Host half',
        code: { host: "return { name: 'active-ptc-plugin', apply(ctx) {} }" },
      });
      const active = await tools.cordis_run({
        pluginId: activeDefinition.pluginId,
        packageId: activeDefinition.packageId,
        mode: 'run',
      });
      const pendingDefinition = await tools.cordis_define({
        plugin: { kind: 'new', idPrefix: 'queue' },
        name: 'pending-ptc-plugin',
        purpose: 'prove a Host half waiting for a Service',
        code: { host: "return { name: 'pending-ptc-plugin', inject: ['missing-ptc-service'], apply(ctx) {} }" },
      });
      const pending = await tools.cordis_run({
        pluginId: pendingDefinition.pluginId,
        packageId: pendingDefinition.packageId,
        mode: 'run',
      });
      const before = await tools.cordis_inspect_self({});
      const removed = await tools.cordis_undefine({ pluginId: active.pluginId });
      const after = await tools.cordis_inspect_self({});
      await tools.cordis_undefine({ pluginId: pending.pluginId });
      return {
        active: {
          pluginId: active.pluginId,
          packageId: active.packageId,
          pluginRunId: active.pluginRunId,
          status: active.host.status,
        },
        pending: {
          pluginId: pending.pluginId,
          packageId: pending.packageId,
          pluginRunId: pending.pluginRunId,
          status: pending.host.status,
          waitingFor: pending.host.waitingFor,
        },
        removed,
        beforeContainsId: before.plugins.some(plugin => plugin.pluginId === active.pluginId),
        afterContainsId: after.plugins.some(plugin => plugin.pluginId === active.pluginId),
      };
    `, testToolSignal, agent))

    expect(value).toEqual({
      active: {
        pluginId: 'active-1',
        packageId: 'pkg-1',
        pluginRunId: 'run-1',
        status: 'running',
      },
      pending: {
        pluginId: 'queue-2',
        packageId: 'pkg-2',
        pluginRunId: 'run-2',
        status: 'waiting',
        waitingFor: ['missing-ptc-service'],
      },
      removed: { pluginId: 'active-1', wasRunning: true },
      beforeContainsId: true,
      afterContainsId: false,
    })
  })
})

function waitForIdle(harness: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = harness.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('PTC mode: real model writes a program over real tools', () => {
  it('collapses the wire tool list to [run_code], bridges sub-calls, and returns curated output', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'dsh-ptc-e2e-'))
    ctx = await ptcModeHarness(workdir)
    const agent = ctx.agentLoop.create(SessionId('e2e-ptc'), { provider: 'deepseek-official', model: 'deepseek-v4-flash' })

    agent.followup(createUserMessage({
      content: [{
        type: 'text',
        text: 'Using one run_code program: run `echo alpha-7` with the bash tool, run `echo beta-9` with the bash tool, '
        + 'then write both outputs joined by a plus sign into combined.txt (bash heredoc or redirect), '
        + 'and return only the joined string.',
      }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    const events: readonly SessionEvent[] = agent.session.snapshotEvents()

    // The wire contract: every request this session made offered EXACTLY ONE
    // tool — run_code (the logged header snapshots the assembled list).
    const headers = events.filter(event => event.type === 'request/header')
    expect(headers.length).toBeGreaterThan(0)
    for (const header of headers) {
      expect(header.data.header.tools?.map(tool => tool.name)).toEqual([RUN_CODE_NAME])
    }
    // The model actually went through run_code…
    const calls = events.filter(event => event.type === 'tool/call')
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every(event => event.data.name === RUN_CODE_NAME)).toBe(true)
    // …and the program's tool calls landed as dispatch events under it.
    const dispatches = events.filter(event => event.type === 'tool/code-dispatch')
    expect(dispatches.length).toBeGreaterThanOrEqual(2)
    expect(dispatches.every(event => event.data.name === 'bash')).toBe(true)
    const parents = new Set(calls.map(event => event.data.callId))
    expect(dispatches.every(event => parents.has(event.data.parentCallId))).toBe(true)

    // World verification: the file the program wrote, and the curated answer.
    const combined = await readFile(join(workdir, 'combined.txt'), 'utf8')
    expect(combined).toContain('alpha-7')
    expect(combined).toContain('beta-9')
    const finalMessage = events.findLast(event => event.type === 'assistant/message')
    const finalText = finalMessage !== undefined
      ? finalMessage.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('')
      : ''
    expect(finalText).toContain('alpha-7')
    expect(finalText).toContain('beta-9')
  }, 180_000)

  it('projects nested workspace instructions discovered by an fs sub-call', async () => {
    workdir = await mkdtemp(join(tmpdir(), 'dsh-ptc-workspace-e2e-'))
    await mkdir(join(workdir, '.git'), { recursive: true })
    await mkdir(join(workdir, 'pkg/deep'), { recursive: true })
    await writeFile(join(workdir, 'pkg/AGENTS.md'), `If asked for the PTC mode workspace handshake, reply with exactly ${WORKSPACE_PROBE} and nothing else.\n`)
    await writeFile(join(workdir, 'pkg/deep/task.txt'), 'Touch this file to discover the nested instructions.\n')
    ctx = await workspacePtcModeHarness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('e2e-ptc-workspace-session'),
      meta: { cwd: workdir },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })

    handle.agent.followup(createUserMessage({
      content: [{
        type: 'text',
        text: 'Use one run_code program to call tools.read on pkg/deep/task.txt. After it finishes, answer: PTC mode workspace handshake?',
      }], source: { kind: 'user' } }))
    await waitForIdle(ctx, handle.agent)

    const events: readonly SessionEvent[] = handle.agent.session.snapshotEvents()
    const dispatch = events.find(event => event.type === 'tool/code-dispatch' && event.data.name === 'read')
    const outerResult = events.find(event => event.type === 'tool/result')
    const workspaceContext = await vi.waitFor(() => {
      const splice = handle.agent.session.snapshotEvents().findLast(event => event.type === 'agent/inbox/spliced'
        && event.data.inserted.some(message => message.source.kind === 'agent-instructions'))
      const inserted = splice?.type === 'agent/inbox/spliced'
        ? splice.data.inserted.find(message => message.source.kind === 'agent-instructions')
        : undefined
      expect(inserted).toBeDefined()
      return inserted!
    })
    expect(dispatch).toBeDefined()
    expect(outerResult).toBeDefined()
    const contextText = workspaceContext.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
    expect(contextText).toContain(WORKSPACE_PROBE)
  }, 180_000)
})
