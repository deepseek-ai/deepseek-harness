/** PTC registries: one program entry whose programs call the registry's bindings. @module */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { RUN_CODE_NAME, projectToolSchema } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRegistry, ToolStep } from '@deepseek-ai/dsh-tools'
import { ToolEntries, ToolExecutionPipeline, toolErrorMessage } from '@deepseek-ai/dsh-tools/pipeline'
import { createRunCodeTransport, requirePtcRuntime, requireRuntimeLanguage } from './ptc.ts'
import { renderToolsSdk } from './ts-types.ts'
import { Config } from './config.ts'
import { PtcCalls } from './ptc-calls.ts'
import { CodeResetFailedError } from './errors.ts'

const PTC_ONLY_INSTRUCTION = `\`${RUN_CODE_NAME}\` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.`

/** Entry, runtime, and limits of one PTC registry. */
export interface PtcToolRegistryOptions {
  /** Model-facing program entry name; a root registry uses `run_code`. */
  readonly name: string
  /** Capability instructions replacing the runtime's default entry description. */
  readonly description?: string
  /** Fixed TypeScript runtime; omitted reads the context's `ptcRuntime` service for each program. */
  readonly runtime?: PtcRuntime
  /** Program call limits; omitted fields use {@link PtcToolRegistry.Config} defaults. */
  readonly config?: Partial<Config>
}

/**
 * Registry with one directly callable program entry. Its registrations and
 * included entries are bindings that programs call through the shared
 * invocation pipeline; they are not entries, so a model-direct call to a
 * binding fails as `UNKNOWN_TOOL`.
 */
export class PtcToolRegistry implements ToolRegistry {
  /** Program call allowance and concurrency, shared by root and included registries. */
  static readonly Config = Config

  private readonly bindingEntries: ToolEntries
  private readonly stepBindings = new WeakMap<ToolStep, ReadonlyMap<string, ToolDefinition>>()
  private readonly pipeline: ToolExecutionPipeline
  private readonly calls: PtcCalls
  private readonly entry: ToolDefinition

  /**
   * @param ctx - owning context: policy events, runtime and working-directory lookup, and program cleanup on disposal.
   * @param options - entry name, optional description and fixed runtime, and program call limits.
   * @throws Error when the limits are invalid.
   * @throws ToolContextUnavailableError when a fixed runtime is not TypeScript.
   */
  constructor(
    private readonly ctx: Context,
    private readonly options: PtcToolRegistryOptions,
  ) {
    const runtime = options.runtime === undefined ? undefined : requireRuntimeLanguage(options.runtime)
    const config = Config(options.config ?? {})
    const name = options.name
    this.bindingEntries = new ToolEntries(`PTC registry "${name}"`)
    this.calls = new PtcCalls(ctx)
    this.pipeline = new ToolExecutionPipeline(ctx, {
      get: (called, scope, toolStep) => this.binding(called, scope, toolStep),
    })
    this.entry = createRunCodeTransport(ctx, this.pipeline, config, this.calls, {
      name,
      ...options.description === undefined ? {} : { description: options.description },
      runtime: runtime === undefined ? () => requirePtcRuntime(ctx) : () => runtime,
      sandboxMode: () => (runtime ?? ctx.get('ptcRuntime'))?.sandboxMode,
      bindings: exec => this.bindings(exec.agent, exec.toolStep),
    })
  }

  /**
   * Add one program binding.
   * @param tool - definition programs call as `tools.<name>`.
   * @returns the disposer that removes this binding.
   */
  register(tool: ToolDefinition): () => void {
    return this.bindingEntries.register(tool)
  }

  /**
   * Bind another registry's entries in programs. As a root, the registry
   * receives the registrations its scope sees from `ctx.tools.setRoot()`.
   * @param registry - live source of bindings.
   * @returns the disposer that removes this inclusion.
   */
  include(registry: Pick<ToolRegistry, 'get' | 'getAll'>): () => void {
    return this.bindingEntries.include(registry)
  }

  get(name: string): ToolDefinition | undefined {
    return name === this.entry.name ? this.entry : undefined
  }

  getAll(): readonly ToolDefinition[] {
    return [this.entry]
  }

  /**
   * List the bindings programs receive. With a model step, the first query
   * pins the step's bindings, so its declarations and program calls agree.
   * @param scope - viewing scope without a model step.
   * @param toolStep - model step whose Agent views the bindings.
   * @returns binding definitions in registration order, then inclusion order.
   * @throws ToolCompositionError when a binding name has several definitions or an inclusion cycles.
   */
  bindings(scope?: ScopeKey, toolStep?: ToolStep): readonly ToolDefinition[] {
    return toolStep === undefined ? this.bindingEntries.resolveAll(scope) : [...this.declaredBindings(toolStep).values()]
  }

  /**
   * Test whether a model step declares this registry's program entry.
   * @param toolStep - assembled step, or undefined outside a model step.
   * @returns whether prompt guidance for this entry applies.
   */
  declaredBy(toolStep: ToolStep | undefined): boolean {
    return toolStep?.declares(this.entry) === true
  }

