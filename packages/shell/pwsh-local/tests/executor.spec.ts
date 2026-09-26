/**
 * Real-process tests for `@deepseek-ai/dsh-pwsh-local`: the LOCAL subprocess
 * service plus a REAL pwsh executable, exercised through the executor seam
 * (`resolve` → `run`/`start`). These verify the world — actual PowerShell
 * runs, output capture, truncation and spill, deadlines, kill escalation, and
 * the background-handle contract. The suite self-skips when no usable `pwsh`
 * resolves (a CI accommodation for hosts without PowerShell); the pure unit tests
 * (config validation, executable resolution) run on every platform. PowerShell
 * writes CRLF on Windows, so exact text assertions normalize line endings.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { PwshLocalExecutor, ENCODING_PREAMBLE, candidatePwshPaths, resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
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


const spillDir = mkdtempSync(join(tmpdir(), 'dsh-pwsh-exec-spec-'))

afterAll(() => {
  rmSync(spillDir, { recursive: true, force: true })
})

/** Per-test temp dirs, removed after each test. */
const tempDirs: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  const ownedContexts = contexts.splice(0)
  const directories = tempDirs.splice(0)
  const results = await Promise.allSettled(ownedContexts.map(ctx => ctx.fiber.dispose()))
  for (const dir of directories) rmSync(dir, { recursive: true, force: true })
  const failures: unknown[] = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length > 0) throw new AggregateError(failures, 'PowerShell fixture cleanup failed')
})

function createContext(): Context {
  const ctx = new Context()
  contexts.push(ctx)
  return ctx
}

/** A private file barrier keeps the command alive until the test releases it. */
function commandBarrier() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-pwsh-barrier-'))
  tempDirs.push(dir)
  const path = join(dir, 'release')
  return {
    command: 'while (-not (Test-Path -LiteralPath $env:DSH_TEST_RELEASE)) { Start-Sleep -Milliseconds 20 }',
    env: { DSH_TEST_RELEASE: path },
    release: () => { writeFileSync(path, '') },
  }
}

