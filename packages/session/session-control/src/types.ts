/** Typed requests and provider-owned acceptance for Session messaging. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId, UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Trusted execution context supplied by the consumer, never by model arguments. */
export interface SessionControlContext {
  /** Exact live Agent whose action sends the message. */
  readonly caller: Agent
  /** Cancels work before acceptance; an accepted message is never withdrawn. */
  readonly signal: AbortSignal
}

/** Text addressed to an independent Session. */
export interface SessionMessageRequest {
  readonly id: SessionId
  readonly message: string
}

/** Content addressed through the existing subagent tree authority. */
export interface SessionAgentContentRequest {
  readonly id: SessionId
  readonly content: ContentBlock[]
}

/** Receipt for acceptance into the target's inbox, without waiting for its answer. */
export interface SessionMessageReceipt {
  readonly messageId: MessageId
}

/** Complete message whose identity and attribution are fixed before delivery. */
export interface SessionDeliveryRequest {
  readonly id: SessionId
  readonly message: UserMessage
}

/** Implementation of Session message acceptance. */
export interface SessionControlProvider {
  /**
   * Accept a message once, using steer semantics, restoring a cold target when needed.
   * Recheck cancellation, caller liveness, archive state, and ownership at acceptance.
   * Rejection never causes an automatic retry; a known receipt survives later cancellation.
   * @param request - target and fully attributed message.
   * @param runtime - exact caller and combined provider/caller cancellation.
   * @returns the accepted message identity.
   */
  deliver(request: SessionDeliveryRequest, runtime: SessionControlContext): Promise<SessionMessageReceipt>
}

/** Capability held by the subagent lifecycle owner for its existing tree controls. */
export interface SessionTreeDelivery extends SessionControlProvider {
  /**
   * Resolve the sender's tree-local display name while checking its runtime ownership.
   * @param caller - exact live sender.
   * @returns the sender's tree-local name or Session id.
   */
  senderName(caller: Agent): string
}

/** Durable attribution for one model-authored message between Agents. */
export interface AgentMessageSource {
  readonly kind: 'agent-message'
  /** A message another agent addressed to this one (`relay` context form). */
  readonly form: 'relay'
  /** Session id of the Agent whose tool call produced the message. */
  readonly senderSessionId: SessionId
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'agent-message': AgentMessageSource
  }
}
