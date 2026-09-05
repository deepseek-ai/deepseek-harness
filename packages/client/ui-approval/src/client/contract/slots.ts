/** Approval composer and optional correlated-detail contracts. */
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  PropsLocale, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { ApprovalKey } from '../locales.ts'

/* jscpd:ignore-start -- Approval and Question intentionally own independent pending-settlement lifecycles. */
function settlePendingComposer(settle: () => void, failureMessage: string): Promise<void> {
  try {
    settle()
    return Promise.resolve()
  } catch (error) {
    return Promise.reject(error instanceof Error
      ? error
      : new Error(failureMessage, { cause: error }))
  }
}
/* jscpd:ignore-end */

declare module '@deepseek-ai/dsh-client-ui-session/client' {
  interface SessionPendingInteractionMap {
    /** Pending approval request. */
    approval: PendingApproval
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Approval prompt copy. */
    approval: ApprovalKey
  }

  interface SlotMap {
    /** Optional detail for the Tool call correlated with an approval request. */
    'conversation.approval.detail': {
      kind: 'single'
      scope: 'session'
      owner: ApprovalDetailOwnerProps
    }
  }
}

/** Stable identity handed to an optional approval-detail renderer. */
export interface ApprovalDetailOwnerProps {
  /** Tool call correlated with the request. */
  callId: ToolCallId
}

/** Client-visible fields of an approval request projected through Remote Events. */
export interface ApprovalPresentationRequest {
  /** Tool requesting the decision. */
  readonly toolName: string
  /** Tool call correlated with the request. */
  readonly callId?: ToolCallId
  /** Human-readable reason supplied by the requester. */
  readonly reason?: string
  /** Cancellation projected from the Host waterfall. */
  readonly signal?: AbortSignal
}

/** Decisions this interactive Client presentation can return. */
export type ApprovalDecision = 'allowed-once' | 'rejected'

let nextApprovalKey = 0

/** One answerable Client presentation of a pending Host waterfall. */
export class PendingApproval {
  /** Domain discriminator used by Session pending-interaction consumers. */
  readonly kind: 'approval'
  /** Opaque render identity and one-shot remount axis. */
  readonly key: string
  /** Tool requesting the decision. */
  readonly toolName: string
  /** Correlated Tool call, when supplied by the asker. */
  readonly callId: ToolCallId | undefined
  /** Human-readable reason supplied by the asker. */
  readonly reason: string | undefined
  /** Result returned by the Remote Event listener to the Host waterfall. */
  readonly result: Promise<ApprovalDecision>

  readonly #resolve: (outcome: ApprovalDecision) => void
  readonly #reject: (reason: unknown) => void
  readonly #signal: AbortSignal | undefined
  readonly #onAbort: (() => void) | undefined
  readonly #delegated = Symbol('pending approval delegated')
  #settled = false

  /**
   * @param sessionId - Agent/Session identity owning the scoped request.
   * @param request - Host approval request projected through the Remote Event.
   */
  constructor(readonly sessionId: SessionId, request: ApprovalPresentationRequest) {
    this.kind = 'approval'
    nextApprovalKey += 1
    this.key = `approval:${String(nextApprovalKey)}`
    this.toolName = request.toolName
    this.callId = request.callId
    this.reason = request.reason
    const completion = Promise.withResolvers<ApprovalDecision>()
    this.result = completion.promise
    this.#resolve = completion.resolve
    this.#reject = completion.reject
    this.#signal = request.signal
    if (request.signal === undefined) {
      this.#onAbort = undefined
      return
    }
    const onAbort = (): void => {
      this.abort(request.signal?.reason ?? new Error('approval request was aborted'))
    }
    this.#onAbort = onAbort
    request.signal.addEventListener('abort', onAbort, { once: true })
    if (request.signal.aborted) onAbort()
  }

  /**
   * Resolve the Host waterfall with the user's decision.
   * @param outcome - supported interactive decision.
   */
  answer(outcome: ApprovalDecision): Promise<void> {
    return settlePendingComposer(() => {
      this.finish(() => { this.#resolve(outcome) })
    }, 'pending approval settlement failed')
  }

  /** Delegate an unanswered request to the next waterfall listener. */
  delegate(): void {
    if (this.#settled) return
    this.finish(() => { this.#reject(this.#delegated) })
  }

  /**
   * Test whether a rejection requests waterfall delegation.
   * @param reason - rejection received from {@link PendingApproval.result}.
   * @returns whether {@link PendingApproval.delegate} produced it.
   */
  isDelegation(reason: unknown): boolean {
    return reason === this.#delegated
  }

  /**
   * End an unanswered presentation when its transport, scope, or plugin lifetime ends.
   * @param reason - rejection exposed to the waiting Remote Event listener.
   */
  abort(reason: unknown): void {
    if (this.#settled) return
    this.finish(() => { this.#reject(reason) })
  }

  private finish(settle: () => void): void {
    if (this.#settled) throw new Error(`pending approval ${this.key} is already settled`)
    this.#settled = true
    if (this.#signal !== undefined && this.#onAbort !== undefined) {
      this.#signal.removeEventListener('abort', this.#onAbort)
    }
    settle()
  }
}

/** Full props of the approval composer takeover. */
export type ApprovalComposerProps =
  PropsRuntime<'conversation.composer'>
  & PropsRenderSlots<'conversation.approval.detail'>
  & { matched: PendingApproval }
  & PropsLocale<'approval'>
