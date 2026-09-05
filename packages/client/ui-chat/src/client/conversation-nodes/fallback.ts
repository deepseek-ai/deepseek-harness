import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationNodeDefinition, UnknownSurfaceNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import { chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Generic presentation of an unclaimed append-surface event. */
    unknown: UnknownSurfaceNode
  }
}

/** Unclaimed append-surface fallback Definition. */
export const unknownFallbackDefinition: ConversationNodeDefinition<UnknownSurfaceNode> = {
  kind: 'unknown-surface',
  target: 'chat',
  match: event => event.type !== 'assistant/live-chunk' && isAppendSurfaceEvent(event)
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match) => ({
    kind: 'unknown',
    seq: match.event.seq,
    time: match.event.time,
    type: match.event.type,
    data: match.event.data,
  }),
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : chatNode(context, 'unknown', context.state.seq, context.state),
}

/**
 * Register the unmatched append-surface fallback contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerUnknownConversationFallback(ctx: Context): void {
  ctx.uiConversation.events.registerFallback(unknownFallbackDefinition)
}
