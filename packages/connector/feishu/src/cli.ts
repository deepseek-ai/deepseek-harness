/** Managed lark-cli location and bounded execution with subprocess lifetime ownership. */

import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ShellEnvRegistry } from '@deepseek-ai/dsh-shell-env'
import type { SubprocessOutcome, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'

const PROGRAM = 'lark-cli'
const STDERR_TAIL_BYTES = 4096
const TERMINATE_GRACE_MS = 2_000
const TIMEOUT_CODE = 'FEISHU_CLI_TIMEOUT'

/** Deployment limits for one native command. */
export interface FeishuCliLimits {
  /** Deadline in milliseconds, including executable lookup. */
  commandTimeoutMs: number
  /** Maximum stdout bytes retained from one command. */
  maxOutputBytes: number
}

/**
 * Locate the directory holding the managed executable.
 * @param binDir - absolute override; defaults to the installed `@larksuite/cli` package.
 * @returns the bin directory containing an executable `lark-cli`.
 * @throws when the executable is missing.
 */
export function resolveCliDirectory(binDir: string | undefined): string {
  const directory = binDir ?? join(dirname(fileURLToPath(import.meta.resolve('@larksuite/cli/package.json'))), 'bin')
  const program = join(directory, PROGRAM)
  try {
    accessSync(program, constants.X_OK)
  } catch (error) {
    throw new Error(`feishu: ${program} is not executable; approve the @larksuite/cli install script or set binDir`, { cause: error })
  }
  return directory
}

function commandLine(args: readonly string[]): string {
  return [PROGRAM, ...args].join(' ')
}

/** Runs lark-cli through the private Shell PATH and owns each command until its process exits. */
export class FeishuCli {
  private readonly lifetime = new AbortController()
  private readonly running = new Set<Promise<string>>()

  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly shellEnv: ShellEnvRegistry,
    private readonly limits: FeishuCliLimits,
  ) {}

  /**
   * Run one command to process exit, require exit code zero, and parse its JSON stdout.
   * @param args - native arguments without the executable.
   * @param signal - caller cancellation; an abort rejects with its reason after the process exits.
   * @returns unvalidated JSON for the caller to check.
   * @throws after disposal; otherwise, with a message naming the command, when the deadline
   *   (which includes executable lookup) elapses, the exit is nonzero (with the stderr tail),
   *   stdout exceeds `maxOutputBytes`, or stdout is not JSON.
   */
  async json(args: readonly string[], signal: AbortSignal): Promise<unknown> {
    this.lifetime.signal.throwIfAborted()
    const task = this.execute(args, signal)
    this.running.add(task)
    let stdout: string
    try {
      stdout = await task
    } finally {
      this.running.delete(task)
    }
    try {
      return JSON.parse(stdout)
    } catch (error) {
      throw new Error(`${commandLine(args)} returned invalid JSON`, { cause: error })
    }
  }

  /**
   * Abort owned commands and wait for their processes to exit.
   * @returns settles once every owned command has settled.
   */
  async dispose(): Promise<void> {
    this.lifetime.abort(new Error('feishu: plugin disposed'))
    await Promise.allSettled([...this.running])
  }

  private async execute(args: readonly string[], upstream: AbortSignal): Promise<string> {
    using limit = deadline(AbortSignal.any([upstream, this.lifetime.signal]), this.limits.commandTimeoutMs, TIMEOUT_CODE)
    try {
      return await this.collect(args, limit.signal)
    } catch (error) {
      if (timeoutOf(limit.signal, TIMEOUT_CODE) === undefined) throw error
      throw new Error(`${commandLine(args)} timed out after ${String(this.limits.commandTimeoutMs)}ms`, { cause: error })
    }
  }

  private async collect(args: readonly string[], signal: AbortSignal): Promise<string> {
    const env = this.shellEnv.prepareEnvironment(this.subprocess)
    const program = await this.subprocess.resolveExecutable(PROGRAM, env, signal)
    signal.throwIfAborted()
    const handle = this.subprocess.spawn({
      argv: [program, ...args], cwd: homedir(), env,
      stdio: { stdin: 'ignore', stdout: { maxBytes: this.limits.maxOutputBytes }, stderr: { maxBytes: STDERR_TAIL_BYTES } },
      graceMs: TERMINATE_GRACE_MS, signal,
    })
    let outcome: SubprocessOutcome
    try {
      outcome = await handle.done
    } finally {
      handle.terminate()
      await handle.waitForExit()
    }
    signal.throwIfAborted()
    /* v8 ignore start -- collect-mode stdio always yields both readers. */
    const stdout = handle.collected.stdout?.readFrom(0) ?? { text: '', lossy: false }
    const stderr = handle.collected.stderr?.readFrom(0).text ?? ''
    /* v8 ignore stop */
    if (outcome.exitCode !== 0) {
      throw new Error(`${commandLine(args)} exited with ${outcome.signal ?? String(outcome.exitCode)}${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`)
    }
    if (stdout.lossy) throw new Error(`${commandLine(args)} output exceeded ${String(this.limits.maxOutputBytes)} bytes`)
    return stdout.text
  }
}
