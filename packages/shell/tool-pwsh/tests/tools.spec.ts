/**
 * Consumer-surface tests for the `pwsh` tool over a FAKE bash executor,
 * exercised through `ctx.tools.execute()` so nothing bypasses the tool
 * registry. The fake executor makes every seam outcome scriptable — output
 * text, truncation, timeout, abort, nonzero exits, background handles — so
 * these tests verify the schema, argument validation, workdir derivation,
 * managed `DSH_*` collection, abort translation, canonical result projection,
 * sandbox denial rendering with the escalation surface, rendering,
 * background job wiring, and the UI presenters. Real-pwsh behavior
 * is pinned separately in integration.spec.ts.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_ABORTED, TOOL_ABORTED_BEFORE_DISPATCH } from '@deepseek-ai/dsh-tools'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolTasks from '@deepseek-ai/dsh-tool-jobs'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { turnBoundaryProjectionDefinition } from '@deepseek-ai/dsh-agent-loop'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import * as ToolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import type { ShellProcessRead } from '@deepseek-ai/dsh-shell'
import { processOutcome } from '../src/background.ts'
import { renderPwshProcessRead, renderPwshResult } from '../src/render.ts'

const testToolSignal = new AbortController().signal

/**
 * A scriptable fake executor: `resolve()` mirrors the real defaulting, `run()`
 * returns the armed foreground script, `start()` returns the armed background
 * handle.
 */
class FakeBash extends ShellExecutor {
  requests: ShellExecRequest[] = []
  specs: ShellExecSpec[] = []
  startCalls = 0
  handler: (spec: ShellExecSpec) => ShellRunResult = () => runResult('')
  backgroundHandler: (spec: ShellExecSpec) => ShellProcess = () => fakeProcess('bg-ok\n')

  override resolve(request: ShellExecRequest): ShellExecSpec {
    this.requests.push(request)
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: request.timeoutMs ?? 60_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      ...request.signal ? { signal: request.signal } : {},
      ...request.stdin !== undefined ? { stdin: request.stdin } : {},
      ...request.env !== undefined ? { env: request.env } : {},
      ...request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {},
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  override async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    this.specs.push(spec)
    return this.handler(spec)
  }

  override start(spec: ShellExecSpec): ShellProcess {
    this.startCalls++
    this.specs.push(spec)
    return this.backgroundHandler(spec)
  }
}

/** A successful run result over the given stdout; overrides script the failure shapes. */
function runResult(stdout: string, overrides?: Partial<ShellRunResult>): ShellRunResult {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    timeoutMs: 60_000,
    stdout: { text: stdout, truncated: false },
    stderr: { text: '', truncated: false },
    ...overrides,
  }
}

/** A settled successful background handle; overrides script failure shapes. */
function fakeProcess(delta = 'bg-ok\n'): ShellProcess {
  let consumed = false
  return {
    status: 'completed',
    exitCode: 0,
    signal: null,
    done: Promise.resolve(),
    readOutput: () => {
      if (consumed) return { delta: '', lossy: false }
      consumed = true
      return { delta, lossy: false }
    },
    kill: () => false,
  }
}

/** A running background handle whose kill() settles it as killed (like a real job_kill). */
function killableProcess(): ShellProcess {
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => { resolveDone = resolve })
  const proc: ShellProcess = {
    status: 'running',
    exitCode: null,
    signal: null,
    done,
    readOutput: () => ({ delta: '', lossy: false }),
    kill: () => {
      if (proc.status !== 'running') return false
      proc.status = 'killed'
      proc.signal = 'SIGTERM'
      resolveDone()
      return true
    },
  }
  return proc
}

async function setup(toolConfig: Partial<ToolPwsh.Config> = {}, dshHome?: string) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(BashEnvPlugin, dshHome === undefined ? {} : { dshHome })
  await ctx.plugin(FakeBash)
  await ctx.plugin(ToolPwsh, toolConfig)
  const bash = ctx.shell as FakeBash
  return { ctx, bash }
}

/** Full harness: the generic job runtime + its controller, then the pwsh tool. */
async function setupWithTasks(toolConfig: Partial<ToolPwsh.Config> = {}, dshHome?: string) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(ToolTasks)
  await ctx.plugin(BashEnvPlugin, dshHome === undefined ? {} : { dshHome })
  await ctx.plugin(FakeBash)
  await ctx.plugin(ToolPwsh, toolConfig)
  const bash = ctx.shell as FakeBash
  return { ctx, bash }
}

/**
 * A CONFINING fake executor (`sandboxMode` advertised): the tool must resolve
 * the calling session's standing policy and stamp it on the request, exactly
 * like the bash tool — the per-session sandbox-policy regression surface.
 * Records each confined mode and returns scriptable sandbox facts so the
 * escalation and rendering surfaces are testable without a real backend.
 */
class ConfiningFakeBash extends ShellExecutor {
  requests: ShellExecRequest[] = []
  modes: Array<string | undefined> = []

  override get sandboxMode() {
    return 'read-only' as const
  }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    this.requests.push(request)
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: request.timeoutMs ?? 60_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      ...request.signal ? { signal: request.signal } : {},
      ...request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {},
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  override async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    this.modes.push(spec.sandboxPolicy?.mode)
    return runResult('ok\n', {
      sandbox: {
        mode: spec.sandboxPolicy?.mode ?? 'read-only',
        denied: false,
        ...spec.command === 'without optional sandbox facts'
          ? {}
          : { enforcement: 'full' as const, runnerFailed: false },
      },
    })
  }

  override start(spec: ShellExecSpec): ShellProcess {
    this.modes.push(spec.sandboxPolicy?.mode)
    return fakeProcess()
  }
}

