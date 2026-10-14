/** Bounded execution of one CLI program on the private Shell PATH, with subprocess lifetime ownership. */

import { homedir } from 'node:os'
import type { Readable } from 'node:stream'
import type { ShellEnvRegistry } from '@deepseek-ai/dsh-shell-env'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'

const STDERR_TAIL_BYTES = 4096
const MAX_OUTPUT_BYTES = 1_048_576
const AUTHORIZATION_TIMEOUT_MS = 600_000
const TERMINATE_GRACE_MS = 2_000
const TIMEOUT_CODE = 'CLI_ACCOUNT_TIMEOUT'

/** The program a plugin runs and its deadline for commands that do not wait for the user. */
export interface CliCommandExecutorOptions {
  /** Executable name looked up on the private Shell PATH. */
  readonly program: string
  /** Deadline in milliseconds, including executable lookup. */
  readonly commandTimeoutMs: number
}

/** One command that ran to exit; a nonzero exit is the caller's to interpret. */
export interface CliCommandResult {
  readonly exitCode: number | null
  /** At most 1 MiB of stdout. */
  readonly stdout: string
  /** The last 4 KiB of stderr. */
  readonly stderr: string
}

/** How long one command may run and who observes its output. */
export interface CliRunOptions {
  /** Whether the command waits for the user in a browser; it then gets a fixed 10-minute deadline instead of the command deadline. */
  readonly awaitsUser?: boolean
  /** Receives each complete output line, without its line terminator, as the command writes it. */
  readonly onLine?: (stream: 'stdout' | 'stderr', line: string) => void
}

interface StreamText { text: string; overflowed: boolean }

/** Drain one pipe, report complete lines, and keep the head up to `maxBytes` or, for a tail, the last `maxBytes`. */
async function readStream(
  stream: Readable | undefined, name: 'stdout' | 'stderr', maxBytes: number, keep: 'head' | 'tail',
  onLine: CliRunOptions['onLine'],
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

/** Runs one plugin's CLI program and owns each command until its process exits. */
export class CliCommandExecutor {
  private readonly lifetime = new AbortController()
  private readonly running = new Set<Promise<CliCommandResult>>()

  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly shellEnv: ShellEnvRegistry,
    private readonly options: CliCommandExecutorOptions,
  ) {}

  /**
   * Run one command to process exit and return its output whatever the exit code.
   * @param args - native arguments without the executable.
   * @param signal - caller cancellation; an abort rejects with its reason after the process exits.
   * @param options - the deadline choice and an observer for output lines.
   * @returns the exit code, the stdout head, and the stderr tail.
   * @throws after disposal; otherwise, with a message naming the command, when the deadline elapses,
   *   the process ends by a signal, or stdout exceeds 1 MiB.
   */
  async run(args: readonly string[], signal: AbortSignal, options: CliRunOptions = {}): Promise<CliCommandResult> {
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
   * Abort owned commands, wait for their processes to exit, and refuse later commands.
   * @returns settles once every owned command has settled.
   */
  async dispose(): Promise<void> {
    this.lifetime.abort(new Error(`${this.options.program}: plugin disposed`))
    await Promise.allSettled([...this.running])
  }

  /**
   * Name a command for diagnostics.
   * @param args - native arguments without the executable.
   * @returns the program and its arguments joined by spaces.
   */
  commandLine(args: readonly string[]): string {
    return [this.options.program, ...args].join(' ')
  }

  private async execute(args: readonly string[], upstream: AbortSignal, options: CliRunOptions): Promise<CliCommandResult> {
    const timeoutMs = options.awaitsUser === true ? AUTHORIZATION_TIMEOUT_MS : this.options.commandTimeoutMs
    using limit = deadline(AbortSignal.any([upstream, this.lifetime.signal]), timeoutMs, TIMEOUT_CODE)
    try {
      return await this.collect(args, limit.signal, options.onLine)
    } catch (error) {
      if (timeoutOf(limit.signal, TIMEOUT_CODE) === undefined) throw error
      throw new Error(`${this.commandLine(args)} timed out after ${String(timeoutMs)}ms`, { cause: error })
    }
  }

  private async collect(args: readonly string[], signal: AbortSignal, onLine: CliRunOptions['onLine']): Promise<CliCommandResult> {
    const env = this.shellEnv.prepareEnvironment(this.subprocess)
    const program = await this.subprocess.resolveExecutable(this.options.program, env, signal)
    signal.throwIfAborted()
    const handle = this.subprocess.spawn({
      argv: [program, ...args], cwd: homedir(), env,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: TERMINATE_GRACE_MS, signal,
    })
    const stdout = readStream(handle.stdout, 'stdout', MAX_OUTPUT_BYTES, 'head', onLine)
    const stderr = readStream(handle.stderr, 'stderr', STDERR_TAIL_BYTES, 'tail', onLine)
    try {
      const [outcome, out, err] = await Promise.all([handle.done, stdout, stderr])
      signal.throwIfAborted()
      if (outcome.signal !== null) throw new Error(`${this.commandLine(args)} exited with ${outcome.signal}`)
      if (out.overflowed) throw new Error(`${this.commandLine(args)} output exceeded ${String(MAX_OUTPUT_BYTES)} bytes`)
      return { exitCode: outcome.exitCode, stdout: out.text, stderr: err.text }
    } finally {
      handle.terminate()
      await handle.waitForExit()
    }
  }
}
