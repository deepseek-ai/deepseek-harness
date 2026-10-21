/** Node PTC execution with configurable per-call processes or retained in-memory REPL state. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { stripTypeScriptTypes } from 'node:module'
import { isAbsolute } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcBindingNamespace, PtcJsonValue, PtcRunFailure, PtcRunRequest, PtcRunResult, PtcRunSandbox, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { clampTimeout } from '@deepseek-ai/dsh-timeout'
import { SandboxUnavailableError, classifyRunnerFailure, isRunnerSpawnFailure } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-fs'
import type { BirpcReturn } from 'birpc'
import { invokeBinding, validateBindings } from './bindings.ts'
import { createProcessRpc } from './rpc.ts'
import { bootstrapArgs, resolveLaunch } from './launch.ts'
import { NodeConfig, validateConfig } from './config.ts'
import { PolicyProcesses } from './policy-processes.ts'
import { InMemoryExecution } from './persistent.ts'
import type { Config, ResolvedConfig } from './config.ts'
export type { Config } from './config.ts'
export type { LaunchConfig } from './launch.ts'
import { OutputLedger } from './output-ledger.ts'
import { terminateProcess } from './output-stream.ts'
import { STARTUP_ENVIRONMENT_NAMES } from './environment.ts'
import { decodePtcJsonWire } from './json-wire.ts'
import { readProgramResult, type ProgramBootData, type ProgramMethods, type HostMethods } from './protocol.ts'

interface LiveRun { controller: AbortController; finished: Promise<void> }
const STRIP_PREFIX = 'async function __dsh_program__() {\n'
const STRIP_SUFFIX = '\n}'

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }

/** Node execution under file policy, with optional owner-scoped retained memory. */
export class NodePtcRuntime extends PtcRuntime {
  static inject = ['fs', 'subprocess', 'sandbox', 'sandboxPolicy']
  static Config = NodeConfig
  readonly language = 'typescript'
  readonly isolation = 'process'
  private readonly inMemory?: InMemoryExecution
  private readonly processes: PolicyProcesses

