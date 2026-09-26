import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import type { JobId } from '@deepseek-ai/dsh-jobs'
import * as ToolTasks from '@deepseek-ai/dsh-tool-jobs'
import type { ShellExecution, ShellProcess } from '@deepseek-ai/dsh-shell'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { processSources, ringDelta } from '../src/background.ts'
import { renderPromoted } from '../src/render.ts'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'

// Readiness polling stays on wall time while a test controls the execution deadline.
const pollingTimeout = setTimeout

/** Empty offset readers for fakes that never produce output. */
const silentReader = { readFrom: (fromByte: number) => ({ text: '', nextOffset: fromByte, lossy: false }) }

const testToolSignal = new AbortController().signal
const spillDir = mkdtempSync(join(tmpdir(), 'dsh-tool-bash-background-spec-'))

/** Job harness with a fast registry pump for tests. */
async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry, { pumpPollMs: 25 })
  await ctx.plugin(ToolTasks)
  await ctx.plugin(LocalSubprocessRuntime)
  ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
  await ctx.plugin(BashEnvPlugin)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, graceMs: 200 })
  await ctx.plugin(ToolBash)
  return ctx
}

let callCounter = 0
function call(ctx: Context, args: Record<string, unknown>) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`background-call-${++callCounter}`),
    name: 'bash',
    arguments: args,
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

async function until<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value !== undefined) return value
    await new Promise(resolve => pollingTimeout(resolve, 20))
  }
  throw new Error('condition not reached before timeout')
}

function retainedText(ctx: Context, id: JobId, caller?: Agent): string {
  return ctx.jobs.readAt(id, 0, caller?.id).chunks.map(chunk => chunk.text).join('')
}

describe('background bash output', () => {
  it('streams a background run into the job ring with live output and settlement', async () => {
    const ctx = await setup()
    const ack = await call(ctx, {
      command: 'printf "line-1\\n"; sleep 0.4; printf "line-2\\n"',
      description: 'test command',
      run_in_background: true,
    })
    expect(text(ack)).toContain('started background job')
    const jobs = ctx.jobs
    const job = jobs.list()[0]
    expect(job).toBeDefined()

    // Live output appears in the ring while the command is still running.
    await until(() => retainedText(ctx, job!.id).includes('line-1') ? true : undefined)
    expect(jobs.get(job!.id).status).toBe('running')

    // Settlement ends the ring with the job; the trailing bytes are drained first.
    await until(() => jobs.get(job!.id).status === 'completed' ? true : undefined)
    expect(jobs.get(job!.id).detail).toBe('exit code: 0')
    expect(retainedText(ctx, job!.id)).toContain('line-2')

    // The model-facing consuming cursor reads the same bytes: observation stole nothing.
    const consumed = jobs.read(job!.id).chunks.map(chunk => chunk.text).join('')
    expect(consumed).toContain('line-1')
    expect(consumed).toContain('line-2')
  })

  it('a killed background job settles killed with the kill reason merged into its detail', async () => {
    const ctx = await setup()
    await call(ctx, { command: 'sleep 60', description: 'test command', run_in_background: true })
    const jobs = ctx.jobs
    const job = jobs.list()[0]
    jobs.kill(job!.id, undefined, 'test cleanup')
    await until(() => jobs.get(job!.id).status === 'killed' ? true : undefined)
    expect(jobs.get(job!.id).detail).toMatch(/(signal|killed before exit).*; test cleanup$/)
  })

  it('a background spawn failure reaches the model as the stderr note master rendered', async () => {
    const ctx = await setup()
    const started = await call(ctx, {
      command: 'true',
      description: 'test command',
      workdir: '/nonexistent-dsh',
      run_in_background: true,
    })
    expect(text(started)).toMatch(/^started background job bash-\d+$/)
    const jobs = ctx.jobs
    const job = jobs.list()[0]
    await until(() => jobs.get(job!.id).status === 'killed' ? true : undefined)
    const read = text(await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('background-spawn-failure-read'),
      name: 'job_output',
      arguments: { job_id: String(job!.id) },
    }))
    expect(read).toMatch(/^\[stderr\]\nsubprocess failed before reporting an outcome: .*\n\[status: killed, killed before exit\]$/s)
  })

  it('labels stderr chunks with their channel', async () => {
    const ctx = await setup()
    await call(ctx, {
      command: 'echo out-line; echo err-line 1>&2',
      description: 'test command',
      run_in_background: true,
    })
    const jobs = ctx.jobs
    const job = jobs.list()[0]
    await until(() => jobs.get(job!.id).status === 'completed' ? true : undefined)
    const chunks = jobs.readAt(job!.id, 0).chunks
    expect(chunks.find(chunk => chunk.text.includes('out-line'))?.channel).toBe('stdout')
    expect(chunks.find(chunk => chunk.text.includes('err-line'))?.channel).toBe('stderr')
  })
})