  /**
   * Render TypeScript declarations for the bindings a step's programs call.
   * @param toolStep - model step that declares this registry's entry.
   * @returns the SDK section text.
   * @throws ToolContextUnavailableError when no TypeScript runtime is available.
   */
  renderSdk(toolStep: ToolStep): string {
    const runtime = this.options.runtime ?? requirePtcRuntime(this.ctx)
    return renderToolsSdk(this.bindings(toolStep.agent, toolStep).map(definition => ({
      ...projectToolSchema(definition, false),
      output: definition.output.schema,
    })), runtime.programFormat)
  }

  /**
   * Clear one Agent's retained environment without executing program code.
   * Cancellation or Agent disposal can discard the queued notice after state is cleared.
   * @param agent - Exact owner supplied to program executions.
   * @returns After process and nested-call cleanup and a queued model-visible state-loss notice.
   * @throws Error if no supported runtime is available, without changing admission.
   * @throws CodeResetFailedError if the runtime does not retain state, without changing admission;
   * or if cleanup or notice admission fails, blocking programs until a reset retry succeeds.
   */
  async reset(agent: Agent): Promise<void> {
    const runtime = this.options.runtime ?? requirePtcRuntime(this.ctx)
    if (!runtime.retainsState) throw new CodeResetFailedError('The PTC runtime does not retain an environment')
    try {
      await this.calls.reset(agent.session.id, () => runtime.release(agent), () => {
        agent.inject(createUserMessage({
          content: [{ type: 'text', text: 'Program environment reset; retained variables cleared. Completed tool effects remain.' }],
          source: { kind: 'ptc-mode' },
        }))
      })
    } catch (error) {
      throw new CodeResetFailedError(`Program environment reset failed: ${toolErrorMessage(error)}. State may not be cleared; retry the host reset before running more code.`)
    }
  }

  /**
   * Select this registry as the root of the scope it was constructed in. It
   * binds every tool registered for the scope's Agents and declares them in
   * the system prompt of each step that declares its entry. The registry keeps
   * those registrations after the root unloads, so accepted batches settle
   * their programs' calls.
   * @returns the disposer that removes the root selection and its prompt sections.
   * @throws Error when the scope already has a live root, before any contribution.
   */
  mountRoot(): () => void {
    const { ctx } = this
    // oxlint-disable-next-line typescript/no-this-alias -- the generator effect has its own this
    const registry = this
    // oxlint-disable-next-line typescript/no-misused-promises -- synchronous disposers; preserve the Cordis disposer identity
    return ctx.effect(function* () {
      yield ctx.tools.setRoot(registry)
      yield ctx.systemPrompt.section({
        name: 'tools:ptc-only',
        order: ctx.systemPrompt.getSectionOrder('PTC_ONLY'),
        interpolate: false,
        text: ({ toolStep }) => registry.declaredBy(toolStep) ? PTC_ONLY_INSTRUCTION : '',
      })
      yield ctx.systemPrompt.section({
        name: 'tools:sdk',
        order: ctx.systemPrompt.getSectionOrder('TOOLS_SDK'),
        interpolate: false,
        text: ({ toolStep }) => toolStep !== undefined && registry.declaredBy(toolStep) ? registry.renderSdk(toolStep) : '',
      })
    }, 'ptc-tool-registry.root')
  }

  private binding(name: string, scope: ScopeKey | undefined, toolStep: ToolStep | undefined): ToolDefinition | undefined {
    const current = this.bindingEntries.get(name, scope)
    if (current === undefined || toolStep === undefined) return current
    return this.declaredBindings(toolStep).get(name) === current ? current : undefined
  }

  private declaredBindings(toolStep: ToolStep): ReadonlyMap<string, ToolDefinition> {
    let declared = this.stepBindings.get(toolStep)
    if (declared === undefined) {
      declared = new Map(this.bindingEntries.resolveAll(toolStep.agent).map(definition => [definition.name, definition]))
      this.stepBindings.set(toolStep, declared)
    }
    return declared
  }
}

export { Config } from './config.ts'
export { CodeRunFailedError, CodeResetFailedError } from './errors.ts'
export type { CodeRunErrorCode } from './errors.ts'
export type { PtcDispatchLog } from './runtime-types.ts'
export type { PtcDispatchStartEventData, PtcDispatchEventData } from './types.ts'
export { jsonSchemaToTs, renderToolsSdk, type ToolSdkSchema } from './ts-types.ts'

/** Cordis plugin name. */
export const name = 'ptc-tool-registry'
/** Activate the root only while its registry, prompt service, and runtime are available. */
export const inject = ['tools', 'systemPrompt', 'ptcRuntime']

/**
 * Select a PTC root with the `run_code` entry in the mounting scope.
 * Schema projection and execution reject unsupported runtime languages.
 * @param ctx - context owning the root selection and its lifetime.
 * @param config - timeout-based program call allowance and concurrency limits.
 */
export function apply(ctx: Context, config: Config): void {
  new PtcToolRegistry(ctx, { name: RUN_CODE_NAME, config }).mountRoot()
}
