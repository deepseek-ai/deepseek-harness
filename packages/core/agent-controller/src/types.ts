/**
 * Delivery vocabulary of the Agent controller: the request a sender passes to
 * `ctx.agentController.deliver`, the decision an admission listener returns,
 * and the `agent-controller/admission` event.
 *
 * @module @deepseek-ai/dsh-agent-controller/types
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MessageSource, UserMessage } from '@deepseek-ai/dsh-llm'
import type { Scoped } from '@deepseek-ai/dsh-scope'

/** How a delivered message enters the inbox: `followup` for its own turn, `steer` for the nearest step. */
export type DeliveryMode = 'followup' | 'steer'

/** One message a sender delivers on someone's behalf. */
export interface DeliveryRequest {
  /** Where the message enters once it is admitted. */
  readonly mode: DeliveryMode
  /** Durable attribution recorded on the message. */
  readonly source: MessageSource
  /** The sender's cancellation; it ends the sender's wait at once and stops a message that has not entered the inbox. */
  readonly signal: AbortSignal
  /**
   * Turn the sender's content into durable message content, such as by
   * storing attachments. It runs in the Agent's delivery order, after the
   * earlier messages to the same Agent settled; its failure reaches the
   * sender unchanged.
   * @param signal - aborted when the sender cancels or the controller stops; controller disposal waits for the preparation to settle.
   * @returns the content of the message.
   */
  readonly prepare: (signal: AbortSignal) => Promise<UserMessage['content']>
  /**
   * Record what the sender needs before the Agent wakes. It runs
   * synchronously after admission, immediately before the message enters the
   * inbox. A throw keeps the message out of the inbox and reaches the sender
   * unchanged; the sender reverts its own effects when `deliver` rejects.
   * @param message - the admitted message.
   */
  readonly beforeInsert?: (message: UserMessage) => void
}

/** The outcome of the admission stage for one message. */
export type AdmissionDecision =
  /** The message enters the inbox. */
  | { readonly kind: 'admit' }
  /** The message stays out of the inbox. */
  | {
    readonly kind: 'reject'
    /** Code of the refusal, owned by its source, such as `forge/worktree-missing`. */
    readonly reason: string
    /** Explanation for a sender that shows nothing of the refusing plugin. */
    readonly message: string
    /** Whether the refusing plugin explains the refusal in its own interface. */
    readonly presented: boolean
  }

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Decide whether one message from outside an Agent enters its inbox.
     * `ctx.agentController.deliver` runs this stage and appends the message
     * only after the whole chain admitted it; messages the Agent's own
     * machinery produces enter through `followup`, `steer`, or `inject`
     * without it. Listeners run in registration order, and messages to one
     * Agent are decided one at a time in arrival order. A listener admits by
     * returning the decision of `next()`, whose last step admits; awaiting
     * before `next()` holds the message, and returning a `reject` decision
     * refuses it without asking later listeners. A thrown error means the
     * listener's check itself failed. A listener must not wait for a person
     * when the message source is unattended, such as a schedule or a webhook.
     * @param payload.agent - the receiving Agent.
     * @param payload.message - the message as it will enter the inbox.
     * @param payload.signal - aborted when the sender cancels or the controller stops; a holding
     * listener must settle once it aborts, because controller disposal waits for it.
     * Scope-filtered dispatch (`@deepseek-ai/dsh-scope`): Agent-scoped listeners receive only that Agent.
     * @mode waterfall
     */
    'agent-controller/admission'(this: Scoped<Agent>, payload: { agent: Agent; message: UserMessage; signal: AbortSignal }, next: () => Promise<AdmissionDecision>): Promise<AdmissionDecision>
  }
}
