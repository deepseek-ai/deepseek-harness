/** Original log coordinates submitted for target-owned Chat reveal. */

import type { SessionEventLike } from '@deepseek-ai/dsh-api-session-controller/client'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { InspectorChatTarget } from '../objects.ts'

/** Original owning event and, for an Assistant child row, its selected stream chunk. */
export interface SessionLogAnchor {
  readonly event: SessionEventLike
  readonly chunk?: StreamChunk
}

function partOf(chunk: StreamChunk | undefined): string | undefined {
  if (chunk?.type === 'reasoning-delta') return 'reasoning'
  if (chunk?.type === 'text-delta') return 'response'
  const type = chunk?.type === 'block-start' ? chunk.blockType : chunk?.type === 'block-end' ? chunk.block.type : undefined
  return type === 'reasoning' ? 'reasoning' : type === 'text' ? 'response' : undefined
}

/**
 * Describe a log record without reading another View's model or DOM.
 * @param anchor - Original log event and optional selected delta.
 * @returns Original event coordinates and any tool-call or Assistant-part identity.
 */
export function sessionLogChatTarget(anchor: SessionLogAnchor): InspectorChatTarget {
  const { event, chunk } = anchor
  const data = event.data
  const turn = 'turn' in data && typeof data.turn === 'number' ? data.turn : undefined
  const step = 'step' in data && typeof data.step === 'number' ? data.step : undefined
  const callId = event.type === 'tool/call' ? event.data.callId
    : event.type === 'tool/result' ? event.data.message.source.callId
      : 'subCallId' in data && typeof data.subCallId === 'string' ? data.subCallId
        : chunk?.type === 'tool-call-delta' ? chunk.id
          : chunk?.type === 'block-end' && chunk.block.type === 'tool-call' ? chunk.block.id : undefined
  const rootCallId = 'rootCallId' in data && typeof data.rootCallId === 'string' ? data.rootCallId : callId
  const groupPart = partOf(chunk)
  return {
    anchorSeq: event.seq,
    ...event.type === 'assistant/message' || event.type === 'assistant/attempt' || event.type === 'assistant/live-chunk'
      ? { nodeKind: 'assistant-step' } : {},
    ...turn === undefined ? {} : { turn },
    ...step === undefined ? {} : { step },
    ...callId === undefined ? {} : { callId },
    ...rootCallId === undefined || rootCallId === callId ? {} : { rootCallId },
    ...groupPart === undefined ? {} : { groupPart },
  }
}
