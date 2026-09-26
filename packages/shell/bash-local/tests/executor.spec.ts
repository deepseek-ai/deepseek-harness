import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { ShellExecSpec, ShellExecution, ShellProcess, ShellRunResult } from '@deepseek-ai/dsh-shell'

/** Historical foreground shorthand over the unified execute() seam. */
async function run(x: { execute(spec: ShellExecSpec): Promise<ShellExecution> }, spec: ShellExecSpec): Promise<ShellRunResult> {
  return (await x.execute(spec)).result()
}

/** Historical background shorthand: execute with no deadline armed. */
function start(x: { execute(spec: ShellExecSpec): Promise<ShellExecution> }, spec: ShellExecSpec): Promise<ShellExecution> {
  return x.execute({ ...spec, onExpiry: 'none' })
}


const spillDir = mkdtempSync(join(tmpdir(), 'dsh-bash-exec-spec-'))

afterAll(() => {
  rmSync(spillDir, { recursive: true, force: true })
})

async function setup(config: Parameters<typeof LocalBashExecutor.Config>[0] = {}) {
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
    const result = await run(bash, bash.resolve({ command: 'echo hi' }))
    expect(result.exitCode).toBe(0)
    expect(result.stdout.text).toBe('hi\n')
    expect(result.timeoutMs).toBe(5_000)
  })

  it('uses config cwd, overridable per call', async () => {
    const { bash } = await setup({ cwd: '/tmp' })
    const fromConfig = await run(bash, bash.resolve({ command: 'pwd' }))
    expect(fromConfig.stdout.text.trim()).toMatch(/\/tmp$/)
    const fromCall = await run(bash, bash.resolve({ command: 'pwd', workdir: '/' }))
    expect(fromCall.stdout.text.trim()).toBe('/')
  })

  it('defaults cwd to process.cwd()', async () => {
    const { bash } = await setup()
    const result = await run(bash, bash.resolve({ command: 'pwd' }))
    expect(result.stdout.text.trim()).toBe(process.cwd())
  })

  it('caps per-call timeouts at maxTimeoutMs', async () => {
    const { bash } = await setup({ timeoutMs: 1_000, maxTimeoutMs: 2_000 })
    const result = await run(bash, bash.resolve({ command: 'true', timeoutMs: 99_999 }))
    expect(result.timeoutMs).toBe(2_000)
  })

  it('rejects unusable numeric config at the next command and invalid timeout overrides at resolve', async () => {
    for (const [config, field] of [
      [{ timeoutMs: Number.NaN }, /timeoutMs/], [{ maxTimeoutMs: 0 }, /maxTimeoutMs/], [{ maxOutputBytes: -1 }, /maxOutputBytes/],
      [{ maxSpillBytes: 0 }, /maxSpillBytes/], [{ graceMs: 0 }, /graceMs/],
      [{ graceMs: MAX_TIMER_DELAY_MS + 1 }, `graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`],
    ] as const) {
      const { bash: unusable } = await setup(config)
      expect(() => unusable.resolve({ command: 'true' })).toThrow(field)
    }

    const { bash } = await setup()
    expect(() => bash.resolve({ command: 'true', timeoutMs: Number.NaN })).toThrow(/request\.timeoutMs/)
    expect(() => bash.resolve({ command: 'true', timeoutMs: -1 })).toThrow(/request\.timeoutMs/)
    expect(() => bash.resolve({ command: 'true', stdoutMaxBytes: Number.NaN })).toThrow(/request\.stdoutMaxBytes/)
    expect(() => bash.resolve({ command: 'true', stdoutMaxBytes: -1 })).toThrow(/request\.stdoutMaxBytes/)
  })

  it('defaults stdoutMaxBytes to maxOutputBytes and lets foreground callers raise stdout only', async () => {
    const { bash } = await setup({ maxOutputBytes: 100 })
    expect(bash.resolve({ command: 'true' }).stdoutMaxBytes).toBe(100)

    const result = await run(bash, bash.resolve({
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
    const result = await run(bash, bash.resolve({ command: 'sleep 60', timeoutMs: 100 }))
    expect(result.timedOut).toBe(true)
    // Mutually exclusive: a timeout classifies as timedOut, never also aborted.
    expect(result.aborted).toBe(false)
    expect(result.timeoutMs).toBe(100)
  })

  it('propagates abort signals', async () => {
    const { bash } = await setup()
    const controller = new AbortController()
    const pending = run(bash, bash.resolve({ command: 'sleep 60', signal: controller.signal }))
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
    const result = await run(bash, bash.resolve({ command: 'kill -TERM $$' }))
    expect(result.signal).toBe('SIGTERM')
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
  })

  it('rejects on spawn failure (bad workdir)', async () => {
    const { bash } = await setup()
    await expect(run(bash, bash.resolve({ command: 'true', workdir: '/nonexistent-dsh' }))).rejects.toThrow(/ENOENT/)
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
    const result = await run(bash, spec)
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
  it('start returns a running handle before the child is allowed to finish', async (t) => {
    const { bash } = await setup()
    const directory = mkdtempSync(join(spillDir, 'start-'))
    const proc = await start(bash, bash.resolve({
      command: 'echo ready; while [ ! -f release ]; do sleep 0.02; done; echo done',
      workdir: directory,
    }))
    t.onTestFinished(async () => {
      proc.kill()
      await proc.done
      rmSync(directory, { recursive: true, force: true })
    })
    await readUntil(proc, 'ready\n')
    expect(proc.status).toBe('running')
    writeFileSync(join(directory, 'release'), '')
    await proc.done
    expect(proc.status).toBe('completed')
    expect(proc.exitCode).toBe(0)
    expect(proc.readOutput().delta).toBe('done\n')
  })

  it('threads stdin and extra env into a background process', async () => {
    const { bash } = await setup()
    const proc = (await start(bash, bash.resolve({
      command: 'cat; echo "[$BG_VAR][$DSH_BG_VAR]"',
      stdin: 'bg-stdin\n',
      env: { BG_VAR: 'bg-env' },
      dshEnv: { DSH_BG_VAR: 'bg-dsh-env' },
    })))
    const output = await readUntil(proc, '[bg-env][bg-dsh-env]')
    expect(output).toContain('bg-stdin')
    await proc.done
    expect(proc.exitCode).toBe(0)
  })

  it('readOutput is consuming: increments are never re-delivered, and reads stay valid after exit', async () => {
    const { bash } = await setup()
    const proc = (await start(bash, bash.resolve({ command: 'echo first; sleep 1; echo second' })))
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
    const proc = (await start(bash, bash.resolve({ command: 'echo out; echo err >&2' })))
    await proc.done
    expect(proc.readOutput().delta).toBe('out\n[stderr]\nerr\n')
  })

  it('readOutput reports stderr-only deltas without a leading newline', async () => {
    const { bash } = await setup()
    const proc = (await start(bash, bash.resolve({ command: 'echo err >&2' })))
    await proc.done
    expect(proc.readOutput().delta).toBe('[stderr]\nerr\n')
  })

  it('readOutput adds a separator only when stdout lacks a trailing newline', async () => {
    const { bash } = await setup()
    const proc = (await start(bash, bash.resolve({ command: 'printf out; echo err >&2' })))
    await proc.done
    expect(proc.readOutput().delta).toBe('out\n[stderr]\nerr\n')
  })

  it('readOutput flags lossy reads and reports stdout spill paths', async () => {
    const { bash } = await setup({ maxOutputBytes: 100 })
    const proc = (await start(bash, bash.resolve({ command: 'for i in $(seq 1 100); do printf "line-%04d\\n" $i; done' })))
    await proc.done
    const read = proc.readOutput()
    // Window slid past offset 0 → lossy, spill path points at the full stream.
    expect(read.lossy).toBe(true)
    expect(read.stdoutSpillPath).toBeDefined()
  })

  it('readOutput reports stderr spill paths', async () => {
    const { bash } = await setup({ maxOutputBytes: 100 })
    const proc = (await start(bash, bash.resolve({ command: 'for i in $(seq 1 100); do printf "line-%04d\\n" $i >&2; done' })))
    await proc.done
    const read = proc.readOutput()
    expect(read.lossy).toBe(true)
    expect(read.stderrSpillPath).toBeDefined()
    expect(read.delta).toContain('[stderr]')
  })

  it('kill() requests managed-range termination: true once, false after settlement', async () => {
    const { bash } = await setup()
    const proc = (await start(bash, bash.resolve({ command: 'sleep 60' })))
    expect(proc.kill()).toBe(true)
    await proc.done
    expect(proc.status).toBe('killed')
    expect(proc.signal).toBe('SIGTERM')
    expect(proc.kill()).toBe(false)
  })

  it('kill() returns false for a naturally completed process', async () => {
    const { bash } = await setup()
    const proc = (await start(bash, bash.resolve({ command: 'true' })))
    await proc.done
    expect(proc.status).toBe('completed')
    expect(proc.kill()).toBe(false)
  })

  it('kill escalation uses the configured graceMs (a TERM-trapping process dies by SIGKILL)', async () => {
    const { bash } = await setup() // setup pins graceMs: 200 via config
    // The child echoes AFTER arming the trap, so waiting for the marker
    // guarantees SIGTERM is already ignored when the kill lands (a fixed sleep
    // is load-flaky: a slow spawn would take the SIGTERM before the trap).
    const proc = (await start(bash, bash.resolve({ command: 'trap \'\' TERM; echo armed; sleep 60' })))
    await readUntil(proc, 'armed')
    proc.kill()
    await proc.done
    expect(proc.status).toBe('killed')
    expect(proc.signal).toBe('SIGKILL')
  })

  it('a spec.signal abort settles the handle as killed, not completed', async () => {
    const { bash } = await setup()
    const controller = new AbortController()
    const proc = (await start(bash, bash.resolve({ command: 'sleep 60', signal: controller.signal })))
    controller.abort()
    await proc.done
    expect(proc.status).toBe('killed')
    expect(proc.signal).toBe('SIGTERM')
  })

  it('a self-signal exit settles the handle as killed, not completed', async () => {
    const { bash } = await setup()
    const proc = (await start(bash, bash.resolve({ command: 'kill -TERM $$' })))
    await proc.done
    expect(proc.status).toBe('killed')
    expect(proc.exitCode).toBeNull()
    expect(proc.signal).toBe('SIGTERM')
  })

  it('observed readers delegate to the collectors once a process spawned', async () => {
    const { bash } = await setup()
    const proc = (await start(bash, bash.resolve({ command: 'echo err 1>&2' })))
    await proc.done
    expect(proc.observed.stderr.readFrom(0).text).toBe('err\n')
    expect(proc.observed.stdout.readFrom(0).text).toBe('')
  })

  it('reports both unread stderr and an asynchronous provider rejection exactly once', async () => {
    const { ctx, bash } = await setup()
    const emptyReader: SubprocessOutputReader = {
      readFrom: () => ({ text: '', nextOffset: 0, lossy: false }),
    }
    const stderrText = 'target stderr'
    const stderrReader: SubprocessOutputReader = {
      readFrom: offset => ({
        text: stderrText.slice(offset),
        nextOffset: stderrText.length,
        lossy: false,
      }),
    }
    vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue({
      control: undefined,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: { stdout: emptyReader, stderr: stderrReader },
      done: Promise.reject(new Error('provider lost the direct outcome')),
      terminate: vi.fn(),
      waitForExit: async () => true,
    } satisfies SubprocessHandle)

    const proc = (await start(bash, bash.resolve({ command: 'true' })))
    await expect(proc.done).resolves.toBeUndefined()
    expect(proc.status).toBe('killed')
    const output = proc.readOutput().delta
    expect(output).toContain('target stderr')
    expect(output).toContain('subprocess failed before reporting an outcome:')
    expect(output).not.toContain('spawn failed:')
    expect(proc.readOutput().delta).toBe('')
  })

  it('treats a rejection after its own abort as the aborted outcome, not a provider failure', async () => {
    const { ctx, bash } = await setup()
    const emptyReader: SubprocessOutputReader = {
      readFrom: () => ({ text: '', nextOffset: 0, lossy: false }),
    }
    const rejected = Promise.withResolvers<SubprocessOutcome>()
    vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue({
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      control: undefined,
      collected: { stdout: emptyReader, stderr: emptyReader },
      done: rejected.promise,
      terminate: vi.fn(),
      waitForExit: async () => true,
    } satisfies SubprocessHandle)
    const controller = new AbortController()
    const ex = (await start(bash, bash.resolve({ command: 'true', signal: controller.signal })))
    controller.abort()
    // A provider that terminated the range before the target started has no
    // exit to report and rejects with the cancellation reason instead.
    rejected.reject(controller.signal.reason)
    await expect(ex.done).resolves.toBeUndefined()
    expect(ex.status).toBe('killed')
    await expect(ex.result()).resolves.toMatchObject({ aborted: true, timedOut: false, exitCode: null })
    expect(ex.readOutput().delta).toBe('')
  })

  it('treats a rejection after kill() as the killed outcome, not a provider failure', async () => {
    const { ctx, bash } = await setup()
    const emptyReader: SubprocessOutputReader = {
      readFrom: () => ({ text: '', nextOffset: 0, lossy: false }),
    }
    const rejected = Promise.withResolvers<SubprocessOutcome>()
    vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue({
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      control: undefined,
      collected: { stdout: emptyReader, stderr: emptyReader },
      done: rejected.promise,
      terminate: vi.fn(),
      waitForExit: async () => true,
    } satisfies SubprocessHandle)
    const ex = (await start(bash, bash.resolve({ command: 'true' })))
    expect(ex.kill()).toBe(true)
    rejected.reject(new Error('subprocess terminated before target start'))
    await expect(ex.done).resolves.toBeUndefined()
    expect(ex.status).toBe('killed')
    await expect(ex.result()).resolves.toMatchObject({ aborted: false, timedOut: false, exitCode: null })
    expect(ex.readOutput().delta).toBe('')
  })

  it('settles an unprintable provider rejection instead of rejecting done', async () => {
    const { ctx, bash } = await setup()
    const emptyReader: SubprocessOutputReader = {
      readFrom: () => ({ text: '', nextOffset: 0, lossy: false }),
    }
    const providerError = new Error('unprintable provider error')
    Object.defineProperty(providerError, Symbol.toPrimitive, {
      value: () => { throw new Error('provider formatting must not escape') },
    })
    vi.spyOn(ctx.subprocess, 'spawn').mockReturnValue({
      control: undefined,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected: { stdout: emptyReader, stderr: emptyReader },
      done: Promise.reject(providerError),
      terminate: vi.fn(),
      waitForExit: async () => true,
    } satisfies SubprocessHandle)

    const proc = (await start(bash, bash.resolve({ command: 'true' })))
    await expect(proc.done).resolves.toBeUndefined()
    expect(proc.status).toBe('killed')
    expect(proc.readOutput().delta).toContain('unprintable provider failure')
    expect(proc.readOutput().delta).toBe('')
  })

  it('an asynchronous creation failure settles as killed with a stage-neutral note', async () => {
    const { bash } = await setup()
    const proc = (await start(bash, bash.resolve({ command: 'true', workdir: '/nonexistent-dsh' })))
    // done resolves (never rejects) even though the process never ran.
    await expect(proc.done).resolves.toBeUndefined()
    expect(proc.status).toBe('killed')
    // Observers read the note as the whole stderr stream at their own offsets.
    const first = proc.observed.stderr.readFrom(0)
    expect(first.text).toMatch(/^subprocess failed before reporting an outcome: /)
    expect(first).toMatchObject({ nextOffset: Buffer.byteLength(first.text, 'utf8'), lossy: false })
    expect(proc.observed.stderr.readFrom(first.nextOffset)).toEqual({ text: '', nextOffset: first.nextOffset, lossy: false })
    expect(proc.observed.stdout.readFrom(0).text).toBe('')
    // The consuming read folds the same note in exactly once.
    expect(proc.readOutput().delta).toBe(`[stderr]\n${first.text}`)
    expect(proc.readOutput().delta).toBe('')
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
    const proc = (await start(bash, bash.resolve({ command: 'echo $$; sleep 60' })))
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

    const finished = (await start(bash, bash.resolve({ command: 'echo done' })))
    await finished.done
    expect(finished.status).toBe('completed')
    const trapping = (await start(bash, bash.resolve({ command: 'trap \'\' TERM; echo armed; sleep 60' })))
    await readUntil(trapping, 'armed')

    await managerFiber.dispose()
    // A settled process was untouched; the live one died by escalation.
    expect(finished.status).toBe('completed')
    await trapping.done
    expect(trapping.status).toBe('killed')
    expect(trapping.signal).toBe('SIGKILL')
  })
})

describe('cancellation against a hanging backend', () => {
  /** A subprocess service whose process runs until the test settles it and ignores the spawn signal. */
  class HangingSubprocessRuntime extends SubprocessRuntime {
    settle: (outcome: { exitCode: number | null; signal: NodeJS.Signals | null }) => void = () => {}
    override async terminalEnvironment(): Promise<never> { throw new Error('fixture does not open terminals') }
    override async resolveExecutable(command: string): Promise<string> { return command }
    override spawnTerminal(): Promise<never> { throw new Error('bash spawns pipes, never terminals') }
    private readonly reader: SubprocessOutputReader = {
      readFrom: () => ({ text: '', lossy: false, nextOffset: 0 }),
    }
    override spawn(): SubprocessHandle {
      return {
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        control: undefined,
        collected: { stdout: this.reader, stderr: this.reader },
        done: new Promise((resolve) => { this.settle = resolve }),
        terminate: () => {},
        waitForExit: async () => true,
      }
    }
  }

  it('a caller abort before the deadline stays the first cause when the process outlives the deadline', async () => {
    const ctx = new Context()
    const subprocess = new HangingSubprocessRuntime(ctx)
    await ctx.plugin(LocalBashExecutor)
    const controller = new AbortController()
    const ex = (await ctx.shell.execute(ctx.shell.resolve({ command: 'sleep 30', timeoutMs: 20, signal: controller.signal })))
    controller.abort()
    // The fake ignores the relayed abort, so the process outlives the deadline
    // the way a real one does inside its termination grace.
    await new Promise(resolve => setTimeout(resolve, 40))
    subprocess.settle({ exitCode: null, signal: 'SIGTERM' })
    const result = await ex.result()
    expect(result.aborted).toBe(true)
    expect(result.timedOut).toBe(false)
  })
})

describe('execute() projections under none policy', () => {
  it('classifies a no-deadline execution: clean settle, then an aborted one', async () => {
    const { bash } = await setup()
    const clean = (await start(bash, bash.resolve({ command: 'echo bg' })))
    await clean.done
    await expect(clean.result()).resolves.toMatchObject({ exitCode: 0, timedOut: false, aborted: false })

    const controller = new AbortController()
    const killed = (await start(bash, bash.resolve({ command: 'sleep 30', signal: controller.signal })))
    controller.abort()
    await killed.done
    await expect(killed.result()).resolves.toMatchObject({ timedOut: false, aborted: true })
  })
})
