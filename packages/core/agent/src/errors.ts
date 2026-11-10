/**
 * Failures shared by Agent implementations and input consumers.
 * @module @deepseek-ai/dsh-agent
 */

import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Input rejected before changing the inbox because the Agent is disposing. */
export class AgentInputClosedError extends HarnessError {
  constructor(id: SessionId) {
    super(`agent "${id}" no longer accepts input`, 'AGENT_INPUT_CLOSED')
  }
}