describe('processSources', () => {
  it('reads nothing while the process is not spawned yet', () => {
    const [stdout, stderr] = processSources(() => undefined)
    expect(stdout!.channel).toBe('stdout')
    expect(stderr!.channel).toBe('stderr')
    expect(stdout!.read(0)).toEqual({ text: '', nextOffset: 0, lossy: false })
    expect(stderr!.read(3)).toEqual({ text: '', nextOffset: 3, lossy: false })
  })

  it('forwards each read to the matching stream reader at its own offset once the process exists', () => {
    const reads: { channel: string; from: number }[] = []
    const reader = (channel: string, text: string): ShellProcess['observed']['stdout'] => ({
      readFrom: (from: number) => { reads.push({ channel, from }); return { text, nextOffset: from + text.length, lossy: false } },
    })
    const proc: Pick<ShellProcess, 'observed'> = { observed: { stdout: reader('stdout', 'out'), stderr: reader('stderr', 'err!') } }
    const [stdout, stderr] = processSources(() => proc)
    expect(stdout!.read(2)).toEqual({ text: 'out', nextOffset: 5, lossy: false })
    expect(stderr!.read(7)).toEqual({ text: 'err!', nextOffset: 11, lossy: false })
    expect(reads).toEqual([{ channel: 'stdout', from: 2 }, { channel: 'stderr', from: 7 }])
  })

  it("passes a lossy read's spill file through, so the model's notice can name it", () => {
    const proc: Pick<ShellProcess, 'observed'> = {
      observed: {
        stdout: { readFrom: (from: number) => ({ text: '', nextOffset: from, lossy: false }) },
        stderr: { readFrom: (from: number) => ({ text: 'tail', nextOffset: from + 4, lossy: true, spillPath: '/spill/err.log' }) },
      },
    }
    const [, stderr] = processSources(() => proc)
    expect(stderr!.read(0)).toEqual({ text: 'tail', nextOffset: 4, lossy: true, spillPath: '/spill/err.log' })
  })

})

