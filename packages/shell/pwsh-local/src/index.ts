/**
 * Local PowerShell Service Provider for the bash capability seam. Each command runs
 * as `pwsh -NoLogo -NoProfile -NonInteractive -Command <command>` in a managed
 * process spawned through `ctx.subprocess`; the executor owns command
 * defaulting, deadlines and cause classification, the model-friendly terminal
 * environment, and the model-facing stdout/stderr merge for background reads.
 *
 * The command string is passed as ONE argv element to `-Command`: PowerShell
 * itself parses the text, and no intermediate shell exists, so there is no
 * shell-quoting layer to escape (the `bash -c` string domain has no
 * equivalent here). Native Win32 paths (`C:\...`) pass through unchanged.
 *
 * @module @deepseek-ai/dsh-pwsh-local
 */

/* jscpd:ignore-start -- this executor mirrors dsh-bash-local call-for-call by
   design (see this package's README), so the two import the same seam surface */
import type { Volatile } from '@deepseek-ai/cordis'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import type { CollectedOutput, ShellExecRequest, ShellExecSpec, ShellExecution, ShellProcess, ShellProcessRead, ShellRunResult } from '@deepseek-ai/dsh-shell'
import type { SubprocessCollect, SubprocessHandle, SubprocessOutputReader, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import { clampTimeout, deadline, MAX_TIMER_DELAY_MS, timeoutOf } from '@deepseek-ai/dsh-timeout'
/* jscpd:ignore-end */
import { resolvePwshPath } from './resolve.ts'

/* jscpd:ignore-start -- deliberate call-for-call mirror of dsh-bash-local (Agent Note: pwsh-tool-and-executor). */
/**
 * Model-friendly environment overrides for PowerShell: disable colors and
 * pagers that would garble tool output. `TERM=dumb` is a POSIX concept and is
 * deliberately absent; `NO_COLOR` is honored by modern pwsh renderers.
 */
export const ENV_OVERRIDES = {
  NO_COLOR: '1',
  PAGER: 'cat',
  GIT_PAGER: 'cat',
} as const

/**
 * UTF-8 output pinning prepended to every command. The subprocess collector
 * decodes output bytes as UTF-8, but Windows PowerShell 5.1 (the last-resort
 * executable fallback) writes the console/OEM code page by default, which
 * garbles non-ASCII output; pwsh 7 defaults to UTF-8 and is unaffected. The
 * statements ride on line 1 after `; ` separators so PowerShell error line
 * numbers stay accurate.
 */
export const ENCODING_PREAMBLE =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); '

/** Default SIGTERM→SIGKILL grace period (the `graceMs` config). */
const DEFAULT_GRACE_MS = 3_000

/** Default per-stream spill cap (the `maxSpillBytes` config). */
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024

/** Validated plugin configuration with live command budgets. */
export interface Config {
  /** Default working directory for commands (default: process.cwd()). */
  cwd: Volatile<string | undefined>
  /** Default foreground timeout in milliseconds. */
  timeoutMs: Volatile<number>
  /** Upper bound for per-call timeout overrides. */
  maxTimeoutMs: Volatile<number>
  /** Per-stream in-memory output cap; overflow spills to a temp file. */
  maxOutputBytes: Volatile<number>
  /** Per-stream spill-file cap; larger streams retain only their in-memory tail. */
  maxSpillBytes: Volatile<number>
  /** Grace period for kill escalation and inherited pipes; at most `MAX_TIMER_DELAY_MS`. */
  graceMs: Volatile<number>
  /**
   * Explicit pwsh executable. When omitted, well-known Windows install
   * locations and PATH entries are probed in order (PowerShell 7 install,
   * PATH entries such as the Microsoft Store install, then Windows
   * PowerShell 5.1), falling back to a bare `pwsh` resolved through PATH.
   */
  pwshPath: Volatile<string | undefined>
}

