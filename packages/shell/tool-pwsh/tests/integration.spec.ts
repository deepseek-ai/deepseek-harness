/**
 * Integration tests: the REAL `@deepseek-ai/dsh-pwsh-local` executor plus the
 * `pwsh` tool, exercised through `ctx.tools.execute()` with a real PowerShell
 * process. These verify the world — actual commands run, stdout/stderr come
 * back, exit codes render, timeouts abort, background jobs settle through the
 * generic job runtime, and per-session cwd resolution works. The suite
 * self-skips when no usable `pwsh` resolves (a CI accommodation for hosts without
 * PowerShell); the fake-executor suite (tools.spec.ts) carries the coverage
 * gate.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { TOOL_ABORTED } from '@deepseek-ai/dsh-tools'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as ToolJobs from '@deepseek-ai/dsh-tool-jobs'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { PwshLocalExecutor, resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'
import * as ToolPwsh from '@deepseek-ai/dsh-tool-pwsh'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'

const testToolSignal = new AbortController().signal

// The probe follows the executor's own resolution (Program Files installs on
// Windows are found even when bare `pwsh` is not on PATH).
const hasPwsh = spawnSync(resolvePwshPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'], { encoding: 'utf8' }).status === 0

/** Normalize PowerShell's platform line endings (CRLF on Windows, LF elsewhere). */
const lf = (text: string): string => text.replace(/\r\n/g, '\n')

let dir: string
let ctx: Context

let callCounter = 0
function call(name: string, args: unknown, agentObj?: object, signal?: AbortSignal) {
  return ctx.tools.execute({
    signal: signal ?? testToolSignal,
    callId: ToolCallId(`it-${++callCounter}`),
    name,
    arguments: args,
    ...agentObj ? { agent: agentObj as never } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe.skipIf(!hasPwsh)('pwsh tool over the real pwsh executor', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-tool-pwsh-'))
    await writeFile(join(dir, 'greeting.txt'), 'hello pwsh\n')

    ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalJobRegistry)
    await ctx.plugin(ToolJobs)
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(BashEnvPlugin)
    await ctx.plugin(PwshLocalExecutor, { timeoutMs: 20_000, graceMs: 200 })
    await ctx.plugin(ToolPwsh)
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const agent = () => ({ session: { header: { id: 'session-int', cwd: dir } } })

  it('runs a command and returns stdout with no marker on a clean exit', async () => {
    const result = await call('pwsh', { command: 'Write-Output hi', description: 'say hi' }, agent())
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected pwsh success')
    expect(result.value).toMatchObject({ kind: 'foreground', exitCode: 0 })
    expect(lf(text(result))).toBe('hi\n')
  })

  it('returns stderr in a marked section and a nonzero exit as a marker, not an error', async () => {
    const result = await call('pwsh', {
      command: '[Console]::Error.WriteLine("boom"); exit 3',
      description: 'fail loudly',
    }, agent())
    expect(result.isError).toBe(false)
    expect(lf(text(result))).toBe('[stderr]\nboom\n[exit code: 3]')
  })

  it('resolves relative paths in the session workspace', async () => {
    const result = await call('pwsh', {
      command: 'Get-Content greeting.txt',
      description: 'read greeting',
    }, agent())
    expect(result.isError).toBe(false)
    expect(lf(text(result))).toBe('hello pwsh\n')
  })

  it('a per-call timeout kills the run and reports the timed-out marker, not an error', async () => {
    const result = await call('pwsh', {
      command: 'Start-Sleep -Seconds 60',
      description: 'sleep forever',
      timeoutMs: 100,
    }, agent())
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected a timed-out foreground result')
    expect(result.value).toMatchObject({ kind: 'foreground', timedOut: true, aborted: false })
    // Windows reports the forced termination as exit 1 without a signal;
    // POSIX reports SIGTERM — the timeout marker is the stable fact.
    expect(lf(text(result))).toContain('[timed out after 100ms]')
  })

  it('an upstream cancellation aborts the run', async () => {
    const controller = new AbortController()
    const pending = call('pwsh', {
      command: 'Start-Sleep -Seconds 60',
      description: 'sleep forever',
    }, agent(), controller.signal)
    setTimeout(() => { controller.abort() }, 50)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.error).toMatchObject({ info: { name: 'AbortError', code: TOOL_ABORTED } })
  })

  it('a background run settles through the REAL job_output tool', async () => {
    const started = await call('pwsh', {
      command: 'Start-Sleep -Milliseconds 300; Write-Output bg-done',
      description: 'background greeting',
      run_in_background: true,
    })
    expect(started.isError).toBe(false)
    if (started.isError) throw new Error('expected background pwsh success')
    expect(started.value).toMatchObject({ kind: 'background' })
    const jobId = (started.value as { jobId: string }).jobId

    // The output delta and the terminal status can land in separate reads
    // (Windows flushes the child pipe at exit), so collect incrementally —
    // the same two-step shape as the bash background suite.
    const deadline = Date.now() + 10_000
    let output = ''
    while (Date.now() < deadline) {
      const read = await call('job_output', { job_id: jobId })
      output += text(read)
      if (output.includes('bg-done') && output.includes('[status: completed, exit code: 0]')) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    expect(output).toContain('bg-done')
    expect(output).toContain('[status: completed, exit code: 0]')
  })
})
