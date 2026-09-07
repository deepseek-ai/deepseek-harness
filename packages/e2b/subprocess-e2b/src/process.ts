/** One asynchronously-started E2B command projected onto the subprocess seam. */

import { Buffer } from 'node:buffer'
import { PassThrough, Writable } from 'node:stream'
import { posix } from 'node:path'
import {
  CommandExitError,
  e2bControlEnvs,
  FileNotFoundError,
  SandboxNotFoundError,
  quoteE2BShellArg,
} from '@deepseek-ai/dsh-e2b'
import type { CommandHandle, CommandResult, Sandbox } from '@deepseek-ai/dsh-e2b'
import type {
  SubprocessCollect,
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessOutputMode,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'
import type E2BRuntime from '@deepseek-ai/dsh-e2b'
import { bootstrapEnvironment, readRemoteEnvironment, serializeRemoteEnvironment } from './environment.ts'
import { E2BBase64Decoder, E2B_OUTPUT_COMPLETE_FRAME, E2BOutputReader } from './output.ts'
import { asError, commandOpts, signalRemoteGroups, waitTick } from './remote.ts'

const OUTPUT_ENCODER_SOURCE = [
  '(async () => {',
  '  for await (const chunk of process.stdin) {',
  "    if (!process.stdout.write(chunk.toString('base64') + '\\n')) {",
  "      await new Promise(resolve => process.stdout.once('drain', resolve))",
  '    }',
  '  }',
  `  if (!process.stdout.write(${JSON.stringify(E2B_OUTPUT_COMPLETE_FRAME)} + '\\n')) {`,
  "    await new Promise(resolve => process.stdout.once('drain', resolve))",
  '  }',
  '})().catch(() => { process.exitCode = 1 })',
].join('\n')

function isCollect(mode: SubprocessOutputMode): mode is SubprocessCollect {
  return mode !== 'pipe' && mode !== 'inherit'
}

function hasSpill(mode: SubprocessOutputMode): mode is SubprocessCollect & { spill: { maxBytes: number } } {
  return isCollect(mode) && mode.spill !== undefined
}

function isValidProcessId(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

class DeferredStdin extends Writable {
  constructor(private readonly ready: Promise<CommandHandle>) {
    super({ decodeStrings: false })
  }

  override _write(chunk: string | Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    void this.ready.then(handle => handle.sendStdin(chunk)).then(
      () => { callback() },
      (error: unknown) => { callback(asError(error)) },
    )
  }

  override _final(callback: (error?: Error | null) => void): void {
    void this.ready.then(handle => handle.closeStdin()).then(
      () => { callback() },
      (error: unknown) => { callback(asError(error)) },
    )
  }
}

interface RemotePaths {
  pid: string
  status: string
  environment: string
  stdout: string
  stderr: string
}

type CommandSettlement =
  | { kind: 'result'; result: CommandResult }
  | { kind: 'error'; error: unknown }

function withinMs(settlement: Promise<CommandSettlement>, timeoutMs: number): Promise<CommandSettlement | undefined> {
  return new Promise<CommandSettlement | undefined>((resolve) => {
    const timer = setTimeout(() => { resolve(undefined) }, timeoutMs)
    void settlement.then((value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

function commandText(spec: SubprocessSpawnSpec, paths: RemotePaths): string {
  const encoder = `"$dsh_e2b_env_bin" -i "$dsh_e2b_node" -e ${quoteE2BShellArg(OUTPUT_ENCODER_SOURCE)}`
  const stdoutRedirect = hasSpill(spec.stdio.stdout)
    ? `> >("$dsh_e2b_tee" --output-error=warn-nopipe >("$dsh_e2b_head" -c ${spec.stdio.stdout.spill.maxBytes} > ${quoteE2BShellArg(paths.stdout)}) | ${encoder} 2>/dev/null)`
    : `> >(${encoder} 2>/dev/null)`
  const stderrRedirect = hasSpill(spec.stdio.stderr)
    ? `2> >("$dsh_e2b_tee" --output-error=warn-nopipe >("$dsh_e2b_head" -c ${spec.stdio.stderr.spill.maxBytes} > ${quoteE2BShellArg(paths.stderr)}) | ${encoder} >&2 2>/dev/null)`
    : `2> >(${encoder} >&2 2>/dev/null)`
  const inner = [
    'set +e',
    'dsh_e2b_env_bin=$1',
    'dsh_e2b_node=$2',
    'dsh_e2b_ps=$3',
    'dsh_e2b_tr=$4',
    'dsh_e2b_tee=$5',
    'dsh_e2b_head=$6',
    'dsh_e2b_rm=$7',
    'shift 7',
    'dsh_e2b_pgid="$("$dsh_e2b_ps" -o pgid= -p "$$" | "$dsh_e2b_tr" -d " ")"',
    `printf '%s\\n' "$dsh_e2b_pgid" > ${quoteE2BShellArg(paths.pid)}`,
    `mapfile -d '' -t dsh_e2b_env < ${quoteE2BShellArg(paths.environment)}`,
    `"$dsh_e2b_rm" -f -- ${quoteE2BShellArg(paths.environment)}`,
    `"$dsh_e2b_env_bin" -i -- "\${dsh_e2b_env[@]}" "$@" ${stdoutRedirect} ${stderrRedirect}`.trimEnd(),
    'dsh_e2b_status=$?',
    `printf '%s\\n' "$dsh_e2b_status" > ${quoteE2BShellArg(paths.status)}`,
    'wait',
    'exit "$dsh_e2b_status"',
  ].join('\n')
  const argv = spec.argv.map(quoteE2BShellArg).join(' ')
  const bootstrap = [
    `mapfile -d '' -t dsh_e2b_env < ${quoteE2BShellArg(paths.environment)}`,
    'dsh_e2b_env_bin="$(command -v env)"',
    'dsh_e2b_setsid="$(command -v setsid)"',
    'dsh_e2b_bash="$(command -v bash)"',
    'dsh_e2b_node="$(command -v node)"',
    'dsh_e2b_ps="$(command -v ps)"',
    'dsh_e2b_tr="$(command -v tr)"',
    'dsh_e2b_tee="$(command -v tee)"',
    'dsh_e2b_head="$(command -v head)"',
    'dsh_e2b_rm="$(command -v rm)"',
    'for dsh_e2b_tool in "$dsh_e2b_env_bin" "$dsh_e2b_setsid" "$dsh_e2b_bash" "$dsh_e2b_node" "$dsh_e2b_ps" "$dsh_e2b_tr" "$dsh_e2b_tee" "$dsh_e2b_head" "$dsh_e2b_rm"; do',
    '  [[ "$dsh_e2b_tool" == /* && -x "$dsh_e2b_tool" ]] || exit 125',
    'done',
    `exec "$dsh_e2b_env_bin" -i -- "\${dsh_e2b_env[@]}" "$dsh_e2b_setsid" --wait -- "$dsh_e2b_bash" -c ${quoteE2BShellArg(inner)} dsh-e2b "$dsh_e2b_env_bin" "$dsh_e2b_node" "$dsh_e2b_ps" "$dsh_e2b_tr" "$dsh_e2b_tee" "$dsh_e2b_head" "$dsh_e2b_rm" ${argv}`,
  ].join('\n')
  return bootstrap
}

const WAIT_ABORTED = Symbol('wait aborted')

function waitWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T | typeof WAIT_ABORTED> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.resolve(WAIT_ABORTED)
  return new Promise<T | typeof WAIT_ABORTED>((resolve) => {
    const onAbort = (): void => { cleanup(); resolve(WAIT_ABORTED) }
    const cleanup = (): void => { signal.removeEventListener('abort', onAbort) }
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) {
      onAbort()
      return
    }
    void promise.then((value) => { cleanup(); resolve(value) })
  })
}

/** E2B-backed subprocess handle with private remote process-group tracking. */
export class E2BSubprocessHandle implements SubprocessHandle {
  readonly stdin: Writable | undefined
  readonly stdout: PassThrough | undefined
  readonly stderr: PassThrough | undefined
  readonly collected: SubprocessHandle['collected']
  readonly done: Promise<SubprocessOutcome>

  private readonly commandState = Promise.withResolvers<CommandHandle | undefined>()
  private readonly readyState = Promise.withResolvers<CommandHandle>()
  private readonly stdoutDecoder = new E2BBase64Decoder()
  private readonly stderrDecoder = new E2BBase64Decoder()
  private readonly terminationController = new AbortController()
  /** Releases output waits that survive the command outcome, so blocked SDK callbacks settle. */
  private readonly outputReleased = new AbortController()
  private readonly stdoutReader: E2BOutputReader | undefined
  private readonly stderrReader: E2BOutputReader | undefined
  private readonly paths: RemotePaths
  private controlEnvs: Record<string, string> = {}
  private remoteProcessGroupId: number | undefined
  private outputTransportError: Error | undefined
  private outputDrainExpired = false
  private stateDirectoryCreated = false
  private quiescenceProven = false
  private terminationAttempt: Promise<void> | undefined
  private terminationFailure: Error | undefined
  private terminationSignal: NodeJS.Signals | null = null

  /**
   * Begin an E2B command without blocking the synchronous subprocess spawn call.
   * @param runtime - Shared E2B sandbox owner.
   * @param spec - Fully resolved subprocess request.
   * @param stateDir - Remote directory retaining process identity, status, and valid spills.
   * @param pollMs - Remote status/liveness poll cadence.
   */
  constructor(
    private readonly runtime: E2BRuntime,
    private readonly spec: SubprocessSpawnSpec,
    readonly stateDir: string,
    private readonly pollMs: number,
  ) {
    this.paths = {
      pid: posix.join(stateDir, 'pid'),
      status: posix.join(stateDir, 'exit-code'),
      environment: posix.join(stateDir, 'environment'),
      stdout: posix.join(stateDir, 'stdout.log'),
      stderr: posix.join(stateDir, 'stderr.log'),
    }
    const outMode = spec.stdio.stdout
    const errMode = spec.stdio.stderr
    this.stdout = outMode === 'pipe' ? new PassThrough() : undefined
    this.stderr = errMode === 'pipe' ? new PassThrough() : undefined
    this.stdoutReader = isCollect(outMode)
      ? new E2BOutputReader(outMode.maxBytes, outMode.spill?.maxBytes, this.paths.stdout)
      : undefined
    this.stderrReader = isCollect(errMode)
      ? new E2BOutputReader(errMode.maxBytes, errMode.spill?.maxBytes, this.paths.stderr)
      : undefined
    this.collected = {
      ...(this.stdoutReader !== undefined ? { stdout: this.stdoutReader } : {}),
      ...(this.stderrReader !== undefined ? { stderr: this.stderrReader } : {}),
    }
    this.stdin = spec.stdio.stdin === 'pipe' ? new DeferredStdin(this.readyState.promise) : undefined
    void this.readyState.promise.catch(() => {})
    spec.signal?.addEventListener('abort', this.onAbort, { once: true })
    this.done = this.run()
    void this.done.catch(() => {})
    if (spec.signal?.aborted === true) this.terminate()
  }

  /** @inheritdoc */
  terminate(): void {
    if (this.quiescenceProven || this.terminationAttempt !== undefined) return
    this.terminationController.abort(new Error('subprocess-e2b: command terminated'))
    this.stdout?.destroy()
    this.stderr?.destroy()
    this.terminationFailure = undefined
    const attempt = this.terminateRemote()
    this.terminationAttempt = attempt
    void attempt.then(
      () => { this.terminationAttempt = undefined },
      (error: unknown) => {
        if (!this.quiescenceProven) this.terminationFailure = asError(error)
        this.terminationAttempt = undefined
      },
    )
  }

  /** @inheritdoc */
  async waitForExit(signal?: AbortSignal): Promise<boolean> {
    if (this.quiescenceProven) return true
    let handle: CommandHandle | undefined
    if (this.terminationController.signal.aborted) {
      const observed = await waitWithSignal(this.commandState.promise, signal)
      if (observed === WAIT_ABORTED) return false
      handle = observed
      if (handle === undefined) {
        this.markQuiescent()
        return true
      }
      if (this.remoteProcessGroupId === undefined) {
        const attempt = this.terminationAttempt
        if (attempt !== undefined && await waitWithSignal(attempt.catch(() => undefined), signal) === WAIT_ABORTED) {
          return false
        }
        this.throwTerminationFailure()
        // Successful pre-publication termination records quiescence; its only other outcome is the failure above.
        return true
      }
    } else {
      const observed = await waitWithSignal(
        this.readyState.promise.catch(() => this.commandState.promise),
        signal,
      )
      if (observed === WAIT_ABORTED) return false
      handle = observed
      if (handle === undefined) {
        this.markQuiescent()
        return true
      }
    }
    this.throwTerminationFailure()
    let sandbox: Sandbox
    try {
      sandbox = await this.runtime.getSandbox()
    } catch (error: unknown) {
      if (signal?.aborted === true) return false
      if (error instanceof SandboxNotFoundError) {
        this.markQuiescent()
        return true
      }
      throw error
    }
    const processGroupId = this.remoteProcessGroupId ?? handle.pid
    while (await this.groupAlive(sandbox, processGroupId, signal)) {
      this.throwTerminationFailure()
      if (!await waitTick(this.pollMs, signal)) return false
    }
    this.throwTerminationFailure()
    if (signal?.aborted === true) return false
    this.markQuiescent()
    return true
  }

  private readonly onAbort = (): void => { this.terminate() }

  private markQuiescent(): void {
    this.quiescenceProven = true
    this.terminationFailure = undefined
  }

  private async run(): Promise<SubprocessOutcome> {
    let sandbox: Sandbox | undefined
    let preparing = true
    try {
      sandbox = await this.runtime.getSandbox()
      await this.prepareState(sandbox)
      preparing = false
      const handle = await sandbox.commands.run(
        commandText(this.spec, this.paths),
        {
          background: true,
          cwd: this.spec.cwd,
          envs: e2bControlEnvs(this.controlEnvs),
          stdin: this.spec.stdio.stdin !== 'ignore',
          timeoutMs: 0,
          onStdout: async (data) => { await this.dispatchOutput('stdout', data) },
          onStderr: async (data) => { await this.dispatchOutput('stderr', data) },
        },
      )
      const completion = handle.wait()
      void completion.catch(() => {})
      if (!isValidProcessId(handle.pid)) {
        const invalidPid = new Error(`subprocess-e2b: E2B returned invalid command pid ${handle.pid}`)
        try {
          await handle.kill()
          this.markQuiescent()
        } catch (cleanupError: unknown) {
          this.terminationFailure = asError(cleanupError)
          this.commandState.resolve(handle)
          throw new AggregateError(
            [invalidPid, cleanupError],
            'subprocess-e2b: invalid command pid rollback did not reach quiescence',
          )
        }
        throw invalidPid
      }
      this.commandState.resolve(handle)
      try {
        this.remoteProcessGroupId = await this.waitForProcessGroupId(sandbox, completion)
      } catch (error: unknown) {
        try {
          await this.rollbackUnpublishedGroup(sandbox, handle)
        } catch (cleanupError: unknown) {
          throw new AggregateError(
            [error, cleanupError],
            'subprocess-e2b: process-group publication failed and rollback did not reach quiescence',
          )
        }
        throw error
      }
      this.readyState.resolve(handle)
      await this.writeBatchStdin(handle)
      const outcome = await this.waitForCommand(sandbox, handle, completion)
      if (this.outputTransportError !== undefined) throw this.outputTransportError
      const requireCompleteOutput = this.terminationSignal === null && !this.outputDrainExpired
      this.stdoutDecoder.finish(requireCompleteOutput)
      this.stderrDecoder.finish(requireCompleteOutput)
      await this.finalizeSpills(sandbox)
      return outcome
    } catch (error: unknown) {
      const canceledPreparation = preparing && this.terminationController.signal.aborted
      let failure = await this.rollbackPublishedFailure(error)
      if (sandbox !== undefined && this.stateDirectoryCreated) {
        try {
          await this.removeFailedState(sandbox)
        } catch (cleanupError: unknown) {
          failure = new AggregateError(
            [failure, cleanupError],
            'subprocess-e2b: command failed and private state cleanup failed',
          )
        }
      }
      this.commandState.resolve(undefined)
      this.readyState.reject(failure)
      if (canceledPreparation && failure === error) return { exitCode: null, signal: 'SIGTERM' }
      throw failure
    } finally {
      this.spec.signal?.removeEventListener('abort', this.onAbort)
      this.stdout?.end()
      this.stderr?.end()
    }
  }

  private async prepareState(sandbox: Sandbox): Promise<void> {
    const signal = this.terminationController.signal
    const ambient = await readRemoteEnvironment(sandbox, signal)
    this.controlEnvs = bootstrapEnvironment(ambient)
    // Own the directory before the request: a cancellation racing a committed
    // creation must still enter cleanup (removal tolerates an absent path).
    this.stateDirectoryCreated = true
    await sandbox.files.makeDir(this.stateDir, { signal })
    await sandbox.commands.run(
      `chmod 700 -- ${quoteE2BShellArg(this.stateDir)}`,
      commandOpts(this.controlEnvs, signal),
    )
    const files = [
      { path: this.paths.pid, data: '' },
      { path: this.paths.status, data: '' },
      { path: this.paths.environment, data: serializeRemoteEnvironment(ambient, this.spec.env) },
      ...(hasSpill(this.spec.stdio.stdout) ? [{ path: this.paths.stdout, data: '' }] : []),
      ...(hasSpill(this.spec.stdio.stderr) ? [{ path: this.paths.stderr, data: '' }] : []),
    ]
    await sandbox.files.write(files, { signal })
    await sandbox.commands.run(
      `chmod 600 -- ${files.map(file => quoteE2BShellArg(file.path)).join(' ')}`,
      commandOpts(this.controlEnvs, signal),
    )
    signal.throwIfAborted()
  }

  private async writeBatchStdin(handle: CommandHandle): Promise<void> {
    if (typeof this.spec.stdio.stdin !== 'object') return
    try {
      await handle.sendStdin(this.spec.stdio.stdin.data)
      await handle.closeStdin()
    } catch (_processClosedItsInput) {
      // Like the local adapter, batch stdin is best-effort; exit and output remain authoritative.
    }
  }

  private async dispatchOutput(stream: 'stdout' | 'stderr', data: string): Promise<void> {
    let bytes: Buffer
    try {
      bytes = stream === 'stdout' ? this.stdoutDecoder.push(data) : this.stderrDecoder.push(data)
    } catch (error: unknown) {
      this.outputTransportError ??= asError(error)
      const target = stream === 'stdout' ? this.stdout : this.stderr
      target?.destroy(this.outputTransportError)
      return
    }
    try {
      if (stream === 'stdout') {
        this.stdoutReader?.push(bytes)
        await this.writeOutput(this.stdout, this.spec.stdio.stdout === 'inherit' ? process.stdout : undefined, bytes)
        return
      }
      this.stderrReader?.push(bytes)
      await this.writeOutput(this.stderr, this.spec.stdio.stderr === 'inherit' ? process.stderr : undefined, bytes)
    } catch (error: unknown) {
      const target = stream === 'stdout' ? this.stdout : this.stderr
      target?.destroy(asError(error))
    }
  }

  private async writeOutput(pipe: PassThrough | undefined, inherited: NodeJS.WriteStream | undefined, data: Uint8Array): Promise<void> {
    const target = pipe ?? inherited
    if (target === undefined || data.length === 0 || this.terminationController.signal.aborted) return
    if (target.destroyed) throw new Error('subprocess output stream is closed')
    if (target.write(data)) return
    await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => { cleanup(); resolve() }
      const onClose = (): void => { cleanup(); resolve() }
      const onRelease = (): void => { cleanup(); resolve() }
      const onError = (error: Error): void => { cleanup(); reject(error) }
      const cleanup = (): void => {
        target.removeListener('drain', onDrain)
        target.removeListener('close', onClose)
        target.removeListener('error', onError)
        this.terminationController.signal.removeEventListener('abort', onRelease)
        this.outputReleased.signal.removeEventListener('abort', onRelease)
      }
      target.once('drain', onDrain)
      target.once('close', onClose)
      target.once('error', onError)
      this.terminationController.signal.addEventListener('abort', onRelease, { once: true })
      this.outputReleased.signal.addEventListener('abort', onRelease, { once: true })
      if (this.terminationController.signal.aborted || this.outputReleased.signal.aborted) onRelease()
    })
  }

  private async waitForProcessGroupId(sandbox: Sandbox, completion: Promise<CommandResult>): Promise<number> {
    const commandSettled = completion.then(
      () => true,
      () => true,
    )
    while (true) {
      // TODO(e2b-publication-cancel): Join cancellation to the existing
      // termination transaction before aborting an in-flight SDK file read.
      const raw = await sandbox.files.read(this.paths.pid)
      const value = raw.trim()
      if (value.length > 0) {
        const pid = Number(value)
        if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(pid)) {
          throw new Error(`subprocess-e2b: remote wrapper published invalid process-group id ${JSON.stringify(value)}`)
        }
        // A same-UID sandbox process can rewrite this file; refuse ids whose
        // negative form addresses every process (`kill -- -1`) or init's group.
        if (pid <= 1) {
          throw new Error(`subprocess-e2b: unsafe published process-group id ${pid}`)
        }
        return pid
      }
      const settled = await Promise.race([commandSettled, waitTick(this.pollMs).then(() => false)])
      if (settled) throw new Error('subprocess-e2b: remote command exited before publishing its process-group id')
    }
  }

  private async waitForCommand(
    sandbox: Sandbox,
    handle: CommandHandle,
    completion: Promise<CommandResult>,
  ): Promise<SubprocessOutcome> {
    const settlement = completion.then<CommandSettlement, CommandSettlement>(
      result => ({ kind: 'result', result }),
      (error: unknown) => ({ kind: 'error', error }),
    )
    const hasPipeOutput = this.spec.stdio.stdout === 'pipe' || this.spec.stdio.stderr === 'pipe'
    let completed = hasPipeOutput ? await settlement : undefined
    while (true) {
      const rawStatus = (await sandbox.files.read(this.paths.status)).trim()
      if (rawStatus.length > 0) {
        const exitCode = Number(rawStatus)
        if (!/^(?:0|[1-9][0-9]*)$/.test(rawStatus) || !Number.isSafeInteger(exitCode) || exitCode > 255) {
          throw new Error(`subprocess-e2b: remote wrapper published invalid exit code ${JSON.stringify(rawStatus)}`)
        }
        if (completed !== undefined) return this.commandOutcome(completed, exitCode)
        const drained = await withinMs(settlement, this.spec.graceMs)
        if (drained !== undefined) return this.commandOutcome(drained, exitCode)
        this.outputDrainExpired = true
        this.stdoutReader?.invalidateSpill()
        this.stderrReader?.invalidateSpill()
        // Release inherited-output waits so a callback blocked on host
        // backpressure cannot keep the disconnected SDK settlement pending.
        this.outputReleased.abort(new Error('subprocess-e2b: output drain grace expired'))
        await handle.disconnect()
        return { exitCode, signal: null }
      }
      if (completed !== undefined) return this.commandOutcome(completed)
      // TODO(e2b-status-watch): Replace collect/inherit control-plane polling
      // when E2B can observe direct-command exit independently of descendant-held output.
      completed = await Promise.race([settlement, waitTick(this.pollMs).then(() => undefined)])
    }
  }

  private commandOutcome(settlement: CommandSettlement, publishedExitCode?: number): SubprocessOutcome {
    if (settlement.kind === 'result') {
      return { exitCode: publishedExitCode ?? settlement.result.exitCode, signal: null }
    }
    if (settlement.error instanceof CommandExitError) {
      if (publishedExitCode !== undefined) return { exitCode: publishedExitCode, signal: null }
      return this.terminationSignal === null
        ? { exitCode: settlement.error.exitCode, signal: null }
        : { exitCode: null, signal: this.terminationSignal }
    }
    throw settlement.error
  }

  private async rollbackPublishedFailure(error: unknown): Promise<unknown> {
    if (this.remoteProcessGroupId === undefined || this.quiescenceProven) return error
    this.terminate()
    try {
      await this.waitForExit()
      return error
    } catch (cleanupError: unknown) {
      return new AggregateError(
        [asError(error), asError(cleanupError)],
        'subprocess-e2b: command monitoring failed and process-group rollback did not reach quiescence',
      )
    }
  }

  private async rollbackUnpublishedGroup(sandbox: Sandbox, handle: CommandHandle): Promise<void> {
    // The bootstrap ends in an exec chain through the scrubbed environment and
    // `setsid`, so E2B's command PID is the provisional group id even before the
    // private publication file can be trusted. Kill that group before the SDK-PID
    // fallback, then prove no group member survived before rejecting startup.
    await this.forceKillGroup(sandbox, handle, handle.pid)
    this.markQuiescent()
  }

  private async terminateRemote(): Promise<void> {
    try {
      await this.terminateRemoteInSandbox()
    } catch (error: unknown) {
      if (error instanceof SandboxNotFoundError) {
        this.markQuiescent()
        return
      }
      throw error
    }
  }

  private async terminateRemoteInSandbox(): Promise<void> {
    const handle = await this.commandState.promise
    if (handle === undefined) {
      this.markQuiescent()
      return
    }
    if (!isValidProcessId(handle.pid) && this.remoteProcessGroupId === undefined) {
      await handle.kill()
      this.markQuiescent()
      return
    }
    const sandbox = await this.runtime.getSandbox()
    const processGroupId = this.remoteProcessGroupId ?? handle.pid
    await this.terminateGroup(sandbox, handle, processGroupId)
  }

  private async terminateGroup(sandbox: Sandbox, handle: CommandHandle, processGroupId: number): Promise<void> {
    this.terminationSignal = 'SIGTERM'
    try {
      await signalRemoteGroups(sandbox, this.controlEnvs, [processGroupId], 'TERM')
      if (await this.waitForGroupExit(sandbox, processGroupId)) {
        this.markQuiescent()
        return
      }
    } catch (_gracefulTerminationFailure) {
      // Failed TERM delivery or observation cannot prove exit; force cleanup still owns the group.
    }
    this.terminationSignal = 'SIGKILL'
    await this.forceKillGroup(sandbox, handle, processGroupId)
    this.markQuiescent()
  }

  private async forceKillGroup(sandbox: Sandbox, handle: CommandHandle, processGroupId: number): Promise<void> {
    try {
      await signalRemoteGroups(sandbox, this.controlEnvs, [processGroupId], 'KILL')
    } catch (_processGroupKillFailure) {
      // SDK kill and the final liveness probe remain independent cleanup paths.
    }
    try {
      await handle.kill()
    } catch (_sdkKillFailure) {
      // The final liveness probe, not either transport's self-report, proves cleanup.
    }
    if (await this.waitForGroupExit(sandbox, processGroupId)) return
    throw new Error(`subprocess-e2b: remote process group ${processGroupId} remained live after force termination`)
  }

  private async waitForGroupExit(sandbox: Sandbox, processGroupId: number): Promise<boolean> {
    const deadline = Date.now() + this.spec.graceMs
    while (await this.groupAlive(sandbox, processGroupId)) {
      if (Date.now() >= deadline) return false
      await waitTick(this.pollMs)
    }
    return true
  }

  private throwTerminationFailure(): void {
    if (this.terminationFailure !== undefined) throw this.terminationFailure
  }

  private async groupAlive(sandbox: Sandbox, pid: number, signal?: AbortSignal): Promise<boolean> {
    const result = await sandbox.commands.run(
      `set -o pipefail; ps -eo pgid=,stat= | awk '$1 == ${pid} && $2 !~ /^[ZXx]/ { live=1 } END { if (live) print "live" }'`,
      commandOpts(this.controlEnvs, signal),
    ).catch((error: unknown) => {
      if (signal?.aborted === true) return undefined
      if (error instanceof SandboxNotFoundError) return { exitCode: 0, stdout: '', stderr: '' }
      throw error
    })
    return result?.stdout.trim() === 'live'
  }

  private async finalizeSpills(sandbox: Sandbox): Promise<void> {
    const removals: Promise<void>[] = []
    const collect = (mode: SubprocessOutputMode, reader: E2BOutputReader | undefined, path: string): void => {
      if (!hasSpill(mode)) return
      // A spill mode is a collect mode, so construction always created its reader.
      const size = (reader as E2BOutputReader).size
      if (this.outputDrainExpired || size <= mode.maxBytes || size > mode.spill.maxBytes) {
        removals.push(sandbox.files.remove(path).catch((_adapterPrivateSpillRemovalFailure: unknown) => {
          // The command outcome is authoritative; owner teardown bounds private residue.
        }))
      }
    }
    collect(this.spec.stdio.stdout, this.stdoutReader, this.paths.stdout)
    collect(this.spec.stdio.stderr, this.stderrReader, this.paths.stderr)
    await Promise.all(removals)
  }

  private async removeFailedState(sandbox: Sandbox): Promise<void> {
    const failures: Error[] = []
    for (const path of [this.paths.environment, this.stateDir]) {
      try {
        await sandbox.files.remove(path)
      } catch (error: unknown) {
        if (!(error instanceof FileNotFoundError)) failures.push(asError(error))
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'subprocess-e2b: failed to remove private command state')
    }
  }
}
