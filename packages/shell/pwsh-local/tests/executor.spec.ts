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
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { PwshLocalExecutor, ENCODING_PREAMBLE, candidatePwshPaths, resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle, SubprocessOutcome, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { ShellProcess } from '@deepseek-ai/dsh-shell'

const spillDir = mkdtempSync(join(tmpdir(), 'dsh-pwsh-exec-spec-'))

afterAll(() => {
  rmSync(spillDir, { recursive: true, force: true })
})

/** Per-test temp dirs, removed after each test. */
const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

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

async function setup(config: ConstructorParameters<typeof PwshLocalExecutor>[1] = {}) {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocessRuntime)
  ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
  // A short kill grace via the REAL config path, so escalation tests stay fast.
  await ctx.plugin(PwshLocalExecutor, { graceMs: 200, ...config })
  const bash = ctx.shell as PwshLocalExecutor
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
    if (lf(all).includes(expected)) return lf(all)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`process output did not include ${JSON.stringify(expected)}; accumulated ${JSON.stringify(lf(all))}`)
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
    const ctx = new Context()
    const subprocess = new CapturingSubprocessRuntime(ctx)
    await ctx.plugin(PwshLocalExecutor)
    await ctx.shell.run(ctx.shell.resolve({ command: 'Write-Output 你好' }))
    expect(subprocess.specs).toHaveLength(1)
    const { argv } = subprocess.specs[0]!
    expect(argv.slice(0, 5)).toEqual([expect.any(String), '-NoLogo', '-NoProfile', '-NonInteractive', '-Command'])
    expect(argv[5]).toBe(`${ENCODING_PREAMBLE}Write-Output 你好`)
    expect(ENCODING_PREAMBLE).toContain('[Console]::OutputEncoding')
    expect(ENCODING_PREAMBLE).toContain('$OutputEncoding')
  })

  it('reports both unread stderr and an asynchronous provider rejection exactly once', async () => {
    const ctx = new Context()
    const subprocess = new CapturingSubprocessRuntime(ctx)
    await ctx.plugin(PwshLocalExecutor)
    subprocess.stderrText = 'target stderr'
    subprocess.done = Promise.reject(new Error('provider lost the direct outcome'))

    const proc = ctx.shell.start(ctx.shell.resolve({ command: 'Write-Output maybe-ran' }))
    await expect(proc.done).resolves.toBeUndefined()
    expect(proc.status).toBe('killed')
    const output = proc.readOutput().delta
    expect(output).toContain('target stderr')
    expect(output).toContain('subprocess failed before reporting an outcome:')
    expect(output).not.toContain('spawn failed:')
    expect(proc.readOutput().delta).toBe('')
  })

  it('settles an unprintable provider rejection instead of rejecting done', async () => {
    const ctx = new Context()
    const subprocess = new CapturingSubprocessRuntime(ctx)
    await ctx.plugin(PwshLocalExecutor)
    const providerError = new Error('unprintable provider error')
    Object.defineProperty(providerError, Symbol.toPrimitive, {
      value: () => { throw new Error('provider formatting must not escape') },
    })
    subprocess.done = Promise.reject(providerError)

    const proc = ctx.shell.start(ctx.shell.resolve({ command: 'Write-Output maybe-ran' }))
    await expect(proc.done).resolves.toBeUndefined()
    expect(proc.status).toBe('killed')
    expect(proc.readOutput().delta).toContain('unprintable provider failure')
    expect(proc.readOutput().delta).toBe('')
  })

  it('preserves an explicit kill stamp and maps an aborted direct outcome to killed', async () => {
    const ctx = new Context()
    const subprocess = new CapturingSubprocessRuntime(ctx)
    await ctx.plugin(PwshLocalExecutor)

    const killedOutcome = Promise.withResolvers<SubprocessOutcome>()
    subprocess.done = killedOutcome.promise
    const killed = ctx.shell.start(ctx.shell.resolve({ command: 'Write-Output maybe-ran' }))
    expect(killed.kill()).toBe(true)
    killedOutcome.resolve({ exitCode: 0, signal: null })
    await killed.done
    expect(killed.status).toBe('killed')
    expect(killed.exitCode).toBe(0)

    const abortedOutcome = Promise.withResolvers<SubprocessOutcome>()
    subprocess.done = abortedOutcome.promise
    const controller = new AbortController()
    const aborted = ctx.shell.start(ctx.shell.resolve({
      command: 'Write-Output maybe-ran',
      signal: controller.signal,
    }))
    controller.abort()
    abortedOutcome.resolve({ exitCode: 0, signal: null })
    await aborted.done
    expect(aborted.status).toBe('killed')
  })
})

