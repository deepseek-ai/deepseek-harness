import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session/types'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolTasks from '@deepseek-ai/dsh-tool-jobs'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellExecution, ShellProcess } from '@deepseek-ai/dsh-shell'
import { renderPwshPromoted } from '../src/render.ts'
import * as ToolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import { processSources, ringDelta } from '../src/background.ts'

const testToolSignal = new AbortController().signal

/** ASCII-only scripted stream: readFrom offsets are byte-exact string indexes. */
function scriptedReader(state: { text: string }) {
  return {
    readFrom(fromByte: number) {
      return { text: state.text.slice(fromByte), nextOffset: state.text.length, lossy: false }
    },
  }
}

/** A running fake background handle over scripted non-consuming observed streams. */
function observableProcess(streams: { stdout: { text: string }; stderr: { text: string } } = { stdout: { text: '' }, stderr: { text: '' } }) {
  let resolveDone: () => void = () => {}
  const done = new Promise<void>((resolve) => { resolveDone = resolve })
  const proc: ShellProcess = {
    status: 'running',
    exitCode: null,
    signal: null,
    done,
    readOutput: () => ({ delta: '', lossy: false }),
    kill: () => false,
    observed: { stdout: scriptedReader(streams.stdout), stderr: scriptedReader(streams.stderr) },
  }
  return {
    proc,
    finish() {
      proc.status = 'completed'
      proc.exitCode = 0
      resolveDone()
    },
  }
}

class FakePwsh extends ShellExecutor {
  /** Scripts every `none` execution: a background start, or a foreground call registered as a job. */
  backgroundHandler: (spec: ShellExecSpec) => ShellProcess | ShellExecution = () => { throw new Error('unscripted start') }
  /** Scripts the deadline-killed foreground path (`kill`), which no job wraps. */
  foregroundHandler: (spec: ShellExecSpec) => ShellExecution = () => { throw new Error('foreground is not exercised here') }

  override resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? process.cwd(),
      timeoutMs: request.timeoutMs ?? 60_000,
      onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      ...request.signal ? { signal: request.signal } : {},
      ...request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {},
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    if (spec.onExpiry !== 'none') return this.foregroundHandler(spec)
    // Augment the scripted handle in place: the scenarios mutate the original
    // object (finish()), so a spread copy would freeze its lifecycle.
    const proc = this.backgroundHandler(spec)
    return 'result' in proc ? proc : Object.assign(proc, {
      result: () => Promise.reject(new Error('foreground projection unused')),
    })
  }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry, { pumpPollMs: 5 })
  await ctx.plugin(ToolTasks)
  await ctx.plugin(BashEnvPlugin)
  await ctx.plugin(FakePwsh)
  await ctx.plugin(ToolPwsh)
  return { ctx, pwsh: ctx.shell as FakePwsh }
}

let callCounter = 0
function call(ctx: Context, args: Record<string, unknown>) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`pwsh-background-${++callCounter}`),
    name: 'pwsh',
    arguments: args,
  })
}

async function until<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition not reached before timeout')
}

