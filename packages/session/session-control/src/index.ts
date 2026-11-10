/**
 * Session control service: true Agent attribution, target serialization, and provider lifetime.
 * @module @deepseek-ai/dsh-session-control
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionControlError } from './error.ts'
import { createAgentMessage } from './message.ts'
import type {
  SessionAgentContentRequest, SessionControlContext, SessionControlProvider,
  SessionDeliveryRequest, SessionMessageReceipt, SessionMessageRequest, SessionTreeDelivery,
} from './types.ts'

export { SessionControlError, type SessionControlErrorCode } from './error.ts'
export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionControl: SessionControlService
  }
}

interface Registration<Provider> {
  readonly provider: Provider
  readonly lifetime: AbortController
  readonly pending: Set<Promise<unknown>>
}

/** Shared acceptance service; providers retain their own restoration and closing rules. */
export class SessionControlService extends Service {
  static inject = ['agents']
  private provider?: Registration<SessionControlProvider>
  private tree?: Registration<SessionTreeDelivery>
  private readonly targets = new Map<SessionId, Promise<unknown>>()

  constructor(ctx: Context) {
    super(ctx, 'sessionControl')
  }

  /**
   * Register the independent-Session provider. Unload cancels and drains pending calls.
   * @param provider - local or alternative implementation of independent-Session delivery.
   * @returns the effect disposer; a replacement may register after it completes.
   */
  register(provider: SessionControlProvider): () => Promise<void> {
    return this.install('provider', provider)
  }

  /**
   * Register the existing subagent manager's private delivery capability.
   * @param provider - tree naming, authority, restoration, and acceptance owned by that manager.
   * @returns the effect disposer, which cancels and drains calls before releasing the capability.
   */
  registerTreeDelivery(provider: SessionTreeDelivery): () => Promise<void> {
    return this.install('tree', provider)
  }

  /**
   * Send text to an independent Session, returning once its inbox accepts the message.
   * Running targets process it at the next input opportunity; idle targets start a turn.
   * @param request - target Session id and nonblank text.
   * @param runtime - real caller and cancellation before acceptance.
   * @returns the accepted message id; no reply is awaited.
   */
  async sendMessage(request: SessionMessageRequest, runtime: SessionControlContext): Promise<SessionMessageReceipt> {
    if (request.message.trim().length === 0) {
      throw new SessionControlError('message must contain non-whitespace text', 'SESSION_CONTROL_INVALID_MESSAGE')
    }
    this.assertCaller(runtime)
    return this.dispatch(this.require(this.provider), {
      id: request.id,
      message: createAgentMessage(runtime.caller, runtime.caller.id, [{ type: 'text', text: request.message }]),
    }, runtime)
  }

  /**
   * Deliver existing subagent content under the manager's tree authority.
   * @param request - target and existing content-block representation.
   * @param runtime - exact sending Agent and pre-acceptance cancellation.
   * @returns the accepted message identity, preserving subagent lifecycle bookkeeping.
   */
  async sendAgentContent(request: SessionAgentContentRequest, runtime: SessionControlContext): Promise<SessionMessageReceipt> {
    this.assertCaller(runtime)
    const registration = this.require(this.tree)
    return this.dispatch(registration, {
      id: request.id,
      message: createAgentMessage(runtime.caller, registration.provider.senderName(runtime.caller), request.content),
    }, runtime)
  }

  private require<Provider>(registration: Registration<Provider> | undefined): Registration<Provider> {
    if (registration === undefined || registration.lifetime.signal.aborted) {
      throw new SessionControlError('Session delivery provider is unavailable', 'SESSION_CONTROL_UNAVAILABLE')
    }
    return registration
  }

  private assertCaller(runtime: SessionControlContext): void {
    runtime.signal.throwIfAborted()
    if (this.ctx.agents.get(runtime.caller.id) !== runtime.caller) {
      throw new SessionControlError('the sending Agent is no longer live', 'SESSION_CONTROL_CALLER_UNAVAILABLE')
    }
  }

  private dispatch(
    registration: Registration<SessionControlProvider>, request: SessionDeliveryRequest, runtime: SessionControlContext,
  ): Promise<SessionMessageReceipt> {
    const signal = AbortSignal.any([runtime.signal, registration.lifetime.signal])
    const context = { caller: runtime.caller, signal }
    const previous = this.targets.get(request.id) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(() => {
      this.assertCaller(context)
      return registration.provider.deliver(request, context)
    })
    this.targets.set(request.id, operation)
    registration.pending.add(operation)
    const settled = (): void => {
      registration.pending.delete(operation)
      if (this.targets.get(request.id) === operation) this.targets.delete(request.id)
    }
    void operation.then(settled, settled)
    return operation
  }

  private install(key: 'provider', provider: SessionControlProvider): () => Promise<void>
  private install(key: 'tree', provider: SessionTreeDelivery): () => Promise<void>
  private install(key: 'provider' | 'tree', provider: SessionControlProvider | SessionTreeDelivery): () => Promise<void> {
    if (this[key] !== undefined) {
      throw new SessionControlError('a Session delivery provider is already registered', 'SESSION_CONTROL_UNAVAILABLE')
    }
    const registration = { provider, lifetime: new AbortController(), pending: new Set<Promise<unknown>>() }
    return this.ctx.effect(() => {
      if (key === 'tree') this.tree = { ...registration, provider: provider as SessionTreeDelivery }
      else this.provider = registration
      return async () => {
        registration.lifetime.abort(new DOMException('Session delivery provider unloaded', 'AbortError'))
        await Promise.allSettled([...registration.pending])
        if (key === 'tree') delete this.tree
        else delete this.provider
      }
    })
  }
}

export default SessionControlService
