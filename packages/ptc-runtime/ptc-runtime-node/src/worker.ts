/** Managed Node process shared by temporary and owner-retained evaluations. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { Context } from '@deepseek-ai/cordis'
import type { PtcRunSpec, PtcRunResult, PtcRunSandbox, PtcRunFailure, PtcBindingNamespace, PtcJsonValue } from '@deepseek-ai/dsh-ptc-runtime'
import { SandboxUnavailableError, classifyRunnerFailure, isRunnerSpawnFailure } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import type { PolicyProcesses } from './policy-processes.ts'
import type { ResolvedConfig } from './config.ts'
import type { ExecutionMode } from './execution.ts'
import { invokeBinding } from './bindings.ts'
import type { BirpcReturn } from 'birpc'
import { createProcessRpc } from './rpc.ts'
import { bootstrapArgs } from './launch.ts'
import { STARTUP_ENVIRONMENT_NAMES } from './environment.ts'
import { decodePtcJsonWire } from './json-wire.ts'
import { OutputLedger } from './output-ledger.ts'
import { drainOutput, terminateProcess } from './output-stream.ts'
import { readProgramResult, type ProgramBootData, type ProgramMethods, type HostMethods } from './protocol.ts'

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

interface Evaluation {
  settled: boolean
  data: ProgramBootData
  spec: PtcRunSpec
  bindings: Map<string, PtcBindingNamespace>
  invoke: typeof invokeBinding
  pending: number
  pendingBytes: number
  admit(text: string): void
  finish(error?: PtcRunFailure, value?: PtcJsonValue, discard?: boolean): void
}

/** One managed process; all mutable program state belongs to this process alone. */
export class ProgramWorker {
  private readonly unregister: (() => void) | undefined
  private confined: ConfinedArgv | undefined
  private handle?: SubprocessHandle
  private channel?: BirpcReturn<ProgramMethods, HostMethods>
  private active: Evaluation | undefined
  /** Admission remains reserved until the result includes completed process cleanup. */
  private running = false
  private cleanupPending = false
  private ready = false
  private stderr = ''
  private controlFailure: string | undefined
  private stopped: Promise<boolean> | undefined
  private starting?: Promise<void>
  private exitOutcome?: SubprocessOutcome
  private readonly controller = new AbortController()
  closed = false

  /** Whether termination succeeded and this process no longer needs cleanup retries. */
  get cleanupComplete(): boolean { return this.closed && !this.cleanupPending }

  /**
   * Own one process under a fixed file policy.
   * @param ctx - Provider execution services.
   * @param config - Validated resource limits and launch selection.
   * @param policy - Authority retained for the lifetime of this process.
   * @param processes - Session policy invalidation and cleanup coordination.
   * @param mode - Evaluator syntax and TypeScript erasure.
   * @param retainsState - Whether this process belongs to an owner and survives completed evaluations.
   */
  constructor(
    private readonly ctx: Context, private readonly config: ResolvedConfig,
    readonly policy: SandboxExecutionPolicy, processes: PolicyProcesses, private readonly mode: ExecutionMode,
    private readonly retainsState: boolean,
  ) {
    this.unregister = processes.register(policy, () => this.dispose())
  }

  /** Reject reuse until the previous evaluation and required cleanup settle. */
  assertIdle(): void {
    if (this.running) throw new Error('persistent PTC does not accept concurrent runs for one state owner')
    if (this.cleanupPending) throw new Error('persistent PTC environment cleanup is incomplete; release the owner before running another program')
  }

  /**
   * Evaluate a program, retaining this process only for an enabled state owner.
   * @param spec - Resolved program inputs and cancellation.
   * @param bindings - Current host binding implementations.
   * @returns Output after any required process cleanup.
   */
  async run(spec: PtcRunSpec, bindings: Map<string, PtcBindingNamespace>): Promise<PtcRunResult> {
    this.running = true
    const sandbox: PtcRunSandbox = { mode: this.policy.mode, denied: false }
    try {
      const result = await this.evaluate(spec, bindings)
      if (this.confined !== undefined) {
        sandbox.enforcement = this.confined.enforcement
        sandbox.denied ||= result.error?.kind !== 'sandbox-unavailable' && this.confined.denialSignatures.some(signature =>
          result.error?.message.toLowerCase().includes(signature.toLowerCase()))
      }
      return { ...result, sandbox }
    } finally { this.running = false }
  }