describe('background pwsh output', () => {
  it('streams observed channels into the job ring and settles with the mapped outcome', async () => {
    const { ctx, pwsh } = await setup()
    const stdout = { text: '' }
    const stderr = { text: '' }
    const scripted = observableProcess({ stdout, stderr })
    pwsh.backgroundHandler = () => scripted.proc

    await call(ctx, { command: 'Get-Progress', description: 'test command', run_in_background: true })
    const jobs = ctx.jobs
    const job = jobs.list()[0]
    expect(job).toBeDefined()
    expect(job!.kind).toBe('pwsh')
    expect(job!.output).toEqual({ total: 0, earliest: 0 })

    stdout.text = 'progress-line\n'
    stderr.text = 'warn-line\n'
    await until(() => {
      const chunks = jobs.readAt(job!.id, 0).chunks
      return chunks.some(chunk => chunk.text.includes('progress-line'))
        && chunks.some(chunk => chunk.text.includes('warn-line'))
        ? true
        : undefined
    })
    const chunks = jobs.readAt(job!.id, 0).chunks
    expect(chunks.find(chunk => chunk.text.includes('progress-line'))?.channel).toBe('stdout')
    expect(chunks.find(chunk => chunk.text.includes('warn-line'))?.channel).toBe('stderr')

    scripted.finish()
    await until(() => jobs.get(job!.id).status === 'completed' ? true : undefined)
    expect(jobs.get(job!.id).detail).toBe('exit code: 0')
  })

  it('a failing reader warns once and never fakes a terminal state onto the running job', async () => {
    const { ctx, pwsh } = await setup()
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    let resolveDone: () => void = () => {}
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    const proc: ShellProcess = {
      status: 'running',
      exitCode: null,
      signal: null,
      done,
      readOutput: () => ({ delta: '', lossy: false }),
      kill: () => false,
      observed: {
        stdout: { readFrom() { throw new Error('reader boom') } },
        stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
      },
    }
    pwsh.backgroundHandler = () => proc
    await call(ctx, { command: 'Get-Broken', description: 'test command', run_in_background: true })
    const jobs = ctx.jobs
    const job = jobs.list()[0]
    await until(() => warn.mock.calls.some(args => String(args[0]).includes('output source for')) ? true : undefined)
    // The reader already failed; the job must wait for real settlement rather
    // than freezing a fake terminal state onto the running process.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(jobs.get(job!.id).status).toBe('running')
    expect(warn).toHaveBeenCalledTimes(1)
    proc.status = 'completed'
    proc.exitCode = 0
    resolveDone()
    await until(() => jobs.get(job!.id).status !== 'running' ? true : undefined)
    expect(jobs.get(job!.id)).toMatchObject({ status: 'completed', detail: 'exit code: 0' })
  })

  it('a silent process settles with an empty ring', async () => {
    const { ctx, pwsh } = await setup()
    const scripted = observableProcess()
    pwsh.backgroundHandler = () => scripted.proc

    await call(ctx, { command: 'Start-Job', description: 'test command', run_in_background: true })
    const jobs = ctx.jobs
    const job = jobs.list()[0]
    expect(jobs.readAt(job!.id, 0).chunks).toEqual([])

    scripted.finish()
    await until(() => jobs.get(job!.id).status === 'completed' ? true : undefined)
    expect(jobs.get(job!.id).output).toEqual({ total: 0, earliest: 0 })
  })
})

describe('owned background output (pwsh)', () => {
  it('keeps an owned background run under the owning session', async () => {
    const { ctx, pwsh } = await setup()
    const ownerId = SessionId('pwsh-background-owner')
    const owner: Agent = {
      id: ownerId,
      options: {},
      session: Session.create(ownerId, undefined, {
        version: SESSION_FORMAT_VERSION, id: ownerId, createdAt: 0, cwd: process.cwd(), isSeeded: false,
      }),
      inbox: unsupportedInbox(),
      status: 'idle',
      ctx,
      send: () => {},
      followup: () => {},
      steer: () => {},
      inject: () => {},
      cancel: () => {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    ctx.agents.register(owner)
    const scripted = observableProcess()
    pwsh.backgroundHandler = () => scripted.proc
    await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('pwsh-background-owned'),
      name: 'pwsh',
      arguments: { command: 'Get-Slow', description: 'test command', run_in_background: true },
      agent: owner,
    })
    const owned = ctx.jobs
    const job = owned.list(owner.id)[0]
    expect(job).toBeDefined()
    expect(job!.owner).toBe(owner.id)
    expect(() => ctx.jobs.readAt(job!.id, 0)).toThrow(/belongs to another session/)
    expect(owned.readAt(job!.id, 0, owner.id).chunks).toEqual([])
    scripted.finish()
    await until(() => owned.get(job!.id, owner.id).status === 'completed' ? true : undefined)
  })
})

