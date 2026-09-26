/**
 * `node:child_process` over the worker's own shell.
 *
 * A browser worker cannot fork, so this module IS the machine's process layer:
 * `spawn` starts the argv as a shell process (`src/shell/process/`) — its own
 * Web Worker, off this thread — and reports it through the `ChildProcess`
 * surface the subprocess service consumes: pipes, `exit`/`close`, pid, and
 * signals, with `SIGKILL` terminating the worker for real. Worker-owned
 * executable wrappers resolve before the shell's command table; anything in
 * neither set fails with `ENOENT`, exactly as a missing binary does on a real
 * host.
 *
 * What stays impossible is what needs a real process: synchronous execution
 * (`execSync`, and `spawnSync` for a known program) and `fork`.
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/node/builtin_modules/implemented/child_process
 */

import { Buffer } from 'buffer'
import { EventEmitter } from './events.ts'
import { notImplementedFail } from '../../notImplementedFail.ts'
import { registerProcess, releaseProcess, signalProcess } from '../../process-table.ts'
import { startProcess } from '../../../shell/process/host.ts'
import { hostFileSystem } from '../../../shell/fs-access.ts'
import { virtualExecutable } from '../../../shell/process/virtual-executables.ts'
import type { VirtualExecutableExit } from '../../../shell/process/virtual-executables.ts'
import { standardPrograms } from '../../../shell/programs/index.ts'
import type { ShellFileSystem } from '../../../shell/types.ts'
import { DSH_ROOT } from '../../../storage/paths.ts'

const MODULE = 'node:child_process'

/** Per-stream disposition, as Node's `stdio` array spells it. */
type StdioSetting = 'pipe' | 'ignore' | 'inherit'

/** The spawn options this shim reads; Node accepts more, none of which apply here. */
export interface WorkerSpawnOptions {
  cwd?: string | undefined
  env?: Record<string, string | undefined> | undefined
  stdio?: StdioSetting | readonly StdioSetting[] | undefined
  /** Accepted and ignored: process groups do not exist, so there is no group to detach into. */
  detached?: boolean | undefined
}

/**
 * The readable half of a pipe: `data` events carrying Buffers, `end`, and a
 * `destroy` that stops delivery.
 *
 * The stream-shaping members below are no-ops rather than omissions. A caller
 * that configures the pipe before reading it (the browser launcher calls
 * `setEncoding`) would otherwise die of a TypeError on the configuration line,
 * hiding the real outcome — which for an unknown program is the `ENOENT` this
 * shim is about to emit.
 */
class WorkerReadable extends EventEmitter {
  private destroyed = false

  /**
   * Accept an encoding (chunks are always UTF-8 text carried as Buffers).
   * @returns this stream.
   */
  setEncoding(): this {
    return this
  }

  /**
   * Accept a flow-control request; delivery is driven by the command, which
   * has already produced whatever it produced.
   * @returns this stream.
   */
  pause(): this {
    return this
  }

  /** @returns this stream; see {@link pause}. */
  resume(): this {
    return this
  }

  /**
   * Deliver one chunk to the `data` listeners.
   * @param text - the text written by the command.
   */
  push(text: string): void {
    if (this.destroyed || text === '') return
    this.emit('data', Buffer.from(text, 'utf8'))
  }

  /** Signal end of stream. */
  finish(): void {
    if (this.destroyed) return
    this.emit('end')
  }

  /** Stop delivering; the collector calls this once the process settles. */
  destroy(): void {
    this.destroyed = true
    this.emit('close')
  }
}

/** The writable half of stdin: the batch write the subprocess service performs. */
class WorkerWritable extends EventEmitter {
  private text = ''

  /**
   * Buffer one write.
   * @param chunk - text or bytes to add to standard input.
   * @returns true, since nothing here applies backpressure.
   */
  write(chunk: string | Uint8Array): boolean {
    this.text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
    return true
  }

  /**
   * Finish standard input.
   * @param chunk - optional final write.
   */
  end(chunk?: string | Uint8Array): void {
    if (chunk !== undefined) this.write(chunk)
    this.emit('finish')
  }

  /** @returns everything written so far. */
  contents(): string {
    return this.text
  }
}

/**
 * One running command, wearing the parts of `ChildProcess` its consumers read.
 */
