/** Confined Node programs with host-owned bindings, output limits, and managed process cleanup. */
import { stripTypeScriptTypes } from 'node:module'
import { isAbsolute } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcBindingNamespace, PtcJsonValue, PtcRunFailure, PtcRunRequest, PtcRunResult, PtcRunSandbox, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { MAX_TIMER_DELAY_MS, clampTimeout } from '@deepseek-ai/dsh-timeout'
import { SandboxUnavailableError, classifyRunnerFailure, isRunnerSpawnFailure } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle, SubprocessOutcome } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-fs'
import { snapshotJsonValue } from '@deepseek-ai/dsh-util-values'
import { validateBindings } from './bindings.ts'
import { JsonChannel } from './channel.ts'
import { bootstrapArgs } from './launch.ts'
import type { LaunchConfig } from './launch.ts'
import { OutputLedger } from './output-ledger.ts'
import { drainOutput } from './output-stream.ts'
import { STARTUP_ENVIRONMENT_NAMES } from './environment.ts'
import { decodePtcJsonWire, encodePtcJsonWire } from './json-wire.ts'
import type { ProgramBootData } from './protocol.ts'

/** Deployment-varying runtime bounds and launch choices. */
export interface Config extends LaunchConfig {
  /** Default elapsed deadline, including nested tool and approval waits. */
  timeoutMs?: number
  /** Maximum numeric elapsed budget accepted by resolve. */
  maxTimeoutMs?: number
  /** Combined serialized logs, completion and diagnostic byte cap. */
  maxOutputBytes?: number
  /** V8 old-generation heap limit in MiB; native allocations are excluded. */
  maxOldGenerationSizeMb?: number
  /** Maximum control frame, outstanding argument and queued control-output bytes. */
  maxMessageBytes?: number
  /** Maximum simultaneous host binding calls accepted from a program. */
  maxPendingCalls?: number
  /** Managed process termination and output-drain grace in milliseconds. */
  graceMs?: number
}

type ResolvedConfig = Required<Omit<Config, 'bootstrapPath'>> & Pick<Config, 'bootstrapPath'>
interface LiveRun { controller: AbortController; finished: Promise<void> }
const STRIP_PREFIX = 'async function __dsh_program__() {\n'
const STRIP_SUFFIX = '\n}'

function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }

