import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeContext, ConversationNodeDefinition, TurnErrorNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TurnEndReason } from '@deepseek-ai/dsh-session/types'
import { chatNode } from './common.ts'
import { displayFailure } from './event-projection.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Terminal turn failure recorded on the turn's end reason. */
    'turn-error': TurnErrorNode
  }
}

interface TurnErrorState {
  readonly turn: number
  readonly failure?: {
    readonly seq: number
    readonly time: number
    readonly message: string
    readonly code?: string
  }
}

function lastStep(context: ConversationNodeContext<TurnErrorState>): number {
  const location = context.start?.location ?? context.matches[0]?.location
  if (location?.kind !== 'turn' && location?.kind !== 'step') return 0
  return location.turn.steps.at(-1)?.step ?? 0
}

/**
 * Failure shown for a turn ending: a recorded error, a sign-out cancellation,
 * or a turn that restart recovery closed because the DSH process exited mid-turn.
 */
function endFailure(reason: TurnEndReason): { readonly message: string; readonly code?: string } | undefined {
  switch (reason.kind) {
    case 'error':
      return reason.error
    case 'aborted':
      // User and parent cancellations show only the stopped turn summary.
      return reason.reason.kind === 'hook' && reason.reason.reason === 'deepseek-account/signed-out'
        ? { message: 'Stopped because you signed out of DeepSeek.', code: 'ACCOUNT_SIGNED_OUT' }
        : undefined
    case 'interrupted':
      return { message: 'The DSH process exited before this turn finished.', code: 'INTERRUPTED' }
    default:
      // Completed, blocked, max-tokens, forked, and plugin-merged endings have no failure row.
      return undefined
  }
}

function failureFrom(match: ConversationMatch): TurnErrorState['failure'] | undefined {
  if (match.event.type !== 'turn/end') return undefined
  const failure = endFailure(match.event.data.reason)
  if (failure === undefined) return undefined
  const display = displayFailure(failure)
  return {
    seq: match.event.seq,
    time: match.event.time,
    message: display.message,
    ...(display.code === undefined ? {} : { code: display.code }),
  }
}

function fallbackState(context: ConversationNodeContext<TurnErrorState>): TurnErrorState | undefined {
  const end = context.matches.find(match => failureFrom(match) !== undefined)
  if (end?.event.type !== 'turn/end') return undefined
  const failure = failureFrom(end)
  if (failure === undefined) return undefined
  return { turn: end.event.data.turn, failure }
}

/**
 * Terminal turn failure Definition. Retries run inside the failing turn, so the
 * turn's `llm/retry` history never suppresses this terminal row; the model-retry
 * node renders that history separately.
 */
export const turnErrorDefinition: ConversationNodeDefinition<TurnErrorState> = {
  kind: 'turn-error',
  target: 'chat',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'turn/end' && endFailure(event.data.reason) !== undefined) {
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('turn-error start requires turn/start')
    return { turn: match.event.data.turn }
  },
  update: (context, match) => {
    const failure = failureFrom(match)
    return failure === undefined ? context.state : { ...context.state, failure }
  },
  buildViewNode: (context) => {
    const state = context.state ?? fallbackState(context)
    if (state?.failure === undefined) return null
    const failure = state.failure
    const node: TurnErrorNode = {
      kind: 'turn-error',
      seq: failure.seq,
      time: failure.time,
      turn: state.turn,
      step: lastStep(context),
      message: failure.message,
      ...failure.code === undefined ? {} : { code: failure.code },
    }
    return chatNode(context, 'turn-error', node.seq, node, { groupTree: 'turn' })
  },
}

/**
 * Register the terminal Turn-error business contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerTurnErrorConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(turnErrorDefinition)
}
