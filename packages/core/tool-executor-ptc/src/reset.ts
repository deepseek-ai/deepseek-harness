/** Host-side reset of an Agent's retained PTC environment. @module */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { toolErrorMessage } from '@deepseek-ai/dsh-tools/pipeline'
import { CodeResetFailedError } from './errors.ts'
import type { PtcCalls } from './ptc-calls.ts'
import { requirePtcRuntime } from './ptc.ts'

/**
 * Terminate an owned environment and queue a durable notice for the next model request.
 * @param ctx - Executor context containing the runtime provider.
 * @param calls - Complete calls whose cancellation and cleanup precede success.
 * @param agent - Exact owner of the retained environment.
 * @returns After cleanup and notice admission; completed tool effects remain.
 */
export async function resetPtcEnvironment(ctx: Context, calls: PtcCalls, agent: Agent): Promise<void> {
  const runtime = requirePtcRuntime(ctx)
  if (!runtime.retainsState) throw new CodeResetFailedError('The PTC runtime does not retain an environment')
  try {
    await calls.reset(agent.session.id, () => runtime.release(agent))
  } catch (error) {
    throw new CodeResetFailedError(`Program environment reset failed: ${toolErrorMessage(error)}. State may not be cleared; retry the host reset before running more code.`)
  }
  agent.inject(createUserMessage({
    content: [{ type: 'text', text: 'The host reset the program environment. All retained variables have been cleared. The next run_code starts fresh. Completed tool effects have not been undone.' }],
    source: { kind: 'ptc-mode' },
  }))
}
