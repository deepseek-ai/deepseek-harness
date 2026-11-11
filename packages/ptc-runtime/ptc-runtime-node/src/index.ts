/** Node PTC provider with uniform admission and configurable evaluation and process ownership. */
import { Context } from '@deepseek-ai/cordis'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { PtcProgramFormat, PtcRunRequest, PtcRunResult, PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-fs'
import { resolveLaunch } from './launch.ts'
import { NodeConfig, resolveReplScoped, validateConfig } from './config.ts'
import { createExecution } from './execution.ts'
import { PolicyProcesses } from './policy-processes.ts'
import type { Config, ResolvedConfig } from './config.ts'
export type { Config } from './config.ts'
export type { LaunchConfig } from './launch.ts'

interface LiveRun { controller: AbortController; finished: Promise<void> }
interface InitializerRegistration {
  program: string
  removing: boolean
  cleanup?: Promise<void>
}

/** Node execution under file policy, with optional owner-scoped retained memory. */
export class NodePtcRuntime extends PtcRuntime {
  static inject = ['fs', 'subprocess', 'sandbox', 'sandboxPolicy']
  static Config = NodeConfig
  readonly language = 'typescript'
  readonly isolation = 'process'
  private readonly execution: ReturnType<typeof createExecution>
  private readonly processes: PolicyProcesses

  override get programFormat(): PtcProgramFormat { return this.execution.mode.format }
  override get retainsState(): boolean { return this.execution.mode.retainsState }
  override get executionInstructions(): string { return this.execution.mode.executionInstructions }
  private readonly config: ResolvedConfig
  private readonly live = new Set<LiveRun>()
  private disposed = false
  private admitted = false
  private initializer: InitializerRegistration | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = { ...config, replScoped: resolveReplScoped(config), launch: resolveLaunch(config.launch) } as ResolvedConfig
    validateConfig(this.config)
    this.processes = new PolicyProcesses(ctx)
    this.execution = createExecution(ctx, this.config, this.processes)
    ctx.effect(() => async () => {
      this.disposed = true
      await this.drain('runtime disposed')
    }, 'Node ptc-runtime cleanup')
  }

  private async drain(reason: string): Promise<void> {
    const active = [...this.live]
    for (const run of active) run.controller.abort(reason)
    const results = await Promise.allSettled([this.execution.dispose(), ...active.map(run => run.finished)])
    const failed = results.find(result => result.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }

  override registerEnvironmentInitializer(program: string): () => Promise<void> {
    if (this.disposed) throw new Error('ptc-runtime-node: initialization registration after disposal')
    if (this.config.executionMode !== 'persistent-in-memory') {
      throw new Error('ptc-runtime-node: initialization requires persistent-in-memory execution')
    }
    if (this.initializer !== undefined) throw new Error('ptc-runtime-node: environment initializer is already registered')
    if (this.admitted) throw new Error('ptc-runtime-node: register initialization before the first run')
    const registration: InitializerRegistration = {
      program: this.execution.mode.stripTypes(program), removing: false,
    }
    this.initializer = registration
    return () => {
      if (this.initializer !== registration) return Promise.resolve()
      registration.removing = true
      if (registration.cleanup !== undefined) return registration.cleanup
      const completion: PromiseWithResolvers<void> = Promise.withResolvers()
      registration.cleanup = completion.promise
      void this.drain('environment initializer removed').then(() => {
        this.initializer = undefined
        completion.resolve()
      }, (error: unknown) => {
        delete registration.cleanup
        completion.reject(error)
      })
      return completion.promise
    }
  }

  override get sandboxMode(): SandboxMode | undefined { return this.ctx.sandboxPolicy.defaultMode }

  override release(owner: object): Promise<void> {
    return this.execution.release(owner)
  }

  override get timeout(): { defaultMs: number; maxMs: number } {
    return { defaultMs: Math.min(this.config.timeoutMs, this.config.maxTimeoutMs), maxMs: this.config.maxTimeoutMs }
  }

  /**
   * Resolve directory, deadline and file policy for the selected execution mode.
   * @param request - Program, bindings, cwd/deadline, and resolved authority.
   * @returns Complete execution inputs with a capped numeric budget or an explicit null deadline.
   * @throws When an execution choice is invalid or the provider is disposed.
   */
  resolve(request: PtcRunRequest): PtcRunSpec {
    if (this.disposed) {
      const source = this.retainsState ? 'persistent PTC' : 'ptc-runtime-node'
      throw new Error(`${source}: resolve after disposal`)
    }
    return this.execution.resolve(request)
  }

  /**
   * Run a resolved program under the configured execution mode.
   * Session mode changes cancel admitted calls before process launch as well as active programs.
   * @param spec - Inputs returned by resolve for the configured mode.
   * @returns Logs, JSON completion or failure; retained processes remain until release or invalidation.
   */
  async run(spec: PtcRunSpec): Promise<PtcRunResult> {
    if (this.disposed) throw new Error('ptc-runtime-node: run after disposal')
    if (this.initializer?.removing) throw new Error('ptc-runtime-node: environment initialization cleanup is incomplete')
    this.admitted = true
    const initialization = this.initializer?.program
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
      // Disposal can begin while a previous policy's process cleanup is pending.
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      if (this.disposed) throw new Error(`${this.retainsState ? 'persistent PTC' : 'ptc-runtime-node'}: run after disposal`)
      const signal = spec.signal === undefined ? controller.signal : AbortSignal.any([spec.signal, controller.signal])
      return await this.execution.run({ ...spec, signal }, initialization)
    } finally {
      unregister?.()
      this.live.delete(live)
      completion.resolve()
    }
  }
}

export default NodePtcRuntime
