/** Native execution plugin for the mounting Agent, preset, or deployment scope. @module */
import type { Context } from '@deepseek-ai/cordis'
import { projectToolSchema } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolExecutor, ToolModelInput, ToolBatchInput, ToolBatchResult } from '@deepseek-ai/dsh-tools'
import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline'

/** Executes visible capabilities directly and owns their complete batch settlement. */
export class NativeToolExecutor implements ToolExecutor {
  private readonly pipeline: ToolExecutionPipeline

  constructor(ctx: Context, private readonly maxParallel: () => number = () => 10) {
    this.pipeline = new ToolExecutionPipeline(ctx)
  }

  describe(tools: readonly ToolDefinition[]): ToolModelInput {
    return { schemas: tools.map(definition => projectToolSchema(definition, false)) }
  }

  execute(input: ToolBatchInput): Promise<ToolBatchResult> {
    return executeToolBatch(input, this.pipeline, this.maxParallel)
  }
}

/** Cordis plugin name. */
export const name = 'native-tool-executor'
/** Tool registration and scoped dispatch. */
export const inject = ['tools']

/**
 * Select native execution in the mounting scope.
 * @param ctx - context owning this executor's selection and lifetime.
 */
export function apply(ctx: Context): void {
  ctx.tools.setExecutor(new NativeToolExecutor(ctx))
}
