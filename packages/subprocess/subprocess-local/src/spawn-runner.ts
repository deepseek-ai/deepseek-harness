/** One-shot Linux exec bootstrap and Windows Job-owning subprocess runner. */

import { closeSync } from 'node:fs'
import {
  closeHandleChecked,
  isJobEmpty,
  loadWin32ProcessBindings,
  pollProcessExit,
  spawnCurrentTokenJobProcess,
  terminateJob,
  Win32Error,
} from '@deepseek-ai/dsh-win32-process'
import type {
  CurrentTokenProcessBindings,
  NativePtr,
} from '@deepseek-ai/dsh-win32-process'
import { loadLinuxExecve } from './linux-execve.ts'
import {
  consumeLinuxLaunchRequest,
  isWindowsTerminateRequest,
  linuxLaunchFilesFromLocator,
  parseWindowsStartRequest,
  serializeRunnerError,
  writeLinuxStartupError,
} from './runner-protocol.ts'
import type {
  LinuxLaunchFiles,
  SerializedRunnerError,
  WindowsRunnerResult,
  WindowsStartRequest,
} from './runner-protocol.ts'
import {
  parseRunnerTargetArgv,
  resolveWindowsExecutable,
  SUBPROCESS_RUNNER_ENV,
  WINDOWS_RUNNER_SELECTION,
} from './runner-launch.ts'

type RunnerHost = Pick<NodeJS.Process, 'env' | 'exitCode' | 'connected' | 'cwd' | 'chdir' | 'on' | 'off' | 'once' | 'disconnect'> & {
  send?: NodeJS.Process['send']
}

/** Injectable operations used by the protocol-owner tests. */
export interface SpawnRunnerInternals {
  execve(file: string, argv: string[], env: Record<string, string>): never
  loadWin32ProcessBindings(): CurrentTokenProcessBindings
  spawnCurrentTokenJobProcess: typeof spawnCurrentTokenJobProcess
  closeFileDescriptor(fileDescriptor: number): void
  resolveWindowsExecutable: typeof resolveWindowsExecutable
  pollProcessExit: typeof pollProcessExit
  isJobEmpty: typeof isJobEmpty
  terminateJob: typeof terminateJob
  closeHandleChecked: typeof closeHandleChecked
}

const defaultInternals: SpawnRunnerInternals = {
  /* v8 ignore next -- source/built/packaged subprocess smoke executes this only in a replaceable child process. */
  execve: (file, argv, env) => loadLinuxExecve()(file, argv, env),
  loadWin32ProcessBindings,
  spawnCurrentTokenJobProcess,
  closeFileDescriptor: closeSync,
  resolveWindowsExecutable,
  pollProcessExit,
  isJobEmpty,
  terminateJob,
  closeHandleChecked,
}

const NODE_SPAWN_DETAIL_CODES = new Set(['EACCES', 'ENOENT'])
const WINDOWS_SPAWN_ERROR_CODES = new Map<number, string>([
  [2, 'ENOENT'],
  [3, 'ENOENT'],
  [267, 'ENOENT'],
  [5, 'EPERM'],
  [193, 'EFTYPE'],
  [740, 'EACCES'],
])

function nodeSpawnError(
  syscall: string,
  code: string,
  path?: string,
): SerializedRunnerError {
  const message = `${syscall} ${code}`
  return {
    name: 'Error',
    message,
    code,
    syscall,
    ...path === undefined ? {} : { path },
  }
}

function asSpawnError(
  error: unknown,
  program: string,
): SerializedRunnerError {
  const serialized = serializeRunnerError(error)
  if (!(error instanceof Win32Error)) {
    return serialized.code === undefined
      ? serialized
      : nodeSpawnError(`spawn ${program}`, serialized.code, program)
  }
  const code = WINDOWS_SPAWN_ERROR_CODES.get(error.win32Code) ?? 'UNKNOWN'
  if (NODE_SPAWN_DETAIL_CODES.has(code)) {
    return nodeSpawnError(`spawn ${program}`, code, program)
  }
  return nodeSpawnError('spawn', code)
}

