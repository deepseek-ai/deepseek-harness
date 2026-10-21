import type { Context } from '@deepseek-ai/cordis'
import type {
  ContextMessageNode, ConversationContextReader, ConversationLocation, ConversationNodeDefinition,
  SteeringMessageNode, UserMessageNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { isAppendSurfaceEvent, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import type { InboxState } from './inbox.ts'
import type { ProcessEvidenceState } from './turn-process.ts'
import { chatNode, contextLocation } from './common.ts'
import { contextForm, contextProducer } from './event-projection.ts'

interface ReferencedUserMessageNode extends UserMessageNode {
  /** Labels cited by the immediately following session-reference context. */
  readonly referenceLabels?: readonly string[]
  /** Skill names the same step's `skill-invocation` injections loaded. */
  readonly skillNames?: readonly string[]
}

interface ReferencedSteeringMessageNode extends SteeringMessageNode {
  /** Labels cited by the immediately following session-reference context. */
  readonly referenceLabels?: readonly string[]
  /** Skill names the same step's `skill-invocation` injections loaded. */
  readonly skillNames?: readonly string[]
  /**
   * First human message of its `next-step` claim that Chat orders after its Turn's process control;
   * the row keeps the Turn tail slot above it.
   */
  readonly batchStart?: true
}

type MessageNode = ReferencedUserMessageNode | ReferencedSteeringMessageNode | (ContextMessageNode & { readonly waking?: boolean })

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Ordinary turn-opening user message. */
    user: ReferencedUserMessageNode
    /** User message admitted into an active turn. */
    steering: ReferencedSteeringMessageNode
    /** Non-user context injected into model history. */
    context: ContextMessageNode
    /** Non-human input that starts a Turn. */
    'turn-trigger': ContextMessageNode
  }
}

function isCompactionCheckpoint(event: Parameters<ConversationNodeDefinition['match']>[0]): boolean {
  if (event.type !== 'user/message' || !isReplacementSurfaceEvent(event)) return false
  const source = event.data.source as { kind?: unknown }
  return source.kind === 'compact-checkpoint'
}

/** Context presentation shared by user-role injections and developer messages. */
function contextMessage(
  event: Pick<ContextMessageNode, 'seq' | 'time'>,
  message: Pick<ContextMessageNode, 'content' | 'source'>,
): ContextMessageNode {
  return {
    kind: 'context',
    seq: event.seq,
    time: event.time,
    content: message.content,
    source: message.source,
    producer: contextProducer(message.source),
    form: contextForm(message.source),
  }
}

/**
 * Decide whether an input follows its Turn's process control in Chat order. The control anchors at the
 * Turn's first process evidence, so the input follows it exactly when its Turn recorded evidence earlier;
 * the nearest earlier evidence record then belongs to the input's own Turn.
 * @param location - the input's Location.
 * @param reader - strictly-backward Context lookup of the input's start.
 * @returns whether Chat orders the input after the control.
 */
function followsProcessEvidence(location: ConversationLocation, reader: ConversationContextReader): boolean {
  if (location.kind !== 'turn' && location.kind !== 'step') return false
  return reader.previous<ProcessEvidenceState>('process-evidence')?.state.turn === location.turn.turn
}

/** User, steering, and injected-context message classification Definition. */
export const messageDefinition: ConversationNodeDefinition<MessageNode> = {
  kind: 'input-message',
  target: 'chat',
  match: (event) => {
    if (event.type === 'user/message') {
      return isAppendSurfaceEvent(event) && !isCompactionCheckpoint(event)
        ? { id: String(event.data.id), role: 'start' }
        : null
    }
    return null
  },
  start: (_context, match, reader) => {
    const event = match.event
    if (event.type !== 'user/message') throw new Error('input-message start requires user/message')
    if (event.data.source.kind !== 'user') {
      const nextTurn = reader.previous<InboxState>('inbox-next-turn')?.state
      const nextStep = reader.previous<InboxState>('inbox-next-step')?.state
      const location = match.location
      const turnStart = location.kind === 'step' ? location.turn.start?.seq : undefined
      // An idle steer opens Step 1 without a next-turn claim in this Turn.
      // A human in that same next-step claim owns the opening instead of its notices.
      const idleSteer = location.kind === 'step' && location.step.step === 1
        && turnStart !== undefined && (nextStep?.claimSeq ?? -1) > turnStart
        && (nextTurn?.claimSeq ?? -1) < turnStart && nextStep !== undefined
        && nextStep.firstClaimedHuman === undefined && nextStep.currentClaimed.has(String(event.data.id))

      return {
        ...contextMessage(event, event.data),
        waking: nextTurn?.currentClaimed.has(String(event.data.id)) === true || idleSteer,
      }
    }
    const id = String(event.data.id)
    const claim = reader.previous<InboxState>('inbox-next-step')?.state
    return claim?.currentClaimed.has(id) === true
      ? {
        kind: 'steering',
        messageId: event.data.id,
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
        ...claim.firstClaimedHuman === id && followsProcessEvidence(match.location, reader)
          ? { batchStart: true }
          : {},
      }
      : {
        kind: 'user',
        messageId: event.data.id,
        seq: event.seq,
        time: event.time,
        content: event.data.content,
        source: event.data.source,
      }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    const waking = context.state.kind === 'context'
      && context.start?.event.type === 'user/message'
      && context.state.waking === true
    // Human input claimed for Step 1 opens an exchange; Notice-woken Turns and
    // later steering stay in the current exchange, so they never fold earlier Turns.
    const location = contextLocation(context)
    const human = context.state.kind === 'user' || context.state.kind === 'steering'
    const opensExchange = human && location.kind === 'step' && location.step.step === 1
    return chatNode(
      context,
      waking ? 'turn-trigger' : context.state.kind,
      context.state.seq,
      context.state,
      { location, groupTree: opensExchange ? 'exchange' : (human || waking) ? 'input' : undefined },
    )
  },
}

/** Developer history uses the input-message lifecycle and context presentation. */
export const developerMessageDefinition: ConversationNodeDefinition<MessageNode> = {
  ...messageDefinition,
  kind: 'developer-message',
  match: event => event.type === 'developer/message'
    ? { id: String(event.data.message.id), role: 'start' }
    : null,
  start: (_context, match) => {
    const event = match.event
    if (event.type !== 'developer/message') throw new Error('developer-message start requires developer/message')
    return contextMessage(event, event.data.message)
  },
}

/**
 * Register user, steering, injected-context, and developer message contributions.
 * @param ctx - owning UI Conversation context.
 */
export function registerMessageConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(messageDefinition)
  ctx.uiConversation.events.register(developerMessageDefinition)
}
