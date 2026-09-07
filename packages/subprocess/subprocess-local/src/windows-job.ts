/** Windows parent-side launch and ownership for the private Job runner. */

import { spawn } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { devNull } from 'node:os'
import type { Readable, Writable } from 'node:stream'
import type { SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  loadWin32ProcessBindings,
  probeCurrentTokenJobSupport,
} from '@deepseek-ai/dsh-win32-process'
import type { BoundProcessOwner, ManagedProcessLaunch } from './managed-owner.ts'
import {
  type SerializedRunnerError,
  type WindowsRunnerResult,
  deserializeRunnerError,
  parseWindowsRunnerResult,
} from './runner-protocol.ts'
import {
  runnerEnvironment,
  runnerInvocationAvailable,
  runnerStdio,
  spawnRunnerInvocation,
  WINDOWS_RUNNER_SELECTION,
} from './runner-launch.ts'
import type { RunnerInvocation } from './runner-launch.ts'

/** Test seams for runner launch and dynamic capability checks. */
export interface WindowsJobInternals {
  spawn?: typeof spawn
  runnerInvocation?: RunnerInvocation
  resolveRunnerInvocation?: () => RunnerInvocation
  runnerAvailable?: (invocation: RunnerInvocation) => boolean
  loadWin32ProcessBindings?: typeof loadWin32ProcessBindings
  probeCurrentTokenJobSupport?: typeof probeCurrentTokenJobSupport
}

type RunnerProcess = Omit<ReturnType<typeof spawn>, 'send' | 'stdio'> & {
  send?: ReturnType<typeof spawn>['send']
  stdio: Array<Readable | Writable | null>
}

function isWindowsStartCancellationError(error: SerializedRunnerError): boolean {
  return error.name === 'Error'
    && error.message === 'subprocess target start was cancelled'
    && error.code === undefined
    && error.syscall === undefined
    && error.path === undefined
}

/**
 * Re-check the runner entry, bindings, and current Job capability for every spawn.
 * @param internals - optional runner and Win32 capability seams used by tests.
 * @returns whether the Windows native containment path is currently available.
 */
export function probeWindowsJob(internals: WindowsJobInternals = {}): boolean {
  try {
    const invocation = internals.runnerInvocation
      ?? (internals.resolveRunnerInvocation ?? spawnRunnerInvocation)()
    if (!(internals.runnerAvailable ?? runnerInvocationAvailable)(invocation)) return false
    const api = (internals.loadWin32ProcessBindings ?? loadWin32ProcessBindings)()
    ;(internals.probeCurrentTokenJobSupport ?? probeCurrentTokenJobSupport)(api)
    return true
  } catch {
    return false
  }
}

class WindowsJobOwner implements BoundProcessOwner {
  private cancellationReason: unknown
  private cancellationReasonSet = false
  private terminationSent = false

  constructor(
    private readonly runner: RunnerProcess,
    private readonly exited: Promise<void>,
    private readonly directResultType: () => WindowsRunnerResult['type'] | undefined,
    private readonly failInfrastructure: (error: unknown) => void,
  ) {
    void this.exited.catch(() => {})
  }

  signal(_signal: 'SIGTERM' | 'SIGKILL', cancellationReason?: unknown): void {
    if (!this.cancellationReasonSet) {
      this.cancellationReason = cancellationReason
      this.cancellationReasonSet = true
    }
    if (this.terminationSent || !this.runner.connected) return
    this.terminationSent = true
    try {
      this.runner.send?.({ type: 'terminate' }, (error) => {
        if (error === null || this.directResultType() !== undefined) return
        this.failInfrastructure(error)
        this.terminateForHostExit()
      })
    } catch (error) {
      this.failInfrastructure(error)
      this.terminateForHostExit()
    }
  }

  mapStartFailure(failure: unknown, serialized: SerializedRunnerError): unknown {
    return this.cancellationReasonSet && isWindowsStartCancellationError(serialized)
      ? this.cancellationReason
      : failure
  }

  async waitForExit(): Promise<void> {
    await this.exited
  }