describe('ringDelta', () => {
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

describe('foreground commands as jobs', () => {
  it('keeps a timed-out foreground command running as its job, handing over the output so far', async ({ task }) => {
    const ctx = await setup()
    const execute = ctx.shell.execute.bind(ctx.shell)
    let execution: ShellExecution | undefined
    const capture = vi.spyOn(ctx.shell, 'execute').mockImplementation(async (spec) => {
      execution = await execute(spec)
      return execution
    })
    try {
      // Process startup can exceed the deadline under load. Deliver the first
      // line before advancing the wait so this case proves the output split.
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const pending = call(ctx, {
        command: 'printf "early-output\\n"; sleep 30',
        description: 'test command',
        timeoutMs: 250,
      })
      await until(() => execution?.observed.stdout.readFrom(0).text.includes('early-output') ? true : undefined, task.timeout)
      // The job exists from the start: the command is listed while the call still waits.
      expect(ctx.jobs.list()[0]).toMatchObject({ id: 'bash-1', kind: 'bash', status: 'running', label: 'printf "early-output\\n"; sleep 30' })
      await vi.advanceTimersByTimeAsync(250)
      const result = await pending
      vi.useRealTimers()
      const body = text(result)
      expect(body).toContain('early-output')
      expect(body).toContain('[still running after 250ms; moved to background job bash-1]')
      expect(body).toContain('read newer output with job_output, stop it with job_kill')
      expect(body.indexOf('early-output')).toBeLessThan(body.indexOf('[still running'))

      const jobs = ctx.jobs
      const job = jobs.list()[0]
      expect(job).toMatchObject({ id: 'bash-1', status: 'running' })
      // The hand-over was one consuming read: the next read repeats nothing.
      expect(jobs.read(job!.id).chunks).toEqual([])
      expect(jobs.kill(job!.id, undefined, 'test cleanup')).toBe('requested')
      await until(() => jobs.get(job!.id).status === 'killed' ? true : undefined)
      // Observers still see the whole stream from offset 0.
      expect(retainedText(ctx, job!.id)).toContain('early-output')
    } finally {
      vi.useRealTimers()
      capture.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it('a command that finishes within the wait returns the foreground result and leaves no job behind', async () => {
    const ctx = await setup()
    const seen: string[] = []
    ctx.jobs.events.subscribe({ owners: 'all' }, (event) => { seen.push(event.type === 'settled' ? `settled:${String(event.awaited)}` : event.type) })
    const result = await call(ctx, { command: 'printf "done\\n"; printf "warn\\n" >&2', description: 'test command' })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a foreground result')
    expect(result.value).toMatchObject({ kind: 'foreground', exitCode: 0, stdout: { text: 'done\n' }, stderr: { text: 'warn\n' } })
    expect(text(result)).toBe('done\n[stderr]\nwarn\n')
    expect(ctx.jobs.list()).toEqual([])
    // Registered at the start, settled while awaited, removed with the result.
    expect(seen.filter(type => type !== 'output')).toEqual(['registered', 'settled:true', 'removed'])
  })

  it('a foreground command stopped from outside the call reports the reason instead of failing', async ({ task }) => {
    const ctx = await setup()
    const pending = call(ctx, { command: 'sleep 30', description: 'test command' })
    const job = await until(() => ctx.jobs.list()[0], task.timeout)
    expect(ctx.jobs.kill(job.id, undefined, 'cancelled by the user')).toBe('requested')
    const result = await pending
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a foreground result')
    expect(result.value).toMatchObject({ kind: 'foreground', signal: 'SIGTERM', stopped: 'cancelled by the user' })
    expect(text(result)).toBe('(no output)\n[stopped: cancelled by the user]\n[killed by signal: SIGTERM]')
    expect(ctx.jobs.list()).toEqual([])
  })

  it('a command whose start fails reports the failure as an error result and leaves no job behind', async () => {
    const ctx = await setup()
    vi.spyOn(ctx.shell, 'execute').mockRejectedValue(new Error('spawn bash ENOENT'))
    const result = await call(ctx, { command: 'true', description: 'test command' })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Error: spawn bash ENOENT')
    expect(ctx.jobs.list()).toEqual([])
  })

  it('cancelling the call kills its job, waits for it to settle, and reports the structured abort', async ({ task }) => {
    const ctx = await setup()
    const seen: string[] = []
    ctx.jobs.events.subscribe({ owners: 'all' }, (event) => {
      if (event.type === 'settled') seen.push(`settled:${event.job.status}:${event.job.detail ?? ''}:${String(event.awaited)}`)
      else if (event.type !== 'output') seen.push(event.type)
    })
    const controller = new AbortController()
    const pending = ctx.tools.execute({
      signal: controller.signal,
      callId: ToolCallId('background-call-aborted'),
      name: 'bash',
      arguments: { command: 'sleep 30', description: 'test command' },
    })
    await until(() => ctx.jobs.list()[0], task.timeout)
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ message: 'tool call aborted', info: { name: 'AbortError', code: TOOL_ABORTED } })
    // The kill is this call's own: the settlement was awaited (so no notice
    // follows the abort the result already carries) and the record left.
    expect(seen).toEqual(['registered', 'stopping', 'settled:killed:signal: SIGTERM; tool call aborted:true', 'removed'])
    expect(ctx.jobs.list()).toEqual([])
  })

  it('leaves the job listed when its process outlives the abort wait, so a later settlement still notifies', async () => {
    const ctx = await setup()
    let finish: () => void = () => {}
    const stubborn: ShellExecution = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: new Promise<void>((resolve) => { finish = () => { stubborn.status = 'killed'; stubborn.signal = 'SIGKILL'; resolve() } }),
      readOutput: () => ({ delta: '', lossy: false }),
      observed: { stdout: silentReader, stderr: silentReader },
      kill: () => true, // acknowledges the request but takes its time
      result: () => Promise.reject(new Error('foreground projection unused')),
    }
    vi.spyOn(ctx.shell, 'execute').mockResolvedValue(stubborn)
    const controller = new AbortController()
    const pending = ctx.tools.execute({
      signal: controller.signal,
      callId: ToolCallId('background-call-aborted-slow-kill'),
      name: 'bash',
      arguments: { command: 'sleep 30', description: 'test command', timeoutMs: 100 },
    })
    const job = await until(() => ctx.jobs.list()[0])
    controller.abort()
    const result = await pending
    expect(result.isError).toBe(true)
    expect(ctx.jobs.get(job.id).status).toBe('stopping')
    finish()
    await until(() => ctx.jobs.get(job.id).status === 'killed' ? true : undefined)
  })

  it('a wait that expires before the process spawned ends as the preparation timeout, not a hand-over', async () => {
    const ctx = await setup()
    // Preparation that only ends with the job's own cancellation.
    vi.spyOn(ctx.shell, 'execute').mockImplementation(spec => new Promise((_resolve, reject) => {
      spec.signal?.addEventListener('abort', () => { reject(new Error('fixture preparation aborted')) }, { once: true })
    }))
    const result = await call(ctx, { command: 'sleep 30', description: 'test command', timeoutMs: 250 })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a foreground result')
    expect(result.value).toMatchObject({ kind: 'foreground', exitCode: null, signal: null, timedOut: true, aborted: false, timeoutMs: 250 })
    expect(text(result)).toBe('(no output)\n[timed out after 250ms]\n[exit code: null]')
    expect(ctx.jobs.list()).toEqual([])
  })

  it('registers the job under the calling agent so it is fenced to its session', async () => {
    const ctx = await setup()
    const ownerId = SessionId('promote-owner')
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
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('background-promote-owned'),
      name: 'bash',
      arguments: { command: 'printf "held\\n"; sleep 30', description: 'test command', timeoutMs: 250 },
      agent: owner,
    })
    expect(text(result)).toContain('moved to background job')
    const owned = ctx.jobs
    const job = owned.list(owner.id)[0]
    expect(job).toBeDefined()
    expect(job!.owner).toBe(owner.id)
    expect(() => ctx.jobs.readAt(job!.id, 0)).toThrow(/belongs to another session/)
    expect(owned.kill(job!.id, owner.id, 'test cleanup')).toBe('requested')
    await until(() => owned.get(job!.id, owner.id).status === 'killed' ? true : undefined)
  })

  it('runs under the deadline kill when the registry refuses the job at its start', async () => {
    const ctx = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    // Saturate the per-owner admission budget with unowned running jobs.
    const limit = 10
    const settlers: Array<(outcome: { status: 'killed' }) => void> = []
    for (let i = 0; i < limit; i++) {
      ctx.jobs.start({
        kind: 'bash',
        label: `filler-${i}`,
        run: () => {
          let settle!: (outcome: { status: 'killed' }) => void
          const done = new Promise<{ status: 'killed' }>((resolve) => { settle = resolve })
          settlers.push(settle)
          return { cancel: () => { settle({ status: 'killed' }) }, done }
        },
      })
    }
    const result = await call(ctx, {
      command: 'sleep 30',
      description: 'test command',
      timeoutMs: 250,
    })
    const body = text(result)
    expect(body).toContain('[timed out after 250ms]')
    expect(body).not.toContain('moved to background job')
    expect(warn.mock.calls.map(args => String(args[0])).join('\n')).toContain('job registration refused')
    expect(ctx.jobs.list()).toHaveLength(limit)
    for (const settle of settlers) settle({ status: 'killed' })
  })

  it('keeps the plain timeout kill when keeping timed-out commands is configured off', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(LocalJobRegistry, { pumpPollMs: 25 })
    await ctx.plugin(ToolTasks)
    await ctx.plugin(LocalSubprocessRuntime)
    ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
    await ctx.plugin(BashEnvPlugin)
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000, graceMs: 200 })
    await ctx.plugin(ToolBash, { promoteOnTimeout: false })
    const seen: string[] = []
    ctx.jobs.events.subscribe({ owners: 'all' }, (event) => { seen.push(event.type) })
    const result = await call(ctx, { command: 'sleep 30', description: 'test command', timeoutMs: 250 })
    expect(text(result)).toContain('[timed out after 250ms]')
    expect(ctx.jobs.list()).toEqual([])
    expect(seen).toEqual([])
    const parameters = JSON.stringify(ctx.tools.get('bash')?.parameters)
    expect(parameters).not.toContain('moves to the background')
    expect(parameters).toContain('run_in_background')
  })

  it('advertises the hand-over semantics in the timeout parameter', async () => {
    const ctx = await setup()
    const tool = ctx.tools.get('bash')
    expect(JSON.stringify(tool?.parameters)).toContain('moves to the background as a job instead of being killed')
  })
})

