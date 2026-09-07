/**
 * Local Service Provider for the subprocess capability seam. Each spawn owns a
 * platform-selected managed range with the spec's per-stream stdio dispositions.
 * Normal disposal terminates and joins live ranges; Node's synchronous exit
 * phase force-stops any ranges the service still owns. It has no config: every
 * disposition and limit arrives on the spec, so deployment-varying choices
 * stay with the caller's config (the bash executor's, the LSP host's, …).
 * @module @deepseek-ai/dsh-subprocess-local
 */

import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, extname, isAbsolute, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as nodePty from 'node-pty'
import type { IPtyForkOptions } from 'node-pty'
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import {
  bindManagedProcess,
  childEnv,
  prepareManagedProcessBinding,
  spawnSubprocess,
  validateSubprocessSpec,
} from './spawn.ts'
import type { LocalSubprocessHandle, SpawnInternals } from './spawn.ts'
import {
  launchLinuxScope,
  prepareLinuxTerminalScope,
  probeLinuxManager,
  probeLinuxNative,
} from './linux-scope.ts'
import { launchWindowsJob, probeWindowsJob } from './windows-job.ts'
import { targetEnvironment } from './runner-launch.ts'
import { createProcessInspector } from './process-inspector.ts'
import type { ProcessInspector } from './process-inspector.ts'
import { LocalTerminalHandle } from './terminal.ts'

/**
 * Local subprocess service: platform-selected managed ranges, Node-shaped stdio
 * dispositions (raw pipes, inherit, bounded tail-keep collection with spill
 * files), credential-scrubbed environment, and provider-owned range signalling.
 * POSIX paths stage TERM before KILL; Windows paths terminate immediately.
 * JavaScript-observable host exit also performs synchronous final termination.
 */
export class LocalSubprocessRuntime extends SubprocessRuntime {
  /** Live handles retained for normal disposal and synchronous host-exit finalization. */
  private live = new Set<LocalSubprocessHandle>()
  /** Live terminals retained through normal quiescence or host-exit finalization. */
  private terminals = new Set<LocalTerminalHandle>()
  /** Test hook: process, spill, and platform operations forwarded to spawnSubprocess. */
  internals: SpawnInternals = {}
  /** Provider-lifetime latch suppressing repeated weaker-containment warnings. */
  private fallbackWarningIssued = false
  /** Positive-only cache for the expensive Linux bootstrap and scope probe. */
  private linuxDeepProbePassed = false
  /** Test hook for platform process inspection; production resolves lazily on terminal spawn. */
  terminalInspector: ProcessInspector | undefined

  constructor(ctx: Context) {
    super(ctx)
    ctx.effect(() => {
      const onHostExit = (): void => { this.terminateForHostExit() }
      process.prependListener('exit', onHostExit)
      return async () => {
        await this.disposeManagedProcesses()
        process.off('exit', onHostExit)
      }
    }, 'local subprocess teardown')
  }

  private terminateForHostExit(): void {
    for (const handle of this.live) {
      try {
        handle.terminateForHostExit()
      } catch (_ordinaryRangeTerminationFailed) {
        // Host exit cannot await or report one target; continue with the rest.
      }
    }
    for (const terminal of this.terminals) {
      try {
        terminal.terminateForHostExit()
      } catch (_terminalTerminationFailed) {
        // One terminal must not prevent final termination of another target.
      }
    }
  }

