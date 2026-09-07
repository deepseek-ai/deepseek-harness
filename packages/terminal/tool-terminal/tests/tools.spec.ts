import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { renderToolsSdk } from '@deepseek-ai/dsh-tools'
import type { ToolSdkSchema } from '@deepseek-ai/dsh-tools/src/ts-types.ts'
import TerminalSessionService, { TerminalSessionId } from '@deepseek-ai/dsh-terminal'
import type { TerminalBackend, TerminalBackendSession, TerminalSendOperation, TerminalSendRequest, TerminalSessionStatus, TerminalSignal } from '@deepseek-ai/dsh-terminal'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolTasks from '@deepseek-ai/dsh-tool-jobs'
import * as ToolPty from '@deepseek-ai/dsh-tool-terminal'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'

function fakeAgent(ctx: Context, rawId: string): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId(rawId)
  const session = Session.create(id)
  const agent: Agent = {
    id, options: {}, session, inbox: unsupportedInbox(),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {}, steer: () => {}, inject: () => {}, cancel() {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(agent)
  return agent
}

class StubSession implements TerminalBackendSession {
  readonly motd = 'stub prompt'
  readonly pid = 42
  statusValue: TerminalSessionStatus = { kind: 'running' }
  operation: TerminalSendOperation | undefined
  autoSettle = true
  rejectOperation = false
  closeGate: PromiseWithResolvers<undefined> | undefined
  viewport = 'command output'
  delta = 'live output'
  deltaTruncated = false

  startSend(_request: TerminalSendRequest): TerminalSendOperation {
    let settle!: () => void
    let reject!: (error: unknown) => void
    let cancelled = false
    const done = new Promise<void>((resolve, rejectPromise) => { settle = resolve; reject = rejectPromise }).then(() => ({
      viewport: cancelled ? '^C' : this.viewport,
      waitReason: 'stdin_read' as const,
      sessionStatus: this.statusValue,
      truncated: false,
    }))
    const operation: TerminalSendOperation = {
      done,
      readOutput: () => ({ delta: this.delta, truncated: this.deltaTruncated }),
      cancel: () => {
        if (cancelled) return false
        cancelled = true
        settle()
        return true
      },
    }
    this.operation = operation
    if (this.rejectOperation) queueMicrotask(() => { reject(new Error('operation failed')) })
    else if (this.autoSettle) queueMicrotask(settle)
    return operation
  }

  read() {
    return { text: 'history', totalLines: 1, lineBegin: 0, lineEnd: 1, truncated: false }
  }

  async signal(signal: TerminalSignal) {
    return { delivered: true as const, targetPgid: signal === 'SIGINT' ? 10 : 11 }
  }

  status() { return this.statusValue }

  async close() {
    if (this.closeGate !== undefined) await this.closeGate.promise
    this.statusValue = { kind: 'exited', exitCode: 0, signal: null }
  }
}

function stubBackend() {
  const sessions: StubSession[] = []
  const backend: TerminalBackend = {
    type: 'stub',
    async spawn() {
      const session = new StubSession()
      sessions.push(session)
      return session
    },
  }
  return { backend, sessions }
}

async function setup(jobs: boolean, config: ToolPty.Config = {}) {
  const base = await setupBase(jobs)
  await base.ctx.plugin(ToolPty, config)
  return base
}

async function setupBase(jobs: boolean) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(TerminalSessionService)
  const stub = stubBackend()
  ctx.terminals.registerBackend(stub.backend)
  if (jobs) {
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(ToolTasks)
  }
  return { ctx, stub, agent: fakeAgent(ctx, jobs ? 'with-tasks' : 'foreground') }
}

let callNumber = 0
const TOOL_NAMES = ['terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list'] as const
const testToolSignal = new AbortController().signal
function call(ctx: Context, name: string, args: unknown, agent?: Agent) {
  return ctx.tools.execute({ signal: testToolSignal, callId: ToolCallId(`pty-call-${++callNumber}`), name, arguments: args, ...agent ? { agent } : {} })
}

