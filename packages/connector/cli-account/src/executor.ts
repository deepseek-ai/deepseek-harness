/** Bounded execution of one CLI executable through a subprocess runtime, with subprocess lifetime ownership. */

import { homedir } from 'node:os'
import { addAbortSignal, type Readable } from 'node:stream'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'

const STDERR_TAIL_BYTES = 4096
const MAX_OUTPUT_BYTES = 1_048_576
const AUTHORIZATION_TIMEOUT_MS = 600_000
const TERMINATE_GRACE_MS = 2_000
const DRAIN_AFTER_EXIT_MS = 2_000
const TIMEOUT_CODE = 'CLI_ACCOUNT_TIMEOUT'

/** The program a plugin runs and its deadline for commands that do not wait for the user. */
export interface CliCommandExecutorOptions {
  /** Name the CLI's guides run it by, used in diagnostics. */
  readonly program: string
  /** Absolute path of the executable. */
  readonly executable: string
  /** Deadline in milliseconds, including executable lookup. */
  readonly commandTimeoutMs: number
}

/** One command that ran to exit; a nonzero exit is the caller's to interpret. */
export interface CliCommandResult {
  readonly exitCode: number | null
  /** At most 1 MiB of stdout, in UTF-8 bytes. */
  readonly stdout: string
  /** The last 4 KiB of stderr, in UTF-8 bytes, cut at a character boundary. */
  readonly stderr: string
}

/** How long one command may run and who observes its output. */
export interface CliRunOptions {
  /** Whether the command waits for the user in a browser; it then gets a fixed 10-minute deadline instead of the command deadline. */
  readonly awaitsUser?: boolean
  /**
   * Receives each output line, without its terminator, as the command writes it, and the unterminated rest at exit.
   * `\n`, `\r\n`, and a lone `\r` each end a line, so a line the CLI redraws with `\r` arrives when written. A line
   * longer than its stream's limit, 1 MiB for stdout and 4 KiB for stderr in UTF-8 bytes, is skipped. Every call
   * happens before `run` settles.
   */
  readonly onLine?: (stream: 'stdout' | 'stderr', line: string) => void
}

interface StreamText { text: string; overflowed: boolean }

/** Incremental line splitting over decoded text whose buffer never holds more than `maxBytes` UTF-8 bytes. */
interface LineSplitter {
  push(text: string): void
  end(): void
}

/**
 * Split text into lines at `\n`, `\r\n`, or a lone `\r`, as Node's `readline` does, and skip a line longer than
 * `maxBytes` UTF-8 bytes whole, so a truncated link or JSON line never reaches the observer.
 */
function splitLines(maxBytes: number, emit: (line: string) => void): LineSplitter {
  let line = ''
  let bytes = 0
  let skipping = false
  let afterCarriageReturn = false
  const append = (piece: string): void => {
    if (skipping) return
    bytes += Buffer.byteLength(piece)
    if (bytes > maxBytes) {
      skipping = true
      line = ''
    } else {
      line += piece
    }
  }
  const finish = (): void => {
    if (!skipping) emit(line)
    line = ''
    bytes = 0
    skipping = false
  }
  return {
    push(text) {
      let start = 0
      for (const match of text.matchAll(/\r\n|\r|\n/gu)) {
        // The `\n` of a `\r\n` pair split across two reads ends no second line.
        if (afterCarriageReturn && match.index === 0 && match[0] === '\n') {
          start = 1
          continue
        }
        append(text.slice(start, match.index))
        finish()
        start = match.index + match[0].length
      }
      afterCarriageReturn = text.endsWith('\r')
      append(text.slice(start))
    },
    end() {
      if (line !== '') emit(line)
    },
  }
}

/**
 * The longest suffix of `text` that fits in `maxBytes` UTF-8 bytes, cut at a character boundary.
 * @param text - decoded text, which holds no partial character.
 * @param maxBytes - the byte limit, at least 4 so a whole character always fits.
 * @returns `text` itself when it fits.
 */
function utf8Tail(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  let start = bytes.length - maxBytes
  // UTF-8 continuation bytes are 0b10xxxxxx; the first other byte starts a character.
  while ((bytes.readUInt8(start) & 0xc0) === 0x80) start++
  return bytes.toString('utf8', start)
}