  private async disposeManagedProcesses(): Promise<void> {
    // Request termination, then await MANAGED-RANGE exit — not just the
    // direct command's settlement — so even a surviving descendant cannot
    // outlive the fiber. Keep both sets authoritative while these waits are
    // pending so a shorter process-level exit bound can still force-kill them.
    const pending: Promise<unknown>[] = []
    for (const handle of this.live) {
      handle.terminate()
      // Direct result and range observation are independent. Start both so an
      // unreadable owner cannot hide behind a result that never settles.
      pending.push(Promise.all([
        handle.done.catch(() => {}),
        handle.waitForExit(),
      ]).then(() => { this.live.delete(handle) }))
    }
    for (const terminal of this.terminals) {
      pending.push(terminal.terminate().then(() => { this.terminals.delete(terminal) }))
    }
    const outcomes = await Promise.allSettled(pending)
    const failures: unknown[] = []
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') failures.push(outcome.reason)
    }
    if (failures.length > 0) this.terminateForHostExit()
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'local subprocess teardown failed')
  }

  async resolveExecutable(
    command: string,
    env?: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    if (command.length === 0) throw new Error('subprocess-local: executable must be non-empty')
    signal?.throwIfAborted()
    const environment = childEnv(env)
    const absolute = isAbsolute(command)
    if (!absolute && (command.includes('/') || (process.platform === 'win32' && command.includes('\\')))) {
      throw new Error(
        `subprocess-local: command ${JSON.stringify(command)} is a relative path; use an absolute path or a bare PATH name`,
      )
    }
    const candidates = absolute ? [command] : this.executableCandidates(command, environment)
    for (const candidate of candidates) {
      signal?.throwIfAborted()
      try {
        const info = await stat(candidate)
        if (!info.isFile()) continue
        await access(candidate, constants.X_OK)
        signal?.throwIfAborted()
        return candidate
      } catch {
        // Try the next PATH candidate; the final miss receives one stable error.
      }
    }
    signal?.throwIfAborted()
    throw new Error(absolute
      ? `subprocess-local: command ${JSON.stringify(command)} is not an executable file`
      : `subprocess-local: command ${JSON.stringify(command)} was not found on PATH`)
  }

  private executableCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
    const path = environmentValue(env, 'PATH') ?? ''
    const extensions = process.platform === 'win32' && extname(command) === ''
      ? (environmentValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';')
      : ['']
    return path.split(delimiter).flatMap(directory =>
      extensions.map(extension => resolve(process.cwd(), directory, command + extension)))
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    validateSubprocessSpec(spec)
    const env = targetEnvironment(spec)
    const containmentMode = this.selectContainmentMode('ordinary')
    let handle: LocalSubprocessHandle
    if (containmentMode === 'fallback') {
      handle = spawnSubprocess(spec, this.internals)
    } else {
      const binding = prepareManagedProcessBinding(this.internals)
      const launch = containmentMode === 'linux-scope'
        ? launchLinuxScope(spec, env)
        : launchWindowsJob(spec, env)
      handle = bindManagedProcess(spec, launch, binding)
    }
    this.live.add(handle)
    // Release ownership only once the whole managed range is gone, not at direct-child
    // settlement — a TERM-trapping helper that outlives the leader must stay
    // owned so teardown can still escalate it. For the common no-survivor
    // case waitForExit resolves immediately after settlement.
    const release = (): Promise<void> =>
      handle.waitForExit().then(() => { this.live.delete(handle) })
    void handle.done.then(release, release).catch(() => {})
    return handle
  }

  private selectContainmentMode(
    kind: 'ordinary' | 'terminal',
  ): 'linux-scope' | 'windows-job' | 'fallback' {
    const platform = this.internals.platform ?? process.platform
    let fallbackReason: string | undefined
    if (platform === 'linux') {
      const available = this.linuxDeepProbePassed
        ? probeLinuxManager()
        : probeLinuxNative()
      if (available) this.linuxDeepProbePassed = true
      if (available) return 'linux-scope'
      fallbackReason = 'the current user-systemd scope or private bootstrap is unavailable'
    }
    if (kind === 'ordinary' && platform === 'win32') {
      const available = probeWindowsJob()
      if (available) return 'windows-job'
    }
    this.warnFallback(platform, kind, fallbackReason)
    return 'fallback'
  }

  private warnFallback(
    platform: NodeJS.Platform,
    kind: 'ordinary' | 'terminal',
    selectedReason?: string,
  ): void {
    if (this.fallbackWarningIssued) return
    this.fallbackWarningIssued = true
    const reason = selectedReason ?? (platform === 'darwin'
      ? 'macOS has no supported persistent process-range owner'
      : platform === 'win32'
        ? kind === 'terminal'
          ? 'Windows ConPTY remains outside Job containment'
          : 'the Win32 Job runner is unavailable'
        : `platform ${platform} has no native managed range`)
    this.ctx.logger.warn(
      `subprocess-local is using weaker process-tree containment because ${reason}; descendants that escape the process group or direct-parent tree are not guaranteed to terminate or delay waitForExit()`,
    )
  }

  // Local PTY allocation is synchronous, but the provider contract permits remote asynchronous allocation.
  // oxlint-disable-next-line typescript/require-await -- Preserve promise rejection semantics at the async provider contract.
  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    const file = spec.argv[0]
    if (file === undefined || file.length === 0) {
      throw new Error('subprocess-local: terminal argv must contain a program')
    }
    spec.signal?.throwIfAborted()
    const env = targetEnvironment(spec)
    const options: IPtyForkOptions = {
      name: 'dumb',
      rows: spec.rows,
      cols: spec.cols,
      cwd: spec.cwd,
      env,
    }
    const inspector = this.terminalInspector ?? createProcessInspector()
    const containmentMode = this.selectContainmentMode('terminal')
    const scope = containmentMode === 'linux-scope'
      ? prepareLinuxTerminalScope(spec, {
        ...env,
        PWD: spec.cwd,
        TERM: 'dumb',
      })
      : undefined
    if (scope !== undefined) {
      options.cwd = scope.cwd
      options.env = scope.env
    }
    let terminal: nodePty.IPty
    try {
      terminal = nodePty.spawn(
        scope?.command ?? file,
        scope?.args ?? [...spec.argv.slice(1)],
        options,
      )
    } catch (error) {
      scope?.cleanup()
      throw error
    }
    // oxlint-disable-next-line eslint/prefer-const -- The owner can query readiness before the handle is published.
    let handle: LocalTerminalHandle | undefined
    const owner = scope?.bindOwner({
      running: () => handle?.running ?? true,
      signal: (signal) => {
        try { terminal.kill(signal) } catch { /* Direct process already exited. */ }
      },
    })
    handle = new LocalTerminalHandle(
      terminal,
      inspector,
      spec.graceMs,
      this.internals.platform ?? process.platform,
      owner,
      scope?.resolveOutcome,
    )
    this.terminals.add(handle)
    const release = async (): Promise<void> => {
      await handle.terminate()
      this.terminals.delete(handle)
    }
    void handle.done.then(release, release).catch(() => {})
    return handle
  }
}

/** Read a Windows environment key using the platform's case-insensitive semantics. */
function environmentValue(env: NodeJS.ProcessEnv, name: 'PATH' | 'PATHEXT'): string | undefined {
  const exact = env[name]
  if (exact !== undefined || process.platform !== 'win32') return exact
  const normalized = name.toUpperCase()
  return Object.entries(env).find(([key]) => key.toUpperCase() === normalized)?.[1]
}

export default LocalSubprocessRuntime
