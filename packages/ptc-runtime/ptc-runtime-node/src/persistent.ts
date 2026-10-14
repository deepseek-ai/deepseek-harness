/** Node PTC in-memory execution with retained processes scoped to caller-owned objects. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { stripTypeScriptTypes } from 'node:module'
import { isAbsolute } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { PtcRunRequest, PtcRunSpec, PtcRunResult, PtcRunSandbox, PtcRunFailure, PtcBindingNamespace, PtcJsonValue } from '@deepseek-ai/dsh-ptc-runtime'
import { clampTimeout } from '@deepseek-ai/dsh-timeout'
import { SandboxUnavailableError, classifyRunnerFailure, isRunnerSpawnFailure } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import type { PolicyProcesses } from './policy-processes.ts'
import type { ResolvedConfig } from './config.ts'
import { replyToBinding, validateBindings } from './bindings.ts'
import { JsonChannel } from './channel.ts'
import { bootstrapArgs } from './launch.ts'
import { STARTUP_ENVIRONMENT_NAMES } from './environment.ts'
import { decodePtcJsonWire } from './json-wire.ts'
import { OutputLedger } from './output-ledger.ts'
import { drainOutput, terminateProcess } from './output-stream.ts'
import type { ProgramBootData } from './protocol.ts'

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function persistentOutput(maxBytes: number): OutputLedger {
  return new OutputLedger(maxBytes, `retained variables were cleared; outer output exceeded ${maxBytes} bytes`)
}

interface Evaluation {
  id: number
  data: ProgramBootData
  spec: PtcRunSpec
  bindings: Map<string, PtcBindingNamespace>
  reply: typeof replyToBinding
  pending: number
  pendingBytes: number
  admit(text: string): void
  finish(error?: PtcRunFailure, value?: PtcJsonValue, discard?: boolean): void
}

/** One managed process; all mutable program state belongs to this process alone. */
class Kernel {
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

  constructor(
    private readonly ctx: Context, private readonly config: ResolvedConfig,
    readonly policy: SandboxExecutionPolicy, processes: PolicyProcesses,
  ) {
    this.unregister = processes.register(policy, () => this.dispose())
  }

  assertIdle(): void {
    if (this.running) throw new Error('persistent PTC does not accept concurrent runs for one state owner')
    if (this.cleanupPending) throw new Error('persistent PTC environment cleanup is incomplete; release the owner before running another program')
  }

  async run(spec: PtcRunSpec, bindings: Map<string, PtcBindingNamespace>, code: string): Promise<PtcRunResult> {
    this.running = true
    const sandbox: PtcRunSandbox = { mode: this.policy.mode, denied: false }
    try {
      const result = await this.evaluate(spec, bindings, code)
      if (this.confined !== undefined) {
        sandbox.enforcement = this.confined.enforcement
        sandbox.denied = result.error?.kind !== 'sandbox-unavailable' && this.confined.denialSignatures.some(signature =>
          result.error?.message.toLowerCase().includes(signature.toLowerCase()))
      }
      return { ...result, sandbox }
    } finally { this.running = false }
  }