describe('renderPromoted', () => {
  it('pins the promoted text with and without pre-promotion output', () => {
    expect(renderPromoted({ jobId: 'bash-7', timeoutMs: 120_000, output: '' })).toBe(
      '[still running after 120000ms; moved to background job bash-7]\n'
      + 'The command keeps running in the background. You will be notified when it finishes; '
      + 'read newer output with job_output, stop it with job_kill.',
    )
    // A partial line gains the separating newline exactly once.
    expect(renderPromoted({ jobId: 'bash-7', timeoutMs: 250, output: 'partial' }))
      .toContain('partial\n[still running after 250ms; moved to background job bash-7]')
    expect(renderPromoted({ jobId: 'bash-7', timeoutMs: 250, output: 'line\n' }))
      .toContain('line\n[still running after 250ms')
  })
})

describe('owned background output', () => {
  it('fences an owned background run under the owning session', async () => {
    const ctx = await setup()
    const ownerId = SessionId('background-owner')
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
    await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('background-owned-1'),
      name: 'bash',
      arguments: { command: 'echo owned', description: 'test command', run_in_background: true },
      agent: owner,
    })
    const owned = ctx.jobs
    const job = owned.list(owner.id)[0]
    expect(job).toBeDefined()
    expect(job!.owner).toBe(owner.id)
    await until(() => owned.get(job!.id, owner.id).status === 'completed' ? true : undefined)
    expect(() => retainedText(ctx, job!.id)).toThrow(/belongs to another session/)
    await until(() => retainedText(ctx, job!.id, owner).includes('owned') ? true : undefined)
  })
})