  terminateForHostExit(): void {
    try { this.runner.kill('SIGKILL') } catch { /* Host exit continues with other live runners. */ }
  }
}

/**
 * Launch one target through a runner that uniquely owns its Job handle.
 * @param spec - ordinary target request.
 * @param targetEnv - validated complete target environment.
 * @param internals - optional runner launch seams used by tests.
 * @returns direct streams, result, and runner-owned managed range.
 */
export function launchWindowsJob(
  spec: SubprocessSpawnSpec,
  targetEnv: Record<string, string>,
  internals: WindowsJobInternals = {},
): ManagedProcessLaunch {
  const invocation = internals.runnerInvocation ?? spawnRunnerInvocation()
  const [command, ...prefix] = invocation
  const ignoredStdinFd = spec.stdio.stdin === 'ignore' ? openSync(devNull, 'r') : undefined
  let child: RunnerProcess
  try {
    child = (internals.spawn ?? spawn)(command, [
      ...prefix,
      '--',
      ...spec.argv,
    ], {
      cwd: process.cwd(),
      env: runnerEnvironment(WINDOWS_RUNNER_SELECTION, invocation),
      stdio: runnerStdio(spec, true, ignoredStdinFd ?? 'pipe'),
    }) as RunnerProcess
  } finally {
    if (ignoredStdinFd !== undefined) closeSync(ignoredStdinFd)
  }
  const targetStdin = child.stdio[4] as Writable | null

  const direct = Promise.withResolvers<SubprocessOutcome>()
  const rangeExit = Promise.withResolvers<void>()
  let directResultType: WindowsRunnerResult['type'] | undefined
  let runnerSpawned = false
  const failInfrastructure = (error: unknown): void => {
    direct.reject(error)
    rangeExit.reject(error)
  }

  const owner = new WindowsJobOwner(
    child,
    rangeExit.promise,
    () => directResultType,
    failInfrastructure,
  )
  child.on('message', (value: unknown) => {
    if (directResultType !== undefined) {
      const error = new Error('subprocess-local: Windows runner emitted more than one direct result')
      failInfrastructure(error)
      owner.terminateForHostExit()
      return
    }
    let result: ReturnType<typeof parseWindowsRunnerResult>
    try {
      result = parseWindowsRunnerResult(value)
    } catch (error) {
      failInfrastructure(error)
      owner.terminateForHostExit()
      return
    }
    directResultType = result.type
    if (result.type === 'target-exit') {
      direct.resolve({ exitCode: result.exitCode, signal: null })
    } else {
      direct.reject(owner.mapStartFailure(deserializeRunnerError(result.error), result.error))
    }
  })
  child.once('spawn', () => {
    runnerSpawned = true
    try {
      if (child.send === undefined) throw new Error('subprocess-local: Windows runner has no IPC channel')
      child.send({ type: 'start', cwd: spec.cwd, env: targetEnv }, (error) => {
        if (error === null) return
        failInfrastructure(error)
        owner.terminateForHostExit()
      })
    } catch (error) {
      failInfrastructure(error)
      owner.terminateForHostExit()
    }
  })
  child.once('error', (error) => {
    if (!runnerSpawned) {
      direct.reject(error)
      rangeExit.resolve()
      return
    }
    failInfrastructure(error)
  })
  child.once('close', (exitCode, signal) => {
    if (!runnerSpawned) return
    const clean = exitCode === 0 && signal === null && directResultType !== undefined
    if (clean) {
      rangeExit.resolve()
      return
    }
    const status = signal !== null
      ? `signal ${signal}`
      : exitCode === null
        ? 'without an exit status'
        : `exit code ${String(exitCode)}`
    const error = new Error(
      `subprocess-local: Windows Job runner exited with ${status} before proving its managed range empty`,
    )
    failInfrastructure(error)
  })

  return {
    stdin: spec.stdio.stdin === 'ignore' ? null : targetStdin,
    stdout: child.stdio[5] as Readable | null,
    stderr: child.stdio[6] as Readable | null,
    direct: direct.promise,
    owner,
  }
}