/** Sandboxed composition: the shared policy service + a confining executor + the pwsh tool (+ optional approval). */
async function setupSandboxed(withApproval = false) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(ToolTasks)
  await ctx.plugin(BashEnvPlugin)
  await ctx.plugin(SessionProjectionRegistry)
  // The loop's turnBoundary unit (the open-turn fold) is not mounted in this
  // bench — the loop itself is not composed. Register its open-turn fold so
  // the approval service's turn-enclosure gate reads the seeded log shape.
  ctx.sessionProjections.register(turnBoundaryProjectionDefinition)
  await ctx.plugin(SandboxPolicyService, {})
  await ctx.plugin(ConfiningFakeBash)
  if (withApproval) await ctx.plugin(ApprovalService)
  await ctx.plugin(ToolPwsh)
  const bash = ctx.shell as ConfiningFakeBash
  return { ctx, bash }
}

/**
 * Build a fake {@link Agent} whose session log carries the sandbox-policy
 * mode-override event the escalation flow evaluates against, with an
 * appendable log (the approval service records decisions through
 * `session.append`).
 */
function sandboxAgent(
  mode?: 'read-only' | 'workspace-write' | 'danger-full-access',
  ctx?: Context,
  onAppend?: (type: string) => void,
): Agent {
  const events: Array<{ type: string; data?: Record<string, unknown>; seq?: number }> = [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
  ]
  if (mode !== undefined) events.push({ type: 'sandbox/mode', seq: 1, data: { mode } })
  const id = SessionId('sandbox-session')
  return {
    id,
    ...ctx === undefined ? {} : { ctx: ctx.plugin(() => {}).ctx },
    session: {
      id,
      header: { version: 0, id, createdAt: 0 },
      get seq() { return events.length },
      eventAt: (seq: number) => events[seq],
      snapshotEvents: () => events,
      append: (type: string, data: Record<string, unknown>) => {
        const event = { type, data, seq: events.length }
        events.push(event)
        onAppend?.(type)
        return event
      },
    },
  } as unknown as Agent
}

/**
 * Build a fake {@link Agent} with the shared agent/session identity, give it a
 * dedicated lifecycle fiber for `Agent.ctx`, and register it in `ctx.agents`.
 * The fake session carries an empty event log (the sandbox-policy resolver
 * folds the log for mode overrides, mirroring a real session).
 */
function registerFakeAgent(ctx: Context, sessionId: string): Agent {
  const scopeFiber = ctx.plugin(() => {})
  const id = SessionId(sessionId)
  const agent = {
    id,
    ctx: scopeFiber.ctx,
    session: {
      id,
      header: { version: 0, id, createdAt: 0 },
      seq: 0,
      eventAt: () => undefined,
      snapshotEvents: () => [],
    },
  } as unknown as Agent
  ctx.agents.register(agent)
  return agent
}