function windowsPathNotFoundError(program: string): SerializedRunnerError {
  return nodeSpawnError(`spawn ${program}`, 'ENOENT', program)
}

function windowsStartCancelledError(): SerializedRunnerError {
  return {
    name: 'Error',
    message: 'subprocess target start was cancelled',
  }
}

function linuxPathNotFoundError(program: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawn ${program} ENOENT`), {
    code: 'ENOENT',
    errno: -2,
    syscall: `spawn ${program}`,
    path: program,
    spawnargs: [] as string[],
  })
}

function execLinuxFile(
  file: string,
  argv: string[],
  env: Record<string, string>,
  internals: SpawnRunnerInternals,
): never {
  try {
    return internals.execve(file, argv, env)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOEXEC') throw error
    return internals.execve('/bin/sh', ['/bin/sh', file, ...argv.slice(1)], env)
  }
}

function execLinuxTarget(
  request: { cwd: string; env: Record<string, string> },
  argv: string[],
  internals: SpawnRunnerInternals,
): never {
  const program = argv[0] as string
  if (program.includes('/')) return execLinuxFile(program, argv, request.env, internals)
  const path = request.env.PATH ?? '/usr/bin:/bin'
  let permissionFailure: Error | undefined
  for (const directory of path.split(':')) {
    const root = directory.startsWith('/')
      ? directory
      : `${request.cwd}${request.cwd.endsWith('/') ? '' : '/'}${directory}`
    const candidate = `${root}${root.endsWith('/') ? '' : '/'}${program}`
    try {
      return execLinuxFile(candidate, argv, request.env, internals)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EACCES') {
        permissionFailure ??= error as Error
        continue
      }
      if (code === 'ENOENT' || code === 'ENOTDIR') continue
      throw error
    }
  }
  throw permissionFailure ?? linuxPathNotFoundError(program)
}

function runLinux(
  locator: string,
  argv: string[],
  host: RunnerHost,
  internals: SpawnRunnerInternals,
): void {
  const files = linuxLaunchFilesFromLocator(locator)
  let request: ReturnType<typeof consumeLinuxLaunchRequest>
  try {
    request = consumeLinuxLaunchRequest(files.requestPath)
  } catch (error) {
    writeLinuxStartupError(files, { type: 'error', error: serializeRunnerError(error) })
    host.exitCode = 127
    return
  }
  try {
    host.chdir(request.cwd)
    execLinuxTarget({ ...request, cwd: host.cwd() }, argv, internals)
  } catch (error) {
    writeLinuxStartupError(files, {
      type: 'error',
      error: asSpawnError(error, argv[0] as string),
    })
    host.exitCode = 127
  }
}

function sendMessage(host: RunnerHost, result: WindowsRunnerResult): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!host.connected || host.send === undefined) {
      reject(new Error('subprocess runner IPC is not connected'))
      return
    }
    try {
      host.send(result, (error) => {
        if (error === null) resolve()
        else reject(error)
      })
    } catch (error) {
      /* v8 ignore next -- process.send throws Error instances. */
      const failure = error instanceof Error ? error : new Error(String(error))
      reject(failure)
    }
  })
}

class WindowsJobRunner {
  private api: CurrentTokenProcessBindings | undefined
  private processHandle: NativePtr | undefined
  private jobHandle: NativePtr | undefined
  private pollTimer: ReturnType<typeof setInterval> | undefined
  private startSeen = false
  private terminateRequested = false
  private resultStarted = false
  private resultDelivered = false
  private finished = false
  private readonly completion = Promise.withResolvers<void>()

  constructor(
    private readonly argv: string[],
    private readonly host: RunnerHost,
    private readonly internals: SpawnRunnerInternals,
  ) {}

  run(): Promise<void> {
    if (!this.host.connected || this.host.send === undefined) {
      this.finish(127)
      return this.completion.promise
    }
    this.host.on('message', this.onMessage)
    this.host.once('disconnect', this.onDisconnect)
    return this.completion.promise
  }

  private readonly onMessage = (value: unknown): void => {
    if (this.finished) return
    if (isWindowsTerminateRequest(value)) {
      this.requestTermination()
      return
    }
    if (this.startSeen) {
      void this.runnerFailure(new Error('subprocess runner received more than one Windows start request'))
      return
    }
    let request: WindowsStartRequest
    try {
      request = parseWindowsStartRequest(value)
    } catch (error) {
      void this.runnerFailure(error)
      return
    }
    this.startSeen = true
    void this.start(request)
  }

  private readonly onDisconnect = (): void => {
    if (this.finished) return
    this.releaseOwnedJob()
    this.finish(127, false)
  }

  private async start(request: WindowsStartRequest): Promise<void> {
    if (this.terminateRequested) {
      await this.publishTerminalResult({ type: 'error', error: windowsStartCancelledError() }, 0)
      return
    }
    await new Promise<void>((resolveImmediate) => { setImmediate(resolveImmediate) })
    if (this.finished) return
    // IPC may set this field while start() is suspended above.
    // oxlint-disable-next-line typescript/no-unnecessary-condition
    if (this.terminateRequested) {
      await this.publishTerminalResult({ type: 'error', error: windowsStartCancelledError() }, 0)
      return
    }
    try {
      const [command, ...args] = this.argv
      const applicationName = this.internals.resolveWindowsExecutable(
        command as string,
        request.cwd,
        request.env,
        undefined,
        { ...this.host.env },
      )
      if (applicationName === undefined) {
        await this.publishTerminalResult({
          type: 'error',
          error: windowsPathNotFoundError(command as string),
        }, 0)
        return
      }
      this.api = this.internals.loadWin32ProcessBindings()
      const spawned = this.internals.spawnCurrentTokenJobProcess(this.api, {
        command: command as string,
        applicationName,
        args,
        cwd: request.cwd,
        env: request.env,
        stdio: { stdin: 4, stdout: 5, stderr: 6 },
      })
      this.processHandle = spawned.process
      this.jobHandle = spawned.job
      for (const fileDescriptor of [4, 5, 6]) {
        this.internals.closeFileDescriptor(fileDescriptor)
      }
      this.pollTimer = setInterval(() => { this.poll() }, 10)
    } catch (error) {
      if (this.jobHandle === undefined && error instanceof Win32Error && error.api === 'CreateProcessW') {
        await this.publishTerminalResult({
          type: 'error',
          error: asSpawnError(error, this.argv[0] as string),
        }, 0)
        return
      }
      await this.runnerFailure(error)
    }
  }

  private requestTermination(): void {
    if (this.terminateRequested) return
    this.terminateRequested = true
    try {
      this.terminateOwnedJob()
    } catch (error) {
      void this.runnerFailure(error)
    }
  }

  private terminateOwnedJob(): void {
    const job = this.jobHandle
    if (job === undefined) return
    /* v8 ignore next -- a Job handle is assigned only after the bindings are loaded;
     * the guard above is the only reachable empty-owner state. */
    if (this.api === undefined) return
    this.internals.terminateJob(this.api, job, 1)
  }

  private poll(): void {
    if (this.finished) return
    /* v8 ignore next -- poll is installed only after start() stores the bindings; retained as a defensive invariant guard. */
    if (this.api === undefined) return
    try {
      if (this.processHandle !== undefined) {
        const exitCode = this.internals.pollProcessExit(this.api, this.processHandle)
        if (exitCode !== undefined) {
          this.internals.closeHandleChecked(this.api, this.processHandle, 'ordinary direct process')
          this.processHandle = undefined
          void this.publishTerminalResult({ type: 'target-exit', exitCode })
        }
      }
      if (this.jobHandle !== undefined && this.internals.isJobEmpty(this.api, this.jobHandle)) {
        this.internals.closeHandleChecked(this.api, this.jobHandle, 'ordinary process Job')
        this.jobHandle = undefined
        if (this.resultDelivered) this.finish(0)
      }
    } catch (error) {
      void this.runnerFailure(error)
    }
  }

  private async publishTerminalResult(result: WindowsRunnerResult, exitCode?: number): Promise<void> {
    /* v8 ignore next -- each state transition has a single result call site; the guard contains only re-entrant internal defects. */
    if (this.finished || this.resultStarted) return
    this.resultStarted = true
    try {
      await sendMessage(this.host, result)
      this.resultDelivered = true
    } catch {
      this.releaseOwnedJob()
      this.finish(127, false)
      return
    }
    if (exitCode !== undefined) {
      this.finish(exitCode)
      return
    }
    if (this.jobHandle === undefined) this.finish(0)
  }

  private async runnerFailure(error: unknown): Promise<void> {
    /* v8 ignore next -- callers stop/detach on finish; this guard contains only an already-queued internal callback. */
    if (this.finished) return
    if (!this.resultStarted) {
      this.resultStarted = true
      try {
        await sendMessage(this.host, { type: 'error', error: serializeRunnerError(error) })
        this.resultDelivered = true
      } catch {
        // The disconnected parent observes runner infrastructure failure.
      }
    }
    this.releaseOwnedJob()
    this.finish(127)
  }

  private releaseOwnedJob(): void {
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer)
    this.pollTimer = undefined
    const api = this.api
    if (api === undefined) return
    if (this.jobHandle !== undefined) {
      try { this.internals.terminateJob(api, this.jobHandle, 1) } catch { /* Continue to kill-on-close. */ }
      try { this.internals.closeHandleChecked(api, this.jobHandle, 'ordinary process Job cleanup') } catch { /* Best effort after failure. */ }
      this.jobHandle = undefined
    }
    if (this.processHandle !== undefined) {
      try { this.internals.closeHandleChecked(api, this.processHandle, 'ordinary direct process cleanup') } catch { /* Best effort after failure. */ }
      this.processHandle = undefined
    }
  }

  private finish(exitCode: number, disconnect = true): void {
    if (this.finished) return
    this.finished = true
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer)
    this.pollTimer = undefined
    this.host.off('message', this.onMessage)
    this.host.off('disconnect', this.onDisconnect)
    this.host.exitCode = exitCode
    if (disconnect && this.host.connected) this.host.disconnect()
    this.completion.resolve()
  }
}

/**
 * Execute the selected Linux bootstrap or Windows Job runner.
 * @param selection - Windows sentinel or Linux launch-request locator.
 * @param argv - private runner arguments beginning with the target delimiter.
 * @param host - process transport and lifecycle host.
 * @param internals - native and filesystem operations used by the runner.
 */
export async function runSpawnRunner(
  selection: string,
  argv: readonly string[],
  host: RunnerHost = process,
  internals: SpawnRunnerInternals = defaultInternals,
): Promise<void> {
  Reflect.deleteProperty(host.env, SUBPROCESS_RUNNER_ENV)
  const targetArgv = parseRunnerTargetArgv(argv)
  if (selection === WINDOWS_RUNNER_SELECTION) {
    await new WindowsJobRunner(targetArgv, host, internals).run()
    return
  }
  runLinux(selection, targetArgv, host, internals)
}

/**
 * Best-effort reporting for failures before the selected runner established its owner.
 * @param selection - Windows sentinel, Linux launch-request locator, or no selection.
 * @param error - failure raised before normal runner settlement.
 * @param host - process transport and lifecycle host.
 */
export async function reportSpawnRunnerFailure(
  selection: string | undefined,
  error: unknown,
  host: RunnerHost = process,
): Promise<void> {
  if (selection === WINDOWS_RUNNER_SELECTION) {
    try { await sendMessage(host, { type: 'error', error: serializeRunnerError(error) }) } catch { /* No transport remains. */ }
    host.exitCode = 127
    if (host.connected) host.disconnect()
    return
  }
  if (selection !== undefined) {
    try {
      const files: LinuxLaunchFiles = linuxLaunchFilesFromLocator(selection)
      writeLinuxStartupError(files, { type: 'error', error: serializeRunnerError(error) })
    } catch {
      // The parent will report an unconsumed request or missing runner result.
    }
  }
  host.exitCode = 127
}
