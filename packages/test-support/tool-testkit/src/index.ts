/** Canonical tool-definition fixtures for repository tests. @module @deepseek-ai/dsh-tool-testkit */

import type { Context } from '@deepseek-ai/cordis'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  DefineToolOptions, InferArgs, ParameterSchemaSpec, ToolDefinition,
  ToolExecutionInput, ToolExecutionResult, ToolRunContext,
} from '@deepseek-ai/dsh-tools'

// Expand interface fields so the fixture's content value is checked as JSON without changing runtime values.
type JsonFields<T> = T extends string | number | boolean | null | undefined ? T
  : T extends (...args: never[]) => unknown ? T
    : { [K in keyof T]: JsonFields<T[K]> }
type ContentValue = JsonFields<ContentBlock>

const CONTENT_VALUE_SCHEMA = { type: 'array', items: { type: 'json' } } as const

/** Options for a fixture whose canonical value is its rendered content array. */
export type ContentToolFixtureOptions<S extends ParameterSchemaSpec> = Omit<
  DefineToolOptions<S, typeof CONTENT_VALUE_SCHEMA>,
  'output' | 'execute'
> & {
  /** Produce the fixture's content blocks as its canonical test value. */
  execute(args: InferArgs<S>, exec: ToolRunContext): Promise<ContentBlock[]>
}

/**
 * Define a test fixture that deliberately uses its content blocks as the
 * canonical JSON value. Product tools must declare domain-owned DTOs instead.
 * @param options - ordinary fixture fields plus a content-producing body.
 * @returns a registry-ready tool with an explicit JSON-array output contract.
 * @internal
 */
export function defineContentToolFixture<const S extends ParameterSchemaSpec>(
  options: ContentToolFixtureOptions<S>,
): ToolDefinition {
  // oxlint-disable-next-line typescript/unbound-method
  const execute = options.execute
  return defineTool({
    ...options,
    output: {
      schema: CONTENT_VALUE_SCHEMA,
      render: (_args, value) => value as ContentValue[],
    },
    async execute(args, exec) {
      const value: ContentValue[] = await execute(args, exec)
      return value
    },
  })
}

/**
 * Exercise invocation stages directly, preserving parsed and nested test inputs.
 * The call resolves the entry `ctx.tools.get()` returns, so the context needs a
 * selected root; a PTC root resolves only its program entry. Use
 * executeModelToolFixture for a complete single-call batch.
 * @param ctx - context owning the tool definitions, the selected root, and execution policy.
 * @param input - parsed invocation, including nested identity when testing a composite.
 * @returns the settled capability result.
 * @internal
 */
export async function executeToolFixture(ctx: Context, input: ToolExecutionInput): Promise<ToolExecutionResult> {
  return runStages(new ToolExecutionPipeline(ctx, {
    get: (name, scope, toolStep) => {
      const tool = ctx.tools.get(name, scope)
      return tool !== undefined && (toolStep?.declares(tool) ?? true) ? tool : undefined
    },
  }), input)
}

/**
 * Exercise invocation stages for one known definition without a registry lookup,
 * such as a program binding under a PTC root, which `ctx.tools.get()` does not resolve.
 * @param ctx - context owning the execution policy.
 * @param definition - the definition the call runs when its name matches.
 * @param input - parsed invocation, including nested identity when testing a composite.
 * @returns the settled capability result.
 * @internal
 */
export async function executeDefinitionFixture(
  ctx: Context, definition: ToolDefinition, input: ToolExecutionInput,
): Promise<ToolExecutionResult> {
  return runStages(new ToolExecutionPipeline(ctx, { get: name => name === definition.name ? definition : undefined }), input)
}

/** Prepare, dispatch when policy allows, and complete one invocation. */
async function runStages(pipeline: ToolExecutionPipeline, input: ToolExecutionInput): Promise<ToolExecutionResult> {
  const prepared = await pipeline.prepare(input)
  const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared
  return pipeline.complete(prepared.exec, outcome)
}

/**
 * Run one raw call through `ctx.tools.execute()` without root Session logging.
 * @param ctx - context owning the selected root registry.
 * @param input - JSON arguments, optional Agent supplying scoped tools and tool context, and optional model step.
 * @returns the single settled result.
 * @internal
 */
export async function executeModelToolFixture(
  ctx: Context,
  input: Pick<ToolExecutionInput, 'callId' | 'name' | 'arguments' | 'signal' | 'agent' | 'toolStep'>,
): Promise<ToolExecutionResult> {
  const args = JSON.stringify(input.arguments)
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- JSON.stringify returns undefined for non-JSON fixture arguments
  if (args === undefined) throw new TypeError('Model tool fixture arguments must encode as JSON')
  const batch = await ctx.tools.execute({
    calls: [{ type: 'tool-call', id: input.callId, name: input.name, arguments: args }],
    signal: input.signal,
    ...input.agent === undefined ? {} : { agent: input.agent },
    ...input.toolStep === undefined ? {} : { toolStep: input.toolStep },
  })
  const outcome = batch.results[0]
  if (outcome === undefined) throw new Error('ctx.tools.execute() omitted the model tool fixture result')
  return outcome.result
}

/** The parts of a prompt assembly that name the tools one model step can call. */
export interface StepToolAssembly {
  readonly tools: readonly { readonly name: string }[]
  readonly sections: readonly { readonly name: string; readonly text: string }[]
}

/**
 * List the tools one assembled model step can call: its declared entries, or,
 * when the step declares a PTC program entry, the bindings its `tools:sdk`
 * section declares in `ToolArgsMap`.
 * @param assembly - prompt assembly of a step captured with `ToolStep.capture()`.
 * @returns tool names, sorted.
 * @internal
 */
export function stepToolNames(assembly: StepToolAssembly): string[] {
  const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
  if (sdk === '') return assembly.tools.map(tool => tool.name).sort()
  const members = /^interface ToolArgsMap \{\n([\s\S]*?)\n\}$/mu.exec(sdk)?.[1] ?? ''
  return [...members.matchAll(/^ {2}("(?:[^"\\]|\\.)*"|[A-Za-z_$][\w$]*)\??: /gmu)]
    .map(([, key = '']) => key.startsWith('"') ? JSON.parse(key) as string : key)
    .sort()
}
