/**
 * Driver-owned durable agent inbox projection and command facade.
 *
 * @module @deepseek-ai/dsh-agent-loop/inbox
 */

import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { Session, SessionEvent, SessionEventMap, UserMessage } from '@deepseek-ai/dsh-session'
import type {
  AgentEventDispatch,
  Inbox as InboxContract,
  InboxState,
  InboxTarget,
  InboxWireState,
} from '@deepseek-ai/dsh-agent'
import { z } from 'zod'

const messages = z.array(z.custom<UserMessage>(
  value => typeof value === 'object' && value !== null && typeof Reflect.get(value, 'id') === 'string',
)).readonly()

const inboxProjectionSchema = z.object({
  'next-turn': messages,
  'next-step': messages,
}).readonly()

/** Claims for an unopened step: the current batch, and the batch an interrupted turn left behind. */
const inboxClaimSchema = z.object({
  pending: messages,
  interrupted: messages,
}).readonly()

/** `queues` is the wire view; one object lets the view reuse its reference across claim-only changes. */
const inboxStateSchema = z.object({
  queues: inboxProjectionSchema,
  claim: inboxClaimSchema,
}).readonly()

/** Pending queues and the claims for an unopened step. */
export type InboxProjectionState = z.infer<typeof inboxStateSchema>

type InboxSplice = SessionEventMap['agent/inbox/spliced']

/** Apply a normalized splice and check message identities across both queues. */
function spliceQueue(inbox: InboxState, splice: InboxSplice, removedCount: number) {
  const { target, start, inserted } = splice
  const queue = inbox[target].slice()
  const removed = queue.splice(start, removedCount, ...inserted)
  const queues = { ...inbox, [target]: queue }
  const ids = new Set<MessageId>()
  for (const pending of [queues['next-turn'], queues['next-step']]) {
    for (const { id } of pending) {
      if (ids.has(id)) throw new Error(`message "${id}" is already pending`)
      ids.add(id)
    }
  }
  return { queues, removed }
}

function foldInboxSplice(state: InboxProjectionState, event: SessionEvent<'agent/inbox/spliced'>): InboxProjectionState {
  const { data: splice, seq } = event
  try {
    const { start, target, inserted, outcome } = splice
    const removedCount = splice.removedCount ?? 0
    const length = state.queues[target].length
    if (!Number.isSafeInteger(start) || start < 0 || start > length
      || !Number.isSafeInteger(removedCount) || removedCount < 0 || start + removedCount > length) {
      throw new Error('invalid inbox splice')
    }
    const { queues, removed } = spliceQueue(state.queues, splice, removedCount)
    if (removed.length === 0) return { ...state, queues }
    const { claim } = state
    // A removal without an outcome records a claim.
    if (outcome !== 'canceled') {
      return { queues, claim: { ...claim, pending: [...claim.pending, ...removed] } }
    }

    const discarded = new Set(removed.map(message => message.id))
    for (const { id } of inserted) discarded.delete(id)
    const keep = (message: UserMessage) => !discarded.has(message.id)
    return { queues, claim: { pending: claim.pending.filter(keep), interrupted: claim.interrupted.filter(keep) } }
  } catch (error: unknown) {
    throw new Error(`invalid persisted inbox splice at session seq ${seq}`, { cause: error })
  }
}

/** The Session log stores losslessly serializable messages. Reuse the queue object for wire change detection. */
function toInboxWireState(state: InboxState): InboxWireState {
  return state as unknown as InboxWireState
}

/** Reconstruct the queues and claim settlement from the same validated splices. */
export const inboxProjectionDefinition = {
  key: 'inbox',
  stateSchema: inboxStateSchema,
  init: (): InboxProjectionState => ({
    queues: { 'next-turn': [], 'next-step': [] },
    claim: { pending: [], interrupted: [] },
  }),
  apply(state: InboxProjectionState, event): InboxProjectionState {
    switch (event.type) {
      case 'agent/inbox/spliced':
        return foldInboxSplice(state, event)
      case 'step/start':
        if (state.claim.pending.length === 0) return state
        return { ...state, claim: { ...state.claim, pending: [] } }
      case 'turn/end': {
        const { pending, interrupted } = state.claim
        if (pending.length === 0 && interrupted.length === 0) return state
        return { ...state, claim: { pending: [], interrupted: event.data.reason.kind === 'interrupted' ? pending : [] } }
      }
      case 'session/end-seed': {
        // A fork inherits its parent's queue, never a claim the parent's turn left unopened.
        const { pending, interrupted } = state.claim
        if (event.data.inherited !== true || (pending.length === 0 && interrupted.length === 0)) return state
        return { ...state, claim: { pending: [], interrupted: [] } }
      }
      default:
        // Other Session events leave the inbox unchanged.
        return state
    }
  },
  wire: {
    viewSchema: inboxProjectionSchema as unknown as z.ZodType<InboxWireState>,
    view: ({ queues }) => toInboxWireState(queues),
  },
  stateVersion: 3,
} satisfies ProjectionDefinition<'inbox', InboxProjectionState>

/**
 * Driver-owned durable Inbox implementation used by ReactLoopAgent and focused
 * provider tests.
 * @param readState - reader for the live Inbox projection state.
 * @param session - session whose durable events store pending input.
 * @param dispatch - agent-scoped notifications for Inbox lifecycle events.
 */
export class ReactLoopInbox implements InboxContract {
  /** Whether {@link clear} discarded the batch taken by the latest {@link claim}. */
  private claimDiscarded = false

  constructor(
    private readonly readState: () => InboxProjectionState,
    private readonly session: Session,
    private readonly dispatch: AgentEventDispatch,
  ) {}

