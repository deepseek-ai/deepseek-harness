/** Registered program tools with an explicit runtime and private tool bindings. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { Config } from './config.ts'
import { PtcCalls } from './ptc-calls.ts'
import { createRunCodeTransport, requireRuntimeLanguage } from './ptc.ts'

export { Config as RunCodeConfig } from './config.ts'

/** Fixed capabilities and presentation for one registered program tool. */
export interface RunCodeToolOptions {
  /** Model-facing tool name, distinct from the reserved `run_code` transport. */
  readonly name: string
  /** Capability instructions; runtime syntax, working directory, and escalation guidance are appended. */
  readonly description: string
  /** Caller-owned TypeScript provider; the factory never selects or replaces the scope's shared runtime. */
  readonly runtime: PtcRuntime
  /** Complete private binding set, with unique names; definitions need not be registered. */
  readonly tools: readonly ToolDefinition[]
  /** Nested-call limits; omitted fields use RunCodeConfig defaults. */
  readonly limits?: Partial<Config>
}

/**
 * Create a tool whose programs can call only the supplied private definitions.
 * Nested calls retain approvals, guards, result policy, dispatch logs, and deferred contexts.
 * The owning context cancels and drains active Agent programs when disposed if the runtime
 * retains state or enforces a sandbox. Agent disposal releases retained runtime state.
 * @param ctx - Context with tools, lifecycle ownership, and policies; Agent calls also require workingDirectory.
 * @param options - Fixed runtime, tools, presentation, and configurable limits.
 * @returns An unregistered definition; register it in the owning scope with ctx.tools.register.
 * @throws Error if private tool names repeat or configured limits are invalid.
 * @throws ToolContextUnavailableError if the runtime language is not TypeScript.
 */
export function createRunCodeTool(ctx: Context, options: RunCodeToolOptions): ToolDefinition {
  requireRuntimeLanguage(options.runtime)
  const definitions = new Map<string, ToolDefinition>()
  for (const definition of options.tools) {
    if (definitions.has(definition.name)) throw new Error(`Program tool ${options.name} has duplicate binding ${definition.name}`)
    definitions.set(definition.name, definition)
  }
  const pipeline = new ToolExecutionPipeline(ctx, { get: name => definitions.get(name) })
  return createRunCodeTransport(ctx, pipeline, Config(options.limits ?? {}), new PtcCalls(ctx), {
    ...options,
    tools: [...definitions.values()],
  })
}