export class WorkerChildProcess extends EventEmitter {
  /** The worker's own process id for this command, from the process table. */
  readonly pid: number
  /** Standard input, when the caller asked for a pipe; null otherwise. */
  readonly stdin: WorkerWritable | null
  /** Standard output, when the caller asked for a pipe; null otherwise. */
  readonly stdout: WorkerReadable | null
  /** Standard error, when the caller asked for a pipe; null otherwise. */
  readonly stderr: WorkerReadable | null
  /** Exit status once settled; null while running and after a signal. */
  exitCode: number | null = null
  /** The signal that ended the command, or null when it exited on its own. */
  signalCode: NodeJS.Signals | null = null

  constructor(pid: number, stdio: readonly StdioSetting[]) {
    super()
    this.pid = pid
    this.stdin = stdio[0] === 'pipe' ? new WorkerWritable() : null
    this.stdout = stdio[1] === 'pipe' ? new WorkerReadable() : null
    this.stderr = stdio[2] === 'pipe' ? new WorkerReadable() : null
  }

  /**
   * Deliver a signal to this command.
   * @param signal - signal name; every one of them terminates.
   * @returns true when the command was still running.
   */
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    return signalProcess(this.pid, signal)
  }
}

/** Normalize the `stdio` option into the three-entry form the shim reads. */
function stdioOf(option: WorkerSpawnOptions['stdio']): StdioSetting[] {
  if (typeof option === 'string') return [option, option, option]
  if (option === undefined) return ['pipe', 'pipe', 'pipe']
  return [option[0] ?? 'pipe', option[1] ?? 'pipe', option[2] ?? 'pipe']
}

/** The environment a command runs with: the caller's map, minus the removals Node allows. */
function environmentOf(option: WorkerSpawnOptions['env']): Record<string, string> {
  const inherited = (globalThis as { process?: { env?: Record<string, string> } }).process?.env ?? {}
  const source = option ?? inherited
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined) as [string, string][])
}

/**
 * A missing program fails the way Node fails a missing binary, so consumers
 * that classify spawn errors by `code`, `path`, and `syscall` keep working.
 */
function spawnEnoent(program: string): NodeJS.ErrnoException {
  const error = new Error(`spawn ${program} ENOENT`) as NodeJS.ErrnoException
  error.code = 'ENOENT'
  error.errno = -2
  error.path = program
  error.syscall = `spawn ${program}`
  return error
}

/** Whether this argv is a shell invocation whose script the interpreter should parse. */
function shellScriptOf(argv: readonly string[]): string | undefined {
  const [program, flag, script] = argv
  if ((program !== 'bash' && program !== 'sh') || flag !== '-c') return undefined
  return script ?? ''
}

/**
 * Run one command in the worker.
 *
 * The call returns immediately with a handle; the command runs in its own
 * worker (or inline where no `Worker` exists) and reports back through the
 * handle's pipes and events.
 * @param program - the program name, as argv[0].
 * @param args - its arguments.
 * @param options - working directory, environment, and stdio dispositions.
 * @returns the running command's handle.
 */
