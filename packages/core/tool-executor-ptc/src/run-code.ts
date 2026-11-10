/** Registered program tools with an explicit runtime and private tool bindings. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline, toolErrorMessage } from '@deepseek-ai/dsh-tools/pipeline'
import { Config } from './config.ts'
import { CodeResetFailedError } from './errors.ts'
import { PtcCalls } from './ptc-calls.ts'
import { createRunCodeTransport } from './ptc.ts'

export { Config as RunCodeConfig } from './config.ts'

/** Fixed capabilities and presentation for one registered program tool. */
export interface RunCodeToolOptions {
  /** Model-facing tool name, distinct from the reserved `run_code` transport. */
  readonly name: string
  /** Capability instructions; runtime syntax, working directory, and escalation guidance are appended. */
  readonly description: string
  /** Caller-owned provider; the factory never selects or replaces the scope's shared runtime. */
  readonly runtime: PtcRuntime
  /** Complete private binding set, with unique names; definitions need not be registered. */
  readonly tools: readonly ToolDefinition[]
  /** Nested-call limits; omitted fields use RunCodeConfig defaults. */
  readonly limits?: Partial<Config>
}

/** One registered program tool and the host control over its retained environments. */
export interface RunCodeToolHandle {
  /** Unregistered definition; register it in the owning scope with `ctx.tools.register`. */
  readonly definition: ToolDefinition
  /**
   * Clear one Agent's retained environment without executing program code. Active programs of that
   * Agent are cancelled, the runtime releases the environment, and new programs wait until cleanup
   * settles; a failed cleanup blocks programs until a later reset succeeds. Completed tool effects remain.
   * @param agent - Exact owner supplied to program executions.
   * @returns After process and nested-call cleanup.
   * @throws CodeResetFailedError if the runtime does not retain state, or when cleanup fails.
   */
  reset(agent: Agent): Promise<void>
}

/**
 * Create a tool whose programs can call only the supplied private definitions, with host reset control.
 * Nested calls retain approvals, guards, result policy, dispatch logs, and deferred contexts.
 * The owning context cancels and drains active Agent programs when disposed if the runtime
 * retains state or enforces a sandbox. Agent disposal releases retained runtime state.
 * @param ctx - Context with tools, lifecycle ownership, and policies; Agent calls also require workingDirectory.
 * @param options - Fixed runtime, tools, presentation, and configurable limits.
 * @returns The unregistered definition and its reset control.
 * @throws Error if private tool names repeat or configured limits are invalid.
 */
export function createRunCodeToolHandle(ctx: Context, options: RunCodeToolOptions): RunCodeToolHandle {
  const definitions = new Map<string, ToolDefinition>()
  for (const definition of options.tools) {
    if (definitions.has(definition.name)) throw new Error(`Program tool ${options.name} has duplicate binding ${definition.name}`)
    definitions.set(definition.name, definition)
  }
  const pipeline = new ToolExecutionPipeline(ctx, { get: name => definitions.get(name) })
  const calls = new PtcCalls(ctx)
  const definition = createRunCodeTransport(ctx, pipeline, Config(options.limits ?? {}), calls, {
    ...options,
    tools: [...definitions.values()],
  })
  return {
    definition,
    async reset(agent) {
      if (!options.runtime.retainsState) throw new CodeResetFailedError('The program runtime does not retain an environment')
      try {
        await calls.reset(agent.session.id, () => options.runtime.release(agent))
      } catch (error) {
        throw new CodeResetFailedError(`Program environment reset failed: ${toolErrorMessage(error)}. State may not be cleared; retry the host reset before running more code.`)
      }
    },
  }
}

/**
 * Create a tool whose programs can call only the supplied private definitions.
 * Equivalent to {@link createRunCodeToolHandle} for callers that need no host reset control.
 * @param ctx - Context with tools, lifecycle ownership, and policies; Agent calls also require workingDirectory.
 * @param options - Fixed runtime, tools, presentation, and configurable limits.
 * @returns An unregistered definition; register it in the owning scope with ctx.tools.register.
 * @throws Error if private tool names repeat or configured limits are invalid.
 */
export function createRunCodeTool(ctx: Context, options: RunCodeToolOptions): ToolDefinition {
  return createRunCodeToolHandle(ctx, options).definition
}
