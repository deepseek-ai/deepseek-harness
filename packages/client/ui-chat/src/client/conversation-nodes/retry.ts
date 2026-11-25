import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationLocation, ConversationMatch, ConversationNodeDefinition, ModelRetryNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type { RetryChatData } from '../contract/chat-nodes.ts'
import { chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Producer-correlated model retry chain. */
    'model-retry': RetryChatData
  }
}

/** Accumulated retry attempts sharing one producer-owned RetryId. */
export interface RetryState {
  readonly turn: number
  readonly step: number
  readonly attempts: readonly ModelRetryNode[]
}

function scheduledNode(match: ConversationMatch): ModelRetryNode | undefined {
  if (match.event.type !== 'llm/retry') return undefined
  return {
    kind: 'model-retry',
    seq: match.event.seq,
    time: match.event.time,
    retryState: 'scheduled',
    ...match.event.data,
  }
}

/** A scheduled attempt is cancelled once either owning boundary closes. */
function isClosed(location: ConversationLocation): boolean {
  return (location.kind === 'step' && location.step.status === 'closed')
    || ((location.kind === 'step' || location.kind === 'turn') && location.turn.status === 'closed')
}

/**
 * The last started retry failed when its Step is the last of a Turn that ended with an error.
 * A retry chain can continue into a later Turn, so the current attempt's own location decides.
 * The rule reads the Turn outcome, not the retried request's own result: a retry that
 * succeeded and whose Step then failed for another reason also reads as failed.
 */
function finallyFailed(location: ConversationLocation, current: ModelRetryNode): boolean {
  if (current.retryState !== 'started' || location.kind !== 'step') return false
  const turn = location.turn
  return turn.end?.data.reason.kind === 'error' && turn.steps.at(-1)?.step === current.step
}

/** Producer-correlated model retry chain Definition. */
export const retryDefinition: ConversationNodeDefinition<RetryState> = {
  kind: 'model-retry',
  target: 'chat',
  match: (event) => {
    if (event.type === 'llm/retry') {
      const retryId: unknown = event.data.retryId
      if (typeof retryId !== 'string' || retryId === '') return null
      return { id: retryId, role: event.data.retry === 1 ? 'start' : 'update' }
    }
    if (event.type === 'llm/retry-started') {
      const retryId: unknown = event.data.retryId
      return typeof retryId === 'string' && retryId !== '' ? { id: retryId, role: 'update' } : null
    }
    return null
  },
  start: (_context, match) => {
    const node = scheduledNode(match)
    if (node === undefined) throw new Error('model-retry start requires a valid llm/retry event')
    return { turn: node.turn, step: node.step, attempts: [node] }
  },
  update: (context, match) => {
    if (match.event.type === 'llm/retry') {
      const node = scheduledNode(match)
      return node === undefined ? context.state : { ...context.state, attempts: [...context.state.attempts, node] }
    }
    if (match.event.type !== 'llm/retry-started') return context.state
    const retry = match.event.data.retry
    return {
      ...context.state,
      attempts: context.state.attempts.map(attempt =>
        attempt.retry === retry ? { ...attempt, retryState: 'started' } : attempt),
    }
  },
  buildViewNode: (context) => {
    if (context.state === undefined || context.state.attempts.length === 0) return null
    const location = context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' as const }
    const stateAttempts = context.state.attempts
    const attempts = stateAttempts.map((attempt, index) =>
      index === stateAttempts.length - 1
        && attempt.retryState === 'scheduled'
        && isClosed(location)
        ? { ...attempt, retryState: 'cancelled' as const }
        : attempt)
    const current = attempts.at(-1)
    if (current === undefined) return null
    const currentLocation = context.matches.findLast(match => match.event.seq === current.seq)?.location ?? location
    const data: RetryChatData = {
      attempts,
      current,
      inFlight: current.retryState === 'started' && !isClosed(currentLocation),
      failed: finallyFailed(currentLocation, current),
    }
    return chatNode(context, 'model-retry', attempts[0]?.seq ?? current.seq, data, { groupTree: 'process' })
  },
}

/**
 * Register the correlated model-retry business contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerRetryConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(retryDefinition)
}
