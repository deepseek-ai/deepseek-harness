/** Rejection of new work after an Agent starts closing. @module @deepseek-ai/dsh-agent/closed-error */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** An Agent has stopped accepting new input and maintenance work (`AGENT_CLOSED`). */
export class AgentClosedError extends HarnessError {
  /**
   * @param agentId - closing Agent identity.
   * @param options - original lifecycle cancellation, when available.
   */
  constructor(readonly agentId: SessionId, options?: ErrorOptions) {
    super(`agent "${agentId}" is closing`, 'AGENT_CLOSED', options)
  }
}