  private output(): OutputLedger {
    return new OutputLedger(this.config.maxOutputBytes, this.retainsState
      ? `retained variables were cleared; outer output exceeded ${this.config.maxOutputBytes} bytes` : undefined)
  }

  private message(message: string): string {
    return this.retainsState ? `${message}; retained variables were cleared` : message
  }

  private abortMessage(signal: AbortSignal | undefined): string {
    return this.retainsState ? 'execution canceled; retained variables were cleared' : messageOf(signal?.reason)
  }

  private async evaluate(spec: PtcRunSpec, bindings: Map<string, PtcBindingNamespace>): Promise<PtcRunResult> {
    if (this.exitOutcome !== undefined) {
      const output = this.output()
      const failure: PtcRunFailure = spec.signal?.aborted
        ? { kind: 'abort', message: this.abortMessage(spec.signal) }
        : { kind: 'worker-exit', message: this.message(this.exitMessage(this.exitOutcome)) }
      try { await this.stop() } catch (error: unknown) {
        return output.failure([], { kind: 'worker-exit', message: `managed process cleanup failed: ${messageOf(error)}` })
      }
      return output.failure([], failure)
    }
    this.stderr = ''
    const output = this.output()
    const logs: string[] = []
    let overflowed = false
    const result = Promise.withResolvers<PtcRunResult>()
    const timer = spec.timeoutMs === null ? undefined : setTimeout(() => {
      evaluation.finish({ kind: 'timeout', message: this.message(`execution deadline reached (${spec.timeoutMs}ms)`) }, undefined, true)
    }, spec.timeoutMs)
    const onAbort = (): void => { evaluation.finish({ kind: 'abort', message: this.abortMessage(spec.signal) }, undefined, true) }
    const evaluation: Evaluation = {
      settled: false,
      data: {
        code: '', programFormat: this.mode.format, retainsState: this.retainsState,
        maxOutputBytes: this.config.maxOutputBytes,
        namespaces: [...bindings.values()].map(binding => ({
          global: binding.global, names: Object.keys(binding.functions), ...binding.errorClass ? { errorClass: binding.errorClass } : {},
        })),
      },
      spec, bindings, invoke: AsyncLocalStorage.bind(invokeBinding), pending: 0, pendingBytes: 0,
      admit: (text) => {
        if (overflowed) return
        if (!output.admit(text, logs)) {
          overflowed = true
          logs.push(text)
          evaluation.finish({ kind: 'output-limit', message: 'output limit exceeded' }, undefined, true)
        }
      },
      finish: (error, value, discard = false) => {
        if (evaluation.settled) return
        evaluation.settled = true
        clearTimeout(timer)
        spec.signal?.removeEventListener('abort', onAbort)
        const complete = (): PtcRunResult => overflowed || error?.kind === 'output-limit' ? output.limit(logs)
          : error ? output.failure(logs, error) : output.success(logs, value)
        const outcome = complete()
        const cleanup = discard || outcome.error?.kind === 'output-limit' || !this.retainsState ? this.stop() : Promise.resolve(true)
        void cleanup.then((drained) => {
          this.active = undefined
          result.resolve(drained ? complete() : output.failure(logs, { kind: 'worker-exit', message: 'managed process exited but its output did not drain cleanly' }))
        }, (failure: unknown) => {
          this.active = undefined
          result.resolve(output.failure(logs, { kind: 'worker-exit', message: `managed process cleanup failed: ${messageOf(failure)}` }))
        })
      },
    }
    this.active = evaluation
    spec.signal?.addEventListener('abort', onAbort, { once: true })
    if (spec.signal?.aborted) onAbort()
    else {
      try { evaluation.data.code = this.mode.stripTypes(spec.program) } catch (error: unknown) {
        evaluation.finish({ kind: 'exception', message: messageOf(error) })
        return await result.promise
      }
      if (this.ready) this.dispatch(evaluation)
      else {
        this.starting = this.start(spec.cwd)
        void this.starting.catch((error: unknown) => { this.fail(error instanceof SandboxUnavailableError || (this.confined !== undefined && isRunnerSpawnFailure(error, this.confined.argv[0], spec.cwd)) ? 'sandbox-unavailable' : 'worker-exit', messageOf(error)) })
      }
    }
    return await result.promise
  }

