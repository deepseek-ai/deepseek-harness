import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { ShellProcess } from '@deepseek-ai/dsh-shell'

const spillDir = mkdtempSync(join(tmpdir(), 'dsh-bash-exec-spec-'))

afterAll(() => {
  rmSync(spillDir, { recursive: true, force: true })
})

async function setup(config: ConstructorParameters<typeof LocalBashExecutor>[1] = {}) {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
  // A short kill grace via the REAL config path, so escalation tests stay fast.
  await ctx.plugin(LocalBashExecutor, { graceMs: 200, ...config })
  const bash = ctx.shell as LocalBashExecutor
  return { ctx, bash }
}

/**
 * Poll a handle's consuming readOutput until the ACCUMULATED delta contains
 * `expected`; returns the accumulation (reads never re-deliver, so the caller
 * gets everything produced up to the match).
 */
async function readUntil(proc: ShellProcess, expected: string, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let all = ''
  while (Date.now() < deadline) {
    all += proc.readOutput().delta
    if (all.includes(expected)) return all
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`process output did not include ${JSON.stringify(expected)}; accumulated ${JSON.stringify(all)}`)
}

describe('LocalBashExecutor.run', () => {
  it('resolves with output and the effective timeout', async () => {
    const { bash } = await setup({ timeoutMs: 5_000 })
    const result = await bash.run(bash.resolve({ command: 'echo hi' }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('hi\n')
    expect(result.timeoutMs).toBe(5_000)
  })

  it('uses config cwd, overridable per call', async () => {
    const { bash } = await setup({ cwd: '/tmp' })
    const fromConfig = await bash.run(bash.resolve({ command: 'pwd' }))
    expect(fromConfig.stdout.text.trim()).toMatch(/\/tmp$/)
    const fromCall = await bash.run(bash.resolve({ command: 'pwd', workdir: '/' }))
    expect(fromCall.stdout.text.trim()).toBe('/')
  })

  it('defaults cwd to process.cwd()', async () => {
    const { bash } = await setup()
    const result = await bash.run(bash.resolve({ command: 'pwd' }))
    expect(result.stdout.text.trim()).toBe(process.cwd())
  })

  it('caps per-call timeouts at maxTimeoutMs', async () => {
    const { bash } = await setup({ timeoutMs: 1_000, maxTimeoutMs: 2_000 })
    const result = await bash.run(bash.resolve({ command: 'true', timeoutMs: 99_999 }))
    expect(result.timeoutMs).toBe(2_000)
  })

  it('rejects invalid numeric config and timeout overrides', async () => {
    await expect(setup({ timeoutMs: Number.NaN })).rejects.toThrow(/timeoutMs/)
    await expect(setup({ maxTimeoutMs: 0 })).rejects.toThrow(/maxTimeoutMs/)
    await expect(setup({ maxOutputBytes: -1 })).rejects.toThrow(/maxOutputBytes/)
    await expect(setup({ maxSpillBytes: 0 })).rejects.toThrow(/maxSpillBytes/)
    await expect(setup({ graceMs: 0 })).rejects.toThrow(/graceMs/)
    await expect(setup({ graceMs: MAX_TIMER_DELAY_MS + 1 }))
      .rejects.toThrow(`graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)

    const { bash } = await setup()
    expect(() => bash.resolve({ command: 'true', timeoutMs: Number.NaN })).toThrow(/request\.timeoutMs/)
    expect(() => bash.resolve({ command: 'true', timeoutMs: -1 })).toThrow(/request\.timeoutMs/)
    expect(() => bash.resolve({ command: 'true', stdoutMaxBytes: Number.NaN })).toThrow(/request\.stdoutMaxBytes/)
    expect(() => bash.resolve({ command: 'true', stdoutMaxBytes: -1 })).toThrow(/request\.stdoutMaxBytes/)
  })

  it('defaults stdoutMaxBytes to maxOutputBytes and lets foreground callers raise stdout only', async () => {
    const { bash } = await setup({ maxOutputBytes: 100 })
    expect(bash.resolve({ command: 'true' }).stdoutMaxBytes).toBe(100)

    const result = await bash.run(bash.resolve({
      command: 'printf "%.0sx" $(seq 1 500); printf "%.0se" $(seq 1 500) >&2',
      stdoutMaxBytes: 500,
    }))

    expect(result.stdout.truncated).toBe(false)
    expect(result.stdout.text).toBe('x'.repeat(500))
    expect(result.stderr.truncated).toBe(true)
    expect(result.stderr.text.length).toBeLessThanOrEqual(100)
  })

  it('per-call timeout takes precedence under the cap and kills on expiry', async () => {
    const { bash } = await setup({ timeoutMs: 60_000 })
    const result = await bash.run(bash.resolve({ command: 'sleep 60', timeoutMs: 100 }))
    expect(result.timedOut).toBe(true)
    // Mutually exclusive: a timeout classifies as timedOut, never also aborted.
    expect(result.aborted).toBe(false)
    expect(result.timeoutMs).toBe(100)
  })

  it('propagates abort signals', async () => {
    const { bash } = await setup()
    const controller = new AbortController()
    const pending = bash.run(bash.resolve({ command: 'sleep 60', signal: controller.signal }))
    setTimeout(() => { controller.abort() }, 50)
    const result = await pending
    expect(result.aborted).toBe(true)
    // Mutually exclusive: an upstream cancel classifies as aborted, never also timedOut.
    expect(result.timedOut).toBe(false)
  })

  it('classifies a self-killed command as neither timed out nor aborted', async () => {
    // The command kills itself (SIGTERM) with no timeout and no upstream abort:
    // the deadline signal never fires, so both classifications are false — the
    // fused-signal classification reports the cause that cut the command short,
    // and here nothing the executor owns did.
    const { bash } = await setup({ timeoutMs: 60_000 })
    const result = await bash.run(bash.resolve({ command: 'kill -TERM $$' }))
    expect(result.signal).toBe('SIGTERM')
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
  })

  it('rejects on spawn failure (bad workdir)', async () => {
    const { bash } = await setup()
    await expect(bash.run(bash.resolve({ command: 'true', workdir: '/nonexistent-dsh' }))).rejects.toThrow(/ENOENT/)
  })

  it('resolve() carries stdin/env/dshEnv onto the spec, and run() threads them to the command', async () => {
    const { bash } = await setup()
    const spec = bash.resolve({
      command: 'cat; echo "[$SEAM_VAR][$DSH_SEAM_VAR]"',
      stdin: 'piped\n',
      env: { SEAM_VAR: 'env-ok' },
      dshEnv: { DSH_SEAM_VAR: 'dsh-ok' },
    })
    // resolve() keeps the optional input/environment fields verbatim.
    expect(spec.stdin).toBe('piped\n')
    expect(spec.env).toEqual({ SEAM_VAR: 'env-ok' })
    expect(spec.dshEnv).toEqual({ DSH_SEAM_VAR: 'dsh-ok' })
    const result = await bash.run(spec)
    expect(result.stdout.text).toBe('piped\n[env-ok][dsh-ok]\n')
  })

  it('resolve() omits stdin/env/dshEnv when the request supplies none', async () => {
    const { bash } = await setup()
    const spec = bash.resolve({ command: 'true' })
    expect('stdin' in spec).toBe(false)
    expect('env' in spec).toBe(false)
    expect('dshEnv' in spec).toBe(false)
  })
})

describe('LocalBashExecutor.start (background process handles)', () => {
  it('start returns immediately with a running handle that settles as completed', async () => {
    const { bash } = await setup()
    const before = Date.now()
    const proc = bash.start(bash.resolve({ command: 'sleep 0.2; echo done' }))
    expect(Date.now() - before).toBeLessThan(150)
    expect(proc.status).toBe('running')
    await proc.done
    expect(proc.status).toBe('completed')
    expect(proc.exitCode).toBe(0)
  })

  it('threads stdin and extra env into a background process', async () => {
    const { bash } = await setup()
    const proc = bash.start(bash.resolve({
      command: 'cat; echo "[$BG_VAR][$DSH_BG_VAR]"',
      stdin: 'bg-stdin\n',
      env: { BG_VAR: 'bg-env' },
      dshEnv: { DSH_BG_VAR: 'bg-dsh-env' },
    }))
    const output = await readUntil(proc, '[bg-env][bg-dsh-env]')
    expect(output).toContain('bg-stdin')
    await proc.done
    expect(proc.exitCode).toBe(0)
  })

  it('readOutput is consuming: increments are never re-delivered, and reads stay valid after exit', async () => {
    const { bash } = await setup()
    const proc = bash.start(bash.resolve({ command: 'echo first; sleep 1; echo second' }))
    const first = await readUntil(proc, 'first\n')
    expect(first).toBe('first\n')
    await proc.done
    // Read-after-exit returns the remaining buffered output — once.
    const second = proc.readOutput()
    expect(second.delta).toBe('second\n')
    expect(second.lossy).toBe(false)
    expect(proc.readOutput().delta).toBe('')
  })

  it('readOutput marks stderr sections', async () => {
    const { bash } = await setup()
    const proc = bash.start(bash.resolve({ command: 'echo out; echo err >&2' }))
    await proc.done
    expect(proc.readOutput().delta).toBe('out\n[stderr]\nerr\n')
  })

  it('readOutput reports stderr-only deltas without a leading newline', async () => {
    const { bash } = await setup()
    const proc = bash.start(bash.resolve({ command: 'echo err >&2' }))
    await proc.done
    expect(proc.readOutput().delta).toBe('[stderr]\nerr\n')
  })

  it('readOutput adds a separator only when stdout lacks a trailing newline', async () => {
    const { bash } = await setup()
    const proc = bash.start(bash.resolve({ command: 'printf out; echo err >&2' }))
    await proc.done
    expect(proc.readOutput().delta).toBe('out\n[stderr]\nerr\n')
  })

  it('readOutput flags lossy reads and reports stdout spill paths', async () => {
    const { bash } = await setup({ maxOutputBytes: 100 })
    const proc = bash.start(bash.resolve({ command: 'for i in $(seq 1 100); do printf "line-%04d\\n" $i; done' }))
    await proc.done
    const read = proc.readOutput()
    // Window slid past offset 0 → lossy, spill path points at the full stream.
    expect(read.lossy).toBe(true)
    expect(read.stdoutSpillPath).toBeDefined()
  })

  it('readOutput reports stderr spill paths', async () => {
    const { bash } = await setup({ maxOutputBytes: 100 })
    const proc = bash.start(bash.resolve({ command: 'for i in $(seq 1 100); do printf "line-%04d\\n" $i >&2; done' }))
    await proc.done
    const read = proc.readOutput()
    expect(read.lossy).toBe(true)
    expect(read.stderrSpillPath).toBeDefined()
    expect(read.delta).toContain('[stderr]')
  })

  it('kill() terminates the process group: true once, false after settlement', async () => {
    const { bash } = await setup()
    const proc = bash.start(bash.resolve({ command: 'sleep 60' }))
    expect(proc.kill()).toBe(true)
    await proc.done
    expect(proc.status).toBe('killed')
    expect(proc.signal).toBe('SIGTERM')
    expect(proc.kill()).toBe(false)
  })

  it('kill() returns false for a naturally completed process', async () => {
    const { bash } = await setup()
    const proc = bash.start(bash.resolve({ command: 'true' }))
    await proc.done
    expect(proc.status).toBe('completed')
    expect(proc.kill()).toBe(false)
  })

  it('kill escalation uses the configured graceMs (a TERM-trapping process dies by SIGKILL)', async () => {
    const { bash } = await setup() // setup pins graceMs: 200 via config
    // The child echoes AFTER arming the trap, so waiting for the marker
    // guarantees SIGTERM is already ignored when the kill lands (a fixed sleep
    // is load-flaky: a slow spawn would take the SIGTERM before the trap).
    const proc = bash.start(bash.resolve({ command: 'trap \'\' TERM; echo armed; sleep 60' }))
    await readUntil(proc, 'armed')
    proc.kill()
    await proc.done
    expect(proc.status).toBe('killed')
    expect(proc.signal).toBe('SIGKILL')
  })

  it('a spec.signal abort settles the handle as killed, not completed', async () => {
    const { bash } = await setup()
    const controller = new AbortController()
    const proc = bash.start(bash.resolve({ command: 'sleep 60', signal: controller.signal }))
    controller.abort()
    await proc.done
    expect(proc.status).toBe('killed')
    expect(proc.signal).toBe('SIGTERM')
  })

  it('a self-signal exit settles the handle as killed, not completed', async () => {
    const { bash } = await setup()
    const proc = bash.start(bash.resolve({ command: 'kill -TERM $$' }))
    await proc.done
    expect(proc.status).toBe('killed')
    expect(proc.exitCode).toBeNull()
    expect(proc.signal).toBe('SIGTERM')
  })

  it('a background spawn failure settles as killed with the error readable on stderr', async () => {
    const { bash } = await setup()
    const proc = bash.start(bash.resolve({ command: 'true', workdir: '/nonexistent-dsh' }))
    // done resolves (never rejects) even though the process never ran.
    await expect(proc.done).resolves.toBeUndefined()
    expect(proc.status).toBe('killed')
    expect(proc.readOutput().delta).toContain('spawn failed:')
  })
})

describe('process lifecycle ownership (the subprocess service, not the executor)', () => {
  it('a background process survives executor-fiber disposal and dies with the subprocess service', async () => {
    const ctx = new Context()
    const managerFiber = await ctx.plugin(LocalSubprocessRuntime)
    ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
    const executorFiber = await ctx.plugin(LocalBashExecutor, { graceMs: 200 })
    const bash = ctx.shell as LocalBashExecutor

    // The child prints its own pid ($$ = the detached bash group leader) so
    // the test can probe liveness through the public read API alone.
    const proc = bash.start(bash.resolve({ command: 'echo $$; sleep 60' }))
    const pid = Number((await readUntil(proc, '\n')).trim())
    expect(Number.isInteger(pid) && pid > 0).toBe(true)

    // Executor reload/disposal leaves background work running — the
    // handle stays live and readable, mirroring the job runtime's
    // registrations-outlive-producer-fibers contract.
    await executorFiber.dispose()
    expect(proc.status).toBe('running')
    expect(() => process.kill(pid, 0)).not.toThrow()

    // Service disposal kills the group and AWAITS its exit (no orphans).
    await managerFiber.dispose()
    expect(() => process.kill(pid, 0)).toThrow()
    await proc.done
    expect(proc.status).toBe('killed')
  })

  it('service disposal escalates to SIGKILL for TERM-trapping children and settles handles', async () => {
    const ctx = new Context()
    const managerFiber = await ctx.plugin(LocalSubprocessRuntime)
    ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
    await ctx.plugin(LocalBashExecutor, { graceMs: 200 })
    const bash = ctx.shell as LocalBashExecutor

    const finished = bash.start(bash.resolve({ command: 'echo done' }))
    await finished.done
    expect(finished.status).toBe('completed')
    const trapping = bash.start(bash.resolve({ command: 'trap \'\' TERM; echo armed; sleep 60' }))
    await readUntil(trapping, 'armed')

    await managerFiber.dispose()
    // A settled process was untouched; the live one died by escalation.
    expect(finished.status).toBe('completed')
    await trapping.done
    expect(trapping.status).toBe('killed')
    expect(trapping.signal).toBe('SIGKILL')
  })
})
