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

export interface CliCommandExecutorOptions {
  readonly program: string
  readonly commandTimeoutMs: number
}

export interface CliCommandResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

export interface CliRunOptions {
  readonly awaitsUser?: boolean
  readonly onLine?: (stream: 'stdout' | 'stderr', line: string) => void
}

interface StreamText { text: string; overflowed: boolean }

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

export class CliCommandExecutor {
  private readonly lifetime = new AbortController()
  private readonly running = new Set<Promise<CliCommandResult>>()

  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly shellEnv: ShellEnvRegistry,
    private readonly options: CliCommandExecutorOptions,
  ) {}

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

  async dispose(): Promise<void> {
    this.lifetime.abort(new Error(`${this.options.program}: plugin disposed`))
    await Promise.allSettled([...this.running])
  }

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