  /** Cancel active work and await managed process termination and output drainage. */
  async dispose(): Promise<void> {
    this.active?.finish({ kind: 'abort', message: this.message('PTC environment disposed') }, undefined, true)
    await this.stop()
  }

  private stop(): Promise<boolean> {
    if (this.stopped) return this.stopped
    this.closed = true
    this.cleanupPending = true
    this.controller.abort()
    this.channel?.$close()
    this.stopped = (async () => {
      await this.starting?.catch((_error: unknown) => {
        // Evaluation reports startup failure; cleanup still owns any process already created.
      })
      const handle = this.handle
      return handle === undefined || await terminateProcess(handle, this.config.graceMs)
    })().then((drained) => {
      this.unregister?.()
      this.cleanupPending = false
      if (!drained) this.ctx.logger.warn('Node process exited but its output did not drain cleanly')
      return drained
    }, (error: unknown) => { this.stopped = undefined; throw error })
    return this.stopped
  }

  private fail(kind: PtcRunFailure['kind'], message: string): void {
    if (this.active) this.active.finish({ kind, message: this.message(message) }, undefined, true)
    else {
      if (!this.closed) this.ctx.logger.warn(message)
      void this.stop().catch((error: unknown) => { this.ctx.logger.warn(messageOf(error)) })
    }
  }

  private dispatch(evaluation: Evaluation): void {
    void this.channel?.run(evaluation.spec.cwd, evaluation.data).then((raw) => {
      if (evaluation.settled) return
      const { error, value } = readProgramResult(raw)
      // Raw stdio can be queued beside the RPC result on separate pipes.
      setImmediate(() => { evaluation.finish(error, value) })
    }).catch((error: unknown) => {
      if (this.active === evaluation && !this.channel?.$closed) this.fail('protocol', messageOf(error))
    })
  }

  private withControlFailure(message: string): string {
    return this.controlFailure === undefined ? message : `${message}; control channel failed: ${this.controlFailure}`
  }

  private exitMessage(outcome: SubprocessOutcome): string {
    return this.withControlFailure(`Node process exited (${String(outcome.exitCode)}, signal ${String(outcome.signal)})${this.stderr ? `: ${this.stderr}` : ''}`)
  }