  override get programFormat(): 'function-body' | 'repl' { return this.inMemory ? 'repl' : 'function-body' }
  override get executionInstructions(): string {
    if (this.inMemory) return this.inMemory.executionInstructions
    return 'The program is the body of an async TypeScript function; only erasable syntax is accepted, with no enum or namespaces. Type annotations are advisory. Top-level await and return are supported. Emit output with console.log(...) or return a lossless JSON value. Only printed values and the returned value become program output. Each call runs in a fresh Node process. Node APIs are available through await import(...). Relative paths use the supplied working directory; process.env starts empty. Direct filesystem access follows this execution\'s sandbox policy.'
  }
  private readonly config: ResolvedConfig
  private readonly live = new Set<LiveRun>()
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = { ...config, launch: resolveLaunch(config.launch) } as ResolvedConfig
    validateConfig(this.config)
    this.processes = new PolicyProcesses(ctx)
    if (this.config.executionMode === 'persistent-in-memory') {
      this.inMemory = new InMemoryExecution(ctx, this.config, this.processes)
    }
    ctx.effect(() => async () => {
      this.disposed = true
      const active = [...this.live]
      for (const run of active) run.controller.abort('runtime disposed')
      await Promise.all(active.map(run => run.finished))
    }, 'Node ptc-runtime cleanup')
  }

  override get sandboxMode(): SandboxMode | undefined { return this.ctx.sandboxPolicy.defaultMode }

  override release(owner: object): Promise<void> {
    return this.inMemory ? this.inMemory.release(owner) : super.release(owner)
  }

  override get timeout(): { defaultMs: number; maxMs: number } {
    return { defaultMs: Math.min(this.config.timeoutMs, this.config.maxTimeoutMs), maxMs: this.config.maxTimeoutMs }
  }

  /**
   * Resolve directory, deadline and file policy for the selected execution mode.
   * @param request - Program, bindings, optional cwd/deadline, and resolved authority.
   * @returns Complete execution inputs with a capped numeric budget or an explicit null deadline.
   */
  resolve(request: PtcRunRequest): PtcRunSpec {
    if (this.inMemory) return this.inMemory.resolve(request)
    if (this.disposed) throw new Error('ptc-runtime-node: resolve after disposal')
    const sandboxPolicy = request.sandboxPolicy ?? this.ctx.sandboxPolicy.resolve()
    const cwd = request.cwd ?? sandboxPolicy.workspaceRoot
    if (!isAbsolute(cwd)) throw new Error('ptc-runtime-node: cwd must be absolute')
    return {
      ...request,
      cwd,
      timeoutMs: request.timeoutMs === null ? null : clampTimeout(request.timeoutMs, this.config.timeoutMs, this.config.maxTimeoutMs, 'ptc-runtime-node: timeoutMs'),
      sandboxPolicy,
    }
  }

  /**
   * Run a resolved program under the configured execution mode.
   * Session mode changes cancel admitted calls before process launch as well as active programs.
   * @param spec - Inputs returned by resolve for the configured mode.
   * @returns Logs, JSON completion or failure; retained processes remain until release or invalidation.
   */
  async run(spec: PtcRunSpec): Promise<PtcRunResult> {
    if (this.disposed) throw new Error('ptc-runtime-node: run after disposal')
    const controller = new AbortController()
    const completion = Promise.withResolvers<void>()
    const unregister = spec.sandboxPolicy === undefined ? undefined : this.processes.register(spec.sandboxPolicy, async () => {
      controller.abort(new Error('sandbox mode changed'))
      await completion.promise
    })
    const live = { controller, finished: completion.promise }
    this.live.add(live)
    try {
      await this.processes.wait(spec.sandboxPolicy?.sessionId)
      if (this.inMemory) {
        const signal = spec.signal === undefined ? controller.signal : AbortSignal.any([spec.signal, controller.signal])
        return await this.inMemory.run({ ...spec, signal })
      }
      if (spec.sandboxPolicy === undefined) throw new Error('ptc-runtime-node: run requires a resolved sandbox policy')
      if (!isAbsolute(spec.cwd) || (spec.timeoutMs !== null && (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0 || spec.timeoutMs > this.config.maxTimeoutMs))) throw new Error('ptc-runtime-node: run requires resolved cwd and timeout')
      const bindings = validateBindings(spec)
      return await this.execute(spec, spec.sandboxPolicy, bindings, controller)
    } finally {
      unregister?.()
      this.live.delete(live)
      completion.resolve()
    }
  }

  private async execute(
    spec: PtcRunSpec,
    policy: SandboxExecutionPolicy,
    bindings: Map<string, PtcBindingNamespace>,
    controller: AbortController,
  ): Promise<PtcRunResult> {
    const callBinding = AsyncLocalStorage.bind(invokeBinding)
    const output = new OutputLedger(this.config.maxOutputBytes)
    const logs: string[] = []
    const sandbox: PtcRunSandbox = { mode: policy.mode, denied: false }
    const result = Promise.withResolvers<PtcRunResult>()
    const signal = spec.signal === undefined ? controller.signal : AbortSignal.any([spec.signal, controller.signal])
    let handle: SubprocessHandle | undefined
    let channel: BirpcReturn<ProgramMethods, HostMethods> | undefined
    let confined: ConfinedArgv | undefined
    let settled = false
    let timedOut = false
    let outputOverflow = false
    let overflowResult: PtcRunResult | undefined
    let stderr = ''
    let parsing = true
    const wallTimer = spec.timeoutMs === null ? undefined
      : setTimeout(() => { timedOut = true; controller.abort('execution deadline reached') }, spec.timeoutMs)
    let stopping: Promise<boolean> | undefined
    const stop = (): Promise<boolean> => {
      if (stopping !== undefined) return stopping
      const cleanup = handle === undefined ? Promise.resolve(true) : terminateProcess(handle, this.config.graceMs)
      stopping = cleanup.then((drained) => { unregister(); return drained }, (error: unknown) => {
        stopping = undefined
        throw error
      })
      return stopping
    }
    const finish = (failure?: PtcRunFailure, value?: PtcJsonValue): void => {
      if (settled) return
      settled = true
      clearTimeout(wallTimer)
      signal.removeEventListener('abort', onAbort)
      channel?.$close()
      void (async () => {
        try {
          const drained = await stop()
          if (!drained && failure === undefined) {
            failure = { kind: 'worker-exit', message: 'Node process output did not close cleanly' }
          }
        } catch (error: unknown) {
          failure = { kind: 'worker-exit', message: `managed process cleanup failed: ${messageOf(error)}` }
        }
        const outcome = outputOverflow ? overflowResult ?? output.limit(logs)
          : failure === undefined ? output.success(logs, value) : output.failure(logs, failure)
        result.resolve({ ...outcome, sandbox: { ...sandbox } })
      })()
    }
    const onAbort = (): void => {
      finish(timedOut
        ? { kind: 'timeout', message: `execution deadline reached (${spec.timeoutMs}ms)` }
        : { kind: 'abort', message: messageOf(signal.reason) })
    }
    const unregister = this.processes.register(policy, async () => {
      controller.abort(new Error('sandbox mode changed'))
      await stop()
    })
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
    try {
      // Abort callbacks can settle execution before or during an awaited operation.
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      if (settled) return await result.promise
      const stripped = stripTypeScriptTypes(STRIP_PREFIX + spec.program + STRIP_SUFFIX)
      parsing = false
      const data: ProgramBootData = {
        code: stripped.slice(STRIP_PREFIX.length, stripped.length - STRIP_SUFFIX.length),
        namespaces: [...bindings.values()].map(binding => ({
          global: binding.global,
          names: Object.keys(binding.functions),
          ...binding.errorClass ? { errorClass: binding.errorClass } : {},
        })),
        maxOutputBytes: this.config.maxOutputBytes,
      }
      const executable = await this.ctx.subprocess.resolveExecutable(this.config.launch.executable, undefined, signal)
      // Abort callbacks can settle execution before or during an awaited operation.
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      if (settled) return await result.promise
      const packaged = this.config.launch.kind === 'embedded'
      const heapFlag = `--max-old-space-size=${this.config.maxOldGenerationSizeMb}`
      const argv = [executable, ...packaged ? [] : [heapFlag],
        ...bootstrapArgs(this.ctx.fs, this.config.launch, this.config.maxMessageBytes)]
      confined = policy.mode === 'danger-full-access' ? undefined : await this.ctx.sandbox.confine(argv, { ...policy, mode: policy.mode }, signal)
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- Cancellation can settle during awaited confinement.
      if (settled) return await result.promise
      if (confined !== undefined) sandbox.enforcement = confined.enforcement
      // Electron needs its Node-mode selector until bootstrap; the child then removes it with other ambient values.
      const env: NodeJS.ProcessEnv = Object.fromEntries(Object.keys(process.env)
        .filter(key => !STARTUP_ENVIRONMENT_NAMES.has(key.toUpperCase()) && key.toUpperCase() !== 'ELECTRON_RUN_AS_NODE')
        .map(key => [key, undefined]))
      if (packaged) {
        env.DSH_PTC_RUNTIME_NODE = '1'
        env.NODE_OPTIONS = heapFlag
      }
      handle = this.ctx.subprocess.spawn({ argv: confined?.argv ?? argv, cwd: spec.cwd, env, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', control: 'pipe' }, graceMs: this.config.graceMs, signal })
      const launched = handle
      if (launched.control === undefined || launched.stdout === undefined || launched.stderr === undefined) {
        throw new Error('subprocess provider did not supply the requested control and output pipes')
      }
      const admit = (text: string): void => {
        if (outputOverflow) return
        if (!output.admit(text, logs)) {
          outputOverflow = true
          overflowResult = output.limit([...logs, text])
          finish({ kind: 'output-limit', message: `outer output exceeded ${this.config.maxOutputBytes} bytes` })
        }
      }
      const stdoutDecoder = new TextDecoder('utf-8', { ignoreBOM: true })
      const stderrDecoder = new TextDecoder('utf-8', { ignoreBOM: true })
      handle.stdout?.on('data', (chunk: Buffer) => {
        const text = stdoutDecoder.decode(chunk, { stream: true })
        if (text.length > 0) admit(text)
      })
      handle.stdout?.on('end', () => {
        const text = stdoutDecoder.decode()
        if (text.length > 0) admit(text)
      })
      handle.stdout?.on('error', (error: Error) => { finish({ kind: 'worker-exit', message: messageOf(error) }) })
      handle.stderr?.on('data', (chunk: Buffer) => {
        const text = stderrDecoder.decode(chunk, { stream: true })
        stderr = (stderr + text).slice(-this.config.maxOutputBytes)
        if (text.length > 0) admit(text)
      })
      handle.stderr?.on('end', () => {
        const text = stderrDecoder.decode()
        if (text.length > 0) admit(text)
      })
      handle.stderr?.on('error', (error: Error) => { finish({ kind: 'worker-exit', message: messageOf(error) }) })
      let ready = false
      let pending = 0
      let pendingBytes = 0
      const protocolFailure = (message: string): void => { finish({ kind: 'protocol', message }) }
      const processFinished = (outcome: SubprocessOutcome): void => {
        if (settled) return
        finish((confined !== undefined && classifyRunnerFailure(outcome.exitCode, stderr, confined.runnerFailureRules) !== undefined)
          ? { kind: 'sandbox-unavailable', message: stderr }
          : { kind: 'worker-exit', message: `Node process exited before completing (${String(outcome.exitCode)})${stderr ? `: ${stderr}` : ''}` })
      }
      // Report a protocol failure and abandon the handler; the closed endpoint sends no response.
      const refuse = (message: string): never => { protocolFailure(message); throw new Error(message) }
      const transport = createProcessRpc<ProgramMethods, HostMethods>(launched.control, this.config.maxMessageBytes, {
        ready: () => {
          if (ready) { protocolFailure('duplicate program readiness'); return }
          ready = true
          void transport.run(spec.cwd, data).then((raw) => {
            // A message delivered beside the result can select another outcome first.
            if (settled) return
            const { error, value } = readProgramResult(raw)
            if (error !== undefined) {
              if (confined !== undefined) sandbox.denied = confined.denialSignatures.some(signature =>
                error.message.toLowerCase().includes(signature.toLowerCase()))
              if (error.kind === 'output-limit') outputOverflow = true
            }
            finish(error, value)
          }).catch((error: unknown) => { protocolFailure(messageOf(error)) })
        },
        log: (text: unknown) => {
          if (typeof text === 'string') admit(text)
          else protocolFailure('invalid program log')
        },
        outputLimit: () => {
          outputOverflow = true
          finish()
        },
        invoke: async (global, name, wire) => {
          // Wire identities that are not strings fail these lookups.
          const functions = bindings.get(global)?.functions
          const fn = functions !== undefined && Object.hasOwn(functions, name) ? functions[name] : undefined
          if (typeof fn !== 'function') return refuse('program requested an undeclared binding')
          const args = decodePtcJsonWire(wire)
          if (args === undefined) return refuse('binding arguments must be lossless JSON')
          const bytes = Buffer.byteLength(JSON.stringify(wire))
          if (pending >= this.config.maxPendingCalls || pendingBytes + bytes > this.config.maxMessageBytes) {
            return refuse('pending binding calls exceed configured limits')
          }
          pending += 1
          pendingBytes += bytes
          try { return await callBinding(fn, args) } finally { pending -= 1; pendingBytes -= bytes }
        },
      }, [], (error, kind) => {
        if (kind === 'protocol') protocolFailure(messageOf(error))
        else if (ready) finish({ kind: 'worker-exit', message: messageOf(error) })
        else void launched.done.then(processFinished, (failure: unknown) => { finish({ kind: 'worker-exit', message: messageOf(failure) }) })
      })
      channel = transport
      void launched.done.then((outcome) => {
        // Allow queued control messages to run before classifying a command exit.
        setImmediate(() => { processFinished(outcome) })
      }, (error: unknown) => { finish({ kind: confined !== undefined && isRunnerSpawnFailure(error, confined.argv[0], spec.cwd) ? 'sandbox-unavailable' : 'worker-exit', message: messageOf(error) }) })
    } catch (error: unknown) {
      finish({ kind: error instanceof SandboxUnavailableError ? 'sandbox-unavailable' : parsing ? 'exception' : 'worker-exit', message: messageOf(error) })
    }
    return await result.promise
  }
}

export default NodePtcRuntime