/**
 * Drain one pipe until it ends or `cut` aborts, report its lines when observed, and keep the head up to `maxBytes`
 * or, for a tail, the last `maxBytes`, counted in UTF-8 bytes.
 */
async function readStream(
  stream: Readable | undefined, name: 'stdout' | 'stderr', maxBytes: number, keep: 'head' | 'tail',
  onLine: CliRunOptions['onLine'], cut: AbortSignal,
): Promise<StreamText> {
  const result: StreamText = { text: '', overflowed: false }
  /* v8 ignore next -- pipe-mode stdio always yields both streams. */
  if (stream === undefined) return result
  const lines = onLine === undefined ? undefined : splitLines(maxBytes, (line) => { onLine(name, line) })
  let headBytes = 0
  addAbortSignal(cut, stream)
  stream.setEncoding('utf8')
  try {
    for await (const chunk of stream as AsyncIterable<string>) {
      lines?.push(chunk)
      if (keep === 'tail') {
        result.text = utf8Tail(result.text + chunk, maxBytes)
      } else if (!result.overflowed) {
        headBytes += Buffer.byteLength(chunk)
        if (headBytes > maxBytes) result.overflowed = true
        else result.text += chunk
      }
    }
  } catch (error) {
    // A cut stops reading on purpose; the output read before it is kept.
    if (!cut.aborted) throw error
  }
  lines?.end()
  return result
}

/** Runs one plugin's CLI program and owns each command until its process exits. */
export class CliCommandExecutor {
  private readonly lifetime = new AbortController()
  private readonly running = new Set<Promise<CliCommandResult>>()

  constructor(
    private readonly subprocess: SubprocessRuntime,
    private readonly options: CliCommandExecutorOptions,
  ) {}

  /**
   * Run one command to process exit and return its output whatever the exit code. Its pipes are read until they close,
   * at most until 2 seconds after the subprocess runtime reports the exit, so the result does not wait for a descendant
   * that inherited them to close them; what the descendant writes after that is dropped.
   * @param args - native arguments without the executable.
   * @param signal - caller cancellation; an abort rejects with its reason after the process exits.
   * @param options - the deadline choice and an observer for output lines.
   * @returns the exit code, the stdout head, and the stderr tail.
   * @throws after disposal; with the subprocess runtime's error when executable lookup fails, such as
   *   `SubprocessExecutableNotFoundError`, or the process cannot spawn; with what `onLine` throws; otherwise, with a
   *   message naming the command, when the deadline elapses, the process ends by a signal, or stdout exceeds 1 MiB.
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
    const executable = await this.subprocess.resolveExecutable(this.options.executable, undefined, signal)
    signal.throwIfAborted()
    const handle = this.subprocess.spawn({
      argv: [executable, ...args], cwd: homedir(),
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: TERMINATE_GRACE_MS, signal,
    })
    const cut = new AbortController()
    const readers = [
      readStream(handle.stdout, 'stdout', MAX_OUTPUT_BYTES, 'head', onLine, cut.signal),
      readStream(handle.stderr, 'stderr', STDERR_TAIL_BYTES, 'tail', onLine, cut.signal),
    ] as const
    const output = Promise.all(readers)
    let drain: ReturnType<typeof setTimeout> | undefined
    try {
      // A reader failure, such as an `onLine` throw, stops waiting for the exit.
      const outcome = await Promise.race([handle.done, output.then(() => handle.done)])
      // A descendant that inherited the pipes can keep them open after the exit, so reading stops DRAIN_AFTER_EXIT_MS later.
      drain = setTimeout(() => { cut.abort() }, DRAIN_AFTER_EXIT_MS)
      const [out, err] = await output
      signal.throwIfAborted()
      if (outcome.signal !== null) throw new Error(`${this.commandLine(args)} exited with ${outcome.signal}`)
      if (out.overflowed) throw new Error(`${this.commandLine(args)} output exceeded ${String(MAX_OUTPUT_BYTES)} bytes`)
      return { exitCode: outcome.exitCode, stdout: out.text, stderr: err.text }
    } finally {
      clearTimeout(drain)
      handle.terminate()
      // A failure can leave a reader running, possibly on a pipe a descendant keeps open; stop it so that every
      // `onLine` call precedes the result.
      cut.abort()
      await Promise.allSettled(readers)
      await handle.waitForExit()
    }
  }
}