  private async start(cwd: string): Promise<void> {
    const executable = await this.ctx.subprocess.resolveExecutable(this.config.launch.executable, undefined, this.controller.signal)
    if (this.closed) return
    const packaged = this.config.launch.kind === 'embedded'
    const heapFlag = `--max-old-space-size=${this.config.maxOldGenerationSizeMb}`
    const argv = [executable, ...packaged ? [] : [heapFlag],
      ...bootstrapArgs(this.ctx.fs, this.config.launch, this.config.maxMessageBytes, this.retainsState)]
    const policy = this.policy
    this.confined = policy.mode === 'danger-full-access' ? undefined : await this.ctx.sandbox.confine(argv, { ...policy, mode: policy.mode }, this.controller.signal)
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- Cancellation can close the process during confinement.
    if (this.closed) return
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env)
      .filter(key => !STARTUP_ENVIRONMENT_NAMES.has(key.toUpperCase()) && key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE')
      .map(key => [key, undefined]))
    if (packaged) {
      env.DSH_PTC_RUNTIME_NODE = '1'
      env.NODE_OPTIONS = heapFlag
    }
    const handle = this.ctx.subprocess.spawn({ argv: this.confined?.argv ?? argv, cwd, env, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', control: 'pipe' }, graceMs: this.config.graceMs })
    this.handle = handle
    if (!handle.control || !handle.stdout || !handle.stderr) throw new Error('subprocess provider did not supply the requested control and output pipes')
    for (const stream of [handle.stdout, handle.stderr]) {
      stream.setEncoding('utf8')
      stream.on('data', (text: string) => {
        if (stream === handle.stderr) this.stderr = (this.stderr + text).slice(-this.config.maxOutputBytes)
        this.active?.admit(text)
      })
      stream.on('error', (error: Error) => { this.fail('worker-exit', error.message) })
    }
    // A rejected wire call closes its endpoint before birpc can answer it.
    const refuse = (message: string): never => { this.fail('protocol', message); throw new Error(message) }
    this.channel = createProcessRpc<ProgramMethods, HostMethods>(handle.control, this.config.maxMessageBytes, {
      ready: () => {
        if (this.ready || !this.active) { this.fail('protocol', 'duplicate program readiness'); return }
        this.ready = true
        this.dispatch(this.active)
      },
      log: (text: unknown) => {
        if (!this.ready || this.active === undefined || typeof text !== 'string') this.fail('protocol', 'invalid program log')
        else this.active.admit(text)
      },
      outputLimit: () => {
        if (!this.ready || this.active === undefined) this.fail('protocol', 'idle PTC output limit')
        else this.active.finish({ kind: 'output-limit', message: 'output limit exceeded' }, undefined, true)
      },
      invoke: async (global, name, wire) => {
        const evaluation = this.active
        if (!this.ready || evaluation === undefined || evaluation.settled) return refuse('binding call arrived without an active PTC evaluation')
        const functions = evaluation.bindings.get(global)?.functions
        const fn = functions !== undefined && Object.hasOwn(functions, name) ? functions[name] : undefined
        if (!this.mode.retainsState && typeof fn !== 'function') return refuse('program requested an undeclared binding')
        const args = decodePtcJsonWire(wire)
        if (args === undefined) return refuse('binding arguments must be lossless JSON')
        const bytes = Buffer.byteLength(JSON.stringify(wire))
        if (evaluation.pending >= this.config.maxPendingCalls || evaluation.pendingBytes + bytes > this.config.maxMessageBytes) {
          return refuse('pending binding calls exceed configured limits')
        }
        evaluation.pending += 1
        evaluation.pendingBytes += bytes
        try {
          const value = await evaluation.invoke(fn, args)
          // A late binding result must not fill the pipe shared with the next evaluation.
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- The evaluation may settle while the binding is pending.
          if (this.active !== evaluation || evaluation.settled) throw new Error('PTC evaluation ended before the binding completed')
          return value
        } finally {
          evaluation.pending -= 1
          evaluation.pendingBytes -= bytes
        }
      },
    }, [], (error, kind) => {
      if (kind === 'protocol') this.fail('protocol', error.message)
      else {
        if (kind === 'io') this.controlFailure = error.message
        setImmediate(() => { if (!this.closed && this.exitOutcome === undefined) handle.terminate() })
      }
    })
    void handle.done.then(async (outcome) => {
      this.exitOutcome = outcome
      await Promise.all([drainOutput(handle.stdout, this.config.graceMs), drainOutput(handle.stderr, this.config.graceMs)])
      // The RPC result can already be queued when process exit arrives.
      setImmediate(() => {
        if (!this.closed) this.fail(this.confined !== undefined && classifyRunnerFailure(outcome.exitCode, this.stderr, this.confined.runnerFailureRules) !== undefined ? 'sandbox-unavailable' : 'worker-exit', this.exitMessage(outcome))
      })
    }, (error: unknown) => {
      this.fail(this.confined !== undefined && isRunnerSpawnFailure(error, this.confined.argv[0], cwd)
        ? 'sandbox-unavailable' : 'worker-exit', this.withControlFailure(messageOf(error)))
    })
  }

}