  private async evaluate(spec: PtcRunSpec, bindings: Map<string, PtcBindingNamespace>, code: string): Promise<PtcRunResult> {
    if (this.exitOutcome !== undefined) {
      const output = persistentOutput(this.config.maxOutputBytes)
      const failure: PtcRunFailure = spec.signal?.aborted
        ? { kind: 'abort', message: 'execution canceled; retained variables were cleared' }
        : { kind: 'worker-exit', message: `${this.exitMessage(this.exitOutcome)}; retained variables were cleared` }
      try { await this.stop() } catch (error: unknown) {
        return output.failure([], { kind: 'worker-exit', message: `managed process cleanup failed: ${messageOf(error)}` })
      }
      return output.failure([], failure)
    }
    this.stderr = ''
    const output = persistentOutput(this.config.maxOutputBytes)
    const logs: string[] = []
    const result = Promise.withResolvers<PtcRunResult>()
    const timer = spec.timeoutMs === null ? undefined : setTimeout(() => {
      evaluation.finish({ kind: 'timeout', message: `execution deadline reached (${spec.timeoutMs}ms); retained variables were cleared` }, undefined, true)
    }, spec.timeoutMs)
    const onAbort = (): void => { evaluation.finish({ kind: 'abort', message: 'execution canceled; retained variables were cleared' }, undefined, true) }
    const evaluation: Evaluation = {
      id: ++this.sequence,
      data: { code, maxOutputBytes: this.config.maxOutputBytes, namespaces: [...bindings.values()].map(binding => ({
        global: binding.global, names: Object.keys(binding.functions), ...binding.errorClass ? { errorClass: binding.errorClass } : {},
      })) },
      spec, bindings, reply: AsyncLocalStorage.bind(replyToBinding), pending: 0, pendingBytes: 0,
      admit: (text) => {
        if (!output.admit(text, logs)) {
          logs.push(text)
          evaluation.finish({ kind: 'output-limit', message: 'output limit exceeded' }, undefined, true)
        }
      },
      finish: (error, value, discard = false) => {
        if (this.active !== evaluation) return
        clearTimeout(timer)
        spec.signal?.removeEventListener('abort', onAbort)
        this.active = undefined
        const outcome = error?.kind === 'output-limit' ? output.limit(logs)
          : error ? output.failure(logs, error) : output.success(logs, value)
        const cleanup = discard || outcome.error?.kind === 'output-limit' || spec.stateOwner === undefined ? this.stop() : Promise.resolve(true)
        void cleanup.then((drained) => {
          result.resolve(drained ? outcome : output.failure(logs, { kind: 'worker-exit', message: 'managed process exited but its output did not drain cleanly' }))
        }, (failure: unknown) => {
          result.resolve(output.failure(logs, { kind: 'worker-exit', message: `managed process cleanup failed: ${messageOf(failure)}` }))
        })
      },
    }
    this.active = evaluation
    spec.signal?.addEventListener('abort', onAbort, { once: true })
    if (spec.signal?.aborted) onAbort()
    else if (this.ready) this.dispatch(evaluation)
    else {
      this.starting = this.start(spec.cwd)
      void this.starting.catch((error: unknown) => { this.fail(error instanceof SandboxUnavailableError || (this.confined !== undefined && isRunnerSpawnFailure(error, this.confined.argv[0], spec.cwd)) ? 'sandbox-unavailable' : 'worker-exit', messageOf(error)) })
    }
    return await result.promise
  }

  async dispose(): Promise<void> {
    this.active?.finish({ kind: 'abort', message: 'PTC environment disposed; retained variables were cleared' }, undefined, true)
    await this.stop()
  }

  private stop(): Promise<boolean> {
    if (this.stopped) return this.stopped
    this.closed = true
    this.cleanupPending = true
    this.controller.abort()
    this.channel?.close()
    this.stopped = (async () => {
      await this.starting?.catch(() => {})
      const handle = this.handle
      return handle === undefined || await terminateProcess(handle, this.config.graceMs)
    })().then((drained) => {
      this.unregister?.()
      this.cleanupPending = false
      if (!drained) this.ctx.logger.warn('persistent Node process exited but its output did not drain cleanly')
      return drained
    }, (error: unknown) => { this.stopped = undefined; throw error })
    return this.stopped
  }