/** Node provider; direct file effects use the same sandbox service as Bash. */
export class NodePtcRuntime extends PtcRuntime {
  static inject = ['fs', 'subprocess', 'sandbox', 'sandboxPolicy']
  static Config: z<Config> = z.object({
    timeoutMs: z.number().default(120_000),
    maxTimeoutMs: z.number().default(600_000),
    maxOutputBytes: z.number().default(67_108_864),
    maxOldGenerationSizeMb: z.number().default(512),
    maxMessageBytes: z.number().default(134_217_728),
    maxPendingCalls: z.number().default(128),
    graceMs: z.number().default(3_000),
    nodeExecutable: z.string(),
    bootstrapPath: z.string(),
  })
  readonly language = 'typescript'
  readonly isolation = 'process'
  override get executionInstructions(): string {
    return 'Each call runs in a fresh Node process. Node APIs are available through await import(...). Relative paths use the supplied working directory; process.env starts empty. Direct filesystem access follows this execution\'s sandbox policy.'
  }
  private readonly config: ResolvedConfig
  private readonly live = new Set<LiveRun>()
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = { ...config, nodeExecutable: config.nodeExecutable ?? process.execPath } as ResolvedConfig
    for (const [key, value] of Object.entries(this.config)) {
      if (typeof value === 'number' && (!Number.isFinite(value) || value <= 0)) throw new Error(`ptc-runtime-node: ${key} must be positive and finite`)
    }
    for (const key of ['timeoutMs', 'maxTimeoutMs', 'graceMs'] as const) {
      if (this.config[key] > MAX_TIMER_DELAY_MS) throw new Error(`ptc-runtime-node: ${key} exceeds the supported timer range`)
    }
    if (!Number.isSafeInteger(this.config.maxOutputBytes) || this.config.maxOutputBytes < 4) throw new Error('ptc-runtime-node: maxOutputBytes must be an integer of at least 4')
    if (!Number.isSafeInteger(this.config.maxMessageBytes) || this.config.maxMessageBytes > 0xffff_ffff) throw new Error('ptc-runtime-node: maxMessageBytes must fit an unsigned 32-bit frame length')
    if (!Number.isSafeInteger(this.config.maxPendingCalls)) throw new Error('ptc-runtime-node: maxPendingCalls must be an integer')
    if (!Number.isSafeInteger(this.config.maxOldGenerationSizeMb)) throw new Error('ptc-runtime-node: maxOldGenerationSizeMb must be an integer')
    if (this.config.nodeExecutable.length === 0) throw new Error('ptc-runtime-node: nodeExecutable must be non-empty')
    if (this.config.bootstrapPath !== undefined && !isAbsolute(this.config.bootstrapPath)) throw new Error('ptc-runtime-node: bootstrapPath must be absolute')
    ctx.effect(() => async () => {
      this.disposed = true
      const active = [...this.live]
      for (const run of active) run.controller.abort('runtime disposed')
      await Promise.all(active.map(run => run.finished))
    }, 'Node ptc-runtime cleanup')
  }

  override get sandboxMode(): SandboxMode { return this.ctx.sandboxPolicy.defaultMode }

  override get timeout(): { defaultMs: number; maxMs: number } {
    return { defaultMs: Math.min(this.config.timeoutMs, this.config.maxTimeoutMs), maxMs: this.config.maxTimeoutMs }
  }

  /**
   * Resolve an execution under explicit or deployment policy.
   * @param request - Program, bindings, optional cwd/deadline, and resolved authority.
   * @returns Complete execution inputs with a capped numeric budget or an explicit null deadline.
   */
  resolve(request: PtcRunRequest): PtcRunSpec {
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
   * Run a resolved program in a fresh managed and confined Node process.
   * @param spec - Inputs returned by resolve; missing authority is caller misuse.
   * @returns Output and file-confinement facts after managed cleanup.
   */
  async run(spec: PtcRunSpec): Promise<PtcRunResult> {
    if (this.disposed) throw new Error('ptc-runtime-node: run after disposal')
    if (spec.sandboxPolicy === undefined) throw new Error('ptc-runtime-node: run requires a resolved sandbox policy')
    if (!isAbsolute(spec.cwd) || (spec.timeoutMs !== null && (!Number.isFinite(spec.timeoutMs) || spec.timeoutMs <= 0 || spec.timeoutMs > this.config.maxTimeoutMs))) throw new Error('ptc-runtime-node: run requires resolved cwd and timeout')
    const bindings = validateBindings(spec)
    const controller = new AbortController()
    const completion = Promise.withResolvers<void>()
    const live = { controller, finished: completion.promise }
    this.live.add(live)
    try {
      return await this.execute(spec, spec.sandboxPolicy, bindings, controller)
    } finally {
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
    const output = new OutputLedger(this.config.maxOutputBytes)
    const logs: string[] = []
    const sandbox: PtcRunSandbox = { mode: policy.mode, denied: false }
    const result = Promise.withResolvers<PtcRunResult>()
    const signal = spec.signal === undefined ? controller.signal : AbortSignal.any([spec.signal, controller.signal])
    let handle: SubprocessHandle | undefined
    let channel: JsonChannel | undefined
    let confined: ConfinedArgv | undefined
    let settled = false
    let timedOut = false
    let outputOverflow = false
    let overflowResult: PtcRunResult | undefined
    let stderr = ''
    let parsing = true
    const wallTimer = spec.timeoutMs === null ? undefined
      : setTimeout(() => { timedOut = true; controller.abort('execution deadline reached') }, spec.timeoutMs)
    const finish = (failure?: PtcRunFailure, value?: PtcJsonValue): void => {
      if (settled) return
      settled = true
      clearTimeout(wallTimer)
      signal.removeEventListener('abort', onAbort)
      channel?.close()
      void (async () => {
        if (handle !== undefined) {
          try {
            handle.terminate()
            await Promise.all([handle.done.catch(() => {}), handle.waitForExit()])
            const drained = await Promise.all([
              drainOutput(handle.stdout, this.config.graceMs),
              drainOutput(handle.stderr, this.config.graceMs),
            ])
            if (drained.includes(false) && failure === undefined) {
              failure = { kind: 'worker-exit', message: 'Node process output did not close cleanly' }
            }
          } catch (error: unknown) {
            failure = { kind: 'worker-exit', message: `managed process cleanup failed: ${messageOf(error)}` }
          } finally {
            handle.stdout?.destroy()
            handle.stderr?.destroy()
          }
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
      const executable = await this.ctx.subprocess.resolveExecutable(this.config.nodeExecutable, undefined, signal)
      // Abort callbacks can settle execution before or during an awaited operation.
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      if (settled) return await result.promise
      const packaged = 'pkg' in process && this.config.bootstrapPath === undefined
      const heapFlag = `--max-old-space-size=${this.config.maxOldGenerationSizeMb}`
      const argv = [executable, ...packaged ? [] : [heapFlag], ...bootstrapArgs(this.ctx.fs, this.config, this.config.maxMessageBytes)]
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
      let nextId = 1
      let pending = 0
      let pendingBytes = 0
      const protocolFailure = (message: string): void => { finish({ kind: 'protocol', message }) }
      const processFinished = (outcome: SubprocessOutcome): void => {
        if (settled) return
        finish((confined !== undefined && classifyRunnerFailure(outcome.exitCode, stderr, confined.runnerFailureRules) !== undefined)
          ? { kind: 'sandbox-unavailable', message: stderr }
          : { kind: 'worker-exit', message: `Node process exited before completing (${String(outcome.exitCode)})${stderr ? `: ${stderr}` : ''}` })
      }
      const transport: JsonChannel = new JsonChannel(launched.control, this.config.maxMessageBytes, (raw, bytes) => {
        if (!record(raw)) { protocolFailure('invalid control frame'); return }
        if (!ready) {
          if (raw.type !== 'ready') { protocolFailure('program frame arrived before bootstrap readiness'); return }
          ready = true
          void transport.send({ type: 'boot', data }).catch((error: unknown) => { protocolFailure(messageOf(error)) })
          return
        }
        switch (raw.type) {
          case 'log':
            if (typeof raw.text !== 'string') { protocolFailure('invalid log frame'); return }
            admit(raw.text)
            return
          case 'output-limit': outputOverflow = true; finish(); return
          case 'done': {
            if (raw.error !== undefined) {
              if (!record(raw.error) || typeof raw.error.message !== 'string' || (raw.error.kind !== 'exception' && raw.error.kind !== 'invalid-output' && raw.error.kind !== 'output-limit')) { protocolFailure('invalid terminal error'); return }
              const failure = { kind: raw.error.kind, message: raw.error.message } as PtcRunFailure
              if (confined !== undefined) {
                sandbox.denied = confined.denialSignatures.some(signature =>
                  failure.message.toLowerCase().includes(signature.toLowerCase()))
              }
              if (failure.kind === 'output-limit') outputOverflow = true
              finish(failure)
              return
            }
            const value = raw.value === undefined ? undefined : decodePtcJsonWire(raw.value)
            if (raw.value !== undefined && value === undefined) finish({ kind: 'invalid-output', message: 'program completion must be lossless JSON' })
            else finish(undefined, value)
            return
          }
          case 'call': {
            if (!Number.isSafeInteger(raw.id) || raw.id !== nextId || typeof raw.global !== 'string' || typeof raw.name !== 'string') { protocolFailure('invalid binding call identity'); return }
            nextId += 1
            const functions = bindings.get(raw.global)?.functions
            const fn = functions !== undefined && Object.hasOwn(functions, raw.name) ? functions[raw.name] : undefined
            if (typeof fn !== 'function') { protocolFailure('program requested an undeclared binding'); return }
            const args = decodePtcJsonWire(raw.args)
            if (args === undefined) { protocolFailure('binding arguments must be lossless JSON'); return }
            if (++pending > this.config.maxPendingCalls || (pendingBytes += bytes) > this.config.maxMessageBytes) { protocolFailure('pending binding calls exceed configured limits'); return }
            const id = raw.id
            void (async () => {
              let reply: unknown
              try {
                const value = snapshotJsonValue(await fn(args))
                if (value === undefined) throw new Error('binding resolution must be lossless JSON')
                reply = { type: 'reply', id, ok: true, value: encodePtcJsonWire(value) }
              } catch (error: unknown) {
                reply = { type: 'reply', id, ok: false, message: messageOf(error) }
              } finally {
                pending -= 1
                pendingBytes -= bytes
              }
              if (!settled) await transport.send(reply)
            })().catch((error: unknown) => { protocolFailure(messageOf(error)) })
            return
          }
          default: protocolFailure('unknown control message')
        }
      }, (error, kind) => {
        if (kind === 'protocol') protocolFailure(messageOf(error))
        else if (ready) finish({ kind: 'worker-exit', message: messageOf(error) })
        else void launched.done.then(processFinished, (failure: unknown) => { finish({ kind: 'worker-exit', message: messageOf(failure) }) })
      })
      channel = transport
      void launched.done.then((outcome) => {
        // Allow queued control-frame callbacks to run before classifying a command exit.
        setImmediate(() => { processFinished(outcome) })
      }, (error: unknown) => { finish({ kind: confined !== undefined && isRunnerSpawnFailure(error, confined.argv[0], spec.cwd) ? 'sandbox-unavailable' : 'worker-exit', message: messageOf(error) }) })
    } catch (error: unknown) {
      finish({ kind: error instanceof SandboxUnavailableError ? 'sandbox-unavailable' : parsing ? 'exception' : 'worker-exit', message: messageOf(error) })
    }
    return await result.promise
  }
}

export default NodePtcRuntime