// The probe follows the executor's own resolution (Program Files installs on
// Windows are found even when bare `pwsh` is not on PATH).
const hasPwsh = spawnSync(resolvePwshPath(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'], { encoding: 'utf8' }).status === 0

/** Normalize PowerShell's platform line endings (CRLF on Windows, LF elsewhere). */
const lf = (text: string): string => text.replace(/\r\n/g, '\n')

/** Filesystem path equality across macOS temp symlinks and Windows drive-letter casing. */
function samePath(actual: string, expected: string): boolean {
  const norm = (value: string) => (
    process.platform === 'win32' ? realpathSync.native(value).toLowerCase() : realpathSync.native(value)
  )
  return norm(actual) === norm(expected)
}

async function setup(config: Parameters<typeof PwshLocalExecutor.Config>[0] = {}) {
  const ctx = createContext()
  await ctx.plugin(LocalSubprocessRuntime)
  ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
  // A short kill grace via the REAL config path, so escalation tests stay fast.
  await ctx.plugin(PwshLocalExecutor, { graceMs: 200, ...config })
  const bash = ctx.shell as PwshLocalExecutor
  return { ctx, bash }
}

/**
 * Accumulate consuming reads until the marker arrives, using the current test's
 * budget. Callers keep the child at a barrier when later output must remain unread.
 */
async function readUntil(proc: ShellProcess, expected: string, timeoutMs: number): Promise<string> {
  let all = ''
  await expect.poll(() => {
    all += proc.readOutput().delta
    return lf(all)
  }, { timeout: timeoutMs }).toContain(expected)
  return lf(all)
}

describe('resolvePwshPath and candidatePwshPaths (pure, every platform)', () => {
  it('trusts an explicit configured path verbatim', () => {
    expect(resolvePwshPath('C:\\custom\\pwsh.exe')).toBe('C:\\custom\\pwsh.exe')
    expect(resolvePwshPath('pwsh')).toBe('pwsh')
  })

  it('falls through an empty configured path to platform resolution', () => {
    // SystemRoot points at a non-existent tree so the Windows PowerShell 5.1
    // fallback candidate cannot exist either.
    expect(resolvePwshPath('', {
      PATH: 'P:\\Store',
      ProgramFiles: 'P:\\no-program-files',
      SystemRoot: 'S:\\no-windows',
    }, 'win32')).toBe('pwsh')
  })

  it('returns pwsh on non-Windows platforms regardless of the environment', () => {
    expect(resolvePwshPath(undefined, { ProgramFiles: 'P:\\Program Files' }, 'linux')).toBe('pwsh')
    expect(resolvePwshPath(undefined, { PATH: 'P:\\Store' }, 'darwin')).toBe('pwsh')
  })

  it('uses stable Windows roots when the environment omits both overrides', () => {
    expect(candidatePwshPaths({})).toEqual([
      join('C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
      join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ])
  })

  it('lists PowerShell 7, PATH entries (quotes stripped), then Windows PowerShell 5.1 on win32', () => {
    const candidates = candidatePwshPaths({
      ProgramFiles: 'P:\\Program Files',
      SystemRoot: 'S:\\Windows',
      PATH: ';"Q:\\quoted store";' + ';',
    })
    expect(candidates).toEqual([
      join('P:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
      join('Q:\\quoted store', 'pwsh.exe'),
      join('S:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ])
    // A missing PATH contributes no entries (the empty-string fallback).
    expect(candidatePwshPaths({ ProgramFiles: 'P:\\Program Files', SystemRoot: 'S:\\Windows' }))
      .toEqual([
        join('P:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
        join('S:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ])
  })

  it('returns the first EXISTING win32 candidate, else pwsh', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwsh-resolve-'))
    tempDirs.push(dir)
    const store = join(dir, 'store')
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'pwsh.exe'), '')
    // The existing PATH entry wins over the non-existent Program Files install.
    expect(resolvePwshPath(undefined, { ProgramFiles: join(dir, 'missing'), PATH: store }, 'win32'))
      .toBe(join(store, 'pwsh.exe'))
    // No candidate exists anywhere (SystemRoot points at a non-existent tree,
    // so even the Windows PowerShell 5.1 fallback cannot exist) → the
    // PATH-resolution fallback.
    expect(resolvePwshPath(undefined, { ProgramFiles: join(dir, 'missing'), PATH: join(dir, 'empty'), SystemRoot: join(dir, 'no-windows') }, 'win32'))
      .toBe('pwsh')
  })

  it('accepts a link-shaped PATH candidate whose target cannot be stat-ed', () => {
    // Store app execution aliases stat as EACCES but lstat as a link; a
    // dangling symlink reproduces that split on every platform.
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwsh-resolve-link-'))
    tempDirs.push(dir)
    const store = join(dir, 'store')
    mkdirSync(store, { recursive: true })
    const link = join(store, 'pwsh.exe')
    symlinkSync(join(dir, 'no-such-target.exe'), link)
    expect(resolvePwshPath(undefined, { ProgramFiles: join(dir, 'missing'), PATH: store }, 'win32'))
      .toBe(link)
  })

  it('skips a directory candidate and falls through to the PATH-resolution default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-pwsh-resolve-dir-'))
    tempDirs.push(dir)
    const store = join(dir, 'store')
    mkdirSync(join(store, 'pwsh.exe'), { recursive: true })
    expect(resolvePwshPath(undefined, {
      ProgramFiles: join(dir, 'missing'),
      PATH: store,
      SystemRoot: join(dir, 'no-windows'),
    }, 'win32')).toBe('pwsh')
  })
})

describe('spawn construction (pure, every platform)', () => {
  /** A subprocess service that records spawn specs and settles instantly. */
  class CapturingSubprocessRuntime extends SubprocessRuntime {
    async terminalEnvironment() { return { platform: 'posix' as const } }
    specs: SubprocessSpawnSpec[] = []
    done: Promise<SubprocessOutcome> = Promise.resolve({ exitCode: 0, signal: null })
    stderrText = ''
    override async resolveExecutable(command: string): Promise<string> { return command }
    override spawnTerminal(): Promise<never> { throw new Error('pwsh spawns pipes, never terminals') }
    private readonly stdoutReader: SubprocessOutputReader = {
      readFrom: () => ({ text: '', lossy: false, nextOffset: 0 }),
    }
    private readonly stderrReader: SubprocessOutputReader = {
      readFrom: offset => ({
        text: this.stderrText.slice(offset),
        lossy: false,
        nextOffset: this.stderrText.length,
      }),
    }
    override spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
      this.specs.push(spec)
      return {
        control: undefined,
        stdin: undefined,
        stdout: undefined,
        stderr: undefined,
        collected: { stdout: this.stdoutReader, stderr: this.stderrReader },
        done: this.done,
        terminate: () => {},
        waitForExit: async () => true,
      }
    }
  }

  it('runs every command as ONE argv element under the UTF-8 encoding preamble', async () => {
    const ctx = createContext()
    const subprocess = new CapturingSubprocessRuntime(ctx)
    await ctx.plugin(PwshLocalExecutor)
    await run(ctx.shell, ctx.shell.resolve({ command: 'Write-Output 你好' }))
    expect(subprocess.specs).toHaveLength(1)
    const { argv } = subprocess.specs[0]!
    expect(argv.slice(0, 5)).toEqual([expect.any(String), '-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
    expect(argv[5]).toBe(`${ENCODING_PREAMBLE}Write-Output 你好`)
    expect(ENCODING_PREAMBLE).toContain('[Console]::OutputEncoding')
    expect(ENCODING_PREAMBLE).toContain('$OutputEncoding')
  })

  it('reports both unread stderr and an asynchronous provider rejection exactly once', async () => {
    const ctx = createContext()
    const subprocess = new CapturingSubprocessRuntime(ctx)
    await ctx.plugin(PwshLocalExecutor)
    subprocess.stderrText = 'target stderr'
    subprocess.done = Promise.reject(new Error('provider lost the direct outcome'))

    const proc = (await start(ctx.shell, ctx.shell.resolve({ command: 'Write-Output maybe-ran' })))
    await expect(proc.done).resolves.toBeUndefined()
    expect(proc.status).toBe('killed')
    const output = proc.readOutput().delta
    expect(output).toContain('target stderr')
    expect(output).toContain('subprocess failed before reporting an outcome:')
    expect(output).not.toContain('spawn failed:')
    expect(proc.readOutput().delta).toBe('')
  })

  it('settles an unprintable provider rejection instead of rejecting done', async () => {
    const ctx = createContext()
    const subprocess = new CapturingSubprocessRuntime(ctx)
    await ctx.plugin(PwshLocalExecutor)
    const providerError = new Error('unprintable provider error')
    Object.defineProperty(providerError, Symbol.toPrimitive, {
      value: () => { throw new Error('provider formatting must not escape') },
    })
    subprocess.done = Promise.reject(providerError)

    const proc = (await start(ctx.shell, ctx.shell.resolve({ command: 'Write-Output maybe-ran' })))
    await expect(proc.done).resolves.toBeUndefined()
    expect(proc.status).toBe('killed')
    expect(proc.readOutput().delta).toContain('unprintable provider failure')
    expect(proc.readOutput().delta).toBe('')
  })

  it('treats a rejection after its own abort as the aborted outcome, not a provider failure', async () => {
    const ctx = createContext()
    const subprocess = new CapturingSubprocessRuntime(ctx)
    await ctx.plugin(PwshLocalExecutor)
    const rejected = Promise.withResolvers<SubprocessOutcome>()
    subprocess.done = rejected.promise
    const controller = new AbortController()
    const ex = (await start(ctx.shell, ctx.shell.resolve({ command: 'Write-Output maybe-ran', signal: controller.signal })))
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
    const ctx = createContext()
    const subprocess = new CapturingSubprocessRuntime(ctx)
    await ctx.plugin(PwshLocalExecutor)
    const rejected = Promise.withResolvers<SubprocessOutcome>()
    subprocess.done = rejected.promise
    const ex = (await start(ctx.shell, ctx.shell.resolve({ command: 'Write-Output maybe-ran' })))
    expect(ex.kill()).toBe(true)
    rejected.reject(new Error('subprocess terminated before target start'))
    await expect(ex.done).resolves.toBeUndefined()
    expect(ex.status).toBe('killed')
    await expect(ex.result()).resolves.toMatchObject({ aborted: false, timedOut: false, exitCode: null })
    expect(ex.readOutput().delta).toBe('')
  })

  it('preserves an explicit kill stamp and maps an aborted direct outcome to killed', async () => {
    const ctx = createContext()
    const subprocess = new CapturingSubprocessRuntime(ctx)
    await ctx.plugin(PwshLocalExecutor)

    const killedOutcome = Promise.withResolvers<SubprocessOutcome>()
    subprocess.done = killedOutcome.promise
    const killed = (await start(ctx.shell, ctx.shell.resolve({ command: 'Write-Output maybe-ran' })))
    expect(killed.kill()).toBe(true)
    killedOutcome.resolve({ exitCode: 0, signal: null })
    await killed.done
    expect(killed.status).toBe('killed')
    expect(killed.exitCode).toBe(0)

    const abortedOutcome = Promise.withResolvers<SubprocessOutcome>()
    subprocess.done = abortedOutcome.promise
    const controller = new AbortController()
    const aborted = (await start(ctx.shell, ctx.shell.resolve({
      command: 'Write-Output maybe-ran',
      signal: controller.signal,
    })))
    controller.abort()
    abortedOutcome.resolve({ exitCode: 0, signal: null })
    await aborted.done
    expect(aborted.status).toBe('killed')
  })
})

describe('background spawn failure (fake backend, every platform)', () => {
  /** A subprocess service whose spawn rejects the way a missing pwsh does. */
  class RejectingSubprocessRuntime extends SubprocessRuntime {
    override async terminalEnvironment() { return { platform: 'posix' as const } }
    override async resolveExecutable(command: string): Promise<string> { return command }
    override spawnTerminal(): Promise<never> { throw new Error('pwsh spawns pipes, never terminals') }
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
        done: Promise.reject(new Error('spawn pwsh ENOENT')),
        terminate: () => {},
        waitForExit: async () => true,
      }
    }
  }

  it('serves the note as the whole observed stderr stream and folds it into one consuming delta', async () => {
    const ctx = createContext()
    new RejectingSubprocessRuntime(ctx)
    await ctx.plugin(PwshLocalExecutor)
    const proc = (await ctx.shell.execute(ctx.shell.resolve({ command: 'Write-Output hi', onExpiry: 'none' })))
    await expect(proc.done).resolves.toBeUndefined()
    expect(proc.status).toBe('killed')
    const note = 'subprocess failed before reporting an outcome: Error: spawn pwsh ENOENT'
    expect(proc.observed.stderr.readFrom(0)).toEqual({ text: note, nextOffset: Buffer.byteLength(note), lossy: false })
    expect(proc.observed.stderr.readFrom(Buffer.byteLength(note))).toEqual({ text: '', nextOffset: Buffer.byteLength(note), lossy: false })
    expect(proc.observed.stdout.readFrom(0).text).toBe('')
    expect(proc.readOutput().delta).toBe(`[stderr]\n${note}`)
    expect(proc.readOutput().delta).toBe('')
  })
})

describe('cancellation against a hanging backend (fake backend, every platform)', () => {
  /** A subprocess service whose process runs until the test settles it and ignores the spawn signal. */
  class HangingSubprocessRuntime extends SubprocessRuntime {
    settle: (outcome: { exitCode: number | null; signal: NodeJS.Signals | null }) => void = () => {}
    override async terminalEnvironment(): Promise<never> { throw new Error('fixture does not open terminals') }
    override async resolveExecutable(command: string): Promise<string> { return command }
    override spawnTerminal(): Promise<never> { throw new Error('pwsh spawns pipes, never terminals') }
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

  async function bench() {
    const ctx = createContext()
    const subprocess = new HangingSubprocessRuntime(ctx)
    await ctx.plugin(PwshLocalExecutor)
    return { ctx, subprocess }
  }

  it('relays a caller signal that was already aborted: aborted classification', async () => {
    const { ctx, subprocess } = await bench()
    const controller = new AbortController()
    controller.abort()
    const ex = (await ctx.shell.execute(ctx.shell.resolve({ command: 'Start-Sleep 30', timeoutMs: 20, signal: controller.signal })))
    subprocess.settle({ exitCode: null, signal: 'SIGTERM' })
    const result = await ex.result()
    expect(ex.status).toBe('killed')
    expect(result.aborted).toBe(true)
    expect(result.timedOut).toBe(false)
  })

  it('a caller abort before the deadline stays the first cause when the process outlives the deadline', async () => {
    const { ctx, subprocess } = await bench()
    const controller = new AbortController()
    const ex = (await ctx.shell.execute(ctx.shell.resolve({ command: 'Start-Sleep 30', timeoutMs: 20, signal: controller.signal })))
    controller.abort()
    // The fake ignores the relayed abort, so the process outlives the deadline the way a real one does inside its termination grace.
    await new Promise(resolve => setTimeout(resolve, 40))
    subprocess.settle({ exitCode: null, signal: 'SIGTERM' })
    const result = await ex.result()
    expect(result.aborted).toBe(true)
    expect(result.timedOut).toBe(false)
  })
})

describe.skipIf(!hasPwsh)('PwshLocalExecutor.run', () => {
  it('resolves with output and the effective timeout', { timeout: 15_000 }, async () => {
    const { bash } = await setup({ timeoutMs: 10_000 })
    const result = await run(bash, bash.resolve({ command: 'Write-Output hi' }))
    expect(result.exitCode).toBe(0)
    expect(lf(result.stdout.text)).toBe('hi\n')
    expect(result.timeoutMs).toBe(10_000)
  })

  it('uses config cwd, overridable per call', async () => {
    const first = mkdtempSync(join(tmpdir(), 'dsh-pwsh-cwd-a-'))
    const second = mkdtempSync(join(tmpdir(), 'dsh-pwsh-cwd-b-'))
    tempDirs.push(first, second)
    const { bash } = await setup({ cwd: first })
    const fromConfig = await run(bash, bash.resolve({ command: '(Get-Location).Path' }))
    expect(samePath(fromConfig.stdout.text.trim(), first)).toBe(true)
    const fromCall = await run(bash, bash.resolve({ command: '(Get-Location).Path', workdir: second }))
    expect(samePath(fromCall.stdout.text.trim(), second)).toBe(true)
  })

  it('defaults cwd to process.cwd()', async () => {
    const { bash } = await setup()
    const result = await run(bash, bash.resolve({ command: '(Get-Location).Path' }))
    expect(samePath(result.stdout.text.trim(), process.cwd())).toBe(true)
  })

  it('caps per-call timeouts at maxTimeoutMs', async () => {
    const { bash } = await setup({ timeoutMs: 1_000, maxTimeoutMs: 2_000 })
    const result = await run(bash, bash.resolve({ command: 'Write-Output ok', timeoutMs: 99_999 }))
    expect(result.timeoutMs).toBe(2_000)
  })

  it('rejects unusable numeric config at the next command and invalid timeout overrides at resolve', async () => {
    for (const [config, field] of [
      [{ timeoutMs: Number.NaN }, /timeoutMs/], [{ maxTimeoutMs: 0 }, /maxTimeoutMs/], [{ maxOutputBytes: -1 }, /maxOutputBytes/],
      [{ maxSpillBytes: 0 }, /maxSpillBytes/], [{ graceMs: 0 }, /graceMs/],
      [{ graceMs: MAX_TIMER_DELAY_MS + 1 }, `graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`],
    ] as const) {
      const { bash: unusable } = await setup(config)
      expect(() => unusable.resolve({ command: 'Write-Output ok' })).toThrow(field)
    }

    const { bash } = await setup()
    expect(() => bash.resolve({ command: 'Write-Output ok', timeoutMs: Number.NaN })).toThrow(/request\.timeoutMs/)
    expect(() => bash.resolve({ command: 'Write-Output ok', timeoutMs: -1 })).toThrow(/request\.timeoutMs/)
    expect(() => bash.resolve({ command: 'Write-Output ok', stdoutMaxBytes: Number.NaN })).toThrow(/request\.stdoutMaxBytes/)
    expect(() => bash.resolve({ command: 'Write-Output ok', stdoutMaxBytes: -1 })).toThrow(/request\.stdoutMaxBytes/)
  })

  it('defaults stdoutMaxBytes to maxOutputBytes and lets foreground callers raise stdout only', async () => {
    const { bash } = await setup({ maxOutputBytes: 100 })
    expect(bash.resolve({ command: 'Write-Output ok' }).stdoutMaxBytes).toBe(100)

    // Raw Console writes avoid PowerShell's own line-ending and formatting
    // layers, so the byte counts are exact on every platform.
    const result = await run(bash, bash.resolve({
      command: '[Console]::Out.Write("x" * 500); [Console]::Error.WriteLine("e" * 500)',
      stdoutMaxBytes: 500,
    }))

    expect(result.stdout.text).toBe('x'.repeat(500))
    expect(result.stdout.truncated).toBe(false)
    expect(result.stderr.truncated).toBe(true)
    expect(result.stderr.text.length).toBeLessThanOrEqual(100)
  })

  it('per-call timeout takes precedence under the cap and kills on expiry', async () => {
    const { bash } = await setup({ timeoutMs: 60_000 })
    const result = await run(bash, bash.resolve({ command: 'Start-Sleep -Seconds 60', timeoutMs: 100 }))
    expect(result.timedOut).toBe(true)
    // Mutually exclusive: a timeout classifies as timedOut, never also aborted.
    expect(result.aborted).toBe(false)
    expect(result.timeoutMs).toBe(100)
  })

  it('propagates abort signals', async () => {
    const { bash } = await setup()
    const controller = new AbortController()
    const pending = run(bash, bash.resolve({ command: 'Start-Sleep -Seconds 60', signal: controller.signal }))
    setTimeout(() => { controller.abort() }, 50)
    const result = await pending
    expect(result.aborted).toBe(true)
    // Mutually exclusive: an upstream cancel classifies as aborted, never also timedOut.
    expect(result.timedOut).toBe(false)
  })

  it('classifies a self-killed command as neither timed out nor aborted', async () => {
    const { bash } = await setup({ timeoutMs: 60_000 })
    const result = await run(bash, bash.resolve({ command: 'Stop-Process -Id $PID' }))
    expect(result.timedOut).toBe(false)
    expect(result.aborted).toBe(false)
    // Windows reports a forced termination without a signal; POSIX reports the
    // terminating signal PowerShell chose (SIGTERM, or SIGKILL for the hard kill).
    if (process.platform === 'win32') {
      expect(result.signal).toBeNull()
    } else {
      expect(['SIGTERM', 'SIGKILL']).toContain(result.signal)
    }
  })

  it('rejects on spawn failure (bad workdir)', async () => {
    const { bash } = await setup()
    await expect(run(bash, bash.resolve({ command: 'Write-Output ok', workdir: '/nonexistent-dsh' }))).rejects.toThrow(/ENOENT/)
  })

  it('resolve() carries stdin/env/dshEnv onto the spec, and run() threads them to the command', async () => {
    const { bash } = await setup()
    const spec = bash.resolve({
      command: '$s = ([Console]::In.ReadToEnd()).TrimEnd(); Write-Output $s; Write-Output "[$env:SEAM_VAR][$env:DSH_SEAM_VAR]"',
      stdin: 'piped\n',
      env: { SEAM_VAR: 'env-ok' },
      dshEnv: { DSH_SEAM_VAR: 'dsh-ok' },
    })
    // resolve() keeps the optional input/environment fields verbatim.
    expect(spec.stdin).toBe('piped\n')
    expect(spec.env).toEqual({ SEAM_VAR: 'env-ok' })
    expect(spec.dshEnv).toEqual({ DSH_SEAM_VAR: 'dsh-ok' })
    const result = await run(bash, spec)
    expect(lf(result.stdout.text)).toBe('piped\n[env-ok][dsh-ok]\n')
  })

  it('resolve() omits stdin/env/dshEnv when the request supplies none', async () => {
    const { bash } = await setup()
    const spec = bash.resolve({ command: 'Write-Output ok' })
    expect('stdin' in spec).toBe(false)
    expect('env' in spec).toBe(false)
    expect('dshEnv' in spec).toBe(false)
  })
})

describe.skipIf(!hasPwsh)('PwshLocalExecutor.start (background process handles)', () => {
  it('start returns immediately with a running handle that settles as completed', async ({ task }) => {
    const { bash } = await setup()
    const barrier = commandBarrier()
    const proc = (await start(bash, bash.resolve({
      command: `Write-Output ready; [Console]::Out.Flush(); ${barrier.command}; Write-Output done`,
      env: barrier.env,
    })))
    expect(proc.status).toBe('running')
    expect(await readUntil(proc, 'ready\n', task.timeout)).toBe('ready\n')
    expect(proc.status).toBe('running')
    barrier.release()
    await proc.done
    expect(proc.status).toBe('completed')
    expect(proc.signal).toBeNull()
    expect(proc.exitCode).toBe(0)
    expect(lf(proc.readOutput().delta)).toBe('done\n')
  })

  it('threads stdin and extra env into a background process', async () => {
    const { bash } = await setup()
    const proc = (await start(bash, bash.resolve({
      command: '$s = ([Console]::In.ReadToEnd()).TrimEnd(); Write-Output $s; Write-Output "[$env:BG_VAR][$env:DSH_BG_VAR]"',
      stdin: 'bg-stdin\n',
      env: { BG_VAR: 'bg-env' },
      dshEnv: { DSH_BG_VAR: 'bg-dsh-env' },
    })))
    await proc.done
    expect(proc.status).toBe('completed')
    expect(proc.signal).toBeNull()
    expect(proc.exitCode).toBe(0)
    expect(lf(proc.readOutput().delta)).toBe('bg-stdin\n[bg-env][bg-dsh-env]\n')
  })

  it('readOutput is consuming: increments are never re-delivered, and reads stay valid after exit', async ({ task }) => {
    const { bash } = await setup()
    const barrier = commandBarrier()
    const proc = (await start(bash, bash.resolve({
      command: `Write-Output first; [Console]::Out.Flush(); ${barrier.command}; Write-Output second`,
      env: barrier.env,
    })))
    const first = await readUntil(proc, 'first\n', task.timeout)
    expect(first).toBe('first\n')
    expect(proc.status).toBe('running')
    expect(proc.readOutput().delta).toBe('')
    barrier.release()
    await proc.done
    expect(proc.status).toBe('completed')
    expect(proc.exitCode).toBe(0)
    // Read-after-exit returns the remaining buffered output — once.
    const second = proc.readOutput()
    expect(lf(second.delta)).toBe('second\n')
    expect(second.lossy).toBe(false)
    expect(proc.readOutput().delta).toBe('')
  })

  it('readOutput marks stderr sections', async () => {
    const { bash } = await setup()
    const proc = (await start(bash, bash.resolve({ command: 'Write-Output out; [Console]::Error.WriteLine("err")' })))
    await proc.done
    expect(lf(proc.readOutput().delta)).toBe('out\n[stderr]\nerr\n')
  })

  it('readOutput reports stderr-only deltas without a leading newline', async () => {
    const { bash } = await setup()
    const proc = (await start(bash, bash.resolve({ command: '[Console]::Error.WriteLine("err")' })))
    await proc.done
    expect(lf(proc.readOutput().delta)).toBe('[stderr]\nerr\n')
  })

  it('readOutput adds a separator only when stdout lacks a trailing newline', async () => {
    const { bash } = await setup()
    const proc = (await start(bash, bash.resolve({ command: '[Console]::Out.Write("out"); [Console]::Error.WriteLine("err")' })))
    await proc.done
    expect(lf(proc.readOutput().delta)).toBe('out\n[stderr]\nerr\n')
  })

  it('readOutput flags lossy reads and reports stdout spill paths', async () => {
    const { bash } = await setup({ maxOutputBytes: 100 })
    const proc = (await start(bash, bash.resolve({ command: '1..100 | ForEach-Object { "line-$_" }' })))
    await proc.done
    const read = proc.readOutput()
    // Window slid past offset 0 → lossy, spill path points at the full stream.
    expect(read.lossy).toBe(true)
    expect(read.stdoutSpillPath).toBeDefined()
  })

  it('readOutput reports stderr spill paths', async () => {
    const { bash } = await setup({ maxOutputBytes: 100 })
    const proc = (await start(bash, bash.resolve({ command: '1..100 | ForEach-Object { [Console]::Error.WriteLine("line-$_") }' })))
    await proc.done
    const read = proc.readOutput()
    expect(read.lossy).toBe(true)
    expect(read.stderrSpillPath).toBeDefined()
    expect(lf(read.delta)).toContain('[stderr]')
  })

  it('kill() requests managed-range termination: true once, false after settlement', async () => {
    const { bash } = await setup()
    const proc = (await start(bash, bash.resolve({ command: 'Start-Sleep -Seconds 60' })))
    expect(proc.kill()).toBe(true)
    await proc.done
    expect(proc.status).toBe('killed')
    expect(proc.kill()).toBe(false)
  })

  it('kill() returns false for a naturally completed process', async () => {
    const { bash } = await setup()
    const proc = (await start(bash, bash.resolve({ command: 'Write-Output ok' })))
    await proc.done
    expect(proc.status).toBe('completed')
    expect(proc.kill()).toBe(false)
  })

  it('a spec.signal abort settles the handle as killed, not completed', async () => {
    const { bash } = await setup()
    const controller = new AbortController()
    const proc = (await start(bash, bash.resolve({ command: 'Start-Sleep -Seconds 60', signal: controller.signal })))
    controller.abort()
    await proc.done
    expect(proc.status).toBe('killed')
  })

  it.skipIf(process.platform === 'win32')('a self-signal exit settles the handle as killed, not completed (POSIX)', async () => {
    const { bash } = await setup()
    const proc = (await start(bash, bash.resolve({ command: 'Stop-Process -Id $PID' })))
    await proc.done
    expect(proc.status).toBe('killed')
    expect(proc.exitCode).toBeNull()
    // PowerShell picks SIGTERM for Stop-Process, SIGKILL for the hard kill.
    expect(['SIGTERM', 'SIGKILL']).toContain(proc.signal)
  })

  it('an asynchronous creation failure settles as killed with a stage-neutral note', async () => {
    const { bash } = await setup()
    const proc = (await start(bash, bash.resolve({ command: 'Write-Output ok', workdir: '/nonexistent-dsh' })))
    // done resolves (never rejects) even though the process never ran.
    await expect(proc.done).resolves.toBeUndefined()
    expect(proc.status).toBe('killed')
    expect(proc.readOutput().delta).toContain('subprocess failed before reporting an outcome:')
  })

  it('a SYNCHRONOUS spawn throw is contained, and the observed stderr serves the note', async () => {
    const { ctx, bash } = await setup()
    vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(() => { throw new Error('sync spawn boom') })
    const proc = (await start(bash, bash.resolve({ command: 'Write-Output never' })))
    await expect(proc.done).resolves.toBeUndefined()
    expect(proc.status).toBe('killed')
    // The process never ran, so observers read the note as the whole stderr
    // stream at their own offsets and stdout stays empty.
    const note = 'subprocess failed before reporting an outcome: Error: sync spawn boom'
    const first = proc.observed.stderr.readFrom(0)
    expect(first).toEqual({ text: note, nextOffset: Buffer.byteLength(note, 'utf8'), lossy: false })
    expect(proc.observed.stderr.readFrom(first.nextOffset)).toEqual({ text: '', nextOffset: first.nextOffset, lossy: false })
    expect(proc.observed.stdout.readFrom(0)).toEqual({ text: '', lossy: false, nextOffset: 0 })
    // The consuming read folds the same note in exactly once.
    expect(proc.readOutput().delta).toBe(`[stderr]\n${note}`)
    expect(proc.readOutput().delta).toBe('')
  })
})

describe.skipIf(!hasPwsh)('execute() projections under none policy', () => {
  it('classifies a no-deadline execution: clean settle, then an aborted one', async () => {
    const { bash } = await setup()
    const clean = (await start(bash, bash.resolve({ command: 'Write-Output bg' })))
    await clean.done
    await expect(clean.result()).resolves.toMatchObject({ exitCode: 0, timedOut: false, aborted: false })

    const controller = new AbortController()
    const killed = (await start(bash, bash.resolve({ command: 'Start-Sleep -Seconds 30', signal: controller.signal })))
    controller.abort()
    await killed.done
    await expect(killed.result()).resolves.toMatchObject({ timedOut: false, aborted: true })
  })
})

describe.skipIf(!hasPwsh)('process lifecycle ownership (the subprocess service, not the executor)', () => {
  it('a background process survives executor-fiber disposal and dies with the subprocess service', async ({ task }) => {
    const ctx = createContext()
    const managerFiber = await ctx.plugin(LocalSubprocessRuntime)
    ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
    const executorFiber = await ctx.plugin(PwshLocalExecutor, { graceMs: 200 })
    const bash = ctx.shell as PwshLocalExecutor

    // The child prints its own pid so the test can probe liveness through the
    // public read surface alone.
    const proc = (await start(bash, bash.resolve({ command: 'Write-Output $PID; Start-Sleep -Seconds 60' })))
    const pid = Number((await readUntil(proc, '\n', task.timeout)).trim())
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
    // Service disposal confirmed the tree is gone (kill(pid,0) throws above).
    // On POSIX the stamp depends on whether the shell traps SIGTERM and exits
    // cleanly (completed) or is killed by the signal (killed); Windows forced
    // termination (taskkill, no signals) also stamps completed. Both mean the
    // process no longer survives the service.
    expect(['killed', 'completed']).toContain(proc.status)
  })

  it('service disposal settles running handles and leaves settled ones untouched', async () => {
    const ctx = createContext()
    const managerFiber = await ctx.plugin(LocalSubprocessRuntime)
    ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
    await ctx.plugin(PwshLocalExecutor, { graceMs: 200 })
    const bash = ctx.shell as PwshLocalExecutor

    const finished = (await start(bash, bash.resolve({ command: 'Write-Output done' })))
    await finished.done
    expect(finished.status).toBe('completed')
    const running = (await start(bash, bash.resolve({ command: 'Start-Sleep -Seconds 60' })))

    await managerFiber.dispose()
    // A settled process was untouched; the live one was terminated and joined.
    expect(finished.status).toBe('completed')
    await running.done
    // The live handle was terminated and joined; on POSIX the stamp depends
    // on whether the shell traps SIGTERM and exits cleanly (completed) or is
    // killed by the signal (killed); Windows forced termination (taskkill, no
    // signals) also stamps completed. Both mean the process no longer
    // survives the service.
    expect(['killed', 'completed']).toContain(running.status)
  })
})
