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
import { replyToBinding } from './bindings.ts'
import { JsonChannel } from './channel.ts'
import { bootstrapArgs } from './launch.ts'
import { STARTUP_ENVIRONMENT_NAMES } from './environment.ts'
import { decodePtcJsonWire } from './json-wire.ts'
import { OutputLedger } from './output-ledger.ts'
import { drainOutput, terminateProcess } from './output-stream.ts'
import type { ProgramBootData } from './protocol.ts'

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

interface Evaluation {
  id: number
  settled: boolean
  data: ProgramBootData
  spec: PtcRunSpec
  sandbox: PtcRunSandbox
  bindings: Map<string, PtcBindingNamespace>
  reply: typeof replyToBinding
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
  private channel?: JsonChannel
  private active: Evaluation | undefined
  /** Admission remains reserved until the result includes completed process cleanup. */
  private running = false
  private cleanupPending = false
  private ready = false
  private sequence = 0
  private nextCall = 1
  private stderr = ''
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
   * @param mode - Evaluator syntax and retained-state diagnostics.
   */
  constructor(
    private readonly ctx: Context, private readonly config: ResolvedConfig,
    readonly policy: SandboxExecutionPolicy, processes: PolicyProcesses, private readonly mode: ExecutionMode,
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
      const result = await this.evaluate(spec, bindings, sandbox)
      if (this.confined !== undefined) {
        sandbox.enforcement = this.confined.enforcement
        sandbox.denied ||= result.error?.kind !== 'sandbox-unavailable' && this.confined.denialSignatures.some(signature =>
          result.error?.message.toLowerCase().includes(signature.toLowerCase()))
      }
      return { ...result, sandbox }
    } finally { this.running = false }
  }

  private output(): OutputLedger {
    return new OutputLedger(this.config.maxOutputBytes, this.mode.retainsState
      ? `retained variables were cleared; outer output exceeded ${this.config.maxOutputBytes} bytes` : undefined)
  }

  private message(message: string): string {
    return this.mode.retainsState ? `${message}; retained variables were cleared` : message
  }

  private abortMessage(signal: AbortSignal | undefined): string {
    return this.mode.retainsState ? 'execution canceled; retained variables were cleared' : messageOf(signal?.reason)
  }

  private async evaluate(spec: PtcRunSpec, bindings: Map<string, PtcBindingNamespace>, sandbox: PtcRunSandbox): Promise<PtcRunResult> {
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
      id: ++this.sequence,
      settled: false,
      data: {
        code: '', programFormat: this.mode.format, maxOutputBytes: this.config.maxOutputBytes,
        namespaces: [...bindings.values()].map(binding => ({
          global: binding.global, names: Object.keys(binding.functions), ...binding.errorClass ? { errorClass: binding.errorClass } : {},
        })),
      },
      spec, sandbox, bindings, reply: AsyncLocalStorage.bind(replyToBinding), pending: 0, pendingBytes: 0,
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
        const cleanup = discard || outcome.error?.kind === 'output-limit' || !this.mode.retainsState || spec.stateOwner === undefined ? this.stop() : Promise.resolve(true)
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
    this.channel?.close()
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
    void this.channel?.send({ type: 'run', id: evaluation.id, cwd: evaluation.spec.cwd, data: evaluation.data })
      .catch((error: unknown) => { this.fail('protocol', messageOf(error)) })
  }

  private exitMessage(outcome: SubprocessOutcome): string {
    return `Node process exited (${String(outcome.exitCode)}, signal ${String(outcome.signal)})${this.stderr ? `: ${this.stderr}` : ''}`
  }

  private async start(cwd: string): Promise<void> {
    const executable = await this.ctx.subprocess.resolveExecutable(this.config.launch.executable, undefined, this.controller.signal)
    if (this.closed) return
    const packaged = this.config.launch.kind === 'embedded'
    const heapFlag = `--max-old-space-size=${this.config.maxOldGenerationSizeMb}`
    const argv = [executable, ...packaged ? [] : [heapFlag],
      ...bootstrapArgs(this.ctx.fs, this.config.launch, this.config.maxMessageBytes, this.mode.retainsState)]
    const policy = this.policy
    this.confined = policy.mode === 'danger-full-access' ? undefined : await this.ctx.sandbox.confine(argv, { ...policy, mode: policy.mode }, this.controller.signal)
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- Cancellation can close the process during confinement.
    if (this.closed) return
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env)
      .filter(key => !STARTUP_ENVIRONMENT_NAMES.has(key.toUpperCase()) && key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE')
      .map(key => [key, undefined]))
    if (packaged) {
      env.DSH_PTC_RUNTIME_NODE = '1'
      env.NODE_OPTIONS = `${heapFlag} --experimental-vm-modules`
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
    this.channel = new JsonChannel(handle.control, this.config.maxMessageBytes,
      (raw, bytes) => { this.receive(raw, bytes) }, (error, kind) => {
        if (kind === 'protocol') this.fail('protocol', error.message)
        else setImmediate(() => { if (!this.closed && this.exitOutcome === undefined) handle.terminate() })
      })
    void handle.done.then(async (outcome) => {
      this.exitOutcome = outcome
      await Promise.all([drainOutput(handle.stdout, this.config.graceMs), drainOutput(handle.stderr, this.config.graceMs)])
      // The terminal control frame can already be queued when process exit arrives.
      setImmediate(() => {
        if (!this.closed) this.fail(this.confined !== undefined && classifyRunnerFailure(outcome.exitCode, this.stderr, this.confined.runnerFailureRules) !== undefined ? 'sandbox-unavailable' : 'worker-exit', this.exitMessage(outcome))
      })
    }, (error: unknown) => {
      this.fail(this.confined !== undefined && isRunnerSpawnFailure(error, this.confined.argv[0], cwd)
        ? 'sandbox-unavailable' : 'worker-exit', messageOf(error))
    })
  }

  private receive(raw: unknown, bytes: number): void {
    if (!record(raw)) { this.fail('protocol', 'invalid PTC frame'); return }
    const evaluation = this.active
    if (!evaluation) { this.fail('protocol', 'frame arrived without an active PTC evaluation'); return }
    if (evaluation.settled) return
    if (!this.ready) {
      if (raw.type !== 'ready') { this.fail('protocol', 'expected PTC readiness'); return }
      this.ready = true
      this.dispatch(evaluation)
      return
    }
    if (raw.id !== evaluation.id || !record(raw.payload)) { this.fail('protocol', 'frame does not belong to the active PTC evaluation'); return }
    const payload = raw.payload
    switch (payload.type) {
      case 'log':
        if (typeof payload.text === 'string') evaluation.admit(payload.text)
        else this.fail('protocol', 'invalid PTC log')
        return
      case 'output-limit': evaluation.finish({ kind: 'output-limit', message: 'output limit exceeded' }, undefined, true); return
      case 'done': {
        if (payload.error !== undefined) {
          const error = payload.error
          if (!record(error) || typeof error.message !== 'string' || (error.kind !== 'exception' && error.kind !== 'invalid-output' && error.kind !== 'output-limit')) {
            this.fail('protocol', 'invalid PTC failure'); return
          }
          const failure = { kind: error.kind, message: error.message } as PtcRunFailure
          evaluation.sandbox.denied = this.confined?.denialSignatures.some(signature =>
            failure.message.toLowerCase().includes(signature.toLowerCase())) ?? false
          setImmediate(() => { evaluation.finish(failure, undefined, failure.kind === 'output-limit') })
        } else {
          const value = payload.value === undefined ? undefined : decodePtcJsonWire(payload.value)
          const failure: PtcRunFailure | undefined = payload.value !== undefined && value === undefined
            ? { kind: 'invalid-output', message: 'program completion must be lossless JSON' } : undefined
          // Raw stdio may be queued beside the terminal control frame on separate pipes.
          setImmediate(() => { evaluation.finish(failure, value) })
        }
        return
      }
      case 'call': {
        if (!Number.isSafeInteger(payload.id) || payload.id !== this.nextCall || typeof payload.global !== 'string' || typeof payload.name !== 'string') { this.fail('protocol', 'invalid PTC binding identity'); return }
        this.nextCall += 1
        const args = decodePtcJsonWire(payload.args)
        if (args === undefined) { this.fail('protocol', 'binding arguments must be lossless JSON'); return }
        if (++evaluation.pending > this.config.maxPendingCalls || (evaluation.pendingBytes += bytes) > this.config.maxMessageBytes) {
          this.fail('protocol', 'pending binding calls exceed configured limits'); return
        }
        const functions = evaluation.bindings.get(payload.global)?.functions
        const fn = functions && Object.hasOwn(functions, payload.name) ? functions[payload.name] : undefined
        if (!this.mode.retainsState && typeof fn !== 'function') { this.fail('protocol', 'program requested an undeclared binding'); return }
        const id = payload.id
        void (async () => {
          const reply = await evaluation.reply(id, fn, args).finally(() => {
            evaluation.pending -= 1
            evaluation.pendingBytes -= bytes
          })
          if (this.active === evaluation && !evaluation.settled) await this.channel?.send(reply)
        })().catch((error: unknown) => { this.fail('protocol', messageOf(error)) })
        return
      }
      default: this.fail('protocol', 'unknown PTC message')
    }
  }
}
