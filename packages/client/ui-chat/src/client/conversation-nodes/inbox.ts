import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationNodeDefinition, ConversationPreviousContext,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

interface InboxIdentity {
  readonly id: string
  readonly source: { readonly kind: string }
}

interface InboxSplice {
  readonly start: number
  readonly removedCount?: number
  readonly inserted: readonly InboxIdentity[]
  readonly outcome?: 'canceled'
}

interface PendingSnapshot {
  readonly kind: 'snapshot'
  readonly ids: readonly InboxIdentity[]
}

interface PendingSplice {
  readonly kind: 'splice'
  readonly previous: PendingState
  readonly start: number
  readonly removedCount: number
  readonly inserted: readonly InboxIdentity[]
}

type PendingState = PendingSnapshot | PendingSplice

/** Persistent Inbox state after one durable Inbox splice. */
export interface InboxState {
  /** Persistent splice chain materialized only when a batch is claimed. */
  readonly pending: PendingState
  /** Message ids in the current claim, shared until the next claim. */
  readonly currentClaimed: ReadonlySet<string>
  readonly claimSeq: number
  readonly claimedHuman: boolean
}

const EMPTY_PENDING: PendingState = { kind: 'snapshot', ids: [] }
const EMPTY_CURRENT_CLAIMED: ReadonlySet<string> = new Set()

function materializePending(state: PendingState): InboxIdentity[] {
  const splices: PendingSplice[] = []
  let current = state
  while (current.kind === 'splice') {
    splices.push(current)
    current = current.previous
  }
  const pending = [...current.ids]
  for (const splice of splices.reverse()) {
    pending.splice(splice.start, splice.removedCount, ...splice.inserted)
  }
  return pending
}

function withoutInserted(
  claimed: ReadonlySet<string>,
  inserted: readonly InboxIdentity[],
): ReadonlySet<string> {
  let next: Set<string> | undefined
  for (const { id } of inserted) {
    if (!claimed.has(id)) continue
    next ??= new Set(claimed)
    next.delete(id)
  }
  return next ?? claimed
}

/**
 * Apply one Inbox splice under the AgentLoop's durable event ordering.
 * An entered claim logs its complete message batch before another claim; a
 * rejected claim logs no messages, so only the current claim can classify a
 * later `user/message`.
 */
function applySplice(
  previous: ConversationPreviousContext<InboxState> | undefined,
  splice: InboxSplice,
  seq: number,
): InboxState {
  const priorPending = previous?.state.pending ?? EMPTY_PENDING
  const inserted = splice.inserted
  const removedCount = splice.removedCount ?? 0
  if (removedCount > 0 && splice.outcome !== 'canceled') {
    const pending = materializePending(priorPending)
    const removed = pending.splice(splice.start, removedCount, ...inserted)
    return {
      pending: { kind: 'snapshot', ids: pending },
      currentClaimed: new Set(removed.map(message => message.id)),
      claimSeq: seq,
      claimedHuman: removed.some(message => message.source.kind === 'user'),
    }
  }
  const currentClaimed = withoutInserted(
    previous?.state.currentClaimed ?? EMPTY_CURRENT_CLAIMED,
    inserted,
  )
  return {
    pending: {
      kind: 'splice',
      previous: priorPending,
      start: splice.start,
      removedCount,
      inserted,
    },
    currentClaimed,
    claimSeq: previous?.state.claimSeq ?? -1,
    claimedHuman: previous?.state.claimedHuman ?? false,
  }
}

function inboxDefinition(target: 'next-step' | 'next-turn'): ConversationNodeDefinition<InboxState> {
  const kind = `inbox-${target}`
  return {
    kind,
    match: event => event.type === 'agent/inbox/spliced' && event.data.target === target
      ? { id: String(event.seq), role: 'start' } : null,
    start: (_context, match, reader) => {
      if (match.event.type !== 'agent/inbox/spliced') throw new Error('inbox start requires agent/inbox/spliced')
      return applySplice(reader.previous<InboxState>(kind), match.event.data, match.event.seq)
    },
    update: context => context.state,
    publication: () => 'none',
  }
}

/** Persistent next-step claims identify messages admitted into a running Turn. */
export const nextStepInboxDefinition = inboxDefinition('next-step')

/** Persistent next-turn claims identify messages that wake a new Turn. */
export const nextTurnInboxDefinition = inboxDefinition('next-turn')

/**
 * Register the Inbox state used by Chat message classification.
 * @param ctx - owning UI Conversation context.
 */
export function registerInboxConversationNodes(ctx: Context): void {
  ctx.uiConversation.events.register(nextStepInboxDefinition)
  ctx.uiConversation.events.register(nextTurnInboxDefinition)
}