describe.skipIf(!hasPwsh)('PwshLocalExecutor.run', () => {
  it('resolves with output and the effective timeout', { timeout: 15_000 }, async () => {
    const { bash } = await setup({ timeoutMs: 10_000 })
    const result = await bash.run(bash.resolve({ command: 'Write-Output hi' }))
    expect(result.exitCode).toBe(0)
    expect(lf(result.stdout.text)).toBe('hi\n')
    expect(result.timeoutMs).toBe(10_000)
  })

  it('uses config cwd, overridable per call', async () => {
    const first = mkdtempSync(join(tmpdir(), 'dsh-pwsh-cwd-a-'))
    const second = mkdtempSync(join(tmpdir(), 'dsh-pwsh-cwd-b-'))
    tempDirs.push(first, second)
    const { bash } = await setup({ cwd: first })
    const fromConfig = await bash.run(bash.resolve({ command: '(Get-Location).Path' }))
    expect(samePath(fromConfig.stdout.text.trim(), first)).toBe(true)
    const fromCall = await bash.run(bash.resolve({ command: '(Get-Location).Path', workdir: second }))
    expect(samePath(fromCall.stdout.text.trim(), second)).toBe(true)
  })

  it('defaults cwd to process.cwd()', async () => {
    const { bash } = await setup()
    const result = await bash.run(bash.resolve({ command: '(Get-Location).Path' }))
    expect(samePath(result.stdout.text.trim(), process.cwd())).toBe(true)
  })

  it('caps per-call timeouts at maxTimeoutMs', async () => {
    const { bash } = await setup({ timeoutMs: 1_000, maxTimeoutMs: 2_000 })
    const result = await bash.run(bash.resolve({ command: 'Write-Output ok', timeoutMs: 99_999 }))
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
    const result = await bash.run(bash.resolve({
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
    const result = await bash.run(bash.resolve({ command: 'Start-Sleep -Seconds 60', timeoutMs: 100 }))
    expect(result.timedOut).toBe(true)
    // Mutually exclusive: a timeout classifies as timedOut, never also aborted.
    expect(result.aborted).toBe(false)
    expect(result.timeoutMs).toBe(100)
  })

  it('propagates abort signals', async () => {
    const { bash } = await setup()
    const controller = new AbortController()
    const pending = bash.run(bash.resolve({ command: 'Start-Sleep -Seconds 60', signal: controller.signal }))
    setTimeout(() => { controller.abort() }, 50)
    const result = await pending
    expect(result.aborted).toBe(true)
    // Mutually exclusive: an upstream cancel classifies as aborted, never also timedOut.
    expect(result.timedOut).toBe(false)
  })

  it('classifies a self-killed command as neither timed out nor aborted', async () => {
    const { bash } = await setup({ timeoutMs: 60_000 })
    const result = await bash.run(bash.resolve({ command: 'Stop-Process -Id $PID' }))
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
    await expect(bash.run(bash.resolve({ command: 'Write-Output ok', workdir: '/nonexistent-dsh' }))).rejects.toThrow(/ENOENT/)
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
    const result = await bash.run(spec)
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
  it('start returns immediately with a running handle that settles as completed', async () => {
    const { bash } = await setup()
    const before = Date.now()
    // The sleep outlasts any realistic spawn latency, so returning while the
    // child still sleeps proves start() does not wait for completion.
    const proc = bash.start(bash.resolve({ command: 'Start-Sleep -Milliseconds 2000; Write-Output done' }))
    expect(Date.now() - before).toBeLessThan(1000)
    expect(proc.status).toBe('running')
    await proc.done
    expect(proc.status).toBe('completed')
    expect(proc.exitCode).toBe(0)
  })

  it('threads stdin and extra env into a background process', async () => {
    const { bash } = await setup()
    const proc = bash.start(bash.resolve({
      command: '$s = ([Console]::In.ReadToEnd()).TrimEnd(); Write-Output $s; Write-Output "[$env:BG_VAR][$env:DSH_BG_VAR]"',
      stdin: 'bg-stdin\n',
      env: { BG_VAR: 'bg-env' },
      dshEnv: { DSH_BG_VAR: 'bg-dsh-env' },
    }))
    const partialOutput = await readUntil(proc, '[bg-env][bg-dsh-env]')
    await proc.done
    const output = partialOutput + lf(proc.readOutput().delta)
    expect(output).toBe('bg-stdin\n[bg-env][bg-dsh-env]\n')
    expect(proc.exitCode).toBe(0)
  })

  it('readOutput is consuming: increments are never re-delivered, and reads stay valid after exit', async () => {
    const { bash } = await setup()
    const proc = bash.start(bash.resolve({ command: 'Write-Output first; Start-Sleep -Seconds 1; Write-Output second' }))
    const first = await readUntil(proc, 'first\n')
    expect(lf(first)).toBe('first\n')
    await proc.done
    // Read-after-exit returns the remaining buffered output — once.
    const second = proc.readOutput()
    expect(lf(second.delta)).toBe('second\n')
    expect(second.lossy).toBe(false)
    expect(proc.readOutput().delta).toBe('')
  })

  it('readOutput marks stderr sections', async () => {
    const { bash } = await setup()
    const proc = bash.start(bash.resolve({ command: 'Write-Output out; [Console]::Error.WriteLine("err")' }))
    await proc.done
    expect(lf(proc.readOutput().delta)).toBe('out\n[stderr]\nerr\n')
  })

  it('readOutput reports stderr-only deltas without a leading newline', async () => {
    const { bash } = await setup()
    const proc = bash.start(bash.resolve({ command: '[Console]::Error.WriteLine("err")' }))
    await proc.done
    expect(lf(proc.readOutput().delta)).toBe('[stderr]\nerr\n')
  })

  it('readOutput adds a separator only when stdout lacks a trailing newline', async () => {
    const { bash } = await setup()
    const proc = bash.start(bash.resolve({ command: '[Console]::Out.Write("out"); [Console]::Error.WriteLine("err")' }))
    await proc.done
    expect(lf(proc.readOutput().delta)).toBe('out\n[stderr]\nerr\n')
  })

  it('readOutput flags lossy reads and reports stdout spill paths', async () => {
    const { bash } = await setup({ maxOutputBytes: 100 })
    const proc = bash.start(bash.resolve({ command: '1..100 | ForEach-Object { "line-$_" }' }))
    await proc.done
    const read = proc.readOutput()
    // Window slid past offset 0 → lossy, spill path points at the full stream.
    expect(read.lossy).toBe(true)
    expect(read.stdoutSpillPath).toBeDefined()
  })

  it('readOutput reports stderr spill paths', async () => {
    const { bash } = await setup({ maxOutputBytes: 100 })
    const proc = bash.start(bash.resolve({ command: '1..100 | ForEach-Object { [Console]::Error.WriteLine("line-$_") }' }))
    await proc.done
    const read = proc.readOutput()
    expect(read.lossy).toBe(true)
    expect(read.stderrSpillPath).toBeDefined()
    expect(lf(read.delta)).toContain('[stderr]')
  })

  it('kill() requests managed-range termination: true once, false after settlement', async () => {
    const { bash } = await setup()
    const proc = bash.start(bash.resolve({ command: 'Start-Sleep -Seconds 60' }))
    expect(proc.kill()).toBe(true)
    await proc.done
    expect(proc.status).toBe('killed')
    expect(proc.kill()).toBe(false)
  })

  it('kill() returns false for a naturally completed process', async () => {
    const { bash } = await setup()
    const proc = bash.start(bash.resolve({ command: 'Write-Output ok' }))
    await proc.done
    expect(proc.status).toBe('completed')
    expect(proc.kill()).toBe(false)
  })

  it('a spec.signal abort settles the handle as killed, not completed', async () => {
    const { bash } = await setup()
    const controller = new AbortController()
    const proc = bash.start(bash.resolve({ command: 'Start-Sleep -Seconds 60', signal: controller.signal }))
    controller.abort()
    await proc.done
    expect(proc.status).toBe('killed')
  })

  it.skipIf(process.platform === 'win32')('a self-signal exit settles the handle as killed, not completed (POSIX)', async () => {
    const { bash } = await setup()
    const proc = bash.start(bash.resolve({ command: 'Stop-Process -Id $PID' }))
    await proc.done
    expect(proc.status).toBe('killed')
    expect(proc.exitCode).toBeNull()
    // PowerShell picks SIGTERM for Stop-Process, SIGKILL for the hard kill.
    expect(['SIGTERM', 'SIGKILL']).toContain(proc.signal)
  })

  it('an asynchronous creation failure settles as killed with a stage-neutral note', async () => {
    const { bash } = await setup()
    const proc = bash.start(bash.resolve({ command: 'Write-Output ok', workdir: '/nonexistent-dsh' }))
    // done resolves (never rejects) even though the process never ran.
    await expect(proc.done).resolves.toBeUndefined()
    expect(proc.status).toBe('killed')
    expect(proc.readOutput().delta).toContain('subprocess failed before reporting an outcome:')
  })
})

describe.skipIf(!hasPwsh)('process lifecycle ownership (the subprocess service, not the executor)', () => {
  it('a background process survives executor-fiber disposal and dies with the subprocess service', async () => {
    const ctx = new Context()
    const managerFiber = await ctx.plugin(LocalSubprocessRuntime)
    ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
    const executorFiber = await ctx.plugin(PwshLocalExecutor, { graceMs: 200 })
    const bash = ctx.shell as PwshLocalExecutor

    // The child prints its own pid so the test can probe liveness through the
    // public read surface alone.
    const proc = bash.start(bash.resolve({ command: 'Write-Output $PID; Start-Sleep -Seconds 60' }))
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
    // Service disposal confirmed the tree is gone (kill(pid,0) throws above).
    // On POSIX the stamp depends on whether the shell traps SIGTERM and exits
    // cleanly (completed) or is killed by the signal (killed); Windows forced
    // termination (taskkill, no signals) also stamps completed. Both mean the
    // process no longer survives the service.
    expect(['killed', 'completed']).toContain(proc.status)
  })

  it('service disposal settles running handles and leaves settled ones untouched', async () => {
    const ctx = new Context()
    const managerFiber = await ctx.plugin(LocalSubprocessRuntime)
    ;(ctx.subprocess as LocalSubprocessRuntime).internals = { spillDir }
    await ctx.plugin(PwshLocalExecutor, { graceMs: 200 })
    const bash = ctx.shell as PwshLocalExecutor

    const finished = bash.start(bash.resolve({ command: 'Write-Output done' }))
    await finished.done
    expect(finished.status).toBe('completed')
    const running = bash.start(bash.resolve({ command: 'Start-Sleep -Seconds 60' }))

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
