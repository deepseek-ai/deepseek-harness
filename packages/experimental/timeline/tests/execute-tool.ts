import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/** Dispatch one fixture call through the selected Harness tool executor. */
export async function executeTool(
  ctx: Context,
  { agent, arguments: args, callId, name, signal }: ToolExecutionInput,
): Promise<ToolExecutionResult> {
  const batch = await ctx.tools.execute({
    ...(agent === undefined ? {} : { agent }),
    signal,
    calls: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }],
  })
  const outcome = batch.results[0]
  if (outcome === undefined) throw new Error('Missing fixture tool result')
  return outcome.result
}
