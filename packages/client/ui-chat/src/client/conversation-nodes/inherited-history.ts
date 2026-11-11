import type { Context } from '@deepseek-ai/cordis'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Divider after the history a seeded Session inherited; the Node's anchor is the marker seq. */
    'inherited-history': Record<never, never>
  }
}

/**
 * One divider at the latest inherited `session/end-seed` marker in the loaded
 * window. Ordered Context matches supply its position, including after older
 * pages load. A cut inside a Turn stays outside that Turn's process disclosure.
 */
export const inheritedHistoryDefinition: ConversationNodeDefinition<null> = {
  kind: 'inherited-history',
  target: 'chat',
  match: event => event.type === 'session/end-seed' && event.data.inherited === true
    ? { id: 'inherited-history', role: 'start' }
    : null,
  start: () => null,
  update: () => null,
  buildViewNode: (context) => {
    const latest = context.matches.at(-1)
    /* v8 ignore next -- this Context exists only after matching a durable inherited marker. */
    if (latest === undefined) return null
    return chatNode(context, 'inherited-history', latest.event.seq, {}, {
      location: latest.location, groupTree: 'turn',
    })
  },
}

/**
 * Register the inherited-history divider contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerInheritedHistoryConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(inheritedHistoryDefinition)
}
