/** One-tool dispatch through the batch executor, for tests that drive a single call. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

/**
 * Dispatch one standalone tool call and return that call's own settled result.
 *
 * The executor's batch API reports one result per model call; these tests drive a single call as the
 * loop would, and read the result's content or failure directly.
 * @param ctx - Context carrying the tool runtime.
 * @param input - Call identity, name, raw arguments, owning Agent, and cancellation.
 * @returns The call's settled execution result.
 */
export async function executeOneTool(
  ctx: Context,
  input: {
    readonly signal: AbortSignal
    readonly callId: ToolCallId
    readonly name: string
    readonly arguments: unknown
    readonly agent: Agent
  },
): Promise<ToolExecutionResult> {
  const batch = await ctx.tools.execute({
    signal: input.signal,
    calls: [{
      type: 'tool-call',
      id: input.callId,
      name: input.name,
      arguments: JSON.stringify(input.arguments ?? {}),
    }],
    agent: input.agent,
  })
  const result = batch.results[0]
  if (result === undefined) throw new Error('the tool batch returned no result')
  return result.result
}