function callWithSignal(ctx: Context, name: string, args: unknown, agent: Agent, signal: AbortSignal) {
  return ctx.tools.execute({ callId: ToolCallId(`pty-call-${++callNumber}`), name, arguments: args, agent, signal })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe('tool-terminal foreground API', () => {
  it('registers exactly six schemas and drives the full owner-scoped lifecycle', async () => {
    const { ctx, agent } = await setup(false)
    expect(TOOL_NAMES.every(name => ctx.tools.get(name) !== undefined)).toBe(true)

    const spawned = await call(ctx, 'terminal_open', { type: 'stub', name: 'main' }, agent)
    expect(text(spawned)).toContain('started terminal session pty-1 (main)')
    expect(spawned).toMatchObject({
      isError: false,
      value: {
        sessionId: 'pty-1',
        name: 'main',
        type: 'stub',
        pid: 42,
        status: { kind: 'running' },
        motd: 'stub prompt',
      },
    })
    const listed = await call(ctx, 'terminal_list', {}, agent)
    expect(text(listed)).toContain('pty-1 (main) [stub] running pid=42')
    expect(listed).toMatchObject({ isError: false, value: [{ sessionId: 'pty-1', name: 'main', type: 'stub', pid: 42, status: { kind: 'running' } }] })
    const read = await call(ctx, 'terminal_read', { sessionId: 'pty-1' }, agent)
    expect(text(read)).toContain('history\n[lines: 0-1 of 1]')
    expect(read).toMatchObject({ isError: false, value: { text: 'history', totalLines: 1, lineBegin: 0, lineEnd: 1, truncated: false } })
    const signalled = await call(ctx, 'terminal_signal', { sessionId: 'pty-1', signal: 'SIGINT' }, agent)
    expect(text(signalled)).toBe('delivered SIGINT to foreground process group 10')
    expect(signalled).toMatchObject({ isError: false, value: { delivered: true, targetPgid: 10 } })
    const sent = await call(ctx, 'terminal_send', { sessionId: 'pty-1', text: 'echo hi' }, agent)
    expect(text(sent)).toContain('command output\n[wait: stdin_read]\n[session: running]')
    expect(sent).toMatchObject({
      isError: false,
      value: {
        kind: 'foreground',
        viewport: 'command output',
        waitReason: 'stdin_read',
        sessionStatus: { kind: 'running' },
        truncated: false,
      },
      meta: {
        viewport: 'command output',
        waitReason: 'stdin_read',
        sessionStatus: { kind: 'running' },
        truncated: false,
      },
    })
    const closed = await call(ctx, 'terminal_close', { sessionId: 'pty-1' }, agent)
    expect(text(closed)).toBe('closed terminal session pty-1')
    expect(closed).toMatchObject({ isError: false, value: { sessionId: 'pty-1', outcome: 'closed' } })
    const empty = await call(ctx, 'terminal_list', {}, agent)
    expect(text(empty)).toBe('(no terminal sessions)')
    expect(empty).toMatchObject({ isError: false, value: [] })
  })

  it('projects every terminal DTO into the generated PTC mode output map', async () => {
    const { ctx } = await setup(false)
    const schemas = TOOL_NAMES.map((toolName): ToolSdkSchema => {
      const definition = ctx.tools.get(toolName)
      if (definition === undefined) throw new Error(`missing terminal tool ${toolName}`)
      return {
        name: definition.name,
        description: definition.description,
        parameters: definition.parameters,
        output: definition.output.schema,
      }
    })
    const sdk = renderToolsSdk(schemas)
    const outputMapStart = sdk.indexOf('interface ToolOutputMap')
    const outputMapEnd = sdk.indexOf('\n\ntype ToolName', outputMapStart)

    expect(sdk.slice(outputMapStart, outputMapEnd)).toMatchInlineSnapshot(`
      "interface ToolOutputMap {
        terminal_close: {
          sessionId: string;
          outcome: "closed" | "already-closing";
        };
        terminal_list: ({
          sessionId: string;
          name?: string;
          type: string;
          pid?: number;
          status: {
            kind: "running";
          } | {
            kind: "exited";
            exitCode: number | null;
            signal: string | null;
          };
        })[];
        terminal_open: {
          sessionId: string;
          name?: string;
          type: string;
          pid?: number;
          status: {
            kind: "running";
          } | {
            kind: "exited";
            exitCode: number | null;
            signal: string | null;
          };
          motd: string;
        };
        terminal_read: {
          text: string;
          totalLines: number;
          lineBegin: number;
          lineEnd: number;
          truncated: boolean;
        };
        terminal_send: {
          kind: "background";
          jobId: string;
        } | {
          kind: "foreground";
          viewport: string;
          waitReason: "stdin_read" | "inferred_idle" | "timeout" | "session_exit";
          sessionStatus: {
            kind: "running";
          } | {
            kind: "exited";
            exitCode: number | null;
            signal: string | null;
          };
          truncated: boolean;
        };
        terminal_signal: {
          delivered: true;
          targetPgid: number;
        };
      }"
    `)
  })

  it('fails without an initiating agent and rejects background before writing', async () => {
    const { ctx, agent, stub } = await setup(false)
    expect((await call(ctx, 'terminal_open', { type: 'stub' })).isError).toBe(true)
    await call(ctx, 'terminal_open', { type: 'stub' }, agent)
    const result = await call(ctx, 'terminal_send', { sessionId: 'pty-1', text: 'sleep 1', run_in_background: true }, agent)
    expect(result.isError).toBe(true)
    expect(stub.sessions[0]?.operation).toBeUndefined()
  })

  it('validates required values and forwards optional spawn/read arguments', async () => {
    const { ctx, agent } = await setup(false)
    expect((await call(ctx, 'terminal_open', { type: '' }, agent)).isError).toBe(true)
    expect((await call(ctx, 'terminal_send', { sessionId: '', text: 'x' }, agent)).isError).toBe(true)
    expect((await call(ctx, 'terminal_send', { sessionId: 1, text: 'x' }, agent)).isError).toBe(true)
    expect((await call(ctx, 'terminal_send', { sessionId: 'pty-1', text: 1 }, agent)).isError).toBe(true)
    await call(ctx, 'terminal_open', { type: 'stub', name: 'named', cwd: '/tmp' }, agent)
    expect(text(await call(ctx, 'terminal_read', { sessionId: 'pty-1', offset: 2, count: 3 }, agent))).toContain('history')
  })

  it('declares terminal presentation only for foreground sends', async () => {
    const { ctx } = await setup(false)
    const definition = ctx.tools.get('terminal_send')
    expect(definition?.presentCall?.({ sessionId: 'pty-1', text: 'python3' })).toMatchObject({ card: 'terminal', title: 'python3' })
    expect(definition?.presentCall?.({ sessionId: 'pty-1', text: 'make', run_in_background: true })).toMatchObject({ card: 'generic' })
    expect(definition?.presentCall?.({ sessionId: 'pty-1', text: '' })).toMatchObject({ card: 'terminal', title: '(send input)' })
    expect(definition?.presentResult?.({ sessionId: 'pty-1', text: 'x', run_in_background: true }, { content: [], isError: false })).toBeUndefined()
    expect(definition?.presentResult?.({ sessionId: 'pty-1', text: 'x' }, { content: [], isError: true })).toBeUndefined()
    expect(definition?.presentResult?.({ sessionId: 'pty-1', text: 'x' }, { content: [], isError: false })).toBeUndefined()
    expect(definition?.presentResult?.({ sessionId: 'pty-1', text: 'x' }, { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], isError: false })).toBeUndefined()
    expect(definition?.presentResult?.({ sessionId: 'pty-1', text: 'x' }, { content: [undefined as never], isError: false })).toBeUndefined()
    expect(definition?.presentResult?.({ sessionId: 'pty-1', text: 'x' }, { content: [{ type: 'text', text: 'ok' }], isError: false })).toEqual({ card: 'terminal', output: 'ok' })

    expect(ctx.tools.get('terminal_open')?.presentCall?.({ type: 'stub' })).toMatchObject({ card: 'generic', title: 'Open terminal stub' })
    expect(ctx.tools.get('terminal_open')?.presentCall?.({ type: 'stub', name: 'main' })).toMatchObject({ card: 'generic', title: 'Open terminal main' })
    expect(ctx.tools.get('terminal_read')?.presentCall?.({ sessionId: 'pty-1' })).toMatchObject({ card: 'generic', title: 'Read terminal pty-1' })
    expect(ctx.tools.get('terminal_signal')?.presentCall?.({ sessionId: 'pty-1', signal: 'SIGINT' })).toMatchObject({ card: 'generic', title: 'Signal terminal pty-1' })
    expect(ctx.tools.get('terminal_close')?.presentCall?.({ sessionId: 'pty-1' })).toMatchObject({ card: 'generic', title: 'Close terminal pty-1' })
    expect(ctx.tools.get('terminal_list')?.presentCall?.({})).toMatchObject({ card: 'generic', title: 'List terminal sessions' })
  })

  it('configuration-gates background sends and validates the final result bound', async () => {
    const disabled = await setup(true, { enableRunInBackground: false })
    const definition = disabled.ctx.tools.get('terminal_send')
    expect(definition?.parameters).not.toHaveProperty('properties.run_in_background')
    expect(definition?.description).not.toContain('Background mode')
    await call(disabled.ctx, 'terminal_open', { type: 'stub' }, disabled.agent)
    expect((await call(disabled.ctx, 'terminal_send', {
      sessionId: 'pty-1', text: 'work', run_in_background: true,
    }, disabled.agent)).isError).toBe(true)

    const defaults = await setupBase(false)
    ToolPty.apply(defaults.ctx)
    expect(defaults.ctx.tools.get('terminal_send')?.parameters).toHaveProperty('properties.run_in_background')

    const invalid = await setupBase(false)
    expect(() => { ToolPty.apply(invalid.ctx, { maxResultBytes: 0 }) }).toThrow('maxResultBytes')
    expect(() => { ToolPty.apply(invalid.ctx, { maxResultBytes: 63 }) }).toThrow('at least 64')
  })

  it('bounds normalized errors and preserves allocated ids at the minimum result cap', async () => {
    const { ctx, agent } = await setup(true, { maxResultBytes: 64 })
    const failed = await call(ctx, 'terminal_open', { type: 'x'.repeat(1_000) }, agent)
    expect(failed.isError).toBe(true)
    expect(Buffer.byteLength(text(failed))).toBeLessThanOrEqual(64)
    expect(text(failed)).toContain('[output truncated]')

    const opened = await call(ctx, 'terminal_open', { type: 'stub', name: 'n'.repeat(1_000) }, agent)
    expect(text(opened)).toContain('pty-1')
    expect(Buffer.byteLength(text(opened))).toBeLessThanOrEqual(64)
    const background = await call(ctx, 'terminal_send', {
      sessionId: 'pty-1', text: 'work', run_in_background: true,
    }, agent)
    expect(text(background)).toContain('pty-send-1')
    expect(Buffer.byteLength(text(background))).toBeLessThanOrEqual(64)
  })

  it('bounds terminal results after policy decisions and pipeline failures', async () => {
    const { ctx, agent } = await setup(false, { maxResultBytes: 64 })
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name === 'terminal_list') return { kind: 'deny', reason: 'd'.repeat(1_000) }
      if (exec.name === 'terminal_signal') throw new Error(`pre failed: ${'p'.repeat(1_000)}`)
      return next()
    })
    ctx.on('tools/execute', async (exec, next) => {
      if (exec.name === 'terminal_close') throw new Error(`around failed: ${'e'.repeat(1_000)}`)
      return next()
    })
    ctx.on('tools/post-execute', async (exec, _result, next) => {
      if (exec.name === 'terminal_open') {
        return { kind: 'accept', content: [{ type: 'text', text: 'a'.repeat(1_000) }] }
      }
      if (exec.name === 'terminal_read') {
        return { kind: 'block', feedback: [{ type: 'text', text: 'b'.repeat(1_000) }] }
      }
      if (exec.name === 'terminal_send') throw new Error(`post failed: ${'o'.repeat(1_000)}`)
      return next()
    })

    const denied = await call(ctx, 'terminal_list', {}, agent)
    expect(denied.isError).toBe(true)
    expect(Buffer.byteLength(text(denied))).toBeLessThanOrEqual(64)
    expect(text(denied)).toContain('[output truncated]')

    const replaced = await call(ctx, 'terminal_open', { type: 'stub' }, agent)
    expect(replaced.isError).toBe(false)
    expect(Buffer.byteLength(text(replaced))).toBeLessThanOrEqual(64)
    expect(text(replaced)).toContain('[output truncated]')

    const blocked = await call(ctx, 'terminal_read', { sessionId: 'pty-1' }, agent)
    expect(blocked.isError).toBe(true)
    expect(Buffer.byteLength(text(blocked))).toBeLessThanOrEqual(64)
    expect(text(blocked)).toContain('[output truncated]')

    const failures = [
      await call(ctx, 'terminal_signal', { sessionId: 'pty-1', signal: 'SIGINT' }, agent),
      await call(ctx, 'terminal_close', { sessionId: 'pty-1' }, agent),
      await call(ctx, 'terminal_send', { sessionId: 'pty-1', text: 'work' }, agent),
    ]
    for (const failure of failures) {
      expect(failure.isError).toBe(true)
      expect(Buffer.byteLength(text(failure))).toBeLessThanOrEqual(64)
      expect(text(failure)).toContain('[output truncated]')
    }
  })

  it('leaves a structured around-dispatch failure unchanged', async () => {
    const { ctx, agent } = await setup(false, { maxResultBytes: 64 })
    ctx.on('tools/execute', async (exec, next) => exec.name === 'terminal_list'
      ? { content: [], isError: true, error: { message: 'structured failure' } }
      : next())
    const result = await call(ctx, 'terminal_list', {}, agent)
    expect(result.isError).toBe(true)
    expect(result.content).toEqual([])
  })
})