export function spawn(
  program: string,
  args: readonly string[] = [],
  options: WorkerSpawnOptions = {},
): WorkerChildProcess {
  if (typeof program !== 'string' || program === '') {
    // Node refuses a non-string command with this error rather than starting
    // anything; a caller whose own lookup produced nothing reads why.
    const invalid = new TypeError(`The "file" argument must be a non-empty string. Received ${program as string}`) as NodeJS.ErrnoException
    invalid.code = 'ERR_INVALID_ARG_TYPE'
    throw invalid
  }
  const argv = [program, ...args]
  const stdio = stdioOf(options.stdio)
  const entry = registerProcess()
  const child = new WorkerChildProcess(entry.pid, stdio)

  const emit = (stream: 'stdout' | 'stderr', text: string): void => {
    if (text === '') return
    const pipe = stream === 'stdout' ? child.stdout : child.stderr
    if (pipe !== null) {
      pipe.push(text)
      return
    }
    // An inherited stream belongs to the host: the worker's console is the
    // only place it can go, and an ignored one goes nowhere.
    if (stdio[stream === 'stdout' ? 1 : 2] === 'inherit') {
      (stream === 'stdout' ? console.log : console.error)(text.replace(/\n$/, ''))
    }
  }

  let settled = false
  const settle = (exitCode: number): void => {
    if (settled) return
    settled = true
    releaseProcess(entry.pid)
    // A signalled command reports no exit code, which is what makes the
    // subprocess service classify it as killed rather than finished.
    const signal = entry.signal ?? null
    child.exitCode = signal === null ? exitCode : null
    child.signalCode = signal
    child.stdout?.finish()
    child.stderr?.finish()
    child.emit('exit', child.exitCode, signal)
    child.emit('close', child.exitCode, signal)
  }
  const failSpawn = (error: Error): void => {
    if (settled) return
    settled = true
    releaseProcess(entry.pid)
    child.emit('error', error)
  }

  // The command starts on a microtask, so a caller that attaches listeners and
  // writes standard input right after `spawn()` — the subprocess service does
  // exactly that — is never racing the first output.
  queueMicrotask(() => {
    void (async () => {
      const cwd = options.cwd ?? DSH_ROOT
      let commandArgv: readonly string[] = argv
      let filesystem: ShellFileSystem | undefined
      let missingExecutable: VirtualExecutableExit | undefined
      const executable = virtualExecutable(program)
      if (executable !== undefined) {
        const prepared = await executable.prepare(args, { cwd, filesystem: hostFileSystem() })
        if (prepared.kind === 'exit') {
          emit('stdout', prepared.stdout)
          emit('stderr', prepared.stderr)
          settle(prepared.exitCode)
          return
        }
        commandArgv = prepared.argv
        filesystem = prepared.filesystem
        missingExecutable = prepared.missingExecutable
      }

      const command = commandArgv[0] as string
      const script = shellScriptOf(commandArgv)
      const known = script !== undefined || standardPrograms().has(command)
      if (!known) {
        if (missingExecutable !== undefined) {
          emit('stdout', missingExecutable.stdout)
          emit('stderr', missingExecutable.stderr)
          settle(missingExecutable.exitCode)
        } else {
          failSpawn(spawnEnoent(program))
        }
        return
      }
      entry.process = startProcess({
        script,
        argv: commandArgv,
        cwd,
        env: environmentOf(options.env),
        stdin: child.stdin?.contents() ?? '',
        onOutput: emit,
        onExit: settle,
        ...filesystem === undefined ? {} : { fs: filesystem },
      })
      // A signal that arrived while the process was still starting has to reach
      // it now; the table recorded it but had nothing to deliver it to.
      if (entry.signal !== undefined) {
        if (entry.signal === 'SIGKILL') entry.process.destroy()
        else entry.process.interrupt()
      }
    })().catch((error: unknown) => {
      failSpawn(error instanceof Error ? error : new Error(String(error)))
    })
  })

  return child
}

/** The result shape `spawnSync` returns, holding only the members consumers read. */
export interface WorkerSpawnSyncResult {
  pid: number
  status: number | null
  signal: NodeJS.Signals | null
  stdout: Buffer
  stderr: Buffer
  output: (Buffer | null)[]
  /** Why the run did not happen; carries `code` for the callers that classify by it. */
  error?: NodeJS.ErrnoException
}

/**
 * Report that a command cannot run synchronously.
 *
 * Callers use `spawnSync` to probe for a binary (the sandbox runner probes do)
 * and Node answers a missing one with an `error` rather than a throw, so this
 * answers in the same shape: absent programs report `ENOENT`, and a program
 * this shell *does* have reports that only the asynchronous path can run it.
 * @param program - the program name.
 * @param args - arguments passed to the virtual launcher probe.
 * @returns the Node-shaped synchronous result carrying the failure.
 */
export function spawnSync(program: string, args: readonly string[] = []): WorkerSpawnSyncResult {
  const empty = Buffer.alloc(0)
  const executable = virtualExecutable(program)
  if (executable !== undefined) {
    const result = executable.runSync(args)
    if (result.kind === 'asynchronous') {
      const error = new Error(`${MODULE}.spawnSync cannot run ${program} in the worker host: commands run asynchronously`)
      return { pid: -1, status: null, signal: null, stdout: empty, stderr: empty, output: [null, empty, empty], error }
    }
    const stdout = Buffer.from(result.stdout)
    const stderr = Buffer.from(result.stderr)
    return { pid: -1, status: result.exitCode, signal: null, stdout, stderr, output: [null, stdout, stderr] }
  }
  const error = standardPrograms().has(program)
    ? new Error(`${MODULE}.spawnSync cannot run ${program} in the worker host: commands run asynchronously`)
    : spawnEnoent(program)
  return { pid: -1, status: null, signal: null, stdout: empty, stderr: empty, output: [null, empty, empty], error }
}

