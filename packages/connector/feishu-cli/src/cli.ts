/** Managed lark-cli location and bounded execution with subprocess lifetime ownership. */

import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Readable } from 'node:stream'
import type { ShellEnvRegistry } from '@deepseek-ai/dsh-shell-env'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
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

/** One command that ran to exit; a nonzero exit is the caller's to interpret. */
export interface FeishuCommandResult {
  readonly exitCode: number | null
  readonly stdout: string
  /** The last 4 KiB of stderr. */
  readonly stderr: string
}

/** Deadline and output observer for one command. */
export interface FeishuRunOptions {
  /** Deadline in milliseconds, including executable lookup. */
  readonly timeoutMs: number
  /** Receives each complete output line as the command writes it. */
  readonly onLine?: (stream: 'stdout' | 'stderr', line: string) => void
}

interface StreamText { text: string; overflowed: boolean }

/** Drain one pipe, report complete lines, and keep the head up to `maxBytes` or, for a tail, the last `maxBytes`. */
async function readStream(
  stream: Readable | undefined, name: 'stdout' | 'stderr', maxBytes: number, keep: 'head' | 'tail',
  onLine: FeishuRunOptions['onLine'],
): Promise<StreamText> {
  const result: StreamText = { text: '', overflowed: false }
  /* v8 ignore next -- pipe-mode stdio always yields both streams. */
  if (stream === undefined) return result
  let pending = ''
  stream.setEncoding('utf8')
  for await (const chunk of stream as AsyncIterable<string>) {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() as string
    for (const line of lines) onLine?.(name, line.replace(/\r$/u, ''))
    if (keep === 'tail') {
      result.text = (result.text + chunk).slice(-maxBytes)
    } else if (!result.overflowed) {
      if (Buffer.byteLength(result.text) + Buffer.byteLength(chunk) > maxBytes) result.overflowed = true
      else result.text += chunk
    }
  }
  if (pending !== '') onLine?.(name, pending)
  return result
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

/**
 * Parse one command's JSON stdout.
 * @param args - the command's native arguments, for the error message.
 * @param stdout - the complete stdout.
 * @returns unvalidated JSON for the caller to check.
 * @throws when stdout is not JSON.
 */
export function parseJson(args: readonly string[], stdout: string): unknown {
  try {
    return JSON.parse(stdout)
  } catch (error) {
    throw new Error(`${commandLine(args)} returned invalid JSON`, { cause: error })
  }
}

/** Runs lark-cli through the private Shell PATH and owns each command until its process exits. */
export class FeishuCli {
  private readonly lifetime = new AbortController()
  private readonly running = new Set<Promise<FeishuCommandResult>>()

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
    const result = await this.run(args, signal, { timeoutMs: this.limits.commandTimeoutMs })
    if (result.exitCode !== 0) {
      throw new Error(`${commandLine(args)} exited with ${String(result.exitCode)}${result.stderr.trim() === '' ? '' : `: ${result.stderr.trim()}`}`)
    }
    return parseJson(args, result.stdout)
  }

  /**
   * Run one command to process exit and return its output whatever the exit code.
   * @param args - native arguments without the executable.
   * @param signal - caller cancellation; an abort rejects with its reason after the process exits.
   * @param options - the deadline and an observer for output lines.
   * @returns the exit code, stdout, and the stderr tail.
   * @throws after disposal; otherwise, with a message naming the command, when the deadline elapses,
   *   the process ends by a signal, or stdout exceeds `maxOutputBytes`.
   */
  async run(args: readonly string[], signal: AbortSignal, options: FeishuRunOptions): Promise<FeishuCommandResult> {
    this.lifetime.signal.throwIfAborted()
    const task = this.execute(args, signal, options)
    this.running.add(task)
    try {
      return await task
    } finally {
      this.running.delete(task)
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

  private async execute(args: readonly string[], upstream: AbortSignal, options: FeishuRunOptions): Promise<FeishuCommandResult> {
    using limit = deadline(AbortSignal.any([upstream, this.lifetime.signal]), options.timeoutMs, TIMEOUT_CODE)
    try {
      return await this.collect(args, limit.signal, options.onLine)
    } catch (error) {
      if (timeoutOf(limit.signal, TIMEOUT_CODE) === undefined) throw error
      throw new Error(`${commandLine(args)} timed out after ${String(options.timeoutMs)}ms`, { cause: error })
    }
  }

  private async collect(args: readonly string[], signal: AbortSignal, onLine: FeishuRunOptions['onLine']): Promise<FeishuCommandResult> {
    const env = this.shellEnv.prepareEnvironment(this.subprocess)
    const program = await this.subprocess.resolveExecutable(PROGRAM, env, signal)
    signal.throwIfAborted()
    const handle = this.subprocess.spawn({
      argv: [program, ...args], cwd: homedir(), env,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: TERMINATE_GRACE_MS, signal,
    })
    const stdout = readStream(handle.stdout, 'stdout', this.limits.maxOutputBytes, 'head', onLine)
    const stderr = readStream(handle.stderr, 'stderr', STDERR_TAIL_BYTES, 'tail', onLine)
    try {
      const [outcome, out, err] = await Promise.all([handle.done, stdout, stderr])
      signal.throwIfAborted()
      if (outcome.signal !== null) throw new Error(`${commandLine(args)} exited with ${outcome.signal}`)
      if (out.overflowed) throw new Error(`${commandLine(args)} output exceeded ${String(this.limits.maxOutputBytes)} bytes`)
      return { exitCode: outcome.exitCode, stdout: out.text, stderr: err.text }
    } finally {
      handle.terminate()
      await handle.waitForExit()
    }
  }
}
