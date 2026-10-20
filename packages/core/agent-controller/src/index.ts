/**
 * Agent controller: the entry through which a sender delivers a message from
 * outside an Agent into its inbox, after the `agent-controller/admission`
 * stage decided it.
 *
 * @module @deepseek-ai/dsh-agent-controller
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { AdmissionDecision, DeliveryRequest } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Delivery of messages from outside an Agent into its inbox. */
    agentController: AgentController
  }
}

/** `code` of every {@link AgentAdmissionRejected}; senders recognize a refusal by it. */
export const ADMISSION_REJECTED_CODE = 'AGENT_ADMISSION_REJECTED'

/** Refusal reason when an admission listener threw instead of returning a decision. */
export const ADMISSION_FAILED = 'agent-controller/admission-failed'

/** Refusal reason when the Agent left the registry before its message entered the inbox. */
export const ADMISSION_AGENT_GONE = 'agent-controller/agent-gone'

/** The last step of the admission stage, reached once every listener passed the message on. */
const ADMIT: AdmissionDecision = { kind: 'admit' }

/**
 * A message `deliver` kept out of the inbox: a listener rejected it, a
 * listener threw, or the Agent left the registry first. Senders recognize it
 * by its {@link ADMISSION_REJECTED_CODE} `code` and read `reason`, never by
 * its class, so the check also holds for an error from another copy of this
 * module.
 */
export class AgentAdmissionRejected extends HarnessError {
  declare readonly code: typeof ADMISSION_REJECTED_CODE

  /**
   * @param reason - why the message stayed out: a listener's reason, {@link ADMISSION_FAILED}, or {@link ADMISSION_AGENT_GONE}.
   * @param message - explanation for a sender that shows nothing of the refusing plugin.
   * @param presented - whether the refusing plugin explains the refusal in its own interface.
   * @param options - standard Error options.
   */
  constructor(readonly reason: string, message: string, readonly presented: boolean, options?: ErrorOptions) {
    super(message, ADMISSION_REJECTED_CODE, options)
  }
}

/**
 * Follow a delivery until its sender cancels. The sender's wait ends with the
 * cancellation reason at once; the delivery keeps its place in the Agent's
 * order and stops at its next cancellation check, before any append.
 */
async function untilCancelled<T>(delivery: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  const cancelled = Promise.withResolvers<never>()
  const onAbort = (): void => { cancelled.reject(signal.reason) }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([delivery, cancelled.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Delivers the messages that senders, such as the Web Session Remote, bring
 * on someone's behalf. Messages to one Agent are prepared, decided, and
 * appended one at a time in arrival order; messages to different Agents do
 * not wait for each other. Disposal stops every message that has not entered
 * an inbox and finishes once each delivery it stopped has settled.
 */
export class AgentController extends Service {
  static inject = ['agents']

  /** Per Agent, the settlement of its latest delivery; the next message waits for it. */
  private readonly deliveries = new WeakMap<Agent, Promise<void>>()
  /** Settlements of the deliveries that have not finished; disposal waits for them. */
  private readonly pending = new Set<Promise<void>>()
  /** Aborted on disposal; stops the messages that have not entered an inbox. */
  private readonly lifetime = new AbortController()

  /** @param ctx - Host context carrying the Agent registry. */
  constructor(ctx: Context) {
    super(ctx, 'agentController')
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('The agent controller stopped before the message entered the inbox.'))
      // Preparation and listeners observe the abort; the Agent registry stays available until they settle.
      await Promise.all(this.pending)
    }, 'agent-controller.lifetime')
  }

  /**
   * Deliver one message from outside the Agent: prepare its content, ask the
   * `agent-controller/admission` stage for a decision, then append an
   * admitted message with `followup` or `steer`.
   * @param agent - the receiving Agent.
   * @param request - delivery mode, source, cancellation, and the sender's content preparation.
   * @returns the id of the message once it is in the inbox.
   * @throws {@link AgentAdmissionRejected} when a listener rejects the message
   * or throws, or when the Agent left the registry first; the error of
   * `prepare`, `beforeInsert`, `followup`, or `steer` unchanged; the sender's
   * cancellation reason as soon as it cancels, also while the message waits
   * behind another one; the stop reason once the controller stops.
   */
  async deliver(agent: Agent, request: DeliveryRequest): Promise<MessageId> {
    this.lifetime.signal.throwIfAborted()
    const delivery = (this.deliveries.get(agent) ?? Promise.resolve()).then(() => this.run(agent, request))
    const settled = delivery.then(() => undefined, () => undefined)
    this.deliveries.set(agent, settled)
    this.pending.add(settled)
    void settled.then(() => { this.pending.delete(settled) })
    return await untilCancelled(delivery, request.signal)
  }

  private async run(agent: Agent, request: DeliveryRequest): Promise<MessageId> {
    const signal = AbortSignal.any([request.signal, this.lifetime.signal])
    signal.throwIfAborted()
    this.requireRegistered(agent)
    const content = await request.prepare(signal)
    signal.throwIfAborted()
    const message = createUserMessage({ content, source: request.source })
    let decision: AdmissionDecision
    try {
      decision = await agentEvents(this.ctx, agent)
        .waterfall('agent-controller/admission', { message, signal }, () => Promise.resolve(ADMIT))
    } catch (error: unknown) {
      // A listener interrupted by cancellation reports the cancellation, not a failed check.
      signal.throwIfAborted()
      throw new AgentAdmissionRejected(ADMISSION_FAILED, `The message was not admitted: ${String(error)}`, false, { cause: error })
    }
    signal.throwIfAborted()
    if (decision.kind === 'reject') throw new AgentAdmissionRejected(decision.reason, decision.message, decision.presented)
    this.requireRegistered(agent)
    request.beforeInsert?.(message)
    if (request.mode === 'steer') agent.steer(message)
    else agent.followup(message)
    return message.id
  }

  /** Keep a message out of an Agent that is no longer the registered one for its id. */
  private requireRegistered(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) === agent) return
    throw new AgentAdmissionRejected(ADMISSION_AGENT_GONE, `Agent "${agent.id}" left before its message entered the inbox.`, false)
  }
}

export default AgentController