// Resolution lives in its own dependency-free module so the repository's
// coverage-gate probe shares the exact definition the suites use.
export { candidatePwshPaths, resolvePwshPath } from './resolve.ts'

/** Project a settled collect-mode reader into the final CollectedOutput shape. */
function finalOutput(reader: SubprocessOutputReader): CollectedOutput {
  const read = reader.readFrom(0)
  return {
    text: read.text,
    truncated: read.lossy,
    ...read.spillPath !== undefined ? { spillPath: read.spillPath } : {},
  }
}

function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`pwsh-local: ${name} must be a positive finite number`)
  }
}

/**
 * Reject a resolved section this executor could not run with. The schema
 * expresses neither "positive and finite" nor the timer bound `graceMs` has to
 * fit, so a stored value that cannot be used fails at the next command.
 * @param config - the live configuration, schema-valid by construction.
 * @throws Error naming the field that cannot be used.
 */
export function assertServiceablePwshConfig(config: Config): void {
  assertPositiveFinite('timeoutMs', config.timeoutMs.get())
  assertPositiveFinite('maxTimeoutMs', config.maxTimeoutMs.get())
  assertPositiveFinite('maxOutputBytes', config.maxOutputBytes.get())
  assertPositiveFinite('maxSpillBytes', config.maxSpillBytes.get())
  assertPositiveFinite('graceMs', config.graceMs.get())
  if (config.graceMs.get() > MAX_TIMER_DELAY_MS) {
    throw new Error(`pwsh-local: graceMs must be no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}

/**
 * Local PowerShell executor over `ctx.subprocess`. Bounded output, spill
 * files, and managed-range termination are the subprocess service's mechanics;
 * this executor supplies their configured budgets per spawn.
 */
export class PwshLocalExecutor extends ShellExecutor {
  static inject = ['subprocess']

  static Config = z.object({
    cwd: z.string().volatile(),
    timeoutMs: z.number().default(120_000).volatile(),
    maxTimeoutMs: z.number().default(600_000).volatile(),
    maxOutputBytes: z.number().default(64_000).volatile(),
    maxSpillBytes: z.number().default(DEFAULT_MAX_SPILL_BYTES).volatile(),
    graceMs: z.number().default(DEFAULT_GRACE_MS).volatile(),
    pwshPath: z.string().volatile(),
  })

  /** The declared executable the current {@link pwshPath} was resolved from. */
  private declaredPwshPath: string | undefined

  /** The pwsh executable resolved from the current config. */
  private resolvedPwshPath: string

  /** The pwsh executable every command runs through; a changed declared path is probed again on the next read. */
  get pwshPath(): string {
    const declared = this.config.pwshPath.get()
    if (declared !== this.declaredPwshPath) {
      this.resolvedPwshPath = resolvePwshPath(declared)
      this.declaredPwshPath = declared
    }
    return this.resolvedPwshPath
  }

  constructor(ctx: Context, readonly config: Config) {
    super(ctx)
    this.declaredPwshPath = config.pwshPath.get()
    this.resolvedPwshPath = resolvePwshPath(this.declaredPwshPath)
  }

  /**
   * Resolve a request into a fully-specified spec: fill `workdir` from
   * `config.cwd` (else `process.cwd()`), and `timeoutMs` from
   * `config.timeoutMs`, capped at `config.maxTimeoutMs`.
   */
  resolve(request: ShellExecRequest): ShellExecSpec {
    assertServiceablePwshConfig(this.config)
    const timeoutMs = clampTimeout(
      request.timeoutMs,
      this.config.timeoutMs.get(),
      this.config.maxTimeoutMs.get(),
      'pwsh-local: request.timeoutMs',
    )
    const stdoutMaxBytes = request.stdoutMaxBytes ?? this.config.maxOutputBytes.get()
    assertPositiveFinite('request.stdoutMaxBytes', stdoutMaxBytes)
    return {
      command: request.command,
      workdir: request.workdir ?? this.config.cwd.get() ?? process.cwd(),
      timeoutMs,
      onExpiry: request.onExpiry ?? 'kill',
      stdoutMaxBytes,
      ...request.signal ? { signal: request.signal } : {},
      ...request.stdin !== undefined ? { stdin: request.stdin } : {},
      ...request.env !== undefined ? { env: request.env } : {},
      ...request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {},
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  /**
   * The pwsh invocation argv for one resolved spec — the argv-level seam a
   * confining subclass wraps through `ctx.sandbox.confine` (the pwsh twin of
   * `dsh-bash-local`'s `executeArgv` hook; see
   * `@deepseek-ai/dsh-pwsh-sandbox`).
   */
  protected argv(spec: ShellExecSpec): string[] {
    return [this.pwshPath, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', `${ENCODING_PREAMBLE}${spec.command}`]
  }

  /** Map one resolved spec plus its argv onto a fully-specified subprocess spawn. */
  private spawnSpec(
    spec: ShellExecSpec,
    stdoutMaxBytes: number,
    signal: AbortSignal | undefined,
    argv: readonly string[],
  ): SubprocessSpawnSpec {
    const collect = (maxBytes: number): SubprocessCollect =>
      ({ maxBytes, spill: { maxBytes: this.config.maxSpillBytes.get() } })
    return {
      argv: [...argv],
      cwd: spec.workdir,
      stdio: {
        stdin: spec.stdin !== undefined ? { data: spec.stdin } : 'ignore',
        stdout: collect(stdoutMaxBytes),
        stderr: collect(this.config.maxOutputBytes.get()),
      },
      graceMs: this.config.graceMs.get(),
      signal,
      env: { ...ENV_OVERRIDES, ...spec.env, ...spec.dshEnv },
    }
  }

  /** The collect-mode readers the executor itself requested (present by construction). */
  private static collected(handle: SubprocessHandle): { stdout: SubprocessOutputReader; stderr: SubprocessOutputReader } {
    const { stdout, stderr } = handle.collected
    /* v8 ignore start -- collect dispositions expose both readers by the seam contract; defensive. */
    if (stdout === undefined || stderr === undefined) {
      throw new Error('pwsh-local: subprocess implementation dropped a requested collect stream')
    }
    /* v8 ignore stop */
    return { stdout, stderr }
  }

  async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    return this.executeArgv(spec, this.argv(spec))
  }

  /**
   * Execute an explicit argv with the lifecycle, environment, output,
   * deadline, and cancellation semantics of this executor. Subclasses use this
   * after replacing the public command's shell argv at an execution boundary.
   * @param spec - resolved execution settings and caller-owned command metadata.
   * @param argvOrPrepare - exact argv, or preparation using the execution cancellation signal.
   * @param onStarted - installs provider facts synchronously before the handle can settle.
   * @returns the live execution handle; spawn rejection settles the handle as
   *   killed while `result()` carries the same failure as its rejection.
   */
  protected async executeArgv(
    spec: ShellExecSpec,
    argvOrPrepare: readonly string[] | ((signal: AbortSignal) => Promise<readonly string[]>),
    onStarted?: (process: ShellExecution) => void,
  ): Promise<ShellExecution> {
    // Deadline wiring by expiry policy. Each arm supplies the spawn signal,
    // the result projection's first-cause classification, and the disarm the
    // settlement continuation runs. `ShellExpiryPolicy` has exactly these two
    // members, so the `else` arm is `'none'`.
    let spawnSignal: AbortSignal | undefined
    let classify: () => { timedOut: boolean; aborted: boolean }
    let disarm = (): void => {}
    if (spec.onExpiry === 'kill') {
      // One fused deadline combines timeout and upstream cancellation; only
      // this executor's timeout reason counts as timedOut, outer deadlines as aborts.
      const d = deadline(spec.signal, spec.timeoutMs, 'BASH_TIMEOUT')
      spawnSignal = d.signal
      classify = () => {
        const timedOut = timeoutOf(d.signal, 'BASH_TIMEOUT') !== undefined
        return { timedOut, aborted: d.signal.aborted && !timedOut }
      }
      disarm = () => { d[Symbol.dispose]() }
    } else {
      // No deadline: callers stop the process through kill() or spec.signal.
      spawnSignal = spec.signal
      classify = () => ({ timedOut: false, aborted: spec.signal?.aborted === true })
    }

    let argv: readonly string[] = []
    let preparationTimedOut = false
    if (typeof argvOrPrepare === 'function') {
      const signal = spawnSignal ?? new AbortController().signal
      const cancelled = Promise.withResolvers<never>()
      const abort = (): void => { cancelled.reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      try {
        argv = await Promise.race([
          Promise.resolve().then(() => { signal.throwIfAborted(); return argvOrPrepare(signal) }),
          cancelled.promise,
        ])
        signal.throwIfAborted()
      } catch (error) {
        if (!classify().timedOut) {
          disarm()
          throw error
        }
        preparationTimedOut = true
      } finally { signal.removeEventListener('abort', abort) }
    } else { argv = argvOrPrepare }

    // A synchronous spawn throw (pre-aborted signal, alternative subprocess
    // implementations) is contained into the same settled-killed shape as an
    // asynchronous spawn rejection, so execute() itself never throws for a
    // spawn problem and result() carries the failure uniformly.
    let running: SubprocessHandle | undefined
    let syncSpawnError: { error: unknown } | undefined
    try {
      if (!preparationTimedOut) {
        running = this.ctx.subprocess.spawn(this.spawnSpec(spec, spec.stdoutMaxBytes, spawnSignal, argv))
      }
    } catch (error) {
      syncSpawnError = { error }
    }
    const emptyReader: SubprocessOutputReader = {
      readFrom: () => ({ text: '', lossy: false, nextOffset: 0 }),
    }
    const collected = running !== undefined
      ? PwshLocalExecutor.collected(running)
      : { stdout: emptyReader, stderr: emptyReader }
    const spawnThrow = (): unknown => (syncSpawnError as { error: unknown }).error
    const spawned = preparationTimedOut
      ? Promise.resolve({ exitCode: null, signal: null })
      : running !== undefined ? running.done
      // The original throw is preserved for callers even when it was not an Error.
      // eslint-disable-next-line prefer-promise-reject-errors
        : Promise.reject(spawnThrow())

    // A provider rejection produces no process output, so the subprocess
    // service has nothing to buffer: once the provider rejected, its
    // stage-neutral note is the whole stderr stream for every reader. The
    // observed reader serves it at offset 0, the consuming read folds it in
    // exactly once, and the retained error is the result() projection's
    // rejection.
    let providerFailure: { error: unknown; note: string } | undefined
    let providerFailureReported = false
    const consumeProviderFailure = (): string => {
      if (providerFailure === undefined || providerFailureReported) return ''
      providerFailureReported = true
      return providerFailure.note
    }
    const observedStderr: SubprocessOutputReader = {
      readFrom: (fromByte) => {
        if (providerFailure === undefined) return collected.stderr.readFrom(fromByte)
        const note = Buffer.from(providerFailure.note, 'utf8')
        return { text: note.subarray(Math.min(fromByte, note.length)).toString('utf8'), nextOffset: note.length, lossy: false }
      },
    }

    let stdoutOffset = 0
    let stderrOffset = 0
    let resultPromise: Promise<ShellRunResult> | undefined
    const proc: ShellExecution = {
      status: 'running',
      exitCode: null,
      signal: null,
      observed: { stdout: collected.stdout, stderr: observedStderr },
      done: spawned.then((outcome) => {
        // Any signal termination is killed, including a command signaling itself.
        if (proc.status === 'running') {
          proc.status = spawnSignal?.aborted === true || outcome.signal !== null ? 'killed' : 'completed'
        }
        proc.exitCode = outcome.exitCode
        proc.signal = outcome.signal
        this.onProcessDone(proc, collected.stderr.readFrom(0).text, false)
        disarm()
      }, (error: unknown) => {
        // A live handle whose rejection follows this execution's own
        // termination — kill() or the spawn signal's abort — reports its
        // terminal outcome: a provider that terminated the range before the
        // target started has no exit to report and rejects with the
        // cancellation reason instead. The result projection classifies it
        // from the deadline wiring; nothing is a provider failure. A
        // synchronous spawn throw never produced a handle and stays a failure.
        if (running !== undefined && (proc.status === 'killed' || spawnSignal?.aborted === true)) {
          proc.status = 'killed'
          this.onProcessDone(proc, collected.stderr.readFrom(0).text, false)
          disarm()
          return
        }
        // Provider failures settle the handle as killed and surface on stderr for every reader.
        proc.status = 'killed'
        let detail = 'unprintable provider failure'
        try {
          detail = String(error)
        } catch {
          // Provider-owned rejection values cannot make ShellProcess.done reject.
        }
        providerFailure = { error, note: `subprocess failed before reporting an outcome: ${detail}` }
        this.onProcessDone(proc, providerFailure.note, true, error)
        disarm()
      }),
      readOutput: (): ShellProcessRead => {
        const out = collected.stdout.readFrom(stdoutOffset)
        const err = collected.stderr.readFrom(stderrOffset)
        stdoutOffset = out.nextOffset
        stderrOffset = err.nextOffset

        const providerFailure = consumeProviderFailure()
        const failureSeparator = err.text.length > 0 && !err.text.endsWith('\n') ? '\n' : ''
        const errText = err.text
          + (providerFailure.length > 0 ? `${failureSeparator}${providerFailure}` : '')
        // Single newline between sections: stdout chunks usually end with one
        // already; add it only when missing.
        const separator = out.text.length > 0 && !out.text.endsWith('\n') ? '\n' : ''
        const delta = out.text
          + (errText.length > 0 ? `${separator}[stderr]\n${errText}` : '')
        return {
          delta,
          lossy: out.lossy || err.lossy,
          ...out.spillPath !== undefined ? { stdoutSpillPath: out.spillPath } : {},
          ...err.spillPath !== undefined ? { stderrSpillPath: err.spillPath } : {},
        }
      },
      kill: (): boolean => {
        if (proc.status !== 'running') return false
        proc.status = 'killed'
        running?.terminate()
        return true
      },
      result: (): Promise<ShellRunResult> => {
        resultPromise ??= proc.done.then(() => {
          // Infrastructure-failure parity with the historical foreground path:
          // a spawn that never produced a process rejects the projection.
          if (providerFailure !== undefined) throw providerFailure.error
          return {
            exitCode: proc.exitCode,
            signal: proc.signal,
            ...classify(),
            timeoutMs: spec.timeoutMs,
            stdout: finalOutput(collected.stdout),
            stderr: finalOutput(collected.stderr),
          }
        })
        return resultPromise
      },
    }
    if (!preparationTimedOut) onStarted?.(proc)
    return proc
  }

  /**
   * Settlement hook for subclasses that attach execution facts to a process.
   * The base implementation is intentionally empty. Mirrored from
   * `dsh-bash-local` (whose sandboxing subclass consumes the same hook); the
   * pwsh-confining consumer is `@deepseek-ai/dsh-pwsh-sandbox`.
   * @param _proc - the settled process handle.
   * @param _stderr - the process's retained stderr tail used by subclasses for settlement classification.
   * @param _providerRejected - whether the subprocess promise rejected without a direct outcome.
   * @param _providerError - the provider rejection reason, which may itself be undefined.
   */
  protected onProcessDone(_proc: ShellProcess, _stderr: string, _providerRejected: boolean, _providerError?: unknown): void {}
}
/* jscpd:ignore-end */

export default PwshLocalExecutor
