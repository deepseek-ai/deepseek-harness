import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeContext, ConversationNodeDefinition, TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { deriveTurnTokenUsage } from '@deepseek-ai/dsh-token-meter/client'
import type {
  AssistantChatData, FinalAssistantChatData, TurnTailChatData,
} from '../contract/chat-nodes.ts'
import { CHAT_SYNTHETIC_SEQ_OFFSETS, chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Completed-turn actions and extension tail. */
    'turn-tail': TurnTailChatData
  }
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** Closing Assistant and footer facts derived for this completed Turn. */
    'turn-tail': TurnTailChatData
  }
}

interface TurnTailState {
  readonly turn: number
  readonly end?: ConversationMatch
}

function isSessionEvent(event: ConversationMatch['event']): event is SessionEvent {
  return event.type !== 'assistant/live-chunk'
}

function turnCoordinates(event: Parameters<ConversationNodeDefinition['match']>[0]): {
  readonly turn: number
  readonly step?: number
} | undefined {
  if (event.type === 'assistant/message'
    || event.type === 'assistant/attempt'
    || event.type === 'assistant/live-chunk'
    || event.type === 'step/start'
    || event.type === 'step/end') {
    return { turn: event.data.turn, step: event.data.step }
  }
  if (event.type === 'llm/retry' || event.type === 'llm/retry-started') {
    return { turn: event.data.turn, step: event.data.step }
  }
  return undefined
}

function turnLocation(context: ConversationNodeContext<TurnTailState>): TurnLocation | undefined {
  const location = context.start?.location ?? context.matches[0]?.location
  return location?.kind === 'turn' || location?.kind === 'step' ? location.turn : undefined
}

function hasText(data: AssistantChatData): data is FinalAssistantChatData {
  return data.finalNode !== undefined
    && data.blocks.some(block => block.kind === 'text' && block.text.trim() !== '')
}

function tailData(context: ConversationNodeContext<TurnTailState>): TurnTailChatData | null {
  const end = context.state === undefined
    ? context.matches.find(match => match.event.type === 'turn/end')
    : context.state.end
  if (end?.event.type !== 'turn/end') return null
  const turn = turnLocation(context)
  if (turn === undefined) return null
  const assistants = turn.steps
    .map(step => step.data.get('assistant-step'))
    .filter((candidate): candidate is Readonly<AssistantChatData> => candidate !== undefined)
  const finalized = assistants
    .filter((candidate): candidate is Readonly<FinalAssistantChatData> => candidate.finalNode !== undefined)
    .sort((left, right) => left.finalNode.seq - right.finalNode.seq)
  const closing = finalized.findLast(hasText) ?? null
  let latestTranscriptSeq = finalized.at(-1)?.finalNode.seq
  for (const match of context.matches) {
    const event = match.event
    const candidate = event.type === 'tool/call'
      || (event.type === 'tool/result' && event.surfaceOp === 'append')
      || (event.type === 'turn/end' && event.data.reason.kind === 'error')
      || event.type === 'llm/retry'
      ? event.seq
      : undefined
    if (candidate !== undefined && (latestTranscriptSeq === undefined || candidate > latestTranscriptSeq)) {
      latestTranscriptSeq = candidate
    }
  }
  const tokenUsage = context.start?.event.type === 'turn/start'
    ? deriveTurnTokenUsage(context.matches.map(match => match.event).filter(isSessionEvent))
    : undefined
  return {
    turn: end.event.data.turn,
    seq: end.event.seq,
    time: end.event.time,
    closing,
    branchUnavailable: closing === null || latestTranscriptSeq !== closing.finalNode.seq,
    ...tokenUsage === undefined ? {} : { tokenUsage },
  }
}

/** Completed-turn footer Definition independent of any Assistant row. */
export const turnTailDefinition: ConversationNodeDefinition<TurnTailState> = {
  kind: 'turn-tail',
  target: 'chat',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'turn/end') return { id: String(event.data.turn), role: 'update' }
    if (event.type === 'tool/call' || event.type === 'tool/result') {
      return { id: String(event.data.turn), role: 'update' }
    }
    const coordinates = turnCoordinates(event)
    if (coordinates !== undefined) return { id: String(coordinates.turn), role: 'update' }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('turn-tail start requires turn/start')
    return { turn: match.event.data.turn }
  },
  update: (context, match) => match.event.type === 'turn/end'
    ? { ...context.state, end: match }
    : context.state,
  publication: match => match.event.type === 'turn/end' ? 'immediate' : 'none',
  buildLocationData: (context, scope) => {
    if (scope !== 'turn') return null
    const value = tailData(context)
    return value === null ? null : {
      kind: 'turn',
      turn: value.turn,
      key: 'turn-tail',
      value,
    }
  },
  buildViewNode: (context) => {
    const turn = turnLocation(context)
    const data = turn?.data.get('turn-tail')
    return data === undefined ? null : chatNode(context, 'turn-tail', data.seq + CHAT_SYNTHETIC_SEQ_OFFSETS.finalizedFollowup, data)
  },
}

/**
 * Register completed-Turn footer data and its Chat node contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerTurnTailConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(turnTailDefinition)
}