let callCounter = 0
function call(ctx: Context, name: string, args: unknown, agent?: Agent) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${++callCounter}`),
    name,
    arguments: args,
    ...agent ? { agent } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

async function callUntilText(
  ctx: Context,
  name: string,
  args: unknown,
  expected: string,
  timeoutMs = 5_000,
): Promise<Awaited<ReturnType<typeof call>>> {
  const deadline = Date.now() + timeoutMs
  let last: Awaited<ReturnType<typeof call>> | undefined
  while (Date.now() < deadline) {
    last = await call(ctx, name, args)
    if (text(last).includes(expected)) return last
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`tool output did not include ${JSON.stringify(expected)}; last text ${JSON.stringify(last === undefined ? '' : text(last))}`)
}

describe('registration', () => {
  it('registers the pwsh tool with its prompt section and schema', async () => {
    const { ctx } = await setup()
    const schema = ctx.tools.schemas().find(s => s.name === 'pwsh')
    expect(schema).toBeDefined()
    expect(schema?.description).toContain('PowerShell command')
    expect(schema?.parameters.properties).toMatchObject({
      command: { type: 'string' },
      description: { type: 'string' },
      timeoutMs: { type: 'number' },
      workdir: { type: 'string' },
      run_in_background: { type: 'boolean' },
    })
    expect(schema?.parameters.required).toEqual(['command', 'description'])
    const prompt = renderPrompt(await ctx.systemPrompt.assemble())
    expect(prompt).toContain('Non-zero exits are reported as `[exit code: N]` markers')
    expect(prompt).toContain('without a signal marker')
  })

  it('stays pending until ctx.shell exists (inject)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(ToolPwsh)
    expect(ctx.tools.schemas()).toHaveLength(0)
  })

  it('unregisters everything on fiber disposal (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(BashEnvPlugin)
    await ctx.plugin(FakeBash)
    const fiber = await ctx.plugin(ToolPwsh)
    expect(ctx.tools.schemas()).toHaveLength(1)
    await fiber.dispose()
    expect(ctx.tools.schemas()).toHaveLength(0)
  })
})

describe('argument validation', () => {
  it('rejects a blank command or description and a non-positive timeoutMs', async () => {
    const { ctx } = await setup()
    expect(text(await call(ctx, 'pwsh', { command: '  ', description: 'd' }))).toContain('expected a non-empty string')
    expect(text(await call(ctx, 'pwsh', { command: 'Write-Output hi', description: ' ' }))).toContain('expected a non-empty string')
    expect(text(await call(ctx, 'pwsh', { command: 'Write-Output hi', description: 'd', timeoutMs: -1 })))
      .toContain('invalid timeoutMs: expected a positive number')
  })
})

describe('execution through the bash seam', () => {
  it('forwards command, session cwd, timeout, and managed DSH_* environment', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'dsh-tool-pwsh-home-'))
    const { ctx, bash } = await setup({}, dshHome)
    bash.handler = () => runResult('hi\n')
    const agent = registerFakeAgent(ctx, 'session-1')
    Object.assign(agent.session.header, { cwd: '/sessions/s1' })
    const result = await call(ctx, 'pwsh', {
      command: 'Write-Output hi',
      description: 'say hi',
      timeoutMs: 1234,
    }, agent)
    expect(result.isError).toBe(false)
    const request = bash.requests[0]
    expect(request?.command).toBe('Write-Output hi')
    expect(request?.workdir).toBe('/sessions/s1')
    expect(request?.timeoutMs).toBe(1234)
    expect(request?.dshEnv).toEqual({
      DSH_HOME: dshHome,
      DSH_SHELL: '1',
      DSH_SESSION_ID: 'session-1',
    })
    expect(bash.specs[0]?.workdir).toBe('/sessions/s1')
  })

  it('resolves a relative workdir against the session cwd, absolute ones verbatim', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('ok\n')
    const agent = registerFakeAgent(ctx, 'session-cwd')
    Object.assign(agent.session.header, { cwd: '/sessions/s1' })
    await call(ctx, 'pwsh', { command: 'pwd', description: 'cwd', workdir: 'sub/dir' }, agent)
    expect(bash.requests[0]?.workdir).toBe(resolvePath('/sessions/s1', 'sub/dir'))
    await call(ctx, 'pwsh', { command: 'pwd', description: 'cwd', workdir: resolvePath('/abs/path') }, agent)
    expect(bash.requests[1]?.workdir).toBe(resolvePath('/abs/path'))
  })

  it('omits workdir and the session id without an agent, so executor defaulting applies', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('ok\n')
    await call(ctx, 'pwsh', { command: 'Write-Output ok', description: 'ok' })
    expect(bash.requests[0]).not.toHaveProperty('workdir')
    const dshEnv = bash.requests[0]?.dshEnv
    expect(dshEnv).toBeDefined()
    expect(dshEnv?.['DSH_SHELL']).toBe('1')
    expect(dshEnv?.['DSH_HOME']).toEqual(expect.any(String))
    expect(dshEnv).not.toHaveProperty('DSH_SESSION_ID')
  })

  it('forwards exec.signal into the resolved request', async () => {
    const { ctx, bash } = await setup()
    const controller = new AbortController()
    bash.handler = () => runResult('ok\n')
    await ctx.tools.execute({
      signal: controller.signal,
      callId: ToolCallId('call-signal'),
      name: 'pwsh',
      arguments: { command: 'Write-Output ok', description: 'ok' },
    })
    expect(bash.requests[0]?.signal).toBe(controller.signal)
  })

  it('projects the canonical foreground result with stdout, stderr, and exit facts', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('out\n', {
      exitCode: 2,
      stderr: { text: 'err\n', truncated: false },
      timeoutMs: 5000,
    })
    const result = await call(ctx, 'pwsh', { command: 'failing', description: 'fail' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected pwsh success')
    expect(result.value).toEqual({
      kind: 'foreground',
      exitCode: 2,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: 5000,
      stdout: { text: 'out\n', truncated: false },
      stderr: { text: 'err\n', truncated: false },
    })
    expect(text(result)).toBe('out\n[stderr]\nerr\n[exit code: 2]')
  })

  it('renders a clean exit without a marker and an empty body as (no output)', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('hi\n')
    const clean = await call(ctx, 'pwsh', { command: 'Write-Output hi', description: 'say hi' })
    expect(text(clean)).toBe('hi\n')

    bash.handler = () => runResult('')
    const empty = await call(ctx, 'pwsh', { command: 'Write-Output -NoNewline ""', description: 'nothing' })
    expect(text(empty)).toBe('(no output)')
  })

  it('renders stderr-only output without a stdout prefix', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('', {
      stderr: { text: 'err\n', truncated: false },
      exitCode: 1,
    })
    const result = await call(ctx, 'pwsh', { command: 'fail', description: 'fail' })
    expect(text(result)).toBe('[stderr]\nerr\n[exit code: 1]')
  })

  it('inserts the separating newline before the stderr section when stdout lacks one', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('out', {
      stderr: { text: 'err\n', truncated: false },
      exitCode: 1,
    })
    const result = await call(ctx, 'pwsh', { command: 'fail', description: 'fail' })
    expect(text(result)).toBe('out\n[stderr]\nerr\n[exit code: 1]')
  })

  it('renders the truncation notice with the spill path, then markers', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('tail', {
      stdout: { text: 'tail', truncated: true, spillPath: '/spill/out.log' },
      stderr: { text: '', truncated: false },
    })
    const result = await call(ctx, 'pwsh', { command: 'noisy', description: 'noise' })
    expect(text(result)).toBe('tail\n[output truncated; full output: /spill/out.log]')

    bash.handler = () => runResult('', { timedOut: true, exitCode: null, signal: 'SIGTERM', timeoutMs: 500 })
    const timedOut = await call(ctx, 'pwsh', { command: 'slow', description: 'slow' })
    // A timeout kill carries both facts, mirroring the bash tool's markers.
    expect(text(timedOut)).toBe('(no output)\n[timed out after 500ms]\n[killed by signal: SIGTERM]')
  })

  it('renders the truncation notice with (unavailable) when no spill path exists', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('tail', {
      stdout: { text: 'tail', truncated: true },
      stderr: { text: '', truncated: false },
    })
    const result = await call(ctx, 'pwsh', { command: 'noisy', description: 'noise' })
    expect(text(result)).toBe('tail\n[output truncated; full output: (unavailable)]')
  })

  it('translates an aborted run into the TOOL_ABORTED HarnessError', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('', { aborted: true, exitCode: null, signal: 'SIGTERM' })
    const result = await call(ctx, 'pwsh', { command: 'Start-Sleep -Seconds 60', description: 'sleep' })
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ info: { name: 'AbortError', code: TOOL_ABORTED } })
  })
})

describe('per-call sandbox policy resolution', () => {
  it('stamps the CALLING SESSION\'s resolved policy onto the request (session cwd, not the server launch dir)', async () => {
    const { ctx, bash } = await setupSandboxed()
    const sessionCwd = mkdtempSync(join(tmpdir(), 'dsh-tool-pwsh-policy-'))
    const agent = registerFakeAgent(ctx, 'policy-session')
    Object.assign(agent.session.header, { cwd: sessionCwd })
    const result = await call(ctx, 'pwsh', { command: 'Write-Output hi', description: 'say hi' }, agent)
    expect(result.isError).toBe(false)
    // The policy's workspace root is the session cwd canonicalized by the
    // policy service (realpath + resolve), NEVER the web server's launch dir;
    // the calling session's identity rides along for backend per-session state.
    expect(bash.requests[0]?.sandboxPolicy).toEqual({
      mode: 'read-only',
      workspaceRoot: resolvePath(realpathSync.native(sessionCwd)),
      sessionId: 'policy-session',
    })
  })

  it('falls back to the deployment policy without an agent, and omits the field entirely without a confining executor', async () => {
    const { ctx, bash } = await setupSandboxed()
    await call(ctx, 'pwsh', { command: 'Write-Output hi', description: 'say hi' })
    expect(bash.requests[0]?.sandboxPolicy).toEqual({
      mode: 'read-only',
      workspaceRoot: resolvePath(realpathSync.native(process.cwd())),
    })

    // The base FakeBash advertises no sandboxMode, so the tool must not stamp
    // any policy (the executor defaulting stays the executor's own).
    const plain = await setup()
    await call(plain.ctx, 'pwsh', { command: 'Write-Output hi', description: 'say hi' })
    expect(plain.bash.requests[0]).not.toHaveProperty('sandboxPolicy')
  })

  it('fails load when a confining executor has no shared sandbox-policy resolver', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(BashEnvPlugin)
    await ctx.plugin(ConfiningFakeBash)
    await expect(ctx.plugin(ToolPwsh)).rejects.toThrow(
      'tool-pwsh: the mounted bash executor confines but ctx.sandboxPolicy is missing',
    )
  })
})

describe('sandbox escalation through ctx.approval', () => {
  const escalate = {
    command: 'Write-Output ok',
    description: 'test escalation',
    sandbox_permissions: 'workspace-write',
    justification: 'the command needs workspace writes',
  }

  it('advertises the sandbox fields, the escalation clause, and the confined-mode contracts', async () => {
    const { ctx } = await setupSandboxed()
    const schema = ctx.tools.schemas().find(item => item.name === 'pwsh')!
    const properties = schema.parameters.properties as Record<string, { enum?: string[] }>
    expect(properties['sandbox_permissions']?.enum).toEqual(['workspace-write', 'danger-full-access'])
    expect(schema.description).toContain('approval prompt')
    expect(schema.description).toContain('ConstrainedLanguage')
    expect(schema.description).toContain('workspace-write stays in FullLanguage')
    expect(schema.description).toContain('In both confined modes, programs cannot open named pipes')
    expect(schema.description).toContain('fails with EPERM')

    for (const args of [
      { command: 'Write-Output ok', description: 'd', sandbox_permissions: 'workspace-write' },
      { command: 'Write-Output ok', description: 'd', justification: 'why' },
      { command: 'Write-Output ok', description: 'd', sandbox_permissions: 'workspace-write', justification: ' ' },
    ]) {
      expect((await call(ctx, 'pwsh', args)).isError).toBe(true)
    }
  })

  it('the escalation fields and the confined-mode clauses stay out of sandbox-less compositions', async () => {
    const { ctx } = await setup()
    const schema = ctx.tools.schemas().find(item => item.name === 'pwsh')!
    expect(schema.description).not.toContain('ConstrainedLanguage')
    expect(schema.description).not.toContain('named pipes')
    expect(schema.description).not.toContain('sandbox_permissions')
    expect(schema.parameters.properties).not.toHaveProperty('sandbox_permissions')
  })

  it('rejects injected escalation without a sandbox and non-widening escalation without prompting', async () => {
    const plain = await setup()
    expect(text(await call(plain.ctx, 'pwsh', escalate))).toContain('not available in this composition')

    const { ctx } = await setupSandboxed(true)
    const prompted = vi.fn()
    ctx.on('approval/request', () => { prompted(); return Promise.resolve<ApprovalOutcome>('allowed-once') })
    const result = await call(ctx, 'pwsh', { ...escalate, sandbox_permissions: 'workspace-write' }, sandboxAgent('workspace-write'))
    expect(text(result)).toContain('not strictly wider')
    expect(prompted).not.toHaveBeenCalled()

    const malformed = sandboxAgent()
    ;(malformed.session.snapshotEvents() as unknown as Array<{ type: string; data: { mode: string }; seq: number }>).push({
      type: 'sandbox/mode',
      data: { mode: 'unknown-mode' },
      seq: malformed.session.seq,
    })
    expect(text(await call(ctx, 'pwsh', escalate, malformed))).toContain('not strictly wider')
  })

  it('fails closed when approval cannot be routed', async () => {
    const withoutService = await setupSandboxed()
    expect(text(await call(withoutService.ctx, 'pwsh', escalate, sandboxAgent()))).toContain('no approval service')

    const withService = await setupSandboxed(true)
    expect(text(await call(withService.ctx, 'pwsh', escalate))).toContain('no agent to route')
    expect(text(await call(withService.ctx, 'pwsh', escalate, sandboxAgent()))).toContain('no approval channel')
  })

  it.each([
    ['rejected', 'user rejected'],
    ['cancelled', 'was cancelled'],
  ] as const)('maps an approval %s to its distinct failure', async (outcome, message) => {
    const { ctx, bash } = await setupSandboxed(true)
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>(outcome))
    const result = await call(ctx, 'pwsh', escalate, sandboxAgent())
    expect(text(result)).toContain(message)
    expect(bash.modes).toEqual([])
  })

  it('runs a granted foreground or background call under the approved mode', async () => {
    const { ctx, bash } = await setupSandboxed(true)
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
    const agent = sandboxAgent(undefined, ctx)
    ctx.agents.register(agent)
    const foreground = await ctx.tools.execute({
      callId: ToolCallId('sandbox-signal'),
      name: 'pwsh',
      arguments: escalate,
      agent,
      signal: new AbortController().signal,
    })
    expect(foreground.isError).toBe(false)
    const background = await call(ctx, 'pwsh', { ...escalate, run_in_background: true }, agent)
    expect(text(background)).toBe('started background job pwsh-1')
    expect(bash.modes).toEqual(['workspace-write', 'workspace-write'])
  })

  it('does not publish detached work when cancellation follows the escalation grant', async () => {
    const { ctx, bash } = await setupSandboxed(true)
    const controller = new AbortController()
    const agent = sandboxAgent(undefined, ctx, (type) => {
      if (type === 'approval/decided') controller.abort()
    })
    ctx.agents.register(agent)
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
    const start = vi.spyOn(bash, 'start')

    const result = await ctx.tools.execute({
      callId: ToolCallId('cancelled-escalation-background'),
      name: 'pwsh',
      arguments: { ...escalate, run_in_background: true },
      agent,
      signal: controller.signal,
    })

    expect(result.error).toEqual({
      message: 'tool call aborted',
      info: { name: 'AbortError', code: TOOL_ABORTED },
    })
    expect(text(result)).toBe('Error: tool call aborted')
    expect(start).not.toHaveBeenCalled()
  })

  it('uses the session override for ordinary calls and evaluates widening against it', async () => {
    const { ctx, bash } = await setupSandboxed(true)
    const agent = sandboxAgent('workspace-write')
    await call(ctx, 'pwsh', { command: 'Write-Output hi', description: 'ordinary' }, agent)
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
    await call(ctx, 'pwsh', { ...escalate, sandbox_permissions: 'danger-full-access' }, agent)
    expect(bash.modes).toEqual(['workspace-write', 'danger-full-access'])
  })

  it('omits sandbox facts the executor did not acquire from the canonical result', async () => {
    const { ctx } = await setupSandboxed()
    const result = await call(ctx, 'pwsh', {
      command: 'without optional sandbox facts',
      description: 'exercise optional sandbox facts',
    })
    if (result.isError) throw new Error('expected foreground pwsh success')
    expect(result.value).toMatchObject({
      kind: 'foreground',
      sandbox: { mode: 'read-only', denied: false },
    })
    expect((result.value as { sandbox: object }).sandbox).not.toHaveProperty('enforcement')
    expect((result.value as { sandbox: object }).sandbox).not.toHaveProperty('runnerFailed')
  })

  it('keeps the exhaustiveness backstop for a rogue approval implementation', async () => {
    const { ctx } = await setupSandboxed(true)
    ctx.approval.request = () => Promise.resolve('rogue' as ApprovalOutcome)
    const result = await call(ctx, 'pwsh', escalate, sandboxAgent())
    expect(text(result)).toContain('unreachable variant in EscalationOutcome')
  })
})

describe('background execution through the job runtime', () => {
  it('run_in_background acks with the job id, readable through the REAL job_output tool', async () => {
    const { ctx } = await setupWithTasks()
    const started = await call(ctx, 'pwsh', { command: 'Write-Output bg-ok', description: 'test command', run_in_background: true })
    expect(started.isError).toBe(false)
    if (started.isError) throw new Error('expected background pwsh success')
    expect(started.value).toEqual({ kind: 'background', jobId: 'pwsh-1' })
    expect(text(started)).toBe('started background job pwsh-1')

    const read = await callUntilText(ctx, 'job_output', { job_id: 'pwsh-1' }, 'bg-ok')
    expect(text(read)).toContain('bg-ok')
    // A later read reports the terminal outcome in the generic status line.
    const final = await callUntilText(ctx, 'job_output', { job_id: 'pwsh-1' }, '[status: completed, exit code: 0]')
    expect(final.isError).toBe(false)
  })

  it('a running background job is killable through the REAL job_kill tool', async () => {
    const { ctx, bash } = await setupWithTasks()
    bash.backgroundHandler = () => killableProcess()
    await call(ctx, 'pwsh', { command: 'Start-Sleep -Seconds 60', description: 'test command', run_in_background: true })

    const killed = await call(ctx, 'job_kill', { job_id: 'pwsh-1' })
    expect(text(killed)).toBe('requested cancellation of job pwsh-1')
    // The cancel reached the process handle; the task settles as killed with
    // the signal detail mapped by processOutcome.
    const final = await call(ctx, 'job_output', { job_id: 'pwsh-1', wait: true })
    expect(text(final)).toContain('[status: killed, signal: SIGTERM]')
  })

  it('a background job started by an agent is registered with that agent as owner', async () => {
    const { ctx } = await setupWithTasks()
    const agent = registerFakeAgent(ctx, 'sess-owner')
    const started = await call(ctx, 'pwsh', { command: 'Start-Sleep -Seconds 60', description: 'test command', run_in_background: true }, agent)
    expect(text(started)).toBe('started background job pwsh-1')

    const anon = await call(ctx, 'job_output', { job_id: 'pwsh-1' })
    expect(anon.isError).toBe(true)
    expect(text(anon)).toMatch(/belongs to another session/)

    const killed = await call(ctx, 'job_kill', { job_id: 'pwsh-1' }, agent)
    expect(killed.isError).toBe(false)
    await call(ctx, 'job_output', { job_id: 'pwsh-1', wait: true }, agent) // await settlement — no orphan
  })

  it('fails loud when the job runtime is not loaded', async () => {
    const { ctx } = await setup() // no LocalJobRegistry / ToolTasks
    const result = await call(ctx, 'pwsh', { command: 'Start-Sleep -Seconds 60', description: 'test command', run_in_background: true })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
  })

  it('a pre-aborted call is skipped before the process starts', async () => {
    const { ctx, bash } = await setupWithTasks()
    const controller = new AbortController()
    controller.abort()
    const result = await ctx.tools.execute({
      callId: ToolCallId('call-pre-aborted'),
      name: 'pwsh',
      arguments: { command: 'Start-Sleep -Seconds 60', description: 'test command', run_in_background: true },
      signal: controller.signal,
    })
    expect(result.isError).toBe(true)
    expect(result.error).toEqual({
      message: 'tool call aborted before dispatch',
      info: { name: 'AbortError', code: TOOL_ABORTED_BEFORE_DISPATCH },
    })
    expect(bash.startCalls).toBe(0)
  })

  it('never spawns the process when tasks.start preflight throws (no orphan, by construction)', async () => {
    // With no job controller, preflight fails before the executor can spawn.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(BashEnvPlugin)
    await ctx.plugin(FakeBash)
    await ctx.plugin(ToolPwsh)
    const bash = ctx.shell as FakeBash

    const result = await call(ctx, 'pwsh', { command: 'Start-Sleep -Seconds 60', description: 'test command', run_in_background: true })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no job controller serves this agent')
    // Declare-then-execute: the failed preflight means no process ever ran.
    expect(bash.startCalls).toBe(0)
  })

  it('enableRunInBackground: false removes the parameter and flips the description', async () => {
    const { ctx } = await setup({ enableRunInBackground: false })
    const schema = ctx.tools.schemas().find(s => s.name === 'pwsh')!
    expect(Object.keys(schema.parameters.properties as Record<string, unknown>))
      .toEqual(['command', 'description', 'timeoutMs', 'workdir'])
    expect(schema.description).toContain('Background execution is not available')
    expect(schema.description).not.toContain('run_in_background')

    // Schema omission is advertising; execution must also enforce the opt-out.
    const forced = await call(ctx, 'pwsh', { command: 'Write-Output hi', description: 'test command', run_in_background: true })
    expect(forced.isError).toBe(true)
    expect(text(forced)).toContain('run_in_background is disabled for this deployment')
    const foreground = await call(ctx, 'pwsh', { command: 'Write-Output hi', description: 'test command' })
    expect(foreground.isError).toBe(false)
  })

  it('applies the built-in background default when apply() receives a bare config', async () => {
    // Bypasses the schemastery defaults on purpose: apply() must stand on its
    // own `?? true` fallback when embedded programmatically without the schema.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(BashEnvPlugin)
    await ctx.plugin(FakeBash)
    ToolPwsh.apply(ctx, {})
    const schema = ctx.tools.schemas()[0]!
    expect(schema.parameters.properties).toHaveProperty('run_in_background')
    expect(schema.description).toContain('job_output')
  })
})

describe('UI presentation', () => {
  it('a real execute presents a completed foreground run as a terminal card with the parsed exit pill', async () => {
    const { ctx, bash } = await setup()
    bash.handler = () => runResult('hi\n')
    const args = { command: 'Write-Output hi', description: 'say hi' }
    const result = await call(ctx, 'pwsh', args)
    const view = ctx.tools.get('pwsh')?.presentResult?.(args, result)
    // A terminal result keeps the RAW bytes (newlines intact) a terminal
    // renderer needs; a clean run renders no exit marker, so the body is the
    // raw output with a clean exit-0 pill, mirroring the bash tool.
    expect(view).toEqual({ card: 'terminal', output: 'hi\n', exitCode: 0 })
  })

  it('the pending call view is a terminal card carrying command, description, and optional cwd', async () => {
    const { ctx } = await setup()
    const definition = ctx.tools.get('pwsh')
    expect(definition?.presentCall?.({ command: 'Get-Process', description: 'List processes' }))
      .toEqual({ card: 'terminal', title: 'Get-Process', description: 'List processes' })
    expect(definition?.presentCall?.({ command: 'Get-Process', description: 'List processes', workdir: 'C:\\work' }))
      .toMatchObject({ cwd: 'C:\\work' })
  })

  it('a background pending call renders the generic card like the bash tool', async () => {
    const { ctx } = await setup()
    const definition = ctx.tools.get('pwsh')
    expect(definition?.presentCall?.({
      command: 'Start-Sleep -Seconds 60',
      description: 'long wait',
      run_in_background: true,
    })).toEqual({
      card: 'generic',
      title: 'Start-Sleep -Seconds 60',
      kind: 'execute',
      rawInput: 'Start-Sleep -Seconds 60',
      content: [{ type: 'text', text: 'long wait' }],
    })
  })

  it('presentResult: a non-zero exit and a signal kill parse into exitCode / signal', async () => {
    const { ctx } = await setup()
    const present = ctx.tools.get('pwsh')
    const args = { command: 'x', description: 'x' }
    expect(present?.presentResult?.(args, { content: [{ type: 'text', text: 'oops\n[exit code: 3]' }], isError: false }))
      .toEqual({ card: 'terminal', output: 'oops', exitCode: 3 })
    expect(present?.presentResult?.(args, { content: [{ type: 'text', text: 'gone\n[killed by signal: SIGKILL]' }], isError: false }))
      .toEqual({ card: 'terminal', output: 'gone', signal: 'SIGKILL' })
  })

  it('presentResult: markers a pill CANNOT show (timeout) stay in the terminal output', async () => {
    const { ctx } = await setup()
    const args = { command: 'x', description: 'x' }
    expect(ctx.tools.get('pwsh')?.presentResult?.(
      args,
      { content: [{ type: 'text', text: 'slow\n[timed out after 100ms]\n[exit code: 143]' }], isError: false },
    )).toEqual({ card: 'terminal', output: 'slow\n[timed out after 100ms]', exitCode: 143 })
  })

  it('presentResult exit parse is the inverse of renderPwshResult markers (round-trip)', async () => {
    const { ctx } = await setup()
    const present = ctx.tools.get('pwsh')!
    const base = {
      aborted: false,
      timeoutMs: 1000,
      stdout: { text: 'out', truncated: false },
      stderr: { text: '', truncated: false },
    }
    const cases = [
      { result: { ...base, exitCode: 0, signal: null, timedOut: false }, expect: { exitCode: 0 } },
      { result: { ...base, exitCode: 7, signal: null, timedOut: false }, expect: { exitCode: 7 } },
      { result: { ...base, exitCode: null, signal: 'SIGTERM' as const, timedOut: false }, expect: { signal: 'SIGTERM' } },
      // A trapped-timeout run that exits 0 has no signal/exit marker → reads as exit 0 (it did exit 0).
      { result: { ...base, exitCode: 0, signal: null, timedOut: true }, expect: { exitCode: 0 } },
    ]
    for (const c of cases) {
      const rendered = renderPwshResult(c.result)
      const out = present.presentResult!({ command: 'x', description: 'x' }, { content: [{ type: 'text', text: rendered }], isError: false })
      // Drop card + output; the remaining fields are the parsed exit.
      const { card: _c, output, ...exit } = out as { card: string; output?: string; exitCode?: number; signal?: string }
      expect(exit).toEqual(c.expect)
      // Whatever the parse consumed is gone from the body, so a card with an
      // exit pill never shows the same status twice.
      expect(output).not.toMatch(/\[exit code: \d+\]|\[killed by signal: /)
    }
  })

  it('presentResult: a clean exit-0 whose output ENDS in marker-like text is NOT read as a failure', async () => {
    const { ctx } = await setup()
    const args = { command: 'Write-Output "[exit code: 5]"', description: 'print' }
    // A successful command may print marker-like text. A clean result appends no marker or
    // newline; parsing requires the leading newline emitted for real markers, so this stays exit 0.
    const out = ctx.tools.get('pwsh')!.presentResult!(args, { content: [{ type: 'text', text: '[exit code: 5]' }], isError: false })
    expect(out).toEqual({ card: 'terminal', output: '[exit code: 5]', exitCode: 0 })
    // Same for a fake signal marker with no leading newline.
    const sig = ctx.tools.get('pwsh')!.presentResult!(args, { content: [{ type: 'text', text: '[killed by signal: SIGKILL]' }], isError: false })
    expect(sig).toEqual({ card: 'terminal', output: '[killed by signal: SIGKILL]', exitCode: 0 })
  })

  it('presentResult: a run_in_background ack is a generic card and carries no exit pill', async () => {
    const { ctx } = await setup()
    const result = ctx.tools.get('pwsh')!.presentResult!(
      { command: 'Start-Sleep -Seconds 60', description: 'long wait', run_in_background: true },
      { content: [{ type: 'text', text: 'started background job pwsh-1' }], isError: false },
    )
    expect(result).toEqual({ card: 'generic', content: [{ type: 'text', text: '```console\nstarted background job pwsh-1\n```' }] })
  })

  it('presentResult: an isError result is a generic card (no real process exit to report)', async () => {
    const { ctx } = await setup()
    const out = ctx.tools.get('pwsh')!.presentResult!(
      { command: 'x', description: 'x' },
      { content: [{ type: 'text', text: 'tool call aborted' }], isError: true },
    )
    expect(out).toEqual({ card: 'generic', content: [{ type: 'text', text: '```console\ntool call aborted\n```' }] })
  })

  it('presentResult falls back to undefined for multi-block or non-text content', async () => {
    const { ctx } = await setup()
    const definition = ctx.tools.get('pwsh')
    const args = { command: 'Write-Output hi', description: 'say hi' }
    const multi = { content: [{ type: 'text' as const, text: 'a' }, { type: 'text' as const, text: 'b' }], isError: false }
    expect(definition?.presentResult?.(args, multi as never)).toBeUndefined()
    const image = { content: [{ type: 'image' as const, text: 'a' }], isError: false }
    expect(definition?.presentResult?.(args, image as never)).toBeUndefined()
  })
})

describe('renderPwshResult sandbox markers', () => {
  const base = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    timeoutMs: 1000,
    stdout: { text: 'out\n', truncated: false },
    stderr: { text: '', truncated: false },
  }

  it('a denied run reports the denial marker before the exit marker', () => {
    expect(renderPwshResult({ ...base, exitCode: 2, sandbox: { mode: 'read-only', denied: true } }))
      .toBe('out\n[sandbox: file access denied under read-only mode]\n[exit code: 2]')
  })

  it('hints only when the composition advertises escalation', () => {
    const denied = { ...base, sandbox: { mode: 'read-only' as const, denied: true } }
    expect(renderPwshResult(denied, ['workspace-write'])).toBe(
      'out\n[sandbox: file access denied under read-only mode]\n'
      + '[sandbox: escalation available — retry this exact command once with sandbox_permissions '
      + '(the narrowest wider mode that suffices) + justification; the approval prompt asks the user]',
    )
  })

  it('a confined run without a denial adds no sandbox marker', () => {
    expect(renderPwshResult({ ...base, sandbox: { mode: 'read-only', denied: false } })).toBe('out\n')
  })
})

describe('renderPwshProcessRead', () => {
  const base: ShellProcessRead = { delta: 'out\n', lossy: false }

  it('returns the delta verbatim for a lossless read', () => {
    expect(renderPwshProcessRead(base)).toBe('out\n')
    expect(renderPwshProcessRead({ delta: '', lossy: false })).toBe('')
  })

  it('appends the loss notice with the available spill paths', () => {
    expect(renderPwshProcessRead({ ...base, lossy: true, stdoutSpillPath: 'C:\\spill\\out.log' }))
      .toBe('out\n[some output was dropped from memory; full output: C:\\spill\\out.log]')
    expect(renderPwshProcessRead({
      ...base,
      lossy: true,
      stdoutSpillPath: 'C:\\spill\\out.log',
      stderrSpillPath: 'C:\\spill\\err.log',
    }))
      .toBe('out\n[some output was dropped from memory; full output: C:\\spill\\out.log, C:\\spill\\err.log]')
  })

  it('reports (unavailable) when a lossy read has no safe spill path', () => {
    expect(renderPwshProcessRead({ ...base, lossy: true }))
      .toBe('out\n[some output was dropped from memory; full output: (unavailable)]')
  })

  it('an empty lossy delta is the notice alone', () => {
    expect(renderPwshProcessRead({ delta: '', lossy: true, stderrSpillPath: 'C:\\spill\\err.log' }))
      .toBe('[some output was dropped from memory; full output: C:\\spill\\err.log]')
  })

  it('inserts the separating newline only when the delta lacks one', () => {
    expect(renderPwshProcessRead({ delta: 'tail', lossy: true }))
      .toBe('tail\n[some output was dropped from memory; full output: (unavailable)]')
    expect(renderPwshProcessRead({ delta: 'tail\n', lossy: true }))
      .toBe('tail\n[some output was dropped from memory; full output: (unavailable)]')
  })

  it('appends the runner-failed notice (denial outranked)', () => {
    expect(renderPwshProcessRead({ delta: 'x', lossy: false }, { mode: 'read-only', denied: true, runnerFailed: true }))
      .toBe('x\n[sandbox: the sandbox runner itself failed under read-only mode — the command did not run; this is a sandbox problem, not a command failure]')
  })

  it('appends the denial marker and hints only when escalation is advertised', () => {
    expect(renderPwshProcessRead({ delta: 'x', lossy: false }, { mode: 'read-only', denied: true }))
      .toBe('x\n[sandbox: file access denied under read-only mode]')
    expect(renderPwshProcessRead({ delta: 'x', lossy: false }, { mode: 'read-only', denied: true }, ['workspace-write']))
      .toBe('x\n[sandbox: file access denied under read-only mode]\n'
        + '[sandbox: escalation available — retry this exact command once with sandbox_permissions '
        + '(the narrowest wider mode that suffices) + justification; the approval prompt asks the user]')
  })
})

describe('processOutcome', () => {
  function settled(over: Partial<ShellProcess>): ShellProcess {
    return {
      status: 'completed',
      exitCode: 0,
      signal: null,
      done: Promise.resolve(),
      readOutput: () => ({ delta: '', lossy: false }),
      kill: () => false,
      ...over,
    }
  }

  it('maps a signal-killed process to killed with the signal detail', () => {
    expect(processOutcome(settled({ status: 'killed', signal: 'SIGTERM' })))
      .toEqual({ status: 'killed', detail: 'signal: SIGTERM' })
  })

  it('maps a killed process without a recorded signal (kill raced exit / spawn failure)', () => {
    expect(processOutcome(settled({ status: 'killed', exitCode: null })))
      .toEqual({ status: 'killed', detail: 'killed before exit' })
  })

  it('maps a completed process to its exit code', () => {
    expect(processOutcome(settled({ exitCode: 3 })))
      .toEqual({ status: 'completed', detail: 'exit code: 3' })
  })

  it('defensively reads a null exit code as 0 (handle shapes from other executors)', () => {
    expect(processOutcome(settled({ exitCode: null })))
      .toEqual({ status: 'completed', detail: 'exit code: 0' })
  })
})
