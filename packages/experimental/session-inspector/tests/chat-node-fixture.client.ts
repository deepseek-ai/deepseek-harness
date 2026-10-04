/** Real Location readers expose the store/source cycle reached by raw Node inspection. */

import type { ChatConversationViewNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { ConversationLocationIndex } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationStepDataMap {
    'inspector-test': { readonly text: string }
  }
}

/** @returns A Chat Node with a materialized, self-referencing Location data source. */
export function chatNodeWithLocation(): ChatConversationViewNode {
  const index = new ConversationLocationIndex()
  const turn: SessionEvent<'turn/start'> = { seq: SessionSeq(1), time: 0, type: 'turn/start', data: { turn: 1 } }
  const step: SessionEvent<'step/start'> = { seq: SessionSeq(2), time: 0, type: 'step/start', data: { turn: 1, step: 1 } }
  index.appendBoundary(turn)
  index.appendBoundary(step)
  const location = index.locationOf(step)
  if (location.kind !== 'step') throw new Error('Expected a Step Location')
  location.step.data.source('inspector-test')
  return { key: 'assistant:long-node-identity', kind: 'assistant', id: 'node-identity', target: 'chat',
    anchorSeq: 2, location, visibility: 'visible', data: { text: 'node content' } }
}