  private fail(kind: PtcRunFailure['kind'], message: string): void {
    if (this.active) this.active.finish({ kind, message: `${message}; retained variables were cleared` }, undefined, true)
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
    const argv = [executable, `--max-old-space-size=${this.config.maxOldGenerationSizeMb}`, ...bootstrapArgs(this.ctx.fs, this.config.launch, this.config.maxMessageBytes, true)]
    const policy = this.policy
    this.confined = policy.mode === 'danger-full-access' ? undefined : await this.ctx.sandbox.confine(argv, { ...policy, mode: policy.mode }, this.controller.signal)
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- Cancellation can close the kernel during confinement.
    if (this.closed) return
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env)
      .filter(key => !STARTUP_ENVIRONMENT_NAMES.has(key.toUpperCase()) && key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE')
      .map(key => [key, undefined]))
    const handle = this.ctx.subprocess.spawn({ argv: this.confined?.argv ?? argv, cwd, env, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', control: 'pipe' }, graceMs: this.config.graceMs })
    this.handle = handle
    if (!handle.control || !handle.stdout || !handle.stderr) throw new Error('subprocess provider did not supply persistent PTC pipes')
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
    }, (error: unknown) => { this.fail('worker-exit', messageOf(error)) })
  }

  private receive(raw: unknown, bytes: number): void {
    if (!record(raw)) { this.fail('protocol', 'invalid persistent PTC frame'); return }
    const evaluation = this.active
    if (!evaluation) { this.fail('protocol', 'frame arrived without an active PTC evaluation'); return }
    if (!this.ready) {
      if (raw.type !== 'ready') { this.fail('protocol', 'expected persistent PTC readiness'); return }
      this.ready = true
      this.dispatch(evaluation)
      return
    }
    if (raw.id !== evaluation.id || !record(raw.payload)) { this.fail('protocol', 'frame does not belong to the active PTC evaluation'); return }
    const payload = raw.payload
    switch (payload.type) {
      case 'log':
        if (typeof payload.text === 'string') evaluation.admit(payload.text)
        else this.fail('protocol', 'invalid persistent PTC log')
        return
      case 'output-limit': evaluation.finish({ kind: 'output-limit', message: 'output limit exceeded' }, undefined, true); return
      case 'done': {
        if (payload.error !== undefined) {
          const error = payload.error
          if (!record(error) || typeof error.message !== 'string' || (error.kind !== 'exception' && error.kind !== 'invalid-output' && error.kind !== 'output-limit')) {
            this.fail('protocol', 'invalid persistent PTC failure'); return
          }
          const failure = { kind: error.kind, message: error.message } as PtcRunFailure
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
        if (payload.id !== this.nextCall || typeof payload.global !== 'string' || typeof payload.name !== 'string') { this.fail('protocol', 'invalid persistent PTC binding identity'); return }
        this.nextCall += 1
        const args = decodePtcJsonWire(payload.args)
        if (args === undefined) { this.fail('protocol', 'binding arguments must be lossless JSON'); return }
        if (++evaluation.pending > this.config.maxPendingCalls || (evaluation.pendingBytes += bytes) > this.config.maxMessageBytes) {
          this.fail('protocol', 'pending binding calls exceed configured limits'); return
        }
        const functions = evaluation.bindings.get(payload.global)?.functions
        const fn = functions && Object.hasOwn(functions, payload.name) ? functions[payload.name] : undefined
        const id = payload.id
        void (async () => {
          const reply = await evaluation.reply(id, fn, args).finally(() => {
            evaluation.pending -= 1
            evaluation.pendingBytes -= bytes
          })
          if (this.active === evaluation) await this.channel?.send(reply)
        })().catch((error: unknown) => { this.fail('protocol', messageOf(error)) })
        return
      }
      default: this.fail('protocol', 'unknown persistent PTC message')
    }
  }
}

/** Sandboxed, best-effort retained state; restart, disposal, and interrupted execution clear it. */
export class InMemoryExecution {
  /**
   * Model-facing rules for retained variables, authority, output, and recovery.
   * @returns Usage guidance appended to the run_code schema.
   */
  get executionInstructions(): string {
    return 'The program contains TypeScript REPL statements; only erasable syntax is accepted, with no enum or namespaces. Type annotations are advisory. Top-level declarations and await are supported; top-level return is not supported. Emit output with console.log(...) or a final lossless JSON expression. Only printed values and that final expression become program output. Variables, functions, and imported modules remain in memory for this Agent across calls. Use await import(...) for modules. Direct filesystem access follows this execution\'s sandbox policy; process.env starts empty. Changing the session sandbox mode clears retained variables. An approved sandbox escalation runs in a separate temporary environment: it cannot access retained variables, and its declarations are discarded afterward. Restart, Agent disposal, cancellation, timeout, output overflow, or process failure clears the environment. If a variable is undefined, recreate it and reacquire its resources. State is not restored from the conversation, and failed evaluations can leave earlier mutations in memory. Redeclaring an existing let, const, or class name fails; assign to a mutable binding or use a new name. Await all tool calls; background callbacks cannot call tools after their evaluation ends. Await child-process completion before ending an evaluation; raw subprocess output belongs to whichever evaluation is active when it arrives.'
  }
  private readonly owners = new WeakMap<object, Kernel>()
  private readonly kernels = new Set<Kernel>()
  private disposed = false

