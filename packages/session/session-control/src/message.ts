/** Shared model-authored message construction for Session and subagent controls. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import type {} from './types.ts'

/**
 * Construct the exact message that will enter the recipient's inbox.
 * @param sender - live Agent whose action authored the content.
 * @param senderName - tree-local name or independent Session id.
 * @param content - message blocks chosen by the sender.
 * @returns one message carrying the sender's durable identity.
 */
export function createAgentMessage(sender: Agent, senderName: string, content: ContentBlock[]): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: `Agent ${senderName} sent a message: ` }, ...content],
    source: { kind: 'agent-message', form: 'relay', senderSessionId: sender.id },
  })
}