describe('foreground commands as jobs (pwsh)', () => {
  /** A scriptable running execution whose observed stdout already holds `partial`. */
  function runningExecution(partial: string) {
    let resolveDone: () => void = () => {}
    let killed = false
    const proc: ShellExecution = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: new Promise<void>((resolve) => { resolveDone = resolve }),
      readOutput: () => ({ delta: '', lossy: false }),
      observed: { stdout: scriptedReader({ text: partial }), stderr: scriptedReader({ text: '' }) },
      kill: () => {
        if (proc.status !== 'running') return false
        killed = true
        proc.status = 'killed'
        proc.signal = 'SIGTERM'
        resolveDone()
        return true
      },
      result: () => proc.done.then(() => ({
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: false,
        aborted: killed,
        timeoutMs: 250,
        stdout: { text: partial, truncated: false },
        stderr: { text: '', truncated: false },
      })),
    }
    const finish = (): void => {
      if (proc.status !== 'running') return
      proc.status = 'completed'
      proc.exitCode = 0
      resolveDone()
    }
    return { proc, finish, killed: () => killed }
  }

  it('keeps a timed-out command running as its job, handing over the output so far', async () => {
    const { ctx, pwsh } = await setup()
    const scripted = runningExecution('early-output\n')
    pwsh.backgroundHandler = () => scripted.proc

    const result = await call(ctx, { command: 'Get-Slow', description: 'test command', timeoutMs: 250 })
    const body = (result.content[0] as { text: string }).text
    expect(body).toContain('early-output')
    expect(body).toContain('moved to background job pwsh-1]')
    expect(body).toContain('read newer output with job_output, stop it with job_kill')

    const jobs = ctx.jobs
    const job = jobs.list()[0]
    expect(job).toMatchObject({ id: 'pwsh-1', kind: 'pwsh', status: 'running' })
    // The hand-over was one consuming read: the next read repeats nothing.
    expect(jobs.read(job!.id).chunks).toEqual([])
    scripted.finish()
    await until(() => jobs.get(job!.id).status === 'completed' ? true : undefined)
  })

  it('a command that finishes within the wait returns the foreground result and leaves no job behind', async () => {
    const { ctx, pwsh } = await setup()
    const scripted = runningExecution('done\n')
    pwsh.backgroundHandler = () => {
      queueMicrotask(() => { scripted.finish() })
      return scripted.proc
    }
    const seen: string[] = []
    ctx.jobs.events.subscribe({ owners: 'all' }, (event) => { seen.push(event.type === 'settled' ? `settled:${String(event.awaited)}` : event.type) })
    const result = await call(ctx, { command: 'Get-Quick', description: 'test command', timeoutMs: 5_000 })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a foreground result')
    expect(result.value).toMatchObject({ kind: 'foreground', exitCode: 0, stdout: { text: 'done\n' } })
    expect((result.content[0] as { text: string }).text).toBe('done\n')
    expect(ctx.jobs.list()).toEqual([])
    expect(seen.filter(type => type !== 'output')).toEqual(['registered', 'settled:true', 'removed'])
  })

  it('a foreground command stopped from outside the call reports the reason instead of failing', async () => {
    const { ctx, pwsh } = await setup()
    const scripted = runningExecution('')
    pwsh.backgroundHandler = () => scripted.proc
    const pending = call(ctx, { command: 'Get-Slow', description: 'test command', timeoutMs: 5_000 })
    const job = await until(() => ctx.jobs.list()[0])
    expect(ctx.jobs.kill(job.id, undefined, 'cancelled by the user')).toBe('requested')
    const result = await pending
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a foreground result')
    expect(scripted.killed()).toBe(true)
    expect(result.value).toMatchObject({ kind: 'foreground', signal: 'SIGTERM', stopped: 'cancelled by the user' })
    expect((result.content[0] as { text: string }).text).toBe('(no output)\n[stopped: cancelled by the user]\n[killed by signal: SIGTERM]')
    expect(ctx.jobs.list()).toEqual([])
  })

  it('a command whose start fails reports the failure as an error result and leaves no job behind', async () => {
    const { ctx, pwsh } = await setup()
    pwsh.backgroundHandler = () => { throw new Error('spawn pwsh ENOENT') }
    const result = await call(ctx, { command: 'Get-Missing', description: 'test command' })
    expect(result.isError).toBe(true)
    expect((result.content[0] as { text: string }).text).toBe('Error: spawn pwsh ENOENT')
    expect(ctx.jobs.list()).toEqual([])
  })

  it('cancelling the call kills its job and reports the structured abort', async () => {
    const { ctx, pwsh } = await setup()
    const scripted = runningExecution('')
    pwsh.backgroundHandler = () => scripted.proc
    const controller = new AbortController()
    const pending = ctx.tools.execute({
      signal: controller.signal,
      callId: ToolCallId('pwsh-call-aborted'),
      name: 'pwsh',
      arguments: { command: 'Get-Slow', description: 'test command', timeoutMs: 5_000 },
    })
    await until(() => ctx.jobs.list()[0])
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ message: 'tool call aborted', info: { name: 'AbortError', code: TOOL_ABORTED } })
    expect(scripted.killed()).toBe(true)
    // The kill is this call's own: the settlement was awaited and the record left.
    expect(ctx.jobs.list()).toEqual([])
  })

  it('leaves the job listed when its process outlives the abort wait, so a later settlement still notifies', async () => {
    const { ctx, pwsh } = await setup()
    const scripted = runningExecution('')
    // Acknowledge the kill without settling; the test settles it afterwards.
    scripted.proc.kill = () => true
    pwsh.backgroundHandler = () => scripted.proc
    const controller = new AbortController()
    const pending = ctx.tools.execute({
      signal: controller.signal,
      callId: ToolCallId('pwsh-call-aborted-slow-kill'),
      name: 'pwsh',
      arguments: { command: 'Get-Slow', description: 'test command', timeoutMs: 100 },
    })
    const job = await until(() => ctx.jobs.list()[0])
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(ctx.jobs.get(job.id).status).toBe('stopping')
    scripted.finish()
    await until(() => ctx.jobs.get(job.id).status === 'completed' ? true : undefined)
  })

  it('a wait that expires before the process spawned ends as the preparation timeout, not a hand-over', async () => {
    const { ctx, pwsh } = await setup()
    pwsh.backgroundHandler = () => { throw new Error('unreachable: preparation never finishes') }
    vi.spyOn(pwsh, 'execute').mockImplementation(spec => new Promise((_resolve, reject) => {
      spec.signal?.addEventListener('abort', () => { reject(new Error('fixture preparation aborted')) }, { once: true })
    }))
    const result = await call(ctx, { command: 'Get-Slow', description: 'test command', timeoutMs: 250 })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a foreground result')
    expect(result.value).toMatchObject({ kind: 'foreground', exitCode: null, signal: null, timedOut: true, aborted: false, timeoutMs: 250 })
    expect((result.content[0] as { text: string }).text).toBe('(no output)\n[timed out after 250ms]\n[exit code: null]')
    expect(ctx.jobs.list()).toEqual([])
  })

  it('registers the job under the calling agent and stops it through the registry kill', async () => {
    const { ctx, pwsh } = await setup()
    const ownerId = SessionId('pwsh-promote-owner')
    const owner: Agent = {
      id: ownerId,
      options: {},
      session: Session.create(ownerId, undefined, {
        version: SESSION_FORMAT_VERSION, id: ownerId, createdAt: 0, cwd: process.cwd(), isSeeded: false,
      }),
      inbox: unsupportedInbox(),
      status: 'idle',
      ctx,
      send: () => {},
      followup: () => {},
      steer: () => {},
      inject: () => {},
      cancel: () => {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    ctx.agents.register(owner)
    const scripted = runningExecution('')
    pwsh.backgroundHandler = () => scripted.proc

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('pwsh-observe-promote-owned'),
      name: 'pwsh',
      arguments: { command: 'Get-Slow', description: 'test command', timeoutMs: 250 },
      agent: owner,
    })
    expect((result.content[0] as { text: string }).text).toContain('moved to background job')
    const owned = ctx.jobs
    const job = owned.list(owner.id)[0]
    expect(job).toBeDefined()
    expect(job!.owner).toBe(owner.id)

    expect(owned.kill(job!.id, owner.id, 'test cleanup')).toBe('requested')
    await until(() => scripted.killed() ? true : undefined)
    const settled = await until(() => {
      const view = owned.get(job!.id, owner.id)
      return view.status === 'killed' ? view : undefined
    })
    expect(settled.detail).toBe('signal: SIGTERM; test cleanup')
  })

  it('runs under the deadline kill when no job controller serves the owner', async () => {
    // The same composition minus dsh-tool-jobs: the registry exists, so the
    // job-backed variant is registered, but admission refuses at the start
    // and the call runs under the executor's deadline instead.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(BashEnvPlugin)
    await ctx.plugin(FakePwsh)
    await ctx.plugin(ToolPwsh)
    const pwsh = ctx.shell as FakePwsh
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const specs: ShellExecSpec[] = []
    pwsh.foregroundHandler = (spec) => {
      specs.push(spec)
      const scripted = runningExecution('')
      return Object.assign(scripted.proc, {
        result: () => Promise.resolve({
          exitCode: 1,
          signal: null,
          timedOut: true,
          aborted: false,
          timeoutMs: 250,
          stdout: { text: '', truncated: false },
          stderr: { text: '', truncated: false },
        }),
      })
    }

    const result = await call(ctx, { command: 'Get-Slow', description: 'test command', timeoutMs: 250 })
    const body = (result.content[0] as { text: string }).text
    expect(body).toContain('[timed out after 250ms]')
    expect(body).not.toContain('moved to background job')
    expect(specs[0]?.onExpiry).toBe('kill')
    expect(warn.mock.calls.map(args => String(args[0])).join('\n')).toContain('job registration refused')
    expect(ctx.jobs.list()).toEqual([])
  })

  it('keeps the kill deadline and the plain timeout parameter when keeping timed-out commands is off', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(ToolTasks)
    await ctx.plugin(BashEnvPlugin)
    await ctx.plugin(FakePwsh)
    await ctx.plugin(ToolPwsh, { promoteOnTimeout: false })
    const pwsh = ctx.shell as FakePwsh
    const specs: ShellExecSpec[] = []
    pwsh.foregroundHandler = (spec) => {
      specs.push(spec)
      const scripted = runningExecution('')
      return Object.assign(scripted.proc, {
        result: () => Promise.resolve({
          exitCode: 1,
          signal: null,
          timedOut: true,
          aborted: false,
          timeoutMs: 250,
          stdout: { text: '', truncated: false },
          stderr: { text: '', truncated: false },
        }),
      })
    }
    const result = await call(ctx, { command: 'Get-Slow', description: 'test command', timeoutMs: 250 })
    expect((result.content[0] as { text: string }).text).toContain('[timed out after 250ms]')
    expect(specs[0]?.onExpiry).toBe('kill')
    expect(ctx.jobs.list()).toEqual([])
    const parameters = JSON.stringify(ctx.tools.get('pwsh')?.parameters)
    expect(parameters).not.toContain('moves to the background')
    expect(parameters).toContain('run_in_background')
  })

  it('advertises the hand-over semantics in the timeout parameter', async () => {
    const { ctx } = await setup()
    const tool = ctx.tools.get('pwsh')
    expect(JSON.stringify(tool?.parameters)).toContain('moves to the background as a job instead of being killed')
  })
})