  /** Prompts awaiting individual turns. */
  get nextTurn(): readonly UserMessage[] {
    return this.readState().queues['next-turn']
  }

  /** Input awaiting the next step boundary. */
  get nextStep(): readonly UserMessage[] {
    return this.readState().queues['next-step']
  }

  /**
   * Return the batch claimed for an unopened step to the next-turn head when
   * the turn ends before `step/start`, unless {@link clear} discarded it.
   * Call before `turn/end` settles the claim.
   * @throws when the Session refuses the return; the claim stays settled by `turn/end`.
   */
  returnClaims(): void {
    if (!this.claimDiscarded) this.returnClaim('pending')
  }

  /** Return the claim an interrupted turn left for an unopened step; a no-op after a completed turn. */
  restoreInterrupted(): void {
    this.returnClaim('interrupted')
  }

  /** Prepend one claim list in order, skipping any occurrence already queued. */
  private returnClaim(source: keyof InboxProjectionState['claim']): void {
    const state = this.readState()
    const claims = state.claim[source]
    if (claims.length === 0) return
    const queued = new Set([...state.queues['next-turn'], ...state.queues['next-step']].map(message => message.id))
    this.splice('next-turn', 0, 0, claims.filter(message => !queued.has(message.id)))
  }

  /** Whether either pending-message list contains work. */
  get hasPending(): boolean {
    const { queues } = this.readState()
    return queues['next-turn'].length > 0 || queues['next-step'].length > 0
  }

  /** Durably cancel all pending input, clearing next-step before next-turn. */
  clear(): void {
    this.claimDiscarded = true
    this.splice('next-step', 0, this.nextStep.length, [])
    this.splice('next-turn', 0, this.nextTurn.length, [])
  }

  /**
   * Remove and return the complete batch proposed for one step.
   * @param target - whether this boundary also consumes one queued turn.
   * @param turn - turn that will own the claimed batch.
   * @returns next-step input followed by the queued turn, when requested.
   */
  claim(target: InboxTarget, turn: number): UserMessage[] {
    this.claimDiscarded = false
    const claimed = this.mutate('next-step', 0, this.nextStep.length, [], false)
    if (target === 'next-turn') claimed.push(...this.mutate('next-turn', 0, 1, [], false))
    for (const message of claimed) this.dispatch.emit('agent/inbox/claimed', { message, turn })
    return claimed
  }

  /**
   * Append one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to append.
   */
  append(target: InboxTarget, message: UserMessage): void {
    this.splice(target, this.readState().queues[target].length, 0, [message])
  }

  /**
   * Prepend one message to a pending list.
   * @param target - pending list to extend.
   * @param message - message to prepend.
   */
  prepend(target: InboxTarget, message: UserMessage): void {
    this.splice(target, 0, 0, [message])
  }

  /**
   * Replace one pending message in place.
   * @param messageId - identity of the pending message to replace.
   * @param newMessage - replacement message.
   * @returns whether the message was still pending.
   */
  replace(messageId: MessageId, newMessage: UserMessage): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [newMessage])
    return true
  }

  /**
   * Remove one pending message.
   * @param messageId - identity of the pending message to remove.
   * @returns whether the message was still pending.
   */
  remove(messageId: MessageId): boolean {
    const location = this.locate(messageId)
    if (location === undefined) return false
    this.splice(location.target, location.index, 1, [])
    return true
  }

  /**
   * Apply standard splice semantics and durably record the normalized result.
   * @param target - pending list to mutate.
   * @param start - splice position.
   * @param deleteCount - maximum number of messages to remove.
   * @param inserted - messages to insert at the resolved position.
   * @returns messages removed by the splice.
   */
  splice(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
  ): UserMessage[] {
    return this.mutate(target, start, deleteCount, inserted, true)
  }

  /** Locate one pending identity across both owned lists. */
  private locate(messageId: MessageId): { target: InboxTarget; index: number } | undefined {
    const { queues } = this.readState()
    for (const target of ['next-turn', 'next-step'] as const) {
      const index = queues[target].findIndex(message => message.id === messageId)
      if (index >= 0) return { target, index }
    }
    return undefined
  }

  /** Commit one normalized mutation and publish its live events. */
  private mutate(
    target: InboxTarget,
    start: number,
    deleteCount: number,
    inserted: UserMessage[],
    discardRemoved: boolean,
  ): UserMessage[] {
    const { queues } = this.readState()
    const inbox = queues[target]
    const truncatedStart = Math.trunc(start)
    const offset = Number.isNaN(truncatedStart) ? 0 : truncatedStart
    const actualStart = offset < 0
      ? Math.max(inbox.length + offset, 0)
      : Math.min(offset, inbox.length)
    const truncatedDeleteCount = Math.trunc(deleteCount)
    const actualDeleteCount = Math.min(
      Math.max(Number.isNaN(truncatedDeleteCount) ? 0 : truncatedDeleteCount, 0),
      inbox.length - actualStart,
    )
    if (actualDeleteCount === 0 && inserted.length === 0) return []
    const outcome = discardRemoved && actualDeleteCount > 0 ? 'canceled' as const : undefined
    const splice: InboxSplice = {
      target,
      start: actualStart,
      ...(actualDeleteCount === 0 ? {} : { removedCount: actualDeleteCount }),
      inserted,
      ...(outcome === undefined ? {} : { outcome }),
    }
    const { removed } = spliceQueue(queues, splice, actualDeleteCount)
    const event = this.session.append('agent/inbox/spliced', splice)
    if (discardRemoved) {
      for (const message of removed) this.dispatch.emit('agent/inbox/discarded', { message })
    }
    for (const message of event.data.inserted) {
      this.dispatch.emit('agent/inbox/inserted', { message })
    }
    return removed
  }
}
