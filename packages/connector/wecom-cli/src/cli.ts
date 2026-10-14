import { accessSync, constants } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Readable } from 'node:stream'
import type { ShellEnvRegistry } from '@deepseek-ai/dsh-shell-env'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'

const PROGRAM = 'wecom-cli'
const STDERR_TAIL_BYTES = 4096
const TERMINATE_GRACE_MS = 2_000
const TIMEOUT_CODE = 'WECOM_CLI_TIMEOUT'

export interface WecomCliLimits {
  commandTimeoutMs: number
  maxOutputBytes: number
}

export interface WecomCommandResult {
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}

export interface WecomRunOptions {
  readonly timeoutMs: number
  readonly onLine?: (stream: 'stdout' | 'stderr', line: string) => void
}

interface StreamText { text: string; overflowed: boolean }

async function readStream(
  stream: Readable | undefined, name: 'stdout' | 'stderr', maxBytes: number, keep: 'head' | 'tail',
  onLine: WecomRunOptions['onLine'],
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

function platformDirectory(): string {
  const platformPackage = `@wecom/cli-${process.platform}-${process.arch}`
  try {
    const require = createRequire(import.meta.resolve('@wecom/cli/package.json'))
    return join(dirname(require.resolve(`${platformPackage}/package.json`)), 'bin')
  } catch (error) {
    throw new Error(`wecom: ${platformPackage} is not installed; @wecom/cli has no binary for this platform, or set binDir`, { cause: error })
  }
}

export function resolveCliDirectory(binDir: string | undefined): string {
  const directory = binDir ?? platformDirectory()
  const program = join(directory, PROGRAM)
  try {
    accessSync(program, constants.X_OK)
  } catch (error) {
    throw new Error(`wecom: ${program} is not executable; reinstall the plugin or set binDir`, { cause: error })
  }
  return directory
}

function commandLine(args: readonly string[]): string {
  return [PROGRAM, ...args].join(' ')
}

export class WecomCli {
  private readonly lifetime = new AbortController()
  private readonly running = new Set<Promise<WecomCommandResult>>()

  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly shellEnv: ShellEnvRegistry,
    private readonly limits: WecomCliLimits,
  ) {}

  async run(args: readonly string[], signal: AbortSignal, options: WecomRunOptions): Promise<WecomCommandResult> {
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
    this.lifetime.abort(new Error('wecom: plugin disposed'))
    await Promise.allSettled([...this.running])
  }

  private async execute(args: readonly string[], upstream: AbortSignal, options: WecomRunOptions): Promise<WecomCommandResult> {
    using limit = deadline(AbortSignal.any([upstream, this.lifetime.signal]), options.timeoutMs, TIMEOUT_CODE)
    try {
      return await this.collect(args, limit.signal, options.onLine)
    } catch (error) {
      if (timeoutOf(limit.signal, TIMEOUT_CODE) === undefined) throw error
      throw new Error(`${commandLine(args)} timed out after ${String(options.timeoutMs)}ms`, { cause: error })
    }
  }

  private async collect(args: readonly string[], signal: AbortSignal, onLine: WecomRunOptions['onLine']): Promise<WecomCommandResult> {
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