describe('renderPwshPromoted', () => {
  it('pins the promoted text with and without pre-promotion output', () => {
    expect(renderPwshPromoted({ jobId: 'pwsh-7', timeoutMs: 120_000, output: '' })).toBe(
      '[still running after 120000ms; moved to background job pwsh-7]\n'
      + 'The command keeps running in the background. You will be notified when it finishes; '
      + 'read newer output with job_output, stop it with job_kill.',
    )
    expect(renderPwshPromoted({ jobId: 'pwsh-7', timeoutMs: 250, output: 'partial' }))
      .toContain('partial\n[still running after 250ms; moved to background job pwsh-7]')
    expect(renderPwshPromoted({ jobId: 'pwsh-7', timeoutMs: 250, output: 'line\n' }))
      .toContain('line\n[still running after 250ms')
  })
})

describe('ringDelta (pwsh)', () => {
  it('renders stdout chunks in order and every stderr chunk in one trailing section', () => {
    expect(ringDelta([])).toBe('')
    expect(ringDelta([
      { at: 0, text: 'a\n', channel: 'stdout' },
      { at: 2, text: 'warn\n', channel: 'stderr' },
      { at: 7, text: 'b', channel: 'stdout' },
    ])).toBe('a\nb\n[stderr]\nwarn\n')
    expect(ringDelta([{ at: 0, text: 'only\n', channel: 'stderr' }])).toBe('[stderr]\nonly\n')
  })
})

describe('processSources (pwsh)', () => {
  it('reads nothing while the process is not spawned yet', () => {
    const [stdout, stderr] = processSources(() => undefined)
    expect(stdout!.channel).toBe('stdout')
    expect(stderr!.channel).toBe('stderr')
    expect(stdout!.read(0)).toEqual({ text: '', nextOffset: 0, lossy: false })
    expect(stderr!.read(3)).toEqual({ text: '', nextOffset: 3, lossy: false })
  })
})
