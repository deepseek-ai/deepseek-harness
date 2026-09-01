import type { Context } from '@deepseek-ai/cordis'
import type {
  ContextMessageNode, ConversationNodeDefinition, ConversationPreviousContext,
  SteeringMessageNode, UserMessageNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-agent/types'
import { trajectoryNode } from './trajectory-definition-common.ts'
import { contextForm, contextProvenance } from './trajectory-event-projection.ts'

/* jscpd:ignore-start -- Target-owned Definitions intentionally keep their event
 * state machines independent; see ../../../../../.agents/notes/implemented/
 * architecture/2026-08-09-client-conversation-node-assembly.md. */
interface InboxIdentity {
  readonly id: string
}

interface InboxSplice {
  readonly start: number
  readonly removedCount?: number
  readonly inserted: readonly InboxIdentity[]
  readonly outcome?: 'canceled'
}

interface PendingSnapshot {
  readonly kind: 'snapshot'
  readonly ids: readonly string[]
}

interface PendingSplice {
  readonly kind: 'splice'
  readonly previous: PendingState
  readonly start: number
  readonly removedCount: number
  readonly inserted: readonly string[]
}

type PendingState = PendingSnapshot | PendingSplice

interface InboxState {
  /** Persistent splice chain materialized only when a next-step batch is claimed. */
  readonly pending: PendingState
  /** Message ids in the current claim, shared until the next claim. */
  readonly currentClaimed: ReadonlySet<string>
}

type MessageNode = UserMessageNode | SteeringMessageNode | ContextMessageNode

const EMPTY_PENDING: PendingState = { kind: 'snapshot', ids: [] }
const EMPTY_CURRENT_CLAIMED: ReadonlySet<string> = new Set()

function materializePending(state: PendingState): string[] {
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
  inserted: readonly string[],
): ReadonlySet<string> {
  let next: Set<string> | undefined
  for (const id of inserted) {
    if (!claimed.has(id)) continue
    next ??= new Set(claimed)
    next.delete(id)
  }
  return next ?? claimed
}

/**
 * Apply one next-step splice under the AgentLoop's durable event ordering.
 * An entered claim logs its complete message batch before another claim; a
 * rejected claim logs no messages, so only the current claim can classify a
 * later `user/message`.
 */
function applySplice(
  previous: ConversationPreviousContext<InboxState> | undefined,
  splice: InboxSplice,
): InboxState {
  const priorPending = previous?.state.pending ?? EMPTY_PENDING
  const inserted = splice.inserted.map(identity => identity.id)
  const removedCount = splice.removedCount ?? 0
  if (removedCount > 0 && splice.outcome !== 'canceled') {
    const pending = materializePending(priorPending)
    const removed = pending.splice(splice.start, removedCount, ...inserted)
    return {
      pending: { kind: 'snapshot', ids: pending },
      currentClaimed: new Set(removed),
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
  }
}

const trajectoryInboxDefinition: ConversationNodeDefinition<InboxState> = {
  kind: 'trajectory-inbox-next-step',
  match: (event) => {
    if (event.type === 'agent/inbox/spliced' && event.data.target === 'next-step') {
      return { id: String(event.seq), role: 'start' }
    }
    return null
  },
  start: (_context, match, reader) => {
    if (match.event.type !== 'agent/inbox/spliced') {
      throw new Error('trajectory-inbox-next-step start requires agent/inbox/spliced')
    }
    return applySplice(
      reader.previous<InboxState>('trajectory-inbox-next-step'),
      match.event.data,
    )
  },
  update: context => context.state,
  publication: () => 'none',
}

const trajectoryMessageDefinition: ConversationNodeDefinition<MessageNode> = {
  kind: 'trajectory-input-message',
  target: 'trajectory',
  match: event => event.type === 'user/message'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match, reader) => {
    if (match.event.type !== 'user/message') {
      throw new Error('trajectory-input-message start requires user/message')
    }
    const event = match.event
    if (event.data.source.kind !== 'user') {
      return {
        kind: 'context',
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
        provenance: contextProvenance(event.data.source),
        form: contextForm(event.data.source),
      }
    }
    const claimed = reader.previous<InboxState>('trajectory-inbox-next-step')
      ?.state.currentClaimed.has(String(event.data.id)) === true
    return claimed
      ? {
        kind: 'steering',
        messageId: event.data.id,
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
      }
      : {
        kind: 'user',
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
      }
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : trajectoryNode(context, context.state.seq, { kind: 'node', node: context.state }),
}
/* jscpd:ignore-end */

/**
 * Register Trajectory-owned inbox classification and message records.
 *
 * @param ctx - Plugin context receiving the Definitions.
 */
export function registerTrajectoryMessageDefinitions(ctx: Context): void {
  ctx.uiConversation.events.register(trajectoryInboxDefinition)
  ctx.uiConversation.events.register(trajectoryMessageDefinition)
}