/** Callback `exec` and `execFile` report through. */
type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void

/** Split the optional options argument from the callback Node allows in either position. */
function execArguments(
  options: WorkerSpawnOptions | ExecCallback | undefined,
  callback: ExecCallback | undefined,
): { options: WorkerSpawnOptions; callback: ExecCallback | undefined } {
  if (typeof options === 'function') return { options: {}, callback: options }
  return { options: options ?? {}, callback }
}

/**
 * Run a command line and report its output through a callback.
 * @param command - the shell source to run.
 * @param options - working directory and environment, or the callback.
 * @param callback - receives the failure (nonzero status included), stdout, and stderr.
 * @returns the running command's handle.
 */
export function exec(
  command: string,
  options?: WorkerSpawnOptions | ExecCallback,
  callback?: ExecCallback,
): WorkerChildProcess {
  const settled = execArguments(options, callback)
  return execute(['bash', '-c', command], settled.options, settled.callback)
}

/**
 * Run one program with an explicit argv and report its output through a callback.
 * @param program - the program name.
 * @param args - its arguments, or the options, or the callback.
 * @param options - working directory and environment, or the callback.
 * @param callback - receives the failure (nonzero status included), stdout, and stderr.
 * @returns the running command's handle.
 */
export function execFile(
  program: string,
  args?: readonly string[] | WorkerSpawnOptions | ExecCallback,
  options?: WorkerSpawnOptions | ExecCallback,
  callback?: ExecCallback,
): WorkerChildProcess {
  const argv = Array.isArray(args) ? [program, ...args as string[]] : [program]
  const shifted = Array.isArray(args) ? options : args as WorkerSpawnOptions | ExecCallback | undefined
  const settled = execArguments(shifted, typeof options === 'function' ? options : callback)
  return execute(argv, settled.options, settled.callback)
}

/** Shared body of `exec` and `execFile`: spawn, collect both streams, then report. */
function execute(argv: readonly string[], options: WorkerSpawnOptions, callback: ExecCallback | undefined): WorkerChildProcess {
  const child = spawn(argv[0] as string, argv.slice(1), { ...options, stdio: 'pipe' })
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (chunk: unknown) => { stdout += String(chunk) })
  child.stderr?.on('data', (chunk: unknown) => { stderr += String(chunk) })
  child.on('error', (error: unknown) => { callback?.(error instanceof Error ? error : new Error(String(error)), stdout, stderr) })
  child.on('close', (code: unknown) => {
    const status = typeof code === 'number' ? code : 1
    callback?.(status === 0 ? null : new Error(`Command failed: ${argv.join(' ')}`), stdout, stderr)
  })
  return child
}

/** Run a command line synchronously (unavailable: the interpreter is asynchronous). */
export const execSync: typeof import('node:child_process').execSync = notImplementedFail(MODULE, 'execSync')

/** Run one program synchronously (unavailable: the interpreter is asynchronous). */
export const execFileSync: typeof import('node:child_process').execFileSync = notImplementedFail(MODULE, 'execFileSync')

/** Start a Node child (unavailable: the worker cannot create another Node runtime). */
export const fork: typeof import('node:child_process').fork = notImplementedFail(MODULE, 'fork')

/** CommonJS interop marker: the worker loader hands `default` to default imports (see ../../builtins.ts). */
export const __esModule = true

/**
 * The `node:child_process` declarations this module stands in for. The four
 * process starters keep this module's own types: they answer
 * {@link WorkerChildProcess} and {@link WorkerSpawnSyncResult}, the pipes and exit
 * facts a shell worker can carry, where Node declares a `ChildProcess` holding OS
 * stream objects and, for `exec`/`execFile`, an overload ladder over encodings
 * this shell reports as UTF-8 text.
 */
type NodeFace = Partial<Omit<typeof import('node:child_process'), 'spawn' | 'spawnSync' | 'exec' | 'execFile'>>
  & Record<'spawn' | 'spawnSync' | 'exec' | 'execFile', unknown>

/** CommonJS default export: the members `require()` hands a caller of this module. */
export default { spawn, spawnSync, exec, execFile, execFileSync, execSync, fork } satisfies NodeFace