describe('tool-terminal task integration', () => {
  it('registers a generic task and exposes incremental output', async () => {
    const { ctx, agent } = await setup(true)
    await call(ctx, 'terminal_open', { type: 'stub' }, agent)
    const started = await call(ctx, 'terminal_send', { sessionId: 'pty-1', text: 'build', run_in_background: true }, agent)
    expect(text(started)).toBe('started background job pty-send-1')
    expect(started).toMatchObject({ isError: false, value: { kind: 'background', jobId: 'pty-send-1' } })
    const output = await call(ctx, 'job_output', { job_id: 'pty-send-1', wait: true }, agent)
    expect(text(output)).toContain('live output')
    expect(text(output)).toContain('[status: completed, wait: stdin_read]')
  })

  it('bounds foreground and background results after terminal and task metadata', async () => {
    const { ctx, agent, stub } = await setup(true, { maxResultBytes: 64 })
    await call(ctx, 'terminal_open', { type: 'stub' }, agent)
    stub.sessions[0]!.viewport = '界'.repeat(100)
    const foreground = await call(ctx, 'terminal_send', { sessionId: 'pty-1', text: 'foreground' }, agent)
    expect(Buffer.byteLength(text(foreground))).toBeLessThanOrEqual(64)

    stub.sessions[0]!.delta = '界'.repeat(100)
    stub.sessions[0]!.deltaTruncated = true
    await call(ctx, 'terminal_send', { sessionId: 'pty-1', text: 'background', run_in_background: true }, agent)
    const background = await call(ctx, 'job_output', { job_id: 'pty-send-1', wait: true }, agent)
    expect(Buffer.byteLength(text(background))).toBeLessThanOrEqual(64)
    expect(text(background)).toContain('[status: completed')
    expect(text(background).match(/\[output truncated\]/g)).toHaveLength(1)
    expect(text(background)).toContain('[output truncated]\n[status: completed')
  })

  it('rejects pre-aborted background calls, maps job cancellation, and contains operation failure', async () => {
    const { ctx, agent, stub } = await setup(true)
    await call(ctx, 'terminal_open', { type: 'stub' }, agent)
    const controller = new AbortController()
    controller.abort()
    expect((await callWithSignal(ctx, 'terminal_send', { sessionId: 'pty-1', text: 'x', run_in_background: true }, agent, controller.signal)).isError).toBe(true)

    stub.sessions[0]!.autoSettle = false
    expect(text(await call(ctx, 'terminal_send', { sessionId: 'pty-1', text: '', run_in_background: true }, agent))).toContain('pty-send-1')
    expect(text(await call(ctx, 'job_kill', { job_id: 'pty-send-1' }, agent))).toContain('requested cancellation')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(text(await call(ctx, 'job_output', { job_id: 'pty-send-1' }, agent))).toContain('[status: killed')

    stub.sessions[0]!.rejectOperation = true
    stub.sessions[0]!.autoSettle = false
    expect(text(await call(ctx, 'terminal_send', { sessionId: 'pty-1', text: 'bad', run_in_background: true }, agent))).toContain('pty-send-2')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(text(await call(ctx, 'job_output', { job_id: 'pty-send-2' }, agent))).toContain('[status: failed')
  })

  it('reports foreground cancellation after the terminal operation settles', async () => {
    const { ctx, agent, stub } = await setup(false)
    await call(ctx, 'terminal_open', { type: 'stub' }, agent)
    stub.sessions[0]!.autoSettle = false
    const controller = new AbortController()
    const pending = callWithSignal(ctx, 'terminal_send', { sessionId: 'pty-1', text: 'sleep' }, agent, controller.signal)
    await Promise.resolve()
    controller.abort()
    stub.sessions[0]!.operation?.cancel()
    expect((await pending).isError).toBe(true)
  })

  it('renders the already-closing kill result', async () => {
    const { ctx, agent, stub } = await setup(false)
    await call(ctx, 'terminal_open', { type: 'stub' }, agent)
    stub.sessions[0]!.closeGate = Promise.withResolvers<undefined>()
    const first = ctx.terminals.kill(agent, TerminalSessionId('pty-1'))
    const second = call(ctx, 'terminal_close', { sessionId: 'pty-1' }, agent)
    stub.sessions[0]!.closeGate?.resolve(undefined)
    await first
    const result = await second
    expect(text(result)).toBe('terminal session pty-1 was already closing')
    expect(result).toMatchObject({ isError: false, value: { sessionId: 'pty-1', outcome: 'already-closing' } })
  })

  it('renders an exited session detail for background completion', async () => {
    const { ctx, agent, stub } = await setup(true)
    await call(ctx, 'terminal_open', { type: 'stub' }, agent)
    stub.sessions[0]!.statusValue = { kind: 'exited', exitCode: null, signal: null }
    await call(ctx, 'terminal_send', { sessionId: 'pty-1', text: 'exit', run_in_background: true }, agent)
    const output = await call(ctx, 'job_output', { job_id: 'pty-send-1', wait: true }, agent)
    expect(text(output)).toContain('session exited: unknown')
  })
})

describe('tool-terminal plugin shape', () => {
  it('is a named function plugin with no default export', () => {
    expect('default' in ToolPty).toBe(false)
    expect(ToolPty.name).toBe('tool-terminal')
    expect(ToolPty.inject).toEqual(['terminals', 'tools', 'systemPrompt'])
  })
})