  /**
   * Own retained execution resources under the existing Node provider.
   * @param ctx - Provider lifecycle and execution services.
   * @param config - Validated limits and selected executable.
   * @param processes - Provider-owned policy invalidation and cleanup.
   */
  constructor(private readonly ctx: Context, private readonly config: ResolvedConfig, private readonly processes: PolicyProcesses) {
    if (this.config.launch.kind === 'embedded') throw new Error('Persistent PTC requires a node-script launch')
    ctx.effect(() => async () => {
      this.disposed = true
      const results = await Promise.allSettled([...this.kernels].map(kernel => kernel.dispose()))
      this.kernels.clear()
      const failed = results.find(result => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    }, 'Persistent PTC environments')
  }

  /**
   * Resolve the file policy, directory and deadline for a retained REPL.
   * @param request - Program, bindings, owner, directory and elapsed budget.
   * @returns Resolved inputs with the selected file policy.
   */
  resolve(request: PtcRunRequest): PtcRunSpec {
    if (this.disposed) throw new Error('persistent PTC: resolve after disposal')
    const sandboxPolicy = request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    const cwd = request.cwd ?? sandboxPolicy.workspaceRoot
    if (!isAbsolute(cwd)) throw new Error('persistent PTC: cwd must be absolute')
    return { ...request, sandboxPolicy, cwd, timeoutMs: request.timeoutMs === null ? null : clampTimeout(request.timeoutMs, this.config.timeoutMs, this.config.maxTimeoutMs, 'persistent PTC timeoutMs') }
  }

  /**
   * Evaluate statements using this owner's process, or a temporary process without an owner.
   * @param spec - Resolved request; concurrent calls for one owner are rejected.
   * @returns Logs, a final JSON expression, or a structured execution failure.
   */
  async run(spec: PtcRunSpec): Promise<PtcRunResult> {
    if (this.disposed) throw new Error('persistent PTC: run after disposal')
    if (spec.sandboxPolicy === undefined || !isAbsolute(spec.cwd) || (spec.timeoutMs !== null && (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0 || spec.timeoutMs > this.config.maxTimeoutMs))) throw new Error('persistent PTC: run requires resolved inputs with a sandbox policy')
    const bindings = validateBindings(spec)
    let kernel = spec.stateOwner === undefined ? undefined : this.owners.get(spec.stateOwner)
    kernel?.assertIdle()
    if (kernel && !kernel.closed && (kernel.policy.mode !== spec.sandboxPolicy.mode
      || kernel.policy.workspaceRoot !== spec.sandboxPolicy.workspaceRoot
      || kernel.policy.sessionId !== spec.sandboxPolicy.sessionId)) {
      throw new Error('persistent PTC: release the retained environment before changing its sandbox policy')
    }
    let code: string
    try { code = stripTypeScriptTypes(spec.program) } catch (error: unknown) {
      const output = persistentOutput(this.config.maxOutputBytes)
      const outcome = output.failure([], { kind: 'exception', message: messageOf(error) })
      if (outcome.error?.kind === 'output-limit' && spec.stateOwner !== undefined) {
        try { await this.release(spec.stateOwner) } catch (failure: unknown) {
          return output.failure([], { kind: 'worker-exit', message: `managed process cleanup failed: ${messageOf(failure)}` })
        }
      }
      return outcome
    }
    if (!kernel || kernel.closed) {
      if (kernel) this.kernels.delete(kernel)
      kernel = new Kernel(this.ctx, this.config, { ...spec.sandboxPolicy }, this.processes)
      this.kernels.add(kernel)
      if (spec.stateOwner !== undefined) this.owners.set(spec.stateOwner, kernel)
    }
    try { return await kernel.run(spec, bindings, code) } finally {
      if (spec.stateOwner === undefined) this.kernels.delete(kernel)
    }
  }

  /**
   * Release retained state and await its process cleanup.
   * @param owner - Exact object supplied to run.
   * @returns Completion after the owned process and output streams stop.
   */
  async release(owner: object): Promise<void> {
    const kernel = this.owners.get(owner)
    if (!kernel) return
    await kernel.dispose()
    if (this.owners.get(owner) === kernel) this.owners.delete(owner)
    this.kernels.delete(kernel)
  }
}
