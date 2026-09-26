import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellExecution, ShellProcessRead } from '@deepseek-ai/dsh-shell'

/** Empty offset readers for fakes that never produce output. */
const silentReader = { readFrom: (fromByte: number) => ({ text: '', nextOffset: fromByte, lossy: false }) }

/**
 * Minimal concrete executor: canned foreground results, a hand-built process
 * handle. The seam is TASK-FREE (execute returns a live handle;
 * task semantics live in `ctx.jobs`), so this stub is all an implementation
 * owes the abstract class.
 */
class StubExecutor extends ShellExecutor {
  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? '/stub',
      timeoutMs: request.timeoutMs ?? 1000,
      onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      ...request.signal ? { signal: request.signal } : {},
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const proc: ShellExecution = {
      status: 'running',
      exitCode: null,
      signal: null,
      done: Promise.resolve(),
      readOutput: (): ShellProcessRead => ({ delta: '', lossy: false }),
      observed: { stdout: silentReader, stderr: silentReader },
      kill: (): boolean => {
        if (proc.status !== 'running') return false
        proc.status = 'killed'
        return true
      },
      result: () => Promise.resolve({
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        timeoutMs: spec.timeoutMs,
        stdout: { text: 'ok', truncated: false },
        stderr: { text: '', truncated: false },
      }),
    }
    return proc
  }
}

describe('ShellExecutor service seam', () => {
  it('a concrete subclass registers as ctx.shell and serves the abstract API', async () => {
    const ctx = new Context()
    await ctx.plugin(StubExecutor)
    const spec = ctx.shell.resolve({ command: 'echo hi' })
    expect(spec).toEqual({ command: 'echo hi', workdir: '/stub', timeoutMs: 1000, onExpiry: 'kill', stdoutMaxBytes: 64_000, sandboxPolicy: undefined })

    // One execution, two views: the foreground result projection…
    const ex = (await ctx.shell.execute(spec))
    const result = await ex.result()
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('ok')

    // …and the live handle itself.
    const proc = (await ctx.shell.execute({ ...spec, onExpiry: 'none' }))
    expect(proc.status).toBe('running')
    expect(proc.readOutput()).toEqual({ delta: '', lossy: false })
    expect(proc.kill()).toBe(true)
    expect(proc.kill()).toBe(false) // already settled → no-op
    await proc.done
  })

  it('reports no default sandbox mode from the task-free base seam', async () => {
    const ctx = new Context()
    await ctx.plugin(StubExecutor)
    expect(ctx.shell.sandboxMode).toBeUndefined()
  })

  it('loading a second implementation throws (one bash service per context — cordis standard)', async () => {
    const ctx = new Context()
    await ctx.plugin(StubExecutor)
    class SecondExecutor extends StubExecutor {}
    await expect(ctx.plugin(SecondExecutor)).rejects.toThrow(/service "shell" has been registered/)
  })
})
